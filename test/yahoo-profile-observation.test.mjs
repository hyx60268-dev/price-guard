import test from 'node:test';
import assert from 'node:assert/strict';
import {yahooProfileObservation,yahooProfilePageObservation,yahooProfileSchemaReceipt} from '../scripts/lib/yahoo-profile-observation.mjs';

// Synthetic cards use only fields already parsed in yahoo.mjs and exercised in
// yahoo-batch-quotes/profile-history fixtures. No marketplace reads are made.
const NOW=Date.parse('2026-10-16T12:00:00Z');
const account={id:'fixture-yahoo',platform:'yahoo_fleamarket',profileUrl:'https://paypayfleamarket.yahoo.co.jp/user/p123'};
const raw=id=>({id,title:'ブルー ボトル 370ml 1本',price:9000,thumbnailImageUrl:'https://fixture.invalid/blue.jpg',itemStatus:'OPEN',sellerId:'p123'});
function input(total=1){
 const count=Math.max(1,Math.ceil(total/100));
 return {account:{...account},now:NOW,pages:Array.from({length:count},(_,index)=>{
  const pageNumber=index+1,url=`${account.profileUrl}?page=${pageNumber}`;
  const items=Array.from({length:Math.min(100,total-index*100)},(_,offset)=>raw(`z${index*100+offset}`));
  return {pageNumber,requestedUrl:url,response:{url,status:200,redirected:false,fromCache:false,observedAt:NOW-10000+index*1000},
   result:{offset:index*100,totalResultsAvailable:total,totalResultsReturned:items.length,items}};
 })};
}
const observe=(change,total=1)=>{const value=input(total);change?.(value);return yahooProfileObservation(value);};
function rejected(value,reason){assert.equal(value.complete,false);assert.equal(value.enumerationComplete,false);assert.equal(value.reason,reason);assert.deepEqual(value.membershipIds,[]);assert.deepEqual(value.rowObservations,[]);assert.deepEqual(value.cards,[]);assert.deepEqual(value.pageObservations,[]);}
function ineligible(value,reason){assert.equal(value.complete,true);assert.equal(value.enumerationComplete,true);assert.deepEqual(value.membershipIds,['z0']);assert.equal(value.quoteIneligibleCount,1);assert.deepEqual(value.cards,[]);if(reason)assert.equal(value.quoteIneligibleReasons[reason],1);}

test('complete profile enumeration retains each card’s original body clock and source page',()=>{
 const value=input(101),before=structuredClone(value),result=yahooProfileObservation(value);
 assert.equal(result.complete,true);assert.equal(result.total,101);assert.equal(result.uniqueIds,101);
 assert.equal(result.observedAt,NOW-10000);assert.equal(result.maxObservedAt,NOW-9000);assert.equal(result.fromCache,false);
 assert.equal(result.cards[0].observedAt,NOW-10000);assert.equal(result.cards[100].observedAt,NOW-9000);
 assert.equal(result.cards[100].pageUrl,`${account.profileUrl}?page=2`);assert.equal(result.cards[100].pageNumber,2);
 assert.deepEqual(result.cards[0],{id:'z0',accountId:account.id,title:raw('z0').title,priceJPY:9000,imageUrl:raw('z0').thumbnailImageUrl,
  itemStatus:'OPEN',sellerId:'p123',profileUrl:account.profileUrl,pageUrl:`${account.profileUrl}?page=1`,pageNumber:1,observedAt:NOW-10000,source:'current_profile_card'});
 assert.deepEqual(value,before);
 value.pages[0].result.items[0].title='changed input';assert.equal(result.cards[0].title,before.pages[0].result.items[0].title);
 result.cards[1].title='changed output';assert.equal(value.pages[0].result.items[1].title,before.pages[0].result.items[1].title);
});

test('receipt does not expose or refresh description, identity, detail, shipping or recommendation evidence',()=>{
 const result=observe(value=>Object.assign(value.pages[0].result.items[0],{
  description:'Private historic or card description',updatedAt:'2026-10-16T11:59:59Z',checkedAt:'fake-current',
  recommendations:[{id:'private-neighbor'}],shipping:0,canReprice:true,costVerified:true,identityVerified:true,
  sourceDetail:{description:'private source detail',checkedAt:'private timestamp'}
 }));
 assert.equal(result.complete,true);
 for(const name of ['description','updatedAt','checkedAt','recommendations','shipping','canReprice','costVerified','identityVerified','sourceDetail'])assert.equal(Object.hasOwn(result.cards[0],name),false,name);
 assert.equal(JSON.stringify(result).includes('Private historic'),false);
 assert.equal(JSON.stringify(result).includes('private-neighbor'),false);
});

