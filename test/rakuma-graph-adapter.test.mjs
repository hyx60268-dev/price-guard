import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createRakumaGraphAdapter,rakumaGraphSearchSpec} from '../scripts/lib/rakuma-graph-adapter.mjs';
import {rakumaCompare,extractRakumaDetail,screenRakumaCard} from '../scripts/lib/rakuma.mjs';
import {configureImageFingerprintCache,imageFingerprints} from '../scripts/lib/image.mjs';
import {fixtureTitle,fixtureDescription,ownId,candidateId,otherId,itemUrl,imageUrl,searchHtml,detailHtml,
  targetFixture,fixtureOwnedOffers} from './fixtures/rakuma-graph-observed-layout.mjs';
const at=Date.parse('2026-10-15T00:00:00.000Z');
const cycle={cycleId:'rakuma-fixture',source:'rakuma',purpose:'pricing',origin:'discovered',deadlineAt:at+1200000};
const ownHtml=()=>detailHtml({id:ownId,price:9000,sellerId:'100',image:imageUrl(1)});
const ownItem=()=>({...targetFixture(),sourceDetail:extractRakumaDetail(ownHtml(),itemUrl(ownId))});
function fixtureAdapter({html=detailHtml(),search=searchHtml(),own=ownHtml(),settings={},pageExtra={},reader,fingerprint=imageFingerprints}={}){
  const log=[],adapter=createRakumaGraphAdapter({settings:{ownedOffers:fixtureOwnedOffers(),...settings},now:()=>at,imageFingerprints:fingerprint,
    fetchPage:async(url,context)=>{log.push(url);if(reader)return reader(url,context);
      return {html:url.startsWith('https://fril.jp/s?')?search:url===itemUrl(ownId)?own:html,observedAt:at,fromCache:false,httpStatus:200,...pageExtra};}});
  return {adapter,log};
}
const request=(url,kind='detail')=>({source:'rakuma',accessScope:'public',kind,...(kind==='search'?{query:{url}}:{url})});
async function verifyFixture(options={}){
  const {adapter,log}=fixtureAdapter(options),target=targetFixture(),own=await adapter.fetchRaw(request(target.own.url),cycle);
  const ownValidation=await adapter.validateOwn(target,own,cycle),raw=await adapter.fetchRaw(request(itemUrl(candidateId)),cycle);
  const result=await adapter.validateOffer(target,own,raw,{...cycle,ownIdentity:ownValidation.identity});
  return {adapter,log,target,own,raw,ownValidation,result};
}
let restoreFetch;
test.before(async()=>{
  const bytes=await sharp(Buffer.from('<svg width="96" height="96"><rect width="96" height="96" fill="white"/><path d="M8 6L65 11L84 84L24 74Z" fill="#367bd4"/><circle cx="41" cy="38" r="12" fill="#e6a223"/><rect x="12" y="52" width="62" height="8" fill="#111111"/></svg>')).png().toBuffer();
  const different=await sharp(Buffer.from('<svg width="96" height="96"><rect width="96" height="96" fill="#0b1818"/><circle cx="64" cy="62" r="28" fill="#e41280"/><path d="M0 80L86 10L22 18Z" fill="#30df40"/></svg>')).png().toBuffer();
  restoreFetch=globalThis.fetch;globalThis.fetch=async url=>{
    assert.match(String(url),/^https:\/\/img\.fril\.jp\/img\/\d+\/l\/product\.png$/,'unexpected network request');
    return new Response(String(url).includes('/img/3/')?different:bytes,{headers:{'content-type':'image/png','cache-control':'public,max-age=3600'}});
  };configureImageFingerprintCache({now:()=>at});
});
test.after(()=>{globalThis.fetch=restoreFetch;configureImageFingerprintCache()});

