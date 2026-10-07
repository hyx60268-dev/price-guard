import { parseShopProfile } from '../../public/shop-profile.js';
import { normalizeOfferPlatform } from '../../public/owned-offers.js';

export function profileListingHistoryItems(account={},discovered={}){
 const profile=parseShopProfile(account.profileUrl),sellerId=profile?.platform==='yahoo_fleamarket'?new URL(profile.profileUrl).pathname.split('/').at(-1):'';
 if(!discovered||!account.id||normalizeOfferPlatform(account.platform)!=='yahoo'||!sellerId||discovered.complete!==true||
  discovered.profileUrl!==profile.profileUrl||discovered.profileSellerId!==sellerId||account.sellerId&&String(account.sellerId)!==sellerId)return [];
 return (discovered.listedItems||[]).filter(item=>item?.id&&String(item.title||'').trim()&&
  item.url===`https://paypayfleamarket.yahoo.co.jp/item/${item.id}`&&
  [item.sellerId,item.seller?.id].filter(Boolean).every(id=>String(id)===sellerId)).map(item=>({
   ...item,accountId:account.id,platform:'yahoo',sellerId,profileUrl:profile.profileUrl
  }));
}

export function mergeOwnedListingHistory({previous={},contexts=[],items=[],relistAliases={}}={}){
 const listed=contexts.flatMap(context=>profileListingHistoryItems(context.account,context.profileDiscovery));
 const listingHistory={...(previous?.listingHistory||{})};
 for(const item of [...(previous?.items||[]),...listed,...items]){
  if(!item.accountId||!item.id)continue;
  const key=`${item.accountId}:${item.id}`,record={...listingHistory[key],id:item.id,accountId:item.accountId};
  for(const field of ['title','xianyuQuery','image','relistedFrom','platform','sellerId','profileUrl','itemStatus']){
   if(item[field]!==undefined&&item[field]!==null&&item[field]!=='')record[field]=item[field];
  }
  listingHistory[key]=record;
 }
 for(const [key,oldId] of Object.entries(relistAliases))delete listingHistory[`${key.slice(0,key.lastIndexOf(':'))}:${oldId}`];
 const ownedTitleHistory=[...new Set([
  ...(previous?.ownedTitleHistory||[]),...(previous?.items||[]).map(item=>item.title),
  ...contexts.flatMap(context=>(context.catalogItems||[]).map(item=>item.title)),...listed.map(item=>item.title),...items.map(item=>item.title)
 ].map(value=>String(value||'').trim()).filter(Boolean))].slice(-5000);
 return {listingHistory,ownedTitleHistory};
}
