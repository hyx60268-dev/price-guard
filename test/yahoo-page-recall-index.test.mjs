import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mapYahooPoolToTargets} from '../scripts/lib/yahoo-page-observation-pool.mjs';
import {mapYahooPoolToTargets as brute} from './fixtures/yahoo-page-recall-brute.mjs';

const NOW=Date.parse('2026-10-18T06:00:00Z');
const url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const image=id=>`https://synthetic.invalid/${id}.jpg`;
const target=(id='own-0',accountId='account-0',title='APEX ヴァイオレット フィギュア')=>({id,accountId,platform:'yahoo',
  title:'stale item title',image:image('stale'),relistedFrom:`previous-${id}`,
  profileCard:{id,accountId,title,imageUrl:image(id),sellerId:`seller-${accountId}`,priceJPY:10000,itemStatus:'OPEN',
    source:'current_profile_card',observedAt:new Date(NOW-1000).toISOString(),
    profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/seller-${accountId}`,
    pageUrl:`https://paypayfleamarket.yahoo.co.jp/user/seller-${accountId}?page=1`,pageNumber:1}});
const card=(id,title='APEX ヴァイオレット フィギュア',extra={})=>({id,title,url:url(id),image:image(id),sellerId:'external',
  price:9000,priceKind:'ordinary',currency:'JPY',observedAt:new Date(NOW-2000).toISOString(),
  availability:null,description:null,identityVerified:false,canRecommend:false,...extra});
const page=(id,cards,at=NOW-2000)=>({source:{id,url:url(id),sha256:'a'.repeat(64),observedAt:at,expiresAt:NOW+60000,
  role:'own',fromCache:false,status:200,redirected:false,key:`${id}:${at}`},cards:cards.map(value=>({...value,observedAt:new Date(at).toISOString()}))});
function settingsFor(targets,extra={}){
  return {ownedOffersComplete:true,ownedOffers:{yahoo:{items:new Set(targets.map(value=>value.id)),
    sellers:new Set(targets.map(value=>value.profileCard?.sellerId).filter(Boolean))}},...extra};
}
const argsFor=(targets,pages,extra={})=>({targets,snapshot:{pages},settings:settingsFor(targets),now:NOW,...extra});
const identity=(target,id,extra={})=>({accountId:target.accountId,own:{id:target.id},candidate:{id},...extra});
const correction=(target,id,extra={})=>({accountId:target.accountId,itemId:target.id,platform:'yahoo',candidateId:id,deleted:false,...extra});
function equivalent(args){
  const before=structuredClone(args),expected=brute(args),actual=mapYahooPoolToTargets(args);
  assert.deepEqual(args,before,'mapping must not mutate input evidence, settings or accepted pricing');
  for(const [key,value] of Object.entries(expected)){
    if(['actualTargetObservationVisits','omittedTargetObservationVisits'].includes(key))continue;
    assert.deepEqual(actual[key],value,`original result field ${key}`);
  }
  assert.equal(actual.mappingStopped,false);
  assert.equal(actual.naivePotentialTargetObservationVisits,expected.actualTargetObservationVisits);
  assert.equal(actual.omittedTargetObservationVisits,0);
  assert.equal(actual.actualTargetObservationVisits+actual.preexcludedOwnedTargetObservationPairs+actual.indexEliminatedTargetObservationPairs,
    actual.naivePotentialTargetObservationVisits,'every naive pair is processed or conclusively eliminated');
  assert.ok(actual.scoredTargetObservationPairs<=actual.actualTargetObservationVisits);
  assert.ok(actual.actualTargetObservationVisits<=actual.maximumTargetObservationVisits);
  assert.equal(actual.actualIndexedWorkUnits,actual.indexBuildPostingVisits+actual.indexQueryPostingVisits+actual.actualTargetObservationVisits);
  assert.ok(actual.actualIndexedWorkUnits<=actual.maximumIndexedWorkUnits);
  return actual;
}

test('reverse recall exactly preserves duplicates, newer prices, equal-time conflicts, source order and source/candidate caps',()=>{
  const own=target(),pages=[page('first',[card('same'),card('other'),card('never','completely different')],NOW-100),
    page('second',[card('same',own.profileCard.title,{price:7000}),card('other',own.profileCard.title,{price:null})],NOW-300),
    page('third',[card('same',own.profileCard.title,{price:8000}),card('other',own.profileCard.title,{price:6000})],NOW-100)];
  for(const maximumCandidatesPerTarget of [1,2,64])for(const maximumSourceReferencesPerCandidate of [1,2,8]){
    const result=equivalent(argsFor([own],pages,{maximumCandidatesPerTarget,maximumSourceReferencesPerCandidate}));
    const same=result.rows[0].candidates.find(value=>value.id==='same');
    if(same){assert.equal(same.card.price,8000);assert.equal(same.conflictingCardObservations,true);assert.equal(same.identityVerified,false);}
  }
});

test('exact URL and account/own-bound first historical identity recall with no shared title gram',()=>{
  const own=target('own-0','account-0','abcdef'),same=card('image-only','UVWXYZ',{image:own.profileCard.imageUrl});
  own.historicalIdentities=[identity(own,'history-only',{marker:'first'}),identity(own,'history-only',{marker:'second'}),
    identity(own,'wrong-account',{accountId:'another'}),identity(own,'wrong-own',{own:{id:'another'}})];
  const out=equivalent(argsFor([own],[page('source',[same,card('history-only','123456'),card('wrong-account','123456'),card('wrong-own','123456')])]));
  assert.deepEqual(out.rows[0].candidates.map(value=>value.id),['history-only','image-only']);
  assert.equal(out.rows[0].candidates[0].historicalIdentity.marker,'first');
  assert.equal(out.rows[0].candidates[0].titleSimilarity,0);
  assert.equal(out.rows[0].candidates[1].sameImageUrl,true);
});

test('image/history recall still reports exact title score when title length makes threshold impossible',()=>{
  const own=target('own-0','account-0','abc'),external=card('long','abcdefghijklmnopqrstuvwxyz',{image:own.profileCard.imageUrl});
  const result=equivalent(argsFor([own],[page('source',[external])]));
  assert.equal(result.rows[0].candidates[0].titleSimilarity,2/25);
});

test('owned seller discovered on another page preexcludes every duplicate before recall, with exact exclusion order/counts',()=>{
  const first=target(),second=target('own-1','account-1'),pages=[page('a',[card('owned-later','different'),card('corrected','different'),card('external'),card(second.id)]),
    page('b',[card('owned-later','different',{sellerId:second.profileCard.sellerId}),card('corrected','different')])];
  const settings=settingsFor([first,second],{matchCorrections:{reject:correction(first,'corrected')}});
  for(const maximumCandidatesPerTarget of [1,2,64]){
    const out=equivalent(argsFor([first,second],pages,{settings,maximumCandidatesPerTarget}));
    assert.equal(out.preexcludedOwnedCardObservations,3);
    assert.equal(out.preexcludedOwnedTargetObservationPairs,6);
    assert.equal(out.rows[0].excludedCardObservations,5);
    assert.equal(out.rows[1].excludedCardObservations,3);
    assert.ok(out.rows.every(row=>!row.candidates.some(value=>value.id==='owned-later')));
  }
});

test('corrections preserve account/platform, direct identity, relisting current title/image and tombstone rules even without title overlap',()=>{
  const own=target(),candidates=['direct','relisted-current','relisted-stale','relisted-wrong-image','other-account','other-platform','deleted'];
  const records={direct:correction(own,'direct'),relisted:correction(own,'relisted-current',{itemId:own.relistedFrom,ownTitle:own.profileCard.title,ownImage:own.profileCard.imageUrl}),
    stale:correction(own,'relisted-stale',{itemId:own.relistedFrom,ownTitle:own.title,ownImage:own.image}),
    image:correction(own,'relisted-wrong-image',{itemId:own.relistedFrom,ownTitle:own.profileCard.title,ownImage:own.image}),
    account:correction(own,'other-account',{accountId:'other'}),platform:correction(own,'other-platform',{platform:'rakuma'}),
    tombstone:correction(own,'deleted',{deleted:true})};
  const args=argsFor([own],[page('a',candidates.map(id=>card(id,'unrelated text')))],{settings:settingsFor([own],{matchCorrections:records})});
  const out=equivalent(args);
  assert.deepEqual(out.rows[0].excluded.map(value=>value.id),['direct','relisted-current']);
  assert.equal(out.rows[0].unmappedCardObservations,5);
  args.targets[0].historicalIdentities=candidates.map(id=>identity(own,id));
  const recalled=equivalent(args);
  assert.equal(recalled.rows[0].candidates.length,5);
});

test('threshold zero, empty card/title grams, normalization, repeated grams and exact threshold boundaries match the oracle',()=>{
  const targets=[target(),target('one','account-0','A'),target('punctuation','account-0','...'),target('empty','account-0','')];
  const pages=[page('source',['','A','...','ＡＰＥＸ  ヴァイオレット！ フィギュア','abababab','😀😀😀'].map((title,index)=>card(`card-${index}`,title)))];
  for(const titleThreshold of [0,Number.MIN_VALUE,.35,1])equivalent(argsFor(targets,pages,{titleThreshold}));
  const own=target('boundary','account-0','abcdefghijklmnopqrstu');
  const boundary=argsFor([own],[page('a',[card('yes','abcdefghXYZ'),card('no','abcdefgXYZ')])],{titleThreshold:.35});
  const result=equivalent(boundary);
  assert.deepEqual(result.rows[0].candidates.map(value=>value.id),['yes']);
  assert.equal(result.rows[0].candidates[0].titleSimilarity,.35);
});

test('every account/target remains in denominator including no-hit, unsupported, closed, stale and incomplete ownership',()=>{
  const targets=[target('match'),target('nohit','account-1','UVWXYZ'),target('closed'),target('stale'),target('rakuma'),target('missing')];
  targets[2].profileCard.itemStatus='CLOSED';targets[3].profileCard.observedAt=new Date(NOW-21*60_000).toISOString();
  targets[4].platform='rakuma';targets[5].profileCard=null;
  const args=argsFor(targets,[page('source',[card('external')]),{...page('expired',[card('expired')]),source:{...page('expired',[]).source,expiresAt:NOW}},
    page('future',[card('future')],NOW+1)]);
  const result=equivalent(args);
  assert.equal(result.totalManagedTargets,6);assert.equal(result.rows.length,6);assert.equal(result.mappedTargets,1);
  assert.equal(result.unmappedTargets,5);assert.equal(result.rows[1].status,'unresolved');
  assert.equal(result.rows[2].status,'not_open');assert.equal(result.rows[5].reason,'target_profile_binding_required');
  args.settings.ownedOffersComplete=false;equivalent(args);
  assert.equal(mapYahooPoolToTargets(args).rows.every(row=>row.reason==='complete_owned_index_required'),true);
});

function random(seed){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};}
const pick=(rng,values)=>values[Math.floor(rng()*values.length)];
function generated(seed,{targetCount=8,pageCount=7,cardsPerPage=12}={}){
  const rng=random(seed),titles=['APEX ヴァイオレット フィギュア','apexviolet','ＡＰＥＸ violet','新品 魔女 ドレス','新作 魔女 フィギュア',
    'abcdefghi','ABCDEFGHI','UVWXYZ','ab ab ab','', '.', 'A','😀blue👗 red'];
  const targets=Array.from({length:targetCount},(_,i)=>target(`own-${i}`,`account-${i%3}`,pick(rng,titles)));
  const pages=Array.from({length:pageCount},(_,i)=>page(`page-${i}`,Array.from({length:cardsPerPage},()=>{
    const id=pick(rng,Array.from({length:cardsPerPage*2},(_,j)=>`external-${j}`).concat(targets.map(row=>row.id)));
    return card(id,pick(rng,titles),{image:pick(rng,[image(id),...targets.map(row=>row.profileCard.imageUrl)]),
      sellerId:pick(rng,[...Array(15).fill('external'),'external-other',null,...new Set(targets.map(row=>row.profileCard.sellerId))]),price:pick(rng,[null,5000,9000,10000,15000])});
  }),NOW-pick(rng,[1000,2000,3000])));
  const records={};
  for(const own of targets){
    own.historicalIdentities=Array.from({length:5},()=>identity(own,`external-${Math.floor(rng()*cardsPerPage*2)}`,{accountId:pick(rng,[own.accountId,'other'])}));
    for(let i=0;i<5;i++)records[`${own.id}-${i}`]=correction(own,`external-${Math.floor(rng()*cardsPerPage*2)}`,{
      itemId:pick(rng,[own.id,own.relistedFrom,'other']),ownTitle:pick(rng,[own.title,own.profileCard.title]),
      ownImage:pick(rng,[own.image,own.profileCard.imageUrl]),deleted:rng()<.2,platform:pick(rng,['yahoo','yahoo','rakuma']),
      accountId:pick(rng,[own.accountId,own.accountId,'other'])});
  }
  return argsFor(targets,pages,{settings:settingsFor(targets,{matchCorrections:records}),titleThreshold:pick(rng,[0,.35,.5,1,Number.MIN_VALUE]),
    maximumCandidatesPerTarget:pick(rng,[1,3,64]),maximumSourceReferencesPerCandidate:pick(rng,[1,2,8])});
}

test('250 seeded randomized shared observations exactly match the frozen Cartesian mapper',()=>{
  for(let seed=1;seed<=250;seed++){
    try{equivalent(generated(seed));}catch(error){error.message=`seed ${seed}: ${error.message}`;throw error;}
  }
});

test('budget failure before/during index or target query fails closed with all targets and unresolved work retained',()=>{
  const args=generated(83,{targetCount:15,pageCount:10,cardsPerPage:30});
  for(const limit of [0,1,5,15,30,50,100]){
    let calls=0;
    const actual=mapYahooPoolToTargets({...args,continueMapping:()=>calls++<limit});
    assert.equal(actual.rows.length,args.targets.length);
    assert.equal(actual.mappedTargets+actual.unmappedTargets,args.targets.length);
    assert.ok(actual.actualTargetObservationVisits<=actual.naivePotentialTargetObservationVisits);
    assert.equal(actual.omittedTargetObservationVisits+actual.actualTargetObservationVisits+actual.preexcludedOwnedTargetObservationPairs+actual.indexEliminatedTargetObservationPairs,
      actual.naivePotentialTargetObservationVisits);
    if(actual.mappingStopped){assert.ok(actual.budgetUnresolvedTargets>0);assert.equal(actual.mappingStoppedReason,'callback_budget');}
    if(!actual.indexBuildComplete)assert.equal(actual.targetCandidatePairs,0,'partial global ownership/index must never leak a candidate');
    assert.equal(actual.completeComparisons,0);assert.equal(actual.searchCheckedAt,null);assert.equal(actual.marketplaceRequests,0);
  }
});

test('threshold-zero Cartesian fallback is visit-bounded and exposes partial work without fake completion',()=>{
  const targets=[target(),target('own-1'),target('own-2')],args=argsFor(targets,[page('source',Array.from({length:100},(_,i)=>card(`external-${i}`)))],
    {titleThreshold:0,maximumTargetObservationVisits:17});
  const out=mapYahooPoolToTargets(args);
  assert.equal(out.actualTargetObservationVisits,17);assert.equal(out.scoredTargetObservationPairs,17);
  assert.equal(out.mappingStopped,true);assert.equal(out.mappingStoppedReason,'actual_visit_limit');
  assert.equal(out.budgetUnresolvedTargets,3);assert.equal(out.omittedTargetObservationVisits,283);
  assert.equal(out.rows[0].candidates.length,17);assert.equal(out.rows[1].reason,'local_mapping_budget');
  assert.equal(out.totalManagedTargets,3);assert.equal(out.completeComparisons,0);
});

test('paired generated 627-target/2320-observation scale replay reduces work, with exact candidates and no transport',()=>{
  // Generated workload, deliberately not represented as a replay of private production evidence.
  const targets=Array.from({length:627},(_,i)=>target(`own-${i}`,`account-${i%3}`,`${String.fromCharCode(0x5000+i)}${String.fromCharCode(0x6000+i)}${String.fromCharCode(0x7000+i)}`));
  const pages=Array.from({length:29},(_,i)=>page(`page-${i}`,Array.from({length:80},(_,j)=>{
    const n=i*80+j,id=`external-${n%1833}`,own=targets[n%targets.length];return card(id,own.profileCard.title);
  })));
  const args=argsFor(targets,pages),oldFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('recall must never use transport');};
  try{
    const started=performance.now(),expected=brute(args),bruteMs=performance.now()-started;
    const indexedStarted=performance.now(),actual=mapYahooPoolToTargets(args),indexMs=performance.now()-indexedStarted;
    assert.deepEqual(actual.rows,expected.rows);assert.equal(actual.mappingStopped,false);
    assert.equal(actual.naivePotentialTargetObservationVisits,1_454_640);
    assert.equal(actual.actualTargetObservationVisits,2320);assert.equal(actual.scoredTargetObservationPairs,2320);
    assert.equal(actual.omittedTargetObservationVisits,0);assert.equal(actual.totalManagedTargets,627);
    assert.ok(indexMs<1000,'generated selective case must complete inside the unchanged one-second mapping budget');
    console.log(JSON.stringify({fixture:'generated-selective-627x2320',bruteMs:Math.round(bruteMs),indexMs:Math.round(indexMs),
      naivePairs:actual.naivePotentialTargetObservationVisits,indexedVisits:actual.actualTargetObservationVisits,pairs:actual.targetCandidatePairs}));
  }finally{globalThis.fetch=oldFetch;}
});

test('high-frequency Japanese boilerplate stays exact on paired generated scale input',()=>{
  const targets=Array.from({length:627},(_,i)=>target(`own-${i}`,`account-${i%3}`,
    `新品 フィギュア ${Array.from({length:24},(_,j)=>String.fromCharCode(0x5000+i*24+j)).join('')}`));
  const pages=Array.from({length:29},(_,i)=>page(`page-${i}`,Array.from({length:80},(_,j)=>{
    const n=i*80+j;return card(`external-${n%1833}`,targets[n%627].profileCard.title);
  })));
  const args=argsFor(targets,pages),started=performance.now(),expected=brute(args),bruteMs=performance.now()-started;
  const indexedStarted=performance.now(),actual=mapYahooPoolToTargets(args),indexMs=performance.now()-indexedStarted;
  assert.deepEqual(actual.rows,expected.rows);assert.equal(actual.mappingStopped,false);assert.equal(actual.omittedTargetObservationVisits,0);
  assert.equal(actual.actualTargetObservationVisits,1_454_640,'shared boilerplate can make every pair mathematically possible');
  assert.equal(actual.scoredTargetObservationPairs,1_454_640,'score work is not hidden as free index elimination');
  assert.equal(actual.targetCandidatePairs,2320);
  console.log(JSON.stringify({fixture:'generated-common-grams-627x2320',bruteMs:Math.round(bruteMs),indexMs:Math.round(indexMs),
    naivePairs:actual.naivePotentialTargetObservationVisits,indexedVisits:actual.actualTargetObservationVisits,indexPostingVisits:actual.indexQueryPostingVisits}));
  // Clock enforcement includes building/querying the index, not only final visits.
  const budgetStart=performance.now(),bounded=mapYahooPoolToTargets({...args,continueMapping:()=>performance.now()-budgetStart<1000});
  assert.equal(bounded.totalManagedTargets,627);assert.ok(bounded.actualTargetObservationVisits<=2_000_000);
  if(bounded.mappingStopped){assert.ok(bounded.budgetUnresolvedTargets>0);assert.ok(bounded.omittedTargetObservationVisits>0);}
});

test('worst-case universal shared grams cannot exceed the hard actual-pair visit limit',()=>{
  const targets=Array.from({length:220},(_,i)=>target(`own-${i}`));
  const pages=Array.from({length:120},(_,i)=>page(`page-${i}`,Array.from({length:80},(_,j)=>card(`external-${i*80+j}`))));
  const out=mapYahooPoolToTargets(argsFor(targets,pages,{maximumTargetObservationVisits:1000}));
  assert.equal(out.naivePotentialTargetObservationVisits,2_112_000);
  assert.equal(out.actualTargetObservationVisits,1000);assert.equal(out.scoredTargetObservationPairs,1000);
  assert.equal(out.mappingStopped,true);assert.equal(out.mappingStoppedReason,'actual_visit_limit');
  assert.equal(out.omittedTargetObservationVisits,2_111_000);assert.equal(out.budgetUnresolvedTargets,220);
  assert.equal(out.totalManagedTargets,220);
  assert.throws(()=>mapYahooPoolToTargets({...argsFor(targets,pages),maximumTargetObservationVisits:2_000_001}),/invalid_mapping_visit_bound/);
});

test('default two-million bound stops common-gram scoring without requiring an artificially lower cap',()=>{
  const targets=Array.from({length:220},(_,i)=>target(`own-${i}`));
  const pages=Array.from({length:120},(_,i)=>page(`page-${i}`,Array.from({length:80},(_,j)=>card(`external-${i*80+j}`,
    'フィギュア 1234567890abcdefghijklmnop'))));
  const out=mapYahooPoolToTargets(argsFor(targets,pages));
  assert.equal(out.maximumTargetObservationVisits,2_000_000);
  assert.equal(out.actualTargetObservationVisits,2_000_000);assert.equal(out.scoredTargetObservationPairs,2_000_000);
  assert.equal(out.omittedTargetObservationVisits,112000);assert.equal(out.mappingStoppedReason,'actual_visit_limit');
  assert.equal(out.totalManagedTargets,220);assert.equal(out.targetCandidatePairs,0);assert.ok(out.budgetUnresolvedTargets>0);
});

test('independent indexed-work guard accounts exactly and stops index build, query or final pairs with a nonexpiring timer',()=>{
  const args=argsFor([target('own','account','abc')],[page('source',[card('one','abc'),card('two','abc'),card('three','abc')])]);
  const complete=mapYahooPoolToTargets(args),build=complete.indexBuildPostingVisits,query=complete.indexQueryPostingVisits;
  assert.equal(build,6);assert.equal(query,6);assert.equal(complete.actualIndexedWorkUnits,15);
  for(const [cap,phase] of [[build-1,'build'],[build+1,'query'],[build+query+1,'pairs']]){
    const out=mapYahooPoolToTargets({...args,maximumIndexedWorkUnits:cap,continueMapping:()=>true});
    assert.equal(out.actualIndexedWorkUnits,cap);
    assert.equal(out.actualIndexedWorkUnits,out.indexBuildPostingVisits+out.indexQueryPostingVisits+out.actualTargetObservationVisits);
    assert.equal(out.mappingStopped,true);assert.equal(out.mappingStoppedReason,'indexed_work_limit');
    assert.equal(out.totalManagedTargets,1);assert.equal(out.budgetUnresolvedTargets,1);
    assert.equal(out.rows[0].mappingIncomplete,true);assert.equal(out.rows[0].reason,'local_mapping_budget');
    if(phase==='build')assert.equal(out.indexBuildComplete,false);else assert.equal(out.indexBuildComplete,true);
    assert.equal(out.targetCandidatePairs,phase==='pairs'?1:0);
    assert.equal(out.rows[0].status,phase==='pairs'?'local_recall_only':'blocked');
  }
  assert.throws(()=>mapYahooPoolToTargets({...args,maximumIndexedWorkUnits:20_000_001}),/invalid_indexed_work_bound/);
});

test('partial target is explicitly incomplete whether a stopped pair loop recalled a candidate or only rejected a weak title',()=>{
  for(const hit of [false,true]){
    const own=target('own','account','abcdefghijklmnopqrstu'),cards=[card('one',hit?own.profileCard.title:'abcUVWXYZ01234567890'),card('two',own.profileCard.title)];
    const out=mapYahooPoolToTargets(argsFor([own,target('next')],[page('source',cards)],{maximumTargetObservationVisits:1}));
    assert.equal(out.rows[0].mappingIncomplete,true);assert.equal(out.rows[0].reason,'local_mapping_budget');
    assert.equal(out.rows[0].status,hit?'local_recall_only':'blocked');assert.equal(out.rows[0].candidates.length,hit?1:0);
    assert.equal(out.rows[1].mappingIncomplete,true);assert.equal(out.rows[1].status,'blocked');
    assert.equal(out.budgetUnresolvedTargets,2);assert.equal(out.totalManagedTargets,2);
  }
});

test('default 20M posting/pair guard bounds extreme common grams even if the time callback never expires',()=>{
  const common='新品 未使用 フィギュア 1/7 完成品 スケール 塗装済み ',
    suffix=start=>Array.from({length:60},(_,i)=>String.fromCharCode(start+i)).join('');
  const targets=Array.from({length:220},(_,i)=>target(`own-${i}`,'account',common+suffix(0x5000)));
  const pages=Array.from({length:120},(_,i)=>page(`page-${i}`,Array.from({length:80},(_,j)=>card(`external-${i*80+j}`,common+suffix(0x6000)))));
  const out=mapYahooPoolToTargets({...argsFor(targets,pages),continueMapping:()=>true});
  assert.equal(out.maximumIndexedWorkUnits,20_000_000);assert.equal(out.actualIndexedWorkUnits,20_000_000);
  assert.equal(out.actualIndexedWorkUnits,out.indexBuildPostingVisits+out.indexQueryPostingVisits+out.actualTargetObservationVisits);
  assert.equal(out.mappingStoppedReason,'indexed_work_limit');assert.ok(out.actualTargetObservationVisits<2_000_000);
  assert.equal(out.maximumTargetObservationVisits,2_000_000);assert.equal(out.totalManagedTargets,220);assert.equal(out.rows.length,220);
  assert.equal(out.targetCandidatePairs,0);assert.ok(out.budgetUnresolvedTargets>0);assert.ok(out.omittedTargetObservationVisits>0);
  assert.equal(out.rows.filter(row=>row.mappingIncomplete).length,out.budgetUnresolvedTargets);
});
