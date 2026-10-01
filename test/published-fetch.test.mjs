import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchPublishedBytes } from '../scripts/lib/published-fetch.mjs';

const quiet={wait:async()=>{},warn:()=>{}};
test('published restore recovers a discovery HTTP 503 after the cost baseline was already downloaded',async()=>{
 const calls=[],delays=[],warnings=[];let failures=0;
 const opts={...quiet,wait:async ms=>delays.push(ms),warn:m=>warnings.push(m),fetchImpl:async(url,options)=>{
   calls.push(url);assert.equal(options.headers['cache-control'],'no-cache');
   if(url.endsWith('discovery.json.enc')&&failures++<1)return new Response('unavailable',{status:503});
   return new Response(url.endsWith('state.json.enc')?'cost baseline':'discovery baseline');
 }};
 assert.equal((await fetchPublishedBytes('https://pages.test/state.json.enc',opts)).toString(),'cost baseline');
 assert.equal((await fetchPublishedBytes('https://pages.test/discovery.json.enc',opts)).toString(),'discovery baseline');
 assert.equal(calls.length,3);assert.deepEqual(delays,[1000]);assert.equal(warnings.length,1);
});
test('repeated 503 fails closed after bounded retries and never returns an empty baseline',async()=>{
 let calls=0;const delays=[];
 await assert.rejects(fetchPublishedBytes('https://pages.test/state.json.enc',{...quiet,label:'state.json.enc',wait:async ms=>delays.push(ms),fetchImpl:async()=>{calls++;return new Response('error',{status:503})}}),/state\.json\.enc.*3 次尝试.*HTTP 503.*停止发布/);
 assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);
});
test('missing optional published files return null; authentication and other permanent failures abort immediately',async()=>{
 for(const status of [404,400,401,403,410]){
   let calls=0;const task=fetchPublishedBytes('https://pages.test/file',{...quiet,fetchImpl:async()=>{calls++;return new Response('status',{status})}});
   if(status===404)assert.equal(await task,null);else await assert.rejects(task,new RegExp('HTTP '+status));
   assert.equal(calls,1);
 }
});
test('Retry-After is respected and an excessive server delay stops this restore without premature requests',async()=>{
 for(const value of ['4',new Date(Date.now()+5000).toUTCString(),'120']){
   let calls=0;const delays=[];
   const task=fetchPublishedBytes('https://pages.test/file',{...quiet,wait:async ms=>delays.push(ms),fetchImpl:async()=>++calls===1?new Response('busy',{status:429,headers:{'retry-after':value}}):new Response('ok')});
   if(value==='120'){await assert.rejects(task,/HTTP 429/);assert.equal(calls,1);assert.deepEqual(delays,[])}
   else{assert.equal((await task).toString(),'ok');assert.equal(calls,2);assert.ok(delays[0]>=3000&&delays[0]<=5000)}
 }
});
test('network disconnect and truncated bodies retry the whole file without concatenating partial data',async()=>{
 let calls=0;
 const bytes=await fetchPublishedBytes('https://pages.test/file',{...quiet,fetchImpl:async()=>{
   calls++;if(calls===1)throw new TypeError('fetch failed');
   if(calls===2)return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.error(new TypeError('terminated'))}}));
   return new Response(new Uint8Array([3,4,5]));
 }});
 assert.equal(calls,3);assert.deepEqual([...bytes],[3,4,5]);
});
test('download timeout also aborts a stalled response body and can recover on the next request',async()=>{
 let calls=0;
 const server=createServer((request,response)=>{
   calls++;response.writeHead(200);
   if(calls===1){response.write('partial');return}
   response.end('complete');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
   const result=await fetchPublishedBytes(`http://127.0.0.1:${server.address().port}/file`,{...quiet,timeoutMs:150});
   assert.equal(result.toString(),'complete');assert.equal(calls,2);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
test('successful bytes pass unchanged to existing integrity verification without a success retry',async()=>{
 const bytes=new Uint8Array([0,255,16,240]);let calls=0;
 assert.deepEqual([...await fetchPublishedBytes('https://pages.test/file',{...quiet,fetchImpl:async()=>{calls++;return new Response(bytes)}})],[...bytes]);
 assert.equal(calls,1);
});
