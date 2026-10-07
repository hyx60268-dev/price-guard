// Read-only adapter for the exact retail detail observed on 2026-10-07.
// The shop states stock and payable full price publicly; checkout is never opened.
export const ALTER_NARBERAL_URL='https://www.alter-shanghai.cn/m/spotPage/298.html';
export const ALTER_NARBERAL_SKU='AL20744';
const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
export function alterTargetIssue(item={}){
 const value=clean([item.title,item.sourceDetail?.title].filter(Boolean).join(' '));
 const description=clean([item.description,item.sourceDetail?.description,item.yahoo?.ownDescription].filter(Boolean).join(' '));
 if(!/(?:\bALTER\b|アルター|阿尔塔)/i.test(value)||!/(?:ナーベラル[・·\s]*ガンマ|娜[贝貝]拉[尔爾][・·\s]*[伽迦]玛|Narberal\s*(?:Gamma|Γ))/i.test(value)||!/so[\s-]*bin/i.test(value))return 'target_product_mismatch';
 if(/空箱(?:のみ|だけ)|(?:外箱|箱)のみ|(?:杖|武器|台座|パーツ|附件|配件)(?:のみ|だけ|单独|单品)|本体(?:なし|無し|は付属しません)|不含(?:手办|本体)/i.test(value+' '+description))return 'target_sale_content_mismatch';
 const scales=[...value.matchAll(/(?:^|[^\d])1\s*[/／:]\s*(\d+)(?!\d)/g)].map(m=>Number(m[1]));
 // Body dates are not dimensions; require an explicit scale/figure descriptor.
 for(const match of description.matchAll(/(?:比例\s*[:：]?\s*|scale\s*[:：]?\s*)1\s*[/／:]\s*(\d+)|1\s*[/／:]\s*(\d+)\s*(?:スケール|scale|フィギュア|手办)/gi))scales.push(Number(match[1]||match[2]));
 if(scales.some(scale=>scale!==8))return 'target_scale_mismatch';
 if(/初版|初回版|2019年|first\s*(?:edition|release)/i.test(value+' '+description))return 'target_release_mismatch';
 const models=value.match(/\bAL\d{4,8}\b/gi)||[];
 return models.every(model=>model.toUpperCase()===ALTER_NARBERAL_SKU)?null:'target_product_mismatch';
}
export const isAlterNarberalTarget=item=>!alterTargetIssue(item);

