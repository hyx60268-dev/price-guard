const $=selector=>document.querySelector(selector);
const money=value=>Number.isFinite(value)?`¥${Math.round(value).toLocaleString()}`:'—';
const cny=value=>Number.isFinite(value)?`¥${Number(value).toFixed(1)}`:'—';
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numberOrNull=value=>value===''||value===null||value===undefined?null:(Number.isFinite(Number(value))?Number(value):null);
const repo='hyx60268-dev/price-guard';
const accountKey='priceGuard.localAccounts.v2',legacyAccountKey='priceGuard.localAccounts.v1';
const costKey='priceGuard.manualCosts.v2',legacyCostKey='priceGuard.manualCosts.v1';
const deletedAccountKey='priceGuard.deletedAccounts.v1';
const dismissedDiscoveryKey='priceGuard.dismissedDiscoveries.v1';
const discoveryReviewKey='priceGuard.discoveryReviews.v1';
const notificationEmailKey=username=>`priceGuard.notificationEmail.v1.${username}`;

let data,discoveryData,password,currentUsername='admin',dataPrefix='data',installPrompt,currentAccountId,cloudStatus,discoveryCloudStatus,refreshingData=false,pricingPage=1,imageSearchState=null;
const PAGE_SIZE=10;
const getJson=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback))}catch{return fallback}};
const scopedKey=key=>currentUsername==='admin'?key:`${key}.${currentUsername}`;
const getLocal=()=>getJson(scopedKey(accountKey),currentUsername==='admin'?getJson(legacyAccountKey,[]):[]);
const saveLocal=value=>localStorage.setItem(scopedKey(accountKey),JSON.stringify(value));
const getDeleted=()=>getJson(scopedKey(deletedAccountKey),[]);
const saveDeleted=value=>localStorage.setItem(scopedKey(deletedAccountKey),JSON.stringify([...new Set(value)]));
let manualCosts={},dismissedDiscoveries={},discoveryReviews={};
const saveManualCosts=()=>localStorage.setItem(scopedKey(costKey),JSON.stringify(manualCosts));
const saveDismissedDiscoveries=()=>localStorage.setItem(scopedKey(dismissedDiscoveryKey),JSON.stringify(dismissedDiscoveries));
const saveDiscoveryReviews=()=>localStorage.setItem(scopedKey(discoveryReviewKey),JSON.stringify(discoveryReviews));
function loadLocalState(){
  manualCosts=currentUsername==='admin'?{...getJson(legacyCostKey,{}),...getJson(costKey,{})}:getJson(scopedKey(costKey),{});
  dismissedDiscoveries=getJson(scopedKey(dismissedDiscoveryKey),{});discoveryReviews=getJson(scopedKey(discoveryReviewKey),{});
}

function normalizeIdentity(value=''){
  return String(value).normalize('NFKC').toLowerCase().replace(/中国限定|海外限定|日本未発売|日本非売品|正規品|新品|未使用|未開封|公式|送料無料|匿名配送/gi,'')
    .replace(/[\s·・,:：，。!！?？【】\[\]()（）<>《》“”"'‘’\-_/／+＋×]/g,'');
}
function identityKeys(item){
  const accountId=item.accountId||account()?.id||'default',keys=[];
  const query=normalizeIdentity(item.xianyuQuery||''),title=normalizeIdentity(item.title||'');
  if(query)keys.push(`${accountId}:query:${query}`);
  if(title)keys.push(`${accountId}:title:${title}`);
  return [...new Set(keys)];
}
function itemKey(item){return identityKeys(item)[0]||`${item.accountId||account()?.id||'default'}:item:${item.id}`}
function recordTime(record){const time=Date.parse(record?.updatedAt||'');return Number.isFinite(time)?time:0}
function mergeCosts(base={},incoming={}){
  const output={...base};
  for(const [key,record] of Object.entries(incoming||{}))if(record&&typeof record==='object'&&(!output[key]||recordTime(record)>=recordTime(output[key])))output[key]=record;
  return output;
}
function fullRecord(item,values={}){
  return {
    deleted:Boolean(values.deleted),
    purchaseCNY:numberOrNull(values.purchaseCNY),manualFeeCNY:numberOrNull(values.manualFeeCNY),shippingJPY:numberOrNull(values.shippingJPY),
    updatedAt:values.updatedAt||new Date().toISOString(),accountId:item.accountId||account()?.id||'default',itemId:item.id||'',title:item.title||'',
    xianyuQuery:item.xianyuQuery||'',identityKeys:[...new Set([...(values.identityKeys||[]),...identityKeys(item)])]
  };
}

async function decryptFile(url,pwd){
  const response=await fetch(`${url}?t=${Date.now()}`,{cache:'no-store'});
  if(!response.ok)throw Error('尚无检查结果');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(new TextDecoder().decode(bytes.slice(0,4))!=='PG01')throw Error('数据格式错误');
  const salt=bytes.slice(4,20),iv=bytes.slice(20,32),tag=bytes.slice(32,48),body=bytes.slice(48);
  const joined=new Uint8Array(body.length+tag.length);joined.set(body);joined.set(tag,body.length);
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pwd),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:180000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['decrypt']);
  return crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,joined);
}

function migrateLocalData(){
  const aliases=data.relistAliases||{};
  for(const item of data.items||[]){
    const accountId=item.accountId||'default';
    const candidateKeys=[`${accountId}:${item.id}`,`${accountId}:item:${item.id}`,...identityKeys(item)];
    const oldId=aliases[`${accountId}:${item.id}`]||item.relistedFrom;
    if(oldId)candidateKeys.push(`${accountId}:${oldId}`,`${accountId}:item:${oldId}`);
    let best=item.manualCost||null;
    for(const key of candidateKeys)if(manualCosts[key]&&(!best||recordTime(manualCosts[key])>=recordTime(best)))best=manualCosts[key];
    if(!best){
      const wanted=new Set(identityKeys(item));
      for(const record of Object.values(manualCosts))if(record?.accountId===accountId&&(record.itemId===item.id||(record.identityKeys||[]).some(key=>wanted.has(key)))&&(!best||recordTime(record)>=recordTime(best)))best=record;
    }
    if(best){const normalized=fullRecord(item,best);manualCosts[itemKey(item)]=normalized}
  }
  saveManualCosts();
  const deleted=new Set(getDeleted()),cloudManaged=data.managedAccounts||[],local=getLocal(),combined=new Map();
  for(const item of [...cloudManaged,...local])if(item?.id&&!deleted.has(item.id))combined.set(item.id,{...combined.get(item.id),...item});
  saveLocal([...combined.values()]);
}

async function loadDashboard(){
  const plain=await decryptFile(`${dataPrefix}/latest.json.enc`,password);
  data=JSON.parse(new TextDecoder().decode(plain));
  await loadDiscovery();
  if(!data.accounts)data.accounts=[{id:'default',name:data.seller||'默认账号',profileUrl:data.profile||'',profileStatus:'cached',items:data.items||[]}];
  manualCosts=mergeCosts(manualCosts,data.manualCosts||{});dismissedDiscoveries=mergeCosts(dismissedDiscoveries,data.dismissedDiscoveries||{});saveDismissedDiscoveries();
  discoveryReviews=mergeCosts(discoveryReviews,data.discoveryReviews||{});saveDiscoveryReviews();migrateLocalData();
  const visible=cloudAccounts();
  if(!currentAccountId||currentAccountId!=='__all__'&&![...visible,...localOnlyAccounts()].some(item=>item.id===currentAccountId))currentAccountId=visible[0]?.id||localOnlyAccounts()[0]?.id||'__all__';
}

