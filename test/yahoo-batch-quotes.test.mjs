import test from 'node:test';
import assert from 'node:assert/strict';
import { readYahooSellerQuotes,readYahooSellerBatch } from '../scripts/lib/yahoo-batch-quotes.mjs';
const raw=(id)=>({id,title:'white box 1 item',sellerId:'p123',seller:{id:'p123'},price:9000,thumbnailImageUrl:'https://fixture.test/white.jpg',condition:'new',itemStatus:'OPEN'});
test('one public page batches 100 quote observations without claiming identity, shipping or automatic costs',async()=>{
 let calls=0,clock=1000;
 const snapshots=await readYahooSellerBatch(['p123','p123'],{yahooRequestIntervalMs:5000},{now:()=>clock,fetchYahooResult:async(url,settings)=>{
  calls++;assert.equal(settings.yahooRequestIntervalMs,5000);assert.equal(url,'https://paypayfleamarket.yahoo.co.jp/user/p123?page=1');clock+=1200;
  return {offset:0,totalResultsAvailable:100,items:Array.from({length:100},(_,i)=>raw('z'+i))};
 }});
 assert.equal(calls,1);assert.equal(snapshots.length,1);assert.equal(snapshots[0].quotes.length,100);assert.equal(snapshots[0].complete,true);
 const quote=snapshots[0].quotes[0];assert.equal(quote.quoteObservedAt,new Date(2200).toISOString());assert.equal(quote.itemPriceJPY,9000);
 assert.equal(quote.identityVerified,false);assert.equal(quote.shippingKnown,false);assert.equal(quote.canReprice,false);assert.equal(quote.checkedAt,undefined);
});
test('all pages are required and duplicate, wrong seller or changing page totals cannot claim full observation',async()=>{
 let calls=0;
 const result=await readYahooSellerQuotes('p123',{}, {fetchYahooResult:async()=>++calls===1?
  {offset:0,totalResultsAvailable:101,items:Array.from({length:100},(_,i)=>raw('z'+i))}:
  {offset:100,totalResultsAvailable:101,items:[{...raw('last'),itemStatus:'SOLD'}]}});
 assert.equal(calls,2);assert.equal(result.complete,true);assert.equal(result.quotes.at(-1).availability,'sold');
 for(const mutate of [item=>({...item,sellerId:'p456'}),item=>({...item,seller:{id:'p456'}}),item=>({...item,price:0}),item=>({...item,itemStatus:'unknown'})]){
  const invalid=await readYahooSellerQuotes('p123',{}, {fetchYahooResult:async()=>({offset:0,totalResultsAvailable:1,items:[mutate(raw('z1'))]})});
  assert.equal(invalid.complete,false);assert.equal(invalid.quotes.length,0);
 }
 const duplicate=await readYahooSellerQuotes('p123',{}, {fetchYahooResult:async()=>({offset:0,totalResultsAvailable:2,items:[raw('z1'),raw('z1')]})});
 assert.equal(duplicate.complete,false);
});
test('invalid seller, failed requests and absent items do not synthesize prices or retry via another source',async()=>{
 await assert.rejects(readYahooSellerQuotes('https://untrusted.test'),/Invalid/);
 let calls=0;await assert.rejects(readYahooSellerQuotes('p123',{}, {fetchYahooResult:async()=>{calls++;throw Error('HTTP 403')}}),/403/);assert.equal(calls,1);
 const empty=await readYahooSellerQuotes('p123',{}, {fetchYahooResult:async()=>({offset:0,totalResultsAvailable:0,items:[]})});
 assert.equal(empty.complete,true);assert.deepEqual(empty.quotes,[]);
});
