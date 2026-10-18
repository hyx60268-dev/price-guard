import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isOwnedOffer,normalizeOfferPlatform} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {sharedYahooTargetBinding} from '../../public/shared-yahoo-offers.js';
import {yahooProfileCardProblem} from './yahoo-profile-identity.mjs';

const key=item=>`${item.accountId}:${item.id}`;
const canonical=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const hash=value=>createHash('sha256').update(value).digest('hex');
const text=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const candidateUrls=(detail,maxImages)=>[...new Set((detail?.images||[])
  .map(value=>typeof value==='string'?value:value?.url).filter(Boolean))].slice(0,maxImages);
const priceKind=recall=>recall.conflictingCardObservations?'conflicting':
  recall.lowerListedPrice===true?'lower':recall.lowerListedPrice===false?'not_lower':'unknown';
const emptyCosts=()=>Object.fromEntries(['both','own_only','candidate_only','neither'].map(kind=>
  [kind,{lower:0,not_lower:0,unknown:0,conflicting:0}]));
const recallScore=recall=>Number.isFinite(recall.titleSimilarity)?recall.titleSimilarity:0;
// These are read-order hints only. Even a historical link or identical image
// URL needs the independent current detail/image verifier after the own read.
const evidenceOrder=(a,b)=>Number(Boolean(b.recall.historicalIdentity))-Number(Boolean(a.recall.historicalIdentity))||
  Number(Boolean(b.recall.sameImageUrl))-Number(Boolean(a.recall.sameImageUrl))||
  recallScore(b.recall)-recallScore(a.recall)||a.price-b.price||a.recall.id.localeCompare(b.recall.id);