test('price changes are current card observations and string numeric prices are narrow, explicit input forms',()=>{
 assert.equal(observe(value=>{value.pages[0].result.items[0].price='8500';}).cards[0].priceJPY,8500);
 for(const price of [0,-1,1.5,NaN,Infinity,true,null,[],{},'', ' 8500 ', '8e3','8,500','8500.0',Number.MAX_SAFE_INTEGER+1]){
  ineligible(observe(value=>{value.pages[0].result.items[0].price=price;}),'price_invalid');
 }
});

test('SOLD remains explicit without inventing sold/open dates or removing history',()=>{
 const result=observe(value=>{value.pages[0].result.items[0].itemStatus='SOLD';});
 assert.equal(result.complete,true);assert.equal(result.cards[0].itemStatus,'SOLD');
 assert.equal(result.cards[0].observedAt,NOW-10000);assert.equal(result.cards[0].sellerId,'p123');
 assert.equal(result.quoteEligibleCount,0);assert.equal(result.quoteIneligibleCount,1);assert.equal(result.cardIneligibleCount,0);
 assert.deepEqual(result.quoteIneligibleReasons,{not_open:1});
 for(const name of ['soldAt','firstSeenAt','openedAt'])assert.equal(result.cards[0][name],undefined);
 assert.equal(JSON.stringify(result.cards).includes('OPEN'),false);
});

test('empty complete enumeration carries its real observation without fabricated cards',()=>{
 const result=yahooProfileObservation(input(0));assert.equal(result.complete,true);assert.equal(result.total,0);
 assert.deepEqual(result.cards,[]);assert.equal(result.observedAt,NOW-10000);assert.equal(result.pageObservations.length,1);
});

test('raw nested seller is accepted, but missing, conflicting or foreign seller is never filled from profile URL',()=>{
 const result=observe(value=>{const card=value.pages[0].result.items[0];delete card.sellerId;card.seller={id:'p123'};});
 assert.equal(result.complete,true);assert.equal(result.cards[0].sellerId,'p123');
 for(const change of [card=>{delete card.sellerId;},card=>{card.sellerId='p456';},card=>{card.seller={id:'p456'};},
  card=>{card.sellerId=null;card.seller={id:'p123'};},card=>{card.sellerId=123;},card=>{card.seller={id:null};}]){
  ineligible(observe(value=>change(value.pages[0].result.items[0])));
 }
 const missing=observe(value=>{delete value.pages[0].result.items[0].sellerId;});assert.equal(missing.schemaReceipts[0].missingSellerCount,1);
 const conflict=observe(value=>{value.pages[0].result.items[0].seller={id:'p456'};});assert.equal(conflict.schemaReceipts[0].conflictingSellerFieldsCount,1);
});

for(const [name,change] of [
 ['missing account id',account=>{delete account.id;}],['wrong platform',account=>{account.platform='rakuma';}],
 ['foreign seller binding',account=>{account.sellerId='p456';}],['non-Yahoo origin',account=>{account.profileUrl='https://evil.invalid/user/p123';}],
 ['credentials in profile',account=>{account.profileUrl='https://secret@paypayfleamarket.yahoo.co.jp/user/p123';}],
 ['profile query',account=>{account.profileUrl+='?page=1';}],['profile fragment',account=>{account.profileUrl+='#x';}],
 ['malformed profile',account=>{account.profileUrl='not a URL';}],['missing platform',account=>{delete account.platform;}]
])test(`rejects ${name}`,()=>rejected(observe(value=>change(value.account)),'account_binding_invalid'));

test('account identity is attached explicitly, with no cross-account key or saved identity reuse',()=>{
 const first=yahooProfileObservation(input()),second=observe(value=>{value.account.id='another-configured-account';});
 assert.equal(first.cards[0].accountId,'fixture-yahoo');assert.equal(second.cards[0].accountId,'another-configured-account');
 assert.notDeepEqual(first.cards[0],second.cards[0]);
});

