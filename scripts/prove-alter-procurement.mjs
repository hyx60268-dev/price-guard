import {createHash} from 'node:crypto';
import {openContext} from './lib/browser.mjs';
import {readPublicProcurementDetail,alternativeProcurementCost} from './lib/procurement-sources.mjs';
import {ALTER_NARBERAL_URL} from './lib/alter-procurement.mjs';
import {verifiedProcurementAuthority} from './lib/procurement-authority.mjs';
import {discoverYahooProfile,fetchYahooItemBundle} from './lib/yahoo.mjs';
import {createOwnSourceLoader} from './lib/own-source.mjs';
import {runPublicProcurement} from './lib/procurement-runner.mjs';
import {verifiedProcurementOwnPrimaryImage} from './lib/reviewed-procurement-catalog.mjs';
import {compactDashboardResult} from './lib/publish.mjs';
import {visiblePurchasableOffers} from '../public/procurement-view.js';
import {imageFingerprints,primaryProductSimilarity} from './lib/image.mjs';
import {titleScore} from './lib/rules.mjs';
import {externalImageQueries} from './lib/external-images.mjs';
import {verifiedPurchasableProcurementOffers} from './lib/procurement-reference.mjs';
const opened=await openContext();let passed=true,observedQuote=null;
try{
 for(const [label,title]of [['target','ALTER オーバーロード ナーベラル・ガンマ so-bin Ver. フィギュア'],['wrong_character','ALTER アルベド so-bin Ver. 1/8'],['wrong_scale','ALTER ナーベラル・ガンマ so-bin Ver. 1/7']]){
  const quote=await readPublicProcurementDetail(ALTER_NARBERAL_URL,{item:{title},context:opened.context,deadline:Date.now()+45000});
  const authority=quote.status==='quoted'?verifiedProcurementAuthority(quote):null;
  const valid=label==='target'?quote.status==='quoted'&&quote.skuId==='AL20744'&&quote.unitCNY>0&&quote.inStock===true&&quote.shippingCNY===0&&quote.purchaseLimit===1&&quote.shippingScope==='source_displayed_zto_delivery'&&authority?.type==='reviewed_retailer':quote.reason===(label==='wrong_scale'?'target_scale_mismatch':'target_product_mismatch');
  if(label==='target')observedQuote=quote;
  console.log('[阿尔塔公开采购来源实测]',JSON.stringify({label,checkedAt:new Date().toISOString(),status:quote.status,reason:quote.reason,skuId:quote.skuId,unitCNY:quote.unitCNY,shippingCNY:quote.shippingCNY,deliveryTerms:quote.deliveryTerms,purchaseLimit:quote.purchaseLimit,inStock:quote.inStock,sourceReadAccepted:valid,condition:quote.condition,diagnostic:quote.diagnostic}));
  passed&&=valid;
 }
 // Use the same public profile-card -> hydrate -> runner -> publication path as
 // production. No private inventory, credentials or Xianyu state are loaded.
 const profile=await discoverYahooProfile(null,'https://paypayfleamarket.yahoo.co.jp/user/p6579087',{});
 const card=profile.items.find(row=>row.id==='z679021554');
 if(!card?.image)throw Error('public_profile_target_unavailable');
 const sourceItem={...card,platform:'yahoo',accountId:'public-source-proof'},listingImage=card.image;
 const loader=createOwnSourceLoader({fetchYahooBundle:id=>fetchYahooItemBundle(id,{})});
 let hydrated;
 const results=await runPublicProcurement([[{item:sourceItem,prior:{}}]],{
  deadline:Date.now()+90000,limit:1,concurrency:1,
  hydrate:async(item,prior)=>{hydrated=await loader.hydrate(item,prior);return hydrated;},
  lookup:(item,options)=>alternativeProcurementCost(item,{...options,context:opened.context,
   search:async()=>[],detail:async url=>url===ALTER_NARBERAL_URL?observedQuote:{status:'unsupported',reason:'proof_source_outside_scope',reviewComplete:false}})
 });
 const reference=results.get('public-source-proof:'+sourceItem.id),own=hydrated?.sourceDetail;
 const image=verifiedProcurementOwnPrimaryImage(hydrated);
 if(!reference||!own?.description||!image)throw Error('public_target_detail_identity_unavailable');
 const [ownFp,candidateFp,listingFp]=await Promise.all([imageFingerprints(image),imageFingerprints(observedQuote?.detailImages?.[0]),imageFingerprints(listingImage)]);
 const candidateTitle=[observedQuote?.brand,observedQuote?.series,observedQuote?.detailTitle,observedQuote?.selectedVariant].filter(Boolean).join(' ');
 const digest=value=>createHash('sha256').update(String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim(),'utf8').digest('hex');
 const identityDiagnostics={titleScore:titleScore(externalImageQueries(own.title)[0],candidateTitle),primaryImageScore:primaryProductSimilarity(ownFp,candidateFp),
  listingImageScore:primaryProductSimilarity(listingFp,candidateFp),listingPrimary:{url:listingFp?.url,contentSha256:listingFp?.contentSha256},
  ownPrimary:{url:ownFp?.url,contentSha256:ownFp?.contentSha256},sourcePrimary:{url:candidateFp?.url,contentSha256:candidateFp?.contentSha256},
  listingImagePreserved:sourceItem.image===listingImage&&hydrated.image===listingImage,
  ownTitle:own.title,ownSellerId:String(own.seller?.id||own.sellerId||''),ownImages:own.images,
  ownDescriptionSha256:digest(own.description),sourceDescriptionSha256:digest(observedQuote?.detailDescription),
  ownCondition:own.condition,sourceCondition:observedQuote?.condition,sourceSku:observedQuote?.skuId,sourceTitle:observedQuote?.detailTitle,sourceVariant:observedQuote?.selectedVariant};
 const automaticCostAccepted=reference.status==='ok'&&reference.averageCNY>0;
 const publishedRow={...sourceItem,procurementSource:reference};
 const purchasableOffers=verifiedPurchasableProcurementOffers(publishedRow);
 const compact=compactDashboardResult({items:[publishedRow]}).items[0];
 const purchasableOfferPublishedCandidate=purchasableOffers.length===1&&purchasableOffers[0].skuId==='AL20744'&&
  purchasableOffers[0].price===observedQuote.price&&purchasableOffers[0].purchaseLimit===1&&
  reference.averageCNY===null&&reference.samples.length===0&&!reference.selectedQuote&&
  compact.image===listingImage&&visiblePurchasableOffers(compact).length===1;
 console.log('[阿尔塔公开同款全流程实测]',JSON.stringify({checkedAt:new Date().toISOString(),targetId:sourceItem.id,status:reference.status,reason:reference.reason,detailCheckedCount:reference.detailCheckedCount,
  entry:'profile_card_hydrate_runner_compact',sourceReadAccepted:passed,purchasableOfferPublishedCandidate,automaticCostAccepted,averageCNY:reference.averageCNY,
  purchasableOffers:purchasableOffers.map(offer=>({skuId:offer.skuId,price:offer.price,shippingCNY:offer.shippingCNY,inStock:offer.inStock,purchaseLimit:offer.purchaseLimit,deliveryTerms:offer.deliveryTerms,eligibility:offer.eligibility,condition:offer.condition,checkedAt:offer.checkedAt,verification:offer.verification,identity:offer.identity})),
  identityDiagnostics,diagnostics:reference.diagnostics,privateInventoryVerified:false}));
 // A displayed quote with unknown sealing is distinct from automatic cost.
 passed&&=purchasableOfferPublishedCandidate||automaticCostAccepted;
}catch(error){console.error('[阿尔塔公开实测错误]',String(error?.message||error).replace(/https?:\/\/\S+/g,'[url omitted]').slice(0,200));passed=false}
finally{await opened.browser.close()}
if(!passed)process.exitCode=1;
