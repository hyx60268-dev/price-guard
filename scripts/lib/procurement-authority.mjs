// Explicitly reviewed suppliers only. This is a quote from that supplier, not a
// claim about a legally verified business, an official brand or the market low.
// Every price still requires current target/SKU, stock and freight evidence.
const reviewedOffers=[{
 id:'alter-shanghai-narberal-al20744-20261007',type:'reviewed_retailer',source:'alter_shanghai',
 canonicalUrl:'https://www.alter-shanghai.cn/m/spotPage/298.html',
 sellerKey:'alter_shanghai:retail',skuId:'AL20744',selectedVariant:'AL20744 / 娜贝拉尔·伽玛 so-bin Ver.【再版】 / 1/8',
 reviewedAt:'2026-10-07',evidence:{
  url:'https://www.alter-shanghai.cn/m/spotPage/298.html',
  observation:'人工只读核对AL20744再版商品页全额、现货、限购1件、中通包邮/顺丰到付及型号表；公司页about/7自述阿尔塔中国大陆直营网店。未把自述当独立品牌认证，未确认未拆封。'
 }
},{
 id:'youzan-41125317-aeroclip2-white-20261004',type:'reviewed_retailer',source:'youzan',
 canonicalUrl:'https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd',
 sellerKey:'youzan:41125317',skuId:'15099721490',selectedVariant:'【凌赫同款白】「声声有赫」限定礼盒',
 reviewedAt:'2026-10-04',evidence:{
  url:'https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd',
  observation:'人工核对商品页的微信公众号认证及店铺链接 kdt_id=41125317，并逐项核对目标白色礼盒 SKU；未核实法律主体或品牌授权。'
 }
}];
const normalized=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
export function matchesReviewedProcurementAuthority(sample,record){
 if(!record?.id||!record.evidence?.url||!record.evidence?.observation||!record.reviewedAt)return false;
 if(!['reviewed_retailer','verified_official_store'].includes(record.type))return false;
 // A future official-brand record also needs an independently reviewed brand link.
 if(record.type==='verified_official_store'&&(!record.independentEvidence?.url||!record.independentEvidence?.observation))return false;
 return sample.source===record.source&&sample.canonicalUrl===record.canonicalUrl&&
  sample.sellerKey===record.sellerKey&&String(sample.skuId)===record.skuId&&
  normalized(sample.selectedVariant)===normalized(record.selectedVariant);
}
export function verifiedProcurementAuthority(sample){
 const record=reviewedOffers.find(record=>matchesReviewedProcurementAuthority(sample,record));
 return record?{id:record.id,type:record.type,sellerKey:record.sellerKey,
  evidenceUrl:record.evidence.url,reviewedAt:record.reviewedAt}:null;
}