test('extracted helpers preserve genuine accepted legacy fixture using actual local image pipeline',async()=>{
  const {adapter,ownValidation,result,own,target}=await verifyFixture();
  assert.equal(ownValidation.complete,true);assert.equal(ownValidation.identity.quantityBasis,'whole_listing_sale_unit');
  assert.ok(Object.values(result.gates).every(value=>value==='pass'));assert.equal(result.quote.price,7800);
  assert.equal(result.quote.currency,'JPY');assert.equal(result.quote.shipping,0);assert.equal(result.quote.primaryImageScore,1);
  for(const field of ['id','title','detailTitle','image','matchMethod'])assert.ok(result.quote[field]);
  assert.ok(Number.isFinite(result.quote.titleScore));
  const legacy=await rakumaCompare(ownItem(),{ownedOffers:fixtureOwnedOffers()},
    {imageFingerprints,fetchPage:async url=>({html:url.startsWith('https://fril.jp/s?')?searchHtml():detailHtml(),observedAt:new Date(at).toISOString()})});
  assert.equal(legacy.competitorCount,1);assert.equal(legacy.candidates[0].price,result.quote.price);
  assert.equal(legacy.candidates[0].matchMethod,result.quote.matchMethod);
  assert.notEqual((await adapter.validateOwn({...target,accountId:'another'},own,cycle)).identity.skuId,ownValidation.identity.skuId);
});
for(const [name,change,reason] of [
  ['colour',{description:'新品 未使用 ブラウン 370ml 1本'},'description_color_mismatch'],
  ['quantity',{description:'新品 未使用 ブルー 370ml 3本セット'},'sale_unit_mismatch'],
  ['condition',{description:'中古 使用感あり ブルー 370ml 1本'},'condition_or_packaging_mismatch'],
  ['defect',{description:'傷あり ブルー 370ml 1本'},'defect'],['sold',{availability:'OutOfStock'},'not_open'],
  ['own seller',{sellerId:'100'},'own_seller'],['description',{description:''},'sale_description_unavailable'],
  ['shipping',{shipping:'着払い'},'shipping_unconfirmed']
])test(`adapter and legacy reject same ${name} fixture`,async()=>{
  const html=detailHtml(change),{result}=await verifyFixture({html});assert.equal(result.reason,reason);
  const legacy=await rakumaCompare(ownItem(),{ownedOffers:fixtureOwnedOffers()},
    {imageFingerprints,fetchPage:async url=>({html:url.startsWith('https://fril.jp/s?')?searchHtml():html,observedAt:new Date(at).toISOString()})});
  assert.equal(legacy.competitorCount,0);assert.ok(legacy.rejected.some(row=>row.reason===reason));
});
for(const [name,change,gate] of [
  ['missing currency',{currency:''},'price'],['foreign currency',{currency:'USD'},'price'],
  ['unknown availability',{availability:''},'availability'],['missing seller',{sellerId:''},'ownership'],
  ['missing shipping method',{method:''},'shipping'],['undetermined shipping method',{method:'未定'},'shipping']
])test(`payable envelope fails closed for ${name}`,async()=>assert.equal((await verifyFixture({html:detailHtml(change)})).result.gates[gate],'unknown'));

