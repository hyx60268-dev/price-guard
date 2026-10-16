import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {rakumaCompare,extractRakumaDetail,fetchRakumaItem} from '../scripts/lib/rakuma.mjs';
import {createOwnSourceLoader} from '../scripts/lib/own-source.mjs';
import {createRakumaHintSession,definitiveRakumaRejection,mergeRakumaDiscovery,refreshRakumaDiscovery,withRakumaDiscovery} from '../scripts/lib/rakuma-discovery-hints.mjs';
import {reconcileDurableState} from '../scripts/lib/state.mjs';
import {compactDashboardResult,scopeResultForPortalUser,writeOutputs} from '../scripts/lib/publish.mjs';
import {decrypt} from '../scripts/lib/crypto.mjs';
import {RequestDeferredError} from '../scripts/lib/request-cooldown.mjs';
import {pricingDecision,PRICING_RULES_VERSION} from '../public/pricing-policy.js';

const start=Date.now()-12*3600000,step=21*60000;
const title='中国限定 スターバックス レオパード グリッター ブルー 370ml',description='新品 未使用 ブルー 370ml 1本';
const ownId='a'.repeat(32),id='b'.repeat(32),url=id=>`https://item.fril.jp/${id}`;
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const image='https://img.fril.jp/img/1/l/1.jpg';
const html=({title:name=title,description:body=description,price=7800,status='InStock',seller='200',currency='JPY',images=[image],shipping='送料込'}={})=>
 `<script type="application/ld+json">${JSON.stringify({'@type':'Product',name,description:body,image:images,offers:{price,priceCurrency:currency,availability:`https://schema.org/${status}`}})}</script><script>window.data={"seller_user_id":"${seller}"}</script><table><tr><th>配送料の負担</th><td>${shipping}</td></tr></table>`;
const card=(value=id,price=7800)=>`<a href="${url(value)}" class="link_search_image" data-rat-itemid="200/123" data-rat-item_name="${title}" data-rat-price="${price}"><img data-original="${image}"></a>`;
const page=(target,body,at)=>({html:body,status:200,url:target,finalUrl:target,redirected:false,fromCache:false,observedAt:at});
const target=()=>({id:ownId,accountId:'shop',platform:'rakuma',comparisonMode:'same_platform',title,ownPrice:9000,sellerId:'100',image,url:url(ownId),
 sourceDetail:{...extractRakumaDetail(html({seller:'100',price:9000}),url(ownId)),listingId:ownId,sourceTargetVerified:true,
  sourceObservedAt:new Date(start-3600000).toISOString(),checkedAt:new Date(start-3600000).toISOString()}});
const settings={maxRakumaDetailChecks:6,rakumaFreshHours:1/3,ownedOffers:{rakuma:{items:new Set([ownId]),sellers:new Set(['100'])}}};
async function run(item,{at=start,search=card(),detail=html(),throwSearch,throwDetail,transport={},settings:overrides={},priorItem}={}){
 const reads=[],stats=[];let result,error;
 try{result=await rakumaCompare(item,{...settings,...overrides},{now:()=>at,priorItem,imageFingerprints:async()=>fp,
  onDiscovery:store=>{item.competitorDiscovery={rakuma:store}},onHintStats:value=>stats.push(value),
  fetchPage:async requested=>{reads.push(requested);if(requested.startsWith('https://fril.jp/s?')){if(throwSearch)throw throwSearch;return page(requested,typeof search==='function'?search(requested):search,at);}
   if(throwDetail)throw throwDetail;return {...page(requested,typeof detail==='function'?detail(requested):detail,at),...transport};}});
  item.rakuma=result;
 }catch(value){error=value;}
 return {result,error,reads,stats:stats.at(-1)};
}
async function seeded(count=1){const item=target();await run(item,{search:Array.from({length:count},(_,i)=>card(String.fromCharCode(98+i).repeat(32),7800+i)).join('')});return item;}

