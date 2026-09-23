import fs from 'node:fs/promises';
import path from 'node:path';
import { loadXianyuSession } from './lib/xianyu-session.mjs';
import { fileURLToPath } from 'node:url';
import { openContext,settle } from './lib/browser.mjs';
import { decrypt,encrypt } from './lib/crypto.mjs';
import { canonicalSaleTitle,clusterSellerSales,containsDiscoveryKeyword,discoveryId,discoveryProfit,eligibleDiscoveryCard,groupDiscoveryCandidates,isOwnedDiscoverySource,isWithinDays,median,mercariDiscoverySearchUrl,mercariSoldEvidence,nextMercariPage,parseListingTime,rankDiscoveryCandidates,rewriteListing,rotateDiscoverySellers,sameDiscoveryProduct,sellerIdFromProfile,validDiscoveryXianyu,xianyuQueryFor,yahooDiscoverySearchUrl } from './lib/discovery.mjs';
import { positivePrice } from './lib/xianyu-evidence.mjs';
import { xianyuCost } from './lib/xianyu.mjs';
import { fetchYahooItemBundle,fetchYahooResult } from './lib/yahoo.mjs';
import { discoveryDismissalKey,normalizeProductIdentity } from './lib/state.mjs';
import { imageFingerprints,imageSetSimilarity } from './lib/image.mjs';
import { listingSpecificationEquivalent,listingTextEquivalent,productFamily,titleScore } from './lib/rules.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const DISCOVERY_VERSION=11;
const readJson=file=>fs.readFile(file,'utf8').then(JSON.parse);
const exists=file=>fs.access(file).then(()=>true).catch(()=>false);
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
let sessionManager;
const settings=await readJson(path.join(root,'config','settings.json'));
const accountsCfg=await readJson(path.join(root,'config','accounts.json'));
const cfg={keyword:'中国限定',minPriceJPY:5001,windowDays:30,minSalesPerSeller:2,freshHours:6,seedLimitPerPlatform:200,sellerLimitPerPlatform:200,sellerCardLimit:160,sellerPages:2,mercariSearchScrolls:24,mercariSellerScrolls:8,maxProducts:30,maxProductsPerSeller:4,...(settings.discovery||{})};
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
await Promise.all(['data','public/data','state','.auth'].map(directory=>fs.mkdir(path.join(root,directory),{recursive:true})));
const stateEnc=path.join(root,'state','discovery.json.enc'),stateStatus=path.join(root,'state','discovery-status.json');
const publicEnc=path.join(root,'public','data','discovery.json.enc'),publicStatus=path.join(root,'public','data','discovery-status.json');

function applyDiscoveryProfit(item){
  const profit=discoveryProfit(item,settings);Object.assign(item,profit);
  if(profit.ready&&!profit.qualified){item.status='rejected_low_profit';item.confidence=`预计到手利润 ¥${profit.estimatedProfitJPY.toLocaleString('ja-JP')}，低于 ¥${profit.assumptions.minimumProfitJPY.toLocaleString('ja-JP')}`}
  else if(item.status==='ready'&&item.timeEvidence==='listing_page_relative'){item.status='needs_sale_time_review';item.confidence='成本已核验；页面时间不等于精确成交时间，需确认成交窗口'}
  return item;
}

function mergeOwnedRecords(records=[]){
  const output=new Map();
  for(const record of records){
    const key=normalizeProductIdentity(record.title||'');if(!key)continue;
    const current=output.get(key)||{title:record.title,description:'',category:'',images:[]};
    output.set(key,{...current,title:current.title||record.title,description:current.description||record.description||'',category:current.category||record.category||'',
      images:[...new Set([...(current.images||[]),...(record.images||[])])].slice(0,12)});
  }
  return [...output.values()];
}

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
  const sellerIds=new Set(),itemIds=new Set(),productTitles=[...(snapshot?.ownedTitleHistory||[])],records=[];
  const profiles=[settings.profileUrl,...(accountsCfg.accounts||[]).map(account=>account.profileUrl),
    ...(snapshot?.managedAccounts||[]).map(account=>account.profileUrl),...(snapshot?.accounts||[]).map(account=>account.profileUrl)];
  for(const profile of profiles){const id=sellerIdFromProfile(profile);if(id)sellerIds.add(id)}
  const remember=item=>{
    if(item.id)itemIds.add(String(item.id));if(item.sellerId)sellerIds.add(String(item.sellerId));if(item.title)productTitles.push(item.title);
    if(item.title)records.push({title:item.title,description:item.yahoo?.ownDescription||'',category:item.yahoo?.ownCategory||'',
      images:[...(item.yahoo?.ownImages||[]),item.image].filter(Boolean)});
  };
  for(const item of snapshot?.items||[])remember(item);
  for(const account of snapshot?.accounts||[])for(const item of account.items||[])remember(item);
  for(const id of cfg.excludeYahooSellerIds||[])sellerIds.add(String(id));
  const uniqueTitles=[...new Set(productTitles)];
  for(const title of uniqueTitles)if(title&&!records.some(record=>normalizeProductIdentity(record.title)===normalizeProductIdentity(title)))records.push({title,description:'',category:'',images:[]});
  return {sellerIds,itemIds,productTitles:uniqueTitles,records:mergeOwnedRecords(records)};
}

const imageFingerprintCache=new Map();
async function fingerprints(images=[]){
  const output=[];
  for(const url of [...new Set(images)].slice(0,8)){
    if(!imageFingerprintCache.has(url))imageFingerprintCache.set(url,imageFingerprints(url).catch(()=>null));
    const value=await imageFingerprintCache.get(url);if(value)output.push(value);
  }
  return output;
}

