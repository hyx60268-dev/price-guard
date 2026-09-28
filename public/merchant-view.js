const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url=value=>/^https:\/\//i.test(value||'')?escape(value):'#';
const day=time=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
const date=value=>Number.isFinite(Date.parse(value||''))?new Date(value).toLocaleString('zh-CN'):'未知';
const labels={sold:'已售 · 平台时间',observed_sold:'监控发现售出',undated_sold:'已售 · 日期未知',listed:'平台上架记录',observed_listing:'首次发现上架'};
export function selectMerchantProducts(products=[],{query='',platform='all',period='month',event='all',now=Date.now()}={}){
 return products.filter(p=>{
  if(query&&!`${p.sourceTitle} ${p.seller?.name}`.toLowerCase().includes(query.toLowerCase()))return false;
  if(platform!=='all'&&p.sourcePlatform!==platform)return false;
  if(event==='undated')return p.event==='undated_sold';
  if(p.event==='undated_sold')return false;
  if(event==='sold'&&!['sold','observed_sold'].includes(p.event))return false;
  if(event==='listed'&&!['listed','observed_listing'].includes(p.event))return false;
  const stamp=Date.parse(p.eventAt||'');if(!Number.isFinite(stamp)||stamp>now)return false;
  return period==='today'?day(stamp)===day(now):stamp>=now-30*86400000;
 });
}
export function merchantCardsMarkup(products=[]){
 return products.map(p=>{
  const found=(p.xianyuImages||[]).filter(photo=>/^https:\/\//i.test(photo.url||'')&&/^https:\/\//i.test(photo.sourceUrl||'')),photos=(found.length?found:(p.sourceImages||[]).map(src=>({url:src,sourceUrl:p.sourceUrl}))).filter(photo=>/^https:\/\//i.test(photo.url||''));
  const photoLabel=found.length?'闲鱼同款详情图片':'来源商家图片 · 闲鱼找图待完成';
  const title=p.proposedTitle||p.sourceTitle||'',copy=`日文タイトル：\n${title}\n\n商品説明：\n${p.proposedDescription||''}\n\n${p.translatedDescription||''}`;
  return `<article class="discoverycard merchant-card"><div class="merchant-photos">${photos.slice(0,4).map(photo=>`<a href="${url(photo.sourceUrl)}" target="_blank" rel="noopener"><img src="${url(photo.url)}" alt="${escape(photoLabel)}" loading="lazy"></a>`).join('')||'<p>等待商品图片</p>'}</div><small>${escape(photoLabel)}</small><div class="statusline"><span class="pill">${escape(labels[p.event]||'待核验')}</span><strong>¥${Number(p.sourcePriceJPY).toLocaleString('ja-JP')}</strong></div><h3>${escape(p.sourceTitle)}</h3><p class="muted">${escape(p.seller?.name||p.seller?.id)} · ${escape(p.sourcePlatform)}<br>${p.event==='undated_sold'?'成交日期未公开':escape(date(p.eventAt))}${p.event==='observed_sold'?`<br>观测区间：${escape(date(p.soldWindowStart))} 至 ${escape(date(p.soldObservedAt))}`:''}</p><details><summary>日文标题与文案 · 中文对照</summary><p class="muted">${escape(p.copyNote)}</p><textarea class="merchant-copy" readonly aria-label="商品文案草稿">${escape(copy)}</textarea><button class="soft" data-copy-merchant>复制完整文案</button></details><div class="discoveryactions"><a class="soft linkbtn" href="${url(p.sourceUrl)}" target="_blank" rel="noopener">商品原页 ↗</a><a class="soft linkbtn" href="${url(p.seller?.url)}" target="_blank" rel="noopener">商家主页 ↗</a></div></article>`;
 }).join('');
}
