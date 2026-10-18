import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createOwnSourceLoader} from '../../scripts/lib/own-source.mjs';
import {createYahooScanPageObservation} from '../../scripts/lib/yahoo-scan-page-observation.mjs';
import {mapYahooPoolToTargets} from '../../scripts/lib/yahoo-page-observation-pool.mjs';
import {configureImageFingerprintCache,imageFingerprints,peekImageFingerprints} from '../../scripts/lib/image.mjs';
import {verifySharedYahooDetailPair} from '../../scripts/lib/yahoo-shared-detail-consumer.mjs';
import {buildOwnedOffers} from '../../public/owned-offers.js';
import {PRICING_RULES_VERSION} from '../../public/pricing-policy.js';
export const T=Date.parse('2026-10-18T06:00:00Z'),url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
export const title='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 特典付き';
export async function pipeline(t,{accountId='melon',candidateChange=()=>{},ownChange=()=>{},skipCandidate=false,skipImages=false,secondTarget=false,deferSecondTargetRead=false}={}){
 let time=T+1000,htmlReads=0,imageReads=0;
 t.mock.method(Date,'now',()=>time);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'shared-detail-actual-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const image=`https://images.example.invalid/${accountId}.png`;
 const item={id:`own-${accountId}`,accountId,platform:'yahoo',title,image,sellerId:`seller-${accountId}`,ownPrice:10000,itemStatus:'OPEN',url:url(`own-${accountId}`),
  yahoo:{rulesVersion:PRICING_RULES_VERSION,status:'incomplete',candidates:[],checkedAt:new Date(T-3600_000).toISOString(),searchCheckedAt:new Date(T-3600_001).toISOString()}};
 const accounts=['melon','boss','momoka'].map(id=>({id,platform:'yahoo',sellerId:`seller-${id}`,profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/seller-${id}`}));
 const own={id:item.id,title,price:10000,description:'新品 未使用 フィギュア1点 特典付き',status:'OPEN',images:[image],seller:{id:item.sellerId},categoryList:[{name:'フィギュア'}]};
 const candidate={id:'external-offer',title,price:8000,description:own.description,status:'OPEN',images:['https://images.example.invalid/external.png'],seller:{id:'external-seller'},categoryList:own.categoryList};
 ownChange(own);candidateChange(candidate);
 const card={id:candidate.id,title:candidate.title,price:candidate.price,sellerId:candidate.seller.id,image:candidate.images[0],url:url(candidate.id)};
 const profileCard={id:item.id,accountId,sellerId:item.sellerId,title:item.title,priceJPY:item.ownPrice,imageUrl:item.image,itemStatus:'OPEN',source:'current_profile_card',observedAt:T+1,
  profileUrl:accounts.find(a=>a.id===accountId).profileUrl,pageUrl:accounts.find(a=>a.id===accountId).profileUrl+'?page=1',pageNumber:1};
 const second=secondTarget?{...item,id:'other-own',accountId:'boss',sellerId:'seller-boss',image:'https://images.example.invalid/other-own.png',url:url('other-own')}:null;
 const secondProfile=second?{...profileCard,id:second.id,accountId:second.accountId,sellerId:second.sellerId,imageUrl:second.image,profileUrl:accounts[1].profileUrl,pageUrl:accounts[1].profileUrl+'?page=1'}:null;
 const contexts=accounts.map(account=>({account,activeItems:account.id===accountId?[item]:second&&account.id==='boss'?[second]:[],previousItems:[],profileStatus:'live',profileDiscovery:{profileObservation:{complete:true,enumerationComplete:true,ownershipConflictCount:0,fromCache:false,observedAt:T+1,cards:account.id===accountId?[profileCard]:second&&account.id==='boss'?[secondProfile]:[],membershipIds:account.id===accountId?[item.id]:second&&account.id==='boss'?[second.id]:[]}}}));
 const observer=createYahooScanPageObservation({startedAt:T,deadlineAt:T+12*60_000,accounts,contexts,now:()=>time});
 const imageBytes=await sharp({create:{width:64,height:64,channels:3,background:{r:80,g:120,b:160}}}).png().toBuffer();
 t.mock.method(globalThis,'fetch',async requested=>{
  if(String(requested).startsWith('https://images.example.invalid/')){imageReads++;return new Response(imageBytes,{headers:{'cache-control':'public,max-age=3600'}});}
  htmlReads++;const id=new URL(requested).pathname.split('/').pop(),detail=id===item.id?own:second&&id===second.id?{...own,id:second.id,seller:{id:second.sellerId},images:[second.image]}:candidate;
  const next={props:{initialState:{itemsState:{items:{item:detail}},recommendsState:{recommends:{recommends:{fleamarket_web_itempage:{recommendItems:{items:id===item.id?[{itemId:card.id,title:card.title,price:card.price,seller:{id:card.sellerId},image:{url:card.image},log:{rctype:'vector',rcsm:.99}}]:[]}}}}}}}};
  const html=`<h1>${detail.title}</h1><div><span class="ItemPrice__Component">${detail.price.toLocaleString('en-US')}円</span><span class="ItemDetail__ShippingFreeLabel">送料無料</span></div><script id="__NEXT_DATA__">${JSON.stringify(next)}</script>`+' '.repeat(10000);
  const response=new Response(html);Object.defineProperty(response,'url',{value:requested});return response;
 });
 const {fetchYahooItemBundle}=await import('../../scripts/lib/yahoo.mjs?original-fixture='+crypto.randomUUID());
 const loader=createOwnSourceLoader({now:()=>time,retainYahooOriginals:{startedAt:T,deadlineAt:T+12*60_000},fetchYahooBundle:(id,options={})=>fetchYahooItemBundle(id,{attempts:1,yahooRetainSharedOriginals:true,yahooRequestPurpose:options.purpose||(id===item.id?'own':'candidate'),beforeYahooTransport:options.beforeYahooTransport,onYahooItemPageObserved:observer.observe})});
 await loader.yahooBundle(item.id);time+=6000;
 if(!skipCandidate)await loader.yahooBundle(candidate.id);time+=6000;
 if(second&&!deferSecondTargetRead){await loader.yahooBundle(second.id);time+=6000;}
 configureImageFingerprintCache({directory,now:()=>time});
 if(!skipImages)for(const imageUrl of [own.images[0]||own.thumbnailImageUrl,candidate.images[0],...(second&&!deferSecondTargetRead?[second.image]:[])])await imageFingerprints(imageUrl);
 const settings={ownedOffers:buildOwnedOffers(accounts,[item,...(second?[second]:[])]),ownedOffersComplete:true,matchCorrections:{}};
 const mapping=mapYahooPoolToTargets({snapshot:observer.snapshot(),targets:[{...item,profileCard}],settings,now:time});
 const recall=mapping.rows[0]?.candidates[0]||(candidate.seller.id==='seller-boss'?{id:card.id,card,sources:[{observedAt:T+1000}]}:null);assert.ok(recall,'real recommendation producer must supply a recalled pair');
 const input={item,profileCard,recall,settings,peekBundle:loader.peekYahooBundle,peekFingerprint:peekImageFingerprints,startedAt:T,deadlineAt:T+12*60_000,now:()=>time};
 const counts=()=>({htmlReads,imageReads});
 return {item,second,own,candidate,accounts,contexts,observer,loader,settings,input,counts,directory,setTime:value=>time=value,run:()=>verifySharedYahooDetailPair(input)};
}