test('accepted current detail bootstraps URL-only hints and empty discovery reuses current detail, never old quote',async()=>{
 const item=await seeded(),old=item.competitorDiscovery.rakuma.links[0];
 assert.equal(old.lastVerifiedAt,new Date(start).toISOString());assert.equal(old.identityObservedAt,item.sourceDetail.sourceObservedAt);
 for(const forbidden of ['price','title','image','sellerId','matchMethod','checkedAt','status'])assert.equal(old[forbidden],undefined);
 const {result,reads}=await run(item,{at:start+step,search:'商品が見つかりません',detail:html({price:8500})});
 assert.equal(reads.length,2);assert.equal(reads[1],url(id));assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].price,8500);
 assert.equal(result.candidates[0].checkedAt,new Date(start+step).toISOString());
 assert.equal(item.competitorDiscovery.rakuma.links[0].identityObservedAt,old.identityObservedAt);
 assert.deepEqual(result.hintStats,{eligible:1,admitted:1,reverified:1,retired:0,retainedUnknown:0,invalidatedBinding:0,hintDetailReads:1,searchDetailReads:0,pendingDue:0,bootstrapped:0,pendingLinks:1,retiredLinks:0});
});

for(const mode of ['empty_not_due','partial','timeout','deadline','search_timeout','source_denied'])test(`uncertain outcome keeps discovery URL without granting fresh old acceptance: ${mode}`,async()=>{
 const item=await seeded(),before=structuredClone(item.competitorDiscovery),at=start+(mode==='empty_not_due'?1000:step);
 const opts={at,search:'商品が見つかりません'};
 if(mode==='partial')Object.assign(opts,{settings:{maxRakumaSearchPages:1},search:u=>`商品が見つかりません<a href="${u}&page=2">次へ</a>`,throwDetail:new Error('temporary detail failure')});
 if(mode==='timeout')opts.throwDetail=new Error('temporary timeout');
 if(mode==='deadline')opts.throwDetail=new RequestDeferredError('request_deadline');
 if(mode==='search_timeout')opts.throwSearch=new Error('temporary search failure');
 if(mode==='source_denied')opts.throwDetail=Object.assign(new Error('denied'),{code:'RAKUMA_SOURCE_ACCESS_DENIED'});
 const {result,error}=await run(item,opts),row=item.competitorDiscovery.rakuma.links[0];
 assert.equal(row.url,url(id));assert.equal(row.retiredAt,undefined);assert.equal(row.lastVerifiedAt,before.rakuma.links[0].lastVerifiedAt);
 if(result){assert.equal(result.candidates.length,0);assert.equal(pricingDecision(item,{now:at}).lowest,null);if(mode!=='empty_not_due'){assert.equal(result.status,'incomplete');assert.equal(pricingDecision(item,{now:at}).canRecommend,false);}}
 else assert.ok(error);
});

for(const [change,reason] of [[{status:'OutOfStock'},'not_open'],[{seller:'100'},'own_seller'],[{description:'新品 未使用 カラー：ブラウン 370ml 1本'},'description_color_mismatch'],[{description:'新品 未使用 ブルー 370ml 1本 傷あり'},'defect']])
test(`current authoritative detail retires a URL: ${reason}`,async()=>{
 const item=await seeded(),old=structuredClone(item.competitorDiscovery.rakuma);
 const {result}=await run(item,{at:start+step,search:'商品が見つかりません',detail:html(change)});
 assert.equal(result.candidates.length,0);assert.equal(item.competitorDiscovery.rakuma.links[0].reason,reason);
 const merged=mergeRakumaDiscovery(item,old,item.competitorDiscovery.rakuma,old);assert.ok(merged.links[0].retiredAt);
 const next=await run(item,{at:start+2*step,search:'商品が見つかりません'});assert.equal(next.reads.length,1);
});

