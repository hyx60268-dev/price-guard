import {createHash} from 'node:crypto';
import {parse} from 'parse5';
import {ALTER_NARBERAL_URL,alterTargetIssue,alterQuoteFromDOM,isAlterProcurementUrl} from './alter-procurement.mjs';

const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const attrs=node=>Object.fromEntries((node.attrs||[]).map(a=>[a.name,a.value]));
const children=node=>node.childNodes||[];
const all=(node,predicate)=>[...(predicate(node)?[node]:[]),...children(node).flatMap(child=>all(child,predicate))];
const cls=(node,name)=>(attrs(node).class||'').split(/\s+/).includes(name);
const hidden=node=>{for(let n=node;n;n=n.parentNode){const a=attrs(n);if(Object.hasOwn(a,'hidden')||/(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$))/i.test(a.style||''))return true}return false};
const text=node=>clean(node.nodeName==='#text'?node.value:['script','style','template','#comment'].includes(node.nodeName)||hidden(node)?'':children(node).map(text).join(' '));
const one=(nodes)=>nodes.length===1?nodes[0]:null;
const failure=(reason,status='incomplete')=>({status,reason,reviewComplete:status==='incomplete'});

// Parse only this reviewed public product template. Scripts are never executed,
// and no account/session endpoint, cart or checkout is requested. The bounded
// literal guard below recognizes its server-rendered full-payment presentation.
export function parseAlterPublicHTML(html,item={},receipt={}){
 if(alterTargetIssue(item))return failure(alterTargetIssue(item));
 if(!isAlterProcurementUrl(receipt.finalUrl)||receipt.httpStatus!==200)return failure('target_response_unconfirmed','unavailable');
 const root=parse(String(html||'')),elements=all(root,n=>Boolean(n.tagName));
 if(elements.some(n=>!hidden(n)&&((n.tagName==='input'&&attrs(n).type==='password')||n.tagName==='iframe'&&/login/i.test(attrs(n).src||''))))return failure('source_login_required','unavailable');
 if(elements.some(n=>['iframe','form'].includes(n.tagName)&&/captcha|challenge|baxia|punish/i.test((attrs(n).src||'')+' '+(attrs(n).id||''))))return failure('source_challenge','unavailable');
 const product=one(elements.filter(n=>cls(n,'spot_one')&&!hidden(n)));
 const title=product&&one(all(product,n=>n.tagName==='h1'));
 const priceLabel=product&&one(all(product,n=>attrs(n).id==='yuan'));
 const rows=product?all(product,n=>n.tagName==='p'&&cls(n,'plis')&&!hidden(n)):[];
 const scriptText=elements.filter(n=>n.tagName==='script'&&!attrs(n).src).map(n=>children(n).map(c=>c.value||'').join('')).join('\n');
 const fullPayment=/if\s*\(\s*"2"\s*==\s*2\s*\)\s*\{\s*\$\("\.xs"\)\.hide\(\);\s*\}/.test(scriptText)&&/if\s*\(\s*"0\.00"\s*==\s*0\s*\|\|\s*"0\.00"\s*==\s*null\s*\)\s*\{\s*\$\("\.xs2"\)\.hide\(\);\s*\$\("#yuan"\)\.html\("全额："\);\s*\}/.test(scriptText);
 const priceRow=priceLabel?.parentNode;
 const priceText=priceRow&&text(priceRow);
 if(!product||!title||!priceLabel||!rows.includes(priceRow)||!fullPayment||!/^促销价:\s*[￥¥]\s*\d+(?:\.\d{1,2})?$/.test(priceText))return failure('public_price_template_unconfirmed');
 const zeroRows=rows.filter(n=>all(n,c=>cls(c,'xs')||cls(c,'xs2')).length);
 if(zeroRows.length!==2||!zeroRows.every(n=>/^(?:原价|定金):\s*[￥¥]\s*0\.00$/.test(text(n))))return failure('full_payment_unconfirmed');
 const table=one(elements.filter(n=>cls(n,'spot_two')&&!hidden(n)));
 const fields={};let duplicateFields=false;
 for(const tr of table?all(table,n=>n.tagName==='tr'&&!hidden(n)):[]){const cells=children(tr).filter(n=>n.tagName==='td');if(cells.length!==2)continue;const key=text(cells[0]);if(Object.hasOwn(fields,key))duplicateFields=true;fields[key]=text(cells[1]);}
 const quantityInput=one(elements.filter(n=>n.tagName==='input'&&attrs(n).id==='Stock'));
 if(fields['商品类别']!=='PVC&ABS涂装完成品'||attrs(quantityInput||{}).value!=='1')return failure('sale_unit_unconfirmed');
 const terms=elements.filter(n=>cls(n,'int_cps')&&!hidden(n)).map(text).join('\n');
 const images=[...new Set(elements.filter(n=>n.tagName==='img'&&n.parentNode&&cls(n.parentNode,'swiper-zoom-container')).map(n=>{try{return new URL(attrs(n).src,ALTER_NARBERAL_URL).href}catch{return ''}}))];
 const dom={url:receipt.finalUrl,title:text(title),rows:rows.filter(n=>!zeroRows.includes(n)).map(n=>n===priceRow?priceText.replace(/^促销价:/,'全额:'):text(n)),fields,duplicateFields,terms,images};
 const observed=alterQuoteFromDOM(dom,item);
 if(observed.status!=='quoted')return observed;
 // Published carrier terms are useful, but China alone does not establish the
 // actual receiving region or delivery coverage. Never invent landed cost.
 const quote={...observed,shippingKnown:false,shippingCNY:null,landedCNY:null,price:observed.unitCNY,
  shippingApplicability:'unconfirmed',checkedAt:receipt.fetchedAt,
  provenance:{...receipt,pageKind:'target_detail',contentSha256:receipt.contentSha256||createHash('sha256').update(html).digest('hex')}};
 quote.nativeObservation={source:quote.source,accessStatus:'readable',detailTitle:quote.detailTitle,...quote.provenance,
  selectedOffer:{productId:'298',skuId:quote.skuId,sellerKey:quote.sellerKey,sellerName:quote.sellerName,selectedVariant:quote.selectedVariant,
   quantity:1,purchaseLimit:1,saleContents:'AL20744 1/8 PVC&ABS涂装完成品 1件',nativePrice:quote.unitCNY,currency:'CNY',priceKind:'selected_sku_total',purchaseType:'ordinary',priceCondition:'unconditional',
   priceEvidence:dom.rows.find(row=>/^全额:/.test(row)),currencyEvidence:fields['贩卖价格'],isOwn:false,
   identity:{status:'pending',evidence:null},availability:{status:'in_stock',evidence:dom.rows.find(row=>/^库存:/.test(row))},condition:{status:'unknown',evidence:null},
   shipping:{status:'published_terms',destinationCountry:'CN',amount:0,currency:'CNY',scope:'中通快递包邮；顺丰到付不适用；具体收货地区未核定',evidence:'运费：免运费；使用物流公司：中通快递（包邮）、顺丰速运（到付）',applicability:'unconfirmed'}}};
 return quote;
}