// Pure selection, never source access or acceptance. The caller supplies the
// runtime's already-built mapping and owns dynamic account/discovery dispatch.
// claim() reserves one root even if its subsequent read fails. Mapping refreshes
// never restore that quota or turn a recalled card into verified price evidence.
export function createSharedOwnReadPlan({accounts=[],peekBundle,peekFingerprintState,startedAt,deadlineAt,
  now=Date.now,maxRoots=6,maxPerAccount=2,isRecallCurrent=null,maxPlanningDurationMs=1000,clock=performance.now.bind(performance)}={}){
  if(typeof peekBundle!=='function'||typeof peekFingerprintState!=='function'||typeof now!=='function'||
    !Number.isFinite(startedAt)||!Number.isFinite(deadlineAt)||deadlineAt<=startedAt||
    !Number.isSafeInteger(maxRoots)||maxRoots<0||maxRoots>6||
    !Number.isSafeInteger(maxPerAccount)||maxPerAccount<0||maxPerAccount>2||typeof clock!=='function'||
    !Number.isSafeInteger(maxPlanningDurationMs)||maxPlanningDurationMs<0||maxPlanningDurationMs>1000)
    throw Error('invalid_shared_own_read_plan');
  const accountOrder=[...new Set(accounts.filter(account=>normalizeOfferPlatform(account.platform,account.profileUrl)==='yahoo').map(account=>account.id))];
  const accountsById=new Map(accounts.map(account=>[account.id,account]));
  const claimedRoots=new Set(),claimedByAccount=new Map(),queues=new Map(),recallStates=new Map();
  let cursor=0,settings=null,planningSpent=0;
  const stats={version:1,scope:'missing_own_original_only',mappingUpdates:0,eligibleRoots:0,claimedRoots:0,
    skippedClaims:0,maximumRoots:maxRoots,maximumPerAccount:maxPerAccount,bodyCosts:emptyCosts(),reasons:{},
    planningDurationMs:0,planningPairs:0,planningStops:0,maximumPlanningDurationMs:maxPlanningDurationMs,
    marketplaceRequests:0,imageRequests:0,completeComparisons:0,canRecommend:false};
  const reason=value=>{stats.reasons[value]=(stats.reasons[value]||0)+1;};
  const currentTime=()=>{const value=now();return Number.isFinite(value)?value:Infinity;};
  const current=(value,at)=>Number.isFinite(value)&&value>=startedAt&&value<=at&&value<deadlineAt&&at-value<20*60_000;
  const stopped=at=>at<startedAt||at>=deadlineAt;
  const ownedReady=()=>settings?.ownedOffersComplete===true&&settings.ownedOffers?.yahoo?.items instanceof Set&&settings.ownedOffers.yahoo.sellers instanceof Set;
  function targetProblem(item,at){
    const card=item?.profileCard,account=accountsById.get(item?.accountId);
    if(!ownedReady())return 'complete_owned_index_required';
    if(!account||!accountOrder.includes(item.accountId)||normalizeOfferPlatform(item.platform)!=='yahoo'||
      card?.id!==item.id||card.accountId!==item.accountId||card.itemStatus!=='OPEN'||item.itemStatus!=='OPEN'||
      yahooProfileCardProblem(card,{now:at})||!current(card.observedAt,at)||card.sellerId!==item.sellerId||
      text(card.title)!==text(item.title)||card.priceJPY!==item.ownPrice||card.imageUrl!==item.image||
      !settings.ownedOffers.yahoo.items.has(item.id)||!settings.ownedOffers.yahoo.sellers.has(item.sellerId))return 'current_target_binding_required';
    return null;
  }
  function original(bundle,id,at){
    const receipt=bundle?.originalObservation;
    return bundle?.detail?.id===id&&bundle.sourceUrl===canonical(id)&&bundle.fromCache===false&&
      receipt?.version===1&&receipt.kind==='original_yahoo_detail_body'&&receipt.url===canonical(id)&&
      receipt.status===200&&receipt.redirected===false&&receipt.observedAt===bundle.observedAt&&current(bundle.observedAt,at)&&
      receipt.bodySha256Scope==='decoded_response_html_utf8'&&hex(receipt.bodySha256)&&
      receipt.parsedSha256===hash(JSON.stringify({detail:bundle.detail,shipping:bundle.shipping}));
  }
  function candidateProblem(item,recall,bundle,at,{validated=false,expectedDigest=null}={}){
    const card=recall?.card,detail=bundle?.detail;
    if(!card?.id||recall.id!==card.id||card.id===item.id||recall.conflictingCardObservations||recall.lowerListedPrice!==true||
      !Number.isFinite(card.price)||!(card.price>0&&card.price<item.ownPrice)||card.priceKind!=='ordinary'||card.currency!=='JPY'||
      !Array.isArray(recall.sources)||!recall.sources.some(source=>current(source.observedAt,at)&&source.expiresAt>at))return 'current_lower_recall_required';
    if(isOwnedOffer(settings.ownedOffers,'yahoo',card)||rejectedByMemory(settings.matchCorrections,item,'yahoo',card))return 'excluded_offer';
    if(!validated&&!original(bundle,card.id,at))return 'candidate_original_unavailable';
    if(expectedDigest&&bundle.originalObservation.parsedSha256!==expectedDigest)return 'candidate_original_changed';
    const seller=String(detail?.seller?.id||detail?.sellerId||'');
    if(detail?.status!=='OPEN'||!detail.title?.trim()||!detail.description?.trim()||!seller||
      card.sellerId&&card.sellerId!==seller||isOwnedOffer(settings.ownedOffers,'yahoo',{id:card.id,sellerId:seller})||
      !Number.isFinite(Number(detail.price))||Number(detail.price)<=0||Number(detail.price)>=item.ownPrice||
      !bundle.shipping?.shippingKnown||bundle.shipping.currency!=='JPY'||bundle.shipping.shippingJPY!==0)return 'candidate_terms_unavailable';
    const maxImages=Math.max(3,Math.min(10,Number(settings.maxYahooImages)||8)),urls=candidateUrls(detail,maxImages);
    if(!urls.length)return 'candidate_images_unavailable';
    for(const url of urls){
      const image=peekFingerprintState(url),observedAt=Date.parse(image?.imageObservedAt||'');
      if(image?.status!=='available'||!hex(image.contentSha256)||!Number.isFinite(observedAt)||observedAt>at||
        !Number.isFinite(image.imageCacheExpiresAt)||image.imageCacheExpiresAt<=at)return 'candidate_images_unavailable';
    }
    if(isRecallCurrent&&isRecallCurrent({item,profileCard:item.profileCard,recall,settings})!==true)return 'recall_no_longer_current';
    return null;
  }
  function observeMapping(mapping,{targets=[],strictSettings={}}={}){
    stats.mappingUpdates++;queues.clear();recallStates.clear();settings=strictSettings;stats.eligibleRoots=0;stats.bodyCosts=emptyCosts();
    const at=currentTime();if(stopped(at)){reason('source_deadline');return;}
    if(!ownedReady()){reason('complete_owned_index_required');return;}
    const begin=clock(),stop=()=>stopped(currentTime())||planningSpent+Math.max(0,clock()-begin)>=maxPlanningDurationMs;
    const targetByKey=new Map(targets.map(item=>[key(item),item])),bundleCache=new Map(),originalCache=new Map(),seenPairs=new Set();
    const peek=id=>{if(!bundleCache.has(id)){const value=peekBundle(id);bundleCache.set(id,value);originalCache.set(id,original(value,id,at));}return bundleCache.get(id);};
    try{
      for(const row of mapping?.rows||[]){
        if(stop()){stats.planningStops++;reason('planning_budget');break;}
        const item=targetByKey.get(row.targetKey);if(!item||targetProblem(item,at))continue;
        const complete=mapping.indexBuildComplete===true&&row.mappingIncomplete!==true&&['local_recall_only','unresolved'].includes(row.status)&&row.reason!=='local_mapping_budget';
        recallStates.set(row.targetKey,{item,binding:JSON.stringify(sharedYahooTargetBinding(item)),value:complete?Boolean(row.candidates?.length):null});
        if(!complete)continue;
        peek(item.id);const ownPresent=originalCache.get(item.id);
        const eligible=[];
        for(const recall of row.candidates||[]){
          if(stop()){stats.planningStops++;reason('planning_budget');break;}
          const pair=`${row.targetKey}:${recall.id}`;if(seenPairs.has(pair))continue;seenPairs.add(pair);
          stats.planningPairs++;
          const bundle=peek(recall.id),candidatePresent=originalCache.get(recall.id);
          stats.bodyCosts[ownPresent?(candidatePresent?'both':'own_only'):(candidatePresent?'candidate_only':'neither')][priceKind(recall)]++;
          if(ownPresent||!candidatePresent||claimedRoots.has(row.targetKey)||candidateProblem(item,recall,bundle,at,{validated:true}))continue;
          eligible.push({recall:structuredClone(recall),candidateDigest:bundle.originalObservation.parsedSha256,price:Number(bundle.detail.price)});
        }
        if(!eligible.length)continue;
        eligible.sort(evidenceOrder);
        const queue=queues.get(item.accountId)||[];
        const existing=queue.find(value=>key(value.item)===row.targetKey);
        if(existing)existing.candidates=[...existing.candidates,...eligible].sort(evidenceOrder).slice(0,2);
        else queue.push({item,binding:JSON.stringify(sharedYahooTargetBinding(item)),profileBinding:JSON.stringify(item.profileCard),
          // Keep a bounded fallback per root, never the expanded full mapping.
          candidates:eligible.slice(0,2)});queues.set(item.accountId,queue);
      }
      for(const [accountId,queue] of queues){
        queue.sort((a,b)=>evidenceOrder(a.candidates[0],b.candidates[0])||a.item.id.localeCompare(b.item.id));
        // Two claimable roots plus bounded alternatives if evidence changes.
        queues.set(accountId,queue.slice(0,Math.max(0,maxPerAccount*2)));
      }
      stats.eligibleRoots=[...queues.values()].reduce((sum,queue)=>sum+queue.length,0);
    }catch{queues.clear();recallStates.clear();stats.eligibleRoots=0;reason('planning_evidence_unavailable');}
    finally{planningSpent+=Math.max(0,clock()-begin);stats.planningDurationMs=planningSpent;}
  }
  function claimCore(accountId,{blockedTargetKeys=new Set()}={},budgetStop=()=>false){
    const at=currentTime();if(stopped(at)){reason('source_deadline');return null;}
    if(claimedRoots.size>=maxRoots){reason('root_quota');return null;}
    const order=accountId===undefined?accountOrder.slice(cursor).concat(accountOrder.slice(0,cursor)):[accountId];
    for(const id of order){
      if(!accountOrder.includes(id)||(claimedByAccount.get(id)||0)>=maxPerAccount)continue;
      const queue=queues.get(id)||[];
      let remaining=queue.length;
      while(remaining-->0&&queue.length){
        if(budgetStop())return null;
        const entry=queue.shift(),item=entry.item,targetKey=key(item);
        // In-flight normal workers retain ownership of their target. Keep the
        // root available for a later turn, without spending either claim quota.
        if(blockedTargetKeys.has(targetKey)){queue.push(entry);continue;}
        try{
          let problem=targetProblem(item,at);
          if(!problem&&(entry.binding!==JSON.stringify(sharedYahooTargetBinding(item))||entry.profileBinding!==JSON.stringify(item.profileCard)))problem='target_binding_changed';
          if(!problem&&claimedRoots.has(targetKey))problem='root_already_claimed';
          if(!problem&&peekBundle(item.id))problem='own_original_already_available';
          if(problem){stats.skippedClaims++;reason(problem);continue;}
          for(const candidate of entry.candidates){
            if(budgetStop())return null;
            const bundle=peekBundle(candidate.recall.id);
            problem=candidateProblem(item,candidate.recall,bundle,at,{expectedDigest:candidate.candidateDigest});
            if(problem){reason(problem);continue;}
            const result=structuredClone({item,profileCard:item.profileCard,recall:candidate.recall,candidateDigest:candidate.candidateDigest,settings});
            claimedRoots.add(targetKey);claimedByAccount.set(id,(claimedByAccount.get(id)||0)+1);stats.claimedRoots=claimedRoots.size;
            cursor=(accountOrder.indexOf(id)+1)%Math.max(1,accountOrder.length);return result;
          }
          stats.skippedClaims++;
        }catch{stats.skippedClaims++;reason('claim_evidence_unavailable');}
      }
    }
    return null;
  }
  function hasRecallCore(targetKey){
    try{
      const at=currentTime(),entry=recallStates.get(targetKey);
      if(stopped(at)||!entry||targetProblem(entry.item,at)||entry.binding!==JSON.stringify(sharedYahooTargetBinding(entry.item)))return null;
      return entry.value;
    }catch{return null;}
  }
  function candidateReadProblemCore(root){
    try{
      const at=currentTime();if(stopped(at))return 'source_deadline';
      const problem=targetProblem(root?.item,at);if(problem)return problem;
      if(!hex(root.candidateDigest))return 'candidate_original_unavailable';
      return candidateProblem(root.item,root.recall,peekBundle(root.recall.id),at,{expectedDigest:root.candidateDigest});
    }catch{return 'candidate_original_unavailable';}
  }
  // Claim/recheck hashing and current-index checks consume the same cumulative
  // local allowance as plan construction; repeated calls cannot refill it.
  function measured(call,fallback){
    if(planningSpent>=maxPlanningDurationMs||stopped(currentTime()))return fallback;
    const begin=clock(),stop=()=>planningSpent+Math.max(0,clock()-begin)>=maxPlanningDurationMs;
    try{const result=call(stop);return stop()?fallback:result;}
    finally{planningSpent+=Math.max(0,clock()-begin);stats.planningDurationMs=planningSpent;}
  }
  const claim=(accountId,options)=>measured(stop=>claimCore(accountId,options,stop),null);
  const hasRecall=targetKey=>measured(()=>hasRecallCore(targetKey),null);
  const candidateReadProblem=root=>measured(()=>candidateReadProblemCore(root),'planning_budget');
  return Object.freeze({observeMapping,claim,hasRecall,candidateReadProblem,statistics:()=>structuredClone({...stats,
    pendingRoots:[...queues.values()].reduce((sum,queue)=>sum+queue.length,0),
    accounts:accountOrder.map((id,index)=>({ordinal:index,claimed:claimedByAccount.get(id)||0,pending:queues.get(id)?.length||0}))})});
}
