import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createYahooGraphAdapter,yahooGraphSearchSpec} from '../scripts/lib/yahoo-graph-adapter.mjs';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {imageFingerprints,configureImageFingerprintCache} from '../scripts/lib/image.mjs';
import {buildOwnedOffers} from '../public/owned-offers.js';
const at=Date.parse('2026-10-16T00:00:00Z'),cycle={cycleId:'synthetic',deadlineAt:at+1200000,purpose:'pricing',source:'yahoo',origin:'discovered'};
const title='スターバックス ブルー ステンレスボトル 370ml',description='新品 未使用 ブルー 370ml 1本';
const url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`,img=id=>`https://fixture.invalid/${id}.png`;
const target=()=>({id:'own',accountId:'fixture',platform:'yahoo',sellerId:'managed',title,ownPrice:9000,comparisonMode:'same_platform',own:{url:url('own'),accessScope:'public'},pricing:{yahoo:yahooGraphSearchSpec(title)}});
const detail=(extra={})=>({id:'candidate',title,description,status:'OPEN',price:7800,seller:{id:'external'},images:[img('candidate')],deliveryMethod:{id:'YAMATO',name:'おてがる配送'},condition:{text:'未使用'},categoryList:[{name:'タンブラー'}],...extra});
const own=(extra={})=>detail({id:'own',seller:{id:'managed'},images:[img('own')],price:9000,...extra});
const html=item=>`<main><h1>${item.title}</h1><div><span class="ItemPrice__Component">${item.price}円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><h2>商品の説明</h2></main><script id="__NEXT_DATA__">${JSON.stringify({props:{initialState:{itemsState:{items:{item}}}}})}</script>`;
const card=()=>({id:'candidate',title,price:7800,sellerId:'external',itemStatus:'OPEN',thumbnailImageUrl:img('candidate')});
const search=(extra={})=>`<script id="__NEXT_DATA__">${JSON.stringify({props:{initialState:{searchState:{search:{result:{items:[card()],totalResultsAvailable:1,totalResultsReturned:1,...extra}}}}}})}</script>`;
const index=()=>buildOwnedOffers([{id:'fixture',platform:'yahoo',sellerId:'managed'}],[target()]);
function fixture({candidate=detail(),ownDetail=own(),pageExtra={},settings={},searchExtra={},reader}={}){
 const reads=[],adapter=createYahooGraphAdapter({now:()=>at,imageFingerprints,settings:{ownedOffers:index(),...settings},fetchPage:async path=>{
  reads.push(path);if(reader)return reader(path);return {status:200,fromCache:false,observedAt:at,html:path.includes('/search/')?search(searchExtra):html(path===url('own')?ownDetail:candidate),...pageExtra};
 }});return {adapter,reads};
}
async function verify(options={}){
 const {adapter,reads}=fixture(options),item=target(),request=id=>({source:'yahoo',accessScope:'public',kind:'detail',url:url(id)});
 const ownRaw=await adapter.fetchRaw(request('own'),cycle),ownValidation=adapter.validateOwn(item,ownRaw,cycle),raw=await adapter.fetchRaw(request('candidate'),cycle);
 const result=await adapter.validateOffer(item,ownRaw,raw,{...cycle,ownIdentity:ownValidation.identity,candidate:{card:{...card(),...options.card}}});return {adapter,reads,item,ownRaw,raw,ownValidation,result};
}
let oldFetch;
test.before(async()=>{
 const bytes=await sharp(Buffer.from('<svg width="96" height="96"><rect width="96" height="96" fill="white"/><path d="M8 6L65 11L84 84L24 74Z" fill="#367bd4"/><circle cx="41" cy="38" r="12" fill="#e6a223"/></svg>')).png().toBuffer();
 oldFetch=globalThis.fetch;globalThis.fetch=async path=>{assert.match(String(path),/^https:\/\/fixture\.invalid\/(own|candidate)\.png$/);return new Response(bytes,{headers:{'content-type':'image/png','cache-control':'public,max-age=3600'}})};
 configureImageFingerprintCache({now:()=>at});
});
test.after(()=>{globalThis.fetch=oldFetch;configureImageFingerprintCache();});
test('actual parser and extracted legacy verifier agree on a current payable offer',async()=>{
 const {result,ownValidation}=await verify();assert.equal(ownValidation.complete,true);assert.ok(Object.values(result.gates).every(v=>v==='pass'),JSON.stringify(result));
 assert.equal(result.quote.price,7800);assert.equal(result.quote.shipping,0);assert.equal(result.quote.observationTime,at);
 const legacy=await yahooCompare(null,{...target(),image:img('own')},{ownedOffers:index()},{imageFingerprints,fetchYahooItemBundle:async id=>({detail:id==='own'?own():detail(),recommendations:[]}),fetchYahooResult:async()=>({items:[card()]})});
 assert.equal(legacy.competitorCount,1);assert.equal(result.quote.matchMethod,legacy.candidates[0].matchMethod);
});
for(const [name,change,reason] of [
 ['colour',{description:'新品 未使用 レッド 370ml 1本'},'description_color_mismatch'],
 ['quantity',{description:'新品 未使用 ブルー 370ml 3本セット'},'sale_unit_mismatch'],
 ['condition',{description:'中古 使用済み ブルー 370ml 1本'},'condition_or_packaging_mismatch'],
 ['defect',{description:'傷あり ブルー 370ml 1本'},'defect'],['sold',{status:'SOLD'},'not_open'],
 ['description',{description:''},'sale_description_unavailable'],['seller',{seller:{}},'detail_seller_missing'],
 ['delivery method',{deliveryMethod:{}},'target_shipping_or_currency_unconfirmed'],['currency',{currency:'USD'},'target_shipping_or_currency_unconfirmed']
])test(`${name} conflict or missing evidence cannot produce a quote`,async()=>{const {result}=await verify({candidate:detail(change)});assert.equal(result.reason,reason);assert.equal(result.quote,undefined);});
test('changed own title or blank description cannot borrow historic identity',async()=>{
 for(const change of [{title:'Different product'},{description:''},{seller:{id:'changed'}}]){const {ownValidation,result}=await verify({ownDetail:own(change)});assert.equal(ownValidation.complete,false);assert.equal(result.quote,undefined);}
});
test('owned inventory and corrections are enforced on actual detail',async()=>{
 assert.equal((await verify({candidate:detail({seller:{id:'managed'}}),card:{sellerId:'managed'}})).result.reason,'own_seller');
 const records={one:{accountId:'fixture',itemId:'own',platform:'yahoo',candidateId:'candidate'}};
 assert.equal((await verify({settings:{matchCorrections:records}})).result.reason,'saved_user_correction');
 assert.equal((await verify({settings:{ownedOffers:null}})).result.reason,'managed_inventory_index_missing');
});
test('denials retain status and Retry-After provenance without alternate reads',async()=>{
 for(const status of [401,403,429]){
  const {adapter,reads}=fixture({reader:()=>{throw Object.assign(new Error('Denied'),{httpStatus:status,retryAfter:'120',retryAt:at+120000});}});
  await assert.rejects(adapter.fetchRaw({source:'yahoo',accessScope:'public',kind:'detail',url:url('own')},cycle),{code:'ACCESS_DENIED',httpStatus:status,retryAfter:'120',retryAt:at+120000});assert.equal(reads.length,1);
 }
});
test('missing HTTP200, redirects, cached and future responses never create current evidence',async()=>{
 for(const pageExtra of [{status:undefined},{status:206},{status:200,httpStatus:403},{fromCache:true},{fromCache:undefined},{observedAt:at+1},{observedAt:undefined},{url:'https://example.invalid/login'},{redirected:true}]){
  const {adapter}=fixture({pageExtra});await assert.rejects(adapter.fetchRaw({source:'yahoo',accessScope:'public',kind:'detail',url:url('own')},cycle));
 }
});
test('query completion requires observed exact first-page totals and adapter receipt',async()=>{
 for(const [searchExtra,complete] of [[{},true],[{totalResultsAvailable:20},false],[{totalResultsAvailable:undefined},false],[{offset:10},false]]){
  const {adapter}=fixture({searchExtra}),request={...yahooGraphSearchSpec(title),source:'yahoo',kind:'search'},raw=await adapter.fetchRaw(request,cycle);
  assert.equal(raw.data.complete,complete);assert.equal(adapter.assessDiscoveryCoverage(request,raw,cycle).accepted,true);
  const forged=structuredClone(raw);forged.data.complete=!complete;assert.equal(adapter.assessDiscoveryCoverage(request,forged,cycle).accepted,false);
 }
});
test('known-card changes are not definitive exclusion; unknown availability cannot claim rejection',async()=>{
 const {adapter,item,ownRaw,ownValidation}=await verify();
 assert.equal(adapter.screenCandidate(item,ownRaw,{...card(),title:'Old unrelated card',sellerId:'managed'}, {...cycle,origin:'known',ownIdentity:ownValidation.identity}).decision,'detail');
 assert.equal((await verify({candidate:detail({status:'UNKNOWN'})})).result.reason,'availability_unconfirmed');
});
test('pricing adapter cannot supply procurement evidence',async()=>{
 const {adapter,item,ownRaw,raw,ownValidation}=await verify();const result=await adapter.validateOffer(item,ownRaw,raw,{...cycle,purpose:'procurement',ownIdentity:ownValidation.identity});assert.equal(result.quote,undefined);
});

test('collector deferral with prior HTTP429 retains the original non-denial hold',async()=>{
 const error=Object.assign(new Error('held'),{code:'request_deferred',httpStatus:429,reason:'request_cooldown_deadline',retryAt:at+3600000,retryAfter:'3600'});
 const {adapter,reads}=fixture({reader:()=>{throw error;}});
 await assert.rejects(adapter.fetchRaw({source:'yahoo',accessScope:'public',kind:'detail',url:url('own')},cycle),actual=>actual===error&&actual.code==='request_deferred');assert.equal(reads.length,1);
});