for(const [name,change] of [
 ['cached',response=>{response.fromCache=true;}],['unknown cache',response=>{delete response.fromCache;}],
 ['redirected',response=>{response.redirected=true;}],['unknown redirects',response=>{delete response.redirected;}],
 ['wrong URL',response=>{response.url='https://paypayfleamarket.yahoo.co.jp/user/p456?page=1';}],
 ['detail URL',response=>{response.url='https://paypayfleamarket.yahoo.co.jp/item/z0';}],
 ['missing source URL',response=>{delete response.url;}],['wrong final alias',response=>{response.finalUrl='https://evil.invalid/login';}],
 ['denied alias',response=>{response.httpStatus=403;}],['missing HTTP status',response=>{delete response.status;}],
 ['non-200',response=>{response.status=206;}],['future clock',response=>{response.observedAt=NOW+1;}],
 ['missing clock',response=>{delete response.observedAt;}],['ISO instead of epoch milliseconds',response=>{response.observedAt=new Date(NOW).toISOString();}],
 ['negative clock',response=>{response.observedAt=-1;}]
])test(`rejects ${name} response without replacing source time`,()=>rejected(observe(value=>change(value.pages[0].response)),'profile_response_not_current'));

test('reprocessing at a later cycle time never renews any original page observation',()=>{
 const value=input(101),first=yahooProfileObservation(value);value.now+=3600000;const second=yahooProfileObservation(value);
 assert.deepEqual(second,first);
 for(const now of [undefined,NaN,Infinity,-1])rejected(observe(value=>{value.now=now;}),'observation_clock_invalid');
});

test('full pagination requires exact URL order, expected page counts, totals, and unique IDs',()=>{
 rejected(observe(value=>{value.pages.pop();},101),'profile_page_count_mismatch');
 rejected(observe(value=>{value.pages.reverse();},101),'profile_page_binding_invalid');
 rejected(observe(value=>{value.pages[0].requestedUrl=`${account.profileUrl}?page=2`;}),'profile_page_binding_invalid');
 rejected(observe(value=>{value.pages[1].result.totalResultsAvailable=102;},101),'profile_page_schema_or_total_changed');
 rejected(observe(value=>{value.pages[1].result.offset=101;},101),'profile_offset_mismatch');
 rejected(observe(value=>{value.pages[0].result.totalResultsReturned=10;}),'profile_returned_count_mismatch');
 rejected(observe(value=>{value.pages[0].result.items.pop();delete value.pages[0].result.totalResultsReturned;},101),'profile_page_card_count_mismatch');
 rejected(observe(value=>{value.pages[1].result.items[0].id='z0';},101),'profile_duplicate_listing_id');
 rejected(observe(value=>{value.pages[0].result.items[1].id='z0';},100),'profile_duplicate_listing_id');
});

test('absent offset is explicit and may close enumeration only through exact page, cardinality, totals and IDs',()=>{
 const result=observe(value=>{for(const page of value.pages)delete page.result.offset;},101);
 assert.equal(result.complete,true);assert.deepEqual(result.pageObservations.map(page=>page.offsetEvidence),['absent','absent']);
 assert.ok(result.schemaReceipts.every(receipt=>!receipt.resultFields.some(field=>field.path==='offset')));
 rejected(observe(value=>{delete value.pages[0].result.offset;value.pages[0].result.items.pop();delete value.pages[0].result.totalResultsReturned;},100),'profile_page_card_count_mismatch');
});

test('missing total, noninteger total, absent pages and invalid listing IDs fail enumeration closed',()=>{
 for(const total of [undefined,'1',-1,1.5,NaN,Infinity])rejected(observe(value=>{value.pages[0].result.totalResultsAvailable=total;}),'profile_total_invalid');
 for(const pages of [undefined,[],null])rejected(yahooProfileObservation({account,now:NOW,pages}),'profile_pages_missing');
 for(const id of ['',null,0,'../other'])rejected(observe(value=>{value.pages[0].result.items[0].id=id;}),'profile_listing_id_invalid');
 rejected(observe(value=>{value.pages[0].result.items[0]=null;}),'profile_listing_id_invalid');
});