export function isAlterProcurementUrl(value){
 try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.alter-shanghai.cn'&&!u.port&&!u.username&&!u.password&&u.pathname==='/m/spotPage/298.html'&&!u.search&&!u.hash}catch{return false}
}
// A new readable supplier invalidates only prior negative reviews for its target.
export const procurementSourcePlanVersion=item=>isAlterNarberalTarget(item)?2:1;
export const currentProcurementSourcePlan=(reference,item)=>(reference?.sourcePlanVersion||1)===procurementSourcePlanVersion(item);
export function readAlterPublicDOM(){
 const visible=node=>{if(!node)return false;for(let n=node;n;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false}const r=node.getBoundingClientRect();return r.width>0&&r.height>0};
 const text=node=>node&&visible(node)?(node.innerText||'').replace(/\s+/g,' ').trim():'';
 const roots=[...document.querySelectorAll('.spot_one')].filter(visible);
 const root=roots.length===1?roots[0]:null;
 const rows=root?[...root.querySelectorAll('h2 p.plis')].map(text).filter(Boolean):[];
 const tableRows=[...document.querySelectorAll('.spot_two table tr')].filter(visible).map(row=>[...row.querySelectorAll('td')].map(text));
 const fields={};let duplicateFields=false;for(const row of tableRows){if(row.length!==2||!row[0])continue;if(Object.hasOwn(fields,row[0]))duplicateFields=true;fields[row[0]]=row[1]}
 const terms=[...document.querySelectorAll('.spot_thr .int_cps')].map(text).filter(Boolean).join('\n');
 const images=[...new Set([...document.querySelectorAll('.swiper-zoom-container img')].map(n=>n.currentSrc||n.src).filter(url=>/^https:\/\/www\.alter-shanghai\.cn\/files\/images\/narberal_[a-z0-9]+\.jpg$/.test(url)))];
 const blocked=[...document.querySelectorAll('iframe,form')].some(n=>visible(n)&&/captcha|challenge|baxia|\/punish/i.test((n.getAttribute('src')||'')+' '+n.id));
 const login=[...document.querySelectorAll('input[type="password"],iframe[src*="login"],[role="dialog"][class*="login"]')].some(visible);
 return {url:location.href,title:root?text(root.querySelector('h1')):'',rows,fields,duplicateFields,terms,images,blocked,login};
}
export function alterQuoteFromDOM(dom,item={},url=ALTER_NARBERAL_URL){
 const fail=(reason,status='incomplete')=>({status,reason,reviewComplete:status==='incomplete'});
 if(!isAlterProcurementUrl(url)||!isAlterProcurementUrl(dom?.url))return fail('target_redirect_mismatch','unavailable');
 if(dom.blocked||dom.login)return fail(dom.blocked?'source_challenge':'source_login_required','unavailable');
 if(alterTargetIssue(item))return fail(alterTargetIssue(item));
 const f=dom.fields||{};
 if(dom.duplicateFields||f['品牌']!=='ALTER'||f['型号']!==ALTER_NARBERAL_SKU||clean(dom.title)!==clean(f['产品名'])||!/娜贝拉尔·伽玛 so-bin Ver\.【再版】/.test(dom.title||'')||f['作品名']!=='OVERLORD'||!/^1\/8(?:\s|$)/.test(clean(f['比例']))||f['到货月份']!=='2024年11月')return fail('target_product_unconfirmed');
 const priceRows=(dom.rows||[]).filter(row=>/^全额[：:]/.test(clean(row)));
 if(priceRows.length!==1||!/^全额[：:]\s*[￥¥]\s*\d+(?:\.\d{1,2})?$/.test(clean(priceRows[0])))return fail('full_price_unconfirmed');
 const unitCNY=Number(clean(priceRows[0]).match(/[￥¥]\s*(\d+(?:\.\d{1,2})?)/)?.[1]);
 const listedPrice=clean(f['贩卖价格']).match(/^RMB\s*(\d+(?:\.\d{1,2})?)元$/)?.[1];
 if(!(unitCNY>0)||Number(listedPrice)!==unitCNY)return fail('price_evidence_mismatch');
 const stock=(dom.rows||[]).filter(row=>/^库存[：:]/.test(clean(row)));
 if(stock.length!==1||!/^库存[：:]\s*有库存\s*\(限购1件\)$/.test(clean(stock[0])))return fail(stock.some(row=>/无库存|缺货|售罄/.test(row))?'out_of_stock':'stock_unconfirmed');
 const shipping=(dom.rows||[]).filter(row=>/^运费[：:]/.test(clean(row)));
 if(shipping.length!==1||!/^运费[：:]\s*免运费$/.test(clean(shipping[0]))||!/中通快递\(包邮\)、顺丰速运\(到付\)/.test(clean(dom.terms)))return fail('shipping_method_unconfirmed');
 const images=(dom.images||[]).filter(value=>/^https:\/\/www\.alter-shanghai\.cn\/files\/images\/narberal_[a-z0-9]+\.jpg$/.test(value));
 if(!images.length)return fail('product_gallery_missing');
 return {status:'quoted',source:'alter_shanghai',id:'298',skuId:f['型号'],url:ALTER_NARBERAL_URL,canonicalUrl:ALTER_NARBERAL_URL,
 sellerKey:'alter_shanghai:retail',sellerName:'阿尔塔在线',sellerIdentityKey:'alter_shanghai:retail',
 unitCNY,shippingCNY:0,landedCNY:unitCNY,price:unitCNY,currency:'CNY',inStock:true,skuVerified:true,shippingKnown:true,
 shippingScope:'source_displayed_zto_delivery',shippingMethod:'中通快递（包邮）；顺丰速运到付不适用此报价',purchaseLimit:1,deliveryTerms:'中国大陆中通快递包邮；顺丰到付不适用此报价；限购1件',
 selectedVariant:f['型号']+' / '+f['产品名']+' / 1/8',
 brand:f['品牌'],series:f['作品名'],detailTitle:dom.title,detailDescription:['品牌：'+f['品牌'],'型号：'+f['型号'],'作品：'+f['作品名'],'到货：'+f['到货月份'],'比例：'+clean(f['比例']),'商品类别：'+f['商品类别']].join('；'),
 detailImages:images,priceSource:'target_detail',priceEvidence:'visible_full_price_and_stock',condition:'retail_unspecified',quantity:1,reviewComplete:true};
}
export async function readAlterProcurementDetail(url,{item,context,getContext,deadline=Date.now()+45000}={}){
 if(!isAlterProcurementUrl(url))return {status:'unsupported',reason:'unsupported_source',reviewComplete:false};
 if(alterTargetIssue(item))return {status:'incomplete',reason:alterTargetIssue(item),reviewComplete:true};
 const browser=context||await getContext?.();if(!browser)return {status:'unavailable',reason:'browser_context_required',reviewComplete:false};
 const page=await browser.newPage(),remaining=()=>Math.max(1,Math.min(15000,deadline-Date.now()));
 try{
  const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:remaining()});
  if(!isAlterProcurementUrl(page.url()))return {status:'unavailable',reason:'target_redirect_mismatch',reviewComplete:false};
  if(response?.status?.()>=400)return {status:'unavailable',reason:'source_http_'+response.status(),reviewComplete:false};
  await page.waitForFunction(()=>Boolean(document.querySelector('.spot_one h1')&&document.querySelector('.spot_two table')),{},{timeout:remaining()}).catch(()=>{});
  const dom=await page.evaluate(readAlterPublicDOM);
  return {...alterQuoteFromDOM(dom,item,url),diagnostic:{stage:'public_detail',finalHost:'www.alter-shanghai.cn',httpStatus:response?.status?.(),hasPublicState:false,challengeMarkerPresent:dom.blocked,loginFormPresent:dom.login}};
 }catch(error){return {status:'unavailable',reason:'detail_read_error',reviewComplete:false,diagnostic:{stage:'public_detail',failureKind:/timeout/i.test(error.name+' '+error.message)?'timeout':'reader_error'}}}
 finally{await page.close().catch(()=>{})}
}
