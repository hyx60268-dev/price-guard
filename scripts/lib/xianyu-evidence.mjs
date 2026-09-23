// A search card (or a recommendation below a blocked detail) is not a verified
// offer. Keep this contract shared by the scanner, cache and discovery pipeline.
export const XIANYU_VERIFICATION = 'shared_offer_identity_detail_v7';

export function positivePrice(value) {
  if(value===null||value===undefined||String(value).trim()==='')return null;
  const number=Number(value);return Number.isFinite(number)&&number>0?number:null;
}

export function detailStateFailure(state={}) {
  if(state.blocked)return 'detail_blocked';
  if(state.loginVisible)return 'detail_login_required';
  if(!state.titles?.length||!state.text||state.text.length<20)return 'detail_unreadable';
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

// This function is serialized into the page. Never inspect recommendations as
// the current item's title, photos, price or seller. Cross-origin challenge
// frames do not expose their text through document.body.innerText.
export function readXianyuDetailDOM() {
  const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0};
  const body=document.body;
  const boundary=[...body.querySelectorAll('p,h1,h2,h3,div')].find(node=>/^(?:为你推荐|猜你喜欢|相关推荐)$/.test((node.innerText||'').trim()));
  const belongs=element=>visible(element)&&!element.closest('header,footer,nav,a[href*="/item?"]')&&
    (!boundary||(!element.contains(boundary)&&Boolean(element.compareDocumentPosition(boundary)&Node.DOCUMENT_POSITION_FOLLOWING)));
  const text=(body.innerText||'').split(/为你推荐|猜你喜欢|相关推荐/)[0].replace(/\s+/g,' ').slice(0,6500);
  const blocked=[...document.querySelectorAll('iframe')].some(frame=>visible(frame)&&/baxia|captcha|_____tmd_____|\/punish/i.test(`${frame.id} ${frame.getAttribute('src')||''}`))||
    /访问频繁|安全验证|滑块|验证码|请稍后重试|被挤爆|drag the slider|verify you are human/i.test(text);
  const loginVisible=[...document.querySelectorAll('iframe[src*="login"],[role="dialog"][class*="login" i]')].some(visible);
  const titles=[document.querySelector('meta[property="og:title"]')?.content,
    ...[...body.querySelectorAll('h1,[class*="itemTitle" i],[class*="detailTitle" i]')].filter(belongs).map(node=>node.innerText)]
    .filter(Boolean).map(value=>value.replace(/\s+/g,' ').trim()).filter(value=>value.length>=3&&!/^(?:闲鱼|为你推荐|猜你喜欢|相关推荐)(?:\s|$)/.test(value));
  const images=[...body.querySelectorAll('img')].filter(belongs).filter(image=>{const rect=image.getBoundingClientRect();return rect.width>=120&&rect.height>=120}).map(image=>image.currentSrc||image.src).filter(Boolean);
  const priceValues=[...body.querySelectorAll('[data-price],[class*="price" i]')].filter(belongs).filter(node=>!/original|old|origin|del|shipping/i.test(String(node.className)))
    .map(node=>(node.getAttribute('data-price')||node.innerText||'').replace(/[¥￥,\s]/g,'')).filter(value=>/^\d+(?:\.\d{1,2})?$/.test(value)).map(Number).filter(value=>value>0);
  const prices=[...new Set(priceValues)];
  const seller=[...body.querySelectorAll('a[href*="/personal"],a[href*="/user"],a[href*="seller"]')].find(belongs);
  let sellerKey='';
  if(seller){const url=new URL(seller.href,location.href);const id=url.searchParams.get('userId')||url.searchParams.get('userid')||url.searchParams.get('id')||url.pathname.match(/\/(?:user|seller)\/(\w+)/)?.[1];if(id)sellerKey=`goofish:${id}`}
  const optionCount=[...body.querySelectorAll('[role="radio"],[class*="sku" i] button,[class*="spec" i] button')].filter(belongs).length;
  return {text,titles:[...new Set(titles)],images:[...new Set(images)].slice(0,16),price:prices.length===1?prices[0]:null,sellerKey,optionCount,blocked,loginVisible};
}
