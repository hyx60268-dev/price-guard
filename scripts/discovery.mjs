import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openContext,settle } from './lib/browser.mjs';
import { decrypt,encrypt } from './lib/crypto.mjs';
import { clusterSellerSales,discoveryId,eligibleDiscoveryCard,isOwnedDiscoverySource,isWithinDays,median,parseListingTime,rewriteListing,sellerIdFromProfile,validDiscoveryXianyu,xianyuQueryFor } from './lib/discovery.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { fetchYahooItemBundle,fetchYahooResult } from './lib/yahoo.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const readJson=file=>fs.readFile(file,'utf8').then(JSON.parse);
const exists=file=>fs.access(file).then(()=>true).catch(()=>false);
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const settings=await readJson(path.join(root,'config','settings.json'));
const accountsCfg=await readJson(path.join(root,'config','accounts.json'));
const cfg={keyword:'中国限定',minPriceJPY:4999,windowDays:30,freshHours:6,seedLimitPerPlatform:120,sellerLimitPerPlatform:20,sellerCardLimit:160,sellerPages:2,mercariSearchScrolls:8,mercariSellerScrolls:8,maxProducts:30,...(settings.discovery||{})};
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
await Promise.all(['data','public/data','state','.auth'].map(directory=>fs.mkdir(path.join(root,directory),{recursive:true})));
const stateEnc=path.join(root,'state','discovery.json.enc'),stateStatus=path.join(root,'state','discovery-status.json');
const publicEnc=path.join(root,'public','data','discovery.json.enc'),publicStatus=path.join(root,'public','data','discovery-status.json');

async function priorDiscovery(){
  if(!await exists(stateEnc))return null;
  try{return JSON.parse(decrypt(await fs.readFile(stateEnc),password).toString('utf8'))}catch{return null}
}

