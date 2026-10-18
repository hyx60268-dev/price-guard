import {isOwnedOffer} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {offerIdentityGuard} from './offer-identity.mjs';
import {distinctiveCoverage,productFamily,semanticQuantity,conditionProfile} from './rules.mjs';
import {primaryProductSimilarity} from './image.mjs';

export const YAHOO_BUYER_SHIPPING_POLICY={version:1,currency:'JPY',shippingJPY:0,
 source:'platform_rule',sourceUrl:'https://support.yahoo-net.jp/SccPaypayfleamarket/s/article/H000008409',
 purchaseGuideUrl:'https://paypayfleamarket.yahoo.co.jp/guide/beginner/',reviewedAt:'2026-10-16'};

// Card-first prototype. It creates a separate observation lane, not a replacement
// detail-verification result. A card-only record can highlight a plausible lower
// price but never enters legacy accepted candidates or advances their clocks.
// Unknown stock stays explicit on a provisional price alert. Ambiguous photos,
// variant/unit conflicts and price outliers remain detail work, never exclusions.
const freshAt=(value,now)=>{const at=Date.parse(value||'');return Number.isFinite(at)&&at<=now&&now-at<=20*60_000};
const boundPrimary=(value,url,now)=>Boolean(typeof url==='string'&&url&&value?.url===url&&
 /^[a-f0-9]{64}$/.test(value.contentSha256||'')&&Number.isFinite(Date.parse(value.imageObservedAt||''))&&Date.parse(value.imageObservedAt)<=now&&
 (freshAt(value.imageObservedAt,now)||value.imageCacheSource==='http_fresh'&&Number.isFinite(value.imageCacheExpiresAt)&&value.imageCacheExpiresAt>now));