async function matchesOwnedListing(candidate,owned){
  const candidateTitle=candidate.sourceTitle||candidate.proposedTitle||'',candidateDescription=candidate.sourceDescription||'';
  const candidateImages=candidate.sourceImages||[];
  for(const record of owned.records||[]){
    if(sameDiscoveryProduct({title:candidateTitle},{title:record.title})||
      listingTextEquivalent(candidateTitle,candidateDescription,record.title,record.description)||
      listingSpecificationEquivalent(candidateTitle,record.title,'',record.category))return true;
    const leftFamily=productFamily(`${candidateTitle}\n${candidateDescription}`),rightFamily=productFamily(`${record.title}\n${record.description}`,record.category);
    if(leftFamily&&rightFamily&&leftFamily!==rightFamily)continue;
    // 图片只对有一定文字关联的候选做，避免 30×全部库存的大量下载；比较时仍使用
    // 两边最多 8 张图的最佳对应关系，而不是只看首图。
    if(titleScore(candidateTitle,record.title)<.42||!candidateImages.length||!record.images.length)continue;
    const score=imageSetSimilarity(await fingerprints(candidateImages),await fingerprints(record.images));
    if(Number.isFinite(score)&&score>=.82)return true;
  }
  return false;
}

async function completeOwnedScope(snapshot){
  const owned=ownedYahooScope(snapshot);
  for(const account of accountsCfg.accounts||[]){
    if(!account.catalogFile)continue;
    try{for(const item of (await readJson(path.join(root,account.catalogFile))).items||[])if(item.title){
      owned.productTitles.push(item.title);owned.records.push({title:item.title,description:'',category:'',images:[item.image].filter(Boolean)});
    }}catch{}
  }
  owned.productTitles=[...new Set(owned.productTitles)];owned.records=mergeOwnedRecords(owned.records);return owned;
}

async function excludeOwnedAndUploaded(items,owned,dismissed=[]){
  const uploadedOwned={records:dismissed.map(record=>({title:record.title||'',description:record.description||'',category:'',images:record.images||[]}))};
  const filtered=[];
  for(const item of items){
    if(await matchesOwnedListing(item,owned))continue;
    const uploaded=dismissed.find(record=>discoveryDismissalKey(item)===String(record.productKey||''));
    if(uploaded||dismissed.some(record=>record.title&&sameDiscoveryProduct({title:item.sourceTitle},{title:record.title})))continue;
    if(await matchesOwnedListing(item,uploadedOwned))continue;
    filtered.push(item);
  }
  return filtered;
}

async function publishExisting(prior){
  const latest=await latestPriceSnapshot(),owned=await completeOwnedScope(latest);
  const dismissed=Object.values(latest?.dismissedDiscoveries||{});
  const costFiltered=(prior.products||[]).map(item=>applyDiscoveryProfit({...item})).filter(item=>item.status!=='rejected_low_profit');
  const products=rankDiscoveryCandidates(await excludeOwnedAndUploaded(costFiltered,owned,dismissed),{
    maxProducts:Number(cfg.maxProducts),minSales:Number(cfg.minSalesPerSeller),perSeller:Number(cfg.maxProductsPerSeller||4)
  });
  const refreshed={...prior,version:DISCOVERY_VERSION,products,stats:{...(prior.stats||{}),ready:products.filter(item=>item.status==='ready').length,
    pending:products.filter(item=>item.status!=='ready').length,mercari:products.filter(item=>item.sourcePlatform==='mercari'||item.sourcePlatforms?.includes('mercari')).length,
    yahoo:products.filter(item=>item.sourcePlatform==='yahoo'||item.sourcePlatforms?.includes('yahoo')).length}};
  const sealed=encrypt(Buffer.from(JSON.stringify(refreshed)),password);await Promise.all([fs.writeFile(stateEnc,sealed),fs.writeFile(publicEnc,sealed)]);
  await fs.writeFile(publicStatus,JSON.stringify(statusFor(refreshed),null,2));
  await fs.writeFile(stateStatus,JSON.stringify(statusFor(refreshed),null,2));
  await fs.writeFile(path.join(root,'data','discovery-change-summary.json'),JSON.stringify({hasChanges:false,total:0,added:0,removed:0,firstRun:false},null,2));
}

function isChinaLimitedProduct(item={}){
  return /(?:中国\s*限定|上海\s*限定|北京\s*限定|広州\s*限定|深圳\s*限定|bilibili.{0,16}限定)/i.test(`${item.title||''} ${item.description||''}`);
}

function xianyuReviewLabel(status=''){
  if(status==='login_required')return '待核验：闲鱼登录已失效';
  if(status==='blocked')return '待核验：闲鱼触发安全验证';
  if(status==='page_empty')return '待核验：闲鱼未返回商品';
  if(status==='manual_review')return '待核验：同款或报价证据不足';
  return '待核验：自动搜索失败';
}

