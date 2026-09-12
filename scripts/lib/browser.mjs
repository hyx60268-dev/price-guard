import { chromium } from 'playwright';

export async function openContext(storageStatePath) {
  const browser=await chromium.launch({headless:true,args:['--disable-blink-features=AutomationControlled']});
  const context=await browser.newContext({
    storageState:storageStatePath || undefined,
    locale:'ja-JP',timezoneId:'Asia/Tokyo',viewport:{width:1440,height:1000},
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
  });
  return {browser,context};
}

export async function cardsFromPage(page, domain) {
  return page.locator('a[href*="/item"]').evaluateAll((links,domain)=>{
    const seen=new Set(), out=[];
    for(const a of links){
      const href=a.href;if(!href||seen.has(href))continue;seen.add(href);
      let box=a; for(let i=0;i<4&&box.parentElement;i++){
        if((box.innerText||'').length>40)break; box=box.parentElement;
      }
      const text=(box.innerText||a.innerText||'').replace(/\s+/g,' ').trim();
      const img=box.querySelector('img')||a.querySelector('img');
      const id=(href.match(/[?&]id=([^&]+)/)||href.match(/\/item\/([^/?]+)/)||[])[1]||href;
      out.push({id,url:href,text,title:(a.innerText||text).replace(/\s+/g,' ').trim(),image:img?.currentSrc||img?.src||'',domain});
    }
    return out;
  },domain);
}

export async function settle(page,delay=1800){
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForTimeout(delay);
}
