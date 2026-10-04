import { sameDiscoveryProduct,canonicalSaleTitle } from './discovery.mjs';
import { buildOwnedOffers,isOwnedOffer } from '../../public/owned-offers.js';
import { productFamily } from './rules.mjs';
import { imageFingerprints,primaryProductSimilarity } from './image.mjs';
import { reviewedMerchantArtworkPair } from './reviewed-merchant-artwork.mjs';

const heading=value=>canonicalSaleTitle(value).replace(/新発売/g,' ').replace(/AeroClip\s*2/gi,'AeroClip2').replace(/レッドイヤホン/g,'レッド ワイヤレスイヤホン').replace(/ギフトボックスセット/g,'ギフトボックス').replace(/\s+/g,' ').trim();
const shape=p=>({title:heading(p.sourceTitle||p.title||''),description:p.sourceDescription||p.description||p.yahoo?.ownDescription||p.sourceDetail?.description||''});
const images=p=>[...(p.sourceImages||[]),...(p.images||[]),...(p.yahoo?.ownImages||[]),p.image].filter(Boolean);
export function merchantIdentityCompatible(a,b){
 const left=shape(a),right=shape(b);
 // A profile card can precede its detail fetch. Missing description is unknown,
 // not a conflicting condition; compare headings until both details exist.
 if(!left.description||!right.description){left.description='';right.description=''}
 return sameDiscoveryProduct(left,right);
}
export function sameMerchantProduct(a,b){
 if(!merchantIdentityCompatible(a,b))return false;
 // Card artwork can vary even when the series and rarity match. A shared
 // concrete image is required before hiding or grouping such records.
 if([productFamily(shape(a).title),productFamily(shape(b).title)].includes('card')){
  const x=images(a)[0],y=images(b)[0];
  if(x&&x===y)return true;
  return x&&y&&a.primaryFingerprint?.url===x&&b.primaryFingerprint?.url===y&&primaryProductSimilarity(a.primaryFingerprint,b.primaryFingerprint)>=.98||false;
 }
 return true;
}
export function merchantOwnedProducts(dashboard={}){
 return [...(dashboard.items||[]),...Object.values(dashboard.listingHistory||{}),
  ...Object.values(dashboard.dismissedDiscoveries||{}).filter(r=>r&&!r.deleted)];
}
// Download only primary images of text-compatible card pairs. Results are
// persisted in the encrypted discovery state so repacking needs no network.
export async function prepareMerchantVisuals(products,dashboard,{fingerprint=imageFingerprints,deadline=Infinity,maxImages=40}={}){
 const owned=merchantOwnedProducts(dashboard),all=[...products,...owned],cache=dashboard.merchantPrimaryImages||{};
 for(const p of all){const url=images(p)[0];if(url&&cache[url])p.primaryFingerprint=cache[url]}
 let count=0;
 for(const p of products){
  if(productFamily(shape(p).title)!=='card')continue;
  for(const other of all){
   if(p===other||!merchantIdentityCompatible(p,other))continue;
   const reviewed=reviewedMerchantArtworkPair(p,other,{withBytes:false});
   for(const item of [p,other]){
    const url=images(item)[0];if(!url)continue;
    if(reviewed&&cache[url]&&!cache[url].contentSha256)delete cache[url];
    if(!cache[url]&&count<maxImages&&Date.now()<deadline){count++;const value=await fingerprint(url);if(value)cache[url]=value}
    if(cache[url])item.primaryFingerprint=cache[url];
   }
  }
 }
 return cache;
}
export function curateMerchantProducts(products=[],dashboard={}){
 const owned=merchantOwnedProducts(dashboard),index=buildOwnedOffers([...(dashboard.accounts||[]),...(dashboard.managedAccounts||[])],owned),groups=[];
 for(const p of [...products,...owned]){const url=images(p)[0];if(dashboard.merchantPrimaryImages?.[url])p.primaryFingerprint=dashboard.merchantPrimaryImages[url]}
 let excludedOwned=0;const reviewedOwnedExclusions=[];
 for(const p of products){
  if(isOwnedOffer(index,p.sourcePlatform,{id:p.sourceId,url:p.sourceUrl,sellerId:p.seller?.id})||owned.some(item=>sameMerchantProduct(p,item))){excludedOwned++;continue}
  let reviewed;
  for(const item of owned){const evidence=reviewedMerchantArtworkPair(p,item);if(evidence&&merchantIdentityCompatible(p,item)){reviewed=evidence;break}}
  if(reviewed){excludedOwned++;reviewedOwnedExclusions.push({productId:p.sourceId,ownedId:reviewed.ownedId,method:reviewed.kind});continue}
  // Compare to every member to avoid transitive merging of distinct variants.
  let group=groups.find(g=>g.every(other=>sameMerchantProduct(p,other)));
  if(!group){group=[];groups.push(group)}group.push(p);
 }
 return {products:groups.map(g=>({...g[0],observations:g.map(p=>({...p,observations:undefined})),listingCount:g.length,
  sourceImages:[...new Set(g.flatMap(p=>p.sourceImages||[]))],sourcePhotos:g.flatMap(p=>(p.sourceImages||[]).map(url=>({url,sourceUrl:p.sourceUrl}))),
  webImages:g.flatMap(p=>p.webImages||[]),xianyuImages:g.flatMap(p=>p.xianyuImages||[])})),excludedOwned,reviewedOwnedExclusions,mergedListings:products.length-excludedOwned-groups.length};
}
