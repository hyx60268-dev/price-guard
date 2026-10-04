import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooTargetShipping,knownYahooCandidates,knownYahooRefreshTasks,keepKnownYahooRefresh,runKnownYahooRefresh,yahooFullAttemptTime} from '../scripts/lib/yahoo-known-refresh.mjs';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {buildOwnedOffers} from '../public/owned-offers.js';
import {ownTitle,title,ownDescription,description} from './fixtures/yahoo-known-pikachu.mjs';

const old='2026-10-01T08:00:00.000Z',now=Date.parse('2026-10-04T16:00:00.000Z');
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const card={id:'z696507894',sellerId:'p59959877',title,image:'candidate-primary',price:41999,url:'https://paypayfleamarket.yahoo.co.jp/item/z696507894',matchMethod:'same_sealed_single_box_primary'};
function item(accountId='owner',id='z685606778'){
 return {id,accountId,sellerId:'p76217154',platform:'yahoo',title:ownTitle,image:'own-primary',ownPrice:44499,
  yahoo:{status:'ok',checkedAt:old,lastAttemptAt:old,searchCheckedAt:old,rulesVersion:MATCHING_RULES_VERSION,
   audit:{ownItemId:id,accountId},candidates:[{...card}]}};
}
function context(accountId,ids){const items=ids.map(id=>item(accountId,id));return {account:{id:accountId},activeItems:items,previousById:new Map(items.map(value=>[value.id,structuredClone(value)]))}}
const priceArea=(price,label='送料無料')=>'<div><span class="x ItemPrice__Component"><span>'+price.toLocaleString('en-US')+'</span><span>円</span></span><span class="x ItemDetail__ShippingFreeLabel">'+label+'</span></div>';
const shipping=(price,heading=title)=>yahooTargetShipping('<main><h1>'+heading+'</h1>'+priceArea(price)+'<h2>商品の説明</h2></main>',{title:heading,price});

test('target ordinary price and adjacent explicit free shipping are required',()=>{
 assert.equal(shipping(41999).shippingKnown,true);
 const detail={title,price:41999},head='<main><h1>'+title+'</h1>';
 for(const body of [
  priceArea(40999),
  '<p>41,999円 送料無料</p>',
  '<div hidden>'+priceArea(41999)+'</div>',
  '<div style="display:none">'+priceArea(41999)+'</div>',
  '<div aria-hidden="true">'+priceArea(41999)+'</div>',
  priceArea(41999,'全品送料無料'),
  '<div><span class="ItemPrice__Component">41,999円</span></div><div><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div>',
  '<p>41,999円</p><h2>この商品に似た商品</h2><p>送料無料</p>',
  '<p>41,999円</p></main><footer>送料無料</footer>',
  '<p>41,999円 全品 送料無料</p>',
  '<p>41,999円 送料別 送料無料</p>',
  '<script>41,999円 送料無料</script>',
  '<p hidden>41,999円 送料無料</p>',
  '<div aria-hidden="true"><p>41,999円 送料無料</p></div>',
  '<div style="display:none"><p>41,999円 送料無料</p></div>',
  '<div style="opacity:0"><p>41,999円 送料無料</p></div>',
  '<p>41,999円</p><h1>別の商品</h1><p>41,999円 送料無料</p>'
 ])assert.equal(yahooTargetShipping(head+body,detail).shippingKnown,false,body);
 assert.equal(yahooTargetShipping('<h1>別の商品</h1><p>41,999円 送料無料</p>',detail).shippingKnown,false);
});

