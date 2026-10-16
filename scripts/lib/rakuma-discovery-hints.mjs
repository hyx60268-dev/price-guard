import {createHash} from 'node:crypto';
import {isOwnedOffer} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {pricingDecision} from '../../public/pricing-policy.js';
import {explicitSaleContents,identityVariantFacets,semanticQuantity} from './rules.mjs';

// Discovery addresses only. Nothing in this store is a quote, a current card,
// an identity acceptance, or a substitute for the current detail gates.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=value=>Date.parse(value||'');
const text=value=>typeof value==='string'?value:'';
const images=value=>(Array.isArray(value)?value:[]).map(row=>typeof row==='string'?row:row?.url).filter(Boolean);
const scope=item=>({accountId:item.accountId,itemId:item.id,platform:item.platform});
const sameScope=(a,b)=>['accountId','itemId','platform'].every(key=>a?.[key]&&a[key]===b?.[key]);
const listingKey=item=>hash([item.accountId,item.id,item.platform,item.title,item.image||'',item.sellerId||'']);
const key=row=>`${row.identityKey}:${row.listingKey}:${row.id}`;

export function definitiveRakumaRejection(item,detail,reason){
 if(reason==='not_open')return detail.status==='SOLD';
 if(['managed_shop','own_seller','saved_user_correction','defect'].includes(reason))return true;
 const own=`${item.title}\n${item.sourceDetail?.description||''}`,candidate=`${detail.title}\n${detail.description||''}`;
 if(reason==='sale_unit_mismatch'){
  const a=semanticQuantity(own),b=semanticQuantity(candidate);
  return !explicitSaleContents(own).ambiguous&&!explicitSaleContents(candidate).ambiguous&&Number.isFinite(a)&&Number.isFinite(b)&&a!==b;
 }
 if(reason==='description_color_mismatch'){
  const a=identityVariantFacets(own).colors,b=identityVariantFacets(detail.description||detail.title).colors;
  return a.size===1&&b.size===1&&![...a].some(value=>b.has(value));
 }
 if(reason==='explicit_variant_mismatch'){
  const a=identityVariantFacets(item.title),b=identityVariantFacets(detail.title),fields=['figureScales','waves','prizes','tarot','tarotNames','anniversaries','cardGrades','colors'];
  if(fields.some(field=>a[field]?.size>1||b[field]?.size>1))return false;
  return fields.some(field=>a[field]?.size===1&&b[field]?.size===1&&![...a[field]].some(value=>b[field].has(value)));
 }
 return false;
}

export function canonicalRakumaHint(row={}){
 try{
  const url=new URL(row.url),id=url.pathname.match(/^\/([a-f0-9]{32})\/?$/i)?.[1];
  if(!id||url.protocol!=='https:'||url.host!=='item.fril.jp'||url.username||url.password||url.search||url.hash||row.id&&row.id!==id)return null;
  return {id,url:`https://item.fril.jp/${id}`};
 }catch{return null;}
}

export function rakumaTargetBinding(item={},now=Date.now()){
 const detail=item.sourceDetail,seller=detail?.sellerId,observedAt=stamp(detail?.sourceObservedAt||detail?.checkedAt);
 // The first implementation deliberately binds only same-source own listings.
 // Compacted/old snapshots without original target-response proof cannot seed.
 if(item.platform!=='rakuma'||!item.accountId||!item.id||!item.title||!detail||detail.sourceTargetVerified!==true||
  detail.id!==item.id||detail.listingId&&detail.listingId!==item.id||detail.title!==item.title||detail.status!=='OPEN'||
  !text(detail.description).trim()||!seller||item.sellerId&&String(item.sellerId)!==String(seller)||!images(detail.images).length||
  !Number.isFinite(observedAt)||observedAt>now)return null;
 return {identityKey:hash([item.accountId,item.id,item.platform,detail.title,detail.description,detail.condition??null,
  detail.category??null,images(detail.images),String(seller)]),listingKey:listingKey(item),observedAt};
}