test('missing current own description cannot fall back to cached target evidence',async()=>{
  const {adapter}=fixtureAdapter({own:detailHtml({id:ownId,description:'',sellerId:'100'})});
  const target={...targetFixture(),description:fixtureDescription,sourceDetail:{description:fixtureDescription,images:[imageUrl(1)]},yahoo:{ownDescription:fixtureDescription}};
  const raw=await adapter.fetchRaw(request(target.own.url),cycle);assert.equal((await adapter.validateOwn(target,raw,cycle)).complete,false);
});
test('own current title and seller must still agree with inventory and this adapter handles pricing only',async()=>{
  const {adapter,own,target,raw}=await verifyFixture();
  assert.equal((await adapter.validateOwn({...target,title:'different'},own,cycle)).complete,false);
  assert.equal((await adapter.validateOwn({...target,sellerId:'999'},own,cycle)).complete,false);
  const unsupported=await adapter.validateOffer(target,own,raw,{...cycle,purpose:'procurement'});
  assert.equal(unsupported.gates.identity,'unknown');assert.equal(unsupported.quote,undefined);
});
test('correction exclusions remain account-specific and tombstones permit fresh verification',async()=>{
  const correction={accountId:'fixture-account',itemId:ownId,platform:'rakuma',candidateId,updatedAt:new Date(at).toISOString(),deleted:false};
  const {adapter,own,target}=await verifyFixture({settings:{matchCorrections:{one:correction}}});
  const card={id:candidateId,url:itemUrl(candidateId),title:fixtureTitle,price:7800,sellerId:'200',itemStatus:'OPEN'};
  const screen=adapter.screenCandidate(target,own,{url:card.url,card},cycle);
  assert.equal(screen.decision,'reject');assert.equal(screen.gates.correction,'reject');assert.equal(screen.quote,undefined);
  assert.equal(adapter.screenCandidate(target,own,{url:card.url},cycle).decision,'detail');
  assert.equal(adapter.screenCandidate(target,own,{url:card.url,card},{...cycle,origin:'known'}).decision,'detail');
  assert.ok(Object.values((await verifyFixture({settings:{matchCorrections:{one:{...correction,deleted:true}}}})).result.gates).every(value=>value==='pass'));
});
test('query page proof is adapter-owned and malformed/partial pagination fails closed',async()=>{
  const spec=rakumaGraphSearchSpec(fixtureTitle),next=new URL(spec.query.url);next.searchParams.set('page','2');
  const {adapter}=fixtureAdapter({search:searchHtml({nextUrl:next.href})}),req=request(spec.query.url,'search'),raw=await adapter.fetchRaw(req,cycle);
  assert.equal(raw.data.complete,false);assert.equal(raw.data.nextQuery.url,next.href);
  assert.equal(adapter.assessDiscoveryCoverage(req,raw,{originalQuery:spec.query}).accepted,true);
  const tampered=structuredClone(raw);tampered.data.complete=true;
  assert.equal(adapter.assessDiscoveryCoverage(req,tampered,{originalQuery:spec.query}).accepted,false);
  await assert.rejects(fixtureAdapter({search:searchHtml().replace('data-rat-price="7800"','data-rat-price=""')}).adapter.fetchRaw(req,cycle),/manifest_unreadable/);
  await assert.rejects(fixtureAdapter({search:searchHtml()+'<a rel="next" href="/wrong">次へ</a>'}).adapter.fetchRaw(req,cycle),/pagination_unproven/);
});
test('cached, missing and future timestamps are not current observations',async()=>{
  for(const pageExtra of [{fromCache:true},{observedAt:null},{observedAt:at+1}]){
    const {adapter,log}=fixtureAdapter({pageExtra});await assert.rejects(adapter.fetchRaw(request(itemUrl(candidateId)),cycle),/current_page_unproven/);assert.equal(log.length,1);
  }
});
test('matching secondary image cannot rescue a contradictory primary collectible image',async()=>{
  const title='海外限定Hello Kitty x TBH ネックピロー',description='新品 未使用 ブルー 1個';
  const {adapter}=fixtureAdapter({own:detailHtml({id:ownId,title,description,sellerId:'100',image:imageUrl(1)}),html:detailHtml({title,description,image:[imageUrl(3),imageUrl(1)]})});
  const target=targetFixture({title}),own=await adapter.fetchRaw(request(target.own.url),cycle);await adapter.validateOwn(target,own,cycle);
  const result=await adapter.validateOffer(target,own,await adapter.fetchRaw(request(itemUrl(candidateId)),cycle),cycle);
  assert.equal(result.reason,'primary_variant_unconfirmed');assert.equal(result.gates.identity,'unknown');
});
test('complete ownership gate requires the system owned inventory index',async()=>assert.equal((await verifyFixture({settings:{ownedOffers:null}})).result.gates.ownership,'unknown'));
test('cross-platform validation uses current flat own data plus graph-scoped identity',async()=>{
  const {adapter}=fixtureAdapter(),target={...targetFixture(),platform:'yahoo',id:'yahoo-own',own:{accessScope:'public',url:'https://paypayfleamarket.yahoo.co.jp/item/yahoo-own'}};
  const own={cycleId:cycle.cycleId,observedAt:at,fromCache:false,data:{...extractRakumaDetail(ownHtml(),itemUrl(ownId)),id:'yahoo-own',url:target.own.url}};
  const raw=await adapter.fetchRaw(request(itemUrl(candidateId)),cycle),context={...cycle,ownIdentity:{skuId:'graph-target-offer',quantity:1}};
  assert.ok(Object.values((await adapter.validateOffer(target,own,raw,context)).gates).every(value=>value==='pass'));
  assert.equal((await adapter.validateOffer(target,{...own,fromCache:true},raw,context)).gates.identity,'unknown');
});
test('weak abbreviated titles need detail; proven quantity conflicts may skip it',async()=>{
  const {adapter,own,target,raw}=await verifyFixture();
  const card={id:candidateId,url:itemUrl(candidateId),title:'ブルー 370ml',price:7800,sellerId:'200',itemStatus:'OPEN'};
  assert.equal(screenRakumaCard(ownItem(),card,{ownedOffers:fixtureOwnedOffers()}).rejection.reason,'weak_anchors');
  assert.equal(adapter.screenCandidate(target,own,{url:card.url,card},cycle).decision,'detail');
  assert.ok(Object.values((await adapter.validateOffer(target,own,raw,{...cycle,candidate:{url:card.url,card}})).gates).every(gate=>gate==='pass'));
  assert.equal(adapter.screenCandidate(target,own,{url:card.url,card:{...card,itemStatus:'UNKNOWN'}},cycle).decision,'detail');
  assert.equal(adapter.screenCandidate(target,own,{url:card.url,card:{...card,title:'ブルー 370ml 3本セット'}},cycle).gates.quantity,'reject');
});
for(const [name,pageExtra] of [
  ['missing status',{httpStatus:undefined}],['server error',{httpStatus:500}],['redirect',{httpStatus:302}],
  ['partial body',{httpStatus:206}],['cached 304',{httpStatus:304}],['conflicting aliases',{httpStatus:200,status:500}],
  ['unrecognized status',{httpStatus:'success'}],['declared redirect',{httpStatus:200,redirected:true}]
])test(`valid HTML does not bypass ${name} transport failure`,async()=>{
  const {adapter,log}=fixtureAdapter({pageExtra});await assert.rejects(adapter.fetchRaw(request(itemUrl(candidateId)),cycle),/rakuma_response_status_unproven|rakuma_redirected_response/);assert.equal(log.length,1);
});
for(const alias of ['httpStatus','status'])for(const denied of [401,403,429])test(`returned/thrown ${alias} ${denied} closes source and retains retry metadata`,async()=>{
  for(const throws of [false,true]){
    const metadata={[alias]:denied,retryAfter:'120',retryAt:at+120000,reason:'rate_limit'};
    const {adapter,log}=fixtureAdapter({reader:async()=>{if(throws)throw Object.assign(new Error('fixture denial'),metadata);
      return {html:detailHtml(),observedAt:at,fromCache:false,httpStatus:200,...metadata};}});
    await assert.rejects(adapter.fetchRaw(request(itemUrl(candidateId)),cycle),error=>error.code==='ACCESS_DENIED'&&error[alias]===denied&&error.retryAt===at+120000&&error.reason==='rate_limit');assert.equal(log.length,1);
  }
});
test('explicit success status and exact final URL aliases work; changed final URLs do not',async()=>{
  for(const pageExtra of [{httpStatus:200},{httpStatus:undefined,status:200},{httpStatus:200,status:200},{url:itemUrl(candidateId),finalURL:itemUrl(candidateId),redirectedURL:itemUrl(candidateId)}])
    assert.equal((await fixtureAdapter({pageExtra}).adapter.fetchRaw(request(itemUrl(candidateId)),cycle)).data.price,7800);
  for(const alias of ['url','finalUrl','finalURL','responseUrl','responseURL','redirectedUrl','redirectedURL'])
    await assert.rejects(fixtureAdapter({pageExtra:{[alias]:itemUrl(otherId)}}).adapter.fetchRaw(request(itemUrl(candidateId)),cycle),/response_url_mismatch/);
});
test('challenge markers stop even with successful transport and otherwise valid details',async()=>{
  await assert.rejects(fixtureAdapter({html:detailHtml()+'<div>captcha</div>'}).adapter.fetchRaw(request(itemUrl(candidateId)),cycle),error=>error.code==='ACCESS_DENIED');
});
test('coverage starts at page one and requires contiguous pages',async()=>{
  const spec=rakumaGraphSearchSpec(fixtureTitle),page2=new URL(spec.query.url),page3=new URL(spec.query.url);
  page2.searchParams.set('page','2');page3.searchParams.set('page','3');
  await assert.rejects(fixtureAdapter({search:searchHtml({nextUrl:page3.href})}).adapter.fetchRaw(request(spec.query.url,'search'),cycle),/pagination_gap/);
  const {adapter}=fixtureAdapter({search:searchHtml({cards:[]})}),req=request(page2.href,'search'),raw=await adapter.fetchRaw(req,cycle);
  assert.equal(adapter.assessDiscoveryCoverage(req,raw,{originalQuery:req.query}).accepted,false);
  assert.equal(adapter.assessDiscoveryCoverage(req,raw).accepted,false);
});
test('each target validation uses its current image signal instead of a prior node closure',async()=>{
  const signals=[],first=new AbortController(),second=new AbortController();
  const {adapter,target,own,raw}=await verifyFixture({fingerprint:async(url,options)=>{signals.push(options?.signal);return imageFingerprints(url,options)}});
  signals.length=0;await adapter.validateOffer(target,own,raw,{...cycle,signal:first.signal});first.abort();
  const result=await adapter.validateOffer(target,own,raw,{...cycle,signal:second.signal});
  assert.ok(Object.values(result.gates).every(value=>value==='pass'));
  assert.ok(signals.includes(first.signal));assert.ok(signals.includes(second.signal));
});

test('collector local deferral is not reclassified as a new denial',async()=>{
 const error=Object.assign(new Error('held'),{code:'request_deferred',httpStatus:429,reason:'request_cooldown_deadline',retryAt:at+3600000});
 const {adapter,log}=fixtureAdapter({reader:()=>{throw error;}});
 await assert.rejects(adapter.fetchRaw(request(itemUrl(candidateId)),cycle),actual=>actual===error);assert.equal(log.length,1);
});
