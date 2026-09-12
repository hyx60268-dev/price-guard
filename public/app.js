const $=selector=>document.querySelector(selector);
const money=value=>Number.isFinite(value)?`¥${Math.round(value).toLocaleString()}`:'—';
const cny=value=>Number.isFinite(value)?`¥${Number(value).toFixed(1)}`:'—';
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const numberOrNull=value=>value===''||value===null||value===undefined?null:(Number.isFinite(Number(value))?Number(value):null);

let data,password,installPrompt,currentAccountId;
const accountKey='priceGuard.localAccounts.v1';
const costKey='priceGuard.manualCosts.v1';
const getJson=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback))}catch{return fallback}};
const getLocal=()=>getJson(accountKey,[]);
const saveLocal=value=>localStorage.setItem(accountKey,JSON.stringify(value));
let manualCosts=getJson(costKey,{});
const saveManualCosts=()=>localStorage.setItem(costKey,JSON.stringify(manualCosts));

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

async function loadDashboard(){
  const plain=await decryptFile('data/latest.json.enc',password);
  data=JSON.parse(new TextDecoder().decode(plain));
  if(!data.accounts)data.accounts=[{id:'default',name:data.seller||'默认账号',profileUrl:data.profile||'',profileStatus:'cached',items:data.items||[]}];
  if(!currentAccountId||!data.accounts.some(account=>account.id===currentAccountId))currentAccountId=data.accounts[0]?.id;
}

$('#unlockForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.submitter;button.disabled=true;$('#unlockError').textContent='正在解密…';
  try{
    password=$('#password').value;
    await loadDashboard();
    $('#unlock').hidden=true;$('#dashboard').hidden=false;
    renderAccountOptions();render();
  }catch(error){$('#unlockError').textContent='密码不正确，或云端尚未生成数据。'}
  finally{button.disabled=false}
});

function account(){return data.accounts.find(item=>item.id===currentAccountId)||data.accounts[0]}
function rawItems(){return account()?.items||[]}
function itemKey(item){return `${item.accountId||account()?.id||'default'}:${item.id}`}
function manualFor(item){return manualCosts[itemKey(item)]||{}}

function clientAdvice({ownPrice,recommendedPrice,costJPY}){
  if(!Number.isFinite(costJPY))return '待输入成本';
  const current=ownPrice-costJPY,after=recommendedPrice-costJPY,warning=data.settings.profitWarningJPY;
  if(after<0)return '调价后亏损';
  if(after<warning)return '不建议按推荐价出售';
  if(current<warning)return '建议提价或控制成本';
  return '利润正常';
}

function effective(item,temporary){
  const saved=temporary||manualFor(item);
  const manualPurchaseCNY=numberOrNull(saved.purchaseCNY);
  const purchaseCNY=manualPurchaseCNY??numberOrNull(item.averageCNY);
  const manualFeeCNY=numberOrNull(saved.manualFeeCNY);
  const shippingJPY=numberOrNull(saved.shippingJPY);
  const complete=[purchaseCNY,manualFeeCNY,shippingJPY].every(Number.isFinite);
  const costJPY=complete?Math.ceil(((purchaseCNY+manualFeeCNY)*data.settings.exchangeRate+shippingJPY)*data.settings.costMultiplier):null;
  const currentProfitJPY=Number.isFinite(costJPY)?item.ownPrice-costJPY:null;
  const afterProfitJPY=Number.isFinite(costJPY)?item.recommendedPrice-costJPY:null;
  const currentUnder1500=Number.isFinite(currentProfitJPY)&&currentProfitJPY<data.settings.profitWarningJPY;
  const afterUnder1500=Number.isFinite(afterProfitJPY)&&afterProfitJPY<data.settings.profitWarningJPY;
  return {
    ...item,manualPurchaseCNY,purchaseCNY,manualFeeCNY,shippingJPY,costJPY,currentProfitJPY,afterProfitJPY,currentUnder1500,afterUnder1500,
    needsCostInput:!complete,advice:clientAdvice({ownPrice:item.ownPrice,recommendedPrice:item.recommendedPrice,costJPY}),
    effectiveCostSource:complete?(Number.isFinite(manualPurchaseCNY)?'人工采购价 + 手工费用':`${item.costSource==='live'?'闲鱼验证均价':'历史参考价'} + 手工费用`):'待补齐三个成本值'
  };
}

