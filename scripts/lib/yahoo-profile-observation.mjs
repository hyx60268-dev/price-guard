// Pure receipts for already-read public profile responses. This module performs
// no I/O and does not promote a card into identity, description, shipping,
// recommendation, procurement, or automatic-pricing evidence.
const ORIGIN='https://paypayfleamarket.yahoo.co.jp';
const CARD_PATHS=['id','title','price','thumbnailImageUrl','itemStatus','sellerId','seller.id','description'];
const RESULT_PATHS=['items','offset','totalResultsAvailable','totalResultsReturned'];
const UPDATE_FIELD=/^(?:update(?:d)?(?:At|Time|Date)?|lastUpdate(?:d)?(?:At|Time|Date)?|modified(?:At|Time|Date)?)$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const own=(value,key)=>record(value)&&Object.hasOwn(value,key);
function field(value,path){
 let current=value;
 for(const key of path.split('.')){if(!own(current,key))return {present:false};current=current[key];}
 return {present:true,value:current};
}
const type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
function fields(rows,paths){
 const result=[];
 for(const path of [...paths].sort()){
  const types={};let present=0;
  for(const row of rows){const found=field(row,path);if(!found.present)continue;present++;const name=type(found.value);types[name]=(types[name]||0)+1;}
  if(present)result.push({path,present,types});
 }
 return result;
}

// This is the ONLY output intended for aggregate/public diagnostics. Never log
// the private cards, profile URLs, account IDs, or raw result next to it. Unknown
// keys are counted, not copied: arbitrary JSON keys can themselves contain data.
// Update-like names are reported only when present; no update semantics or date
// are inferred from a name, its type, or an unchanged title/image.
export function yahooProfileSchemaReceipt(result){
 const cards=Array.isArray(result?.items)?result.items:[],updatePaths=new Set();
 for(const card of cards)if(record(card))for(const key of Object.keys(card))if(UPDATE_FIELD.test(key))updatePaths.add(key);
 const paths=[...CARD_PATHS,...updatePaths],recognized=new Set([...paths.map(path=>path.split('.')[0])]);
 return {version:1,source:'yahoo_profile_result_schema',resultFields:fields([result],RESULT_PATHS),
  cardCount:cards.length,cardFields:fields(cards,paths),
  missingSellerCount:cards.filter(card=>!nonempty(field(card,'sellerId').value)&&!nonempty(field(card,'seller.id').value)).length,
  conflictingSellerFieldsCount:cards.filter(card=>field(card,'sellerId').present&&field(card,'seller.id').present&&card.sellerId!==card.seller.id).length,
  unrecognizedCardFieldCount:cards.reduce((count,card)=>count+(record(card)?Object.keys(card).filter(key=>!recognized.has(key)).length:0),0)};
}

function accountBinding(account){
 if(!record(account)||!nonempty(account.id)||!['yahoo','yahoo_fleamarket'].includes(account.platform))return null;
 let url;try{url=new URL(account.profileUrl);}catch{return null;}
 if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!/^\/user\/p\d+$/.test(url.pathname))return null;
 const sellerId=url.pathname.split('/').at(-1);
 if(account.sellerId!==undefined&&account.sellerId!==sellerId)return null;
 return {accountId:account.id,profileUrl:url.href,sellerId};
}
function sameUrl(value,expected){
 if(typeof value!=='string')return false;
 try{const url=new URL(value);return !url.username&&!url.password&&url.href===expected;}catch{return false;}
}
function validTransport(response,requestedUrl,now){
 if(!record(response)||response.status!==200||response.fromCache!==false||response.redirected!==false||
  !Number.isFinite(response.observedAt)||response.observedAt<0||response.observedAt>now||!sameUrl(response.url,requestedUrl))return false;
 // Reject conflicting alias metadata rather than allowing a safe-looking url
 // to hide a redirect or a denial reported under another collector field.
 if(response.httpStatus!==undefined&&response.httpStatus!==200)return false;
 for(const key of ['finalUrl','finalURL','responseUrl','responseURL','redirectedUrl','redirectedURL'])
  if(response[key]!==undefined&&!sameUrl(response[key],requestedUrl))return false;
 return true;
}
function assessCard(raw,binding,pageUrl,pageNumber,observedAt){
 const reasons=[];
 if(!own(raw,'title')||!nonempty(raw.title))reasons.push('title_missing');
 if(!own(raw,'itemStatus')||!['OPEN','SOLD'].includes(raw.itemStatus))reasons.push('availability_unknown');
 else if(raw.itemStatus==='SOLD')reasons.push('not_open');
 const sellerIds=[field(raw,'sellerId'),field(raw,'seller.id')].filter(found=>found.present);
 const ownershipConflict=sellerIds.some(({value})=>nonempty(value)&&value!==binding.sellerId);
 if(!sellerIds.length)reasons.push('seller_missing');
 else if(ownershipConflict)reasons.push('seller_conflict');
 else if(sellerIds.some(({value})=>value!==binding.sellerId))reasons.push('seller_invalid');
 // The existing parser uses Number(price). Permit only its observed numeric or
 // decimal-string forms, not booleans, arrays, whitespace or coercible objects.
 const priceType=typeof raw.price==='number'||typeof raw.price==='string'&&/^\d+$/.test(raw.price);
 const priceJPY=priceType?Number(raw.price):NaN;
 if(!own(raw,'price')||!Number.isSafeInteger(priceJPY)||priceJPY<=0)reasons.push('price_invalid');
 let image;try{if(own(raw,'thumbnailImageUrl')&&nonempty(raw.thumbnailImageUrl))image=new URL(raw.thumbnailImageUrl);}catch{}
 if(image?.protocol!=='https:'||image.username||image.password)reasons.push('image_invalid');
 // A fully typed, explicitly seller-bound SOLD card is useful positive status
 // evidence for exclusion, though it is never an eligible current price quote.
 if(reasons.some(reason=>reason!=='not_open'))return {reasons,ownershipConflict};
 return {reasons,ownershipConflict,card:{id:raw.id,accountId:binding.accountId,title:raw.title,priceJPY,imageUrl:raw.thumbnailImageUrl,
  itemStatus:raw.itemStatus,sellerId:binding.sellerId,profileUrl:binding.profileUrl,pageUrl,pageNumber,
  observedAt,source:'current_profile_card'}};
}