for(const change of [{seller:''},{status:''},{currency:''},{images:[]},{description:''},{shipping:'着払い'},
 {description:'ブルー 370ml 1本'}, {description:'新品 未使用 ブルー 370ml 1本のみ。2本セット。'},
 {description:`${description} 引き取り限定。発送不可。`},{description:`${description} 東京都内のみ送料無料です。`},
 {description:`${description} 沖縄は送料追加です。`}])test(`missing or conditional current evidence keeps hint pending: ${JSON.stringify(change)}`,async()=>{
 const item=await seeded(),{result}=await run(item,{at:start+step,search:'商品が見つかりません',detail:html(change)});
 assert.equal(result.candidates.length,0);assert.equal(result.status,'incomplete');assert.equal(item.competitorDiscovery.rakuma.links[0].retiredAt,undefined);
 assert.equal(result.hintStats.retainedUnknown,1);
});

test('a geographic merchandise title and optional carrier do not invalidate proven current fee',async()=>{
 const item=await seeded(),{result}=await run(item,{at:start+step,search:'商品が見つかりません',detail:html({description:`${description} 東京限定マグカップ 送料無料`})});
 assert.equal(result.candidates.length,1);
});

for(const transport of [{status:302},{status:206},{status:undefined},{redirected:true},{redirected:undefined},{fromCache:true},
 {finalUrl:url('c'.repeat(32))},{url:url('c'.repeat(32))},{url:undefined,finalUrl:undefined}])
test(`known URL requires original successful exact-target transport: ${JSON.stringify(transport)}`,async()=>{
 const item=await seeded(),{result}=await run(item,{at:start+step,search:'商品が見つかりません',transport});
 assert.equal(result.candidates.length,0);assert.equal(result.status,'incomplete');assert.equal(item.competitorDiscovery.rakuma.links[0].retiredAt,undefined);
});

test('one hint shares six detail slots, deduplicates live recall, rotates remaining hints and blocks false complete coverage',async()=>{
 const item=await seeded(2),initial=structuredClone(item.competitorDiscovery),newIds=['d','e','f','1','2','3'].map(x=>x.repeat(32));
 const first=await run(item,{at:start+step,search:card(id)+newIds.map(x=>card(x)).join('')});
 assert.equal(first.result.detailCheckedCount,6);assert.equal(first.result.hintStats.hintDetailReads,1);assert.equal(first.result.hintStats.searchDetailReads,5);
 assert.equal(first.reads.filter(x=>x===url(id)).length,1);assert.equal(first.result.hintPendingCount,1);assert.equal(first.result.status,'incomplete');
 // Keep only the two original links to isolate oldest-attempt rotation.
 item.competitorDiscovery.rakuma.links=item.competitorDiscovery.rakuma.links.filter(row=>initial.rakuma.links.some(x=>x.id===row.id));
 const second=await run(item,{at:start+step+1000,search:'商品が見つかりません'});
 assert.equal(second.reads[1],url('c'.repeat(32)));assert.equal(second.result.hintStats.admitted,1);
});

test('an unknown unpriced hint plus another current accepted quote stays incomplete',async()=>{
 const item=await seeded(),other='d'.repeat(32);
 const {result}=await run(item,{at:start+step,search:card(other),detail:requested=>requested===url(id)?html({seller:''}):html()});
 assert.equal(result.candidates.length,1);assert.equal(result.status,'incomplete');assert.equal(result.plausibleMinPrice,7800);
 assert.equal(result.hintStats.retainedUnknown,1);
});

test('rules invalidation keeps URL hints; active corrections retire absent/non-due hints individually',async()=>{
 const item=await seeded(2);item.rakuma.rulesVersion=0;
 const corrected={one:{accountId:'shop',itemId:ownId,platform:'rakuma',candidateId:id,updatedAt:new Date(start+1).toISOString(),deleted:false}};
 const prepared=withRakumaDiscovery(item,{}, {...settings,matchCorrections:corrected},start+1000);
 assert.equal(prepared.competitorDiscovery.rakuma.links.find(x=>x.id===id).reason,'saved_user_correction');
 assert.equal(prepared.competitorDiscovery.rakuma.links.find(x=>x.id!==id).retiredAt,undefined);
 const {result}=await run(prepared,{at:start+step,search:'商品が見つかりません',settings:{matchCorrections:corrected}});
 assert.equal(result.candidates[0].id,'c'.repeat(32));assert.equal(result.rulesVersion,PRICING_RULES_VERSION);
});