async function loadDiscovery(){
  try{const discoveryPlain=await decryptFile('data/discovery.json.enc',password);discoveryData=JSON.parse(new TextDecoder().decode(discoveryPlain))}catch{discoveryData=null}
}

$('#unlockForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;$('#unlockError').textContent='正在解密…';
  try{
    currentUsername=String($('#username').value||'admin').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'')||'admin';loadLocalState();
    dataPrefix=currentUsername==='admin'?'data':`data/users/${currentUsername}`;
    password=$('#password').value;await loadDashboard();$('#unlock').hidden=true;$('#dashboard').hidden=false;$('#cloudSync').hidden=false;
    $('#userAdminSection').hidden=currentUsername!=='admin';
    renderAccountOptions();render();await checkCloudStatus(false);
  }catch(error){$('#unlockError').textContent='密码不正确，或云端尚未生成数据。'}
  finally{button.disabled=false}
});

function cloudAccounts(){const deleted=new Set(getDeleted());return (data?.accounts||[]).filter(item=>!deleted.has(item.id))}
function localOnlyAccounts(){return getLocal().filter(item=>!cloudAccounts().some(cloud=>cloud.profileUrl===item.profileUrl))}
function account(){return cloudAccounts().find(item=>item.id===currentAccountId)||cloudAccounts()[0]}
function allAccountsSelected(){return currentAccountId==='__all__'}
function rawItems(){return allAccountsSelected()?(data?.items||[]):(account()?.items||[])}
function manualFor(item){
  const accountId=item.accountId||account()?.id||'default',aliases=data?.relistAliases||{};
  const keys=[itemKey(item),`${accountId}:${item.id}`,`${accountId}:item:${item.id}`,...identityKeys(item)];
  const oldId=aliases[`${accountId}:${item.id}`]||item.relistedFrom;if(oldId)keys.push(`${accountId}:${oldId}`,`${accountId}:item:${oldId}`);
  let best=item.manualCost||null;
  for(const key of keys)if(manualCosts[key]&&(!best||recordTime(manualCosts[key])>=recordTime(best)))best=manualCosts[key];
  const wanted=new Set(identityKeys(item));
  for(const record of Object.values(manualCosts))if(record?.accountId===accountId&&(record.itemId===item.id||(record.identityKeys||[]).some(key=>wanted.has(key)))&&(!best||recordTime(record)>=recordTime(best)))best=record;
  return best&&!best.deleted?best:{};
}

function clientAdvice({ownPrice,recommendedPrice,costJPY}){
  if(!Number.isFinite(costJPY))return '待输入成本';
  const current=ownPrice-costJPY,after=recommendedPrice-costJPY,warning=data.settings.profitWarningJPY;
  if(after<0)return '调价后亏损';if(after<warning)return '不建议按推荐价出售';if(current<warning)return '建议提价或控制成本';return '利润正常';
}
function effective(item,temporary){
  const saved=temporary||manualFor(item),manualPurchaseCNY=numberOrNull(saved.purchaseCNY),purchaseCNY=manualPurchaseCNY??numberOrNull(item.averageCNY);
  const manualFeeCNY=numberOrNull(saved.manualFeeCNY),shippingJPY=numberOrNull(saved.shippingJPY);
  const complete=[purchaseCNY,manualFeeCNY,shippingJPY].every(Number.isFinite);
  const costJPY=complete?Math.ceil(((purchaseCNY+manualFeeCNY)*data.settings.exchangeRate+shippingJPY)*data.settings.costMultiplier):null;
  const currentProfitJPY=Number.isFinite(costJPY)?item.ownPrice-costJPY:null,afterProfitJPY=Number.isFinite(costJPY)?item.recommendedPrice-costJPY:null;
  return {...item,manualPurchaseCNY,purchaseCNY,automaticReferenceCNY:numberOrNull(item.averageCNY),manualFeeCNY,shippingJPY,costJPY,currentProfitJPY,afterProfitJPY,
    currentUnder1500:Number.isFinite(currentProfitJPY)&&currentProfitJPY<data.settings.profitWarningJPY,
    afterUnder1500:Number.isFinite(afterProfitJPY)&&afterProfitJPY<data.settings.profitWarningJPY,needsCostInput:!complete,
    advice:item.yahoo?.underpriced?'售价明显低于同款市场，建议提价':clientAdvice({ownPrice:item.ownPrice,recommendedPrice:item.recommendedPrice,costJPY}),
    effectiveCostSource:complete?(Number.isFinite(manualPurchaseCNY)?'人工采购价 + 手工费用':`${item.costSource==='live'?'闲鱼验证均价':'历史参考价'} + 手工费用`):'待补齐成本值'};
}
function items(){return rawItems().map(item=>effective(item))}
function stats(){const list=items();return [['商品',list.length],['建议调价',list.filter(item=>item.recommendedPrice!==item.ownPrice).length],['当前利润 < ¥1,500',list.filter(item=>item.currentUnder1500).length],['调价后 < ¥1,500',list.filter(item=>item.afterUnder1500).length],['待补完整成本',list.filter(item=>item.needsCostInput).length]]}
function pill(item){const tone=/亏损|不建议|控制成本/.test(item.advice)?'bad':item.needsCostInput||item.confidence!=='高'?'warn':'';return `<span class="pill ${tone}">${escapeHtml(item.advice)}</span>`}
function selected(){
  const query=$('#search').value.toLowerCase(),filter=$('#filter').value;
  return items().filter(item=>(item.title+(item.xianyuQuery||'')).toLowerCase().includes(query)&&(filter==='all'||filter==='reprice'&&item.recommendedPrice!==item.ownPrice||filter==='low'&&item.afterUnder1500||filter==='input'&&item.needsCostInput||filter==='manual'&&item.confidence!=='高'));
}
function statusCard(label,value,tone=''){return `<div class="status ${tone}"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`}

