import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {pricingDecision,PRICING_RULES_VERSION} from '../public/pricing-policy.js';

test('expired full-inventory graph scan retains encrypted state and publishes honest stale coverage for every account',async()=>{
  const source=fileURLToPath(new URL('../',import.meta.url));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-graph-state-'));
  const envKeys=['PRICE_SCAN_ENGINE','FULL_PRICE_AUDIT','FORCE_FULL_SCAN','PRICE_AUDIT_ITEM_IDS','DASHBOARD_PASSWORD','PORTAL_USERS_JSON',
    'XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3','XIANYU_STORAGE_STATE_GZIP_B64','XIANYU_STORAGE_STATE_B64'];
  const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]])),originalFetch=globalThis.fetch;
  const password='isolated-graph-test-password',memberPassword='isolated-member-password',requests=[];
  const before=Date.now(),checkedAt=new Date(before-3600000).toISOString(),searchCheckedAt=new Date(before-7200000).toISOString();
  const retryAt=before+3600000,updatedAt=new Date(before-300000).toISOString();
  const yahooAccount='account-managed_a',rakumaAccount='account-rakuma-managed_b',yahooId='zOwnOne',rakumaId='a'.repeat(32);
  const comparison=(platform,id)=>({status:'ok',evidenceStatus:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt,searchCheckedAt,searchComplete:true,
    lowestPrice:7000,lowestUrl:platform==='yahoo'?`https://paypayfleamarket.yahoo.co.jp/item/${id}`:`https://item.fril.jp/${id}`,
    candidates:[{id,title:'Synthetic historical external quote',sellerId:'external-seller',price:7000,matchMethod:'fixture-verified',checkedAt,
      url:platform==='yahoo'?`https://paypayfleamarket.yahoo.co.jp/item/${id}`:`https://item.fril.jp/${id}`}],
    ...(platform==='yahoo'?{retryAt}:{})});
  const previous={
    items:[
      {id:yahooId,accountId:yahooAccount,platform:'yahoo_fleamarket',comparisonMode:'same_platform',title:'Synthetic Yahoo product',ownPrice:9000,
        url:`https://paypayfleamarket.yahoo.co.jp/item/${yahooId}`,relistedFrom:'zOriginal',yahoo:comparison('yahoo','zExternalOne')},
      {id:rakumaId,accountId:rakumaAccount,platform:'rakuma',comparisonMode:'same_platform',title:'Synthetic Rakuma product',ownPrice:10000,
        url:`https://item.fril.jp/${rakumaId}`,rakuma:comparison('rakuma','b'.repeat(32))}
    ],
    accounts:[{id:yahooAccount,profileStatus:'live'},{id:rakumaAccount,profileStatus:'live'}],
    managedAccounts:[{id:rakumaAccount,name:'Synthetic Rakuma account',platform:'rakuma',profileUrl:'https://fril.jp/shop/managed_b',enabled:true,updatedAt}],
    manualCosts:{
      [`${yahooAccount}:zOriginal`]:{accountId:yahooAccount,itemId:'zOriginal',title:'Synthetic Yahoo product',purchaseCNY:80,manualFeeCNY:3,shippingJPY:250,updatedAt},
      [`${rakumaAccount}:${rakumaId}`]:{accountId:rakumaAccount,itemId:rakumaId,title:'Synthetic Rakuma product',purchaseCNY:125,manualFeeCNY:5,shippingJPY:300,updatedAt}
    },
    relistAliases:{[`${yahooAccount}:${yahooId}`]:'zOriginal'},
    portalPreferences:{staff_a:{notificationEmail:'updated@example.invalid',priceAlerts:false,updatedAt}},
    portalUsers:[{username:'staff_a',displayName:'Synthetic member',password:memberPassword,accountIds:[yahooAccount],enabled:true,updatedAt}],
    appliedSyncIssues:{42:{digest:'retained-synthetic-acknowledgment',appliedAt:updatedAt}},
    matchCorrections:{
      [`${yahooAccount}:${yahooId}:yahoo:rejected-candidate`]:{accountId:yahooAccount,itemId:yahooId,platform:'yahoo',candidateId:'rejected-candidate',deleted:false,updatedAt},
      [`${yahooAccount}:${yahooId}:yahoo:zExternalOne`]:{accountId:yahooAccount,itemId:yahooId,platform:'yahoo',candidateId:'zExternalOne',deleted:true,updatedAt},
      [`${rakumaAccount}:${rakumaId}:rakuma:rejected-rakuma`]:{accountId:rakumaAccount,itemId:rakumaId,platform:'rakuma',candidateId:'rejected-rakuma',deleted:false,updatedAt}
    },
    dismissedDiscoveries:{fixture:{productKey:'fixture',title:'Previously listed synthetic product',updatedAt}},
    discoveryReviews:{fixture:{productKey:'fixture',purchaseCNY:29,updatedAt}},
    yahooRequestAccess:{reason:'http_429',retryAt},
    rakumaRequestAccess:{httpStatus:429,retryAfter:'3600',observedAt:new Date(before).toISOString(),retryAt,holdReason:'retry_after'}
  };
  const readEncrypted=async(relative,key=password)=>JSON.parse(decrypt(await fs.readFile(path.join(root,relative)),key));
  try{
    await fs.cp(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});
    await fs.mkdir(path.join(root,'public'),{recursive:true});
    for(const name of ['shared-yahoo-offers.js','native-supplier-quotes.js','match-memory.js','shop-profile.js','durable-state.js','build-version.js','pricing-policy.js','owned-offers.js','merchant-config.js','merchant-records.js','merchant-image-evidence.js'])
      await fs.copyFile(path.join(source,'public',name),path.join(root,'public',name));
    for(const name of ['state','config'])await fs.mkdir(path.join(root,name));
    await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
    await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
    await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts:[{
      id:yahooAccount,name:'Synthetic Yahoo account',platform:'yahoo_fleamarket',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/managed_a'
    }]}));
    // The positive budget expires during initialization, before any collector
    // may start. No timing/sleep stub can manufacture current observations.
    await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({comparisonMode:'same_platform',scanBudgetMinutes:0.000001,
      exchangeRate:20,costMultiplier:1.05,profitWarningJPY:1500,profileConcurrency:2}));
    await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
    for(const key of envKeys)process.env[key]='';
    process.env.DASHBOARD_PASSWORD=password;process.env.PRICE_SCAN_ENGINE='full_inventory_graph';process.env.FULL_PRICE_AUDIT='0';
    globalThis.fetch=async(...args)=>{requests.push(String(args[0]));throw new Error('Unexpected external request in expired-budget scan fixture');};
    await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));
    assert.deepEqual(requests,[],'expired source admission must perform no network requests');
    const state=await readEncrypted('state/latest.json.enc'),publishedState=await readEncrypted('public/data/state.json.enc');
    const phone=await readEncrypted('public/data/latest.json.enc'),member=await readEncrypted('public/data/users/staff_a/latest.json.enc',memberPassword);
    const hold=await readEncrypted('state/yahoo-request-access.json.enc');
    assert.deepEqual(publishedState,state,'cloud restore state matches the encrypted scanner checkpoint');
    const expectedKeys=previous.items.map(item=>`${item.accountId}:${item.id}`).sort();
    for(const snapshot of [state,publishedState,phone]){
      assert.deepEqual(snapshot.items.map(item=>`${item.accountId}:${item.id}`).sort(),expectedKeys);
      assert.deepEqual(snapshot.accounts.map(account=>account.id).sort(),[yahooAccount,rakumaAccount].sort());
      for(const field of ['manualCosts','relistAliases','portalPreferences','managedAccounts','matchCorrections','dismissedDiscoveries','discoveryReviews'])
        assert.deepEqual(snapshot[field],previous[field],field);
      assert.equal(snapshot.scanMeta.pricingEngine,'full_inventory_graph');
      assert.deepEqual(snapshot.scanMeta.comparisonTasks,{yahoo:1,rakuma:1,mercari:0});
      assert.equal(snapshot.scanMeta.graph.total,2);assert.equal(snapshot.scanMeta.graph.priceComplete,0);
      assert.equal(snapshot.scanMeta.graph.complete,false);assert.equal(snapshot.scanMeta.graph.productionAccepted,false);
      assert.equal(snapshot.pricingCoverage.complete,false);assert.equal(snapshot.pricingCoverage.inventoryComplete,false);
      assert.equal(snapshot.cycleCoverage.total,2);assert.equal(snapshot.cycleCoverage.priceObserved,0);
      assert.equal(snapshot.cycleCoverage.priceComplete,0);assert.equal(snapshot.cycleCoverage.costVerified,0);
      assert.equal(snapshot.cycleCoverage.completeItems,0);assert.equal(snapshot.cycleCoverage.inventoryComplete,false);
      assert.equal(snapshot.cycleCoverage.coverageComplete,false);assert.equal(snapshot.cycleCoverage.accepted,false);
      assert.deepEqual(snapshot.rakumaRequestAccess,previous.rakumaRequestAccess);
      assert.deepEqual(snapshot.yahooRequestAccess,{reason:'http_429',retryAt});assert.equal(typeof snapshot.yahooRequestAccess.retryAt,'number');
      for(const item of snapshot.items){
        const source=item.platform==='rakuma'?'rakuma':'yahoo',comparison=item[source];
        assert.equal(comparison.status,'stale');assert.equal(comparison.evidenceStatus,'stale');assert.equal(comparison.cacheReason,'request_error');
        assert.equal(comparison.checkedAt,checkedAt);assert.equal(comparison.searchCheckedAt,searchCheckedAt);assert.equal(comparison.searchComplete,false);
        assert.equal(comparison.candidates.length,1);assert.equal(comparison.candidates[0].checkedAt,checkedAt);
        const decision=pricingDecision(item);assert.equal(decision.complete,false);assert.equal(decision.canRecommend,false);assert.equal(decision.lowest,null);
        assert.equal(item.recommendedPrice,item.ownPrice);assert.equal(item.priceSignal,'hold');
        assert.equal(item.manualPurchaseCNY,source==='yahoo'?80:125);
        if(source==='yahoo'){assert.equal(comparison.retryAt,retryAt);assert.equal(typeof comparison.retryAt,'number');}
      }
    }
    assert.deepEqual(state.appliedSyncIssues,previous.appliedSyncIssues);
    assert.deepEqual(publishedState.appliedSyncIssues,previous.appliedSyncIssues);
    assert.equal(phone.appliedSyncIssues,undefined,'acknowledgment internals stay out of compact dashboards');
    assert.deepEqual(hold,{reason:'http_429',retryAt});
    assert.deepEqual(member.items.map(item=>item.accountId),[yahooAccount]);
    assert.deepEqual(Object.keys(member.manualCosts),[`${yahooAccount}:zOriginal`]);
    assert.ok(Object.values(member.matchCorrections).every(record=>record.accountId===yahooAccount));
    assert.equal(member.matchCorrections[`${yahooAccount}:${yahooId}:yahoo:zExternalOne`].deleted,true);
    assert.equal(member.portalUser.notificationEmail,'updated@example.invalid');
    assert.equal(member.cycleCoverage.total,1);assert.equal(member.cycleCoverage.accepted,false);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await fs.rm(root,{recursive:true,force:true});
  }
});
