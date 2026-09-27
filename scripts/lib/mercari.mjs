import { imageFingerprints,imageSetSimilarity,primaryProductSimilarity } from './image.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { rejectedByMemory } from '../../public/match-memory.js';
import {
  collectibleIdentityRequiresVisualProof,distinctiveCoverage,exactIdentityTitleEquivalent,
  hasExplicitDefect,MATCHING_RULES_VERSION,listingSpecificationEquivalent,listingTextEquivalent,
  productFamily,semanticSameItem,titleScore,visualListingEquivalent
} from './rules.mjs';
import { queryFor } from './yahoo.mjs';
import { mercariSearch,mercariDetail } from './mercari-page.mjs';

export async function mercariCompare(page,item,settings={},dependencies={}){
  const fingerprint=dependencies.imageFingerprints||imageFingerprints;
  const query=queryFor(item.title),searchUrl=`https://jp.mercari.com/search?keyword=${encodeURIComponent(query)}&status=on_sale&sort=price&order=asc`;
  const ownDescription=item.sourceDetail?.description||item.yahoo?.ownDescription||item.description||'';
  const ownCategory=item.sourceDetail?.category||item.yahoo?.ownCategory||item.category||'';
  const ownImages=[...(item.sourceDetail?.images||[]),...(item.yahoo?.ownImages||[]),...(item.images||[]),item.image].filter(Boolean);
  const ownSellerId=item.platform==='mercari'?String(item.sourceDetail?.sellerId||item.sellerId||''):'';
  const ownImageEvidence=await Promise.all([...new Set(ownImages)].slice(0,8).map(fingerprint));
  const ownFingerprints=ownImageEvidence.filter(Boolean),rejected=[];
  const search=await (dependencies.search||mercariSearch)(page,searchUrl),cards=search.cards;
  const screened=[];
  for(const card of cards){
    if(card.itemStatus!=='OPEN'||item.platform==='mercari'&&(card.id===item.id||ownSellerId&&card.sellerId===ownSellerId)){rejected.push({...card,reason:'own_seller_or_not_open'});continue}
    if(rejectedByMemory(settings.matchCorrections,item,'mercari',card)){rejected.push({...card,reason:'saved_user_correction'});continue}
    const semantic=semanticSameItem({query:item.title,candidate:card.title,queryCategory:ownCategory,candidateCategory:card.category});
    const ownFamily=productFamily(item.title,ownCategory),cardFamily=productFamily(card.title,card.category);
    if(ownFamily&&cardFamily&&ownFamily!==cardFamily){rejected.push({...card,reason:'physical_product_type_unconfirmed'});continue}
    const score=titleScore(item.title,card.title),anchors=distinctiveCoverage(item.title,card.title);
    if(semantic.accepted||score>=.62||(score>=.45&&anchors.matchedCount>=2))screened.push({...card,titleScore:score,semantic});
    else rejected.push({...card,reason:semantic.reason||'weak_title',titleScore:score});
  }
  screened.sort((a,b)=>a.price-b.price||b.titleScore-a.titleScore);
  const preliminary=screened.slice(0,Math.max(1,Number(settings.maxMercariDetailChecks)||6));
  const competitors=[];
  for(const card of preliminary){
    try{
      const detail=await (dependencies.detail||mercariDetail)(page,card.url);
      if(ownSellerId&&detail.sellerId===ownSellerId){rejected.push({...card,reason:'own_seller'});continue}
      if(detail.status!=='OPEN'){rejected.push({...card,reason:detail.status==='SOLD'?'not_open':'availability_unconfirmed'});continue}
      if(!detail.shippingKnown){rejected.push({...card,reason:'shipping_unconfirmed',shippingText:detail.shippingText});continue}
      detail.price=detail.itemPrice+detail.shippingJPY;
      if(!ownDescription.trim()||!detail.description.trim()){rejected.push({...card,reason:'sale_description_unavailable'});continue}
      if(hasExplicitDefect(detail.title,detail.description)){rejected.push({...card,reason:'defect'});continue}
      const detailImages=[...detail.images,card.image].filter(Boolean);
      const detailEvidence=await Promise.all([...new Set(detailImages)].slice(0,8).map(fingerprint));
      const detailFingerprints=detailEvidence.filter(Boolean);
      const imageScore=imageSetSimilarity(ownFingerprints,detailFingerprints);
      const primaryImageScore=primaryProductSimilarity(ownImageEvidence[0],detailEvidence[0]);
      const identity=offerIdentityGuard({ownTitle:item.title,ownDescription,candidateTitle:detail.title,candidateDescription:detail.description,ownCategory,candidateCategory:detail.category,primaryImageScore});
      if(!identity.accepted){rejected.push({...card,reason:identity.reason,imageScore,primaryImageScore});continue}
      const semantic=semanticSameItem({query:`${item.title}\n${ownDescription}`,candidate:`${detail.title}\n${detail.description}`,queryCategory:ownCategory,candidateCategory:detail.category});
      const specificationEquivalent=listingSpecificationEquivalent(`${item.title}\n${ownDescription}`,`${detail.title}\n${detail.description}`,ownCategory,detail.category);
      const exactTitleEquivalent=exactIdentityTitleEquivalent(item.title,detail.title,ownCategory,detail.category);
      const textEquivalent=listingTextEquivalent(item.title,ownDescription,detail.title,detail.description);
      const visualEquivalent=visualListingEquivalent({query:`${item.title}\n${ownDescription}`,candidate:`${detail.title}\n${detail.description}`,queryCategory:ownCategory,candidateCategory:detail.category,imageScore,threshold:Number(settings.yahooStrongVisualMatchThreshold)||.86});
      if(collectibleIdentityRequiresVisualProof(item.title,detail.title,ownCategory,detail.category)&&!visualEquivalent){
        rejected.push({...card,reason:'collectible_variant_image_unconfirmed',imageScore,primaryImageScore});continue
      }
      if(!semantic.accepted&&!specificationEquivalent&&!exactTitleEquivalent&&!textEquivalent&&!visualEquivalent){
        rejected.push({...card,reason:semantic.reason||'detail_mismatch',imageScore,primaryImageScore});continue
      }
      const queryFamily=productFamily(`${item.title}\n${ownDescription}`,ownCategory),candidateFamily=productFamily(`${detail.title}\n${detail.description}`,detail.category);
      competitors.push({...card,...detail,platform:'mercari',image:detail.images[0]||card.image,imageScore,primaryImageScore,queryFamily,candidateFamily,matchMethod:visualEquivalent?'strong_visual_primary_product':'detail_type_quantity_equivalent_text'});
    }catch(error){rejected.push({...card,reason:'detail_error',error:String(error)})}
  }
  competitors.sort((a,b)=>a.price-b.price);
  const unresolved=[...screened.slice(preliminary.length),...rejected.filter(row=>['shipping_unconfirmed','availability_unconfirmed','detail_error','sale_description_unavailable','collectible_variant_image_unconfirmed','primary_variant_unconfirmed'].includes(row.reason))];
  const lowerUnconfirmed=unresolved.filter(row=>Number(row.price)<Number(item.ownPrice));
  return {
    audit:{ownItemId:item.id,accountId:item.accountId||null,ownDetailLoaded:Boolean(ownDescription.trim())},
    rulesVersion:MATCHING_RULES_VERSION,query,searchUrl,status:search.hasMore||lowerUnconfirmed.length||!ownDescription.trim()||!competitors.length&&unresolved.length?'incomplete':'ok',
    lowestPrice:competitors[0]?.price??null,lowestUrl:competitors[0]?.url??searchUrl,
    candidates:competitors.slice(0,5),cardCount:cards.length,preliminaryCount:preliminary.length,
    detailCheckedCount:preliminary.length,competitorCount:competitors.length,rejected:rejected.slice(-30),
    unconfirmedLowerCount:lowerUnconfirmed.length,plausibleMinPrice:unresolved.length?Math.min(...unresolved.map(row=>row.price)):null,
    matchLabel:lowerUnconfirmed.length?'存在尚未核验的煤炉低价候选':competitors.length?'已核验煤炉在售同款':'煤炉未发现同款',
    searchComplete:!search.hasMore,checkedAt:new Date().toISOString()
  };
}