function discoveryProductKey(item){return item.productKey||normalizeIdentity(item.sourceTitle||item.proposedTitle||'')||item.id}
function discoveryProducts(){
  const seen=new Set();
  return (discoveryData?.products||[]).filter(item=>{
    const key=discoveryProductKey(item);
    const recentDates=(item.saleDates||[]).map(Date.parse).filter(Number.isFinite).filter(value=>value<=Date.now()+3_600_000&&value>=Date.now()-30*86_400_000);
    if(!key||dismissedDiscoveries[key]||seen.has(key)||recentDates.length<2)return false;
    seen.add(key);return true;
  });
}
function discoverySelected(){
  const query=($('#discoverySearch')?.value||'').toLowerCase(),filter=$('#discoveryFilter')?.value||'all';
  return discoveryProducts().filter(item=>`${item.proposedTitle||''} ${item.sourceTitle||''} ${item.xianyuQuery||''}`.toLowerCase().includes(query)&&
    (filter==='all'||filter===item.sourcePlatform||(item.sourcePlatforms||[]).includes(filter)));
}
function discoveryPlatform(value){return value==='mercari'?'メルカリ':value==='yahoo'?'Yahoo!フリマ':'メルカリ + Yahoo!フリマ'}
function renderDiscovery(){
  const container=$('#discoveryCards');if(!container)return;
  if(!discoveryData){
    $('#discoveryStamp').textContent='等待首次云端选品扫描';$('#discoveryStats').innerHTML='<span>尚无数据</span>';container.innerHTML='';$('#discoveryEmpty').hidden=false;return;
  }
  const checked=new Date(discoveryData.checkedAt),visible=discoveryProducts(),shown=discoverySelected();
  $('#discoveryStamp').textContent=`最近扫描：${Number.isNaN(checked.valueOf())?'—':checked.toLocaleString('zh-CN')} · 每6小时深度更新，其他检查轮次复用结果`;
  $('#discoveryStats').innerHTML=`<span>候选 <b>${visible.length}</b></span><span>煤炉 <b>${visible.filter(item=>item.sourcePlatform==='mercari'||item.sourcePlatforms?.includes('mercari')).length}</b></span><span>Yahoo <b>${visible.filter(item=>item.sourcePlatform==='yahoo'||item.sourcePlatforms?.includes('yahoo')).length}</b></span>`;
  $('#discoveryEmpty').hidden=shown.length>0;
  container.innerHTML=shown.map(item=>{
    const referencePhotos=[...(item.sourceImages||[]),...(item.images||[])].filter((url,index,list)=>url&&list.indexOf(url)===index).slice(0,5),photos=referencePhotos;
    const imageGrid=photos.map((url,index)=>`<a href="${escapeHtml(url)}" target="_blank" title="打开来源商家图片 ${index+1}"><img src="${escapeHtml(url)}" alt="来源商家商品图片 ${index+1}" loading="lazy"></a>`).join('');
    const webQuery=encodeURIComponent(item.sourceTitle||item.proposedTitle||'');
    return `<article class="discoverycard">
      <div class="discoveryimages ${photos.length<3?'incomplete':''}">${imageGrid||'<div class="imageplaceholder">来源商品暂未提取到图片</div>'}</div>
      <div class="statusline"><span class="pill">来源商家图片</span><small>${discoveryPlatform(item.sourcePlatforms?.length>1?'combined':item.sourcePlatform)}</small></div>
      <h3>${escapeHtml(item.proposedTitle||item.sourceTitle)}</h3><p class="source-title">原始：${escapeHtml(item.sourceTitle)}</p>
      <div class="discoverymetrics"><div><small>热卖优先级</small><b>近 ${item.priorityWindow||30} 天</b><small>2天 ${item.salesWindows?.days2||0} · 7天 ${item.salesWindows?.days7||0} · 30天 ${item.salesWindows?.days30||item.salesCount||0}</small><small>最近成交 ${item.saleDates?.[0]?new Date(item.saleDates[0]).toLocaleDateString('zh-CN'):'—'}</small></div><div><small>日本成交中位价</small><b>${money(item.sourcePriceJPY)}</b><small>${item.sellerCount||1} 个独立商家来源</small></div><div><small>闲鱼成本</small><b>${Number.isFinite(Number(item.purchaseCNY))?`¥${Number(item.purchaseCNY).toFixed(1)}`:'待核验'}</b><small>${escapeHtml(item.confidence||'待核验')}</small></div></div>
      <p class="listingcopy">${escapeHtml(item.proposedDescription||'')}</p>
      <div class="discoveryactions"><button class="soft" data-copy-title="${escapeHtml(item.id)}">复制标题</button><button class="soft" data-copy-description="${escapeHtml(item.id)}">复制简介</button><button class="soft" data-uploaded="${escapeHtml(item.id)}">标记仓库已有/已上传</button><a class="soft linkbtn" target="_blank" href="${escapeHtml(item.sourceUrl||'#')}">成交商品</a><a class="soft linkbtn" target="_blank" href="${escapeHtml(item.seller?.url||'#')}">商家主页</a></div>
      <section class="reviewbox"><h4>来源商家图片与找图入口</h4>
        <p class="muted">下面保留发现该商品时使用的商家图片和搜索入口，便于继续找不同来源的可用图片。</p>
        ${referencePhotos.length?`<div class="referencephotos">${referencePhotos.slice(0,3).map(url=>`<a href="${escapeHtml(url)}" target="_blank"><img src="${escapeHtml(url)}" alt="来源商家参考图" loading="lazy"></a>`).join('')}</div>`:''}
        <div class="websearches"><a target="_blank" href="https://www.bing.com/images/search?q=${webQuery}">全网图片</a><a target="_blank" href="https://search.yahoo.co.jp/image/search?p=${webQuery}">Yahoo图片</a><a target="_blank" href="https://www.google.com/search?tbm=isch&q=${webQuery}">Google图片</a><a target="_blank" href="https://s.taobao.com/search?q=${webQuery}">淘宝</a><button type="button" class="linklike" data-search-discovery="${escapeHtml(item.id)}" data-search-app="xianyu">闲鱼搜图</button><button type="button" class="linklike" data-search-discovery="${escapeHtml(item.id)}" data-search-app="xhs">小红书搜图</button></div>
        <p class="muted appsearchnote">系统已在云端准备同源首图；点按钮后先保存到手机，再自动尝试打开对应 App。</p>
      </section>
    </article>`;
  }).join('');
  document.querySelectorAll('[data-copy-title]').forEach(button=>button.onclick=()=>copyDiscovery(button,discoveryProducts().find(item=>item.id===button.dataset.copyTitle)?.proposedTitle));
  document.querySelectorAll('[data-copy-description]').forEach(button=>button.onclick=()=>copyDiscovery(button,discoveryProducts().find(item=>item.id===button.dataset.copyDescription)?.proposedDescription));
  document.querySelectorAll('[data-uploaded]').forEach(button=>button.onclick=()=>markDiscoveryUploaded(discoveryData.products.find(item=>item.id===button.dataset.uploaded)));
  document.querySelectorAll('[data-search-discovery]').forEach(button=>button.onclick=()=>{
    const item=discoveryProducts().find(value=>value.id===button.dataset.searchDiscovery),image=[...(item?.sourceImages||[]),...(item?.images||[])].find(Boolean);
    openImageSearch({kind:'discovery',id:item?.id,title:item?.proposedTitle||item?.sourceTitle||'候选商品',image},button.dataset.searchApp);
  });
}
function markDiscoveryUploaded(item){
  if(!item||!confirm(`确认“${item.proposedTitle||item.sourceTitle}”已经上传？\n\n确认后会隐藏该同款；同步云端后所有设备和以后扫描都不再显示。`))return;const key=discoveryProductKey(item);
  dismissedDiscoveries[key]={productKey:key,title:item.sourceTitle||item.proposedTitle||'',description:item.sourceDescription||'',images:(item.sourceImages||[]).slice(0,8),updatedAt:new Date().toISOString()};
  saveDismissedDiscoveries();renderDiscovery();$('#refreshNotice').hidden=false;$('#refreshText').textContent='已从本机永久隐藏；点“同步云端”后手机和电脑都会排除该同款。';
}
async function copyDiscovery(button,value){try{await navigator.clipboard.writeText(value||'');const old=button.textContent;button.textContent='已复制';setTimeout(()=>button.textContent=old,1500)}catch{alert('复制失败，请长按文字复制')}}
function safeImageKey(value=''){return String(value||'').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,120)||'image'}
function localSearchImage(kind,id){return `data/share-images/${kind}-${safeImageKey(id)}.jpg`}
function marketplaceUrl(app){return app==='xhs'?'https://www.xiaohongshu.com/explore':'https://www.goofish.com/'}
function marketplaceName(app){return app==='xhs'?'小红书':'闲鱼'}
function openMarketplace(app){
  const url=marketplaceUrl(app);
  if(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent))location.assign(url);else window.open(url,'_blank','noopener');
}
async function prepareSearchImage(state){
  const button=$('#saveSearchImage');button.disabled=true;button.textContent='正在准备图片…';
  for(const url of [state.localUrl,state.image]){
    if(!url)continue;
    try{
      const response=await fetch(url,{cache:'no-store'}),blob=response.ok?await response.blob():null;
      if(blob?.type?.startsWith('image/')){
        const type=blob.type||'image/jpeg',extension=type.includes('png')?'png':type.includes('webp')?'webp':'jpg';
        state.blob=blob;state.file=new File([blob],`price-guard-${safeImageKey(state.id)}.${extension}`,{type});break
      }
    }catch{}
  }
  button.disabled=false;button.textContent=state.file?'① 保存图片到手机':'① 打开原图并保存';
  $('#imageSearchStatus').textContent=state.file?'图片已准备好。点“保存图片到手机”，在系统面板选择“存储图像”；完成后会尝试打开对应 App。':'云端图片暂不可下载；点按钮打开原图，长按保存后再打开 App。';
}
function openImageSearch(payload,preferredApp='xianyu'){
  if(!payload?.image||!payload?.id){alert('这件商品暂时没有可用图片');return}
  const state={...payload,preferredApp,localUrl:localSearchImage(payload.kind,payload.id),blob:null,file:null};imageSearchState=state;
  const preview=$('#imageSearchPreview');preview.onerror=()=>{preview.onerror=null;preview.src=state.image};preview.src=state.localUrl;
  $('#imageSearchTitle').textContent=state.title;$('#imageSearchStatus').textContent='正在准备可保存的同源首图…';
  $('#saveSearchImage').textContent='正在准备图片…';$('#saveSearchImage').disabled=true;
  if(!$('#imageSearchDialog').open)$('#imageSearchDialog').showModal();prepareSearchImage(state);
}
async function saveSearchImage(){
  const state=imageSearchState;if(!state)return;
  try{
    if(state.file&&navigator.canShare?.({files:[state.file]})){
      await navigator.share({title:state.title,text:'保存此图后，请在 App 内选择以图搜索',files:[state.file]});
      $('#imageSearchStatus').textContent=`系统图片面板已完成，正在打开${marketplaceName(state.preferredApp)}；若没有自动打开，请点下面按钮。`;
      openMarketplace(state.preferredApp);return;
    }
    const link=document.createElement('a');link.href=state.localUrl||state.image;link.download=`price-guard-${safeImageKey(state.id)}.jpg`;link.target='_blank';link.rel='noopener';link.click();
    $('#imageSearchStatus').textContent=`图片已下载或打开；保存后点“打开${marketplaceName(state.preferredApp)}”。`;
  }catch(error){if(error?.name!=='AbortError'){$('#imageSearchStatus').textContent='保存面板没有打开，请点原图后长按保存。';window.open(state.image,'_blank','noopener')}}
}
function switchView(view){
  const discovery=view==='discovery';$('#pricingView').hidden=discovery;$('#discoveryView').hidden=!discovery;
  $('#showPricing').classList.toggle('active',!discovery);$('#showDiscovery').classList.toggle('active',discovery);if(discovery)renderDiscovery();
}