async function latestPriceSnapshot(){
  for(const file of [path.join(root,'public','data','latest.json.enc'),path.join(root,'state','latest.json.enc')]){
    if(!await exists(file))continue;
    try{return JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'))}catch{}
  }
  return null;
}

function ownedYahooScope(snapshot){
  const sellerIds=new Set(),itemIds=new Set();
  const profiles=[settings.profileUrl,...(accountsCfg.accounts||[]).map(account=>account.profileUrl),
    ...(snapshot?.managedAccounts||[]).map(account=>account.profileUrl),...(snapshot?.accounts||[]).map(account=>account.profileUrl)];
  for(const profile of profiles){const id=sellerIdFromProfile(profile);if(id)sellerIds.add(id)}
  for(const item of snapshot?.items||[]){if(item.id)itemIds.add(String(item.id));if(item.sellerId)sellerIds.add(String(item.sellerId))}
  for(const account of snapshot?.accounts||[])for(const item of account.items||[]){if(item.id)itemIds.add(String(item.id));if(item.sellerId)sellerIds.add(String(item.sellerId))}
  for(const id of cfg.excludeYahooSellerIds||[])sellerIds.add(String(id));
  return {sellerIds,itemIds};
}

async function publishExisting(prior){
  await fs.copyFile(stateEnc,publicEnc);
  if(await exists(stateStatus))await fs.copyFile(stateStatus,publicStatus);
  else await fs.writeFile(publicStatus,JSON.stringify(statusFor(prior),null,2));
  await fs.writeFile(path.join(root,'data','discovery-change-summary.json'),JSON.stringify({hasChanges:false,total:0,added:0,removed:0,firstRun:false},null,2));
}

function isFresh(prior){
  const checked=Date.parse(prior?.checkedAt||'');return Number.isFinite(checked)&&Date.now()-checked<Number(cfg.freshHours)*3_600_000;
}

const prior=await priorDiscovery();
const force=process.env.FORCE_DISCOVERY==='1'||process.env.SCAN_TRIGGER==='workflow_dispatch';
if(prior&&!force&&isFresh(prior)){
  await publishExisting(prior);console.log(`选品发现使用 ${prior.checkedAt} 的缓存，共 ${prior.products?.length||0} 个候选`);process.exit(0);
}

function xianyuStateFromEnv(){
  const file=path.join(root,'.auth','xianyu.json');
  const parts=['XIANYU_AUTH_PART_1','XIANYU_AUTH_PART_2','XIANYU_AUTH_PART_3'].map(key=>process.env[key]||'').join('');
  if(parts){try{return fs.writeFile(file,zlib.gunzipSync(Buffer.from(parts,'base64'))).then(()=>file)}catch{}}
  const gz=process.env.XIANYU_STORAGE_STATE_GZIP_B64;
  if(gz){try{return fs.writeFile(file,zlib.gunzipSync(Buffer.from(gz,'base64'))).then(()=>file)}catch{}}
  const raw=process.env.XIANYU_STORAGE_STATE_B64;
  if(raw){try{return fs.writeFile(file,Buffer.from(raw,'base64')).then(()=>file)}catch{}}
  return Promise.resolve(undefined);
}

function cleanItemHref(href='',origin){
  const url=new URL(href,origin);url.search='';return url.href;
}

async function mercariCards(page,{onlySold=true,assumeSold=false}={}){
  return page.locator('main a[href^="/item/"]').evaluateAll((links,options)=>{
    const output=[],seen=new Set();
    for(const link of links){
      const href=link.getAttribute('href')||'';if(!href||seen.has(href.split('?')[0]))continue;
      const scope=link.closest('li')||link.parentElement?.parentElement||link.parentElement||link;
      const sold=options.assumeSold||Boolean(scope.querySelector('[aria-label*="売り切れ"],[aria-label*="SOLD"],[data-testid*="sold" i],img[alt*="売り切れ"],img[alt*="SOLD" i]'))||/(?:売り切れ|売却済み|SOLD)/i.test(`${scope.innerText||''} ${scope.getAttribute?.('aria-label')||''}`);
      if(options.onlySold&&!sold)continue;
      const lines=(link.innerText||'').split(/\n+/).map(value=>value.trim()).filter(Boolean);
      const priceLine=lines.find(value=>/^[¥￥]?\s*[\d,]+円?$/.test(value.replace(/^現在\s*/,'')))||'';
      const priceMatch=priceLine.match(/[\d,]+/),price=priceMatch?Number(priceMatch[0].replaceAll(',','')):null;
      const image=link.querySelector('img:not([alt="売り切れ"])');
      let title=lines.filter(value=>value!==priceLine&&!/^[¥￥]$/.test(value)&&value!=='現在').at(-1)||image?.alt||'';
      title=title.replace(/の(?:サムネイル|画像).*$/,'').trim();
      seen.add(href.split('?')[0]);output.push({id:(href.match(/\/item\/(m\d+)/)||[])[1],href,title,price,sold,image:image?.currentSrc||image?.src||''});
    }
    return output;
  },{onlySold,assumeSold});
}

async function expandMercariGrid(page,rounds){
  let prior=0,stable=0;
  for(let index=0;index<Number(rounds||0);index++){
    const button=page.getByRole('button',{name:'もっと見る',exact:true});
    if(await button.count()&&await button.first().isVisible())await button.first().click().catch(()=>{});
    else await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
    await page.waitForTimeout(850);
    const count=await page.locator('main a[href^="/item/"]').count();
    stable=count===prior?stable+1:0;prior=count;if(stable>=2)break;
  }
}

async function mercariDetail(page,url){
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await settle(page,2600);
  return page.evaluate(()=>{
    const article=document.querySelector('main article')||document.querySelector('main');
    const text=(article?.innerText||'').replace(/\n{3,}/g,'\n\n');
    const heading=[...article.querySelectorAll('h2')].find(node=>node.textContent?.trim()==='商品の説明');
    const description=(heading?.nextElementSibling?.innerText||'').trim();
    const title=article.querySelector('h1')?.innerText?.trim()||document.title.replace(/\s*-\s*メルカリ.*$/,'');
    const priceText=[...article.querySelectorAll('*')].find(node=>/^[¥￥]\s*[\d,]+$/.test(node.textContent?.trim()||''))?.textContent||'';
    const price=Number((priceText.match(/[\d,]+/)||[])[0]?.replaceAll(',',''))||null;
    const seller=[...article.querySelectorAll('a[href*="/user/profile/"]')][0];
    const images=[...article.querySelectorAll('[aria-label^="商品画像"] img,[aria-label^="商品サムネイル"] img')].map(image=>image.currentSrc||image.src).filter(Boolean);
    const condition=(text.match(/商品の状態\s*([^\n]+)/)||[])[1]||'';
    return {title,price,description,text,condition,sellerUrl:seller?.href||'',sellerId:(seller?.href.match(/\/user\/profile\/(\d+)/)||[])[1]||'',sellerName:(seller?.innerText||'').split('\n')[0].trim(),images:[...new Set(images)].slice(0,10)};
  });
}

async function mercariSellerCards(page,url){
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await settle(page,2500);
  await expandMercariGrid(page,cfg.mercariSellerScrolls);
  return (await mercariCards(page,{onlySold:true})).slice(0,Number(cfg.sellerCardLimit));
}

async function scanMercari(context,errors){
  const page=await context.newPage(),detail=await context.newPage(),origin='https://jp.mercari.com';
  const search=`${origin}/search?keyword=${encodeURIComponent(cfg.keyword)}&status=sold_out&sort=created_time&order=desc&price_min=${cfg.minPriceJPY}`;
  const sellers=new Map(),groups=[];
  try{
    await page.goto(search,{waitUntil:'domcontentloaded',timeout:35000});await settle(page,4200);
    await expandMercariGrid(page,cfg.mercariSearchScrolls);
    const excluded=new Set((cfg.excludeMercariSellerIds||[]).map(String));
    const seeds=(await mercariCards(page,{onlySold:true,assumeSold:true})).filter(card=>Number(card.price)>=cfg.minPriceJPY).slice(0,Number(cfg.seedLimitPerPlatform));
    for(const [index,seed] of seeds.entries()){
      if(sellers.size>=Number(cfg.sellerLimitPerPlatform))break;
      try{
        const item=await mercariDetail(detail,cleanItemHref(seed.href,origin));
        if(item.sellerId&&!excluded.has(String(item.sellerId))&&!sellers.has(item.sellerId))sellers.set(item.sellerId,{id:item.sellerId,name:item.sellerName||item.sellerId,url:item.sellerUrl,seed:item});
      }catch(error){errors.push(`Mercari种子${index+1}: ${String(error)}`)}
      await wait(450);
    }
    console.log(`[选品源] Mercari 成交种子 ${seeds.length}，检查卖家 ${sellers.size}`);
    for(const seller of sellers.values()){
      try{
        const cards=await mercariSellerCards(page,seller.url);
        const likely=clusterSellerSales(cards.filter(card=>Number(card.price)>=cfg.minPriceJPY)).filter(group=>group.items.length>=3);
        for(const group of likely){
          const verified=[];
          for(const card of group.items.slice(0,8)){
            try{
              const item=await mercariDetail(detail,cleanItemHref(card.href,origin));
              const soldAt=parseListingTime(item.text);if(isWithinDays(soldAt,cfg.windowDays))verified.push({...card,...item,sold:true,soldAt,url:cleanItemHref(card.href,origin)});
            }catch(error){errors.push(`Mercari成交${card.id}: ${String(error)}`)}
            if(verified.length>=6)break;await wait(350);
          }
          if(verified.length<3)continue;
          const representative=verified.sort((a,b)=>Date.parse(b.soldAt)-Date.parse(a.soldAt))[0];
          groups.push(makeSourceCandidate('mercari',seller,verified,representative));
        }
      }catch(error){errors.push(`Mercari卖家${seller.id}: ${String(error)}`)}
    }
  }catch(error){errors.push(`Mercari搜索: ${String(error)}`)}
  finally{await Promise.allSettled([page.close(),detail.close()])}
  return groups;
}

function yahooCard(raw){
  return {id:raw.id,title:raw.title||'',price:Number(raw.price),sold:raw.itemStatus==='SOLD',soldAt:raw.endTime||raw.openTime||null,
    image:raw.thumbnailImageUrl||'',sellerId:raw.sellerId||'',url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.id}`};
}

async function scanYahoo(errors,owned){
  const search=`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(cfg.keyword)}?open=0&sort=openTime&order=desc`;
  const sellers=new Map(),groups=[];
  try{
    const first=await fetchYahooResult(search,settings),results=[first];
    const searchPages=Math.min(Number(cfg.searchPages||2),Math.max(1,Math.ceil(Number(first.totalResultsAvailable||first.items?.length||0)/100)));
    for(let page=2;page<=searchPages;page++)results.push(await fetchYahooResult(`${search}&page=${page}`,settings));
    const seeds=results.flatMap(result=>result.items||[]).map(yahooCard)
      .filter(card=>card.sold&&card.price>=cfg.minPriceJPY&&!isOwnedDiscoverySource(card,owned)).slice(0,Number(cfg.seedLimitPerPlatform));
    for(const card of seeds){if(card.sellerId&&!owned.sellerIds.has(String(card.sellerId))&&!sellers.has(card.sellerId)&&sellers.size<Number(cfg.sellerLimitPerPlatform))sellers.set(card.sellerId,{id:card.sellerId,name:card.sellerId,url:`https://paypayfleamarket.yahoo.co.jp/user/${card.sellerId}`})}
    console.log(`[选品源] Yahoo 成交种子 ${seeds.length}，排除自有卖家 ${owned.sellerIds.size}，检查卖家 ${sellers.size}`);
    for(const seller of sellers.values()){
      try{
        const firstProfile=await fetchYahooResult(`${seller.url}?page=1&sort=openTime&order=desc`,settings),profileResults=[firstProfile];
        const profilePages=Math.min(Number(cfg.sellerPages||1),Math.max(1,Math.ceil(Number(firstProfile.totalResultsAvailable||firstProfile.items?.length||0)/100)));
        for(let page=2;page<=profilePages;page++)profileResults.push(await fetchYahooResult(`${seller.url}?page=${page}&sort=openTime&order=desc`,settings));
        const cards=profileResults.flatMap(profile=>profile.items||[]).map(yahooCard)
          .filter(card=>eligibleDiscoveryCard(card,cfg)&&!isOwnedDiscoverySource(card,owned)).slice(0,Number(cfg.sellerCardLimit));
        const likely=clusterSellerSales(cards).filter(group=>group.items.length>=3);
        for(const group of likely){
          const verified=group.items.filter(card=>eligibleDiscoveryCard(card,cfg));if(verified.length<3)continue;
          const representative=verified.sort((a,b)=>Date.parse(b.soldAt)-Date.parse(a.soldAt))[0];
          try{
            const bundle=await fetchYahooItemBundle(representative.id,settings),detail=bundle.detail;
            representative.description=detail.description||'';representative.condition=detail.condition?.name||detail.condition||'';
            representative.images=(detail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean).slice(0,10);
            seller.name=detail.seller?.displayName||detail.seller?.name||detail.seller?.nickname||seller.id;
          }catch(error){errors.push(`Yahoo详情${representative.id}: ${String(error)}`);representative.images=[representative.image].filter(Boolean)}
          groups.push(makeSourceCandidate('yahoo',seller,verified,representative));
        }
      }catch(error){errors.push(`Yahoo卖家${seller.id}: ${String(error)}`)}
    }
  }catch(error){errors.push(`Yahoo搜索: ${String(error)}`)}
  return groups;
}

