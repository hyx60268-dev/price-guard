import {createHash} from 'node:crypto';
import {evaluateYahooDetail,categoryText} from './yahoo.mjs';
import {PRICING_RULES_VERSION} from '../../public/pricing-policy.js';
import {isOwnedOffer} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {yahooProfileCardProblem} from './yahoo-profile-identity.mjs';
import {yahooDetailVerificationDigest} from './yahoo-verification-context.mjs';
import {sharedYahooTargetBinding} from '../../public/shared-yahoo-offers.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const text=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const imageUrls=detail=>[...new Set([...(detail?.images||[]).map(image=>typeof image==='string'?image:image?.url),detail?.thumbnailImageUrl].filter(Boolean))];
const validTime=(value,start,now,deadline)=>Number.isFinite(value)&&value>=start&&value<=now&&value<deadline&&now-value<20*60_000;
function validOriginal(bundle,id,{startedAt,deadlineAt,now}){
 const receipt=bundle?.originalObservation;
 return bundle?.detail?.id===id&&bundle.sourceUrl===canonical(id)&&bundle.fromCache===false&&receipt?.version===1&&
  receipt.kind==='original_yahoo_detail_body'&&receipt.url===canonical(id)&&receipt.status===200&&receipt.redirected===false&&
  receipt.observedAt===bundle.observedAt&&validTime(bundle.observedAt,startedAt,now,deadlineAt)&&
  receipt.bodySha256Scope==='decoded_response_html_utf8'&&/^[a-f0-9]{64}$/.test(receipt.bodySha256||'')&&
  receipt.parsedSha256===hash(JSON.stringify({detail:bundle.detail,shipping:bundle.shipping}));
}
const failure=reason=>({status:'pending',reason,htmlRequests:0,imageRequests:0,canRecommend:false});
// Shared by the source-free verifier and the missing-own read action. This is
// only an early rejection of changed own terms, never an acceptance shortcut.
export function sharedOwnTermsProblem(own,item){
 const detail=own?.detail,seller=String(detail?.seller?.id||detail?.sellerId||'');
 return !item||detail?.status!=='OPEN'||seller!==item.sellerId||text(detail?.title)!==text(item.title)||Number(detail?.price)!==item.ownPrice||
  !detail?.description?.trim()||!Array.isArray(detail?.images)||!detail.images.length||!own.shipping?.shippingKnown||own.shipping.currency!=='JPY'||own.shipping.shippingJPY!==0
  ?'own_terms_changed_or_missing':null;
}
// Cache reads may stall locally. Bounding the wait never starts a replacement
// request; late cache completion cannot commit an offer.
export async function boundedSharedPeek(read,{remainingMs,stopped}={}){
 const remaining=Math.max(0,Math.min(1200_000,Number(remainingMs?.()??1200_000)));
 if(!Number.isFinite(remaining)||remaining<=0||stopped?.())return null;
 let timer;
 try{return await Promise.race([Promise.resolve().then(()=>stopped?.()?null:read()),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),remaining)})]);}
 catch{return null;}
 finally{clearTimeout(timer);}
}