function renderAccountOptions(){
  const cloud=`<option value="__all__">全部账号（总览）</option>`+cloudAccounts().map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.profileStatus==='pending_sync'?'（待首次扫描）':''}</option>`).join('');
  const local=localOnlyAccounts().map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}（待同步）</option>`).join('');
  $('#accountSelect').innerHTML=cloud+local;$('#accountSelect').value=currentAccountId;
}

function render(){
  const local=localOnlyAccounts().find(item=>item.id===currentAccountId);
  if(local){
    $('#profileLink').href=local.profileUrl;$('#accountSync').textContent='已在本机保存 · 点“同步云端”后加入自动扫描';
    $('#statusGrid').innerHTML=statusCard('Yahoo主页','等待云端同步','warn')+statusCard('Yahoo比价','未运行','warn')+statusCard('闲鱼成本','未运行','warn')+statusCard('手工成本','可先录入已有商品','good');
    $('#kpis').innerHTML='';$('#rows').innerHTML='';$('#cards').innerHTML='';$('#pagination').innerHTML='';$('#empty').hidden=false;return;
  }
  const current=account();if(!current){
    $('#profileLink').removeAttribute('href');$('#accountSync').textContent='还没有绑定店铺';
    $('#statusGrid').innerHTML=statusCard('Yahoo店铺','等待你添加','warn')+statusCard('自动比价','绑定后启用','warn')+statusCard('通知邮箱','可先设置','good')+statusCard('账号隔离','已启用','good');
    $('#kpis').innerHTML='';$('#rows').innerHTML='';$('#cards').innerHTML='';$('#pagination').innerHTML='';$('#empty').hidden=false;$('#empty').textContent='还没有商品。点“账号管理”添加你的 Yahoo!フリマ 卖家主页并同步。';return;
  }
  const list=items(),scan=current.scanStats||{},date=new Date(data.checkedAt);
  $('#stamp').textContent=`最近检查：${Number.isNaN(date.valueOf())?'等待首次扫描':date.toLocaleString('zh-CN')} · 页面会自动接收新结果`;
  const login=data.login||{};$('#loginNotice').hidden=!(login.xianyuRequired||login.xianyuAuthExpired);
  $('#loginTitle').textContent=login.xianyuRequired?'闲鱼自动核验暂不可用':'闲鱼登录失效，已尝试匿名模式';
  $('#loginText').textContent='Yahoo 仍会继续检查；闲鱼无法同时核对正文、规格和图片时不会采用低价，请手工填写采购价。';
  const changes=data.changes;$('#changeNotice').hidden=!changes?.hasChanges;
  $('#changeText').textContent=changes?.hasChanges?`本次共 ${changes.total} 项变化：新增 ${changes.added}、下架 ${changes.removed}、价格/利润变化 ${changes.updated}。`:'';
  $('#profileLink').href=current.profileUrl;
  const delta=current.profileDelta||{added:[],removed:[],relisted:[],unchanged:list.length};
  $('#accountSync').textContent=current.profileStatus==='live'?`主页成功 · 新增 ${delta.added?.length||0} / 减少 ${delta.removed?.length||0} / 重新上架 ${delta.relisted?.length||0}`:current.profileStatus==='pending_sync'?'已同步，等待首次扫描':current.profileStatus==='error'?'主页失败，沿用上次清单':'沿用已保存清单';
  const savedCosts=list.filter(item=>!item.needsCostInput).length;
  if(allAccountsSelected()){
    const accounts=cloudAccounts(),totals=accounts.reduce((sum,value)=>({yahooLive:sum.yahooLive+(value.scanStats?.yahooLive||0),yahooCached:sum.yahooCached+(value.scanStats?.yahooCached||0),yahooDeferred:sum.yahooDeferred+(value.scanStats?.yahooDeferred||0),xianyuScanned:sum.xianyuScanned+(value.scanStats?.xianyuScanned||0),xianyuCached:sum.xianyuCached+(value.scanStats?.xianyuCached||0)}),{yahooLive:0,yahooCached:0,yahooDeferred:0,xianyuScanned:0,xianyuCached:0});
    $('#profileLink').removeAttribute('href');$('#accountSync').textContent=`总览 ${accounts.length} 个账号 · 每个账号的数据、成本和利润单独保存`;
    $('#statusGrid').innerHTML=statusCard('账号',`${accounts.length} 个账号 / ${list.length} 件在售`,accounts.every(value=>value.profileStatus==='live')?'good':'warn')+statusCard('Yahoo比价',`实时 ${totals.yahooLive} / 缓存 ${totals.yahooCached} / 延后 ${totals.yahooDeferred}`,totals.yahooDeferred?'warn':'good')+statusCard('闲鱼按需核验',`本轮 ${totals.xianyuScanned} / 缓存 ${totals.xianyuCached}`,data.login?.xianyuRequired?'bad':'good')+statusCard('低价异常',`${list.filter(item=>item.yahoo?.underpriced).length} 件`,'warn');
  }else $('#statusGrid').innerHTML=statusCard('Yahoo主页',current.profileStatus==='live'?`${list.length} 件在售`:'使用保存清单',current.profileStatus==='live'?'good':'warn')+
    statusCard('Yahoo比价',`实时 ${scan.yahooLive??0} / 缓存 ${scan.yahooCached??0} / 延后 ${scan.yahooDeferred??0}`,(scan.yahooDeferred||0)?'warn':'good')+
    statusCard('闲鱼按需核验',`本轮 ${scan.xianyuScanned??0} / 缓存 ${scan.xianyuCached??0}`,data.login?.xianyuRequired?'bad':'good')+
    statusCard('成本数据',`已完整 ${savedCosts}/${list.length}`,savedCosts===list.length?'good':'warn');
  $('#kpis').innerHTML=stats().map(([label,value])=>`<div class="kpi"><strong>${value}</strong><span>${label}</span></div>`).join('');
  const filtered=selected(),pageCount=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));pricingPage=Math.min(Math.max(1,pricingPage),pageCount);
  const shown=filtered.slice((pricingPage-1)*PAGE_SIZE,pricingPage*PAGE_SIZE);$('#empty').hidden=filtered.length>0;
  const accountLabel=item=>allAccountsSelected()?`<small class="accountname">${escapeHtml(item.accountName||item.accountId||'')}</small>`:'';
  $('#rows').innerHTML=shown.map(item=>`<tr data-id="${escapeHtml(item.id)}"><td><div class="product"><img src="${escapeHtml(item.image)}" alt=""><b>${accountLabel(item)}${escapeHtml(item.title)}</b></div></td><td class="money">${money(item.ownPrice)}</td><td class="money">${money(item.lowestPrice)}</td><td class="money">${money(item.recommendedPrice)}</td><td>${cny(item.automaticReferenceCNY)}${Number.isFinite(item.manualPurchaseCNY)?`<small>实际采购 ${cny(item.manualPurchaseCNY)}</small>`:''}</td><td class="money">${money(item.costJPY)}</td><td class="money ${item.currentUnder1500?'bad':''}">${money(item.currentProfitJPY)}</td><td class="money ${item.afterUnder1500?'bad':''}">${money(item.afterProfitJPY)}</td><td>${pill(item)}</td></tr>`).join('');
  $('#cards').innerHTML=shown.map(item=>`<article class="mobile-card" data-id="${escapeHtml(item.id)}"><div class="mobile-head"><img src="${escapeHtml(item.image)}" alt=""><b>${accountLabel(item)}${escapeHtml(item.title)}</b></div><div class="mobile-prices four"><div><small>我的售价</small>${money(item.ownPrice)}</div><div><small>建议价</small>${money(item.recommendedPrice)}</div><div><small>闲鱼自动参考</small>${cny(item.automaticReferenceCNY)}</div><div><small>当前完整成本</small>${money(item.costJPY)}</div><div><small>当前利润</small><span class="${item.currentUnder1500?'bad':''}">${money(item.currentProfitJPY)}</span></div><div><small>改价后利润</small><span class="${item.afterUnder1500?'bad':''}">${money(item.afterProfitJPY)}</span></div></div><div class="mobile-foot">${pill(item)}<span>查看并填写成本 ›</span></div></article>`).join('');
  $('#pagination').innerHTML=filtered.length>PAGE_SIZE?`<button class="soft" data-page="${pricingPage-1}" ${pricingPage===1?'disabled':''}>上一页</button><span>第 ${pricingPage} / ${pageCount} 页 · 共 ${filtered.length} 件</span><button class="soft" data-page="${pricingPage+1}" ${pricingPage===pageCount?'disabled':''}>下一页</button>`:'';
  document.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>{pricingPage=Number(button.dataset.page);render();document.querySelector('#pricingView')?.scrollIntoView({behavior:'smooth'})});
  document.querySelectorAll('[data-id]').forEach(element=>element.onclick=()=>detail(element.dataset.id));
}