async function refreshCachedDiscoveryCosts(prior){
  const products=(prior.products||[]).map(item=>({...item}));
  const retryMs=60*60_000;
  const pending=products.filter(item=>{
    if(item.status==='ready'&&positivePrice(item.purchaseCNY)!==null)return false;
    const checked=Date.parse(item.xianyu?.checkedAt||'');return !Number.isFinite(checked)||Date.now()-checked>=retryMs;
  }).sort((a,b)=>(Date.parse(a.xianyu?.checkedAt||'')||0)-(Date.parse(b.xianyu?.checkedAt||'')||0)).slice(0,Number(cfg.costRefreshLimit||10));
  if(!pending.length)return {...prior,products};
  const authState=await xianyuStateFromEnv();let browser,context,page;
  try{
    const opened=await openContext(authState);browser=opened.browser;context=opened.context;page=await context.newPage();
    for(const item of pending){
      try{
        const xianyu=await xianyuCost(page,{id:item.id,title:item.sourceTitle,description:item.sourceDescription||'',xianyuQuery:item.xianyuQuery,image:item.sourceImages?.[0],images:item.sourceImages||[],yahoo:{ownImages:item.sourceImages||[]}},settings);
        await sessionManager.persist(context,xianyu).catch(()=>console.warn('[闲鱼会话] 更新保存失败，保留原会话'));
        const validated=validDiscoveryXianyu(xianyu);
        Object.assign(item,{xianyu,purchaseCNY:validated.ready?xianyu.averageCNY:null,referenceCNY:xianyu.averageCNY,
          images:validated.images.length?validated.images:(item.images||[]),imageSource:validated.imageSource||item.imageSource,
          status:validated.ready?'ready':'needs_xianyu_review',xianyuSearchUrl:xianyu.searchUrl,
          confidence:validated.ready?'自动核验参考价':xianyuReviewLabel(xianyu.status),costVerification:validated});applyDiscoveryProfit(item);
        console.log(`[选品成本续查] ${item.sourceTitle} 状态=${xianyu.status} 卡片=${xianyu.cardCount??0} 核验=${xianyu.verifiedCount??0} 成本=${item.purchaseCNY??'待核验'}`);
        if(['blocked','login_required'].includes(xianyu.status))break;
      }catch(error){console.warn(`[选品成本续查] ${item.sourceTitle} ${String(error)}`)}
    }
  }finally{await browser?.close().catch(()=>{})}
  return {...prior,products,login:{xianyuRequired:products.some(item=>['blocked','login_required','deferred_auth'].includes(item.xianyu?.status))},costCheckedAt:new Date().toISOString()};
}

function isFresh(prior){
  if(Number(prior?.version)!==DISCOVERY_VERSION)return false;
  const checked=Date.parse(prior?.checkedAt||'');return Number.isFinite(checked)&&Date.now()-checked<Number(cfg.freshHours)*3_600_000;
}

const prior=await priorDiscovery();
// Version changes invalidate source caches; ordinary scans reuse only a short
// freshness window, and keep the original source scan timestamp visible.
const force=process.env.FORCE_DISCOVERY==='1'||process.env.SCAN_TRIGGER==='workflow_dispatch';
if(prior&&!force&&isFresh(prior)){
  const refreshed=await refreshCachedDiscoveryCosts(prior);
  await publishExisting(refreshed);console.log(`选品发现使用 ${prior.checkedAt} 的缓存，共 ${refreshed.products?.length||0} 个候选，并续查待核验成本`);process.exit(0);
}

async function xianyuStateFromEnv(){
  sessionManager=await loadXianyuSession(root);return sessionManager.file;
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
      const labels=[link.getAttribute('aria-label'),...[...link.querySelectorAll('[aria-label]')].map(node=>node.getAttribute('aria-label'))].filter(Boolean);
      const image=link.querySelector('img:not([alt="売り切れ"])');
      const searchText=`${link.innerText||''} ${link.textContent||''} ${labels.join(' ')} ${image?.alt||''}`.replace(/\s+/g,' ').trim();
      const lines=(link.innerText||'').split(/\n+/).map(value=>value.trim()).filter(Boolean);
      const priceLine=lines.find(value=>/^[¥￥]?\s*[\d,]+円?$/.test(value.replace(/^現在\s*/,'')))||'';
      const priceMatch=priceLine.match(/[\d,]+/)||searchText.match(/[¥￥]\s*([\d,]+)/)||searchText.match(/([\d,]+)円/);
      const price=priceMatch?Number((priceMatch[1]||priceMatch[0]).replace(/[¥￥,]/g,'')):null;
      let title=lines.filter(value=>value!==priceLine&&!/^[¥￥]$/.test(value)&&value!=='現在'&&!/^(?:売り切れ(?:ました)?|SOLD(?:\s*OUT)?)$/i.test(value)).at(-1)||image?.alt||'';
      const labelledTitle=labels.find(value=>/の(?:画像|サムネイル)/.test(value))?.replace(/の(?:画像|サムネイル).*$/,'').trim()||'';
      if(!title||title.length<4||/^(?:PR|広告|おすすめ)$/.test(title))title=labelledTitle||image?.alt||title;
      title=title.replace(/の(?:サムネイル|画像).*$/,'').trim();
      seen.add(href.split('?')[0]);output.push({id:(href.match(/\/item\/(m\d+)/)||[])[1],href,title,price,sold,image:image?.currentSrc||image?.src||'',searchText});
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
    await page.waitForTimeout(1100);
    const count=await page.locator('main a[href^="/item/"]').count();
    stable=count===prior?stable+1:0;prior=count;if(stable>=4)break;
  }
}

