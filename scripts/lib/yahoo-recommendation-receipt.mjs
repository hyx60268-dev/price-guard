import {extractItemData} from './yahoo.mjs';

const boundedText=(value,maximum=1000)=>typeof value==='string'?value.slice(0,maximum):'';
const schemaName=value=>typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value)?value:'unrecognized_key';
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value)?value:'';
function publicImageUrl(value){
 if(typeof value!=='string'||value.length>2048)return '';
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||[...url.searchParams.keys()].some(key=>/token|auth|key|session|cookie|signature/i.test(key)))return '';return value}catch{return ''}
}
const scalarCategory=value=>typeof value==='string'?value.slice(0,80):typeof value==='number'&&Number.isFinite(value)?value:null;
function cardReceipt(raw,section,observedAt){
 const id=identifier(raw?.itemId),price=typeof raw?.price==='number'?raw.price:typeof raw?.price==='string'&&/^\d+(?:\.\d+)?$/.test(raw.price)?Number(raw.price):NaN;
 if(!id||typeof raw.title!=='string')return null;
 // A valid source ID with missing/conditional price is still a candidate.
 // Keep it as unknown, without retaining arbitrary raw values or coupon data.
 const ordinaryPrice=Number.isFinite(price)&&price>0&&(raw.priceKind===undefined||raw.priceKind==='ordinary');
 return {id,url:`https://paypayfleamarket.yahoo.co.jp/item/${id}`,title:boundedText(raw.title),text:boundedText(raw.title),
  ...(Object.hasOwn(raw,'currency')?{currency:raw.currency==='JPY'?'JPY':'unknown'}:{}),
  ...(Object.hasOwn(raw,'shipping')?{shipping:raw.shipping?.shippingKnown===true&&raw.shipping.currency==='JPY'&&raw.shipping.shippingJPY===0
    ?{shippingKnown:true,currency:'JPY',shippingJPY:0,shippingSource:'recommendation_card_shipping'}
    :{shippingKnown:false,currency:null,shippingJPY:null}}:{}),
  image:publicImageUrl(raw.image?.url),price:ordinaryPrice?price:null,sellerId:identifier(raw.seller?.id),itemStatus:null,
  categoryIds:Array.isArray(raw.genreCategoryIds)?raw.genreCategoryIds.slice(0,100).map(scalarCategory).filter(value=>value!==null):[],
  source:'recommendation',recommendationSection:schemaName(section),recommendationType:boundedText(raw.log?.rctype,64),
  recommendationScore:typeof raw.log?.rcsm==='number'&&Number.isFinite(raw.log.rcsm)?raw.log.rcsm:null,
  observedAt,priceKind:ordinaryPrice?'ordinary':'unknown',priceField:'recommendItems.items.price',availabilityEvidence:null};
}

// Called only after the already scheduled own-item response is parsed. It does
// no I/O, keeps no HTML/headers/cookies, and is intended for encrypted run state.
// Values are copied with primitive type checks, never a spread of source data.
// Shape evidence is separate from interpreted status; unknown fields never
// become OPEN or a verified shipping/identity assertion.
export function yahooRecommendationReceipt(nextData,{requestedItemId,sourceUrl,observedAt,now=Date.now(),limit=200}={}){
 const at=typeof observedAt==='number'?observedAt:Date.parse(observedAt||'');
 if(!identifier(requestedItemId)||!Number.isFinite(at)||at>now||at<0)throw Error('Missing original Yahoo observation');
 if(sourceUrl!==`https://paypayfleamarket.yahoo.co.jp/item/${requestedItemId}`)throw Error('Yahoo receipt source mismatch');
 const item=extractItemData(nextData);if(item.id!==requestedItemId)throw Error('Yahoo receipt target mismatch');
 const groups=nextData?.props?.initialState?.recommendsState?.recommends?.recommends||{};
 const shape=[],cards=[];let totalCards=0,invalidCards=0;
 const originalTime=new Date(at).toISOString();
 for(const [section,group] of Object.entries(groups).slice(0,20)){
  const rows=Array.isArray(group?.recommendItems?.items)?group.recommendItems.items:[],fields=new Map();
  for(const raw of rows){
   totalCards++;
   if(!raw||typeof raw!=='object'||Array.isArray(raw)){invalidCards++;continue;}
   for(const [key,value] of Object.entries(raw).slice(0,100)){
    const name=schemaName(key);if(!fields.has(name))fields.set(name,new Set());
    fields.get(name).add(value===null?'null':Array.isArray(value)?'array':typeof value);
   }
   const card=cardReceipt(raw,section,originalTime);if(card)cards.push(card);else invalidCards++;
  }
  shape.push({section:schemaName(section),count:rows.length,fields:Object.fromEntries([...fields].sort(([a],[b])=>a.localeCompare(b)).map(([key,types])=>[key,[...types].sort()]))});
 }
 const bound=Math.max(1,Math.min(200,Number(limit)||200));
 return {version:1,requestedItemId,sourceUrl,observedAt:originalTime,shape,
  totalCards,invalidCards,truncated:cards.length>bound,sectionsTruncated:Object.keys(groups).length>20,
  cards:cards.slice(0,bound),identityVerified:false,fullCoverage:false};
}
