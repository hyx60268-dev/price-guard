import { imageFingerprints,primaryProductSimilarity } from './image.mjs';
import { xianyuQueryFor } from './discovery.mjs';
import { allowedMerchantPhotoSource } from '../../public/merchant-records.js';
import { hasExplicitVariantMismatch } from './rules.mjs';
import { reviewedProductImages } from './reviewed-product-images.mjs';
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export function externalPublicUrl(value){
 try{const u=new URL(value);return allowedMerchantPhotoSource(value)&&!u.username&&!u.password&&!u.port&&!/^(?:localhost|.*\.localhost|.*\.local|\d+(?:\.\d+){3}|\[)/i.test(u.hostname)&&u.hostname.includes('.')}catch{return false}
}
export async function publicHtml(url,{deadline=Infinity,request=fetch}={}){
 for(let n=0;n<4;n++){
  if(Date.now()>=deadline)throw Error('lookup_deadline');
  if(!externalPublicUrl(url))throw Error('站外图片来源地址无效');
  const response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-Date.now()))),headers:{'user-agent':'Mozilla/5.0','accept-language':'zh-CN,ja;q=0.8'}});
  if(response.status>=300&&response.status<400){url=new URL(response.headers.get('location'),url).href;continue}
  if(!response.ok)throw Error('公开来源 HTTP '+response.status);
  if(Number(response.headers.get('content-length'))>3_000_000)throw Error('公开来源页面过大');
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>3_000_000)throw Error('公开来源页面过大');chunks.push(chunk)}
  return Buffer.concat(chunks).toString('utf8');
 }
 throw Error('公开来源跳转过多');
}
export function searchImageLinks(html,provider='bing'){
 const links=provider==='bing'?[...html.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>decode(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1])):
  [...html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>/gi)].map(m=>{
   const href=decode(m[0].match(/href=["']([^"']+)["']/i)?.[1]);try{const u=new URL(href,'https://duckduckgo.com');return u.searchParams.get('uddg')||u.href}catch{return ''}
  });
 return [...new Set(links)].filter(externalPublicUrl).slice(0,5).map(url=>({url}));
}
export async function searchExternalImages(query,{provider='bing',deadline=Infinity}={}){
 const q=encodeURIComponent(query+' -site:paypayfleamarket.yahoo.co.jp -site:jp.mercari.com -site:fril.jp');
 const endpoint=provider==='duckduckgo'?'https://html.duckduckgo.com/html/?q=':'https://www.bing.com/search?format=rss&q=';
 const html=await publicHtml(endpoint+q,{deadline});
 // A challenge or unexpected HTML is an access failure, not an empty result.
 if(provider==='bing'&&!/<rss\b/i.test(html)||provider==='duckduckgo'&&!/result__a|No results found/i.test(html))throw Error('search_response_unavailable');
 return searchImageLinks(html,provider);
}
export function externalProductImages(html=''){
 const photos=[];
 for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const collect=node=>{
   if(!node||typeof node!=='object')return;
   if([node['@type']].flat().includes('Product'))for(const img of [node.image||[]].flat())photos.push({url:typeof img==='string'?img:img.url,title:node.name||''});
   for(const child of Object.values(node))if(typeof child==='object')[child].flat().forEach(collect);
  };collect(JSON.parse(m[1]));}catch{}
 }
 // Explicit product galleries only: no recommendations or anonymous banners.
 for(const m of html.matchAll(/<img\b[^>]*>/gi)){
  const alt=decode(m[0].match(/alt=["']([^"']*)["']/i)?.[1]);
  if(!/商品图\d+/.test(alt))continue;
  photos.push({url:decode(m[0].match(/src=["']([^"']+)["']/i)?.[1]),title:alt.replace(/商品图\d+.*$/,'').trim()});
 }
 // Article/product social image is page-bound, unlike a search thumbnail.
 // It must still pass the exact image and variant verifier below.
 const metas=[...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>m[0]);
 const meta=name=>decode(metas.find(m=>new RegExp('(?:property|name)=["\']'+name+'["\']','i').test(m))?.match(/content=["']([^"']+)["']/i)?.[1]);
 const pageTitle=meta('og:title')||decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
 const image=meta('og:image');if(pageTitle&&image)photos.push({url:image,title:pageTitle});
 return [...new Map(photos.filter(p=>externalPublicUrl(p.url)).map(p=>[p.url,p])).values()].slice(0,12);
}
export async function readExternalImages(url,options){return externalProductImages(await publicHtml(url,options))}
export function externalImageQueries(title=''){
 const original=xianyuQueryFor(title);
 const localized=original.replace(/歯医者/g,'牙医').replace(/初期衣装/g,'初始服装').replace(/エドガー[・·\s]*ワルデン/g,'艾格 瓦尔登');
 return [...new Set([localized,original])].filter(Boolean);
}
// Images and procurement are separate evidence paths. Each returned image is
// checked against source artwork. Search thumbnails and prices are not costs.
export async function inspectExternalImages(item,{deadline=Date.now()+60000,search=searchExternalImages,detail=readExternalImages,fingerprint=imageFingerprints}={}){
 const report={photos:[],status:'not_found',reason:'no_search_results',searches:0,pagesRead:0,imagesChecked:0,failures:[]};
 const fail=(stage,url,error)=>report.failures.push({stage,host:url?new URL(url).hostname:'',reason:String(error?.message||error).slice(0,160)});
 if(Date.now()>=deadline)return {...report,status:'deferred',reason:'deadline'};
 const reviewed=reviewedProductImages(item);if(reviewed.length)return {...report,photos:reviewed,status:'verified',reason:'reviewed_source'};
 const sources=(item.images||[item.image]).filter(Boolean).slice(0,3);if(!sources.length)return {...report,status:'unavailable',reason:'source_image_missing'};
 const own=(await Promise.all(sources.map(async url=>{try{return await fingerprint(url)}catch(e){fail('source_image',url,e);return null}}))).filter(Boolean);
 if(!own.length)return {...report,status:'unavailable',reason:'source_image_unavailable'};
 const seed=/Anker/i.test(item.title)&&/AeroClip\s*2/i.test(item.title)&&/張凌赫/.test(item.title)?[{url:'https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd&from_source=gbox_seo'}]:[];
 const visited=new Set();let hadCandidates=false;
 async function check(candidates){for(const candidate of candidates){
  if(Date.now()>=deadline)break;if(!externalPublicUrl(candidate.url)||visited.has(candidate.url))continue;
  visited.add(candidate.url);hadCandidates=true;
  let gallery;try{gallery=await detail(candidate.url,{deadline});report.pagesRead++}catch(e){fail('detail',candidate.url,e);continue}
  for(const p of gallery){
   if(Date.now()>=deadline)break;
   if(!externalPublicUrl(p.url)||hasExplicitVariantMismatch(item.title,p.title||'')||hasExplicitVariantMismatch(p.title||'',item.title))continue;
   let fp;try{fp=await fingerprint(p.url)}catch(e){fail('image',p.url,e);continue}
   if(!fp){fail('image',p.url,'image_download_unavailable');continue}report.imagesChecked++;
   const score=Math.max(-1,...own.map(o=>primaryProductSimilarity(o,fp)??-1));
   if(score<.98)continue;
   report.photos.push({url:p.url,sourceUrl:candidate.url,verification:'external_detail_image_match',primaryImageScore:score,kind:'product_image'});
  }
  if(report.photos.length)break;
 }}
 await check(seed);
 for(const query of externalImageQueries(item.title))for(const provider of ['bing','duckduckgo']){
  if(report.photos.length||Date.now()>=deadline)break;
  report.searches++;let candidates=[];
  try{candidates=await search(query,{provider,deadline})}catch(e){fail('search',provider==='bing'?'https://www.bing.com':'https://duckduckgo.com',e)}
  await check(candidates);
 }
 report.photos=[...new Map(report.photos.map(p=>[p.url,p])).values()].slice(0,8);
 if(report.photos.length){report.status='verified';report.reason='image_match'}
 else if(Date.now()>=deadline){report.status='deferred';report.reason='deadline'}
 else if(report.failures.length){report.status='error';report.reason=report.pagesRead?'image_or_partial_source_failed':hadCandidates?'detail_unavailable':'search_unavailable'}
 else report.reason=report.imagesChecked?'no_verified_match':hadCandidates?'no_product_gallery':'no_search_results';
 return report;
}
export async function findExternalImages(item,options){
 return (await inspectExternalImages(item,options)).photos;
}