const invalidObservation=(reason,schemaReceipts)=>({version:1,complete:false,enumerationComplete:false,pageObservationValid:false,
 reason,membershipIds:[],rowObservations:[],cards:[],pageObservations:[],schemaReceipts});

// A successfully read page establishes only positive observations. Missing
// listings, missing totals, or an unfinished seller traversal never imply sold,
// removed, complete inventory, or a fresh recommendation set.
export function yahooProfilePageObservation({account,page,now}={}){
 const schemaReceipts=[yahooProfileSchemaReceipt(page?.result)],reject=reason=>invalidObservation(reason,schemaReceipts);
 const binding=accountBinding(account);if(!binding)return reject('account_binding_invalid');
 if(!Number.isFinite(now)||now<0)return reject('observation_clock_invalid');
 const pageNumber=page?.pageNumber;
 if(!Number.isSafeInteger(pageNumber)||pageNumber<1)return reject('profile_page_binding_invalid');
 const pageUrl=`${binding.profileUrl}?page=${pageNumber}`;
 if(!sameUrl(page.requestedUrl,pageUrl))return reject('profile_page_binding_invalid');
 if(!validTransport(page.response,pageUrl,now))return reject('profile_response_not_current');
 const result=page.result;
 if(!record(result)||!Array.isArray(result.items))return reject('profile_page_schema_or_total_changed');
 const totalPresent=own(result,'totalResultsAvailable'),total=totalPresent?result.totalResultsAvailable:null;
 if(totalPresent&&(!Number.isSafeInteger(total)||total<0))return reject('profile_total_invalid');
 if(own(result,'offset')&&result.offset!==(pageNumber-1)*100)return reject('profile_offset_mismatch');
 if(own(result,'totalResultsReturned')&&result.totalResultsReturned!==result.items.length)return reject('profile_returned_count_mismatch');
 if(result.items.length>100||total!==null&&(pageNumber>Math.max(1,Math.ceil(total/100))||result.items.length>Math.min(100,total-(pageNumber-1)*100)))return reject('profile_page_card_count_mismatch');
 const cards=[],rowObservations=[],ids=new Set(),quoteIneligibleReasons={};let ownershipConflictCount=0;
 for(const raw of result.items){
  // Membership only says this ID appeared on this profile. It does not assign
  // an observed seller, OPEN status, usable price, or physical identity to it.
  if(!record(raw)||!own(raw,'id')||!nonempty(raw.id)||!/^[A-Za-z0-9_-]+$/.test(raw.id))return reject('profile_listing_id_invalid');
  if(ids.has(raw.id))return reject('profile_duplicate_listing_id');
  ids.add(raw.id);
  const assessed=assessCard(raw,binding,pageUrl,pageNumber,page.response.observedAt);
  // Keep a timestamped barrier even when a row cannot supply a typed card. A
  // later ineligible observation must block fallback to an older valid OPEN
  // card. Never replace this row clock with the aggregate's maximum page time.
  rowObservations.push({id:raw.id,observedAt:page.response.observedAt,cardEligible:Boolean(assessed.card),reason:assessed.reasons[0]||null});
  if(assessed.ownershipConflict)ownershipConflictCount++;
  for(const reason of assessed.reasons)quoteIneligibleReasons[reason]=(quoteIneligibleReasons[reason]||0)+1;
  if(assessed.card)cards.push(assessed.card);
 }
 const quoteEligibleCount=cards.filter(card=>card.itemStatus==='OPEN').length;
 return {version:1,complete:false,enumerationComplete:false,pageObservationValid:true,reason:null,...binding,
  total,totalEvidence:total===null?'absent':'observed',uniqueIds:ids.size,fromCache:false,
  membershipIds:[...ids],membershipEvidence:'profile_page_membership_only',
  quoteEligibleCount,quoteIneligibleCount:ids.size-quoteEligibleCount,cardIneligibleCount:ids.size-cards.length,quoteIneligibleReasons,ownershipConflictCount,
  observedAt:page.response.observedAt,maxObservedAt:page.response.observedAt,
  pageObservations:[{pageNumber,pageUrl,observedAt:page.response.observedAt,returned:result.items.length,offsetEvidence:own(result,'offset')?'observed':'absent'}],
  rowObservations,cards,schemaReceipts};
}