test('changed full own identity retires old binding; current discovery creates a new binding; no cross-account or relist inheritance',async()=>{
 for(const mutate of [item=>{item.sourceDetail.description+=' 付属品付き';},item=>{item.image+='?new=1';},item=>{item.sellerId='300';item.sourceDetail.sellerId='300';}]){
  const item=await seeded();mutate(item);
  const first=await run(item,{at:start+step,search:'商品が見つかりません'});assert.equal(first.reads.length,1);
  assert.equal(item.competitorDiscovery.rakuma.links[0].reason,'own_target_changed');
  await run(item,{at:start+2*step});assert.equal(item.competitorDiscovery.rakuma.links.length,2);assert.equal(item.competitorDiscovery.rakuma.links.filter(x=>!x.retiredAt).length,1);
 }
 const item=await seeded();
 for(const change of [{accountId:'another'},{id:'f'.repeat(32),relistedFrom:ownId},{platform:'yahoo'}])assert.equal(refreshRakumaDiscovery({...item,...change},item,settings,start+step),undefined);
});

test('legacy quote without bound full own observation remains unseeded after compact fallback',async()=>{
 const prior=target(),first=await run(prior);assert.equal(first.result.candidates.length,1);
 delete prior.competitorDiscovery;delete prior.sourceDetail.sourceTargetVerified;
 const item=target(),{result,reads}=await run(item,{at:start+step,priorItem:prior,search:'商品が見つかりません'});
 assert.equal(reads.length,1);assert.equal(result.candidates.length,0);assert.equal(item.competitorDiscovery,undefined);
 const compact=compactDashboardResult({items:[prior]}).items[0];
 let stored;createRakumaHintSession(compact,settings,{now:()=>start+step,priorItem:prior,onDiscovery:x=>{stored=x}});
 assert.equal(stored,undefined);
});

test('even a legacy quote beside a newly hydrated own detail cannot manufacture its historical binding',async()=>{
 const prior=await seeded();delete prior.competitorDiscovery;
 const item=target(),{reads}=await run(item,{at:start+step,priorItem:prior,search:'商品が見つかりません'});
 assert.equal(reads.length,1);assert.equal(item.competitorDiscovery,undefined);
});

test('unambiguous current ownership/color exclusion outranks unknown price terms',async()=>{
 for(const change of [{seller:'100',currency:''},{description:'新品 未使用 カラー：ブラウン 370ml 1本 送料追加です。'}]){
  const item=await seeded(),{result}=await run(item,{at:start+step,search:'商品が見つかりません',detail:html(change)});
  assert.equal(result.candidates.length,0);assert.ok(item.competitorDiscovery.rakuma.links[0].retiredAt);
 }
 const item=await seeded(),{result}=await run(item,{at:start+step,search:'商品が見つかりません',detail:html({seller:'100',currency:''}),
  settings:{ownedOffers:{rakuma:{items:new Set([ownId]),sellers:new Set()}}}});
 assert.equal(result.candidates.length,0);assert.equal(item.competitorDiscovery.rakuma.links[0].reason,'own_seller');
});

test('ambiguous scales, release waves, quantities and unstated condition do not become retirement proof',()=>{
 for(const [ownTitle,candidateTitle] of [['フィギュア 1/6','フィギュア 1/6 1/7'],['Emutenkai ポケモン フィギュア 第3弾','Emutenkai ポケモン フィギュア 第3弾 第4弾']]){
  assert.equal(definitiveRakumaRejection({title:ownTitle},{title:candidateTitle},'explicit_variant_mismatch'),false);
 }
 assert.equal(definitiveRakumaRejection(target(),{title,description:'新品 未使用 ブルー 370ml 1本のみ。2本セット。'},'sale_unit_mismatch'),false);
 assert.equal(definitiveRakumaRejection(target(),{title,description:'ブルー 370ml'},'condition_or_packaging_mismatch'),false);
 assert.equal(definitiveRakumaRejection({title:'フィギュア 1/6'},{title:'フィギュア 1/7'},'explicit_variant_mismatch'),true);
});

