import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {comparisonAuditRequested,openScanComparisonAudit,currentAuditOwnership,executeScanComparisonAudit} from '../scripts/lib/comparison-audit-scan.mjs';
import {comparisonAuditMarker} from '../scripts/lib/comparison-audit-control.mjs';
import {fetchYahooPage,discoverYahooProfile,fetchYahooItemBundle} from '../scripts/lib/yahoo.mjs';
import {compactDashboardResult,scopeResultForPortalUser} from '../scripts/lib/publish.mjs';
const START=Date.parse('2026-10-16T12:00:00Z'),iso=value=>new Date(value).toISOString(),sha='a'.repeat(40),password='synthetic-audit-password';
const accounts=['melon','boss','momoka'].map((id,i)=>({id,platform:'yahoo',profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/p${i+1}`}));
const items=accounts.map((account,i)=>({id:`z${i+1}`,accountId:account.id,platform:'yahoo',itemStatus:'OPEN',sellerId:`p${i+1}`,title:`新品 同型 フィギュア ${i}`,ownPrice:10000,image:`https://images.invalid/${i}.png`}));
const activation={enabled:true,requestId:'synthetic-audit-run',issuedAt:iso(START-1000),expiresAt:iso(START+3600000),targets:items.slice(0,2).map(item=>({accountId:item.accountId,itemId:item.id}))};
const context={writerLockHeld:true,runId:'123',runAttempt:1,codeSha:sha,expectedSha:sha,eventSha:sha,currentMainSha:sha,eventName:'push',ref:'refs/heads/main',commitMessage:comparisonAuditMarker(activation.requestId)};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'audit-scan-'));t.after(()=>fs.rm(root,{force:true,recursive:true}));await fs.mkdir(path.join(root,'state'));
 const previous={checkedAt:iso(START-3600000),items,listingHistory:{old:{id:'old-id',accountId:'melon',sellerId:'p99'}},manualCosts:{kept:{purchaseCNY:123}},yahooRequestAccess:{retryAt:START-1000,reason:'http_429'},scanMeta:{codeSha:sha},scanAdmission:{version:1,runKey:'123:1',codeSha:sha,claimedAt:iso(START-1),slotKey:''}};
 const file=path.join(root,'state/latest.json.enc'),save=value=>fs.writeFile(file,encrypt(Buffer.from(JSON.stringify(value)),password)),read=async()=>JSON.parse(decrypt(await fs.readFile(file),password));
 await save(previous);
 const options={root,password,previous,accounts,startedAt:iso(START),context,now:()=>START};
 await openScanComparisonAudit({...options,activation:{enabled:false},legacyStateCodeShas:[sha]});
 return {root,file,previous,options,save,read};
}
function profile(session,account,index){
 const permit=session.settings.beforeYahooTransport({url:`${account.profileUrl}?page=1`,accountId:account.id});
 session.settings.afterYahooTransport({reservation:permit,httpStatus:200,completed:true,transportStarted:true,decodedBodyBytes:100,observedAt:START});
 return {account,profileStatus:'live',activeItems:[items[index]],profileDiscovery:{profileObservation:{complete:true,enumerationComplete:true,ownershipConflictCount:0,membershipIds:[items[index].id],observedAt:START,pageObservations:[{pageNumber:1,observedAt:START}]}}};
}
test('disabled preparation changes only replay ledger; active claim survives storage and cannot replay',async t=>{
 const f=await fixture(t),prepared=await f.read();assert.deepEqual({...prepared,comparisonAuditReceipt:undefined},{...f.previous,comparisonAuditReceipt:undefined});
 const session=await openScanComparisonAudit({...f.options,activation});assert.equal(session.active,true);
 const saved=await f.read();assert.equal(saved.comparisonAuditReceipt.consumed.length,1);assert.deepEqual(saved.manualCosts,f.previous.manualCosts);assert.deepEqual(saved.yahooRequestAccess,f.previous.yahooRequestAccess);
 assert.deepEqual(await session.state.readReceipt(),saved.comparisonAuditReceipt);
 await assert.rejects(openScanComparisonAudit({...f.options,activation}),/already_consumed/);
});
test('ordinary push cannot activate old marker; expired/rerun/stale-main and missing receipt make no source calls',async t=>{
 const f=await fixture(t);assert.equal(comparisonAuditRequested(activation,{head_commit:{message:'ordinary fix'}}),false);
 assert.equal(comparisonAuditRequested(activation,{head_commit:{message:context.commitMessage}}),true);
 for(const changes of [{runAttempt:2},{currentMainSha:'b'.repeat(40)}])await assert.rejects(openScanComparisonAudit({...f.options,activation,context:{...context,...changes}}));
 await assert.rejects(openScanComparisonAudit({...f.options,activation:{...activation,expiresAt:iso(START)}}),/expired/);
 await f.save(f.previous);await assert.rejects(openScanComparisonAudit({...f.options,activation}),/receipt/);
});
test('three accounted current profiles include all aliases/history and no competitor read can precede them',async t=>{
 const f=await fixture(t),session=await openScanComparisonAudit({...f.options,activation});
 assert.throws(()=>session.settings.beforeYahooTransport({url:'https://paypayfleamarket.yahoo.co.jp/item/z1',purpose:'own'}),/ownership_incomplete/);
 const contexts=accounts.map((account,i)=>profile(session,account,i));
 const incomplete=structuredClone(contexts);incomplete[2].profileDiscovery.profileObservation.complete=false;
 assert.throws(()=>currentAuditOwnership(session,incomplete,START),/Complete current/);
 const index=currentAuditOwnership(session,contexts,START);assert.equal(index.accounts.length,3);assert.ok(index.accounts[0].sellerIds.includes('p99'));assert.ok(index.accounts[0].listingIds.includes('old-id'));
 assert.equal(session.controller.classifyOwnership({id:'external',sellerId:'p99'}),'owned');
 assert.equal(session.controller.snapshot().counts.byKind.profile,3);
});
test('source denial finishes once and prevents remaining profile and all detail admissions',async t=>{
 const f=await fixture(t),session=await openScanComparisonAudit({...f.options,activation});
 const reservation=session.settings.beforeYahooTransport({url:accounts[0].profileUrl+'?page=1',accountId:'melon'});
 session.settings.afterYahooTransport({reservation,httpStatus:429,transportStarted:true,completed:false,decodedBodyBytes:0});
 assert.throws(()=>profile(session,accounts[1],1),/source_denied/);assert.equal(session.controller.snapshot().counts.pageFetches,1);assert.equal(session.controller.snapshot().stopped,'source_denied');
});
test('actual profile collector records raw shape before seller fallback without extra reads',async()=>{
 let reads=0;const result={totalResultsAvailable:2,items:[{id:'z1',title:'one',price:100,thumbnailImageUrl:'https://images.invalid/1.png',itemStatus:'OPEN'}, {id:'z2',title:'two',price:200,thumbnailImageUrl:'https://images.invalid/2.png',itemStatus:'SOLD',sellerId:'p1'}]};
 const html='<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{searchState:{search:{result}}}}})+'</script>';
 const discovered=await discoverYahooProfile(null,accounts[0].profileUrl,{yahooRequestAccountId:'melon'},{fetchPage:async url=>{reads++;return {html,status:200,url,redirected:false,fromCache:false,observedAt:Date.now()}}});
 assert.equal(reads,1);assert.equal(discovered.items.length,1);assert.equal(discovered.items[0].sellerId,'p1');
 const observed=discovered.profileObservation;assert.equal(observed.complete,true);assert.equal(observed.membershipIds.length,2);assert.equal(observed.quoteEligibleCount,0);assert.equal(observed.quoteIneligibleReasons.seller_missing,1);assert.equal(observed.schemaReceipts[0].missingSellerCount,1);
});
test('runner integration counts profiles and own pages inside the same budget with no new pricing evidence',async t=>{
 const f=await fixture(t),session=await openScanComparisonAudit({...f.options,activation}),contexts=accounts.map((account,i)=>profile(session,account,i));let details=0,images=0;
 const report=await executeScanComparisonAudit({session,activation,contexts,settings:session.settings,now:()=>START,imageFingerprints:async()=>{images++;return null},readBundle:async(id,settings)=>{
  details++;const item=items.find(row=>row.id===id),reservation=settings.beforeYahooTransport({url:`https://paypayfleamarket.yahoo.co.jp/item/${id}`,purpose:settings.yahooRequestPurpose,accountId:settings.yahooRequestAccountId});
  settings.afterYahooTransport({reservation,httpStatus:200,completed:true,transportStarted:true,decodedBodyBytes:200,observedAt:START});
  return {detail:{id,title:item.title,price:item.ownPrice,status:'OPEN',description:'新品 フィギュア1点',seller:{id:item.sellerId},images:[item.image]},sourceUrl:`https://paypayfleamarket.yahoo.co.jp/item/${id}`,observedAt:START,fromCache:false,auditReservationId:reservation.reservationId,recommendationReceipt:{version:1,requestedItemId:id,sourceUrl:`https://paypayfleamarket.yahoo.co.jp/item/${id}`,observedAt:iso(START),totalCards:0,invalidCards:0,cards:[]}};
 }});
 assert.equal(details,2);assert.equal(images,0);assert.equal(report.controller.counts.pageFetches,5);assert.equal(report.controller.counts.byKind.profile,3);assert.equal(report.controller.counts.byKind.own,2);assert.equal(report.canRecommend,false);assert.equal(report.procurementCostEligible,false);assert.deepEqual(f.previous.items,items);
});
test('global private frozen report and replay ledger do not enter compact/member publications',()=>{
 const result={items,accounts,comparisonAudit:{privateMarker:'other-account'},comparisonAuditReceipt:{privateMarker:'execution'}};
 const compact=compactDashboardResult(result),member=scopeResultForPortalUser(result,{accountIds:['melon']});
 assert.equal(compact.comparisonAudit,undefined);assert.equal(compact.comparisonAuditReceipt,undefined);assert.equal(member.comparisonAudit,undefined);assert.equal(member.comparisonAuditReceipt,undefined);assert.equal(member.items.length,1);
});