function detail(id){
  const raw=rawItems().find(item=>item.id===id);if(!raw)return;
  const item=effective(raw),saved=manualFor(raw),samples=raw.xianyu?.samples||[],rejected=raw.xianyu?.rejected||[];
  const marketSamples=Number(item.yahoo?.marketSampleCount)||0;
  const marketChecked=item.yahooSource==='live'&&item.yahoo?.status==='ok';
  const marketMedian=marketSamples?`${money(item.yahoo?.marketMedianPrice)} <small>${marketSamples} 个核验样本</small>`:marketChecked?'未找到可比样本':'等待本轮核验';
  const marketRange=marketSamples?`${money(item.yahoo?.marketMinPrice)} ～ ${money(item.yahoo?.marketMaxPrice)}`:marketChecked?'—':'尚未核验';
  $('#detailBody').innerHTML=`
    <div class="detailhead"><img src="${escapeHtml(item.image)}" alt=""><div><h2>${escapeHtml(item.title)}</h2><p>${pill(item)}　同款匹配：${escapeHtml(item.yahoo?.matchConfidence||item.confidence||'需复核')}</p></div></div>
    <div class="detailgrid"><div><small>我的售价</small><br><b>${money(item.ownPrice)}</b></div><div><small>Yahoo最低</small><br><b>${money(item.lowestPrice)}</b></div><div><small>建议价</small><br><b>${money(item.recommendedPrice)}</b></div><div><small>同款市场中位价</small><br><b>${marketMedian}</b></div><div><small>同款价格范围</small><br><b>${marketRange}</b></div><div><small>闲鱼验证均价</small><br><b>${cny(item.averageCNY)}</b></div><div><small>当前成本</small><br><b id="previewCost">${money(item.costJPY)}</b></div><div><small>不改价利润</small><br><b id="previewCurrentProfit" class="${item.currentUnder1500?'bad':''}">${money(item.currentProfitJPY)}</b></div><div><small>改价后利润</small><br><b id="previewAfterProfit" class="${item.afterUnder1500?'bad':''}">${money(item.afterProfitJPY)}</b></div></div>
    <section class="manualbox"><h3>由你确认成本</h3><p class="muted">采购价可使用闲鱼验证均价或由你填写；人肉费和日本物流费始终由你填写。保存后本机立即计算，再点“同步云端”让手机、电脑和 Excel 共用。</p>
      <form id="manualCostForm" class="costform"><label><span>采购价（人民币）</span><input id="purchaseCNY" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(saved.purchaseCNY??'')}" placeholder="${Number.isFinite(item.averageCNY)?item.averageCNY.toFixed(1):'必须填写'}"></label><label><span>人肉费（人民币）</span><input id="manualFeeCNY" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(saved.manualFeeCNY??'')}" placeholder="由你填写"></label><label><span>日本物流费（日元）</span><input id="shippingJPY" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(saved.shippingJPY??'')}" placeholder="由你填写"></label><div class="costactions"><button type="submit">保存本机并计算</button><button type="button" id="saveAndSync">保存并同步云端</button><button type="button" id="clearCost" class="soft">清空</button><span id="costSaveStatus"></span></div></form>
      <p><small>公式：((采购价 + 人肉费) × ${data.settings.exchangeRate} + 日本物流费) × ${data.settings.costMultiplier}，向上取整。</small></p></section>
    <p class="links"><a target="_blank" href="${escapeHtml(item.ownUrl)}">我的 Yahoo 商品</a><a target="_blank" href="${escapeHtml(item.lowestUrl||item.yahoo?.searchUrl)}">最低价/搜索结果</a><a target="_blank" href="${escapeHtml(item.xianyuSearchUrl)}">闲鱼文字搜索</a><button type="button" id="searchMainXianyu" class="linklike">闲鱼搜图</button><button type="button" id="searchMainXhs" class="linklike">小红书搜图</button></p>
    <p><small>系统自动核验方式：商品页相似区与定期宽搜召回候选，再逐个核对详情标题、正文、规格及多张图片。手机搜图会先交给系统保存图片，再打开对应 App。</small></p>
    <p><small>Yahoo来源：${escapeHtml(item.yahooSource||'—')} · 搜索候选 ${escapeHtml(item.yahoo?.searchCardCount??'—')} 件 · 推荐候选 ${escapeHtml(item.yahoo?.recommendationCardCount??'—')} 件 · 详情核验 ${escapeHtml(item.yahoo?.detailCheckedCount??0)} 件 · 闲鱼自动参考：${cny(item.automaticReferenceCNY)} · 利润成本来源：${escapeHtml(item.effectiveCostSource)}</small></p>
    <h3>采用的闲鱼样本（${samples.length}）</h3><ul class="samples">${samples.map(sample=>`<li><a target="_blank" href="${escapeHtml(sample.url||'#')}">${escapeHtml(sample.detailTitle||sample.title||'同款样本')}</a><span>图片 ${(Number(sample.imageScore||0)*100).toFixed(0)}%　<b>${cny(sample.price)}</b></span></li>`).join('')||'<li>没有达到“至少 2 个详情、图片与价格区间均一致”的标准，请人工填写采购价。</li>'}</ul>${rejected.length?`<p class="muted">已排除 ${rejected.length} 个多规格、低价钩子、正文或图片不一致候选。</p>`:''}`;

  const temporary=()=>({purchaseCNY:$('#purchaseCNY').value,manualFeeCNY:$('#manualFeeCNY').value,shippingJPY:$('#shippingJPY').value});
  const preview=()=>{const next=effective(raw,temporary());$('#previewCost').textContent=money(next.costJPY);$('#previewCurrentProfit').textContent=money(next.currentProfitJPY);$('#previewAfterProfit').textContent=money(next.afterProfitJPY);$('#previewCurrentProfit').className=next.currentUnder1500?'bad':'';$('#previewAfterProfit').className=next.afterUnder1500?'bad':''};
  ['#purchaseCNY','#manualFeeCNY','#shippingJPY'].forEach(selector=>$(selector).addEventListener('input',preview));
  const save=()=>{const record=fullRecord(raw,temporary());manualCosts[itemKey(raw)]=record;saveManualCosts();render();return record};
  $('#manualCostForm').onsubmit=event=>{event.preventDefault();save();detail(id);$('#costSaveStatus').textContent='已保存在本机，等待云端同步'};
  $('#saveAndSync').onclick=async()=>{save();await startCloudSync($('#costSaveStatus'))};
  $('#clearCost').onclick=()=>{manualCosts[itemKey(raw)]=fullRecord(raw,{deleted:true,updatedAt:new Date().toISOString()});saveManualCosts();render();detail(id);$('#costSaveStatus').textContent='已在本机清空；点同步云端后其他设备也会清空'};
  $('#searchMainXianyu').onclick=()=>openImageSearch({kind:'item',id:item.id,title:item.title,image:item.image},'xianyu');
  $('#searchMainXhs').onclick=()=>openImageSearch({kind:'item',id:item.id,title:item.title,image:item.image},'xhs');
  if(!$('#detail').open)$('#detail').showModal();
}

