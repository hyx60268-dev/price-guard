// A search card (or a recommendation below a blocked detail) is not a verified
// offer. Keep this contract shared by the scanner, cache and discovery pipeline.
export const XIANYU_VERIFICATION = 'shared_offer_identity_detail_v8';

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
  const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
  const first=selector=>[...document.querySelectorAll(selector)].find(visible);
  const main=first('[class*="item-main-info--"]');
  const gallery=first('[class*="item-main-window--"]');
  const sellerRoot=first('[class*="item-user-container--"]');
  const description=main&&[...main.querySelectorAll('[class^="desc--"], [class*=" desc--"]')].find(visible);
  const text=(description?.innerText||'').replace(/\s+/g,' ').trim().slice(0,6500);
  const pageText=(document.body?.innerText||'').split(/为你推荐|猜你喜欢|相关推荐/)[0];
  const blocked=[...document.querySelectorAll('iframe')].some(frame=>visible(frame)&&/baxia|captcha|_____tmd_____|\/punish/i.test(`${frame.id} ${frame.getAttribute('src')||''}`))||
    /访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆|drag the slider|verify you are human/i.test(pageText);
  const loginVisible=Boolean(first('iframe[src*="login"],[role="dialog"][class*="login" i],[class*="notloginMask--"]'));
  const unavailable=Boolean(first('[class*="empty-container--"]'))&&/宝贝被删|已下架|不存在/.test(pageText);
  const networkError=Boolean(first('[class*="error-container--"]'));
  // The app sets document.title from itemDO.title. Only use it when the actual
  // description is present, never as a substitute for an inaccessible detail.
  const pageTitle=/_闲鱼$/.test(document.title)?document.title.replace(/_闲鱼$/,'').trim():'';
  const titles=text?[pageTitle||text.slice(0,220)]:[];
  const images=gallery?[...gallery.querySelectorAll('img')].filter(visible).filter(image=>{const r=image.getBoundingClientRect();return r.width>=120&&r.height>=120}).map(image=>image.currentSrc||image.src).filter(Boolean):[];
  const prices=main?[...new Set([...main.querySelectorAll('[class^="price--"],[class*=" price--"]')].filter(visible)
    .map(node=>(node.innerText||'').replace(/[¥￥,\s]/g,''))
    .filter(value=>/^\d+(?:\.\d{1,2})?$/.test(value)).map(Number).filter(value=>value>0))]:[];
  const seller=sellerRoot&&[...sellerRoot.querySelectorAll('a[href*="/personal"]')].find(visible);
  let sellerKey='';
  if(seller){const url=new URL(seller.href,location.href);const id=url.searchParams.get('userId');if(id&&/^\d+$/.test(id))sellerKey=`goofish:${id}`}
  const optionCount=main?[...main.querySelectorAll('[role="radio"],[class*="sku" i] button,[class*="spec" i] button')].filter(visible).length:0;
  return {text,titles,images:[...new Set(images)].slice(0,16),price:prices.length===1?prices[0]:null,sellerKey,optionCount,blocked,loginVisible,unavailable,networkError,
    diagnostic:{mainFound:Boolean(main),descriptionLength:text.length,galleryFound:Boolean(gallery),imageCount:images.length,priceCount:prices.length,sellerFound:Boolean(sellerKey)}};
}

// A technical failure is retryable, not a completed negative identity review.
export function xianyuResultStatus(checks=[],{ready=false,cardCount=0}={}) {
  if(checks.some(row=>row.reason==='detail_blocked'))return 'blocked';
  if(checks.some(row=>row.reason==='detail_login_required'))return 'login_required';
  if(ready)return 'ok';
  if(checks.some(row=>/^detail_(?:unreadable|price_unconfirmed|seller_unconfirmed|images_unconfirmed|network_error|error)$/.test(row.reason||'')))return 'detail_inaccessible';
  return cardCount?'manual_review':'page_empty';
}

export function completedXianyuReview(cost={}) {
  return cost.verification===XIANYU_VERIFICATION&&['ok','manual_review','page_empty'].includes(cost.status);
}

// Every check is still the full physical-offer verifier. Stop as soon as the
// existing independent-seller contract is met; extra reads can only add load.
export async function collectXianyuDetails(candidates, verify, coherent = rows => rows) {
  const checks=[], accepted=[];
  for(const candidate of candidates){
    const check=await verify(candidate);checks.push(check);
    if(['detail_blocked','detail_login_required'].includes(check.reason))break;
    if(check.accepted)accepted.push({...candidate,...check});
    if(verifiedCostEvidence(coherent(accepted)).ready)break;
  }
  return checks;
}

// Japan-import middlemen already fail the detail offer guard. Exclude their
// explicitly labelled search cards before spending scarce detail requests.
export function xianyuSearchExclusion(card={}) {
  return /日本代购|煤炉代购/i.test(String(card.title||''))?'japan_import_not_procurement':null;
}
