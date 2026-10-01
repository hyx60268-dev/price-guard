import { imageFingerprints,primaryProductSimilarity } from './image.mjs';
import { xianyuQueryFor } from './discovery.mjs';
import { allowedMerchantPhotoSource } from '../../public/merchant-records.js';
import { hasExplicitVariantMismatch,titleScore,normalize } from './rules.mjs';
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
const searchText=value=>decode(String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
export function imageSearchRelevance(query='',result={}){
 // Search recall only: final variant and primary-image checks stay mandatory.
 const aliases=value=>xianyuQueryFor(value).replace(/Identity\s*V/gi,'第五人格').replace(/Edgar\s*Valden|Painter/gi,'画家').replace(/Dentist|歯医者/gi,'牙医').replace(/初期衣装/g,'初始服装').replace(/張凌赫/g,'张凌赫').replace(/コラボ/g,'联名').replace(/レッド/g,'红色').replace(/ギフトボックス(?:セット)?/g,'礼盒');
 const wanted=aliases(query).replace(/毛绒玩偶|ぬいぐるみ|plush(?:\s+toy)?|初始服装|中国限定|海外限定/gi,' ').replace(/AeroClip\s*2/gi,'AeroClip2');
 const candidate=aliases(result.title||'').replace(/AeroClip\s*2/gi,'AeroClip2');
 const models=wanted.match(/\b[a-z]+\d+[a-z\d]*\b/gi)||[];
 if(models.some(model=>!normalize(candidate).includes(normalize(model))))return 0;
 return titleScore(wanted,candidate);
}
export function parseImageSearchResults(html,provider='bing',query=''){
 const rows=provider==='bing_web'?[...html.matchAll(/<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)].map(m=>{
  const link=m[1].match(/<h2[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i),href=decode(link?.[1]?.match(/href=["']([^"']+)["']/i)?.[1]);let url=href;
  try{const parsed=new URL(href,'https://www.bing.com');if(parsed.hostname.endsWith('.bing.com')&&parsed.pathname==='/ck/a'){const target=parsed.searchParams.get('u');url=target?.startsWith('a1')?Buffer.from(target.slice(2),'base64url').toString('utf8'):''}}catch{url=''}
  return {url,title:searchText(link?.[2])};
 }):provider==='bing'?[...html.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>({
  url:decode(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1]),title:searchText(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1])
 })):[...html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>{
  const href=decode(m[0].match(/href=["']([^"']+)["']/i)?.[1]);try{const u=new URL(href,'https://duckduckgo.com');return {url:u.searchParams.get('uddg')||u.href,title:searchText(m[1])}}catch{return {}}
 });
 const unique=[...new Map(rows.filter(r=>externalPublicUrl(r.url)).map(r=>[r.url,r])).values()];
 const relevant=unique.map(r=>({...r,relevance:query?imageSearchRelevance(query,r):1})).filter(r=>r.relevance>=.35).sort((a,b)=>b.relevance-a.relevance);
 return {candidates:relevant.slice(0,5),returned:unique.length,rejected:unique.length-relevant.length,rejectedExamples:unique.filter(r=>query&&imageSearchRelevance(query,r)<.35).slice(0,3)};
}
export function searchImageLinks(html,provider='bing'){
 return parseImageSearchResults(html,provider).candidates.map(({url})=>({url}));
}
const unavailableProviders=new Map();
export async function searchExternalImages(query,{provider='bing',deadline=Infinity}={}){
 if((unavailableProviders.get(provider)||0)>Date.now())throw Error('search_provider_cooldown');
 // Exclude marketplace URLs after parsing. Keep query text about the product.
 const q=encodeURIComponent(query);
 const endpoint=provider==='duckduckgo'?'https://html.duckduckgo.com/html/?q=':provider==='bing_web'?'https://www.bing.com/search?q=':'https://www.bing.com/search?format=rss&q=';
 const html=await publicHtml(endpoint+q,{deadline});
 // A challenge or unexpected HTML is an access failure, not an empty result.
 if(/(?:id|class)=["'][^"']*(?:anomaly|challenge)-form|id=["']b_captcha/i.test(html)){for(const key of provider.startsWith('bing')?['bing','bing_web']:[provider])unavailableProviders.set(key,Date.now()+20*60000);throw Error('search_challenge')}
 if(provider==='bing'&&!/<rss\b/i.test(html)||provider==='bing_web'&&!/b_algo|No results|找不到|没有结果/i.test(html)||provider==='duckduckgo'&&!/result__a|No results found|没有找到|沒有找到/i.test(html)){
  unavailableProviders.set(provider,Date.now()+20*60000);throw Error('search_response_unavailable: '+searchText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).slice(0,100));
 }
 return parseImageSearchResults(html,provider,query);
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
 const localized=original.replace(/歯医者/g,'牙医').replace(/初期衣装/g,'初始服装').replace(/エドガー[・·\s]*ワルデン/g,'艾格 瓦尔登').replace(/張凌赫/g,'张凌赫').replace(/コラボ/g,'联名').replace(/レッド/g,'红色').replace(/ギフトボックス(?:セット)?/g,'礼盒');
 return [...new Set([localized,original])].filter(Boolean);
}
// Images and procurement are separate evidence paths. Each returned image is
// checked against source artwork. Search thumbnails and prices are not costs.
export async function inspectExternalImages(item,{deadline=Date.now()+60000,search=searchExternalImages,detail=readExternalImages,fingerprint=imageFingerprints}={}){
 const report={photos:[],status:'not_found',reason:'no_search_results',searches:0,pagesRead:0,imagesChecked:0,failures:[],searchResults:[]};
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
 for(const query of externalImageQueries(item.title))for(const provider of ['bing','bing_web','duckduckgo']){
  if(report.photos.length||Date.now()>=deadline)break;
  report.searches++;let candidates=[];
  try{const found=await search(query,{provider,deadline});candidates=Array.isArray(found)?found:found.candidates||[];
   report.searchResults.push({provider,query,returned:found.returned??candidates.length,rejected:found.rejected||0,accepted:candidates.length});
  }catch(e){fail('search',provider.startsWith('bing')?'https://www.bing.com':'https://duckduckgo.com',e)}
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
