export const merchantProductKey=p=>p.productKey||String(p.sourceTitle||p.title||p.proposedTitle||'').normalize('NFKC').toLowerCase().replace(/中国限定|海外限定|新品未開封|新品|正規品|新発売|限定/gi,'').replace(/[\s\p{P}]/gu,'');
export function merchantDismissed(product,records={}){
 const observations=product.observations||[product],keys=new Set([merchantProductKey(product),...observations.map(merchantProductKey)]);
 return Object.entries(records).some(([key,r])=>r&&!r.deleted&&(keys.has(key)||keys.has(r.productKey)||
  (r.sourceIds||[]).some(id=>observations.some(p=>id===`${p.sourcePlatform}:${p.sourceId}`))));
}
export function postedMerchantRecord(p,now=Date.now()){
 return {productKey:merchantProductKey(p),title:p.sourceTitle||p.title||'',description:p.sourceDescription||'',
  images:(p.sourceImages||[]).slice(0,8),primaryFingerprint:p.primaryFingerprint,
  sourceIds:[...new Set((p.observations||[p]).map(o=>`${o.sourcePlatform}:${o.sourceId}`))],updatedAt:new Date(now).toISOString()};
}
export function allowedMerchantPhotoSource(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!/(^|\.)(?:yahoo\.co\.jp|yimg\.jp|mercari\.com|mercdn\.net|fril\.jp|rakuma\.rakuten\.co\.jp)$/.test(u.hostname)}catch{return false}
}