export function classifyYahooCardFirst({item,ownDetail,ownDetailObservation,card,ownPrimary,cardPrimary,
 ownImageKind='unknown',cardImageKind='unknown',settings={},now=Date.now()}={}){
 const detail=reason=>({mode:'detail_required',reason,cardId:card?.id});
 const blocked=reason=>({mode:'blocked',reason,cardId:card?.id});
 const reject=reason=>({mode:'excluded',reason,cardId:card?.id});
 if(!item||!card)return blocked('missing_target_or_card');
 const owned=settings.ownedOffers?.yahoo;
 if(settings.ownedOffersComplete!==true||!(owned?.items instanceof Set)||!(owned?.sellers instanceof Set)||
  !owned.items.has(item.id)||!owned.sellers.has(item.sellerId))return blocked('complete_owned_index_required');
 if(ownDetail?.id!==item.id||ownDetailObservation?.itemId!==item.id||
  ownDetailObservation?.sourceUrl!==`https://paypayfleamarket.yahoo.co.jp/item/${item.id}`||
  !freshAt(ownDetailObservation?.observedAt,now))return blocked('own_source_unbound_or_stale');
 if(!ownDetail?.description?.trim()||!ownDetail.title?.trim()||ownDetail.title!==item.title||
  ownDetail.status!=='OPEN'||String(ownDetail.seller?.id||ownDetail.sellerId||'')!==String(item.sellerId)||
  !(Number(ownDetail.price)>0)||Number(ownDetail.price)!==Number(item.ownPrice))return blocked('own_sale_terms_unconfirmed');
 if(card.id===item.id||isOwnedOffer(settings.ownedOffers,'yahoo',card)||item.sellerId&&item.sellerId===card.sellerId)return reject('own_offer');
 if(rejectedByMemory(settings.matchCorrections,item,'yahoo',card))return reject('saved_user_correction');
 let url;try{url=new URL(card.url)}catch{return detail('unbound_source_url')}
 if(url.origin!=='https://paypayfleamarket.yahoo.co.jp'||url.pathname!==`/item/${card.id}`)return detail('unbound_source_url');
 const at=Date.parse(card.observedAt||'');
 if(!Number.isFinite(at)||at>now||now-at>20*60_000)return detail('missing_or_stale_card_observation');
 if(['SOLD','CLOSED'].includes(card.itemStatus))return reject('not_open');
 const availabilityConfirmed=card.itemStatus==='OPEN'&&card.availabilityEvidence?.itemId===card.id&&
  ['current_search_card','current_seller_card','current_detail'].includes(card.availabilityEvidence?.source)&&
  Date.parse(card.availabilityEvidence?.observedAt||'')===at;
 if(typeof card.sellerId!=='string'||!card.sellerId.trim())return detail('seller_unconfirmed');
 const ownImage=typeof ownDetail.images?.[0]==='string'?ownDetail.images[0]:ownDetail.images?.[0]?.url;
 if(!boundPrimary(ownPrimary,ownImage,now))return blocked('own_primary_image_receipt_unbound');
 if(!boundPrimary(cardPrimary,card.image,now))return detail('primary_image_receipt_unbound');
 const price=Number(card.price),ownPrice=Number(item.ownPrice);
 if(!(price>0)||!(ownPrice>0)||card.priceKind!=='ordinary')return detail('ordinary_price_unconfirmed');
 // Parameters select detail work only. These defaults have no live accuracy
 // calibration and must not be presented as a measured production threshold.
 const minimumRatio=Math.max(.5,Math.min(1,Number(settings.cardFirstMinimumPriceRatio)||.75));
 const maximumRatio=Math.max(1,Math.min(2,Number(settings.cardFirstMaximumPriceRatio)||1.25));
 if(price/ownPrice<minimumRatio||price/ownPrice>maximumRatio)return detail('price_outlier');
 if(['official','photo'].includes(ownImageKind)&&['official','photo'].includes(cardImageKind)&&ownImageKind!==cardImageKind)return detail('official_photo_mismatch');
 const primaryScore=primaryProductSimilarity(ownPrimary,cardPrimary);
 const threshold=Math.max(.98,Math.min(1,Number(settings.cardFirstPrimaryThreshold)||.98));
 if(!Number.isFinite(primaryScore)||primaryScore<threshold)return detail('primary_image_uncertain');
 const ownTitle=String(ownDetail?.title||item.title||''),candidateTitle=String(card.title||'');
 const ownText=`${ownTitle}\n${ownDetail?.description||''}`;
 const family=productFamily(ownTitle),candidateFamily=productFamily(candidateTitle);
 if(!family||family!==candidateFamily)return detail('product_type_uncertain');
 const guard=offerIdentityGuard({ownTitle,ownDescription:ownDetail?.description||'',candidateTitle,
  candidateDescription:'',primaryImageScore:primaryScore,requireDescriptions:false});
 const condition=conditionProfile(candidateTitle);
 const conditionUnknown=!condition.newUnused&&!condition.sealedNew&&!condition.openedOrUsed&&!condition.noBox&&!condition.boxOnly;
 if(!guard.accepted&&!(guard.reason==='condition_or_packaging_mismatch'&&conditionUnknown))return detail(guard.reason);
 const anchors=distinctiveCoverage(ownTitle,candidateTitle);
 if(anchors.score<.9||anchors.matchedLength<6)return detail('identity_title_uncertain');
 const bonus=text=>/特典(?:カード)?(?:付き|付)|おまけ付き/.test(text);
 if(bonus(ownText)!==bonus(candidateTitle))return detail('bonus_terms_uncertain');
 const quantity=semanticQuantity(candidateTitle),ownQuantity=semanticQuantity(ownText);
 if(!Number.isFinite(quantity)||!Number.isFinite(ownQuantity))return detail('sale_quantity_unconfirmed');
 if(quantity!==ownQuantity)return detail('sale_unit_mismatch');
 const unknownTerms=[];
 if(!availabilityConfirmed)unknownTerms.push('availability_not_confirmed');
 if(!['official','photo'].includes(ownImageKind)||!['official','photo'].includes(cardImageKind))unknownTerms.push('image_origin_not_confirmed');

 if(!condition.newUnused&&!condition.sealedNew)unknownTerms.push('condition_not_explicit_on_card');
 // Even an apparently complete heading cannot disclose contradictory sale prose.
 unknownTerms.push('sale_description_not_observed');
 return {mode:'card_observation',reason:'strong_card_similarity',cardId:card.id,
  observation:{id:card.id,url:card.url,title:card.title,sellerId:card.sellerId,
   priceJPY:price,currency:'JPY',priceSource:'current_card_ordinary_price',
   cardObservedAt:new Date(at).toISOString(),availability:availabilityConfirmed?'available':'unconfirmed',
   availabilityEvidence:availabilityConfirmed?{itemId:card.id,source:card.availabilityEvidence.source,observedAt:new Date(at).toISOString()}:null,
   shipping:{...YAHOO_BUYER_SHIPPING_POLICY},primaryImageScore:primaryScore,
   ownObservedAt:ownDetailObservation.observedAt,
   imageEvidence:{own:{url:ownPrimary.url,contentSha256:ownPrimary.contentSha256,observedAt:ownPrimary.imageObservedAt},
    candidate:{url:cardPrimary.url,contentSha256:cardPrimary.contentSha256,observedAt:cardPrimary.imageObservedAt}},
   confidence:'high_visual_title_similarity',unknownTerms,source:'recommendation_card',
   detailVerified:false,detailCheckedAt:null,identityVerifiedAt:null,canRecommend:false,comparisonComplete:false,
   lowerPriceAlert:price<ownPrice,lowerByJPY:Math.max(0,ownPrice-price),
   displayLabel:'图片与标题高度相似的低价线索，未详情核实',
   requiresDetailBefore:['actionable_reprice','confirm_sale_terms','confirmed_lowest_price'],
   procurementCostEligible:false}};
}