test('safe schema receipt contains field names and type counts, never raw private values or arbitrary keys',()=>{
 const card={...raw('private-id'),title:'private-title',price:19876,thumbnailImageUrl:'https://private.invalid/private-image',sellerId:'private-seller',
  seller:{id:'private-seller'},description:'private-description',updatedAt:'private-update-time',lastUpdatedTime:123456789,
  'private-key-containing-inventory':{anything:'private-value'}};
 const receipt=yahooProfileSchemaReceipt({offset:0,totalResultsAvailable:1,items:[card]}),serialized=JSON.stringify(receipt);
 for(const secret of ['private-id','private-title','19876','private.invalid','private-seller','private-description','private-update-time','123456789','private-key-containing-inventory','private-value'])assert.equal(serialized.includes(secret),false,secret);
 assert.deepEqual(receipt.cardFields.find(field=>field.path==='updatedAt'),{path:'updatedAt',present:1,types:{string:1}});
 assert.deepEqual(receipt.cardFields.find(field=>field.path==='lastUpdatedTime'),{path:'lastUpdatedTime',present:1,types:{number:1}});
 assert.equal(receipt.unrecognizedCardFieldCount,1);
 assert.equal(yahooProfileSchemaReceipt({items:[raw('z1')]}).cardFields.some(field=>field.path==='updatedAt'),false);
 assert.equal(receipt.missingSellerCount,0);assert.equal(receipt.conflictingSellerFieldsCount,0);
});

test('schema counts missing sellers and field types without treating present null as evidence',()=>{
 const receipt=yahooProfileSchemaReceipt({items:[{id:'one',price:1},{id:'two',price:'2',sellerId:null},{id:'three',seller:{id:'p123'}},{id:'four',sellerId:'p123',seller:{id:'p456'}}]});
 assert.equal(receipt.missingSellerCount,2);assert.equal(receipt.conflictingSellerFieldsCount,1);
 assert.deepEqual(receipt.cardFields.find(field=>field.path==='price'),{path:'price',present:2,types:{number:1,string:1}});
 assert.deepEqual(receipt.cardFields.find(field=>field.path==='sellerId'),{path:'sellerId',present:2,types:{null:1,string:1}});
 assert.doesNotThrow(()=>yahooProfileSchemaReceipt(null));assert.doesNotThrow(()=>yahooProfileSchemaReceipt({items:[null,[],false]}));
});

test('an old SOLD card without image or seller does not suppress another current OPEN card or shrink enumeration',()=>{
 const result=observe(value=>{value.pages[0].result.items[1]={id:'old-sold',itemStatus:'SOLD'};},2);
 assert.equal(result.complete,true);assert.equal(result.enumerationComplete,true);assert.equal(result.uniqueIds,2);
 assert.deepEqual(result.membershipIds,['z0','old-sold']);assert.equal(result.membershipEvidence,'profile_page_membership_only');
 assert.deepEqual(result.cards.map(card=>card.id),['z0']);assert.equal(result.cards[0].itemStatus,'OPEN');
 assert.equal(result.quoteIneligibleCount,1);assert.deepEqual(result.quoteIneligibleReasons,{title_missing:1,not_open:1,seller_missing:1,price_invalid:1,image_invalid:1});
 assert.equal(result.schemaReceipts[0].missingSellerCount,1);assert.equal(result.ownershipConflictCount,0);
});

test('unknown status, missing image and missing sellers are row-local quote blockers while the full denominator survives',()=>{
 const result=observe(value=>{
  const rows=value.pages[0].result.items;
  rows[1].itemStatus='UNKNOWN';delete rows[2].thumbnailImageUrl;delete rows[3].sellerId;
 },4);
 assert.equal(result.complete,true);assert.equal(result.uniqueIds,4);assert.deepEqual(result.membershipIds,['z0','z1','z2','z3']);
 assert.deepEqual(result.cards.map(card=>card.id),['z0']);assert.equal(result.quoteIneligibleCount,3);
 assert.deepEqual(result.quoteIneligibleReasons,{availability_unknown:1,image_invalid:1,seller_missing:1});
 assert.equal(result.cards.some(card=>['z1','z2','z3'].includes(card.id)),false);
});

test('prototype-inherited status is not an observed SOLD or OPEN field',()=>{
 const value=input(),card=value.pages[0].result.items[0];delete card.itemStatus;
 Object.setPrototypeOf(card,{itemStatus:'SOLD'});
 ineligible(yahooProfileObservation(value),'availability_unknown');
});

