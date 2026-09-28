import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { selectMerchantProducts,merchantCardsMarkup } from '../public/merchant-view.js';
const now=Date.parse('2026-09-28T01:00:00Z'),base={sourceTitle:'中国限定 cup',sourcePlatform:'yahoo',eventAt:new Date(now-3600000).toISOString(),sourcePriceJPY:5000};
test('group remains one card when filtering sold or listed and copy is visible without expanding',()=>{
 const p={...base,event:'listed',listingCount:2,observations:[{...base,event:'listed'},{...base,event:'sold'}]};
 assert.equal(selectMerchantProducts([p],{now,event:'sold'})[0].event,'sold');
 assert.equal(selectMerchantProducts([p],{now,event:'listed'}).length,1);
 const dom=new JSDOM(merchantCardsMarkup([p]));
 try{assert.equal(dom.window.document.querySelector('details'),null);assert.ok(dom.window.document.querySelector('.merchant-text textarea'));assert.match(dom.window.document.body.textContent,/已合并 2/)}finally{dom.window.close()}
});
test('today/month sold views exclude undated sales, but retain a separate unknown-date view',()=>{
 const products=[{...base,event:'undated_sold'},{...base,event:'sold'},{...base,event:'observed_listing'}];
 assert.equal(selectMerchantProducts(products,{now,period:'today'}).length,2);
 assert.equal(selectMerchantProducts(products,{now,event:'sold'}).length,1);
 assert.equal(selectMerchantProducts(products,{now,event:'undated'}).length,1);
});
test('monitor keeps product text inert and identifies actual Xianyu detail images',()=>{
 const dom=new JSDOM(merchantCardsMarkup([{...base,event:'sold',sourceTitle:'<script>bad()</script>',xianyuImages:[{url:'https://image.test/a.jpg',sourceUrl:'https://www.goofish.com/item?id=123'}],sourceUrl:'javascript:bad()',proposedDescription:'<img onerror="bad()">'}]));
 try{assert.equal(dom.window.document.querySelectorAll('script').length,0);assert.match(dom.window.document.body.textContent,/闲鱼同款详情图片/);assert.equal(dom.window.document.querySelector('img').parentElement.href,'https://www.goofish.com/item?id=123');assert.equal(dom.window.document.querySelector('textarea').value.includes('<img onerror='),true)}finally{dom.window.close()}
});