async function collectMercariPages(page,{pages=1,scrolls=4,keyword=null}={}){
  const collected=new Map(),seen=new Set();let pageCount=0,hasMore=false;
  for(let index=0;index<pages;index++){
    if(seen.has(page.url()))break;seen.add(page.url());
    await waitForMercariGrid(page,25000);
    await expandMercariGrid(page,scrolls);
    for(const card of await mercariCards(page,{onlySold:false,assumeSold:false})){
      if(!keyword||containsDiscoveryKeyword(`${card.title} ${card.searchText}`,keyword))collected.set(card.id||card.href,card);
    }
    pageCount++;
    const next=page.getByRole('link',{name:'次へ',exact:true});
    const href=await next.first().getAttribute('href').catch(()=>null);
    const nextUrl=nextMercariPage(href,page.url());hasMore=Boolean(nextUrl&&!seen.has(nextUrl));
    if(!hasMore||index+1>=pages)break;
    await page.goto(nextUrl,{waitUntil:'domcontentloaded',timeout:35000});await settle(page,2500);
  }
  return {cards:[...collected.values()],pages:pageCount,truncated:hasMore};
}

async function waitForMercariGrid(page,timeoutMs=35000){
  const deadline=Date.now()+timeoutMs;let prior=-1,stablePositive=0,current=0;
  while(Date.now()<deadline){
    current=await page.locator('main a[href^="/item/"]').count().catch(()=>0);
    stablePositive=current>0&&current===prior?stablePositive+1:0;
    if(stablePositive>=2)return current;
    prior=current;await page.waitForTimeout(1500);
  }
  return current;
}

async function mercariSearchSnapshot(page,keyword){
  return page.locator('main a[href^="/item/"]').evaluateAll((links,keyword)=>{
    const compact=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
    const wanted=compact(keyword),seen=new Set();let keywordCards=0;
    for(const link of links){
      const href=(link.getAttribute('href')||'').split('?')[0];if(!href||seen.has(href))continue;seen.add(href);
      const labels=[link.getAttribute('aria-label'),...[...link.querySelectorAll('[aria-label]')].map(node=>node.getAttribute('aria-label'))].filter(Boolean).join(' ');
      const evidence=`${link.innerText||''} ${link.textContent||''} ${labels} ${link.querySelector('img')?.alt||''}`;
      if(wanted&&compact(evidence).includes(wanted))keywordCards++;
    }
    return {count:seen.size,keywordCards};
  },keyword);
}

async function waitForMercariSearch(page,keyword=cfg.keyword){
  let snapshot={count:0,keywordCards:0};
  for(let attempt=0;attempt<2;attempt++){
    const deadline=Date.now()+45000;let prior='',stableKeyword=0;
    while(Date.now()<deadline){
      snapshot=await mercariSearchSnapshot(page,keyword).catch(()=>({count:0,keywordCards:0}));
      const signature=`${snapshot.count}:${snapshot.keywordCards}`;
      stableKeyword=snapshot.keywordCards>0&&signature===prior?stableKeyword+1:0;
      if(stableKeyword>=2)return snapshot;
      prior=signature;await page.waitForTimeout(1500);
    }
    if(attempt===0){
      // Mercari may keep a temporary advertising grid while the actual keyword
      // results are still loading. Reload once, then wait for keyword evidence.
      await page.reload({waitUntil:'domcontentloaded',timeout:35000});await settle(page,3000);
    }
  }
  return snapshot;
}

async function mercariDetail(page,url){
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await settle(page,2600);
  await page.locator('[data-testid="item-detail-container"],main article').first().waitFor({state:'attached',timeout:12000}).catch(()=>{});
  await page.locator('[data-testid="name"],main h1').first().waitFor({state:'attached',timeout:8000}).catch(()=>{});
  await page.locator('[data-testid="checkout-button"]').first().waitFor({state:'attached',timeout:8000}).catch(()=>{});
  const item=await page.evaluate(()=>{
    const article=document.querySelector('main article')||document.querySelector('main');
    const text=(article?.innerText||'').replace(/\n{3,}/g,'\n\n');
    const heading=[...article.querySelectorAll('h2')].find(node=>node.textContent?.trim()==='商品の説明');
    const description=(heading?.nextElementSibling?.innerText||'').trim();
    // The product timestamp follows its description; never pick the first
    // relative date from recommendations or buyer comments in the whole page.
    let listingTimeText='';
    for(let node=heading?.nextElementSibling;node;node=node.nextElementSibling){
      if(/^H[123]$/.test(node.tagName))break;
      const value=(node.innerText||'').trim();
      if(/^\d+\s*(?:分|時間|日|週間|ヶ月)前$/.test(value)){listingTimeText=value;break}
    }
    const title=article.querySelector('h1')?.innerText?.trim()||document.title.replace(/\s*-\s*メルカリ.*$/,'');
    const priceText=[...article.querySelectorAll('*')].find(node=>/^[¥￥]\s*[\d,]+$/.test(node.textContent?.trim()||''))?.textContent||'';
    const price=Number((priceText.match(/[\d,]+/)||[])[0]?.replaceAll(',',''))||null;
    const seller=[...article.querySelectorAll('a[href*="/user/profile/"]')][0];
    const images=[...article.querySelectorAll('[aria-label^="商品画像"] img,[aria-label^="商品サムネイル"] img')].map(image=>image.currentSrc||image.src).filter(Boolean);
    const condition=(text.match(/商品の状態\s*([^\n]+)/)||[])[1]||'';
    const checkoutText=(article.querySelector('[data-testid="checkout-button"]')?.innerText||'').trim();
    return {title,price,description,text,checkoutText,condition,listingTimeText,sellerUrl:seller?.href||'',sellerId:(seller?.href.match(/\/user\/profile\/(\d+)/)||[])[1]||'',sellerName:(seller?.innerText||'').split('\n')[0].trim(),images:[...new Set(images)].slice(0,10)};
  });
  return {...item,sold:mercariSoldEvidence(item)};
}

