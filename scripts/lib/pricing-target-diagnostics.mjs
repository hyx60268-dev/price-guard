import {buildOwnedOffers,isOwnedOffer,normalizeOfferPlatform} from '../../public/owned-offers.js';

// Read saved evidence only. These screenshot reports provide target titles and
// prices, not competitor IDs, current availability, descriptions or model proof.
export const VIOLET_TARGETS=Object.freeze([
  {key:'suitcase',id:'z704304540',reportedCandidateIds:['z704300094'],title:'APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 特典付き'},
  {key:'umbrella',id:'z705310958',title:'ヴァイオレット・エヴァーガーデン フィギュア 中国限定 正規品フィギュア'}
]);
const normalized=value=>String(value||'').normalize('NFKC').replace(/[\s・･.。]/g,'').toLowerCase();
const string=value=>typeof value==='string'?value:null;
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)?value:null;
const clocks=value=>Object.fromEntries(['checkedAt','searchCheckedAt','lastAttemptAt','lastFullAttemptAt','knownLastAttemptAt'].map(key=>[key,string(value?.[key])]));
function inventoryRows(state){
  const rows=(state.items||[]).map(item=>({item,location:'items'}));
  for(const account of state.accounts||[])for(const item of account.items||[])
    rows.push({item:{...item,accountId:item.accountId||account.id,platform:item.platform||account.platform},location:'accounts.items'});
  return rows;
}
function offer(row,index){
  return {id:safeId(row.id),price:number(row.price),reason:string(row.reason),
    source:string(row.source),sources:Array.isArray(row.sources)?row.sources.filter(value=>['search','recommendation','prior_verified'].includes(value)):[],
    recommendationSection:string(row.recommendationSection),itemStatus:string(row.itemStatus),
    matchesSavedManagedIndex:isOwnedOffer(index,'yahoo',row),reportedSellerMatch:row.sellerId==='p59959877',checkedAt:string(row.checkedAt)};
}
export function pricingTargetDiagnostics(state={}, {source='saved_state',targets=VIOLET_TARGETS}={}){
  const rows=inventoryRows(state),index=buildOwnedOffers([...(state.accounts||[]),...(state.managedAccounts||[])],rows.map(row=>row.item));
  const matches=[],seen=new Set();
  const authoritative=Array.isArray(state.items)?state.items:rows.map(row=>row.item);
  const activeAccounts=new Set((state.accounts||[]).filter(account=>account.profileStatus==='live').map(account=>account.id));
  const savedOpenTargetKeys=[...new Set(authoritative.filter(item=>item.itemStatus==='OPEN'&&activeAccounts.has(item.accountId)&&
    normalizeOfferPlatform(item.platform,item.url||item.ownUrl)==='yahoo'&&
    item.yahoo?.knownRefresh?.reason!=='own_not_open'&&!['own_not_open','own_availability_unconfirmed'].includes(item.yahoo?.status)&&
    item.yahoo?.reason!=='own_not_open'&&item.yahoo?.cacheReason!=='own_not_open'&&
    targets.some(target=>target.id===item.id||normalized(target.title)===normalized(item.title)))
    .map(item=>safeId(item.accountId)&&safeId(item.id)?item.accountId+':'+item.id:null).filter(Boolean))];
  for(const {item,location} of rows){
    if(normalizeOfferPlatform(item.platform,item.url||item.ownUrl)!=='yahoo'&&item.yahoo===undefined)continue;
    const target=targets.find(target=>target.id===item.id||normalized(target.title)===normalized(item.title));
    if(!target)continue;
    const comparison=item.yahoo||{};
    const candidates=(comparison.candidates||[]).map(row=>offer(row,index)),rejected=(comparison.rejected||[]).map(row=>offer(row,index));
    const record={target:target.key,accountId:safeId(item.accountId),id:safeId(item.id),title:string(item.title),ownPrice:number(item.ownPrice),
      itemStatus:string(item.itemStatus),comparisonStatus:string(comparison.comparisonStatus),status:string(comparison.status),
      evidenceStatus:string(comparison.evidenceStatus),cacheReason:string(comparison.cacheReason),deferredReason:string(comparison.deferredReason),
      retryAt:typeof comparison.retryAt==='number'||typeof comparison.retryAt==='string'?comparison.retryAt:null,
      clocks:clocks(comparison),knownRefresh:{mode:string(comparison.knownRefresh?.mode),reason:string(comparison.knownRefresh?.reason),attemptedAt:string(comparison.knownRefresh?.attemptedAt)},rulesVersion:number(comparison.rulesVersion),
      counts:Object.fromEntries(['cardCount','searchCardCount','recommendationCardCount','preliminaryCount','detailCheckedCount','competitorCount','uncheckedLowerCandidateCount','unconfirmedLowerCandidateCount'].map(key=>[key,number(comparison[key])])),
      sourceStatus:{search:string(comparison.sourceStatus?.search),itemPage:string(comparison.sourceStatus?.itemPage)},
      lowestPrice:number(comparison.lowestPrice),recommendedPrice:number(comparison.recommendedPrice),candidates,rejected,
      reportedCandidateRecords:[...candidates,...rejected].filter(row=>(target.reportedCandidateIds||[]).includes(row.id)),
      recorded28000:{candidates:candidates.filter(row=>row.price===28000),rejected:rejected.filter(row=>row.price===28000)},
      evidenceLimit:'Saved candidates and rejection history are bounded (full: last 30 rejections; compact: last 12). Absence does not prove a candidate was never discovered or rejected. A fallback own price is not a verified competitor quote.'};
    const identity=JSON.stringify(record);if(seen.has(identity))continue;seen.add(identity);matches.push({...record,recordLocation:location});
  }
  return {schemaVersion:1,readOnly:true,source,snapshotCheckedAt:string(state.checkedAt),
    savedOpenTargetKeys,prioritySelectionNote:'Saved OPEN IDs from a live inventory snapshot only; intersect with this run\'s actual active inventory before prioritizing. Never resurrect an old listing or add it to the denominator.',
    missingTargets:targets.filter(target=>!matches.some(row=>row.target===target.key)).map(target=>target.key),targets:matches};
}