export function mergeRakumaDiscovery(item={},...stores){
 const target=scope(item),rows=new Map();
 if(!target.accountId||!target.itemId||target.platform!=='rakuma')return undefined;
 for(const store of stores){
  if(store?.version!==1||!sameScope(target,store.target)||!Array.isArray(store.links))continue;
  for(const raw of store.links){
   const address=canonicalRakumaHint(raw);
   if(!address||!/^([a-f0-9]{64})$/.test(raw.identityKey||'')||!/^([a-f0-9]{64})$/.test(raw.listingKey||'')||!Number.isFinite(stamp(raw.lastVerifiedAt)))continue;
   const row={...address,identityKey:raw.identityKey,listingKey:raw.listingKey,lastVerifiedAt:raw.lastVerifiedAt,
    ...(Number.isFinite(stamp(raw.identityObservedAt))?{identityObservedAt:raw.identityObservedAt}:{}),
    ...(Number.isFinite(stamp(raw.lastAttemptAt))?{lastAttemptAt:raw.lastAttemptAt}:{}),
    ...(Number.isFinite(stamp(raw.retiredAt))?{retiredAt:raw.retiredAt,reason:text(raw.reason)||'retired'}:{})};
   const old=rows.get(key(row));
   if(!old){rows.set(key(row),row);continue;}
   const newer=stamp(row.lastVerifiedAt)>stamp(old.lastVerifiedAt)?row:old;
   const retired=[old,row].filter(value=>value.retiredAt).sort((a,b)=>Number(b.reason==='not_open')-Number(a.reason==='not_open')||stamp(b.retiredAt)-stamp(a.retiredAt))[0];
   const attempts=[old.lastAttemptAt,row.lastAttemptAt].filter(value=>Number.isFinite(stamp(value))).sort((a,b)=>stamp(b)-stamp(a));
   rows.set(key(row),{...newer,...(attempts.length?{lastAttemptAt:attempts[0]}:{}),...(retired?{retiredAt:retired.retiredAt,reason:retired.reason}:{})});
  }
 }
 return rows.size?{version:1,target,links:[...rows.values()].sort((a,b)=>key(a).localeCompare(key(b)))}:undefined;
}

export function refreshRakumaDiscovery(item={},prior={},settings={},now=Date.now()){
 const store=mergeRakumaDiscovery(item,item.competitorDiscovery?.rakuma,prior.competitorDiscovery?.rakuma);
 if(!store)return undefined;
 const binding=rakumaTargetBinding(item,now),at=new Date(now).toISOString();
 const sold=new Map(store.links.filter(row=>row.retiredAt&&row.reason==='not_open').map(row=>[row.id,row]));
 for(const row of store.links){
  if(row.retiredAt)continue;
  if(sold.has(row.id)){Object.assign(row,{retiredAt:sold.get(row.id).retiredAt,reason:'not_open'});continue;}
  const reason=rejectedByMemory(settings.matchCorrections,item,'rakuma',row)?'saved_user_correction':
   isOwnedOffer(settings.ownedOffers,'rakuma',row)?'managed_shop':row.listingKey!==listingKey(item)||binding&&binding.identityKey!==row.identityKey?'own_target_changed':null;
  if(reason)Object.assign(row,{retiredAt:at,reason});
 }
 return store;
}

export function withRakumaDiscovery(item={},prior={},settings={},now=Date.now()){
 const store=refreshRakumaDiscovery(item,prior,settings,now);
 // Remove an inherited foreign/relisted store; it is never a new own binding.
 if(!store&&!item.competitorDiscovery?.rakuma)return item;
 let output={...item,competitorDiscovery:{...item.competitorDiscovery,rakuma:store}};
 const source=item.rakuma,audit=source?.audit,binding=audit?.discoveryBinding;
 if(!source||audit?.accountId&&audit.accountId!==item.accountId||audit?.ownItemId&&audit.ownItemId!==item.id)return output;
 // A legacy quote cannot prove it belongs to another product binding. Quarantine
 // its same-target retired URL without constructing missing identity evidence.
 // SOLD is URL availability, independent of a changed own-product fingerprint.
 const retired=new Set((store?.links||[]).filter(row=>row.retiredAt&&(row.reason==='not_open'||!binding||
  row.identityKey===binding.identityKey&&row.listingKey===binding.listingKey)).map(row=>row.id));
 const candidates=(source.candidates||[]).filter(row=>!retired.has(canonicalRakumaHint(row)?.id)&&
  !rejectedByMemory(settings.matchCorrections,item,'rakuma',row)&&!isOwnedOffer(settings.ownedOffers,'rakuma',row));
 if(candidates.length===(source.candidates||[]).length)return output;
 output={...output,rakuma:{...source,candidates,status:'incomplete',evidenceStatus:'incomplete',searchComplete:false,
  lowestPrice:candidates[0]?.price??null,lowestUrl:candidates[0]?.url??null,competitorCount:candidates.length,
  matchLabel:'既知URLの確定除外を反映、再確認待ち'}};
 const decision=pricingDecision(output,{now});
 return {...output,...decision,lowestPrice:decision.lowest?.price??item.ownPrice,lowestUrl:decision.lowest?.url||item.url||item.ownUrl,
  difference:item.ownPrice-(decision.lowest?.price??item.ownPrice),marketMedianPrice:null,marketSampleCount:candidates.length,
  marketMinPrice:candidates[0]?.price??null,marketMaxPrice:candidates.at(-1)?.price??null,
  afterProfitJPY:Number.isFinite(item.costJPY)?decision.recommendedPrice-item.costJPY:null};
}