function accountId(profileUrl){const id=profileUrl.match(/\/user\/([^/?#]+)/i)?.[1];return id?`account-${id.toLowerCase()}`:`account-${Date.now()}`}
function activePortalUsers(){return (data?.portalUsers||[]).filter(user=>user?.enabled!==false)}
function renderPortalUsers(){
  const section=$('#userAdminSection');section.hidden=currentUsername!=='admin';if(section.hidden)return;
  const users=activePortalUsers();
  $('#portalUsersList').innerHTML=users.length?users.map(user=>`<div class="userrow"><div><b>${escapeHtml(user.displayName)}</b> <code>${escapeHtml(user.username)}</code><small>${(user.accountIds||[]).length} 个店铺 · ${user.githubLogin?`已绑定 GitHub @${escapeHtml(user.githubLogin)}`:'首次同步时绑定 GitHub'}</small></div><div class="useractions">${user.githubLogin?`<button type="button" class="soft" data-unbind-user="${escapeHtml(user.username)}">解除 GitHub 绑定</button>`:''}<button type="button" class="dangersoft" data-delete-user="${escapeHtml(user.username)}">删除</button></div></div>`).join(''):'<p class="muted">还没有普通使用者。</p>';
  document.querySelectorAll('[data-unbind-user]').forEach(button=>button.onclick=async()=>{
    const username=button.dataset.unbindUser,now=new Date().toISOString();data.portalUsers=(data.portalUsers||[]).map(user=>user.username===username?{...user,githubLogin:'',updatedAt:now}:user);renderPortalUsers();$('#userStatus').textContent='正在生成解除绑定的加密同步请求…';await startCloudSync($('#userStatus'));
  });
  document.querySelectorAll('[data-delete-user]').forEach(button=>button.onclick=async()=>{
    const username=button.dataset.deleteUser,user=activePortalUsers().find(value=>value.username===username);if(!user||!confirm(`确认删除使用者“${user.displayName}（${username}）”？\n不会删除其 Yahoo 店铺，管理员仍可查看店铺数据。`))return;
    const now=new Date().toISOString();data.portalUsers=(data.portalUsers||[]).map(value=>value.username===username?{username,displayName:value.displayName,password:'',accountIds:value.accountIds||[],githubLogin:'',enabled:false,updatedAt:now}:value);renderPortalUsers();$('#userStatus').textContent='正在生成删除用户的加密同步请求…';await startCloudSync($('#userStatus'));
  });
}
function renderLocalAccounts(){
  const values=getLocal(),cloudManaged=new Set((data.managedAccounts||[]).map(item=>item.id));
  $('#localAccounts').innerHTML=values.length?values.map((item,index)=>`<div class="localrow"><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.profileUrl)}</small><small>${cloudManaged.has(item.id)?'已在云端':'等待同步'}</small></div><button data-remove="${index}" class="dangersoft">删除</button></div>`).join(''):'<p class="muted">还没有新增账号。</p>';
  document.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{const accounts=getLocal(),removed=accounts.splice(Number(button.dataset.remove),1)[0];saveLocal(accounts);if(cloudManaged.has(removed.id))saveDeleted([...getDeleted(),removed.id]);renderLocalAccounts();renderAccountOptions()});
}

$('#detail .close').onclick=()=>$('#detail').close();$('#detail').onclick=event=>{if(event.target===$('#detail'))$('#detail').close()};
$('#imageSearchDialog .close').onclick=()=>$('#imageSearchDialog').close();$('#imageSearchDialog').onclick=event=>{if(event.target===$('#imageSearchDialog'))$('#imageSearchDialog').close()};
$('#saveSearchImage').onclick=saveSearchImage;$('#openXianyu').onclick=()=>openMarketplace('xianyu');$('#openXhs').onclick=()=>openMarketplace('xhs');
$('#search').oninput=()=>{pricingPage=1;render()};$('#filter').onchange=()=>{pricingPage=1;render()};$('#accountSelect').onchange=event=>{currentAccountId=event.target.value;pricingPage=1;render()};
$('#showPricing').onclick=()=>switchView('pricing');$('#showDiscovery').onclick=()=>switchView('discovery');
$('#discoverySearch').oninput=renderDiscovery;$('#discoveryFilter').onchange=renderDiscovery;
$('#manageAccounts').onclick=()=>{
  renderLocalAccounts();renderPortalUsers();
  $('#notificationEmail').value=localStorage.getItem(notificationEmailKey(currentUsername))||data?.portalUser?.notificationEmail||data?.portalPreferences?.[currentUsername]?.notificationEmail||'';
  $('#accountDialog').showModal();
};$('#accountDialog .close').onclick=()=>$('#accountDialog').close();
$('#userForm').onsubmit=async event=>{
  event.preventDefault();if(currentUsername!=='admin')return;
  const displayName=$('#userDisplayName').value.trim(),username=$('#newUsername').value.trim().toLowerCase(),userPassword=$('#newUserPassword').value;
  if(!/^[a-z0-9_-]{1,48}$/.test(username)||username==='admin'){alert('用户名只能使用英文小写、数字、下划线或短横线，且不能使用 admin');return}
  if(userPassword.length<8){alert('密码至少需要 8 位');return}
  const existing=(data.portalUsers||[]).find(user=>user.username===username),record={...existing,username,displayName,password:userPassword,accountIds:existing?.accountIds||[],githubLogin:existing?.githubLogin||'',enabled:true,updatedAt:new Date().toISOString()};
  data.portalUsers=[...(data.portalUsers||[]).filter(user=>user.username!==username),record];event.target.reset();renderPortalUsers();$('#userStatus').textContent='用户已在本机加密，正在生成云端同步请求…';await startCloudSync($('#userStatus'));
};
$('#accountForm').onsubmit=event=>{
  event.preventDefault();const name=$('#accountName').value.trim(),profileUrl=$('#accountUrl').value.trim().replace(/\/+$/,'');
  if(!/^https:\/\/paypayfleamarket\.yahoo\.co\.jp\/user\/[^/?#]+$/i.test(profileUrl)){alert('请输入完整的 Yahoo!フリマ 卖家主页链接');return}
  const values=getLocal(),id=accountId(profileUrl),existing=values.find(item=>item.profileUrl===profileUrl);
  if(existing){existing.name=name;existing.updatedAt=new Date().toISOString()}else values.push({id,name,profileUrl,enabled:true,updatedAt:new Date().toISOString()});
  saveLocal(values);saveDeleted(getDeleted().filter(value=>value!==id));event.target.reset();renderLocalAccounts();renderAccountOptions();$('#copyStatus').textContent='已保存到本机；点“同步全部数据到云端”。';
};

async function gzipBytes(bytes){
  if(!('CompressionStream'in window))return bytes;
  const stream=new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function encryptPayload(value){
  const input=await gzipBytes(new TextEncoder().encode(JSON.stringify(value))),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:180000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt']);
  const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,tagLength:128},key,input)),body=sealed.slice(0,-16),tag=sealed.slice(-16);
  const output=new Uint8Array(48+body.length);output.set(new TextEncoder().encode('PG01'));output.set(salt,4);output.set(iv,20);output.set(tag,32);output.set(body,48);
  let binary='';for(let offset=0;offset<output.length;offset+=0x8000)binary+=String.fromCharCode(...output.subarray(offset,offset+0x8000));
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
function syncCosts(){
  const output={};
  const compact=(key,record)=>({deleted:Boolean(record.deleted),purchaseCNY:numberOrNull(record.purchaseCNY),manualFeeCNY:numberOrNull(record.manualFeeCNY),shippingJPY:numberOrNull(record.shippingJPY),updatedAt:record.updatedAt,accountId:record.accountId,itemId:record.itemId||'',identityKeys:[...new Set([key,...(record.identityKeys||[])])].slice(0,4)});
  for(const [key,record] of Object.entries(manualCosts))if(record&&(record.deleted||[record.purchaseCNY,record.manualFeeCNY,record.shippingJPY].some(value=>Number.isFinite(numberOrNull(value)))))output[key]=compact(key,record);
  for(const item of data.items||[]){const record=manualFor(item);if(record&&[record.purchaseCNY,record.manualFeeCNY,record.shippingJPY].some(value=>Number.isFinite(numberOrNull(value)))){const key=itemKey(item);output[key]=compact(key,fullRecord(item,record))}}
  return output;
}
async function startCloudSync(statusElement=$('#cloudSyncStatus')){
  const popup=window.open('about:blank','_blank');
  const report=message=>{if(statusElement)statusElement.textContent=message;$('#refreshNotice').hidden=false;$('#refreshText').textContent=message};
  try{
    report('正在本机加密成本、账号和已上传记录…');
    const deleted=new Set(getDeleted()),byProfile=new Map();
    for(const item of [...(data.managedAccounts||[]),...getLocal()])if(item?.profileUrl&&!deleted.has(item.id))byProfile.set(item.profileUrl,{...item,enabled:true});
    const notificationEmail=String(localStorage.getItem(notificationEmailKey(currentUsername))||data?.portalUser?.notificationEmail||data?.portalPreferences?.[currentUsername]?.notificationEmail||'').trim().toLowerCase();
    const payload={version:1,issuedAt:new Date().toISOString(),notificationEmail,manualCosts:syncCosts(),dismissedDiscoveries,discoveryReviews,managedAccounts:[...byProfile.values()],deletedAccountIds:[...deleted],
      ...(currentUsername==='admin'?{portalUsers:data.portalUsers||[]}:{})};
    const ciphertext=await encryptPayload(payload),body=`<!-- PRICE_GUARD_SYNC_V1\n${ciphertext}\n-->\n\n这是一份由价格守卫生成的端到端加密同步数据。请勿修改上方密文。`;
    const title=`[Price Guard Sync:${currentUsername}] ${new Date().toLocaleString('zh-CN')}`;
    await navigator.clipboard?.writeText(body).catch(()=>{});
    const prefilled=`https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    const target=prefilled.length<7000?prefilled:`https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}`;
    if(popup)popup.location.href=target;else window.open(target,'_blank','noopener');
    report(prefilled.length<7000?'已打开 GitHub；点绿色“Submit new issue”后，请等待 Issue 显示“已安全合并”，系统会优先发布登录数据。':'密文已复制；请粘贴后提交，并等待 Issue 显示“已安全合并”。');
  }catch(error){popup?.close();report(`生成失败：${error.message||error}`)}
}

$('#cloudSync').onclick=()=>startCloudSync($('#cloudSyncStatus'));
$('#syncAll').onclick=()=>startCloudSync($('#cloudSyncStatus'));
$('#notificationForm').onsubmit=async event=>{
  event.preventDefault();const email=$('#notificationEmail').value.trim().toLowerCase();
  localStorage.setItem(notificationEmailKey(currentUsername),email);
  $('#notificationStatus').textContent='邮箱已在本机保存，正在生成加密同步请求…';
  await startCloudSync($('#notificationStatus'));
};
$('#exportAccounts').onclick=async()=>{const accounts=[...cloudAccounts().map(item=>({id:item.id,name:item.name,profileUrl:item.profileUrl,enabled:true})),...getLocal()];await navigator.clipboard.writeText(JSON.stringify({version:1,accounts},null,2));$('#copyStatus').textContent='账号配置已复制。'};
function downloadJson(value,filename){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('#exportCosts').onclick=()=>downloadJson({version:2,exportedAt:new Date().toISOString(),manualCosts},`价格守卫_手工成本_${new Date().toISOString().slice(0,10)}.json`);
$('#importCosts').onclick=()=>$('#costFile').click();
$('#costFile').onchange=async event=>{try{const parsed=JSON.parse(await event.target.files[0].text()),incoming=parsed.manualCosts||parsed;if(!incoming||Array.isArray(incoming)||typeof incoming!=='object')throw Error('格式错误');manualCosts=mergeCosts(manualCosts,incoming);saveManualCosts();render();$('#costTransferStatus').textContent='已导入本机；点同步云端后可在其他设备使用。'}catch{$('#costTransferStatus').textContent='导入失败：文件格式不正确。'}finally{event.target.value=''}};

$('#excel').onclick=async()=>{try{const bytes=await decryptFile(`${dataPrefix}/latest.xlsx.enc`,password),url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})),link=document.createElement('a');link.href=url;link.download=`价格守卫_${currentUsername}_${new Date(data.checkedAt).toISOString().slice(0,10)}.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch{alert('Excel 解密失败')}};
$('#help').onclick=()=>$('#helpDialog').showModal();$('#helpDialog .close').onclick=()=>$('#helpDialog').close();$('#helpDialog').onclick=event=>{if(event.target===$('#helpDialog'))$('#helpDialog').close()};

async function fetchStatus(){const response=await fetch(`${dataPrefix}/status.json?t=${Date.now()}`,{cache:'no-store'});if(!response.ok)throw Error('状态读取失败');return response.json()}
async function fetchDiscoveryStatus(){const response=await fetch(`data/discovery-status.json?t=${Date.now()}`,{cache:'no-store'});if(!response.ok)throw Error('选品状态读取失败');return response.json()}
async function checkCloudStatus(reload=true){
  if(refreshingData)return;
  try{
    const [status,nextDiscoveryStatus]=await Promise.all([fetchStatus(),fetchDiscoveryStatus().catch(()=>null)]);cloudStatus=status;
    if(!data){const date=new Date(status.checkedAt);$('#stamp').textContent=`云端检查：${Number.isNaN(date.valueOf())?'等待首次检查':date.toLocaleString('zh-CN')} · 约每 20 分钟`;return}
    if(reload&&status.dataRevision&&status.dataRevision!==data.dataRevision){
      refreshingData=true;await loadDashboard();renderAccountOptions();render();if(!$('#discoveryView').hidden)renderDiscovery();$('#refreshNotice').hidden=false;$('#refreshText').textContent='云端数据已自动更新，无需重新打开页面。';setTimeout(()=>$('#refreshNotice').hidden=true,8000);
    }else if(reload&&nextDiscoveryStatus?.checkedAt&&nextDiscoveryStatus.checkedAt!==discoveryCloudStatus?.checkedAt){
      refreshingData=true;await loadDiscovery();if(!$('#discoveryView').hidden)renderDiscovery();$('#refreshNotice').hidden=false;$('#refreshText').textContent='云端选品数据已自动更新。';setTimeout(()=>$('#refreshNotice').hidden=true,8000);
    }
    discoveryCloudStatus=nextDiscoveryStatus;
  }catch{}finally{refreshingData=false}
}
setInterval(()=>checkCloudStatus(true),60_000);addEventListener('focus',()=>checkCloudStatus(true));addEventListener('pageshow',()=>checkCloudStatus(true));document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkCloudStatus(true)});

addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('#install').hidden=false});$('#install').onclick=async()=>{await installPrompt?.prompt();$('#install').hidden=true};
if('serviceWorker'in navigator){
  const hadController=Boolean(navigator.serviceWorker.controller);let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController&&!reloading){reloading=true;location.reload()}});
  navigator.serviceWorker.register('sw.js?v=17',{updateViaCache:'none'}).then(registration=>registration.update()).catch(()=>{});
}
checkCloudStatus(false);