test('prior evidence must bind the current account, listing, rule and external seller',()=>{
 const value=item();assert.equal(knownYahooCandidates(value).length,1);
 for(const change of [{accountId:'other'},{id:'relisted'},{platform:'mercari'}])assert.equal(knownYahooCandidates({...value,...change}).length,0);
 for(const priorChange of [{rulesVersion:0},{audit:null},{audit:{accountId:'other',ownItemId:value.id}},{status:'error'},{checkedAt:null}])assert.equal(knownYahooCandidates({...value,yahoo:{...value.yahoo,...priorChange}}).length,0);
 const ownedOffers=buildOwnedOffers([{id:'second',platform:'yahoo_fleamarket',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p59959877'}]);
 assert.equal(knownYahooCandidates(value,{ownedOffers}).length,0);
 assert.equal(knownYahooCandidates(value,{matchCorrections:{x:{accountId:value.accountId,itemId:value.id,platform:'yahoo',candidateId:card.id}}}).length,0);
 assert.equal(knownYahooCandidates({...value,yahoo:{...value.yahoo,candidates:[{...card,sellerId:'p76217154'}]}}).length,0);
});

test('oldest known attempts rotate across accounts independently from full-search attempts',()=>{
 const a=context('a',['a1','a2']),b=context('b',['b1','b2']);
 assert.deepEqual(knownYahooRefreshTasks([a,b],{},now).map(task=>task.item.id),['a1','b1','a2','b2']);
 a.previousById.get('a1').yahoo.knownLastAttemptAt=new Date(now-60_000).toISOString();
 assert.deepEqual(knownYahooRefreshTasks([a,b],{},now).map(task=>task.item.id),['b1','a2','b2']);
 a.previousById.get('a2').yahoo.knownLastAttemptAt=new Date(now-60_000).toISOString();
 assert.deepEqual(knownYahooRefreshTasks([a,b],{},now).map(task=>task.item.id),['b1','b2']);
 assert.equal(yahooFullAttemptTime({...item().yahoo,checkedAt:new Date(now).toISOString(),lastFullAttemptAt:old}),Date.parse(old));
});

test('only fresh accepted candidates receive new quote time and partial coverage cannot raise',()=>{
 const prior=item().yahoo,newStamp=new Date(now).toISOString();
 const result={...prior,candidates:[{...card,price:41999}],checkedAt:newStamp,knownRefresh:{mode:'details_only'},searchCheckedAt:old};
 const saved=keepKnownYahooRefresh({...prior,candidates:[card,{...card,id:'old-low',price:100}]},result,newStamp);
 assert.deepEqual(saved.candidates.map(row=>row.id),[card.id]);assert.equal(saved.checkedAt,newStamp);
 assert.equal(saved.searchCheckedAt,old);assert.equal(saved.lastFullAttemptAt,old);assert.equal(saved.lastAttemptAt,old);
 assert.equal(saved.status,'incomplete');assert.equal(saved.searchComplete,false);
 const lower=pricingDecision({...item(),yahoo:saved},{now});
 assert.equal(lower.recommendedPrice,41998);assert.equal(lower.canRecommend,true);assert.equal(lower.complete,false);
 const raise=pricingDecision({...item(),yahoo:{...saved,candidates:[{...card,price:50000}]}},{now});
 assert.equal(raise.recommendedPrice,44499);assert.equal(raise.canRecommend,false);
});

test('failed detail preserves old quote and search dates but invalidates its action',()=>{
 const prior=item().yahoo;
 for(const failure of [null,{candidates:[],knownRefresh:{mode:'details_only'}}]){
  const value=keepKnownYahooRefresh(prior,failure,new Date(now).toISOString());
  assert.equal(value.checkedAt,old);assert.equal(value.searchCheckedAt,old);
  assert.equal(value.lastFullAttemptAt,old);assert.equal(value.knownLastAttemptAt,new Date(now).toISOString());
  assert.equal(value.cacheReason,'request_error');
  assert.equal(pricingDecision({...item(),yahoo:{...value,checkedAt:new Date(now-60_000).toISOString()}},{now}).canRecommend,false);
 }
});

test('admission stops at its own deadline with bounded concurrency and no fixed batch limit',async()=>{
 const contexts=[context('a',Array.from({length:20},(_,index)=>'a'+index))],tasks=knownYahooRefreshTasks(contexts,{},now);
 let stamp=now,active=0,peak=0,reads=0;
 const completed=await runKnownYahooRefresh(tasks,{deadline:now+20,now:()=>stamp,lookup:async()=>{reads++;active++;peak=Math.max(peak,active);await Promise.resolve();active--;stamp+=3;return null}});
 assert.ok(peak<=2);assert.ok(reads<20);assert.equal(completed.size,reads);
 const all=await runKnownYahooRefresh(tasks,{deadline:now+1000,now:()=>now,lookup:async()=>null});
 assert.equal(all.size,20);
});

async function replay({candidate={},own={},prior={},settings={},candidateShipping,ownShipping}={}){
 const value=item();value.yahoo={...value.yahoo,...prior};
 const requests=[],ownDetail={id:value.id,seller:{id:value.sellerId},title:ownTitle,description:ownDescription,status:'OPEN',price:44499,images:['own-primary'],...own};
 const candidateDetail={id:card.id,seller:{id:card.sellerId},title,description,status:'OPEN',price:41999,couponPrice:40999,images:['candidate-primary'],...candidate};
 const result=await yahooCompare(null,value,{yahooKnownOnly:true,yahooKnownCandidateIds:[card.id],...settings},{
  fetchYahooItemBundle:async id=>{requests.push(id);return id===value.id?{detail:ownDetail,shipping:ownShipping??shipping(44499,ownTitle),recommendations:[]}:{detail:candidateDetail,shipping:candidateShipping??shipping(41999),recommendations:[]}},
  fetchYahooResult:async()=>{throw new Error('Known lane must not request broad search')},
  imageFingerprints:async()=>fp});
 return {value,result,requests};
}

test('reported historical Pikachu fixture rechecks details first and keeps ordinary 41999 price',async()=>{
 const {value,result,requests}=await replay();
 assert.deepEqual(requests,[value.id,card.id]);assert.equal(result.competitorCount,1);
 assert.equal(result.candidates[0].price,41999);assert.equal(result.candidates[0].shippingJPY,0);
 assert.equal(result.candidates[0].priceSource,'current_target_detail');assert.equal(result.status,'incomplete');
 assert.equal(result.searchCheckedAt,old);assert.equal(result.searchComplete,false);
 assert.equal(pricingDecision({...value,yahoo:result}).recommendedPrice,41998);
 const missingSearch=await replay({prior:{searchCheckedAt:null}});
 assert.equal(missingSearch.result.searchCheckedAt,null);
 // Fingerprints are controlled test inputs; this does not replace a live cloud check.
});

test('current seller, status, own identity, shipping and physical sale unit still gate fast results',async()=>{
 for(const options of [
  {candidate:{seller:{id:'p76217154'}}},
  {candidate:{seller:{id:'changed'}}},
  {candidate:{id:'different-id'}},
  {candidate:{status:'SOLD'}},
  {candidate:{description:''}},
  {candidate:{images:[]}},
  {candidate:{price:null}},
  {candidateShipping:{shippingKnown:false}},
  {ownShipping:{shippingKnown:false}},
  {own:{seller:{id:'changed'}}},
  {own:{status:'SOLD'}},
  {own:{title:ownTitle+' 第3弾'}},
  {candidate:{description:description+'\n箱なし、フィギュア12体セットです。'}},
  {settings:{ownedOffers:buildOwnedOffers([{id:'other',platform:'yahoo',sellerId:card.sellerId}])}}
 ]){
  const {result}=await replay(options);assert.equal(result.candidates.length,0,JSON.stringify(options));
 }
});
