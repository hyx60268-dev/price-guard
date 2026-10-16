import { NATIVE_QUOTE_VERSION,nativeQuoteTarget,nativeQuoteUrl,validNativeSupplierQuote } from '../../public/native-supplier-quotes.js';
import { rejectedByMemory } from '../../public/match-memory.js';

// Adapter/import boundary, not a network collector. Every non-null fact must
// come from the selected product detail response, never search cards, snippets,
// advertised starting prices, deposit/preorder amounts or an inventory price.
export function normalizeNativeSupplierDetail(item,observation={},options={}){
 const selected=observation.selectedOffer;
 if(!selected||observation.accessStatus!=='readable'||selected.priceKind!=='selected_sku_total'||selected.isOwn!==false)return null;
 const quote={verification:NATIVE_QUOTE_VERSION,use:'reference_only',target:nativeQuoteTarget(item),
  source:observation.source,url:observation.finalUrl,canonicalUrl:nativeQuoteUrl(observation.finalUrl,observation.source,selected.productId,selected.skuId),
  productId:selected.productId,skuId:selected.skuId,sellerKey:selected.sellerKey,sellerName:selected.sellerName,
  detailTitle:observation.detailTitle,selectedVariant:selected.selectedVariant,quantity:selected.quantity,saleContents:selected.saleContents,
  ...(selected.purchaseLimit!==undefined?{purchaseLimit:selected.purchaseLimit}:{}),
  nativePrice:selected.nativePrice,currency:selected.currency,priceKind:selected.priceKind,purchaseType:selected.purchaseType,priceCondition:selected.priceCondition,priceEvidence:selected.priceEvidence,currencyEvidence:selected.currencyEvidence,
  isOwn:false,checkedAt:observation.fetchedAt,
  provenance:{fetchedAt:observation.fetchedAt,finalUrl:observation.finalUrl,httpStatus:observation.httpStatus,pageKind:observation.pageKind,contentSha256:observation.contentSha256},
  identity:selected.identity||{status:'pending',evidence:null},
  availability:selected.availability||{status:'unknown',evidence:null},condition:selected.condition||{status:'unknown',evidence:null},
  shipping:selected.shipping||{status:'unknown',destinationCountry:'CN',amount:null,currency:null,scope:null,evidence:null}};
 return validNativeSupplierQuote(quote,item,options)?structuredClone(quote):null;
}
export function currentNativeSupplierQuotes(item={}, {matchCorrections={},...options}={}){
 const rows=[...(Array.isArray(item.nativeSupplierQuotes)?item.nativeSupplierQuotes:[]),...(Array.isArray(item.procurementSource?.nativeSupplierQuotes)?item.procurementSource.nativeSupplierQuotes:[])];
 const source=item.procurementSource||{},target=nativeQuoteTarget(item),attemptAt=Date.parse(source.checkedAt||'');
 const targetMatches=Object.entries(target).every(([key,value])=>source.target?.[key]===value);
 // A newer explicit stock-out is evidence, not a network failure. Retire the
 // superseded in-stock observation only for this exact target and source URL.
 const stockOut=quote=>source.attempted===true&&targetMatches&&attemptAt<=(options.now??Date.now())&&attemptAt>=Date.parse(quote.checkedAt)&&
  (Array.isArray(source.diagnostics)?source.diagnostics:[]).some(row=>row.reason==='out_of_stock'&&row.url===quote.canonicalUrl);
 const current=rows.filter(quote=>validNativeSupplierQuote(quote,item,options)&&!stockOut(quote)&&!rejectedByMemory(matchCorrections,item,'procurement',quote)&&!(quote.source==='xianyu'&&rejectedByMemory(matchCorrections,item,'xianyu',quote))).sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt));
 const seen=new Set();return current.filter(quote=>{const key=quote.canonicalUrl+'|'+quote.skuId;if(seen.has(key))return false;seen.add(key);return true}).slice(0,5);
}
export function ownedNativeSupplierSellerKeys(accounts=[],items=[]){
 const keys=[],platforms=new Map(accounts.map(account=>[account.id,account.platform]));
 for(const record of [...accounts,...items]){
  const platform=record.platform||platforms.get(record.accountId);
  for(const seller of [record.sellerId,record.sourceDetail?.sellerId,record.sourceDetail?.seller?.id])if(platform&&seller)keys.push(platform+':'+seller);
 }
 return [...new Set(keys)];
}
