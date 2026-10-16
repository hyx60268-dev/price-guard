import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {createRakumaHintSession} from '../scripts/lib/rakuma-discovery-hints.mjs';
import {extractRakumaDetail} from '../scripts/lib/rakuma.mjs';
import {encrypt,decrypt} from '../scripts/lib/crypto.mjs';
import {PRICING_RULES_VERSION,pricingDecision} from '../public/pricing-policy.js';

for(const denied of [false,true])test(`real legacy scan preserves URL-only state through encrypted publication (${denied?'detail source denied':'empty search and current detail'})`,async()=>{
 const source=fileURLToPath(new URL('../',import.meta.url)),root=await fs.mkdtemp(path.join(os.tmpdir(),'rakuma-hint-scan-'));
 const envKeys=['PRICE_SCAN_ENGINE','FULL_PRICE_AUDIT','FORCE_FULL_SCAN','PRICE_AUDIT_ITEM_IDS','DASHBOARD_PASSWORD','PORTAL_USERS_JSON'];
 const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]])),originalFetch=globalThis.fetch,requests=[];
 const password='synthetic-scan-password',ownId='a'.repeat(32),id='b'.repeat(32),url=id=>`https://item.fril.jp/${id}`;
 const title='中国限定 スターバックス レオパード グリッター ブルー 370ml',description='新品 未使用 ブルー 370ml 1本',image='https://img.fril.jp/img/1/l/1.jpg';
 const now=Date.now(),old=new Date(now-3600000).toISOString(),ownAt=new Date(now-2*3600000).toISOString();
 const detail=(seller,price)=>`<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:title,description,image,offers:{price,priceCurrency:'JPY',availability:'https://schema.org/InStock'}})}</script><script>window.x={"seller_user_id":"${seller}"}</script><table><tr><th>配送料の負担</th><td>送料込</td></tr></table>`;
 const item={accountId:'shop',id:ownId,platform:'rakuma',comparisonMode:'same_platform',title,image,url:url(ownId),ownPrice:9000,sellerId:'100',
  sourceDetail:{...extractRakumaDetail(detail('100',9000),url(ownId)),listingId:ownId,sourceTargetVerified:true,sourceObservedAt:ownAt,checkedAt:ownAt}};
 const seed=createRakumaHintSession(item,{}, {now:()=>now-3600000,onDiscovery:store=>{item.competitorDiscovery={rakuma:store}}});
 seed.observed({id,url:url(id),sellerId:'200'},old);
 item.rakuma={status:'ok',rulesVersion:PRICING_RULES_VERSION,checkedAt:old,searchComplete:true,
  audit:{accountId:'shop',ownItemId:ownId,discoveryBinding:seed.binding()},lowestPrice:7800,lowestUrl:url(id),
  candidates:[{id,url:url(id),price:7800,sellerId:'200',title,image,checkedAt:old,matchMethod:'detail_type_quantity_equivalent_text'}]};
 const profile=`<div class="item-list"><a href="${url(ownId)}" class="link_shop_image" data-rat-itemid="100/123" data-rat-item_name="${title}" data-rat-price="9000"><img data-original="${image}"></a></div>`;
 const previous={items:[item],accounts:[{id:'shop',platform:'rakuma'}],manualCosts:{},matchCorrections:{},checkedAt:old};
 try{
  await fs.cp(path.join(source,'scripts'),path.join(root,'scripts'),{recursive:true});
  await fs.cp(path.join(source,'public'),path.join(root,'public'),{recursive:true});
  for(const name of ['state','config'])await fs.mkdir(path.join(root,name));
  await fs.writeFile(path.join(root,'package.json'),' {"type":"module"}');
  await fs.symlink(await fs.realpath(path.join(source,'node_modules')),path.join(root,'node_modules'),'dir');
  // Cost workers are independent and out of scope. Stub them only in the
  // disposable fixture; the real scan, collector, gates and publication run.
  await fs.writeFile(path.join(root,'scripts/lib/xianyu-session.mjs'),`export async function loadXianyuSession(){return {file:null,access:()=>({allowed:false,reason:'fixture_hold',retryAt:${now+3600000}})}}`);
  await fs.writeFile(path.join(root,'scripts/lib/procurement-runner.mjs'),'export async function runPublicProcurement(){return new Map()}');
  await fs.writeFile(path.join(root,'config/accounts.json'),JSON.stringify({accounts:[{id:'shop',name:'Synthetic shop',platform:'rakuma',profileUrl:'https://fril.jp/shop/fixture'}]}));
  await fs.writeFile(path.join(root,'config/settings.json'),JSON.stringify({comparisonMode:'same_platform',scanBudgetMinutes:1,exchangeRate:20,maxRakumaDetailChecks:6,rakumaRequestIntervalMs:800}));
  await fs.writeFile(path.join(root,'state/latest.json.enc'),encrypt(Buffer.from(JSON.stringify(previous)),password));
  for(const key of envKeys)process.env[key]='';process.env.DASHBOARD_PASSWORD=password;process.env.PRICE_SCAN_ENGINE='legacy';
  const pixels=await sharp({create:{width:64,height:64,channels:3,background:{r:100,g:100,b:100}}}).png().toBuffer();
  globalThis.fetch=async requested=>{
   const target=String(requested);requests.push(target);let response;
   if(target===image)response=new Response(pixels,{status:200,headers:{'content-type':'image/png'}});
   else if(target==='https://fril.jp/shop/fixture')response=new Response(profile+' '.repeat(9000));
   else if(target.startsWith('https://fril.jp/s?'))response=new Response('商品が見つかりません'+' '.repeat(9000));
   else if(target===url(id))response=denied?new Response('denied',{status:403}):new Response(detail('200',8500)+' '.repeat(9000));
   else throw new Error('Unexpected fixture URL: '+target);
   Object.defineProperty(response,'url',{value:target});return response;
  };
  await import(pathToFileURL(path.join(root,'scripts/scan.mjs')));
  for(const file of ['state/latest.json.enc','public/data/state.json.enc','public/data/latest.json.enc']){
   const snapshot=JSON.parse(decrypt(await fs.readFile(path.join(root,file)),password).toString('utf8')),row=snapshot.items[0],hint=row.competitorDiscovery.rakuma.links[0];
   assert.equal(snapshot.scanMeta.pricingEngine,'legacy');assert.equal(hint.url,url(id));assert.equal(hint.identityObservedAt,ownAt);
   assert.ok(Date.parse(hint.lastAttemptAt)>=now);assert.equal(hint.retiredAt,undefined);
   if(denied){assert.equal(snapshot.rakumaRequestAccess.httpStatus,403);assert.equal(snapshot.rakumaRequestAccess.holdReason,'internal_fallback');assert.equal(snapshot.rakumaRequestAccess.retryAfter,null);assert.ok(Date.parse(snapshot.rakumaRequestAccess.observedAt)>=now);assert.equal(snapshot.rakumaRequestAccess.retryAt,Date.parse(snapshot.rakumaRequestAccess.observedAt)+3600000);assert.equal(hint.lastVerifiedAt,old);assert.equal(row.rakuma.checkedAt,old);assert.equal(row.rakuma.cacheReason,'request_error');assert.equal(pricingDecision(row).canRecommend,false);}
   else{assert.equal(row.rakuma.candidates[0].price,8500);assert.ok(Date.parse(row.rakuma.candidates[0].checkedAt)>=now);assert.equal(hint.lastVerifiedAt,row.rakuma.candidates[0].checkedAt);}
  }
  assert.equal(requests.filter(value=>value===url(id)).length,1);assert.equal(requests.includes(url(ownId)),false,'cached own identity must not trigger an extra request');
 }finally{
  globalThis.fetch=originalFetch;
  for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
  await fs.rm(root,{recursive:true,force:true});
 }
});