export function createRakumaHintSession(item,settings={},dependencies={}){
 const now=dependencies.now||Date.now,binding=rakumaTargetBinding(item,now()),prior=dependencies.priorItem||{};
 let store=refreshRakumaDiscovery(item,prior,settings,now())||{version:1,target:scope(item),links:[]};
 const stats={eligible:0,admitted:0,reverified:0,retired:0,retainedUnknown:0,invalidatedBinding:0,hintDetailReads:0,searchDetailReads:0,bootstrapped:0};
 const dueIds=new Set(),settledIds=new Set();
 for(const row of store.links)if(row.retiredAt){
  stats.retired++;if(row.reason==='own_target_changed')stats.invalidatedBinding++;
 }
 const pending=()=>[...dueIds].filter(id=>!settledIds.has(id)).length;
 const snapshot=()=>({...stats,pendingDue:pending(),pendingLinks:store.links.filter(row=>!row.retiredAt).length,retiredLinks:store.links.filter(row=>row.retiredAt).length});
 const publish=()=>{if(store.links.length)dependencies.onDiscovery?.(structuredClone(store));dependencies.onHintStats?.(snapshot());};
 const add=(candidate,observedAt)=>{
  const address=canonicalRakumaHint(candidate),at=stamp(observedAt);
  if(!binding||!address||!candidate.sellerId||!Number.isFinite(at)||at>now())return;
  if(store.links.some(row=>row.id===address.id&&row.retiredAt&&row.reason==='not_open'))return;
  const row={...address,identityKey:binding.identityKey,listingKey:binding.listingKey,identityObservedAt:new Date(binding.observedAt).toISOString(),lastVerifiedAt:new Date(at).toISOString()};
  const old=store.links.find(value=>key(value)===key(row));
  if(old?.retiredAt)return;
  if(!old)stats.bootstrapped++;
  store=mergeRakumaDiscovery(item,store,{version:1,target:scope(item),links:[row]});publish();
 };
 // Legacy quote/audit records do not bind the exact original own detail.
 // Only a new accepted detail below bootstraps a URL; never invent migration.
 publish();
 return {
  next(){
   if(!binding)return null;
   const interval=Math.max(1/60,Number(settings.rakumaFreshHours)||1/3)*3600000;
   const sold=new Set(store.links.filter(row=>row.retiredAt&&row.reason==='not_open').map(row=>row.id));
   const due=store.links.filter(row=>!row.retiredAt&&!sold.has(row.id)&&row.identityKey===binding.identityKey&&row.listingKey===binding.listingKey&&
    now()-Math.max(stamp(row.lastAttemptAt)||0,stamp(row.lastVerifiedAt))>=interval)
    .sort((a,b)=>(stamp(a.lastAttemptAt)||stamp(a.lastVerifiedAt))-(stamp(b.lastAttemptAt)||stamp(b.lastVerifiedAt))||a.id.localeCompare(b.id));
   for(const row of due)dueIds.add(row.id);
   stats.eligible=due.length;publish();return due[0]||null;
  },
  attempted(id,isHint=false){
   if(isHint){stats.admitted++;stats.hintDetailReads++;}else stats.searchDetailReads++;
   const row=store.links.find(row=>!row.retiredAt&&row.identityKey===binding?.identityKey&&row.listingKey===binding?.listingKey&&row.id===id);if(row)row.lastAttemptAt=new Date(now()).toISOString();publish();
  },
  observed(candidate,observedAt){if(dueIds.has(candidate.id)&&!settledIds.has(candidate.id)){stats.reverified++;settledIds.add(candidate.id);}add(candidate,observedAt);publish();},
  unknown(isHint){if(isHint){stats.retainedUnknown++;publish();}},
  rejected(id,reason,observedAt,proven=false){
   if(!proven||!Number.isFinite(stamp(observedAt)))return;
   settledIds.add(id);
   for(const row of store.links)if(row.id===id&&(reason==='not_open'||row.identityKey===binding?.identityKey&&row.listingKey===binding?.listingKey)&&
    (!row.retiredAt||reason==='not_open'&&row.reason!=='not_open')){if(!row.retiredAt)stats.retired++;Object.assign(row,{retiredAt:observedAt,reason});}
   publish();
  },
  stats:snapshot,pending,
  binding:()=>binding?{identityKey:binding.identityKey,listingKey:binding.listingKey,identityObservedAt:new Date(binding.observedAt).toISOString()}:undefined
 };
}