function items(){return rawItems().map(item=>effective(item))}
function stats(){
  const list=items();
  return [
    ['商品',list.length],
    ['建议调价',list.filter(item=>item.recommendedPrice<item.ownPrice).length],
    ['当前利润 < ¥1,500',list.filter(item=>item.currentUnder1500).length],
    ['调价后 < ¥1,500',list.filter(item=>item.afterUnder1500).length],
    ['待补成本',list.filter(item=>item.needsCostInput).length]
  ];
}
function pill(item){
  const tone=/亏损|不建议|控制成本/.test(item.advice)?'bad':item.needsCostInput||item.confidence!=='高'?'warn':'';
  return `<span class="pill ${tone}">${escapeHtml(item.advice)}</span>`;
}
function selected(){
  const query=$('#search').value.toLowerCase(),filter=$('#filter').value;
  return items().filter(item=>(item.title+item.xianyuQuery).toLowerCase().includes(query)&&(
    filter==='all'||filter==='reprice'&&item.recommendedPrice<item.ownPrice||filter==='low'&&item.afterUnder1500||
    filter==='input'&&item.needsCostInput||filter==='manual'&&item.confidence!=='高'
  ));
}
function statusCard(label,value,tone=''){return `<div class="status ${tone}"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`}

function renderAccountOptions(){
  const cloud=data.accounts.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  const local=getLocal().filter(item=>!data.accounts.some(accountItem=>accountItem.profileUrl===item.profileUrl)).map((item,index)=>`<option value="local:${index}">${escapeHtml(item.name)}（仅本机）</option>`).join('');
  $('#accountSelect').innerHTML=cloud+local;$('#accountSelect').value=currentAccountId;
}

function render(){
  if(String(currentAccountId).startsWith('local:')){
    const local=getLocal()[Number(currentAccountId.split(':')[1])];
    $('#profileLink').href=local?.profileUrl||'#';$('#accountSync').textContent='仅本机保存 · 尚未云端同步';
    $('#statusGrid').innerHTML=statusCard('Yahoo主页','等待同步','warn')+statusCard('Yahoo比价','未运行','warn')+statusCard('闲鱼成本','未运行','warn')+statusCard('手工成本','可在云端账号商品中填写','good');
    $('#kpis').innerHTML='';$('#rows').innerHTML='';$('#cards').innerHTML='';$('#empty').hidden=false;return;
  }
  const current=account(),list=items(),scan=current.scanStats||{};
  $('#stamp').textContent=`最近检查：${new Date(data.checkedAt).toLocaleString('zh-CN')} · 云端约每 20 分钟检查`;
  const login=data.login||{};
  $('#loginNotice').hidden=!(login.xianyuRequired||login.xianyuAuthExpired);
  $('#loginTitle').textContent=login.xianyuRequired?'闲鱼当前无法搜索':'闲鱼登录已失效，但已自动切换';
  $('#loginText').textContent=login.xianyuRequired?'需要降价的商品未能完成闲鱼搜索；请使用人工采购价输入框。':'系统已改用匿名搜索；无法可靠核验的商品会要求人工输入。';
  const changes=data.changes;$('#changeNotice').hidden=!changes?.hasChanges;
  $('#changeText').textContent=changes?.hasChanges?`本次共 ${changes.total} 项变化：新增 ${changes.added}、下架 ${changes.removed}、价格变化 ${changes.updated}。`:'';
  $('#profileLink').href=current.profileUrl;
  const delta=current.profileDelta||{added:[],removed:[],unchanged:list.length};
  $('#accountSync').textContent=current.profileStatus==='live'?`主页成功 · 新增 ${delta.added?.length||0} / 减少 ${delta.removed?.length||0}`:current.profileStatus==='error'?'主页失败，沿用上次清单':'沿用已保存商品清单';
  const yahooLive=list.filter(item=>item.yahooSource==='live').length;
  const savedCosts=list.filter(item=>!item.needsCostInput).length;
  $('#statusGrid').innerHTML=
    statusCard('Yahoo主页',current.profileStatus==='live'?`${list.length} 件在售`:'使用上次清单',current.profileStatus==='live'?'good':'warn')+
    statusCard('Yahoo比价',`${yahooLive}/${list.length} 实时`,yahooLive===list.length?'good':'warn')+
    statusCard('闲鱼按需检查',`需查 ${scan.xianyuRequested??list.filter(item=>item.needsXianyu).length} / 已跳过 ${scan.xianyuSkipped??0}`,data.login?.xianyuRequired?'bad':'good')+
    statusCard('手工成本',`已完整填写 ${savedCosts}/${list.length}`,savedCosts===list.length?'good':'warn');
  $('#kpis').innerHTML=stats().map(([label,value])=>`<div class="kpi"><strong>${value}</strong><span>${label}</span></div>`).join('');
  const shown=selected();$('#empty').hidden=shown.length>0;
  $('#rows').innerHTML=shown.map(item=>`<tr data-id="${escapeHtml(item.id)}"><td><div class="product"><img src="${escapeHtml(item.image)}" alt=""><b>${escapeHtml(item.title)}</b></div></td><td class="money">${money(item.ownPrice)}</td><td class="money">${money(item.lowestPrice)}</td><td class="money">${money(item.recommendedPrice)}</td><td>${cny(item.purchaseCNY)}</td><td class="money">${money(item.costJPY)}</td><td class="money ${item.afterUnder1500?'bad':''}">${money(item.afterProfitJPY)}</td><td>${pill(item)}</td></tr>`).join('');
  $('#cards').innerHTML=shown.map(item=>`<article class="mobile-card" data-id="${escapeHtml(item.id)}"><div class="mobile-head"><img src="${escapeHtml(item.image)}" alt=""><b>${escapeHtml(item.title)}</b></div><div class="mobile-prices"><div><small>我的售价</small>${money(item.ownPrice)}</div><div><small>建议价</small>${money(item.recommendedPrice)}</div><div><small>调价后利润</small><span class="${item.afterUnder1500?'bad':''}">${money(item.afterProfitJPY)}</span></div></div><div class="mobile-foot">${pill(item)}<span>查看并填写成本 ›</span></div></article>`).join('');
  document.querySelectorAll('[data-id]').forEach(element=>element.onclick=()=>detail(element.dataset.id));
}

