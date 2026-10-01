import { merchantImageSet } from './merchant-image-evidence.js';
import { allowedMerchantPhotoSource } from './merchant-records.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url=value=>/^https:\/\//i.test(value||'')?escape(value):'#';
const day=time=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
const date=value=>Number.isFinite(Date.parse(value||''))?new Date(value).toLocaleString('zh-CN'):'未知';
const labels={sold:'已售 · 平台时间',observed_sold:'监控发现售出',undated_sold:'已售 · 日期未知',listed:'平台上架记录',observed_listing:'首次发现上架'};
export function merchantImageMessage(p={}){
 const reasons={search_unavailable:'搜索服务未返回有效结果',detail_unavailable:'候选图片来源暂时无法读取',image_or_partial_source_failed:'部分来源或图片下载失败',source_image_missing:'原商品缺少核验图片',source_image_unavailable:'原商品图片暂时无法读取',no_verified_match:'候选图片未通过同款核验',no_product_gallery:'候选网页没有可核验商品图',no_search_results:'暂未搜索到站外同款图片',deadline:'本轮找图时间用完，下一轮继续',lookup_exception:'找图执行异常，将自动重试'};
 const reason=reasons[p.webImageReason]||(p.webImageStatus==='error'?'上次找图失败，等待新的检索结果':'尚未找到可核实的站外同款图片');
 return reason+(p.webImageCheckedAt?` · 最近检查 ${date(p.webImageCheckedAt)}`:'')+(p.webImageRetryAt?` · 下次复查不早于 ${date(p.webImageRetryAt)}`:'');
}
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
  const set=merchantImageSet(p);
  const renderPhotos=(photos,label)=>photos.map(photo=>`<a href="${url(photo.sourceUrl)}" target="_blank" rel="noopener"><img src="${url(photo.url)}" alt="${escape(label)}" loading="lazy"><span>${escape(photo.sourceName||(/goofish\.com/.test(photo.sourceUrl||'')?'闲鱼同款详情图片':'查看来源'))} ↗</span></a>`).join('');
  const photoLabel=`官方图 ${set.officialCount}/1–2 · 同组实拍 ${set.photoCount}/至少2`;
  const gallery=`<section class="merchant-image-set"><div class="statusline"><strong>商品图片</strong><span class="pill ${set.complete?'good':'warn'}">${set.complete?'图片组齐全':'图片补全中'}</span></div><p class="muted">${escape(photoLabel)}</p><h4>官方图</h4><div class="merchant-photos">${renderPhotos(set.official,'已核对官方商品图')||'<p class="muted">正在补充可确认官方出处的图片</p>'}</div><h4>实拍组 · 同一发布者、相同场景</h4><div class="merchant-photos">${renderPhotos(set.photos,'已核对同场景实拍图')||'<p class="muted">正在寻找同一发布者的多角度实拍</p>'}</div>${set.other.length?`<h4>同款参考图 · 实拍与来源待补核验</h4><div class="merchant-photos">${renderPhotos(set.other.slice(0,2),(p.xianyuImages||[]).length?'闲鱼同款详情图片':'站外同款参考图')}</div>`:''}${set.complete?'':`<small>${escape(merchantImageMessage(p))}</small>`}</section>`;
  const title=p.proposedTitle||p.sourceTitle||'';
  return `<article class="discoverycard merchant-card">${gallery}<div class="statusline"><span class="pill">${escape(labels[p.event]||'待核验')}</span><strong>¥${Number(p.sourcePriceJPY).toLocaleString('ja-JP')}</strong></div><h3>${escape(p.sourceTitle)}</h3><p class="muted">${escape(p.seller?.name&&p.seller.name!==p.seller.id?p.seller.name:'商家名称读取中')} · ${escape(p.sourcePlatform)}<br>${p.event==='undated_sold'?'成交日期未公开':escape(date(p.eventAt))}${p.event==='observed_sold'?`<br>观测区间：${escape(date(p.soldWindowStart))} 至 ${escape(date(p.soldObservedAt))}`:''}</p><section class="merchant-text"><h4>日文标题与文案 · 中文对照</h4><p class="muted">${escape(p.copyNote)}</p><div><label>日文标题</label><textarea class="merchant-copy" readonly rows="2" aria-label="日文标题">${escape(title)}</textarea><button class="soft" data-copy-merchant>复制标题</button></div><div><label>日文商品详情</label><textarea class="merchant-copy" readonly rows="14" aria-label="日文商品详情">${escape(p.proposedDescription||'')}</textarea><button class="soft" data-copy-merchant>复制详情</button></div><div><label>中文对照</label><textarea class="merchant-copy" readonly rows="10" aria-label="中文对照">${escape(p.translatedDescription||'')}</textarea><button class="soft" data-copy-merchant>复制中文对照</button></div></section>${p.listingCount>1?`<p class="muted">已合并 ${p.listingCount} 条同款记录 · ${[...new Set((p.observations||[]).map(o=>labels[o.event]))].map(escape).join(" / ")}</p>`:""}${p.bundleParentUrl?`<p class="muted">组合内商品 · ¥${Number(p.sourcePriceJPY).toLocaleString('ja-JP')} 为原单品标价，组合总价 ¥${Number(p.bundleTotalPrice).toLocaleString('ja-JP')}<a href="${url(p.bundleParentUrl)}" target="_blank" rel="noopener">查看组合原页</a></p>`:''}<div class="discoveryactions"><button class="soft" data-posted-merchant="${escape(p.id)}">已上品 · 隐藏并同步</button><a class="soft linkbtn" href="${url(p.sourceUrl)}" target="_blank" rel="noopener">商品原页 ↗</a><a class="soft linkbtn" href="${url(p.seller?.url)}" target="_blank" rel="noopener">商家主页 ↗</a></div></article>`;
 }).join('');
}
