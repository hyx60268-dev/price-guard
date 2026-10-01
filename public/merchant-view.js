import { allowedMerchantPhotoSource } from './merchant-records.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url=value=>/^https:\/\//i.test(value||'')?escape(value):'#';
const day=time=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
const date=value=>Number.isFinite(Date.parse(value||''))?new Date(value).toLocaleString('zh-CN'):'未知';
const labels={sold:'已售 · 平台时间',observed_sold:'监控发现售出',undated_sold:'已售 · 日期未知',listed:'平台上架记录',observed_listing:'首次发现上架'};
export function selectMerchantProducts(products=[],{query='',platform='all',period='month',event='all',now=Date.now()}={}){
 const matches=p=>{
  if(query&&!`${p.sourceTitle} ${p.seller?.name}`.toLowerCase().includes(query.toLowerCase()))return false;
  if(platform!=='all'&&p.sourcePlatform!==platform)return false;
  if(event==='undated')return p.event==='undated_sold';
  if(p.event==='undated_sold')return false;
  if(event==='sold'&&!['sold','observed_sold'].includes(p.event))return false;
  if(event==='listed'&&!['listed','observed_listing'].includes(p.event))return false;
  const stamp=Date.parse(p.eventAt||'');if(!Number.isFinite(stamp)||stamp>now)return false;
  return period==='today'?day(stamp)===day(now):stamp>=now-30*86400000;
 };
 return products.flatMap(p=>{
  const observations=(p.observations||[p]).filter(matches);
  if(!observations.length)return [];
  return [{...p,...observations[0],observations,listingCount:p.listingCount||observations.length,sourceImages:p.sourceImages,webImages:p.webImages,xianyuImages:p.xianyuImages}];
 });
}
export function merchantCardsMarkup(products=[]){
 return products.map(p=>{
  const found=[...(p.xianyuImages||[]),...(p.webImages||[])].filter(photo=>allowedMerchantPhotoSource(photo.url)&&allowedMerchantPhotoSource(photo.sourceUrl)),photos=found;
  const photoLabel=found.length?((p.xianyuImages||[]).length?'闲鱼同款详情图片':'站外同款商品图 · 点击查看出处'):(p.webImageStatus==='error'?'站外找图暂时失败，云端会重试':'尚未找到可核实的站外同款图片');
  const title=p.proposedTitle||p.sourceTitle||'';
  return `<article class="discoverycard merchant-card"><div class="merchant-photos">${[...new Map(photos.map(photo=>[photo.url,photo])).values()].slice(0,2).map(photo=>`<a href="${url(photo.sourceUrl)}" target="_blank" rel="noopener"><img src="${url(photo.url)}" alt="${escape(photoLabel)}" loading="lazy"></a>`).join('')||'<p class="muted">同款站外图片暂缺</p>'}</div><small>${escape(photoLabel)}</small><div class="statusline"><span class="pill">${escape(labels[p.event]||'待核验')}</span><strong>¥${Number(p.sourcePriceJPY).toLocaleString('ja-JP')}</strong></div><h3>${escape(p.sourceTitle)}</h3><p class="muted">${escape(p.seller?.name&&p.seller.name!==p.seller.id?p.seller.name:'商家名称读取中')} · ${escape(p.sourcePlatform)}<br>${p.event==='undated_sold'?'成交日期未公开':escape(date(p.eventAt))}${p.event==='observed_sold'?`<br>观测区间：${escape(date(p.soldWindowStart))} 至 ${escape(date(p.soldObservedAt))}`:''}</p><section class="merchant-text"><h4>日文标题与文案 · 中文对照</h4><p class="muted">${escape(p.copyNote)}</p><div><label>日文标题</label><textarea class="merchant-copy" readonly rows="2" aria-label="日文标题">${escape(title)}</textarea><button class="soft" data-copy-merchant>复制标题</button></div><div><label>日文商品详情</label><textarea class="merchant-copy" readonly rows="14" aria-label="日文商品详情">${escape(p.proposedDescription||'')}</textarea><button class="soft" data-copy-merchant>复制详情</button></div><div><label>中文对照</label><textarea class="merchant-copy" readonly rows="10" aria-label="中文对照">${escape(p.translatedDescription||'')}</textarea><button class="soft" data-copy-merchant>复制中文对照</button></div></section>${p.listingCount>1?`<p class="muted">已合并 ${p.listingCount} 条同款记录 · ${[...new Set((p.observations||[]).map(o=>labels[o.event]))].map(escape).join(" / ")}</p>`:""}${p.bundleParentUrl?`<p class="muted">组合内商品 · ¥${Number(p.sourcePriceJPY).toLocaleString('ja-JP')} 为原单品标价，组合总价 ¥${Number(p.bundleTotalPrice).toLocaleString('ja-JP')}<a href="${url(p.bundleParentUrl)}" target="_blank" rel="noopener">查看组合原页</a></p>`:''}<div class="discoveryactions"><button class="soft" data-posted-merchant="${escape(p.id)}">已上品 · 隐藏并同步</button><a class="soft linkbtn" href="${url(p.sourceUrl)}" target="_blank" rel="noopener">商品原页 ↗</a><a class="soft linkbtn" href="${url(p.seller?.url)}" target="_blank" rel="noopener">商家主页 ↗</a></div></article>`;
 }).join('');
}