// No transport dependency exists in this entry. The caller supplies only cache
// peeks; absent/pending originals or fingerprints are explicit unresolved work.
export async function verifySharedYahooDetailPair({item,profileCard,recall,settings={},peekBundle,peekFingerprint,
 startedAt,deadlineAt,now=Date.now,remainingMs=()=>deadlineAt-now(),stopLocal=()=>false}={}){
 const at=now(),stopped=()=>now()>=deadlineAt||stopLocal()||remainingMs()<=0;
 if(stopped()||!Number.isFinite(startedAt)||!Number.isFinite(deadlineAt)||deadlineAt<=startedAt)return failure('source_deadline');
 const owned=settings.ownedOffers?.yahoo;
 if(settings.ownedOffersComplete!==true||!(owned?.items instanceof Set)||!(owned?.sellers instanceof Set)||
  !owned.items.has(item?.id)||!owned.sellers.has(item?.sellerId))return failure('complete_owned_index_required');
 if(!['yahoo','yahoo_fleamarket'].includes(item?.platform)||profileCard?.id!==item.id||profileCard?.accountId!==item.accountId||
  yahooProfileCardProblem(profileCard,{now:at})||profileCard.itemStatus!=='OPEN'||!validTime(profileCard.observedAt,startedAt,at,deadlineAt)||
  profileCard.sellerId!==item.sellerId||text(profileCard.title)!==text(item.title)||profileCard.priceJPY!==item.ownPrice||profileCard.imageUrl!==item.image)return failure('current_target_binding_required');
 const card=recall?.card;
 if(!card?.id||card.id===item.id||recall.id!==card.id||recall.conflictingCardObservations||!Array.isArray(recall.sources)||!recall.sources.length||
  !recall.sources.some(source=>validTime(source.observedAt,startedAt,at,deadlineAt)))return failure('current_recall_binding_required');
 if(isOwnedOffer(settings.ownedOffers,'yahoo',card)||rejectedByMemory(settings.matchCorrections,item,'yahoo',card))return failure('excluded_offer');
 const own=peekBundle(item.id),candidate=peekBundle(card.id);
 if(!validOriginal(own,item.id,{startedAt,deadlineAt,now:at}))return failure('own_original_unavailable');
 if(!validOriginal(candidate,card.id,{startedAt,deadlineAt,now:at}))return failure('candidate_original_unavailable');
 const ownDetail=own.detail,detail=candidate.detail;
 const ownSeller=String(ownDetail.seller?.id||ownDetail.sellerId||''),seller=String(detail.seller?.id||detail.sellerId||'');
 if(sharedOwnTermsProblem(own,item))return failure('own_terms_changed_or_missing');
 if(!seller||card.sellerId&&card.sellerId!==seller||isOwnedOffer(settings.ownedOffers,'yahoo',{id:detail.id,sellerId:seller}))return failure('candidate_seller_changed_or_owned');
 const maxImages=Math.max(3,Math.min(10,Number(settings.maxYahooImages)||8));
 const ownUrls=imageUrls(ownDetail).slice(0,maxImages),candidateUrls=[...new Set((detail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean))].slice(0,maxImages);
 if(!ownUrls.length||!candidateUrls.length)return failure('image_evidence_unavailable');
 const fingerprints=new Map();
 for(const url of new Set([...ownUrls,...candidateUrls])){
  if(stopped())return failure('source_deadline');
  const value=await boundedSharedPeek(()=>peekFingerprint(url,{deadlineAt,now}),{remainingMs,stopped});
  if(stopped())return failure('source_deadline');
  if(!value||value.url!==url||!/^[a-f0-9]{64}$/.test(value.contentSha256||'')||!Number.isFinite(Date.parse(value.imageObservedAt))||
   Date.parse(value.imageObservedAt)>now()||!Number.isFinite(value.imageCacheExpiresAt)||value.imageCacheExpiresAt<=now())return failure('image_evidence_unavailable');
  fingerprints.set(url,structuredClone(value));
 }
 const ownCondition=typeof ownDetail.condition==='string'?ownDetail.condition:ownDetail.condition?.name||ownDetail.condition?.text||ownDetail.condition?.label||ownDetail.condition?.key||'';
 const evaluation=await evaluateYahooDetail({item,card:{...card,sellerId:seller},bundle:candidate,ownDetail,knownOnly:true,
  ownSellerId:ownSeller,ownObservedAt:own.observedAt,ownConditionText:`${item.title}\n${ownDetail.title}\n${ownDetail.description}\n${ownCondition}`,
  ownCategory:categoryText(ownDetail),maxImages,ownFingerprints:ownUrls.map(url=>fingerprints.get(url)),ownImageEvidence:ownUrls.map(url=>fingerprints.get(url)),settings},
  {imageFingerprints:async url=>structuredClone(fingerprints.get(url)||null),now});
 if(stopped())return failure('source_deadline');
 if(!evaluation.candidate)return {status:'rejected',reason:evaluation.rejection?.reason||'strict_rejected',htmlRequests:0,imageRequests:0,canRecommend:false};
 const verification=evaluation.verificationContext;
 const digest=yahooDetailVerificationDigest({item,ownDetail,candidateDetail:detail,ownObservedAt:own.observedAt,candidateObservedAt:candidate.observedAt});
 if(!verification||verification.digest!==digest||verification.rulesVersion!==PRICING_RULES_VERSION)return failure('verification_binding_unavailable');
 return {status:'verified_single_offer',htmlRequests:0,imageRequests:0,canRecommend:false,offer:{
  version:1,evidenceType:'current_shared_detail_pair',rulesVersion:PRICING_RULES_VERSION,target:sharedYahooTargetBinding(item),
  id:detail.id,url:canonical(detail.id),title:detail.title,image:imageUrls(detail)[0],sellerId:seller,price:Number(detail.price),currency:'JPY',
  shippingJPY:0,shippingSource:'target_price_area',itemStatus:'OPEN',matchMethod:evaluation.candidate.matchMethod,
  checkedAt:new Date(candidate.observedAt).toISOString(),ownObservedAt:new Date(own.observedAt).toISOString(),identityVerifiedAt:new Date(verification.verifiedAt).toISOString(),
  cycleStartedAt:new Date(startedAt).toISOString(),ownSource:own.originalObservation,candidateSource:candidate.originalObservation,verification,
  imageEvidence:[...fingerprints.values()].map(value=>({url:value.url,contentSha256:value.contentSha256,imageObservedAt:value.imageObservedAt,imageCacheExpiresAt:value.imageCacheExpiresAt})),
  discoveryComplete:false,canRecommend:false,costEligible:false,
 }};
}