test('foreign or conflicting raw sellers remain conservative profile membership only and never become quote seller evidence',()=>{
 const result=observe(value=>{
  value.pages[0].result.items[1].sellerId='p456';value.pages[0].result.items[2].seller={id:'p456'};
 },3);
 assert.equal(result.complete,true);assert.equal(result.total,3);assert.deepEqual(result.membershipIds,['z0','z1','z2']);
 assert.deepEqual(result.cards.map(card=>card.id),['z0']);assert.equal(result.quoteIneligibleCount,2);
 assert.equal(result.ownershipConflictCount,2);assert.deepEqual(result.quoteIneligibleReasons,{seller_conflict:2});
 assert.equal(result.schemaReceipts[0].conflictingSellerFieldsCount,1);
 assert.equal(JSON.stringify(result.cards).includes('p456'),false);
});

test('a malformed historical row on a later page preserves valid earlier observations and all unique listing IDs',()=>{
 const result=observe(value=>{value.pages[1].result.items[0]={id:'historical-id'};},101);
 assert.equal(result.enumerationComplete,true);assert.equal(result.membershipIds.length,101);
 assert.equal(result.cards.length,100);assert.equal(result.quoteIneligibleCount,1);
 assert.equal(result.cards[0].observedAt,NOW-10000);assert.equal(result.maxObservedAt,NOW-9000);
 assert.equal(result.quoteIneligibleReasons.availability_unknown,1);
});

test('single-page positive observations do not require the whole seller traversal or imply completeness',()=>{
 const value=input(201),page=value.pages[0],result=yahooProfilePageObservation({account:value.account,page,now:NOW});
 assert.equal(result.pageObservationValid,true);assert.equal(result.complete,false);assert.equal(result.enumerationComplete,false);
 assert.equal(result.total,201);assert.equal(result.uniqueIds,100);assert.equal(result.cards.length,100);assert.equal(result.membershipIds.length,100);
 assert.equal(result.observedAt,NOW-10000);assert.equal(result.cards[0].pageUrl,page.requestedUrl);
 const unfinished=yahooProfileObservation({...value,pages:[page]});rejected(unfinished,'profile_page_count_mismatch');
 assert.equal(result.membershipIds.includes('z100'),false);assert.equal(result.cards.some(card=>card.id==='z100'),false);
 assert.equal(result.removedIds,undefined);assert.equal(result.soldIds,undefined);
});

test('a single current page can explicitly exclude a fully typed SOLD known listing without completing seller inventory',()=>{
 const value=input(201),page=value.pages[0];page.result.items[0].itemStatus='SOLD';
 const result=yahooProfilePageObservation({account:value.account,page,now:NOW});
 assert.equal(result.pageObservationValid,true);assert.equal(result.enumerationComplete,false);
 assert.equal(result.cards.length,100);assert.equal(result.quoteEligibleCount,99);assert.equal(result.quoteIneligibleCount,1);assert.equal(result.cardIneligibleCount,0);
 assert.equal(result.cards[0].id,'z0');assert.equal(result.cards[0].itemStatus,'SOLD');
 assert.equal(result.cards[0].observedAt,page.response.observedAt);assert.equal(result.cards[0].pageUrl,page.requestedUrl);
 assert.deepEqual(result.quoteIneligibleReasons,{not_open:1});
});

test('a valid partial page with no total still provides only observed positive cards, never an inventory denominator',()=>{
 const value=input(101),page=value.pages[0];delete page.result.totalResultsAvailable;
 page.result.items=page.result.items.slice(0,7);page.result.totalResultsReturned=7;
 const result=yahooProfilePageObservation({account:value.account,page,now:NOW});
 assert.equal(result.pageObservationValid,true);assert.equal(result.complete,false);assert.equal(result.enumerationComplete,false);
 assert.equal(result.total,null);assert.equal(result.totalEvidence,'absent');assert.equal(result.cards.length,7);assert.equal(result.membershipIds.length,7);
 const empty=structuredClone(page);empty.result.items=[];empty.result.totalResultsReturned=0;
 const observedEmpty=yahooProfilePageObservation({account:value.account,page:empty,now:NOW});
 assert.equal(observedEmpty.pageObservationValid,true);assert.equal(observedEmpty.enumerationComplete,false);assert.equal(observedEmpty.total,null);
});

