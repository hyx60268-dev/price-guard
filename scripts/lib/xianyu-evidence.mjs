// A search card (or a recommendation below a blocked detail) is not a verified
// offer. Keep this contract shared by the scanner, cache and discovery pipeline.
export const XIANYU_VERIFICATION = 'shared_offer_identity_detail_v11';

export function positivePrice(value) {
  if(value===null||value===undefined||String(value).trim()==='')return null;
  const number=Number(value);return Number.isFinite(number)&&number>0?number:null;
}

export function detailStateFailure(state={}) {
  if(state.blocked)return 'detail_blocked';
  if(state.loginVisible)return 'detail_login_required';
  if(state.unavailable)return 'detail_unavailable';
  if(state.networkError)return 'detail_network_error';
  if(!state.titles?.length||!state.text?.trim())return 'detail_unreadable';
  if(state.priceRange)return 'detail_multi_price';
  if(!positivePrice(state.price))return 'detail_price_unconfirmed';
  if(!state.sellerKey)return 'detail_seller_unconfirmed';
  if(!state.images?.length)return 'detail_images_unconfirmed';
  return null;
}

export function verifiedCostEvidence(samples=[]) {
  const sellers=new Map(),ids=new Set();
  for(const sample of samples){
    const price=positivePrice(sample.price);
    const id=sample.id||sample.url;
    if(!id||ids.has(id)||!sample.sellerKey||sample.priceSource!=='target_detail'||!price)continue;
    ids.add(id);
    // One seller cannot vote multiple times in the market median.
    if(!sellers.has(sample.sellerKey))sellers.set(sample.sellerKey,{...sample,price});
  }
  const verified=[...sellers.values()],prices=verified.map(row=>row.price).sort((a,b)=>a-b),mid=Math.floor(prices.length/2);
  const median=prices.length?(prices.length%2?prices[mid]:(prices[mid-1]+prices[mid])/2):null;
  const spread=prices.length>=2?(prices.at(-1)-prices[0])/median:Infinity;
  return {samples:verified,sellerCount:sellers.size,priceSpread:spread,ready:sellers.size>=2&&spread<=.30,median};
}

