// One explicit engine inside the existing encrypted scan writer. All actual
// source reads use the existing collectors, gates and durable source holds.
import {createHash} from 'node:crypto';
import {createYahooGraphAdapter} from './yahoo-graph-adapter.mjs';
import {createRakumaGraphAdapter} from './rakuma-graph-adapter.mjs';
import {fetchYahooPage} from './yahoo.mjs';
import {fetchRakumaPage} from './rakuma.mjs';
import {imageFingerprints} from './image.mjs';
import {planMarketplaceInventory,runMarketplaceInventory} from './marketplace-inventory-graph.mjs';
import {graphComparisonResults,graphComparisonSummary} from './graph-comparison-results.mjs';
import {requiredPricingPlatforms} from '../../public/pricing-policy.js';
import {normalizeOfferPlatform} from '../../public/owned-offers.js';
import {realClock} from './full-cycle-graph.mjs';

export function createLiveInventoryGraph({accounts,contexts,settings,previous,startedAt,deadline,clock=realClock},dependencies={}){
  const cycleId=`graph:${startedAt}`,byKey=new Map(contexts.flatMap(context=>context.activeItems.map(item=>[`${context.account.id}:${item.id}`,{context,item}])));
  const previousItems=contexts.flatMap(context=>context.previousItems||[]),pageCache=new Map();
  const stats={yahoo:{collectorCalls:0,sharedReuses:0,observedPages:0,failedCalls:0},rakuma:{collectorCalls:0,sharedReuses:0,observedPages:0,failedCalls:0}};
  const controllers=new Set();let closed=false;
  const readers={yahoo:dependencies.fetchYahooPage||fetchYahooPage,rakuma:dependencies.fetchRakumaPage||fetchRakumaPage};
  const readPage=source=>async(url,context={})=>{
    if(closed||clock.now()>=deadline||context.signal?.aborted)throw Object.assign(new Error('graph_reader_deadline'),{code:'request_deferred',reason:'request_deadline'});
    const key=source+':'+url;
    if(pageCache.has(key)){stats[source].sharedReuses++;return structuredClone(await pageCache.get(key));}
    const controller=new AbortController();controllers.add(controller);
    // Shared by graph and procurement own hydration. One caller ending does not
    // cancel another current caller, but the fixed cycle always cancels both.
    const timer=setTimeout(()=>controller.abort(),Math.min(Math.max(0,deadline-clock.now()),2147483647));
    const pending=(async()=>{
      stats[source].collectorCalls++;
      try{
        const page=await readers[source](url,{...settings,deadlineAt:deadline,yahooRequestDeadline:deadline,rakumaRequestDeadline:deadline,signal:controller.signal});
        if(closed||controller.signal.aborted||clock.now()>=deadline)throw Object.assign(new Error('graph_reader_deadline'),{code:'request_deferred',reason:'request_deadline'});
        stats[source].observedPages++;return structuredClone(page);
      }catch(error){stats[source].failedCalls++;throw error;}
      finally{clearTimeout(timer);controllers.delete(controller);}
    })();
    pageCache.set(key,pending);return structuredClone(await pending);
  };
  const common={settings:{...settings,matchCorrections:previous?.matchCorrections||{}},now:clock.now,imageFingerprints:dependencies.imageFingerprints||imageFingerprints};
  const adapters={yahoo:createYahooGraphAdapter({...common,fetchPage:readPage('yahoo')}),rakuma:createRakumaGraphAdapter({...common,fetchPage:readPage('rakuma')})};
  const inventories=contexts.map(context=>{
    const discovery=context.profileDiscovery,observedAt=discovery?.observedAt;
    return {accountId:context.account.id,items:context.activeItems,expectedCount:context.activeItems.length,status:context.profileStatus,cycleId,observedAt,
      fromCache:discovery?.fromCache!==false,complete:discovery?.complete===true,truncated:discovery?.truncated===true,
      proofRef:discovery?.complete===true&&Number.isFinite(observedAt)?createHash('sha256').update(JSON.stringify([context.account.id,context.account.profileUrl,observedAt,discovery.pages,context.activeItems.map(item=>item.id)])).digest('hex'):null};
  });
  let planned=null,planningError=null;
  try{planned=accounts.length?planMarketplaceInventory({cycleId,startedAt,deadlineAt:deadline,configuredAccounts:accounts,inventories,
    comparisonMode:settings.comparisonMode==='same_platform'?'same_platform':'cross_platform',historicalOwnedItems:previousItems,
    previousCompleteAt:previous?.cycleCoverage?.coverageComplete?Date.parse(previous.cycleCoverage.finishedAt||''):null}):null;
  }catch(error){planningError=error;}
  if(planned)common.settings.ownedOffers=planned.ownedOffers;
  function hydratedFields(item,raw){
    const observedAt=new Date(raw.observedAt).toISOString(),data=raw.data;
    return {...item,title:data.title,description:data.description,category:data.category,condition:data.condition,sellerId:data.sellerId,
      sourceDetail:{...data,observedAt,checkedAt:observedAt},ownPrice:data.price,image:data.images[0],images:data.images,
      yahoo:{...(item.yahoo||{}),ownDescription:data.description,ownCategory:data.category,ownImages:data.images}};
  }
  function applyOwnObservation(key,fresh){
    const entry=byKey.get(key);if(!entry)return;
    for(const field of ['ownPrice','sourceDetail','image','images','description','category','condition','sellerId'])entry.item[field]=fresh[field];
  }
  async function hydrate(item){
    const source=normalizeOfferPlatform(item.platform),adapter=adapters[source];if(!adapter)throw new Error('own_source_adapter_unavailable');
    if(planningError)throw new Error('graph_inventory_plan_invalid');
    const target=planned?.graph.targets.get(`${item.accountId}:${item.id}`)?.target;if(!target)throw new Error('unplanned_own_inventory_item');
    const raw=await adapter.fetchRaw({source,accessScope:'public',kind:'detail',url:target.own.url},{cycleId,deadlineAt:deadline});
    if(!(await adapter.validateOwn(target,raw,{cycleId,deadlineAt:deadline})).complete)throw new Error('current_own_identity_changed_or_unavailable');
    const fresh=hydratedFields(item,raw);
    // A cost worker may observe this exact own detail before its graph turn.
    // Preserve that real observation in the published item, but do not mark any
    // graph obligation complete or renew a comparison/cost timestamp.
    applyOwnObservation(`${item.accountId}:${item.id}`,fresh);return fresh;
  }
  function failForPublication(reason){
    for(const {context,item} of byKey.values())for(const source of requiredPricingPlatforms(item)){
      const prior=context.previousById?.get(item.id)?.[source]||item[source]||{};
      context[`${source}ById`].set(item.id,{...structuredClone(prior),status:'stale',evidenceStatus:'stale',cacheReason:'request_error',deferredReason:reason,
        searchComplete:false,checkedAt:prior.checkedAt||null,candidates:structuredClone(prior.candidates||[])});
    }
    close();return {report:{total:byKey.size,priceComplete:0,costVerified:0,complete:false,reason},
      summary:{total:byKey.size,complete:false,productionAccepted:false,missingTargetCount:byKey.size,error:reason},stats};
  }
  async function run(){
    if(planningError)return failForPublication('graph_inventory_plan_invalid');
    if(!planned)return {report:{total:0,priceComplete:0,costVerified:0,complete:false,reason:'no_configured_accounts'},summary:{total:0,complete:false,productionAccepted:false},stats};
    const sourceLimits={
      yahoo:{maxConcurrent:Math.max(1,Math.min(4,Number(settings.yahooConcurrency)||3)),minIntervalMs:Math.max(4000,Number(settings.yahooRequestIntervalMs)||5500)},
      rakuma:{maxConcurrent:Math.max(1,Math.min(4,Number(settings.rakumaConcurrency)||3)),minIntervalMs:Math.max(800,Number(settings.rakumaRequestIntervalMs)||1200)}
    };
    try{
      const report=await runMarketplaceInventory(planned,{adapters,clock,sourceLimits,maxConcurrency:sourceLimits.yahoo.maxConcurrent+sourceLimits.rakuma.maxConcurrent});
      if(clock.now()>=deadline)close();
      for(const [key,value] of graphComparisonResults(planned.graph,{previousItems})){
        const entry=byKey.get(key);if(!entry)continue;
        for(const source of ['yahoo','rakuma','mercari'])if(value[source])entry.context[`${source}ById`].set(entry.item.id,value[source]);
      }
      for(const record of planned.graph.targets.values()){
        const own=planned.graph.nodes.get(record.ownId),raw=planned.graph.nodes.get(own.rawId);
        if(own.result?.complete&&raw?.result?.data?.price>0){const entry=byKey.get(record.key);if(entry)applyOwnObservation(record.key,hydratedFields(entry.item,raw.result));}
      }
      return {report,summary:graphComparisonSummary(planned.graph),stats};
    }catch{return failForPublication('graph_execution_failed');}
  }
  function close(){closed=true;for(const controller of controllers)controller.abort();}
  return {run,hydrate,close,stats,planned};
}