function makeSourceCandidate(platform,seller,sales,representative){
  const sold=sales.filter(card=>isWithinDays(card.soldAt,cfg.windowDays));
  const title=representative.title||sales[0]?.title||'',description=representative.description||'';
  const rewrite=rewriteListing({title,description,condition:representative.condition,saleCount:sold.length});
  return {
    id:discoveryId(platform,seller.id,title),sourcePlatform:platform,seller:{id:seller.id,name:seller.name,url:seller.url},
    salesCount:sold.length,saleDates:sold.map(item=>item.soldAt).filter(Boolean).sort().reverse(),sourcePriceJPY:median(sold.map(item=>item.price)),
    sourcePricesJPY:sold.map(item=>item.price).filter(Number.isFinite),sourceTitle:title,sourceDescription:description,sourceUrl:representative.url,
    sourceUrls:sold.map(item=>item.url).filter(Boolean).slice(0,8),sourceImages:[...(representative.images||[]),representative.image].filter(Boolean).slice(0,8),
    xianyuQuery:xianyuQueryFor(title),...rewrite
  };
}

const errors=[],authState=await xianyuStateFromEnv();
let browser,context,xPage,xianyuAuthRequired=false;
const sourceCandidates=[];
try{
  const owned=ownedYahooScope(await latestPriceSnapshot());
  const opened=await openContext(authState);browser=opened.browser;context=opened.context;
  const [mercari,yahoo]=await Promise.all([scanMercari(context,errors),scanYahoo(errors,owned)]);sourceCandidates.push(...mercari,...yahoo);
  const ranked=sourceCandidates.sort((a,b)=>b.salesCount-a.salesCount||b.sourcePriceJPY-a.sourcePriceJPY).slice(0,Number(cfg.maxProducts));
  xPage=await context.newPage();
  for(const [index,item] of ranked.entries()){
    try{
      const xianyu=await xianyuCost(xPage,{id:item.id,title:item.sourceTitle,xianyuQuery:item.xianyuQuery,image:item.sourceImages[0],images:item.sourceImages,yahoo:{ownImages:item.sourceImages}},settings);
      const validated=validDiscoveryXianyu(xianyu);Object.assign(item,{xianyu,purchaseCNY:xianyu.averageCNY,images:validated.images,
        status:validated.ready?'ready':'needs_xianyu_review',xianyuSearchUrl:xianyu.searchUrl,confidence:validated.ready?'高':'需人工'});
      if(['login_required','blocked'].includes(xianyu.status))xianyuAuthRequired=true;
    }catch(error){errors.push(`闲鱼${item.id}: ${String(error)}`);Object.assign(item,{status:'needs_xianyu_review',purchaseCNY:null,images:[],confidence:'需人工',xianyuSearchUrl:`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery)}`})}
    console.log(`[选品 ${index+1}/${ranked.length}] ${item.sourcePlatform} 月销${item.salesCount} ${item.sourceTitle} 闲鱼=${item.purchaseCNY??'待核验'} 图片=${item.images?.length||0}`);
    await wait(600);
  }
}finally{await browser?.close().catch(()=>{})}

