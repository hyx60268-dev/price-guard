import { sameDiscoveryProduct,canonicalSaleTitle } from './discovery.mjs';
import { buildOwnedOffers,isOwnedOffer } from '../../public/owned-offers.js';
import { productFamily } from './rules.mjs';

const heading=value=>canonicalSaleTitle(value).replace(/新発売/g,' ').replace(/AeroClip\s*2/gi,'AeroClip2').replace(/レッドイヤホン/g,'レッド ワイヤレスイヤホン').replace(/ギフトボックスセット/g,'ギフトボックス').replace(/\s+/g,' ').trim();
const shape=p=>({title:heading(p.sourceTitle||p.title||''),description:p.sourceDescription||p.description||p.yahoo?.ownDescription||p.sourceDetail?.description||''});
const images=p=>[...(p.sourceImages||[]),...(p.images||[]),...(p.yahoo?.ownImages||[]),p.image].filter(Boolean);
export function sameMerchantProduct(a,b){
 const left=shape(a),right=shape(b);
 if(!sameDiscoveryProduct(left,right))return false;
 // Card artwork can vary even when the series and rarity match. A shared
 // concrete image is required before hiding or grouping such records.
 if([productFamily(left.title),productFamily(right.title)].includes('card'))return images(a).some(url=>images(b).includes(url));
 return true;
}
export function curateMerchantProducts(products=[],dashboard={}){
 const owned=dashboard.items||[],index=buildOwnedOffers([...(dashboard.accounts||[]),...(dashboard.managedAccounts||[])],owned),groups=[];
 let excludedOwned=0;
 for(const p of products){
  if(isOwnedOffer(index,p.sourcePlatform,{id:p.sourceId,url:p.sourceUrl,sellerId:p.seller?.id})||owned.some(item=>sameMerchantProduct(p,item))){excludedOwned++;continue}
  // Compare to every member to avoid transitive merging of distinct variants.
  let group=groups.find(g=>g.every(other=>sameMerchantProduct(p,other)));
  if(!group){group=[];groups.push(group)}group.push(p);
 }
 return {products:groups.map(g=>({...g[0],observations:g.map(p=>({...p,observations:undefined})),listingCount:g.length,
  sourceImages:[...new Set(g.flatMap(p=>p.sourceImages||[]))],sourcePhotos:g.flatMap(p=>(p.sourceImages||[]).map(url=>({url,sourceUrl:p.sourceUrl}))),
  webImages:g.flatMap(p=>p.webImages||[]),xianyuImages:g.flatMap(p=>p.xianyuImages||[])})),excludedOwned,mergedListings:products.length-excludedOwned-groups.length};
}
