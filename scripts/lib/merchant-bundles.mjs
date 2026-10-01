const plain=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
export const isMixedBundle=item=>/まとめ買い/.test(item?.title||item?.sourceTitle||'');

// Only Yahoo's visible bundle section is evidence. Recommendation cards below
// the description must never become components of the purchased bundle.
export function extractYahooBundleComponents(html=''){
 const section=String(html).match(/<section\b[^>]*id=["']blked["'][^>]*>([\s\S]*?)<\/section>/i)?.[1];
 if(!section)return [];
 const expected=Number(plain(section).match(/まとめ買いの商品\s*[（(](\d+)点[）)]/)?.[1]);
 const children=new Map();
 for(const match of section.matchAll(/<a\b[^>]*href=["'](?:https:\/\/paypayfleamarket\.yahoo\.co\.jp)?\/item\/(z\d+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  const [,id,body]=match,title=plain(body.match(/<img\b[^>]*alt=["']([^"']+)["']/i)?.[1]);
  const price=Number(plain(body).match(/([\d,]+)\s*円/)?.[1]?.replaceAll(',',''));
  const image=body.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1]?.replaceAll('&amp;','&');
  if(title&&Number.isFinite(price)&&price>0)children.set(id,{id,title,price,image,url:`https://paypayfleamarket.yahoo.co.jp/item/${id}`});
 }
 return expected>1&&children.size===expected?[...children.values()]:[];
}

export function expandMerchantBundles(records={}){
 const output=[];
 for(const r of Object.values(records)){
  if(!isMixedBundle(r)){output.push(r);continue}
  // Incomplete bundles are held back, never guessed to be two copies of one
  // item or divided into an invented unit price.
  if(!r.bundleComplete||!r.components?.length)continue;
  for(const c of r.components){
   if(!c.detailVerified)continue;
   output.push({...r,...c,merchant:r.merchant,key:r.key+':component:'+c.id,
    bundleParentId:r.id,bundleParentUrl:r.url,bundleTotalPrice:r.price,
    componentPriceBasis:'original_listing',status:r.status,soldAt:r.soldAt,
    soldObservedAt:r.soldObservedAt,firstSeenSold:r.firstSeenSold,firstSeenAt:r.firstSeenAt,
    // No parent-level images, description, regional claim or draft may leak
    // into a different child product.
    images:c.images||[],image:c.image||'',description:c.description||'',
    webImages:c.webImages||[],xianyuImages:c.xianyuImages||[],components:undefined});
  }
 }
 return output;
}