test('original sixth searched candidate remains unresolved after one-slot hint displacement',async()=>{
 const item=await seeded(),others=['c','d','e','f','1','2'].map(x=>x.repeat(32));
 const {result,reads}=await run(item,{at:start+step,search:others.map(x=>card(x,7000)).join(''),detail:html({price:8000})});
 assert.equal(result.detailCheckedCount,6);assert.equal(result.hintStats.searchDetailReads,5);assert.equal(result.status,'incomplete');
 assert.equal(result.unconfirmedLowerCount,1);assert.equal(reads.includes(url(others[5])),false);
});

test('a second due hint settled through current search detail does not remain falsely pending',async()=>{
 const item=await seeded(2),{result}=await run(item,{at:start+step,search:card('c'.repeat(32))});
 assert.equal(result.hintStats.eligible,2);assert.equal(result.hintStats.admitted,1);assert.equal(result.hintStats.reverified,2);
 assert.equal(result.hintPendingCount,0);assert.equal(result.status,'ok');
});

for(const bad of [{currency:''},{seller:''},{images:[]},{description:`${description} 東京都内のみ送料無料です。`}])
test(`new accepted legacy search evidence without full hint proof cannot bootstrap: ${JSON.stringify(bad)}`,async()=>{
 const item=target();await run(item,{detail:html(bad)});assert.equal(item.competitorDiscovery,undefined);
});

test('a newer cached quote cannot outlive an older-revision exact-bound SOLD tombstone, including compact restoration',async()=>{
 const item=await seeded(2),old=structuredClone(item),originalClock=item.rakuma.checkedAt;
 await run(item,{at:start+step,search:'商品が見つかりません',detail:html({status:'OutOfStock'})});
 const stale={items:[old],dataRevision:new Date(start+2*step).toISOString()},sold={items:[item],dataRevision:new Date(start+step).toISOString()};
 for(const left of [stale,compactDashboardResult(stale)])for(const right of [sold,compactDashboardResult(sold)]){
  const row=reconcileDurableState(left,right).items[0],decision=pricingDecision(row,{now:start+step});
  assert.equal(row.rakuma.candidates.length,1);assert.equal(row.rakuma.candidates[0].id,'c'.repeat(32));
  assert.equal(row.rakuma.checkedAt,originalClock);assert.equal(row.rakuma.status,'incomplete');assert.equal(decision.complete,false);
  assert.equal(decision.lowest.id,'c'.repeat(32));
 }
 const only=structuredClone(stale);only.items[0].rakuma.candidates=only.items[0].rakuma.candidates.filter(x=>x.id===id);
 const row=reconcileDurableState(compactDashboardResult(only),compactDashboardResult(sold)).items[0];
 assert.equal(row.rakuma.candidates.length,0);assert.equal(row.recommendedPrice,row.ownPrice);assert.equal(pricingDecision(row,{now:start+step}).canRecommend,false);
 // Product-specific mismatch does not become a global ban on another bound target.
 const mismatch=structuredClone(sold);mismatch.items[0].competitorDiscovery.rakuma.links.find(x=>x.id===id).reason='description_color_mismatch';
 const newer=structuredClone(old);newer.image+='?new=1';await run(newer,{at:start+2*step});
 const restored=reconcileDurableState({items:[newer],dataRevision:new Date(start+3*step).toISOString()},mismatch).items[0];
 assert.ok(restored.rakuma.candidates.some(x=>x.id===id));
 const soldRestored=reconcileDurableState({items:[newer],dataRevision:new Date(start+3*step).toISOString()},sold).items[0];
 assert.ok(!soldRestored.rakuma.candidates.some(x=>x.id===id),'SOLD remains unavailable after own identity changes');
 for(const legacy of [structuredClone(stale),compactDashboardResult(stale)]){
  delete legacy.items[0].rakuma.audit.discoveryBinding;
  const fenced=reconcileDurableState(legacy,sold).items[0];
  assert.ok(!fenced.rakuma.candidates.some(x=>x.id===id));assert.ok(fenced.rakuma.candidates.some(x=>x.id==='c'.repeat(32)));
  assert.equal(fenced.rakuma.checkedAt,originalClock);assert.equal(fenced.rakuma.status,'incomplete');
 }
});

