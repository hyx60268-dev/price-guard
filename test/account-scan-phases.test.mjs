import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedAccountPhases,runAccountScanPhases} from '../scripts/lib/account-scan-phases.mjs';
import {mapLimit} from '../scripts/lib/worker-pool.mjs';

const context=(id,platform)=>({account:{id,platform},activeItems:[{id:`item-${id}`,checkedAt:'2026-01-01T00:00:00Z'}]});
const fixture=()=>[context('raku','rakuma'),context('momoka','yahoo_fleamarket'),context('unknown','unrecognized'),
  context('boss','yahoo'),context('melon','paypayfleamarket'),context('mercari','mercari'),context('raku2','fril')];
const priorityAccountIds=['melon','boss','momoka'];
const noop=async()=>{};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('platform phases retain all contexts and stable account priority without mutating inventory',()=>{
  const contexts=fixture(),before=structuredClone(contexts);
  const phases=orderedAccountPhases(contexts,{priorityAccountIds:['melon','boss','momoka','melon','raku2']});
  assert.deepEqual(phases.map(phase=>[phase.key,phase.contexts.map(value=>value.account.id)]),[
    ['yahoo',['melon','boss','momoka']],['other',['unknown','mercari']],['rakuma',['raku2','raku']]]);
  assert.deepEqual(contexts,before);
  assert.equal(phases.flatMap(phase=>phase.contexts).length,contexts.length);
  for(const value of contexts)assert.ok(phases.some(phase=>phase.contexts.includes(value)));
  assert.deepEqual(orderedAccountPhases([]),[]);
});

