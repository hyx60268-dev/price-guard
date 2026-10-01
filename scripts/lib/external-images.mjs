import { imageFingerprints,primaryProductSimilarity } from './image.mjs';
import { xianyuQueryFor } from './discovery.mjs';
import { allowedMerchantPhotoSource } from '../../public/merchant-records.js';
import { hasExplicitVariantMismatch } from './rules.mjs';
import { reviewedProductImages } from './reviewed-product-images.mjs';
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export function externalPublicUrl(value){
 try{const u=new URL(value);return allowedMerchantPhotoSource(value)&&!u.username&&!u.password&&!u.port&&!/^(?:localhost|.*\.localhost|.*\.local|\d+(?:\.\d+){3}|\[)/i.test(u.hostname)&&u.hostname.includes('.')}catch{return false}
}
async function publicHtml(url){
 for(let n=0;n<4;n++){
  if(!externalPublicUrl(url))throw Error('站外图片来源地址无效');
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000),headers:{'user-agent':'Mozilla/5.0','accept-language':'zh-CN,ja;q=0.8'}});
  if(response.status>=300&&response.status<400){url=new URL(response.headers.get('location'),url).href;continue}
  if(!response.ok)throw Error('公开来源 HTTP '+response.status);
  if(Number(response.headers.get('content-length'))>3_000_000)throw Error('公开来源页面过大');
  const text=await response.text();if(text.length>3_000_000)throw Error('公开来源页面过大');return text;
 }
 throw Error('公开来源跳转过多');
}
export async function searchExternalImages(query){
 const xml=await publicHtml('https://www.bing.com/search?format=rss&q='+encodeURIComponent(query+' -site:paypayfleamarket.yahoo.co.jp -site:jp.mercari.com -site:fril.jp'));
 return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>({url:decode(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1])})).filter(p=>externalPublicUrl(p.url)).slice(0,5);
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
 return [...new Map(photos.filter(p=>externalPublicUrl(p.url)).map(p=>[p.url,p])).values()].slice(0,12);
}
export async function readExternalImages(url){return externalProductImages(await publicHtml(url))}
// Images and procurement are separate evidence paths. Each returned image is
// checked against source artwork. Search thumbnails and prices are not costs.
export async function findExternalImages(item,{deadline=Infinity,search=searchExternalImages,detail=readExternalImages,fingerprint=imageFingerprints}={}){
 if(Date.now()>=deadline)return [];
 const reviewed=reviewedProductImages(item);if(reviewed.length)return reviewed;
 const sources=(item.images||[item.image]).filter(Boolean).slice(0,3);if(!sources.length)return [];
 const own=await Promise.all(sources.map(fingerprint)),query=xianyuQueryFor(item.title);
 const seed=/Anker/i.test(item.title)&&/AeroClip\s*2/i.test(item.title)&&/張凌赫/.test(item.title)?[{url:'https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd&from_source=gbox_seo'}]:[];
 let searched=[];try{searched=await search(query)}catch(e){if(!seed.length)throw e}
 const photos=[];
 for(const candidate of [...new Map([...seed,...searched].map(c=>[c.url,c])).values()]){
  if(Date.now()>=deadline)break;if(!externalPublicUrl(candidate.url))continue;
  let gallery;try{gallery=await detail(candidate.url)}catch{continue}
  for(const p of gallery){
   if(Date.now()>=deadline)break;
   if(!externalPublicUrl(p.url)||hasExplicitVariantMismatch(item.title,p.title||'')||hasExplicitVariantMismatch(p.title||'',item.title))continue;
   const fp=await fingerprint(p.url),score=Math.max(-1,...own.map(o=>primaryProductSimilarity(o,fp)??-1));
   if(score<.98)continue;
   photos.push({url:p.url,sourceUrl:candidate.url,verification:'external_detail_image_match',primaryImageScore:score,kind:'product_image'});
  }
  if(photos.length)break;
 }
 return photos.slice(0,8);
}