test('changing own binding cannot bootstrap or admit a previously SOLD URL',async()=>{
 let item=await seeded();
 await run(item,{at:start+step,search:'商品が見つかりません',detail:html({status:'OutOfStock'})});
 item.image+='?changed=1';
 const independent=await run(item,{at:start+2*step,search:card()});
 assert.equal(independent.result.hintStats.bootstrapped,0);assert.equal(item.competitorDiscovery.rakuma.links.length,1);
 assert.equal(item.competitorDiscovery.rakuma.links[0].reason,'not_open');
 item=withRakumaDiscovery(item,{},settings,start+2*step);
 assert.equal(item.rakuma.candidates.length,0);
 const next=await run(item,{at:start+3*step,search:'商品が見つかりません'});
 assert.equal(next.reads.length,1);assert.equal(next.result.hintStats.admitted,0);
});

test('shared loader preserves original transport/observation and six-hour own hydration does not freshen it',async()=>{
 let reads=0;const at=start;
 const loader=createOwnSourceLoader({now:()=>start+1000,fetchRakumaPage:async requested=>{reads++;return page(requested,html({seller:'100',price:9000}),at)},
  fetchRakumaItem:item=>fetchRakumaItem(item,{}, {fetchPage:loader.rakumaPage})});
 const first=await loader.rakumaPage(url(ownId)),second=await loader.rakumaPage(url(ownId));
 assert.equal(reads,1);assert.equal(first.observedAt,at);assert.deepEqual(second,first);assert.equal(first.finalUrl,url(ownId));
 const item=target(),hydrated=await loader.hydrate(item,{});assert.equal(hydrated.sourceDetail.checkedAt,new Date(at).toISOString());
 const cachedLoader=createOwnSourceLoader({now:()=>start+3600000,fetchRakumaItem:()=>assert.fail('unexpected extra own request')});
 const cached=await cachedLoader.hydrate({...item,sourceDetail:undefined},hydrated);
 assert.equal(cached.sourceDetail.checkedAt,new Date(at).toISOString());assert.equal(cached.sourceDetail.sourceTargetVerified,true);
});

test('full and compact encrypted publication/restoration preserve tombstones against obsolete cache and keep account scoping',async()=>{
 const item=await seeded(),old=structuredClone(item);
 await run(item,{at:start+step,search:'商品が見つかりません',detail:html({status:'OutOfStock'})});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rakuma-hints-')),password='synthetic-only-password';
 try{
  const result={version:6,checkedAt:new Date(start+step).toISOString(),dataRevision:new Date(start+step).toISOString(),settings:{},accounts:[{id:'shop',platform:'rakuma'}],items:[item],manualCosts:{}};
  await writeOutputs({root,result,previous:{items:[old]},password});
  for(const filename of ['public/data/state.json.enc','public/data/latest.json.enc']){
   const published=JSON.parse(decrypt(await fs.readFile(path.join(root,filename)),password).toString('utf8'));
   const cache={...result,dataRevision:new Date(start+2*step).toISOString(),items:[old]};
   for(const pair of [[cache,published],[published,cache]]){
    const restored=reconcileDurableState(...pair);assert.ok(restored.items[0].competitorDiscovery.rakuma.links[0].retiredAt);
    assert.equal(restored.items[0].competitorDiscovery.rakuma.links[0].reason,'not_open');
   }
   assert.equal(scopeResultForPortalUser(published,{username:'other',accountIds:['unrelated']}).items.length,0);
  }
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
