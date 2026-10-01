import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnedOffers,isOwnedOffer,excludeOwnedOffers } from '../public/owned-offers.js';
import { merchantProfile,mergeMerchantConfigs } from '../public/merchant-config.js';
import { reconcileDurableState } from '../scripts/lib/state.mjs';
import { scopeResultForPortalUser,compactDashboardResult } from '../scripts/lib/publish.mjs';
import { pricingDecision,PRICING_RULES_VERSION } from '../public/pricing-policy.js';
import { pricingSummary } from '../public/pricing-status.js';
import { mercariCompare } from '../scripts/lib/mercari.mjs';
import { yahooCompare } from '../scripts/lib/yahoo.mjs';
const accounts=[{id:'melon',platform:'yahoo',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/shopA'},{id:'momo',platform:'yahoo',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/shopB'},{id:'rakuma',platform:'rakuma',profileUrl:'https://fril.jp/shop/hash'}];
const inventory=[{accountId:'melon',id:'z1',sellerId:'shopA'},{accountId:'momo',id:'z2',sellerId:'shopB'},{accountId:'rakuma',id:'a'.repeat(32),sellerId:'1234'}];
const owned=buildOwnedOffers(accounts,inventory),now=Date.now();
const source=(candidates=[])=>({status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(now).toISOString(),candidates});
const offer=(price,id,sellerId)=>({id,price,sellerId,url:'https://paypayfleamarket.yahoo.co.jp/item/'+id,matchMethod:'verified'});
for(const accountId of ['melon','momo','rakuma'])test(`${accountId}: all registered shops excluded from live and cached recommendations`,()=>{
 const row={accountId,ownPrice:30000,yahoo:source([offer(19000,'z2','shopB'),offer(28000,'z9','external')]),rakuma:source(),mercari:source()};
 const clean=excludeOwnedOffers(row,owned);assert.equal(clean.yahoo.candidates.length,1);assert.equal(pricingDecision(clean).recommendedPrice,27999);
 assert.equal(isOwnedOffer(owned,'yahoo',{id:'unknown',sellerId:'shopB'}),true);
 assert.equal(isOwnedOffer(owned,'rakuma',{sellerId:'1234'}),true);
 assert.equal(isOwnedOffer(owned,'mercari',{sellerId:'1234'}),false);
 assert.equal(isOwnedOffer(owned,'yahoo',{url:'https://paypayfleamarket.yahoo.co.jp/item/z2'}),true);
});
test('own candidates stay own after compacting and cannot create a one yen self-undercut',()=>{
 const row={ownPrice:30000,yahoo:source([{...offer(30000,'self','shopA'),isOwn:true}]),rakuma:source(),mercari:source()};
 assert.equal(pricingDecision(compactDashboardResult({items:[row]}).items[0]).recommendedPrice,30000);
});
test('screenshot counts: 14 suggestions coexist with only 2 fully completed three-platform checks',()=>{
 const rows=Array.from({length:95},(_,i)=>({ownPrice:30000,yahoo:source(i<14?[offer(28000,'external','other')]:[]),rakuma:source(),mercari:i<2?source():{status:'incomplete',rulesVersion:PRICING_RULES_VERSION,checkedAt:new Date(now).toISOString()}}));
 const summary=pricingSummary(rows,{now});assert.equal(summary.ready,2);assert.equal(summary.actionable,14);assert.equal(summary.remaining,93);assert.match(summary.note,/不是同一项统计/);
});
test('merchant URL configuration validates hosts, canonicalizes duplicates and preserves deletion against old caches',()=>{
 const old={...merchantProfile('https://fril.jp/shop/abc?from=share'),updatedAt:'2026-09-27T00:00:00Z',enabled:true};
 const removed={...old,updatedAt:'2026-09-28T00:00:00Z',enabled:false};
 assert.equal(mergeMerchantConfigs([removed],[old])[0].enabled,false);
 assert.equal(mergeMerchantConfigs([old],[old]).length,1);
 assert.equal(reconcileDurableState({merchantMonitors:[removed]},{merchantMonitors:[old]}).merchantMonitors[0].enabled,false);
 for(const url of ['https://evil.example/user/a','https://fril.jp.evil.example/shop/a','javascript:alert(1)','https://user:pass@fril.jp/shop/a'])assert.throws(()=>merchantProfile(url));
 assert.equal(merchantProfile('https://jp.mercari.com/user/profile/123').platform,'mercari');
});
test('monitor configuration remains administrator-only in member dashboard',()=>{
 const scoped=scopeResultForPortalUser({accounts:[],items:[],merchantMonitors:[{url:'private'}]},{username:'member',accountIds:[]});assert.equal(scoped.merchantMonitors,undefined);
});
test('Mercari skips managed inventory before consuming detail request budget',async()=>{
 const result=await mercariCompare(null,{title:'test',ownPrice:30000},{ownedOffers:buildOwnedOffers([],[{platform:'mercari',id:'m1'}])},{imageFingerprints:async()=>null,search:async()=>({cards:[{id:'m1',title:'test',price:1,itemStatus:'OPEN'}],hasMore:false}),detail:async()=>{throw Error('must not fetch managed offer')}});
 assert.equal(result.detailCheckedCount,0);assert.equal(result.rejected[0].reason,'managed_shop');
});
test('Yahoo excludes another managed seller before detail matching',async()=>{
 const result=await yahooCompare(null,{id:'own',platform:'rakuma',title:'フィギュア',ownPrice:30000,sourceDetail:{description:'新品 未開封',images:[],status:'OPEN'}},{ownedOffers:owned,forceYahooBroadSearch:true},{fetchYahooResult:async()=>({items:[{id:'z2',title:'フィギュア',price:20000,sellerId:'shopB',itemStatus:'OPEN'}]}),imageFingerprints:async()=>null,fetchYahooItemBundle:async()=>{throw Error('must not read another managed listing')}});
 assert.equal(result.competitorCount,0);assert.ok(result.rejected.some(r=>r.id==='z2'&&r.reason==='own_seller'));
});

