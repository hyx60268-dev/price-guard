// Public product DOM only. Recommendations and other shop products are never
// part of the target description, price, availability, or image evidence.
export function readMercariCards(document){
 const seen=new Set(),cards=[];
 for(const a of document.querySelectorAll('main a[href^="/item/"],main a[href^="/shops/product/"]')){
  const href=a.getAttribute('href').split('?')[0];if(seen.has(href))continue;seen.add(href);
  const img=a.querySelector('img'),text=(a.innerText||a.textContent||'').trim();
  const label=a.getAttribute('aria-label')||img?.alt||text;
  const title=label.replace(/の(?:画像|サムネイル).*$/,'').trim();
  const priceText=`${text} ${label}`,match=priceText.match(/[¥￥]\s*([\d,]+)/)||priceText.match(/([\d,]+)円/);
  const price=Number(match?.[1]?.replace(/,/g,''));
  if(title&&price>0)cards.push({id:href.split('/').at(-1),url:`https://jp.mercari.com${href}`,title,price,image:img?.currentSrc||img?.src||'',itemStatus:/SOLD|売り切れ/i.test(label+' '+text)?'SOLD':'OPEN'});
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
 // The first price after h1 is the target offer. Stop before the description,
 // so dimensions, shipping and unrelated shop recommendations cannot win.
 const nodes=[...article.querySelectorAll('*')],h1=article.querySelector('h1'),end=headings.find(n=>n.textContent.trim()==='商品の説明');
 const header=nodes.slice(nodes.indexOf(h1)+1,nodes.indexOf(end));
 const priceNode=header.find(n=>/^[¥￥]\s*[\d,]+$/.test(n.textContent.trim()));
 const price=Number(priceNode?.textContent.replace(/[^\d]/g,''))||null;
 const checkout=header.find(n=>n.tagName==='BUTTON'&&/購入手続きへ/.test(n.textContent)&&!n.disabled);
 const shippingText=field('送料')||field('配送料の負担');
 const shippingIncluded=/送料込み|出品者負担/.test(shippingText);
 const fixedShipping=/^[¥￥]\s*[\d,]+$/.test(shippingText)?Number(shippingText.replace(/[^\d]/g,'')):null;
 const shippingJPY=shippingIncluded?0:fixedShipping;
 const seller=article.querySelector('a[href^="/user/profile/"],a[href^="/shops/profile/"]');
 const images=[...article.querySelectorAll('[aria-label^="商品画像"] img,[aria-label^="商品サムネイル"] img')].map(n=>n.currentSrc||n.src).filter(Boolean);
 return {title,description,condition,price,itemPrice:price,shippingJPY,shippingText,shippingKnown:shippingJPY!==null,
  status:checkout?'OPEN':'UNKNOWN',sellerId:seller?.getAttribute('href')||'',images:[...new Set(images)]};
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
 await page.waitForFunction('() => { const d=('+readMercariDetail.toString()+')(document); return Boolean(d&&d.price&&d.description); }',{},{timeout:20000}).catch(()=>{});
 const result=await page.evaluate('('+readMercariDetail.toString()+')(document)');
 if(!result?.title||!result.price||!result.description)throw Error('煤炉目标详情字段不完整 '+JSON.stringify({title:Boolean(result?.title),price:result?.price,description:Boolean(result?.description),status:result?.status}));return {...result,url,id:url.split('/').at(-1)};
}