export async function runYahooCardFirst(frozenCases,{readDetail,verifyDetail,settings={},now=Date.now()}={}){
 const outcomes=[];let detailRequests=0;
 for(const row of frozenCases){
  const decision=classifyYahooCardFirst({...row,settings,now});
  if(decision.mode!=='detail_required'){outcomes.push({...decision,key:row.key});continue}
  detailRequests++;
  try{const bundle=await readDetail(row);
   if(bundle?.detail?.id!==row.card?.id){outcomes.push({...decision,key:row.key,detailResult:{rejection:{id:row.card?.id,reason:'detail_id_mismatch'}}});continue}
   const result=await verifyDetail(row,bundle);
   outcomes.push({...decision,key:row.key,detailResult:result});}
  catch(error){outcomes.push({...decision,key:row.key,detailError:String(error)});}
 }
 return {outcomes,detailRequests};
}

// Persist this under yahoo.cardFirst, never yahoo.candidates/lowestPrice or any
// procurement structure. Existing verified recommendations remain independent.
export function yahooCardFirstPresentation(outcomes=[]){
 const observations=outcomes.flatMap(row=>row.mode==='card_observation'?[row.observation]:[]);
 const lower=observations.filter(row=>row.lowerPriceAlert).sort((a,b)=>a.priceJPY-b.priceJPY);
 const blockedTargets=outcomes.filter(row=>row.mode==='blocked').map(row=>({id:row.cardId,reason:row.reason}));
 return {version:1,source:'card_first_preview',lowerPriceAlerts:lower,
  lowestObservedCardPriceJPY:lower[0]?.priceJPY??null,
  currentCardObservations:observations.length,
  blockedTargets,
  detailPending:outcomes.filter(row=>row.mode==='detail_required'&&!row.detailResult).map(row=>({id:row.cardId,reason:row.reason})),
  displayLabel:lower.length?'发现图片与标题相似的更低标价，待详情确认':blockedTargets.length?'自家证据待补齐，暂不能判断卡片低价':'未发现高置信卡片低价线索',
  canRecommend:false,verifiedCostCount:0,complete:false};
}
