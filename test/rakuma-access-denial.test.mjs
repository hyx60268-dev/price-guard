import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedComparison,comparisonIncomplete} from '../scripts/lib/pricing-coverage.mjs';
import {MATCHING_RULES_VERSION} from '../scripts/lib/rules.mjs';
const freshModule=()=>import('../scripts/lib/rakuma.mjs?denial-test='+crypto.randomUUID());
for(const status of [401,403,429])test(`Rakuma HTTP${status} holds later and queued reads, preserving status without fallback`,async()=>{
 const {fetchRakumaHtml,rakumaAccessDiagnostic}=await freshModule();let reads=0,readerReads=0;
 const dependencies={fetchImpl:async()=>{reads++;return new Response('private denial body',{status,headers:{'retry-after':'180'}})},readerFetchImpl:async()=>{readerReads++;assert.fail('forbidden alternate route')}};
 const results=await Promise.allSettled([fetchRakumaHtml('https://fril.jp/shop/test',{},dependencies),fetchRakumaHtml('https://item.fril.jp/aa',{},dependencies)]);
 assert.ok(results.every(x=>x.status==='rejected'&&x.reason.code==='RAKUMA_SOURCE_ACCESS_DENIED'&&x.reason.httpStatus===status));
 await assert.rejects(fetchRakumaHtml('https://fril.jp/shop/test/page/2',{},dependencies),/access denied/);
 assert.equal(reads,1);assert.equal(readerReads,0);assert.equal(rakumaAccessDiagnostic().retryAfter,'180');
 assert.doesNotMatch(JSON.stringify(rakumaAccessDiagnostic()),/private|fril\.jp/);
});
test('Rakuma Retry-After provenance is canonicalized without retaining arbitrary header comments',async()=>{
 const {fetchRakumaHtml,rakumaAccessDiagnostic}=await freshModule();
 await assert.rejects(fetchRakumaHtml('https://fril.jp/shop/test',{}, {fetchImpl:async()=>new Response('',{status:429,headers:{'retry-after':'Wed, 21 Oct 2015 07:28:00 GMT (private comment)'}})}),/HTTP 429/);
 assert.equal(rakumaAccessDiagnostic().retryAfter,'Wed, 21 Oct 2015 07:28:00 GMT');
});
test('permitted direct HTML remains readable and transport failures never switch readers',async()=>{
 const {fetchRakumaHtml}=await freshModule();const html='<html>'+'public body '.repeat(1000)+'</html>';
 assert.equal(await fetchRakumaHtml('https://fril.jp/shop/test',{}, {fetchImpl:async()=>new Response(html)}),html);
 let readerReads=0;
 await assert.rejects(fetchRakumaHtml('https://item.fril.jp/aa',{}, {fetchImpl:async()=>{throw new Error('network failed')},readerFetchImpl:async()=>{readerReads++;}},1),/network failed/);
 assert.equal(readerReads,0);
});
test('denied refresh retains prior accepted observation time and cannot become completed current coverage',()=>{
 const checkedAt='2026-10-15T00:00:00.000Z';
 const prior={rulesVersion:MATCHING_RULES_VERSION,status:'ok',checkedAt,candidates:[{id:'known',price:1000}]};
 const result=cachedComparison(prior,'request_error');
 assert.equal(result.checkedAt,checkedAt);assert.equal(result.status,'cached');assert.equal(result.cacheReason,'request_error');
 assert.equal(comparisonIncomplete(result),true);assert.deepEqual(result.candidates,prior.candidates);
});
for(const firstDetailDenied of [true,false])test(`candidate access denial propagates before fresh publication (${firstDetailDenied?'first detail':'after verified detail'})`,async()=>{
 const {rakumaCompare}=await freshModule();
 const title='中国限定 スターバックス レオパード グリッター ブルー 370ml',description='新品 未使用 ブルー 370ml 1本';
 const denial=Object.assign(new Error('Rakuma access denied'),{code:'RAKUMA_SOURCE_ACCESS_DENIED',httpStatus:403});
 const card=(id,price)=>`<a href="https://item.fril.jp/${id}" class="link_search_image" data-rat-itemid="21821488/855341843" data-rat-item_name="${title}" data-rat-igenre="123" data-rat-price="${price}"><img data-original="https://img.fril.jp/img/1/m/1.jpg"></a>`;
 const detail=`<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:title,description,image:'https://img.fril.jp/img/1/l/1.jpg',offers:{price:7800,availability:'https://schema.org/InStock'}})}</script><table><tr><th>配送料の負担</th><td>送料込</td></tr></table>`;
 const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
 let detailAttempts=0;
 const prior={rulesVersion:MATCHING_RULES_VERSION,status:'ok',checkedAt:'2026-10-15T00:00:00.000Z',candidates:[{id:'prior',price:8000}]};let retained;
 try{
  await rakumaCompare({id:'own',accountId:'test',title,ownPrice:9000,image:'own-image',yahoo:{ownDescription:description,ownCategory:'雑貨',ownImages:['own-image']}},{maxRakumaDetailChecks:4},{fetchHtml:async url=>{
   if(url.startsWith('https://fril.jp/s?'))return card('aa',7800)+card('bb',10000);
   detailAttempts++;if(!firstDetailDenied&&url.endsWith('/aa'))return detail;throw denial;
  },imageFingerprints:async()=>fp});assert.fail('a denied detail cannot produce a fresh accepted comparison');
 }catch(error){assert.equal(error,denial);retained=cachedComparison(prior,'request_error')}
 assert.equal(detailAttempts,firstDetailDenied?1:2);assert.equal(retained.checkedAt,prior.checkedAt);assert.deepEqual(retained.candidates,prior.candidates);assert.equal(comparisonIncomplete(retained),true);
});