test('single-page observations apply the same exact transport, offset, identity and duplicate gates',()=>{
 const value=input(101),page=value.pages[1],read=page=>yahooProfilePageObservation({account:value.account,page,now:NOW});
 const positive=read(page);assert.equal(positive.pageObservationValid,true);assert.equal(positive.cards[0].pageNumber,2);assert.equal(positive.cards[0].observedAt,NOW-9000);
 for(const [change,reason] of [
  [page=>{page.response.fromCache=true;},'profile_response_not_current'],
  [page=>{page.response.url=`${account.profileUrl}?page=1`;},'profile_response_not_current'],
  [page=>{page.result.offset=0;},'profile_offset_mismatch'],
  [page=>{page.result.items[0].id='../other';},'profile_listing_id_invalid']
 ]){const changed=structuredClone(page);change(changed);rejected(read(changed),reason);}
 const duplicate=structuredClone(value.pages[0]);duplicate.result.items[1].id=duplicate.result.items[0].id;
 rejected(read(duplicate),'profile_duplicate_listing_id');
 const earlier=read(page),later=yahooProfilePageObservation({account:value.account,page,now:NOW+3600000});assert.deepEqual(later,earlier);
});

test('every enumerated row retains its own page clock and eligibility even when no typed card survives',()=>{
 const result=observe(value=>{
  delete value.pages[0].result.items[0].sellerId;
  value.pages[1].result.items[0].itemStatus='SOLD';
 },101);
 assert.equal(result.rowObservations.length,101);assert.deepEqual(result.rowObservations.map(row=>row.id),result.membershipIds);
 assert.deepEqual(result.rowObservations[0],{id:'z0',observedAt:NOW-10000,cardEligible:false,reason:'seller_missing'});
 assert.notEqual(result.rowObservations[0].observedAt,result.maxObservedAt);
 assert.deepEqual(result.rowObservations[1],{id:'z1',observedAt:NOW-10000,cardEligible:true,reason:null});
 assert.deepEqual(result.rowObservations[100],{id:'z100',observedAt:NOW-9000,cardEligible:true,reason:'not_open'});
 assert.equal(result.cards.some(card=>card.id==='z0'),false);assert.equal(result.cards.find(card=>card.id==='z100').itemStatus,'SOLD');
});

test('a newer incomplete SOLD row carries an explicit barrier against an older valid OPEN card',()=>{
 const value=input(),page=value.pages[0],read=page=>yahooProfilePageObservation({account:value.account,page,now:NOW});
 const old=read(page);assert.deepEqual(old.rowObservations,[{id:'z0',observedAt:NOW-10000,cardEligible:true,reason:null}]);
 page.response.observedAt=NOW-1000;page.result.items[0].itemStatus='SOLD';delete page.result.items[0].thumbnailImageUrl;
 const newer=read(page);assert.equal(newer.pageObservationValid,true);assert.deepEqual(newer.cards,[]);
 assert.deepEqual(newer.rowObservations,[{id:'z0',observedAt:NOW-1000,cardEligible:false,reason:'not_open'}]);
 assert.ok(newer.rowObservations[0].observedAt>old.rowObservations[0].observedAt);
 assert.deepEqual(newer.membershipIds,old.membershipIds);assert.equal(old.cards[0].itemStatus,'OPEN');
 const later=yahooProfilePageObservation({account:value.account,page,now:NOW+3600000});assert.deepEqual(later.rowObservations,newer.rowObservations);
});

test('row observations contain only the private ID, original time and fixed eligibility diagnostics',()=>{
 const value=input(),card=value.pages[0].result.items[0];
 Object.assign(card,{title:'private title',description:'private description',price:19876,thumbnailImageUrl:'https://private.invalid/image',sellerId:'p456'});
 const result=yahooProfileObservation(value),row=result.rowObservations[0];
 assert.deepEqual(Object.keys(row),['id','observedAt','cardEligible','reason']);
 assert.deepEqual(row,{id:'z0',observedAt:NOW-10000,cardEligible:false,reason:'seller_conflict'});
 for(const secret of ['private title','private description','19876','private.invalid','p456'])assert.equal(JSON.stringify(result.rowObservations).includes(secret),false);
 assert.equal(JSON.stringify(result.schemaReceipts).includes('z0'),false);
});