export async function readAlterPublicHTTP(url,{item={},request=fetch,deadline=Date.now()+15000,now=()=>new Date().toISOString()}={}){
 if(!isAlterProcurementUrl(url))return failure('unsupported_source','unsupported');
 if(alterTargetIssue(item))return failure(alterTargetIssue(item));
 if(Date.now()>=deadline)return failure('budget_exhausted','unavailable');
 try{
  const response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(15000,deadline-Date.now()))),headers:{accept:'text/html'}});
  // Never follow a login/challenge or any other redirect, nor retry blocked HTTP.
  if(response.status!==200){await response.body?.cancel?.();return failure(response.status>=300&&response.status<400?'target_redirect_mismatch':'source_http_'+response.status,'unavailable')}
  if(response.url&&response.url!==url){await response.body?.cancel?.();return failure('target_redirect_mismatch','unavailable')}
  if(!/^text\/html\b/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>150000){await response.body?.cancel?.();return failure('public_response_unconfirmed','unavailable')}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>150000)return failure('public_response_too_large','unavailable');chunks.push(chunk)}
  const bytes=Buffer.concat(chunks),contentSha256=createHash('sha256').update(bytes).digest('hex');
  let html;
  try{html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch{return failure('public_response_invalid_encoding','unavailable')}
  return {...parseAlterPublicHTML(html,item,{finalUrl:url,httpStatus:200,fetchedAt:now(),contentSha256}),diagnostic:{stage:'public_detail_http',httpStatus:200,responseBytes:size,finalHost:'www.alter-shanghai.cn'}};
 }catch(error){return {...failure('detail_read_error','unavailable'),diagnostic:{stage:'public_detail_http',failureKind:/timeout|abort/i.test(error.name+' '+error.message)?'timeout':'network'}}}
}
