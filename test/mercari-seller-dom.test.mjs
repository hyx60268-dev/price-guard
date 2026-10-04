import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readMercariDetail,mercariDetail } from '../scripts/lib/mercari-page.mjs';
import { merchantDetail } from '../scripts/lib/merchant-sources.mjs';

const url='https://jp.mercari.com/item/m57886391722';
const seller='/user/profile/378316315';
// The actual 2026-10-04 cloud failures logged no observed seller. These are
// structural regressions, not a claim that this HTML was captured in that job.
const product=body=>'<main><article><h1>みそ様 リクエスト 2件 まとめ商品</h1><div data-testid="price">¥10,000</div><button>購入手続きへ</button><h2>商品の説明</h2><div data-testid="description">リクエストありがとうございます。こちらはまとめ買い商品です。</div><h3>配送料の負担</h3><div>送料込み(出品者負担)</div>'+body+'</article></main>';
const profile=(id,name='みこ')=>'<a href="'+id+'"><h3>'+name+'</h3></a>';
function read(body){const dom=new JSDOM(product(body),{url});try{return readMercariDetail(dom.window.document)}finally{dom.window.close()}}

test('explicit target seller wins over earlier comment authors and later recommended profiles',()=>{
 const detail=read('<h2>コメント</h2>'+profile('/user/profile/123','コメント者')+'<section><h2>出品者</h2>'+profile(seller)+'</section><h2>この出品者の商品</h2>'+profile('/user/profile/999','別出品者'));
 assert.equal(detail.sellerId,seller);assert.equal(detail.sellerName,'みこ');
 assert.deepEqual(detail.sellerDiagnostic,{status:'confirmed',scope:'seller_section',candidateCount:1,candidateIds:[seller],articleProfileCount:3,observedProfileIds:['/user/profile/123',seller,'/user/profile/999']});
});

test('observed m57886391722 seller anchor stays visible when its duplicate accessibility child is hidden',()=>{
 // Parent agent manually inspected this target DOM on 2026-10-04. This proves
 // the local structure only; the earlier cloud job did not log its seller DOM.
 const body='<h2>出品者</h2><a data-location="item_details:seller_info" href="'+seller+'" aria-label="みこ,1842件の評価"><div data-testid="seller-link" aria-hidden="true"><h3>みこ</h3></div></a>';
 const dom=new JSDOM(product(body).replace('リクエスト 2件 まとめ商品','リクエスト 2点 まとめ商品'),{url});
 try{const detail=readMercariDetail(dom.window.document);assert.equal(detail.title,'みそ様 リクエスト 2点 まとめ商品');assert.equal(detail.sellerId,seller);assert.equal(detail.sellerName,'みこ');assert.equal(detail.sellerDiagnostic.status,'confirmed');assert.equal(detail.sellerDiagnostic.scope,'seller_section');assert.equal(detail.sellerDiagnostic.articleProfileCount,1)}finally{dom.window.close()}
});

test('ambiguous seller-section identities do not choose the first matching-looking profile',()=>{
 const detail=read('<h2>出品者</h2>'+profile(seller)+profile('/user/profile/123'));
 assert.equal(detail.sellerId,'');assert.equal(detail.sellerDiagnostic.status,'ambiguous');
 assert.equal(detail.sellerDiagnostic.candidateCount,2);
 assert.equal(read('<h2>コメント</h2>'+profile(seller)).sellerId,'','a commenter alone is not the seller');
 const waiting=read('<h2>コメント</h2>'+profile('/user/profile/123')+'<h2>出品者</h2><div>読み込み中</div>');
 assert.equal(waiting.sellerId,'');assert.equal(waiting.sellerDiagnostic.scope,'seller_section');
});

test('profile URL normalization preserves origin and cannot let hidden or description links supply seller evidence',()=>{
 assert.equal(read('<h2>出品者</h2>'+profile('https://jp.mercari.com'+seller+'/?source=item')).sellerId,seller);
 assert.equal(read('<h2>ショップ情報</h2>'+profile('/shops/profile/store_42')).sellerId,'/shops/profile/store_42');
 const hidden='<div hidden>'+profile('/user/profile/123')+'</div><div style="display:none">'+profile('/user/profile/456')+'</div>';
 assert.equal(read('<h2>出品者</h2>'+hidden+profile(seller)).sellerId,seller);
 for(const href of ['https://evil.test'+seller,'//evil.test'+seller,'/user/profile/378316315/items','/user/profile/378316315wrong'])assert.equal(read('<h2>出品者</h2>'+profile(href)).sellerId,'',href);
 const dom=new JSDOM(product(''),{url});try{dom.window.document.querySelector('[data-testid="description"]').innerHTML+=profile(seller);assert.equal(readMercariDetail(dom.window.document).sellerId,'')}finally{dom.window.close()}
 assert.equal(read(profile(seller)).sellerId,seller,'a legacy target with one unambiguous profile remains readable');
 assert.equal(read(profile(seller)+profile('/user/profile/123')).sellerId,'');
});

function pageFor(dom,{lateSeller,timeout=false}={}){
 const observed={waits:[],readyBefore:null,readyAfter:null};
 return {observed,goto:async requested=>assert.equal(requested,url),locator:selector=>({waitFor:async options=>{assert.equal(selector,'main article h1');assert.equal(options.timeout,30000)}}),
  waitForFunction:async(source,args,options)=>{
   observed.waits.push(options.timeout);const ready=new Function('document','return ('+source+')()');
   observed.readyBefore=ready(dom.window.document);
   if(lateSeller)dom.window.document.querySelector('article').insertAdjacentHTML('beforeend',lateSeller);
   observed.readyAfter=ready(dom.window.document);if(timeout)throw Error('simulated timeout');
  },evaluate:async()=>readMercariDetail(dom.window.document)};
}

test('detail waits for delayed seller in the original single 30-second readiness window',async()=>{
 const dom=new JSDOM(product('<h2>出品者</h2>'),{url}),page=pageFor(dom,{lateSeller:profile(seller)});
 try{const detail=await mercariDetail(page,url);assert.equal(detail.sellerId,seller);assert.equal(page.observed.readyBefore,false);assert.equal(page.observed.readyAfter,true);assert.deepEqual(page.observed.waits,[30000])}finally{dom.window.close()}
});

test('timed-out or ambiguous seller never becomes a priced detail or an accepted bundle parent',async()=>{
 for(const body of ['', '<h2>出品者</h2>'+profile(seller)+profile('/user/profile/123')]){
  const dom=new JSDOM(product(body),{url}),page=pageFor(dom,{timeout:true});
  try{await assert.rejects(merchantDetail({platform:'mercari',id:'378316315'},{id:'m57886391722',url,status:'SOLD'},{page}),error=>/煤炉目标卖家尚未确认/.test(error.message)&&!error.message.includes('リクエスト')&&!error.message.includes('<'));assert.deepEqual(page.observed.waits,[30000])}finally{dom.window.close()}
 }
});

test('confirmed different seller still rejects with limited observed and expected profile IDs',async()=>{
 const dom=new JSDOM(product('<h2>出品者</h2>'+profile('/user/profile/123')),{url}),page=pageFor(dom);
 try{await assert.rejects(merchantDetail({platform:'mercari',id:'378316315'},{id:'m57886391722',url,status:'SOLD'},{page}),error=>/商品卖家与监控主页不一致/.test(error.message)&&error.message.includes('"observedSeller":"/user/profile/123"')&&error.message.includes('"expectedSeller":"'+seller+'"')&&!error.message.includes('リクエスト'))}finally{dom.window.close()}
});
