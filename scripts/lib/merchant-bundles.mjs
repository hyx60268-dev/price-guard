const plain=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
export const isMixedBundle=item=>/まとめ買い|リクエスト\s*\d+\s*[点件]\s*まとめ商品/.test(String(item?.title||item?.sourceTitle||'').normalize('NFKC'));

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

// Mercari's request bundles expose an explicit description list, not child
// links or unit prices. Resolve only exact, unambiguous same-seller detail records.
const exactTitle=value=>String(value||'').normalize('NFKC').replace(/[\s「」『』]/g,'').trim();
const exactCondition=value=>String(value||'').normalize('NFKC').replace(/[\s、,]/g,'').trim();
export function extractMercariBundleContents(item={}){
 const count=Number(String(item.title||item.sourceTitle||'').normalize('NFKC').match(/リクエスト\s*(\d+)\s*[点件]\s*まとめ商品/)?.[1]);
 if(!Number.isInteger(count)||count<2||count>30)return [];
 const description=String(item.description||item.sourceDescription||'');
 const section=description.match(/(?:^|\n)\s*■\s*商品内容\s*\n([\s\S]*)/)?.[1]?.split(/\n\s*■/)[0];
 if(!section)return [];
 const rows=[...section.matchAll(/^[・･]\s*(.+?)【([^】]+)】\s*$/gm)].map(([,title,condition])=>({title:title.trim(),condition:condition.trim()}));
 if(rows.length!==count||rows.some(r=>exactTitle(r.title).length<8)||new Set(rows.map(r=>exactTitle(r.title))).size!==count)return [];
 return rows;
}
export function resolveMercariBundles(records={}){
 const all=Object.values(records);
 for(const parent of all){
  if(parent.merchant?.platform!=='mercari'||!isMixedBundle(parent))continue;
  const parentVerified=parent.sellerId==='/user/profile/'+parent.merchant.id&&Number.isFinite(Date.parse(parent.lastDetailAt||''));
  const declared=parentVerified?extractMercariBundleContents(parent):[],components=[],unresolved=[];
  for(const entry of declared){
   const matches=all.filter(child=>child!==parent&&!isMixedBundle(child)&&child.merchant?.key===parent.merchant.key&&
    child.sellerId==='/user/profile/'+parent.merchant.id&&Number.isFinite(Date.parse(child.lastDetailAt||''))&&
    child.description&&child.images?.length&&/^m\d+$/.test(child.id)&&child.url==='https://jp.mercari.com/item/'+child.id&&Number.isFinite(child.price)&&child.price>0&&
    exactTitle(child.title)===exactTitle(entry.title)&&exactCondition(child.condition)===exactCondition(entry.condition));
   if(matches.length!==1){unresolved.push({...entry,reason:matches.length?'ambiguous_original_listing':'original_detail_missing'});continue}
   const child=matches[0],old=(parent.components||[]).find(c=>c.id===child.id&&c.title===child.title&&JSON.stringify(c.images)===JSON.stringify(child.images));
   const component={...child,detailVerified:true,bundleDeclaredTitle:entry.title};
   if(old)for(const key of ['primaryFingerprint','webImages','xianyuImages','webImageVersion','webImageCheckedAt','webImageStatus','webImageReason','webImageRetryAt','webImageDiagnostics','imageCheckedAt','imageLookupStatus'])if(key in old)component[key]=old[key];
   components.push(component);
  }
  parent.components=components;parent.bundleDeclarations=declared;parent.bundleUnresolved=unresolved;
  parent.bundleComplete=declared.length>1&&components.length===declared.length;
  parent.bundleResolution=parent.bundleComplete?'exact_same_seller_details':declared.length?'original_details_pending':'contents_unconfirmed';
 }
 return records;
}

export function expandMerchantBundles(records={}){
 resolveMercariBundles(records);
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