function detail(id){
  const raw=rawItems().find(item=>item.id===id);if(!raw)return;
  const item=effective(raw),saved=manualFor(raw),samples=raw.xianyu?.samples||[];
  const rejected=raw.xianyu?.rejected||[];
  $('#detailBody').innerHTML=`
    <div class="detailhead"><img src="${escapeHtml(item.image)}" alt=""><div><h2>${escapeHtml(item.title)}</h2><p>${pill(item)}　同款匹配：${escapeHtml(item.confidence)}</p></div></div>
    <div class="detailgrid">
      <div><small>我的售价</small><br><b>${money(item.ownPrice)}</b></div><div><small>Yahoo最低</small><br><b>${money(item.lowestPrice)}</b></div>
      <div><small>建议价</small><br><b>${money(item.recommendedPrice)}</b></div><div><small>闲鱼验证均价</small><br><b>${cny(item.averageCNY)}</b></div>
      <div><small>当前成本</small><br><b id="previewCost">${money(item.costJPY)}</b></div><div><small>调价后利润</small><br><b id="previewProfit">${money(item.afterProfitJPY)}</b></div>
    </div>
    <section class="manualbox">
      <h3>由你确认成本</h3>
      <p class="muted">采购价留空时，系统会使用上面的“闲鱼验证均价”；若均价为空，请手工填写。人肉费和日本物流费不再自动判断。</p>
      <form id="manualCostForm" class="costform">
        <label><span>采购价（人民币）</span><input id="purchaseCNY" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(saved.purchaseCNY??'')}" placeholder="${Number.isFinite(item.averageCNY)?item.averageCNY.toFixed(1):'必须填写'}"></label>
        <label><span>人肉费（人民币）</span><input id="manualFeeCNY" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(saved.manualFeeCNY??'')}" placeholder="由你填写"></label>
        <label><span>日本物流费（日元）</span><input id="shippingJPY" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(saved.shippingJPY??'')}" placeholder="由你填写"></label>
        <div class="costactions"><button type="submit">保存并计算</button><button type="button" id="clearCost" class="soft">清空</button><span id="costSaveStatus"></span></div>
      </form>
      <p><small>公式：((采购价 + 人肉费) × ${data.settings.exchangeRate} + 日本物流费) × ${data.settings.costMultiplier}，向上取整。数据保存在当前浏览器。</small></p>
    </section>
    <p class="links"><a target="_blank" href="${escapeHtml(item.ownUrl)}">我的 Yahoo 商品</a><a target="_blank" href="${escapeHtml(item.lowestUrl||item.yahoo?.searchUrl)}">最低价/搜索结果</a><a target="_blank" href="${escapeHtml(item.xianyuSearchUrl)}">闲鱼搜索</a></p>
    <p><small>Yahoo来源：${escapeHtml(item.yahooSource||'—')} · 成本来源：${escapeHtml(item.effectiveCostSource)}</small></p>
    <h3>采用的闲鱼样本（${samples.length}）</h3>
    <ul class="samples">${samples.map(sample=>`<li><a target="_blank" href="${escapeHtml(sample.url||'#')}">${escapeHtml(sample.title||'同款样本')}</a><b>${cny(sample.price)}</b></li>`).join('')||'<li>没有达到“至少 2 个详情验证一致样本”，请人工填写采购价。</li>'}</ul>
    ${rejected.length?`<p class="muted">已排除 ${rejected.length} 个多规格、低价钩子或详情不一致候选。</p>`:''}`;

  const temporary=()=>({purchaseCNY:$('#purchaseCNY').value,manualFeeCNY:$('#manualFeeCNY').value,shippingJPY:$('#shippingJPY').value});
  const preview=()=>{const next=effective(raw,temporary());$('#previewCost').textContent=money(next.costJPY);$('#previewProfit').textContent=money(next.afterProfitJPY);$('#previewProfit').className=next.afterUnder1500?'bad':''};
  ['#purchaseCNY','#manualFeeCNY','#shippingJPY'].forEach(selector=>$(selector).addEventListener('input',preview));
  $('#manualCostForm').onsubmit=event=>{
    event.preventDefault();
    const values=temporary(),record={};
    for(const [key,value] of Object.entries(values)){const parsed=numberOrNull(value);if(Number.isFinite(parsed))record[key]=parsed}
    record.updatedAt=new Date().toISOString();manualCosts[itemKey(raw)]=record;saveManualCosts();render();detail(id);$('#costSaveStatus').textContent='已保存';
  };
  $('#clearCost').onclick=()=>{delete manualCosts[itemKey(raw)];saveManualCosts();render();detail(id);$('#costSaveStatus').textContent='已清空'};
  if(!$('#detail').open)$('#detail').showModal();
}

