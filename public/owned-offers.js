const platforms=['yahoo','rakuma','mercari'];
const token=value=>String(value??'').trim();
export function offerId(platform,offer={}){
 if(offer.id)return token(offer.id);
 try{const u=new URL(offer.url);return platform==='yahoo'?u.pathname.match(/^\/item\/([^/]+)/)?.[1]||'':platform==='rakuma'?u.pathname.match(/^\/([a-f0-9]{32})/i)?.[1]||'':u.pathname.match(/\/(?:item|product)\/([^/]+)/)?.[1]||''}catch{return ''}
}
export function buildOwnedOffers(accounts=[],items=[]){
 const index=Object.fromEntries(platforms.map(p=>[p,{items:new Set(),sellers:new Set()}]));
 const byAccount=new Map(accounts.map(a=>[a.id,a.platform||(/fril\.jp/.test(a.profileUrl)?'rakuma':'yahoo')]));
 for(const a of accounts){
  const p=byAccount.get(a.id),group=index[p];if(!group)continue;
  if(a.sellerId)group.sellers.add(token(a.sellerId));
  // Rakuma /shop/ slugs differ from numeric seller IDs; derive those from inventory.
  if(p!=='rakuma'){const id=String(a.profileUrl||'').match(p==='mercari'?/\/user\/profile\/([^/?#]+)/:/\/user\/([^/?#]+)/)?.[1];if(id)group.sellers.add(id)}
 }
 for(const item of items){const p=item.platform||byAccount.get(item.accountId),group=index[p];if(!group)continue;const id=offerId(p,item);if(id)group.items.add(id);for(const seller of [item.sellerId,item.sourceDetail?.sellerId,item.sourceDetail?.seller?.id])if(seller)group.sellers.add(token(seller))}
 return index;
}
export function isOwnedOffer(index,platform,offer={}){
 const group=index?.[platform];if(!group)return false;
 return group.items.has(offerId(platform,offer))||[offer.sellerId,offer.seller?.id].some(id=>id&&group.sellers.has(token(id)));
}
export function excludeOwnedOffers(item,index){
 const output={...item};
 for(const platform of platforms){
  const source=item[platform];if(!source)continue;
  const removed=(source.candidates||[]).filter(c=>!c.isOwn&&isOwnedOffer(index,platform,c));
  if(!removed.length)continue;
  const candidates=(source.candidates||[]).filter(c=>!isOwnedOffer(index,platform,c));
  const prices=candidates.filter(c=>!c.isOwn).map(c=>c.price).filter(Number.isFinite).sort((a,b)=>a-b);
  output[platform]={...source,candidates,lowestPrice:prices[0]??null,lowestUrl:candidates.filter(c=>!c.isOwn).sort((a,b)=>a.price-b.price)[0]?.url||null,
   marketMinPrice:prices[0]??null,marketMaxPrice:prices.at(-1)??null,marketMedianPrice:prices.length?prices[Math.floor(prices.length/2)]:null,marketSampleCount:prices.length,competitorCount:prices.length,
   rejected:[...(source.rejected||[]),...removed.map(c=>({...c,reason:'managed_shop'}))].slice(-30)};
 }
 return output;
}
