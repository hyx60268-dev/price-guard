import {requiredPricingPlatforms} from '../../public/pricing-policy.js';
import {exactQueryFor,queryFor} from './yahoo.mjs';

const sourcePlatform=value=>value==='yahoo_fleamarket'?'yahoo':value;
const list=value=>Array.isArray(value)?value:[];
const link=value=>{
 try{const url=new URL(value);return url.protocol==='https:'?url.href:null}catch{return null}
};
const pageKey=(platform,row)=>link(row?.url||row?.canonicalUrl)||row?.id&&`${platform}:${row.id}`||null;

// Planning counts only. A repeated query is not a same-SKU binding, and a stored
// supplier/competitor URL is not a current or accepted quote. No source is read.
export function inventoryReadPlan(contexts=[]){
 const platforms=Object.fromEntries(['yahoo','rakuma','mercari'].map(platform=>[platform,{items:0,queriedItems:0,queries:new Set(),ownPages:new Set(),candidatePages:new Set(),itemsWithStoredCandidates:0,sellers:new Map()}]));
 const accounts=[],supplierPages=new Set();let items=0,itemsWithStoredSupplierLinks=0,missingTitles=0;
 for(const context of list(contexts)){
  if(!context||typeof context!=='object')continue;
  const rows=list(context.activeItems).filter(item=>item&&typeof item==='object'),account=context.account||{};
  accounts.push({accountId:account.id,platform:sourcePlatform(account.platform),items:rows.length,inventoryObservation:context.profileStatus||'unknown',observedProfilePages:context.profileDiscovery?.pages??null});
  for(const item of rows){
   items++;if(!String(item.title||'').trim())missingTitles++;
   const prior=context.previousById?.get?.(item.id)||context.previousById?.get?.(item.relistedFrom)||{};
   for(const platform of requiredPricingPlatforms(item)){
    const counts=platforms[platform];counts.items++;
    const query=(platform==='yahoo'?queryFor:exactQueryFor)(String(item.title||''));if(query){counts.queries.add(query);counts.queriedItems++}
    if(sourcePlatform(item.platform)===platform&&item.id)counts.ownPages.add(pageKey(platform,item));
    let stored=false;
    for(const candidate of list(prior[platform]?.candidates)){
     const key=pageKey(platform,candidate);if(!key)continue;stored=true;counts.candidatePages.add(key);
     if(platform==='yahoo'&&candidate.sellerId){
      const seller=String(candidate.sellerId);if(!counts.sellers.has(seller))counts.sellers.set(seller,new Set());counts.sellers.get(seller).add(key);
     }
    }
    if(stored)counts.itemsWithStoredCandidates++;
   }
   let supplier=false;
   for(const quote of [...list(prior.xianyu?.samples),...list(prior.procurementSource?.samples),...list(prior.nativeSupplierQuotes)]){
    if(!quote||typeof quote!=='object')continue;
    const url=link(quote.canonicalUrl||quote.url);if(url){supplierPages.add(url);supplier=true}
   }
   if(supplier)itemsWithStoredSupplierLinks++;
  }
 }
 return {version:1,items,accounts,missingTitles,canonicalSkuGroups:null,
  platforms:Object.fromEntries(Object.entries(platforms).map(([platform,c])=>[platform,{
   items:c.items,itemsWithPrimaryQuery:c.queriedItems,uniquePrimarySearchQueries:c.queries.size,repeatedPrimaryQueryItems:c.queriedItems-c.queries.size,
   uniqueOwnDetailPages:c.ownPages.size,itemsWithStoredCandidates:c.itemsWithStoredCandidates,uniqueStoredCandidatePages:c.candidatePages.size,
   ...(platform==='yahoo'?{storedCandidateSellers:c.sellers.size,linkedOffersOnlySellerPageLowerBound:[...c.sellers.values()].reduce((sum,links)=>sum+Math.ceil(links.size/100),0)}:{})
  }])),
  supplierLinks:{itemsWithStoredLinks:itemsWithStoredSupplierLinks,uniqueStoredDetailUrls:supplierPages.size},
  limits:'Queries are exact current collector keys, not canonical products. Stored links need binding and current detail verification. Seller-page lower bound assumes 100 linked offers per page, excludes other seller inventory, and cannot replace description/shipping evidence. Candidate discovery, pagination, images and missing supplier links add unknown reads.'};
}