async function mercariSellerCards(page,url){
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await settle(page,2500);
  const result=await collectMercariPages(page,{pages:Number(cfg.sellerPages),scrolls:cfg.mercariSellerScrolls});
  sourceScanStats.mercariSellerPages+=result.pages;
  if(result.truncated)sourceScanStats.mercariSellerPageCaps++;
  const cards=result.cards,marked=cards.filter(card=>card.sold);
  return (marked.length?marked:cards).slice(0,Number(cfg.sellerCardLimit));
}

async function scanMercari(context,errors){
  const page=await context.newPage(),detail=await context.newPage(),origin='https://jp.mercari.com';
  const sellers=new Map(),groups=[];
  try{
    const excluded=new Set((cfg.excludeMercariSellerIds||[]).map(String));
    const searchTerms=[...new Set(cfg.mercariKeywords||[cfg.keyword,'上海限定','bilibili 限定'])];
    const rawById=new Map();
    for(const keyword of searchTerms){
      if(sourceBudgetExpired('mercari'))break;
      await page.goto(mercariDiscoverySearchUrl({...cfg,keyword}),{waitUntil:'domcontentloaded',timeout:35000});await settle(page,4200);
      const initialCards=await waitForMercariSearch(page,keyword);
      console.log(`[选品源] Mercari「${keyword}」稳定卡片 ${initialCards.count}，关键词卡片 ${initialCards.keywordCards}`);
      const result=await collectMercariPages(page,{pages:Number(cfg.searchPages),scrolls:cfg.mercariSearchScrolls,keyword});
      sourceScanStats.mercariSearchPages+=result.pages;
      if(result.truncated)sourceScanStats.mercariSearchPageCaps++;
      const cards=result.cards.filter(card=>Number(card.price)>=cfg.minPriceJPY);
      for(const card of cards)if(containsDiscoveryKeyword(`${card.title} ${card.searchText}`,keyword))rawById.set(card.id||card.href,card);
    }
    const rawSeeds=[...rawById.values()];
    const markedSeeds=rawSeeds.filter(card=>card.sold);
    const seeds=(markedSeeds.length?markedSeeds:rawSeeds).slice(0,Number(cfg.seedLimitPerPlatform));
    let verifiedSeeds=0;
    for(const [index,seed] of seeds.entries()){
      if(sourceBudgetExpired('mercari'))break;
      try{
        const item=await mercariDetail(detail,cleanItemHref(seed.href,origin));
        if(item.sold&&/(?:中国\s*限定|上海\s*限定|bilibili.{0,12}限定)/i.test(`${item.title} ${item.description}`)){
          verifiedSeeds++;
          if(item.sellerId&&!excluded.has(String(item.sellerId))&&!sellers.has(item.sellerId))sellers.set(item.sellerId,{id:item.sellerId,name:item.sellerName||item.sellerId,url:item.sellerUrl,seed:item});
        }
      }catch(error){errors.push(`Mercari种子${index+1}: ${String(error)}`)}
      await wait(450);
    }
    Object.assign(sourceScanStats,{mercariRawCards:rawSeeds.length,mercariMarkedSeeds:markedSeeds.length,mercariSeeds:verifiedSeeds,mercariSellers:sellers.size});
    console.log(`[选品源] Mercari 关键词卡片 ${rawSeeds.length}，页面标记已售 ${markedSeeds.length}，详情确认已售 ${verifiedSeeds}，检查卖家 ${sellers.size}`);
    const selectedSellers=rotateDiscoverySellers([...sellers.values()],sellerAttempts.mercari,Number(cfg.sellerLimitPerPlatform));
    sourceScanStats.mercariSellersDeferred=sellers.size-selectedSellers.length;
    for(const seller of selectedSellers){
      if(sourceBudgetExpired('mercari'))break;
      sellerAttempts.mercari[seller.id]=new Date().toISOString();
      try{
        const cards=await mercariSellerCards(page,seller.url);
        const likely=clusterSellerSales(cards.filter(card=>Number(card.price)>=cfg.minPriceJPY)).filter(group=>group.items.length>=Number(cfg.minSalesPerSeller));
        sourceScanStats.mercariSellerCards+=(cards.length||0);sourceScanStats.mercariRepeatedGroups+=(likely.length||0);
        for(const group of likely){
          if(sourceBudgetExpired('mercari'))break;
          const verified=[];
          for(const card of group.items.slice(0,8)){
            try{
              const item=await mercariDetail(detail,cleanItemHref(card.href,origin));
              if(item.sold){
                const soldAt=parseListingTime(item.listingTimeText);
                if(!soldAt)sourceScanStats.mercariMissingDate++;
                const verifiedCard={...card,...item,sold:true,soldAt,timeEvidence:'listing_page_relative',url:cleanItemHref(card.href,origin)};
                if(eligibleDiscoveryCard(verifiedCard,cfg))verified.push(verifiedCard);
              }
            }catch(error){errors.push(`Mercari成交${card.id}: ${String(error)}`)}
            if(verified.length>=6)break;await wait(350);
          }
          if(verified.length<Number(cfg.minSalesPerSeller))continue;
          const representative=verified.sort((a,b)=>Date.parse(b.soldAt)-Date.parse(a.soldAt))[0];
          if(!isChinaLimitedProduct(representative))continue;
          groups.push(makeSourceCandidate('mercari',seller,verified,representative));
        }
      }catch(error){errors.push(`Mercari卖家${seller.id}: ${String(error)}`)}
    }
  }catch(error){errors.push(`Mercari搜索: ${String(error)}`)}
  finally{await Promise.allSettled([page.close(),detail.close()])}
  return groups;
}

