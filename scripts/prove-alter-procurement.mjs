import {openContext} from './lib/browser.mjs';
import {readPublicProcurementDetail,alternativeProcurementCost} from './lib/procurement-sources.mjs';
import {ALTER_NARBERAL_URL} from './lib/alter-procurement.mjs';
import {verifiedProcurementAuthority} from './lib/procurement-authority.mjs';
import {fetchYahooItemBundle} from './lib/yahoo.mjs';
import {imageFingerprints,primaryProductSimilarity} from './lib/image.mjs';
import {titleScore} from './lib/rules.mjs';
import {externalImageQueries} from './lib/external-images.mjs';
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
 // This public listing is evidence for a diagnostic only. No private inventory,
 // manual costs, credentials or Xianyu state are read or changed by this proof.
 const own=(await fetchYahooItemBundle('z679021554',{})).detail;
 const image=(own?.images||[]).map(value=>typeof value==='string'?value:value?.url).find(Boolean)||own?.thumbnailImageUrl;
 const sourceItem={...own,id:'z679021554',accountId:'public-source-proof',image,sourceDetail:own};
 if(own?.status!=='OPEN'||!own?.description||!image)throw Error('public_target_unavailable');
 const [ownFp,candidateFp]=await Promise.all([imageFingerprints(image),imageFingerprints(observedQuote?.detailImages?.[0])]);
 const candidateTitle=[observedQuote?.brand,observedQuote?.series,observedQuote?.detailTitle,observedQuote?.selectedVariant].filter(Boolean).join(' ');
 const identityDiagnostics={titleScore:titleScore(externalImageQueries(own.title)[0],candidateTitle),primaryImageScore:primaryProductSimilarity(ownFp,candidateFp),ownCondition:own.condition,sourceCondition:observedQuote?.condition,sourceSku:observedQuote?.skuId,sourceTitle:observedQuote?.detailTitle};
 const reference=await alternativeProcurementCost(sourceItem,{deadline:Date.now()+60000,context:opened.context,
  search:async()=>[],detail:async url=>url===ALTER_NARBERAL_URL?observedQuote:{status:'unsupported',reason:'proof_source_outside_scope',reviewComplete:false}});
 const automaticCostAccepted=reference.status==='ok'&&reference.averageCNY>0;
 console.log('[阿尔塔公开同款全流程实测]',JSON.stringify({checkedAt:new Date().toISOString(),targetId:sourceItem.id,status:reference.status,reason:reference.reason,detailCheckedCount:reference.detailCheckedCount,automaticCostAccepted,averageCNY:reference.averageCNY,identityDiagnostics,diagnostics:reference.diagnostics,privateInventoryVerified:false}));
 // This workflow includes the true identity pipeline: a readable retail page
 // alone does not make the business acceptance green.
 passed&&=automaticCostAccepted;
}catch(error){console.error('[阿尔塔公开实测错误]',String(error?.message||error).replace(/https?:\/\/\S+/g,'[url omitted]').slice(0,200));passed=false}
finally{await opened.browser.close()}
if(!passed)process.exitCode=1;
