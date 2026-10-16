import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createLiveInventoryGraph} from '../scripts/lib/live-inventory-graph.mjs';
import {imageFingerprints,configureImageFingerprintCache} from '../scripts/lib/image.mjs';
import {pricingDecision,PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import {cycleCoverage} from '../scripts/lib/cycle-coverage.mjs';
import {compactDashboardResult} from '../scripts/lib/publish.mjs';
import {FakeClock} from './fixtures/full-cycle-graph-fixtures.mjs';
import {fixtureTitle,fixtureDescription,ownId,itemUrl,imageUrl,searchHtml,detailHtml} from './fixtures/rakuma-graph-observed-layout.mjs';
// Synthetic HTML and generated images only; this does not measure live capacity.
const START=Date.parse('2026-10-16T00:00:00Z'),iso=t=>new Date(t).toISOString(),yurl=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const ydetail=(id,sellerId,price=7800)=>({id,title:fixtureTitle,description:fixtureDescription,status:'OPEN',price,seller:{id:sellerId},images:[imageUrl(id.startsWith('own')?1:2)],condition:{text:'未使用'},deliveryMethod:{id:'YAMATO',name:'おてがる配送'},categoryList:[{name:'雑貨'}]});
const yhtml=item=>`<main><h1>${item.title}</h1><div><span class="ItemPrice__Component">${item.price}円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><h2>商品の説明</h2></main><script id="__NEXT_DATA__">${JSON.stringify({props:{initialState:{itemsState:{items:{item}}}}})}</script>`;
const ysearch=()=>`<script id="__NEXT_DATA__">${JSON.stringify({props:{initialState:{searchState:{search:{result:{items:[{id:'candidate',title:fixtureTitle,price:7800,sellerId:'external',itemStatus:'OPEN',thumbnailImageUrl:imageUrl(2)}],totalResultsAvailable:1,totalResultsReturned:1}}}}}})}</script>`;
const oldComparison=()=>({rulesVersion:PRICING_RULES_VERSION,status:'ok',evidenceStatus:'ok',checkedAt:iso(START-60000),searchCheckedAt:iso(START-60000),candidates:[{id:'old',url:yurl('old'),title:fixtureTitle,price:2000,sellerId:'old-external',image:imageUrl(2),matchMethod:'verified',checkedAt:iso(START-60000)}],lowestPrice:2000});
let oldFetch,fingerprint;
test.before(async()=>{
 const bytes=await sharp(Buffer.from('<svg width="96" height="96"><rect width="96" height="96" fill="white"/><path d="M8 6L65 11L84 84L24 74Z" fill="#367bd4"/><circle cx="41" cy="38" r="12" fill="#e6a223"/></svg>')).png().toBuffer();
 oldFetch=globalThis.fetch;globalThis.fetch=async url=>{assert.match(String(url),/^https:\/\/img\.fril\.jp\/img\/[12]\/l\/product\.png$/);return new Response(bytes,{headers:{'content-type':'image/png','cache-control':'public,max-age=3600'}})};
 configureImageFingerprintCache({now:()=>START});fingerprint=await imageFingerprints(imageUrl(1));assert.ok(fingerprint);
});
test.after(()=>{globalThis.fetch=oldFetch;configureImageFingerprintCache();});
function setup({twoYahoo=false,old=false,deadlineMs=1200000,yahooFailure=null,missingInventoryProof=false,truncated=false,ownChange={}}={}){
 const clock=new FakeClock(START),accounts=[{id:'a',platform:'yahoo',sellerId:'managed-a',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/managed-a'},{id:'b',platform:'rakuma',sellerId:'100',profileUrl:'https://fril.jp/shop/100'}];
 if(twoYahoo)accounts.push({id:'c',platform:'yahoo',sellerId:'managed-c',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/managed-c'});
 const contexts=accounts.map(account=>{
  const id=account.platform==='rakuma'?ownId:'own-'+account.id,source=account.platform,item={id,title:fixtureTitle,accountId:account.id,platform:source,comparisonMode:'same_platform',ownPrice:9000,sellerId:account.sellerId,image:imageUrl(1),url:source==='rakuma'?itemUrl(id):yurl(id),description:'old description must not be borrowed',...(old?{[source]:oldComparison()}:{}),manualCost:123};
  return {account,activeItems:[item],previousItems:old?[structuredClone(item)]:[],previousById:new Map(old?[[id,structuredClone(item)]]:[]),profileStatus:'live',profileDiscovery:{complete:true,pages:1,truncated,...(missingInventoryProof?{}:{observedAt:START,fromCache:false})},yahooById:new Map(),rakumaById:new Map(),mercariById:new Map()};
 });
 const reads=[],reader=source=>async(url,options)=>{
  reads.push({source,url,at:clock.now(),options});assert.equal(options.deadlineAt,START+deadlineMs);assert.ok(options.signal instanceof AbortSignal);
  if(source==='yahoo'&&yahooFailure)throw yahooFailure;
  const html=source==='rakuma'?(url.startsWith('https://fril.jp/s?')?searchHtml():detailHtml(url===itemUrl(ownId)?{id:ownId,price:9000,sellerId:'100',image:imageUrl(1),...ownChange}:{})):
    url.includes('/search/')?ysearch():yhtml(url.includes('/item/own-')?{...ydetail(url.split('/').at(-1),'managed-'+url.at(-1),9100),...ownChange}:ydetail('candidate','external'));
  return {html,status:200,observedAt:clock.now(),fromCache:false,url,finalUrl:url};
 };
 const previous={manualCosts:{'a:own-a':{purchaseCNY:99}},matchCorrections:{},items:contexts.flatMap(c=>c.previousItems)};
 const session=createLiveInventoryGraph({accounts,contexts,settings:{comparisonMode:'same_platform',yahooConcurrency:1,rakumaConcurrency:1},previous,startedAt:START,deadline:START+deadlineMs,clock},{fetchYahooPage:reader('yahoo'),fetchRakumaPage:reader('rakuma'),imageFingerprints:async()=>structuredClone(fingerprint)});
 return {session,contexts,accounts,clock,reads,previous};
}
const rowsFor=contexts=>contexts.flatMap(c=>c.activeItems.map(item=>({...item,[item.platform]:c[`${item.platform}ById`].get(item.id)})));
test('real adapter→all-account graph→publication consumers retain complete price and missing cost truthfully',async()=>{
 const {session,contexts,accounts,clock,reads,previous}=setup({twoYahoo:true}),saved=JSON.stringify(previous),out=await session.run();session.close();
 assert.equal(out.report.total,3);assert.equal(out.report.priceComplete,3,JSON.stringify(out.report));assert.equal(out.report.costVerified,0);assert.equal(out.report.complete,false);
 assert.equal(reads.filter(r=>r.source==='yahoo'&&r.url.includes('/search/')).length,1);assert.equal(reads.filter(r=>r.url===yurl('candidate')).length,1);
 const rows=rowsFor(contexts),coverage=cycleCoverage(rows,accounts.map(a=>({...a,profileStatus:'live'})),{startedAt:START,finishedAt:clock.now()}),compact=compactDashboardResult({items:rows,accounts,cycleCoverage:coverage},{now:clock.now()});
 assert.equal(coverage.total,3);assert.equal(coverage.priceComplete,3);assert.equal(coverage.costVerified,0);assert.equal(coverage.accepted,false);
 for(const item of compact.items){assert.equal(item[item.platform].candidates.length,1);assert.equal(item[item.platform].candidates[0].price,7800);assert.equal(pricingDecision(item,{now:clock.now()}).recommendedPrice,7799);}
 assert.equal(contexts[0].activeItems[0].ownPrice,9100);assert.equal(contexts[0].activeItems[0].sourceDetail.description,fixtureDescription);assert.equal(JSON.stringify(previous),saved);
});
test('procurement hydration shares the exact own-page observation without borrowing old description',async()=>{
 const {session,contexts,reads}=setup(),[hydrated,out]=await Promise.all([session.hydrate(contexts[0].activeItems[0]),session.run()]);session.close();
 assert.equal(out.report.total,2);assert.equal(reads.filter(r=>r.url===yurl('own-a')).length,1);assert.equal(hydrated.sourceDetail.checkedAt,iso(START));assert.equal(hydrated.description,fixtureDescription);assert.equal(hydrated.yahoo.ownDescription,fixtureDescription);assert.ok(out.stats.yahoo.sharedReuses>=1);assert.equal(contexts[0].yahooById.get('own-a').checkedAt,iso(START));
});
test('denied Yahoo stays stale while Rakuma progresses, without dropping inventory',async()=>{
 const {session,contexts,reads}=setup({old:true,yahooFailure:Object.assign(new Error('HTTP429'),{httpStatus:429,retryAfter:'120',retryAt:START+120000})}),out=await session.run();session.close();
 assert.equal(out.report.total,2);assert.equal(out.report.priceComplete,1);assert.equal(out.report.complete,false);const stale=contexts[0].yahooById.get('own-a');assert.equal(stale.status,'stale');assert.equal(stale.checkedAt,iso(START-60000));assert.equal(stale.candidates[0].checkedAt,iso(START-60000));assert.equal(stale.deferredReason,'source_denied');assert.equal(reads.filter(r=>r.source==='yahoo').length,1);assert.equal(contexts[1].rakumaById.get(ownId).status,'ok');
});
test('expired budget produces every result but renews no stale evidence',async()=>{
 const {session,contexts,clock}=setup({old:true,twoYahoo:true,deadlineMs:1});clock.time=START+1;const out=await session.run();session.close();assert.equal(out.report.total,3);assert.equal(out.report.priceComplete,0);
 for(const item of rowsFor(contexts)){assert.equal(item[item.platform].status,'stale');assert.equal(item[item.platform].checkedAt,iso(START-60000));}assert.equal(out.stats.yahoo.collectorCalls+out.stats.rakuma.collectorCalls,0);
});
test('missing inventory receipt remains incomplete even after successful details',async()=>{
 const {session}=setup({missingInventoryProof:true}),out=await session.run();session.close();assert.equal(out.report.total,2);assert.equal(out.report.coverageComplete,false);assert.ok(out.report.inventoryIssues.length);assert.equal(out.summary.productionAccepted,false);
});
test('changed own identity rejects current cost hydration and preserves old own price',async()=>{
 for(const ownChange of [{description:''},{title:'Different product'},{seller:{id:'foreign'},sellerId:'foreign'}]){const {session,contexts}=setup({ownChange});await assert.rejects(session.hydrate(contexts[0].activeItems[0]),/current_own_identity_changed_or_unavailable/);const out=await session.run();session.close();assert.equal(out.report.priceComplete,0);assert.equal(contexts[0].activeItems[0].ownPrice,9000);}
});
test('invalid account universe preserves stale evidence for publication',async()=>{
 const {session,contexts}=setup({old:true});session.close();const invalid=createLiveInventoryGraph({accounts:[contexts[0].account,contexts[0].account],contexts,settings:{comparisonMode:'same_platform'},previous:{},startedAt:START,deadline:START+1000,clock:new FakeClock(START)},{fetchYahooPage:()=>{throw Error('must not read');},fetchRakumaPage:()=>{throw Error('must not read');},imageFingerprints});
 const out=await invalid.run();assert.equal(out.summary.error,'graph_inventory_plan_invalid');assert.equal(out.summary.total,2);assert.equal(contexts[0].yahooById.get('own-a').checkedAt,iso(START-60000));assert.equal(contexts[1].rakumaById.get(ownId).status,'stale');
});
test('closing shared reader rejects late bodies and later callers',async()=>{
 const {session,contexts,accounts}=setup();session.close();let resolve;const live=createLiveInventoryGraph({accounts,contexts,settings:{comparisonMode:'same_platform'},previous:{},startedAt:START,deadline:START+1000,clock:new FakeClock(START)},{imageFingerprints,fetchYahooPage:()=>new Promise(r=>{resolve=r;}),fetchRakumaPage:()=>{throw Error('unexpected');}});
 const pending=live.hydrate(contexts[0].activeItems[0]);live.close();resolve({status:200,fromCache:false,observedAt:START,html:yhtml(ydetail('own-a','managed-a'))});await assert.rejects(pending,{code:'request_deferred'});await assert.rejects(live.hydrate(contexts[0].activeItems[0]),{code:'request_deferred'});
});

test('contradictory truncated inventory receipt cannot become a trusted complete inventory',async()=>{
 const {session}=setup({truncated:true}),out=await session.run();session.close();
 assert.equal(out.report.total,2);assert.equal(out.report.priceComplete,2);assert.equal(out.report.coverageComplete,false);
 assert.ok(out.report.inventoryIssues.some(issue=>issue.code==='inventory_pagination_incomplete'));
 assert.equal(session.planned.assessInventoryCoverage(null,{now:START+1200000}).complete,false);
});

test('cost-driven current own hydration survives an unstarted graph node without completing pricing',async()=>{
 const {session,contexts,clock,previous}=setup({old:true}),saved=JSON.stringify(previous),item=contexts[0].activeItems[0];
 const fresh=await session.hydrate(item);assert.equal(item.sourceDetail.description,fixtureDescription);assert.equal(item.ownPrice,9100);
 assert.equal(item.sourceDetail.observedAt,iso(START));assert.equal(fresh.sourceDetail.observedAt,iso(START));
 const own=session.planned.graph.nodes.get(session.planned.graph.targets.get('a:own-a').ownId);assert.equal(own.status,'pending');
 clock.time=START+1200000;const out=await session.run();session.close();
 assert.equal(out.report.ownIdentityVerified,0);assert.equal(out.report.priceComplete,0);assert.equal(out.report.costVerified,0);assert.equal(out.report.complete,false);
 assert.equal(item.sourceDetail.description,fixtureDescription);assert.equal(item.sourceDetail.observedAt,iso(START));
 assert.equal(contexts[0].yahooById.get(item.id).checkedAt,iso(START-60000));assert.equal(JSON.stringify(previous),saved);
});