function yahooCard(raw){
  return {id:raw.id,title:raw.title||'',price:Number(raw.price),sold:raw.itemStatus==='SOLD',soldAt:raw.endTime||null,timeEvidence:'sale_end_time',
    image:raw.thumbnailImageUrl||'',sellerId:raw.sellerId||'',url:`https://paypayfleamarket.yahoo.co.jp/item/${raw.id}`};
}

async function scanYahoo(errors,owned){
  const search=yahooDiscoverySearchUrl(cfg);
  const sellers=new Map(),groups=[];
  try{
    const first=await fetchYahooResult(search,settings),results=[first];
    const searchPages=Math.min(Number(cfg.yahooSearchPages||cfg.searchPages||2),Math.max(1,Math.ceil(Number(first.totalResultsAvailable||first.items?.length||0)/100)));
    for(let page=2;page<=searchPages;page++)results.push(await fetchYahooResult(`${search}&page=${page}`,settings));
    sourceScanStats.yahooSearchPages=results.length;
    sourceScanStats.yahooSearchAvailable=Number(first.totalResultsAvailable||0);
    const seeds=results.flatMap(result=>result.items||[]).map(yahooCard)
      .filter(card=>card.sold&&card.price>=cfg.minPriceJPY&&!isOwnedDiscoverySource(card,owned)).slice(0,Number(cfg.seedLimitPerPlatform));
    for(const card of seeds){if(card.sellerId&&!owned.sellerIds.has(String(card.sellerId))&&!sellers.has(card.sellerId))sellers.set(card.sellerId,{id:card.sellerId,name:card.sellerId,url:`https://paypayfleamarket.yahoo.co.jp/user/${card.sellerId}`})}
    sourceScanStats.yahooSeeds=seeds.length;sourceScanStats.yahooSellers=sellers.size;
    console.log(`[选品源] Yahoo 成交种子 ${seeds.length}，排除自有卖家 ${owned.sellerIds.size}，检查卖家 ${sellers.size}`);
    const selectedSellers=rotateDiscoverySellers([...sellers.values()],sellerAttempts.yahoo,Number(cfg.sellerLimitPerPlatform));
    sourceScanStats.yahooSellersDeferred=sellers.size-selectedSellers.length;
    for(const seller of selectedSellers){
      if(sourceBudgetExpired('yahoo'))break;
      sellerAttempts.yahoo[seller.id]=new Date().toISOString();
      try{
        const firstProfile=await fetchYahooResult(`${seller.url}?page=1&sort=openTime&order=desc`,settings),profileResults=[firstProfile];
        const profilePages=Math.min(Number(cfg.sellerPages||1),Math.max(1,Math.ceil(Number(firstProfile.totalResultsAvailable||firstProfile.items?.length||0)/100)));
        for(let page=2;page<=profilePages;page++)profileResults.push(await fetchYahooResult(`${seller.url}?page=${page}&sort=openTime&order=desc`,settings));
        sourceScanStats.yahooSellerPages+=profileResults.length;
        sourceScanStats.yahooSellerCards+=profileResults.reduce((sum,profile)=>sum+(profile.items?.length||0),0);
        sourceScanStats.yahooMissingSaleDate+=profileResults.flatMap(profile=>profile.items||[]).filter(raw=>raw.itemStatus==='SOLD'&&!raw.endTime).length;
        const cards=profileResults.flatMap(profile=>profile.items||[]).map(yahooCard)
          .filter(card=>eligibleDiscoveryCard(card,cfg)&&!isOwnedDiscoverySource(card,owned)).slice(0,Number(cfg.sellerCardLimit));
        const likely=clusterSellerSales(cards).filter(group=>group.items.length>=Number(cfg.minSalesPerSeller));
        for(const group of likely){
          const verified=group.items.filter(card=>eligibleDiscoveryCard(card,cfg));if(verified.length<Number(cfg.minSalesPerSeller))continue;
          const representative=verified.sort((a,b)=>Date.parse(b.soldAt)-Date.parse(a.soldAt))[0];
          try{
            const bundle=await fetchYahooItemBundle(representative.id,settings),detail=bundle.detail;
            representative.description=detail.description||'';representative.condition=detail.condition?.name||detail.condition||'';
            representative.images=(detail.images||[]).map(image=>typeof image==='string'?image:image?.url).filter(Boolean).slice(0,10);
            seller.name=detail.seller?.displayName||detail.seller?.name||detail.seller?.nickname||seller.id;
          }catch(error){errors.push(`Yahoo详情${representative.id}: ${String(error)}`);representative.images=[representative.image].filter(Boolean)}
          if(!isChinaLimitedProduct(representative))continue;
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
    id:discoveryId(platform,seller.id,title),productKey:normalizeProductIdentity(canonicalSaleTitle(title)),sourcePlatform:platform,seller:{id:seller.id,name:seller.name,url:seller.url},
    salesCount:sold.length,platformSales:{[platform]:sold.length},saleDates:sold.map(item=>item.soldAt).filter(Boolean).sort().reverse(),sourcePriceJPY:median(sold.map(item=>item.price)),
    timeEvidence:platform==='mercari'?'listing_page_relative':'sale_end_time',
    saleRecords:sold.map(item=>({url:item.url,date:item.soldAt,price:item.price,platform,timeEvidence:item.timeEvidence})),
    sourcePricesJPY:sold.map(item=>item.price).filter(Number.isFinite),sourceTitle:title,sourceDescription:description,sourceUrl:representative.url,
    sourceUrls:sold.map(item=>item.url).filter(Boolean).slice(0,8),sourceImages:[...(representative.images||[]),representative.image].filter(Boolean).slice(0,8),
    xianyuQuery:xianyuQueryFor(title),...rewrite
  };
}

function aggregateAcrossPlatforms(candidates=[]){
  return groupDiscoveryCandidates(candidates).map(members=>{
    const representative=[...members].sort((a,b)=>b.salesCount-a.salesCount||b.sourcePriceJPY-a.sourcePriceJPY)[0];
    const saleKeys=new Set(),dates=[],prices=[],urls=[];const platformSales={};
    for(const member of members){
      platformSales[member.sourcePlatform]=(platformSales[member.sourcePlatform]||0)+member.salesCount;
      for(const sale of member.saleRecords||[]){
        const key=sale.url;if(!key||saleKeys.has(key))continue;saleKeys.add(key);
        urls.push(sale.url);if(sale.date)dates.push(sale.date);if(Number.isFinite(sale.price))prices.push(sale.price);
      }
    }
    const salesCount=Object.values(platformSales).reduce((sum,value)=>sum+value,0);
    const rewrite=rewriteListing({title:representative.sourceTitle,description:representative.sourceDescription,condition:'',saleCount:salesCount});
    const sellerIds=[...new Set(members.map(member=>member.seller?.id).filter(Boolean))];
    return {...representative,id:discoveryId('all','cross-platform',representative.sourceTitle),salesCount,platformSales,sellerIds,sellerCount:sellerIds.length,
      sourcePlatforms:Object.keys(platformSales),sourceUrls:urls.slice(0,20),saleDates:dates.sort().reverse(),sourcePricesJPY:prices,
      sourcePriceJPY:median(prices)||representative.sourcePriceJPY,timeEvidence:members.some(member=>member.timeEvidence==='listing_page_relative')?'listing_page_relative':'sale_end_time',...rewrite};
  });
}

const errors=[],authState=await xianyuStateFromEnv();
let browser,context,xPage,xianyuAuthRequired=false;
const sourceCandidates=[];
const sellerAttempts={mercari:{...(prior?.sellerAttempts?.mercari||{})},yahoo:{...(prior?.sellerAttempts?.yahoo||{})}};
const sourceScanStats={mercariRawCards:0,mercariMarkedSeeds:0,mercariSeeds:0,mercariSellers:0,mercariSellerCards:0,mercariRepeatedGroups:0,mercariSearchPages:0,mercariSellerPages:0,mercariSearchPageCaps:0,mercariSellerPageCaps:0,mercariMissingDate:0,yahooSeeds:0,yahooSellers:0,yahooSearchPages:0,yahooSellerPages:0,yahooSellerCards:0,yahooMissingSaleDate:0};
let sourceDeadline=Infinity;
function sourceBudgetExpired(platform){
  if(Date.now()<sourceDeadline)return false;
  sourceScanStats[`${platform}BudgetLimited`]=true;return true;
}
let ranked=[];
try{
  const latest=await latestPriceSnapshot(),owned=await completeOwnedScope(latest);
  sourceDeadline=Date.now()+Number(cfg.sourceBudgetMinutes||25)*60_000;
  // The price scan already tested this session. Do not repeat a known blocked
  // detail request in the discovery stage of the same publication.
  if(latest?.login?.xianyuRequired&&Date.now()-Date.parse(latest.checkedAt)<60*60_000)xianyuAuthRequired=true;
  const opened=await openContext(authState);browser=opened.browser;context=opened.context;
  const [mercari,yahoo]=await Promise.all([scanMercari(context,errors),scanYahoo(errors,owned)]);sourceCandidates.push(...mercari,...yahoo);
  const dismissed=Object.values(latest?.dismissedDiscoveries||{});
  const filtered=await excludeOwnedAndUploaded(aggregateAcrossPlatforms(sourceCandidates),owned,dismissed);
  sourceScanStats.afterOwnedExclusion=filtered.length;
  ranked=rankDiscoveryCandidates(filtered,{maxProducts:Number(cfg.maxProducts),minSales:Number(cfg.minSalesPerSeller),perSeller:Number(cfg.maxProductsPerSeller||4)});
  sourceScanStats.deferredByDisplayLimit=filtered.length-ranked.length;
  const reviews=Object.values(latest?.discoveryReviews||{});
  const reviewFor=item=>reviews.find(record=>String(record.productKey||'')===discoveryDismissalKey(item)||(record.title&&sameDiscoveryProduct({title:item.sourceTitle},{title:record.title})));
  xPage=await context.newPage();
  for(const [index,item] of ranked.entries()){
    const review=reviewFor(item),reviewImages=[...new Set(review?.images||[])].filter(url=>/^https?:\/\//i.test(url)).slice(0,12);
    if(positivePrice(review?.purchaseCNY)!==null&&reviewImages.length>=3){
      Object.assign(item,{purchaseCNY:Number(review.purchaseCNY),images:reviewImages,imageSource:'user_verified',status:'ready',confidence:'用户确认',manualReview:review});applyDiscoveryProfit(item);
      console.log(`[选品 ${index+1}/${ranked.length}] ${item.sourcePlatform} 月销${item.salesCount} ${item.sourceTitle} 用户核验=${item.purchaseCNY} 图片=${item.images.length}`);continue;
    }
    if(xianyuAuthRequired){Object.assign(item,{status:'needs_xianyu_review',purchaseCNY:null,images:[],confidence:'待核验：本轮闲鱼详情验证受阻',xianyu:{status:'deferred_auth'}});applyDiscoveryProfit(item);continue}
    try{
      const xianyu=await xianyuCost(xPage,{id:item.id,title:item.sourceTitle,description:item.sourceDescription||'',xianyuQuery:item.xianyuQuery,image:item.sourceImages[0],images:item.sourceImages,yahoo:{ownImages:item.sourceImages}},settings);
      await sessionManager.persist(context,xianyu).catch(()=>console.warn('[闲鱼会话] 更新保存失败，保留原会话'));
      const validated=validDiscoveryXianyu(xianyu);Object.assign(item,{xianyu,purchaseCNY:validated.ready?xianyu.averageCNY:null,referenceCNY:xianyu.averageCNY,images:validated.images,
        imageSource:validated.imageSource,status:validated.ready?'ready':'needs_xianyu_review',xianyuSearchUrl:xianyu.searchUrl,confidence:validated.ready?'自动核验参考价':xianyuReviewLabel(xianyu.status),costVerification:validated});applyDiscoveryProfit(item);
      if(['login_required','blocked'].includes(xianyu.status))xianyuAuthRequired=true;
    }catch(error){errors.push(`闲鱼${item.id}: ${String(error)}`);Object.assign(item,{status:'needs_xianyu_review',purchaseCNY:null,images:[],confidence:'需人工',xianyuSearchUrl:`https://www.goofish.com/search?q=${encodeURIComponent(item.xianyuQuery)}`})}
    if(review){
      if(positivePrice(review.purchaseCNY)!==null)item.purchaseCNY=Number(review.purchaseCNY);
      if(reviewImages.length)item.images=reviewImages;
      item.manualReview=review;
    }
    console.log(`[选品 ${index+1}/${ranked.length}] ${item.sourcePlatform} 月销${item.salesCount} ${item.sourceTitle} 闲鱼=${item.purchaseCNY??'待核验'} 状态=${item.xianyu?.status||'error'} 卡片=${item.xianyu?.cardCount??0} 初筛=${item.xianyu?.preliminaryCount??0} 核验=${item.xianyu?.verifiedCount??0} 利润=${item.estimatedProfitJPY??'待核验'} 图片=${item.images?.length||0} 候选=${JSON.stringify(item.xianyu?.topCandidates||[])}`);
    await wait(600);
  }
}finally{await browser?.close().catch(()=>{})}

const rejectedLowProfit=ranked.filter(item=>item.status==='rejected_low_profit');
const products=ranked.filter(item=>item.status!=='rejected_low_profit');
const result={version:DISCOVERY_VERSION,codeSha:process.env.GITHUB_SHA||null,sellerAttempts,checkedAt:new Date().toISOString(),filters:{keyword:cfg.keyword,soldOnly:true,minPriceJPY:cfg.minPriceJPY,sort:'2d_then_7d_then_30d',windowDays:cfg.windowDays,minSalesPerSeller:cfg.minSalesPerSeller},
  products,stats:{sourceCandidates:sourceCandidates.length,...sourceScanStats,rejectedLowProfit:rejectedLowProfit.length,ready:products.filter(item=>item.status==='ready').length,pending:products.filter(item=>item.status!=='ready').length,
    mercari:products.filter(item=>item.sourcePlatform==='mercari'||item.sourcePlatforms?.includes('mercari')).length,
    yahoo:products.filter(item=>item.sourcePlatform==='yahoo'||item.sourcePlatforms?.includes('yahoo')).length},
  login:{xianyuRequired:xianyuAuthRequired},errors:errors.slice(0,30)};

function statusFor(value){return {version:value.version,codeSha:value.codeSha||null,checkedAt:value.checkedAt,total:value.products?.length||0,ready:value.stats?.ready||0,pending:value.stats?.pending||0,mercari:value.stats?.mercari||0,yahoo:value.stats?.yahoo||0,xianyuLoginRequired:Boolean(value.login?.xianyuRequired),sourceStats:value.stats||{},errors:value.errors||[]}}
const candidateChangeKey=item=>item.productKey||normalizeProductIdentity(canonicalSaleTitle(item.sourceTitle||item.proposedTitle||''))||item.id;
const priorKeys=new Set((prior?.products||[]).map(candidateChangeKey)),nextKeys=new Set(products.map(candidateChangeKey));
const added=[...nextKeys].filter(key=>!priorKeys.has(key)),removed=[...priorKeys].filter(key=>!nextKeys.has(key));
const addedSet=new Set(added),addedProducts=products.filter(item=>addedSet.has(candidateChangeKey(item)));
const changeSummary={hasChanges:added.length+removed.length>0,total:added.length+removed.length,added:added.length,removed:removed.length,
  addedReady:addedProducts.filter(item=>item.status==='ready').length,addedPending:addedProducts.filter(item=>item.status!=='ready').length,
  addedIds:added,removedIds:removed,firstRun:!prior};
const sealed=encrypt(Buffer.from(JSON.stringify(result)),password),status=statusFor(result);
await Promise.all([fs.writeFile(stateEnc,sealed),fs.writeFile(publicEnc,sealed),fs.writeFile(stateStatus,JSON.stringify(status,null,2)),fs.writeFile(publicStatus,JSON.stringify(status,null,2)),
  fs.writeFile(path.join(root,'data','discovery-change-summary.json'),JSON.stringify(changeSummary,null,2))]);
console.log(JSON.stringify({...status,errors:errors.length,changes:changeSummary.total}));