// `pages` contains {pageNumber, requestedUrl, response, result}. `response` is
// the original fetchYahooPage metadata, and `result` is searchResult(nextData)
// before seller fallback, deduplication, or OPEN filtering. Require `now` from
// the calling cycle; neither parsing nor a cache reuse gets a new source clock.
// A complete traversal is an observed ID enumeration, not an atomic marketplace
// snapshot or proof that every card can support a provisional price observation.
export function yahooProfileObservation({account,pages,now}={}){
 const schemaReceipts=Array.isArray(pages)?pages.map(page=>yahooProfileSchemaReceipt(page?.result)):[];
 const reject=reason=>invalidObservation(reason,schemaReceipts);
 const binding=accountBinding(account);if(!binding)return reject('account_binding_invalid');
 if(!Number.isFinite(now)||now<0)return reject('observation_clock_invalid');
 if(!Array.isArray(pages)||!pages.length)return reject('profile_pages_missing');
 const first=pages[0]?.result,total=first?.totalResultsAvailable;
 if(!record(first)||!Number.isSafeInteger(total)||total<0)return reject('profile_total_invalid');
 const pageCount=Math.max(1,Math.ceil(total/100));
 if(pages.length!==pageCount)return reject('profile_page_count_mismatch');
 const cards=[],rowObservations=[],pageObservations=[],ids=new Set(),quoteIneligibleReasons={};let quoteEligibleCount=0,quoteIneligibleCount=0,cardIneligibleCount=0,ownershipConflictCount=0;
 for(let index=0;index<pages.length;index++){
  const entry=pages[index],pageNumber=index+1;
  if(entry?.pageNumber!==pageNumber)return reject('profile_page_binding_invalid');
  const result=entry.result;
  if(!record(result)||!Array.isArray(result.items)||result.totalResultsAvailable!==total)return reject('profile_page_schema_or_total_changed');
  if(result.items.length!==Math.min(100,total-index*100))return reject('profile_page_card_count_mismatch');
  const observed=yahooProfilePageObservation({account,page:entry,now});
  if(!observed.pageObservationValid)return reject(observed.reason);
  for(const id of observed.membershipIds){if(ids.has(id))return reject('profile_duplicate_listing_id');ids.add(id);}
  cards.push(...observed.cards);rowObservations.push(...observed.rowObservations);pageObservations.push(...observed.pageObservations);
  quoteEligibleCount+=observed.quoteEligibleCount;quoteIneligibleCount+=observed.quoteIneligibleCount;cardIneligibleCount+=observed.cardIneligibleCount;ownershipConflictCount+=observed.ownershipConflictCount;
  for(const [reason,count] of Object.entries(observed.quoteIneligibleReasons))quoteIneligibleReasons[reason]=(quoteIneligibleReasons[reason]||0)+count;
 }
 if(ids.size!==total)return reject('profile_unique_count_mismatch');
 const times=pageObservations.map(page=>page.observedAt);
 return {version:1,complete:true,enumerationComplete:true,pageObservationValid:true,reason:null,...binding,total,totalEvidence:'observed',uniqueIds:ids.size,fromCache:false,
  membershipIds:[...ids],membershipEvidence:'profile_page_membership_only',
  quoteEligibleCount,quoteIneligibleCount,cardIneligibleCount,quoteIneligibleReasons,ownershipConflictCount,
  observedAt:Math.min(...times),maxObservedAt:Math.max(...times),pageObservations,rowObservations,cards,schemaReceipts};
}
