import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverYahooProfile } from '../scripts/lib/yahoo.mjs';
import { profileListingHistoryItems,mergeOwnedListingHistory } from '../scripts/lib/owned-listing-history.mjs';
import { curateMerchantProducts } from '../scripts/lib/merchant-curation.mjs';

const account={id:'boss-yahoo',platform:'yahoo_fleamarket',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p6579087'};
// ID, title, seller and SOLD were read on the configured shop on 2026-10-08.
// No first-seen or sold date is fabricated from a profile card.
const red={id:'z686783784',title:'中国限定 Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 限定ギフトボックス レッド',sellerId:'p6579087',itemStatus:'SOLD'};
const externalRed={sourceId:'z692051952',sourcePlatform:'yahoo',seller:{id:'p59959877'},sourceTitle:'【中国限定】 Anker ワイヤレスイヤホン 張凌赫 コラボ ギフトボックスセット AeroClip2 レッドイヤホン'};
const discover=async(cards,overrides={})=>discoverYahooProfile(null,account.profileUrl,{}, {fetchYahooResult:async()=>({items:cards,totalResultsAvailable:cards.length,...overrides})});

test('13-page own profile retains page-7 historical SOLD while active inventory remains OPEN only',async()=>{
 const all=Array.from({length:1201},(_,i)=>({id:`fixture-${i}`,title:`fixture listing ${i}`,itemStatus:i===0?'OPEN':'SOLD',sellerId:'p6579087'}));
 all[600]=red;const requests=[];
 const found=await discoverYahooProfile(null,account.profileUrl,{}, {fetchYahooResult:async url=>{
  requests.push(url);const page=Number(new URL(url).searchParams.get('page'));
  return {items:all.slice((page-1)*100,page*100),totalResultsAvailable:all.length};
 }});
 assert.equal(requests.length,13);assert.equal(found.pages,13);assert.equal(found.complete,true);
 assert.deepEqual(found.items.map(item=>item.id),['fixture-0']);assert.equal(found.listedItems.length,1201);
 const history=mergeOwnedListingHistory({contexts:[{account,profileDiscovery:found}],items:found.items.map(item=>({...item,accountId:account.id}))});
 const stored=history.listingHistory['boss-yahoo:z686783784'];
 assert.equal(stored.title,red.title);assert.equal(stored.itemStatus,'SOLD');assert.equal(stored.sellerId,'p6579087');
 assert.equal(stored.profileUrl,account.profileUrl);assert.equal(stored.soldAt,undefined);assert.equal(stored.firstSeenAt,undefined);
 assert.ok(history.ownedTitleHistory.includes(red.title));
 const curated=curateMerchantProducts([externalRed],history);
 assert.equal(curated.excludedOwned,1);assert.deepEqual(curated.products,[]);
});

test('historical red single gift box excludes itself but not white or a two-box sale',async()=>{
 const found=await discover([red]);assert.deepEqual(found.items,[]);
 const history=mergeOwnedListingHistory({contexts:[{account,profileDiscovery:found}]});
 const white={...externalRed,sourceId:'white',sourceTitle:externalRed.sourceTitle.replace('レッド','ホワイト')};
 const two={...externalRed,sourceId:'two',sourceTitle:externalRed.sourceTitle+' 2セット'};
 const curated=curateMerchantProducts([externalRed,white,two],history);
 assert.equal(curated.excludedOwned,1);assert.deepEqual(curated.products.map(item=>item.sourceId),['white','two']);
});

test('profile history is tied to the current configured shop and rejects explicit foreign sellers',async()=>{
 const found=await discover([red,{...red,id:'foreign',sellerId:'p59959877',itemStatus:'OPEN'},
  {...red,id:'conflict',seller:{id:'p59959877'}},{...red,id:'no-card-seller',sellerId:undefined}]);
 assert.deepEqual(found.items,[]);assert.deepEqual(found.listedItems.map(item=>item.id),[red.id,'no-card-seller']);
 assert.deepEqual(profileListingHistoryItems({...account,profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p999'},found),[]);
 assert.deepEqual(profileListingHistoryItems({...account,sellerId:'p999'},found),[]);
 assert.deepEqual(profileListingHistoryItems({...account,platform:'rakuma'},found),[]);
 assert.deepEqual(profileListingHistoryItems(account,{...found,profileUrl:'https://example.test/user/p6579087'}),[]);
 const rows=profileListingHistoryItems(account,{...found,listedItems:[...found.listedItems,{...found.listedItems[0],id:'rogue',url:'https://paypayfleamarket.yahoo.co.jp/item/rogue',sellerId:'p999'}]});
 assert.equal(rows.length,2);assert.ok(rows.every(item=>item.accountId===account.id&&item.sellerId==='p6579087'));
 const other=mergeOwnedListingHistory({contexts:[{account:{...account,id:'separate-account'},profileDiscovery:found}]});
 assert.equal(other.listingHistory['boss-yahoo:z686783784'],undefined);assert.equal(other.listingHistory['separate-account:z686783784'].accountId,'separate-account');
});

test('partial pagination cannot replace saved history or invent an observation date',async()=>{
 await assert.rejects(discover([red],{totalResultsAvailable:101}),/分页不完整/);
 const previous={listingHistory:{'boss-yahoo:old':{id:'old',accountId:account.id,title:'saved title',image:'saved-image'}},ownedTitleHistory:['saved title']};
 const partial={...(await discover([red])),complete:false};
 const history=mergeOwnedListingHistory({previous,contexts:[{account,profileDiscovery:partial}]});
 assert.deepEqual(history.listingHistory,previous.listingHistory);assert.deepEqual(history.ownedTitleHistory,previous.ownedTitleHistory);
 const empty=mergeOwnedListingHistory({previous,contexts:[{account,profileDiscovery:await discover([])}]});
 assert.deepEqual(empty.listingHistory,previous.listingHistory);
 const failed=mergeOwnedListingHistory({previous,contexts:[{account,profileDiscovery:null,profileStatus:'error'}]});
 assert.deepEqual(failed.listingHistory,previous.listingHistory);assert.deepEqual(failed.ownedTitleHistory,previous.ownedTitleHistory);
});

test('history preserves existing relist metadata, account isolation and opaque bundle parents',async()=>{
 const bundle={...red,id:'bundle-parent',title:'＜まとめ買い＞ '+red.title+' 計2点'};
 const found=await discover([red,bundle]);
 const previous={items:[{id:'z686783784',accountId:account.id,title:red.title,xianyuQuery:'manual query'}],listingHistory:{
  'another:z686783784':{id:red.id,accountId:'another',title:'other account title'},
  'boss-yahoo:old-alias':{id:'old-alias',accountId:account.id,title:red.title}
 }};
 const history=mergeOwnedListingHistory({previous,contexts:[{account,profileDiscovery:found}],relistAliases:{'boss-yahoo:z686783784':'old-alias'}});
 assert.equal(history.listingHistory['boss-yahoo:z686783784'].xianyuQuery,'manual query');
 assert.equal(history.listingHistory['another:z686783784'].title,'other account title');
 assert.equal(history.listingHistory['boss-yahoo:old-alias'],undefined);
 assert.equal(history.listingHistory['boss-yahoo:bundle-parent'].title,bundle.title);
 assert.deepEqual(Object.keys(history.listingHistory).sort(),['another:z686783784','boss-yahoo:bundle-parent','boss-yahoo:z686783784']);
});

test('a newly observed title and image replace the same account/id history without changing another account',async()=>{
 const previous={listingHistory:{
  'boss-yahoo:z686783784':{id:red.id,accountId:account.id,title:red.title,image:'https://fixture.test/red.jpg'},
  'separate:z686783784':{id:red.id,accountId:'separate',title:'separate title',image:'https://fixture.test/separate.jpg'}
 }};
 const changed={...red,title:red.title.replace('レッド','ホワイト'),thumbnailImageUrl:'https://fixture.test/white.jpg'};
 const history=mergeOwnedListingHistory({previous,contexts:[{account,profileDiscovery:await discover([changed])}]});
 assert.equal(history.listingHistory['boss-yahoo:z686783784'].title,changed.title);
 assert.equal(history.listingHistory['boss-yahoo:z686783784'].image,changed.thumbnailImageUrl);
 assert.deepEqual(history.listingHistory['separate:z686783784'],previous.listingHistory['separate:z686783784']);
 const white={...externalRed,sourceId:'white',sourceTitle:externalRed.sourceTitle.replace('レッド','ホワイト')};
 const curated=curateMerchantProducts([externalRed,white],history);
 assert.equal(curated.excludedOwned,1);assert.deepEqual(curated.products.map(item=>item.sourceId),[externalRed.sourceId]);
});