test('Yahoo URL aliases use existing ownership normalization; remaining account order stays stable',()=>{
  const inferred={account:{id:'inferred',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/fixture'}};
  const contexts=[context('second','Yahoo_Fleamarket'),inferred,context('first','yahoo'),context('last','yahoo')];
  assert.deepEqual(orderedAccountPhases(contexts,{priorityAccountIds:['first']})[0].contexts.map(value=>value.account.id),
    ['first','second','inferred','last']);
});

test('discover and scan fully settle in phase order and preserve callback results and the shared deadline',async()=>{
  const calls=[],events=[],contexts=fixture(),before=structuredClone(contexts),deadline=100;
  const results=await runAccountScanPhases(contexts,{priorityAccountIds,deadline,now:()=>10,
    discover:async(phase,bounds)=>{assert.equal(bounds.deadline,deadline);calls.push(`discover:${phase.key}`);await tick();return `inventory:${phase.key}`;},
    scan:async(phase,bounds)=>{assert.equal(bounds.deadline,deadline);calls.push(`scan:${phase.key}`);await tick();return `quotes:${phase.key}`;},
    defer:()=>{throw Error('unexpected defer');},onPhase:event=>events.push(event)});
  assert.deepEqual(calls,['discover:yahoo','scan:yahoo','discover:other','scan:other','discover:rakuma','scan:rakuma']);
  assert.deepEqual(results.map(value=>[value.key,value.status,value.discovery,value.scan]),[
    ['yahoo','completed','inventory:yahoo','quotes:yahoo'],['other','completed','inventory:other','quotes:other'],
    ['rakuma','completed','inventory:rakuma','quotes:rakuma']]);
  assert.deepEqual(contexts,before);
  for(const event of events){
    assert.ok(Object.keys(event).every(key=>['key','event','count','at','durationMs'].includes(key)));
    assert.ok(Number.isFinite(event.at));assert.ok(event.count>0);
  }
});

test('expired deadline defers every phase without discovery, scans, or inventory loss',async()=>{
  const contexts=fixture(),deferred=[];
  const results=await runAccountScanPhases(contexts,{deadline:100,now:()=>100,discover:()=>{throw Error('discovery after deadline');},
    scan:()=>{throw Error('scan after deadline');},defer:async(phase,reason)=>{deferred.push(...phase.contexts);assert.equal(reason,'deferred_due_to_priority');return phase.key;}});
  assert.equal(deferred.length,contexts.length);
  assert.deepEqual(new Set(deferred),new Set(contexts));
  assert.deepEqual(results.map(value=>[value.status,value.deferred]),[['deferred','yahoo'],['deferred','other'],['deferred','rakuma']]);
});

test('deadline reached during discovery defers this phase and all later phases without resetting the clock',async()=>{
  let time=10;const calls=[];
  const results=await runAccountScanPhases(fixture(),{deadline:20,now:()=>time,
    discover:async phase=>{calls.push(`discover:${phase.key}`);time=20;return 'discovery completed';},
    scan:()=>{throw Error('scan after deadline');},defer:async phase=>{calls.push(`defer:${phase.key}`);time=1;}});
  assert.deepEqual(calls,['discover:yahoo','defer:yahoo','defer:other','defer:rakuma']);
  assert.equal(results[0].discovery,'discovery completed');
  assert.ok(results.every(value=>value.status==='deferred'));
});

test('deadline after Yahoo scan defers later phases; onPhase delay cannot start late discovery',async()=>{
  let time=10;const calls=[];
  await runAccountScanPhases(fixture(),{deadline:20,now:()=>time,discover:async phase=>calls.push(`discover:${phase.key}`),
    scan:async phase=>{calls.push(`scan:${phase.key}`);time=20;},defer:async phase=>calls.push(`defer:${phase.key}`)});
  assert.deepEqual(calls,['discover:yahoo','scan:yahoo','defer:other','defer:rakuma']);
  time=10;
  await runAccountScanPhases(fixture(),{deadline:20,now:()=>time,onPhase:async event=>{if(event.event==='start')time=20;},
    discover:()=>{throw Error('late discovery');},scan:()=>{throw Error('late scan');},defer:noop});
});

for(const stage of ['discover','scan'])test(`${stage} rejection stops later phases after the caller worker pool settles`,async()=>{
  const calls=[],failure=Error('worker failure');let remainingSettled=false;
  const failing=async phase=>{
    calls.push(`${stage}:${phase.key}`);
    return mapLimit([0,1],2,async value=>{if(value===0)throw failure;await tick();remainingSettled=true;});
  };
  await assert.rejects(runAccountScanPhases(fixture(),{deadline:100,now:()=>10,
    discover:stage==='discover'?failing:async phase=>calls.push(`discover:${phase.key}`),
    scan:stage==='scan'?failing:()=>{throw Error('scan after failed discovery');},defer:noop}),error=>error===failure);
  assert.equal(remainingSettled,true);
  assert.deepEqual(calls,stage==='discover'?['discover:yahoo']:['discover:yahoo','scan:yahoo']);
});

test('pre-aborted signal performs no phase callbacks',async()=>{
  const controller=new AbortController();controller.abort();
  const unexpected=()=>{throw Error('unexpected callback');};
  await assert.rejects(runAccountScanPhases(fixture(),{deadline:100,now:()=>10,signal:controller.signal,
    discover:unexpected,scan:unexpected,defer:unexpected,onPhase:unexpected}),{name:'AbortError'});
});

for(const stage of ['discover','scan'])test(`cancellation during ${stage} waits for its callback and prevents subsequent work`,async()=>{
  const controller=new AbortController(),calls=[];let settled=false;
  const cancel=async(phase,bounds)=>{assert.equal(bounds.signal,controller.signal);calls.push(`${stage}:${phase.key}`);
    controller.abort();await tick();settled=true;};
  await assert.rejects(runAccountScanPhases(fixture(),{deadline:100,now:()=>10,signal:controller.signal,
    discover:stage==='discover'?cancel:async phase=>calls.push(`discover:${phase.key}`),
    scan:stage==='scan'?cancel:()=>{throw Error('scan after cancellation');},defer:()=>{throw Error('defer after cancellation');}}),{name:'AbortError'});
  assert.equal(settled,true);
  assert.deepEqual(calls,stage==='discover'?['discover:yahoo']:['discover:yahoo','scan:yahoo']);
});

test('a failed defer does not begin another phase',async()=>{
  const calls=[];
  await assert.rejects(runAccountScanPhases(fixture(),{deadline:10,now:()=>10,discover:noop,scan:noop,
    defer:async phase=>{calls.push(phase.key);await tick();throw Error('defer failed');}}),/defer failed/);
  assert.deepEqual(calls,['yahoo']);
});

test('deadline observed after discovery remains expired and cancellation during defer stops later phases',async()=>{
  let time=10;
  await runAccountScanPhases(fixture(),{deadline:20,now:()=>time,discover:async()=>{time=20;},
    onPhase:event=>{if(event.event==='discovered')time=1;},scan:()=>{throw Error('expired discovery cannot scan');},defer:noop});
  const controller=new AbortController(),calls=[];
  await assert.rejects(runAccountScanPhases(fixture(),{deadline:10,now:()=>10,signal:controller.signal,
    discover:noop,scan:noop,defer:async phase=>{calls.push(phase.key);controller.abort();await tick();}}),{name:'AbortError'});
  assert.deepEqual(calls,['yahoo']);
});

test('empty input does no work and invalid deadline/clock fail closed',async()=>{
  const unexpected=()=>{throw Error('unexpected callback');};
  assert.deepEqual(await runAccountScanPhases([],{deadline:100,discover:unexpected,scan:unexpected,defer:unexpected}),[]);
  await assert.rejects(runAccountScanPhases(fixture(),{deadline:NaN,discover:noop,scan:noop,defer:noop}),/deadline/);
  await assert.rejects(runAccountScanPhases(fixture(),{deadline:100,now:()=>NaN,discover:noop,scan:noop,defer:noop}),/clock/);
});
