import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnSourceLoader} from '../scripts/lib/own-source.mjs';
import {fetchRakumaItem,rakumaCompare} from '../scripts/lib/rakuma.mjs';

const title='中国限定 スターバックス レオパード グリッター ブルー 370ml',description='新品 未使用 ブルー 370ml 1本';
const id='aabbcc',url=`https://item.fril.jp/${id}`;
const card=`<a href="${url}" class="link_search_image" data-rat-itemid="21821488/855341843" data-rat-item_name="${title}" data-rat-igenre="123" data-rat-price="7800"><img data-original="https://img.fril.jp/img/1/m/1.jpg"></a>`;
const detail=(text=description)=>`<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:title,description:text,image:'https://img.fril.jp/img/1/l/1.jpg',offers:{price:7800,availability:'https://schema.org/InStock'}})}</script><table><tr><th>配送料の負担</th><td>送料込</td></tr></table>`;
const item=accountId=>({id:'own-'+accountId,accountId,title,ownPrice:9000,image:'own-image',yahoo:{ownDescription:description,ownCategory:'雑貨',ownImages:['own-image']}});
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};

test('two accounts reuse raw Rakuma pages but retain independent matches, corrections, and source time',async()=>{
 let reads=0,clock=1000;
 const loader=createOwnSourceLoader({now:()=>clock,fetchRakumaHtml:async target=>{reads++;await Promise.resolve();return target===url?detail():card}});
 const dependencies={fetchPage:loader.rakumaPage,imageFingerprints:async()=>fp};
 const [a,b]=await Promise.all([rakumaCompare(item('a'),{},dependencies),rakumaCompare(item('b'),{},dependencies)]);
 assert.equal(reads,2);assert.equal(a.competitorCount,1);assert.equal(b.competitorCount,1);assert.equal(a.audit.accountId,'a');assert.equal(b.audit.accountId,'b');
 a.candidates[0].price=1;assert.equal(b.candidates[0].price,7800);
 clock=9000;const record={accountId:'a',itemId:'own-a',platform:'rakuma',candidateId:id,updatedAt:new Date().toISOString(),deleted:false};
 const corrected=await rakumaCompare(item('a'),{matchCorrections:{one:record}},dependencies);
 assert.equal(corrected.competitorCount,0);assert.ok(corrected.rejected.some(row=>row.reason==='saved_user_correction'));
 const reused=await rakumaCompare(item('b'),{},dependencies);
 assert.equal(reads,2);assert.equal(reused.candidates[0].price,7800);assert.equal(reused.checkedAt,new Date(1000).toISOString());assert.equal(reused.candidates[0].checkedAt,reused.checkedAt);
 assert.equal(loader.stats.rakumaPageRequests,2);assert.equal(loader.stats.rakumaPageReuses,5);
});

test('empty search and rejected descriptions avoid own-image reads without bypassing genuine visual checks',async()=>{
 for(const [search,body] of [['商品が見つかりません',detail()],[card,detail('新品 未使用 ブラウン 370ml 1本')]]){
  let images=0;
  const result=await rakumaCompare(item('a'),{},{fetchHtml:async target=>target===url?body:search,imageFingerprints:async()=>{images++;return fp}});
  assert.equal(images,0);assert.equal(result.competitorCount,0);
 }
 let images=0;const visualTitle='海外限定Hello Kitty x TBH ネックピロー';
 const result=await rakumaCompare({...item('a'),title:visualTitle},{},{fetchHtml:async target=>(target===url?detail():card).replaceAll(title,visualTitle),imageFingerprints:async()=>{images++;return null}});
 assert.ok(images>0);assert.equal(result.competitorCount,0);assert.ok(result.rejected.some(row=>row.reason==='primary_variant_unconfirmed'||row.reason==='collectible_variant_image_unconfirmed'));
});

test('shared Rakuma HTML cannot invent an observation from missing or future timestamps',async()=>{
 for(const observedAt of ['',null,'invalid',new Date(Date.now()+3600000).toISOString()]){
  const dependencies={fetchPage:async()=>({html:detail(),observedAt})};
  await assert.rejects(fetchRakumaItem({url}, {},dependencies),/observation unavailable/);
  await assert.rejects(rakumaCompare(item('a'),{},dependencies),/observation unavailable/);
 }
 const observedAt='2026-10-15T00:00:00.000Z';
 const actual=await fetchRakumaItem({url},{},{fetchPage:async()=>({html:detail(),observedAt})});
 assert.equal(actual.sourceObservedAt,observedAt);assert.equal(actual.price,7800);
});