test('real configured yahoo_fleamarket shop is excluded even when new listing is not in inventory',async()=>{
 const {readFile}=await import('node:fs/promises');
 const config=JSON.parse(await readFile(new URL('../config/accounts.json',import.meta.url),'utf8'));
 const index=buildOwnedOffers(config.accounts,[]);
 assert.equal(isOwnedOffer(index,'yahoo',{id:'z694516642',sellerId:'p76217154'}),true);
 const row={platform:'yahoo_fleamarket',id:'another',ownPrice:22000,yahoo:source([offer(22000,'z694516642','p76217154')])};
 assert.equal(pricingDecision(excludeOwnedOffers(row,index)).recommendedPrice,22000);
});
test('z694516642 screenshot: missing seller and ownership index must never undercut itself',()=>{
 const row={platform:'yahoo_fleamarket',id:'z694516642',ownPrice:22000,yahoo:source([offer(22000,'z694516642',null)])};
 assert.equal(pricingDecision(row).recommendedPrice,22000);
 assert.equal(excludeOwnedOffers(row,buildOwnedOffers()).yahoo.candidates.length,0);
});
test('legacy platform aliases cover all shops, URL-only candidates and compacted cache',()=>{
 const index=buildOwnedOffers([{id:'melon',platform:'yahoo_fleamarket',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p76217154'},
 {id:'second',platform:'yahoo',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p2'},
 {id:'third',platform:'rakuma',profileUrl:'https://fril.jp/shop/third'}],
 [{accountId:'melon',platform:'yahoo_fleamarket',id:'z694516642'}]);
 for(const accountId of ['melon','second','third']){
 const row={accountId,ownPrice:22000,yahoo:source([offer(22000,'z694516642',null),offer(21000,'other','outside')])};
 const clean=excludeOwnedOffers(compactDashboardResult({items:[row]}).items[0],index);
 assert.equal(clean.yahoo.candidates.length,1);
 assert.equal(pricingDecision(clean).recommendedPrice,20999);
 }
 assert.equal(isOwnedOffer(index,'yahoo',{url:'https://paypayfleamarket.yahoo.co.jp/item/z694516642'}),true);
 assert.equal(isOwnedOffer(index,'mercari',{id:'z694516642'}),false);
});