const products=sourceCandidates.sort((a,b)=>b.salesCount-a.salesCount||b.sourcePriceJPY-a.sourcePriceJPY).slice(0,Number(cfg.maxProducts));
const result={version:1,checkedAt:new Date().toISOString(),filters:{keyword:cfg.keyword,soldOnly:true,minPriceJPY:cfg.minPriceJPY,sort:'newest',windowDays:cfg.windowDays},
  products,stats:{sourceCandidates:sourceCandidates.length,ready:products.filter(item=>item.status==='ready').length,pending:products.filter(item=>item.status!=='ready').length,
    mercari:products.filter(item=>item.sourcePlatform==='mercari').length,yahoo:products.filter(item=>item.sourcePlatform==='yahoo').length},
  login:{xianyuRequired:xianyuAuthRequired},errors:errors.slice(0,30)};

function statusFor(value){return {version:value.version,checkedAt:value.checkedAt,total:value.products?.length||0,ready:value.stats?.ready||0,pending:value.stats?.pending||0,mercari:value.stats?.mercari||0,yahoo:value.stats?.yahoo||0,xianyuLoginRequired:Boolean(value.login?.xianyuRequired)}}
const priorIds=new Set((prior?.products||[]).filter(item=>item.status==='ready').map(item=>item.id)),nextIds=new Set(products.filter(item=>item.status==='ready').map(item=>item.id));
const added=[...nextIds].filter(id=>!priorIds.has(id)),removed=[...priorIds].filter(id=>!nextIds.has(id));
const changeSummary={hasChanges:added.length+removed.length>0,total:added.length+removed.length,added:added.length,removed:removed.length,addedIds:added,removedIds:removed,firstRun:!prior};
const sealed=encrypt(Buffer.from(JSON.stringify(result)),password),status=statusFor(result);
await Promise.all([fs.writeFile(stateEnc,sealed),fs.writeFile(publicEnc,sealed),fs.writeFile(stateStatus,JSON.stringify(status,null,2)),fs.writeFile(publicStatus,JSON.stringify(status,null,2)),
  fs.writeFile(path.join(root,'data','discovery-change-summary.json'),JSON.stringify(changeSummary,null,2))]);
console.log(JSON.stringify({...status,errors:errors.length,changes:changeSummary.total}));
