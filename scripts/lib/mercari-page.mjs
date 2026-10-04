// Public product DOM only. Recommendations and other shop products are never
// part of the target description, price, availability, or image evidence.
export function readMercariCards(document,{includeUnpriced=false}={}){
 const seen=new Set(),cards=[];
 for(const a of document.querySelectorAll('main a[href^="/item/"],main a[href^="/shops/product/"]')){
  const href=a.getAttribute('href').split('?')[0];if(seen.has(href))continue;seen.add(href);
  const img=a.querySelector('img'),text=(a.innerText||a.textContent||'').trim();
  const label=a.getAttribute('aria-label')||img?.alt||text;
  const title=label.replace(/の(?:画像|サムネイル).*$/,'').trim();
  const priceText=`${text} ${label}`,match=priceText.match(/[¥￥]\s*([\d,]+)/)||priceText.match(/([\d,]+)円/);
  const price=Number(match?.[1]?.replace(/,/g,''));
  if(title&&(price>0||includeUnpriced))cards.push({id:href.split('/').at(-1),url:`https://jp.mercari.com${href}`,title,price:price>0?price:null,image:img?.currentSrc||img?.src||'',itemStatus:/SOLD|売り切れ/i.test(label+' '+text)?'SOLD':'OPEN'});
 }
 const text=document.querySelector('main')?.innerText||document.querySelector('main')?.textContent||'';
 const empty=/該当する商品が見つかりません|検索条件に一致する商品がありません|検索結果はありません/.test(text);
 const hasMore=[...document.querySelectorAll('main a,main button')].some(n=>/^(次へ|次のページ|もっと見る)$/.test((n.innerText||n.textContent||'').trim())&&!n.disabled);
 return {cards,empty,hasMore:hasMore||cards.length>=40};
}
export function readMercariDetail(document){
 const article=document.querySelector('main article');if(!article)return null;
 const title=article.querySelector('h1')?.textContent?.trim()||'';
 const headings=[...article.querySelectorAll('h2,h3')];
 const field=name=>{
  const target=article.querySelector(name==='商品の説明'?'[data-testid="description"]':'[data-testid="'+name+'"]');
  if(target)return (target.innerText||target.textContent||'').trim();
  let n=headings.find(n=>n.textContent.trim()===name);
  for(let level=0;n&&n!==article&&level<4;level++,n=n.parentElement){
   const sibling=n.nextElementSibling;if(!sibling)continue;
   if(sibling.matches('h1,h2,h3')||sibling.querySelector('h1,h2,h3'))return '';
   return (sibling.innerText||sibling.textContent||'').trim();
  }
  return '';
 };
 const description=field('商品の説明'),condition=field('商品の状態');
 // The target price may precede h1 in the responsive DOM. Stop before the description,
 // so dimensions, shipping and unrelated shop recommendations cannot win.
 const nodes=[...article.querySelectorAll('*')],h1=article.querySelector('h1'),end=headings.find(n=>n.textContent.trim()==='商品の説明');
 const header=nodes.slice(0,nodes.indexOf(end));
 const targetPrices=[...article.querySelectorAll('[data-testid="price"]')].filter(n=>!n.closest('a'));
 // Overseas runners receive USD display prices; the explicit yen amount in
 // converted-currency-section is the original marketplace price, not a rate.
 const converted=article.querySelector('[data-testid="converted-currency-section"]');
 const yen=text=>Number(String(text||'').normalize('NFKC').match(/(?:¥|JPY)\s*([0-9][0-9,]*)/)?.[1]?.replace(/,/g,''));
 const originalJPY=yen(converted?.textContent);
 const parsedPrices=targetPrices.map(n=>yen(n.textContent)).filter(n=>Number.isFinite(n)&&n>0);
 const uniquePrices=[...new Set(parsedPrices)];
 const canonical=document.querySelector('link[rel="canonical"]')?.getAttribute('href');
 const metadataCurrency=document.querySelector('meta[name="product:price:currency"]')?.getAttribute('content');
 const metadataPrice=Number(document.querySelector('meta[name="product:price:amount"]')?.getAttribute('content'));
 const metadataJPY=canonical===document.location?.href?.split('?')[0]&&metadataCurrency==='JPY'&&metadataPrice>0?metadataPrice:null;
 const priceNode=header.find(n=>/^[¥￥]\s*[\d,]+$/.test(n.textContent.trim()));
 const visiblePrice=Number.isFinite(originalJPY)&&originalJPY>0?originalJPY:uniquePrices.length===1?uniquePrices[0]:uniquePrices.length>1?null:Number(priceNode?.textContent.replace(/[^\d]/g,''))||null;
 const price=uniquePrices.length>1||visiblePrice&&metadataJPY&&visiblePrice!==metadataJPY?null:visiblePrice||metadataJPY;
 const checkout=header.find(n=>n.tagName==='BUTTON'&&/購入手続きへ/.test(n.textContent)&&!n.disabled);
 const shippingText=field('送料')||field('配送料の負担');
 const shippingIncluded=/送料込み|出品者負担/.test(shippingText);
 const fixedShipping=/^[¥￥]\s*[\d,]+$/.test(shippingText)?Number(shippingText.replace(/[^\d]/g,'')):null;
 const shippingJPY=shippingIncluded?0:fixedShipping;
 // A comment author or recommended shop may precede the target seller link.
 // Prefer the explicit seller section and never resolve conflicting identities
 // by DOM order. Some responsive pages expose just one profile without a heading.
 const visible=node=>{for(let n=node;n&&n!==article.parentElement;n=n.parentElement){const style=document.defaultView?.getComputedStyle(n);if(n.hidden||n.getAttribute('aria-hidden')==='true'||style?.display==='none'||style?.visibility==='hidden'||style?.opacity==='0')return false}return true};
 const profile=anchor=>{try{const u=new URL(anchor.getAttribute('href'),document.location?.href||'https://jp.mercari.com');return u.origin==='https://jp.mercari.com'&&/^\/(?:user\/profile\/\d+|shops\/profile\/[A-Za-z0-9_-]+)\/?$/.test(u.pathname)?u.pathname.replace(/\/$/,''):null}catch{return null}};
 const profileLinks=[...article.querySelectorAll('a[href]')].filter(node=>visible(node)&&!node.closest('[data-testid="description"]')).map(node=>({node,id:profile(node)})).filter(row=>row.id);
 const kind=value=>/^(?:出品者|出品者情報|ショップ情報|販売者)$/.test(value)?'seller':/^(?:コメント|おすすめ|関連商品|この(?:出品者|ショップ)の商品|評価|レビュー)/.test(value)?'other':null;
 const regions=headings.filter(visible).map(node=>({node,kind:kind(node.textContent.trim())})).filter(row=>row.kind);
 const sellerRegions=regions.filter(row=>row.kind==='seller');
 const preceding=(a,b)=>Boolean(a.compareDocumentPosition(b)&4);
 const inSellerRegion=row=>{let region;for(const current of regions)if(preceding(current.node,row.node))region=current;return region?.kind==='seller'};
 const eligibleProfiles=sellerRegions.length?profileLinks.filter(inSellerRegion):regions.length?[]:profileLinks;
 const sellerIds=[...new Set(eligibleProfiles.map(row=>row.id))];
 const seller=sellerIds.length===1?eligibleProfiles.find(row=>row.id===sellerIds[0]).node:null;
 const sellerDiagnostic={status:seller?'confirmed':sellerIds.length>1?'ambiguous':profileLinks.length?'unscoped':'missing',
  scope:sellerRegions.length?'seller_section':regions.length?'no_seller_section':'unique_article',
  candidateCount:sellerIds.length,candidateIds:sellerIds.slice(0,4),articleProfileCount:profileLinks.length,observedProfileIds:[...new Set(profileLinks.map(row=>row.id))].slice(0,4)};
 const images=[...article.querySelectorAll('[aria-label^="商品画像"] img,[aria-label^="商品サムネイル"] img')].map(n=>n.currentSrc||n.src).filter(Boolean);
 const publicShipping=[];
 // Diagnostics only: inspect publicly embedded target-product state, never
 // cookies, credentials, or unrelated account state.
 const targetId=document.location?.pathname?.split('/').at(-1);
 for(const script of document.querySelectorAll('script[type="application/json"]')){
  try{
   const visit=(value,path='',depth=0)=>{
    if(!value||typeof value!=='object'||depth>18||publicShipping.length>=8)return;
    if([value.id,value.itemId,value.item_id].some(id=>id&&String(id)===targetId)){
     const fields=Object.fromEntries(Object.entries(value).filter(([key])=>/^(?:shipping|delivery|condition|status|item_condition)/i.test(key)));
     publicShipping.push({path,fields});
    }
    for(const [key,child] of Object.entries(value))visit(child,path+'.'+key,depth+1);
   };visit(JSON.parse(script.textContent));
  }catch{}
 }
 return {priceDiagnostic:price&&shippingJPY!==null?undefined:{publicShipping,headerText:header.map(n=>n.children.length?'':n.textContent).join(' ').slice(0,1200),shippingHeadings:headings.filter(n=>/送料|配送/.test(n.textContent)).map(n=>n.parentElement.outerHTML.slice(0,1500)),converted:converted?.outerHTML.slice(0,1000),targetPrices:targetPrices.map(n=>n.outerHTML.slice(0,700)),headerPrices:header.filter(n=>/[¥￥]|[0-9],[0-9]{3}/.test(n.textContent)).slice(-10).map(n=>n.outerHTML.slice(0,500))},title,description,condition,price,itemPrice:price,shippingJPY,shippingText,shippingKnown:shippingJPY!==null,
  status:checkout?'OPEN':'UNKNOWN',sellerId:seller?sellerIds[0]:'',sellerDiagnostic,sellerName:seller?.querySelector('h2,h3,[data-testid="seller-name"]')?.textContent?.trim()||seller?.querySelector('img')?.alt?.replace(/の(?:画像|アイコン).*$/,'').trim()||'',images:[...new Set(images)]};
}
export async function mercariSearch(page,url){
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>document.querySelector('main a[href^="/item/"],main a[href^="/shops/product/"]')||/該当する商品が見つかりません|検索条件に一致する商品がありません|検索結果はありません/.test(document.querySelector('main')?.innerText||''),{},{timeout:45000});
 const result=await page.evaluate('('+readMercariCards.toString()+')(document)');
 if(!result.cards.length&&!result.empty)throw Error('煤炉搜索结果不可读');return result;
}
export async function mercariDetail(page,url){
 if(!/^https:\/\/jp\.mercari\.com\/(?:item\/m\d+|shops\/product\/[A-Za-z0-9]+)$/.test(url))throw Error('煤炉商品链接无效');
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 await page.locator('main article h1').waitFor({timeout:30000});
 await page.waitForFunction('() => { const d=('+readMercariDetail.toString()+')(document); return Boolean(d&&d.price&&d.description&&d.shippingText&&d.sellerId); }',{},{timeout:30000}).catch(()=>{});
 const result=await page.evaluate('('+readMercariDetail.toString()+')(document)');
 if(!result?.title||!result.price||!result.description)throw Error('煤炉目标详情字段不完整 '+JSON.stringify({title:Boolean(result?.title),price:result?.price,description:Boolean(result?.description),status:result?.status,diagnostic:result?.priceDiagnostic}));
 if(!result.sellerId)throw Error('煤炉目标卖家尚未确认 '+JSON.stringify({itemId:url.split('/').at(-1),...result.sellerDiagnostic}));
 return {...result,url,id:url.split('/').at(-1)};
}