// Observed PC layout (2026-09-24): item-main-info contains desc--*, not an
// h1/itemTitle. Scope every field to the target components; recommendations,
// site metadata and header prices must never complete a target offer.
export function readXianyuDetailDOM() {
  const visible=element=>{for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0'||node.hidden)return false}const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0};
  const first=selector=>[...document.querySelectorAll(selector)].find(visible);
  const main=first('[class*="item-main-info--"]');
  const gallery=first('[class*="item-main-window--"]');
  const sellerRoot=first('[class*="item-user-container--"]');
  const description=main&&[...main.querySelectorAll('[class^="desc--"], [class*=" desc--"]')].find(visible);
  const rawDescription=(description?.innerText||'').trim();
  const text=rawDescription.replace(/\s+/g,' ').trim().slice(0,6500);
  const pageText=(document.body?.innerText||'').split(/为你推荐|猜你喜欢|相关推荐/)[0];
  const challengeFrame=[...document.querySelectorAll('iframe')].some(frame=>visible(frame)&&/baxia|captcha|_____tmd_____|\/punish/i.test(`${frame.id} ${frame.getAttribute('src')||''}`));
  const challengeText=(pageText.match(/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆|drag the slider|verify you are human/i)||[])[0]||null;
  const blocked=challengeFrame||Boolean(challengeText);
  const loginNodes=[...document.querySelectorAll('iframe[src*="login"],[role="dialog"][class*="login" i],[class*="notloginMask--"]')].filter(visible);
  const loginVisible=loginNodes.length>0;
  const loginSurfaces=loginNodes.map(n=>({tag:n.tagName,kind:n.tagName==='IFRAME'?'login_frame':n.getAttribute('role')==='dialog'?'login_dialog':'detail_mask'}));
  const unavailable=Boolean(first('[class*="empty-container--"]'))&&/宝贝被删|已下架|不存在/.test(pageText);
  const networkError=Boolean(first('[class*="error-container--"]'));
  // The app sets document.title from itemDO.title. Only use it when the actual
  // description is present, never as a substitute for an inaccessible detail.
  const pageTitle=/_闲鱼$/.test(document.title)?document.title.replace(/_闲鱼$/,'').trim():'';
  // Browser title often stops at the first newline, before the character/model.
  // Use only the target description's opening paragraph; never search-card text.
  const descriptionTitle=rawDescription.split(/\n\s*\n|(?:^|\n)\s*(?:tag|标签|关联词|搜索词)[:：\s]/i)[0].replace(/\s+/g,' ').trim().slice(0,220);
  const titles=text?[...new Set([pageTitle,descriptionTitle].filter(Boolean))]:[];
  const images=gallery?[...gallery.querySelectorAll('img')].filter(visible).filter(image=>{const r=image.getBoundingClientRect();return r.width>=120&&r.height>=120}).map(image=>image.currentSrc||image.src).filter(Boolean):[];
  const priceRange=Boolean(main&&[...main.querySelectorAll('[class^="price--"],[class*=" price--"]')].filter(visible).some(node=>/^\d+(?:\.\d{1,2})?[-–~至]\d+(?:\.\d{1,2})?$/.test((node.innerText||'').replace(/[¥￥,\s]/g,''))));
  const prices=main?[...new Set([...main.querySelectorAll('[class^="price--"],[class*=" price--"]')].filter(visible)
    .map(node=>(node.innerText||'').replace(/[¥￥,\s]/g,''))
    .filter(value=>/^\d+(?:\.\d{1,2})?$/.test(value)).map(Number).filter(value=>value>0))]:[];
  const seller=sellerRoot&&[...sellerRoot.querySelectorAll('a[href*="/personal"]')].find(visible);
  let sellerKey='';
  if(seller){const url=new URL(seller.href,location.href);const id=url.searchParams.get('userId');if(id&&/^\d+$/.test(id))sellerKey=`goofish:${id}`}
  const optionCount=main?[...main.querySelectorAll('[role="radio"],[class*="sku" i] button,[class*="spec" i] button')].filter(visible).length:0;
  return {text,titles,priceRange,images:[...new Set(images)].slice(0,16),price:prices.length===1?prices[0]:null,sellerKey,optionCount,blocked,loginVisible,unavailable,networkError,
    diagnostic:{challengeFrame,challengeText,loginVisible,loginSurfaces,networkError,mainFound:Boolean(main),descriptionLength:text.length,galleryFound:Boolean(gallery),imageCount:images.length,priceCount:prices.length,priceRange,sellerFound:Boolean(sellerKey)}};
}

// Search navigation contains ordinary login buttons and readable notLogin*
// containers. Only an active authentication surface makes search inaccessible.
export function readXianyuSearchDOM(){
 const visible=element=>{for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0'||node.hidden)return false}const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0};
 const text=(document.body?.innerText||'').replace(/\s+/g,' ');
 const loginNodes=[...document.querySelectorAll('iframe[src*="login"],[role="dialog"][class*="login" i],[class*="notloginMask--"]')].filter(visible);
 const loginSurfaces=loginNodes.map(n=>({tag:n.tagName,kind:n.tagName==='IFRAME'?'login_frame':n.getAttribute('role')==='dialog'?'login_dialog':'detail_mask'}));
 const challengeFrame=[...document.querySelectorAll('iframe')].some(frame=>visible(frame)&&/baxia|captcha|_____tmd_____|\/punish/i.test(frame.id+' '+(frame.getAttribute('src')||'')));
 const challengeText=(text.match(/访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆|drag the slider|verify you are human/i)||[])[0]||null;
 const loginVisible=loginNodes.length>0,blocked=challengeFrame||Boolean(challengeText);
 return {loginVisible,blocked,noResults:/没有找到你想要的宝贝|减少筛选内容试试/.test(text),diagnostic:{loginVisible,loginSurfaces,challengeFrame,challengeText}};
}

export async function readSettledXianyuSearch(page,{delay=2000}={}){
 const state=await page.evaluate(readXianyuSearchDOM);
 if(state.blocked||!state.loginVisible)return state;
 await page.waitForTimeout(delay);
 return page.evaluate(readXianyuSearchDOM);
}

// Logs contain structural access evidence, never cookies, HTML or login URLs.
export function xianyuAccessDiagnostic(result={}){
 const fields=['loginVisible','challengeFrame','networkError','mainFound','galleryFound','sellerFound','priceRange','imageCount','priceCount','descriptionLength'];
 const diagnostic=value=>Object.fromEntries([...fields.filter(k=>['number','boolean'].includes(typeof value?.[k])).map(k=>[k,value[k]]),['loginSurfaces',(value?.loginSurfaces||[]).filter(s=>['login_frame','login_dialog','detail_mask'].includes(s.kind)).map(s=>({kind:s.kind}))]]);
 return {status:result.status,cardCount:result.cardCount||0,detailCheckedCount:result.detailCheckedCount||0,accessibleDetailCount:result.accessibleDetailCount||0,
  search:diagnostic(result.searchDiagnostic),details:(result.rejected||[]).filter(r=>/^detail_(blocked|login_required|network_error|error)$/.test(r.reason||'')).map(r=>({reason:r.reason,...diagnostic(r.diagnostic)}))};
}

// A restored session may hydrate after the initial login shell is rendered.
// Wait for two consecutive login observations; never dismiss or modify it.
// Challenges stop immediately. Acceptance still requires every target field.
export async function readSettledXianyuDetail(page,{attempts=5,delay=2000}={}){
 let state={},loginObservations=0;
 for(let attempt=0;attempt<attempts;attempt++){
  state=await page.evaluate(readXianyuDetailDOM);
  loginObservations=state.loginVisible?loginObservations+1:0;
  if(state.blocked||state.unavailable||state.networkError||loginObservations>=2||!detailStateFailure(state))break;
  if(attempt<attempts-1)await page.waitForTimeout(delay);
 }
 return state;
}

// A technical failure is retryable, not a completed negative identity review.
export function xianyuResultStatus(checks=[],{ready=false,cardCount=0,searchLoginRequired=false}={}) {
  if(checks.some(row=>row.reason==='detail_blocked'))return 'blocked';
  // One deep link can demand login even while the session can still read other
  // public details. Only the search page itself or two independent details may
  // trip the global access circuit for every listing.
  if(searchLoginRequired||checks.filter(row=>row.reason==='detail_login_required').length>=2)return 'login_required';
  if(ready)return 'ok';
  if(checks.some(row=>/^detail_(?:login_required|unreadable|price_unconfirmed|seller_unconfirmed|images_unconfirmed|network_error|error)$/.test(row.reason||'')))return 'detail_inaccessible';
  return cardCount?'manual_review':'page_empty';
}

export function completedXianyuReview(cost={}) {
  return cost.verification===XIANYU_VERIFICATION&&['ok','manual_review','page_empty'].includes(cost.status);
}

// Every check is still the full physical-offer verifier. Stop as soon as the
// existing independent-seller contract is met; extra reads can only add load.
export async function collectXianyuDetails(candidates, verify, coherent = rows => rows) {
  const checks=[], accepted=[];let detailLoginFailures=0;
  for(const candidate of candidates){
    const check=await verify(candidate);checks.push(check);
    if(check.reason==='detail_blocked')break;
    if(check.reason==='detail_login_required'&&++detailLoginFailures>=2)break;
    if(check.accepted)accepted.push({...candidate,...check});
    if(verifiedCostEvidence(coherent(accepted)).ready)break;
  }
  return checks;
}

// Japan-import middlemen already fail the detail offer guard. Exclude their
// explicitly labelled search cards before spending scarce detail requests.
export function xianyuSearchExclusion(card={}) {
  const title=String(card.title||'');
  if(/日本代购|煤炉代购/i.test(title))return 'japan_import_not_procurement';
  if(/自选(?:款式|角色|图案)|多款可选|任选款式|拍下改价|私聊改价|标价非实价/.test(title))return 'explicit_multi_variant_card';
  const price=String(card.priceText||'').replace(/[¥￥,\s]/g,'');
  if(/^\d+(?:\.\d{1,2})?[-–~至]\d+(?:\.\d{1,2})?$/.test(price))return 'explicit_price_range_card';
  return null;
}
