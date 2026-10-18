import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {pipeline,T} from './fixtures/shared-detail-pipeline.mjs';
import {writeOutputs,compactDashboardResult} from '../scripts/lib/publish.mjs';
import {decrypt} from '../scripts/lib/crypto.mjs';
import {pricingDecision} from '../public/pricing-policy.js';
import {pricingCoverage} from '../scripts/lib/pricing-coverage.mjs';
import {cycleCoverage} from '../scripts/lib/cycle-coverage.mjs';
import {currentSharedYahooOffers} from '../public/shared-yahoo-offers.js';
import {invalidateCorrectedMatches} from '../public/match-memory.js';

const NOW=T+13000,password='local-only-display-test';
async function ui(data){
 const [html,source]=await Promise.all(['index.html','app.js'].map(name=>fs.readFile(new URL('../public/'+name,import.meta.url),'utf8')));
 const dom=new JSDOM(html,{url:'https://example.invalid',runScripts:'outside-only'}),win=dom.window;
 for(const match of source.matchAll(/^import .* from '(\.\/[^']+)';/gm))Object.assign(win,await import(new URL('../public/'+match[1].slice(2),import.meta.url)));
 win.Date.now=()=>NOW;win.HTMLDialogElement.prototype.showModal=function(){this.open=true};win.HTMLDialogElement.prototype.close=function(){this.open=false};
 Object.assign(win,{fetch:async()=>{throw Error('UI must not collect sources')},setInterval:()=>0});
 win.eval(source.replace(/^import .*;\r?\n/gm,'')+`window.fixture={set(value){data=value;manualCosts=value.manualCosts;matchCorrections=value.matchCorrections;currentAccountId='__all__'},render,detail,effective};`);
 win.fixture.set(data);win.fixture.render();win.fixture.detail('own-melon','melon');await new Promise(resolve=>setImmediate(resolve));return win;
}
test('real strict pair survives encrypted publication and actual detail UI without changing automatic price, coverage, clocks or manual cost',async t=>{
 const p=await pipeline(t),result=await p.run();assert.equal(result.status,'verified_single_offer');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shared-offer-publish-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const other={...p.item,id:'own-boss',accountId:'boss',sellerId:'seller-boss',title:'PRIVATE_OTHER_ACCOUNT_TITLE',sharedYahooOffers:[]};
 const base={checkedAt:new Date(NOW).toISOString(),dataRevision:new Date(NOW).toISOString(),settings:{comparisonMode:'same_platform',exchangeRate:20,profitWarningJPY:1500},
  scanMeta:{sharedDetailSummary:{verifiedPairs:3}},accounts:p.accounts,items:[p.item,other],manualCosts:{'melon:item:own-melon':{accountId:'melon',itemId:'own-melon',purchaseCNY:123,shippingJPY:500}},matchCorrections:{},
  portalUsers:[{username:'member',displayName:'Member',password,accountIds:['melon'],enabled:true}],portalPreferences:{},relistAliases:{}};
 const before=structuredClone(base),row={...p.item,sharedYahooOffers:[{...result.offer,privateDescription:'NEVER_PUBLISH_PRIVATE_EXTRA'}]};
 base.items[0]=row;base.cycleCoverage=cycleCoverage(base.items,base.accounts,{startedAt:T,finishedAt:NOW});
 await writeOutputs({root,result:structuredClone(base),previous:structuredClone(before),password});
 const read=async file=>JSON.parse(decrypt(await fs.readFile(path.join(root,file)),password).toString());
 for(const file of ['state/latest.json.enc','public/data/latest.json.enc','public/data/users/member/latest.json.enc']){
  const restored=await read(file),item=restored.items.find(value=>value.id===row.id);
  assert.equal(restored.scanMeta.sharedDetailSummary.outputOffers,1);assert.equal(restored.scanMeta.sharedDetailSummary.outputOfferTargets,1);assert.equal(restored.scanMeta.sharedDetailSummary.verifiedPairs,3);
  assert.equal(item.sharedYahooOffers.length,1,file);assert.equal(item.sharedYahooOffers[0].price,8000);assert.equal(item.sharedYahooOffers[0].privateDescription,undefined);
  assert.deepEqual(item.yahoo.candidates,[]);assert.equal(item.yahoo.checkedAt,before.items[0].yahoo.checkedAt);assert.equal(item.yahoo.searchCheckedAt,before.items[0].yahoo.searchCheckedAt);
  assert.deepEqual(pricingDecision(item,{now:NOW}),pricingDecision(before.items[0],{now:NOW}));
  assert.deepEqual(pricingCoverage([item],restored.accounts),pricingCoverage([before.items[0]],restored.accounts));
  assert.equal(restored.manualCosts['melon:item:own-melon'].purchaseCNY,123);
  if(file.includes('/users/')){
   assert.equal(JSON.stringify(restored).includes('PRIVATE_OTHER_ACCOUNT_TITLE'),false);
   const win=await ui(restored);try{
    const section=win.document.querySelector('#detailSharedQuotes');assert.match(section.textContent,/8,000/);assert.match(section.textContent,/其他候选发现范围仍未完成/);
    assert.equal(section.querySelectorAll('a').length,2);assert.equal(win.fixture.effective(item).recommendedPrice,10000);
    const correction=win.document.querySelector('[data-correct]');assert.ok(correction);correction.click();
    assert.equal(win.document.querySelector('#detailSharedQuotes').textContent,'');
    assert.equal(win.fixture.effective(item).recommendedPrice,10000);
   }finally{win.close();}
  }
 }
 assert.deepEqual(p.counts(),{htmlReads:2,imageReads:2});
});
test('publication and correction cannot upgrade a raw card, old hint, changed target or cross-account own offer',async t=>{
 const p=await pipeline(t),{offer}=await p.run(),options={ownershipIndex:p.settings.ownedOffers,corrections:{},now:NOW};
 for(const fake of [p.input.recall,p.input.recall.card,{...p.input.recall.card,canRecommend:false},
  {...offer,checkedAt:new Date(T-3600_000).toISOString()},{...offer,target:{...offer.target,accountId:'boss'}},
  {...offer,sellerId:'seller-boss'},{...offer,rulesVersion:22},{...offer,verification:undefined},{...offer,imageEvidence:[]}]){
  const row={...p.item,sharedYahooOffers:[fake]};assert.equal(currentSharedYahooOffers(row,options).length,0);
  const compact=compactDashboardResult({accounts:p.accounts,items:[row],matchCorrections:{}},{now:NOW});assert.deepEqual(compact.items[0].sharedYahooOffers,[]);
  assert.deepEqual(compact.items[0].yahoo.candidates,[]);
 }
 const correction={accountId:'melon',itemId:p.item.id,platform:'yahoo',candidateId:offer.id,deleted:false};
 const corrected=invalidateCorrectedMatches({...p.item,sharedYahooOffers:[offer]},{reject:correction});assert.deepEqual(corrected.sharedYahooOffers,[]);
 const changed={...p.item,title:p.item.title+' changed',sharedYahooOffers:[offer]};assert.deepEqual(currentSharedYahooOffers(changed,options),[]);
});

test('actual UI correction list cannot render a raw rail or historical hint disguised as a shared offer',async t=>{
 const p=await pipeline(t),data={settings:{exchangeRate:20,profitWarningJPY:1500},accounts:p.accounts,items:[{...p.item,sharedYahooOffers:[{...p.input.recall.card,title:'RAW_HINT_SHOULD_NOT_RENDER',canRecommend:false}]}],manualCosts:{},matchCorrections:{}};
 const win=await ui(data);try{assert.equal(win.document.querySelector('#detailSharedQuotes').textContent,'');assert.equal(win.document.body.textContent.includes('RAW_HINT_SHOULD_NOT_RENDER'),false);assert.equal(win.document.querySelectorAll('[data-correct]').length,0);}finally{win.close();}
});