$('#detail .close').onclick=()=>$('#detail').close();
$('#detail').onclick=event=>{if(event.target===$('#detail'))$('#detail').close()};
$('#search').oninput=render;$('#filter').onchange=render;
$('#accountSelect').onchange=event=>{currentAccountId=event.target.value;render()};

$('#manageAccounts').onclick=()=>{renderLocalAccounts();$('#accountDialog').showModal()};
$('#accountDialog .close').onclick=()=>$('#accountDialog').close();
$('#accountForm').onsubmit=event=>{
  event.preventDefault();
  const name=$('#accountName').value.trim(),profileUrl=$('#accountUrl').value.trim();
  if(!/^https:\/\/paypayfleamarket\.yahoo\.co\.jp\/user\//.test(profileUrl)){alert('请输入 Yahoo!フリマ 卖家主页链接');return}
  const values=getLocal();values.push({id:`local-${Date.now()}`,name,profileUrl});saveLocal(values);event.target.reset();renderLocalAccounts();renderAccountOptions();
};
function renderLocalAccounts(){
  const values=getLocal();
  $('#localAccounts').innerHTML=values.length?values.map((item,index)=>`<div class="localrow"><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.profileUrl)}</small></div><button data-remove="${index}" class="dangersoft">删除</button></div>`).join(''):'<p class="muted">还没有本机新增账号。</p>';
  document.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{const items=getLocal();items.splice(Number(button.dataset.remove),1);saveLocal(items);renderLocalAccounts();renderAccountOptions()});
}
$('#exportAccounts').onclick=async()=>{
  const accounts=[...data.accounts.map(item=>({id:item.id,name:item.name,profileUrl:item.profileUrl,enabled:true})),...getLocal().map(item=>({id:item.id,name:item.name,profileUrl:item.profileUrl,enabled:true}))];
  await navigator.clipboard.writeText(JSON.stringify({version:1,accounts},null,2));$('#copyStatus').textContent='账号配置已复制。';
};

function downloadJson(value,filename){
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('#exportCosts').onclick=()=>downloadJson({version:1,exportedAt:new Date().toISOString(),manualCosts},`价格守卫_手工成本_${new Date().toISOString().slice(0,10)}.json`);
$('#importCosts').onclick=()=>$('#costFile').click();
$('#costFile').onchange=async event=>{
  try{
    const parsed=JSON.parse(await event.target.files[0].text()),incoming=parsed.manualCosts||parsed;
    if(!incoming||Array.isArray(incoming)||typeof incoming!=='object')throw Error('格式错误');
    manualCosts={...manualCosts,...incoming};saveManualCosts();render();$('#costTransferStatus').textContent='已导入并保存。';
  }catch(error){$('#costTransferStatus').textContent='导入失败：文件格式不正确。'}
  finally{event.target.value=''}
};

$('#excel').onclick=async()=>{
  try{
    const bytes=await decryptFile('data/latest.xlsx.enc',password),url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})),link=document.createElement('a');
    link.href=url;link.download=`价格守卫_${new Date(data.checkedAt).toISOString().slice(0,10)}.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){alert('Excel 解密失败')}
};

$('#help').onclick=()=>$('#helpDialog').showModal();
$('#helpDialog .close').onclick=()=>$('#helpDialog').close();
$('#helpDialog').onclick=event=>{if(event.target===$('#helpDialog'))$('#helpDialog').close()};
addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('#install').hidden=false});
$('#install').onclick=async()=>{await installPrompt?.prompt();$('#install').hidden=true};
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');
fetch(`data/status.json?t=${Date.now()}`,{cache:'no-store'}).then(response=>response.json()).then(status=>$('#stamp').textContent=`云端检查：${new Date(status.checkedAt).toLocaleString('zh-CN')} · 约每 20 分钟`).catch(()=>{});
