import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { reviewedListingCandidate,reviewedListingIdentity } from '../scripts/lib/reviewed-listing-identities.mjs';
import { yahooCompare } from '../scripts/lib/yahoo.mjs';
import { MATCHING_RULES_VERSION,semanticQuantity,sealedSingleBoxEquivalent,sealedSingleBoxTextCompatible } from '../scripts/lib/rules.mjs';
import { buildOwnedOffers } from '../public/owned-offers.js';
import { pricingDecision } from '../public/pricing-policy.js';
import { imageFingerprints } from '../scripts/lib/image.mjs';

const prose=JSON.parse(fs.readFileSync(new URL('./fixtures/user-match-regressions.json',import.meta.url),'utf8')).find(row=>row.case==='2026-10-02 宝可梦梦点睛与实际41999商品夢描点睛别名');
const ownImage='https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/aa1954d0eebeb0f0f7bd68ff5ed1999553cba189/i-img1101x1200-1789662132990x7977t.jpg';
const otherImage='https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0210/users/6aa9cce46b086b8efaedf39aa01c3fb136c1c313/i-img1027x1200-1790874923313ge6mu7.jpg';
const ownImageSha='1286414ddccbde05f9ab601a0d6cbb4ccd2b7e8a5adcf27fc8b99b0ec44ca603',otherImageSha='8f6b6abf9b7e2ff5d606ccd6eca439b0284eae4027769e7c3b4ea0b72a01a64d';
const ownCondition='未使用',candidateCondition='未使用';
function observed(){return {platform:'yahoo',
  own:{id:'z685606778',seller:{id:'p76217154'},title:prose.ownTitle,description:prose.ownDescription,status:'OPEN',price:44499,condition:ownCondition,images:[ownImage]},
  candidate:{id:'z696507894',seller:{id:'p59959877'},title:prose.candidateTitle,description:prose.candidateDescription,status:'OPEN',price:41999,couponPrice:40999,condition:candidateCondition,images:[otherImage]},
  ownPrimary:{url:ownImage,contentSha256:ownImageSha},candidatePrimary:{url:otherImage,contentSha256:otherImageSha}}}
function fingerprint(primary,value){return {...primary,dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[value,value,value],colorGrid:Array(768).fill(value)}}
async function replay({change=()=>{},settings={},accountId='melon'}={}){
  const record=observed();change(record);
  const item={id:record.own.id,accountId,platform:'yahoo_fleamarket',sellerId:record.own.seller.id,title:record.own.title,ownPrice:record.own.price,image:record.own.images[0],yahoo:{searchCheckedAt:new Date().toISOString()}};
  const card={id:record.candidate.id,title:record.candidate.title,sellerId:record.candidate.seller.id,price:41999,image:record.candidate.images[0],source:'recommendation',recommendationScore:.999};
  return yahooCompare(null,item,settings,{fetchYahooItemBundle:async id=>({detail:id===item.id?record.own:record.candidate,recommendations:id===item.id?[card]:[]}),fetchYahooResult:async()=>({items:[]}),imageFingerprints:async url=>url===record.own.images[0]?fingerprint(record.ownPrimary,100):fingerprint(record.candidatePrimary,200)});
}

test('exact manually reviewed carton pair supplies identity without inventing inside quantity or a similarity score',()=>{
  const record=observed(),evidence=reviewedListingIdentity(record);
  assert.equal(evidence?.kind,'reviewed_listing_identity');
  assert.equal(evidence?.scope,'one_sealed_factory_outer_box');
  const query=record.own.title+'\n'+record.own.description,candidate=record.candidate.title+'\n'+record.candidate.description;
  assert.equal(semanticQuantity(query),null);assert.equal(semanticQuantity(candidate),12);
  assert.equal(sealedSingleBoxTextCompatible({query,candidate}),true);
  assert.equal(sealedSingleBoxEquivalent({query,candidate,primaryImageScore:.625}),false);
  assert.equal(JSON.stringify(evidence).includes('41999'),false);
});

test('reviewed carton evidence revokes on either side identity, complete prose, condition or primary bytes changing',()=>{
  for(const side of ['own','candidate']){
    for(const change of [x=>x.id+='new',x=>x.seller.id+='new',x=>x.title+=' 第3弾',x=>x.description+=' 別の商品です。',x=>x.description='',x=>x.condition='開封済み',x=>x.images=[x.images[0]+'?changed'],x=>x.images=[],x=>x.status='SOLD']){
      const record=observed();change(record[side]);assert.equal(reviewedListingIdentity(record),null,side+' '+change);
    }
    const changedBytes=observed();changedBytes[side==='own'?'ownPrimary':'candidatePrimary'].contentSha256='f'.repeat(64);assert.equal(reviewedListingIdentity(changedBytes),null);
    const missing=observed();missing[side==='own'?'ownPrimary':'candidatePrimary']=null;assert.equal(reviewedListingIdentity(missing),null);
  }
  const reversed=observed();[reversed.own,reversed.candidate]=[reversed.candidate,reversed.own];assert.equal(reviewedListingIdentity(reversed),null);
  assert.equal(reviewedListingIdentity({...observed(),platform:'rakuma'}),null);
});

test('whitespace and current price do not rewrite the reviewed identity snapshot',()=>{
  const record=observed();record.own.description=record.own.description.replaceAll(' ','\n  ');record.candidate.price=39999;record.candidate.couponPrice=1;
  assert.equal(reviewedListingIdentity(record)?.kind,'reviewed_listing_identity');
  for(const key of ['name','text','label','key']){const structured=observed();structured.own.condition={[key]:'未使用'};structured.candidate.condition={[key]:'未使用'};assert.equal(reviewedListingIdentity(structured)?.kind,'reviewed_listing_identity',key)}
  const unknown=observed();unknown.candidate.condition={id:1};assert.equal(reviewedListingIdentity(unknown),null);
});

test('Yahoo keeps actual lower similarity, labels manual evidence and calculates from newly fetched list price',async()=>{
  const result=await replay({change:record=>{record.candidate.price=39876;record.candidate.couponPrice=1}});
  assert.equal(result.competitorCount,1);const candidate=result.candidates[0];
  assert.equal(candidate.price,39876);assert.equal(result.recommendedPrice,39875);
  assert.equal(candidate.matchMethod,'reviewed_sealed_box_identity');
  assert.equal(candidate.identityEvidence.kind,'reviewed_listing_identity');
  assert.ok(candidate.primaryImageScore<.98);assert.ok(candidate.imageScore<1);
});

for(const accountId of ['melon','local-1789214704376','account-p6579087'])test(accountId+': owned sellers and saved user rejection always override manual reviewed identity',async()=>{
  const ownedOffers=buildOwnedOffers([{id:'other-managed',platform:'yahoo_fleamarket',sellerId:'p59959877'}]);
  const owned=await replay({accountId,settings:{ownedOffers}});assert.equal(owned.competitorCount,0);assert.ok(owned.rejected.some(row=>row.reason==='own_seller'));
  const sameSeller=await replay({accountId,change:record=>{record.candidate.seller.id=record.own.seller.id}});assert.equal(sameSeller.competitorCount,0);assert.ok(sameSeller.rejected.some(row=>row.reason==='own_seller'));
  const rejection=await replay({accountId,settings:{matchCorrections:[{accountId,itemId:'z685606778',platform:'yahoo',candidateId:'z696507894',updatedAt:new Date().toISOString(),deleted:false}]}});
  assert.equal(rejection.competitorCount,0);assert.ok(rejection.rejected.some(row=>row.reason==='saved_user_correction'));
});

test('changed specifications, used condition, sold state, missing evidence and relist never inherit the reviewed pair',async()=>{
  for(const change of [x=>x.candidate.description+='\n1BOXは6個入りです。',x=>x.candidate.description+='\n商品は1個のみ。',x=>x.candidate.title=x.candidate.title.replace('第4弾 4代目','第3弾 3代目'),x=>x.candidate.condition='開封済み',x=>x.candidate.status='SOLD',x=>x.candidate.id='z-new-id',x=>x.candidate.seller.id='p-different',x=>x.candidatePrimary.contentSha256=null,x=>x.candidate.images[0]+='?changed',x=>x.candidate.price=NaN]){
    const result=await replay({change});assert.equal(result.competitorCount,0,String(change));assert.equal(result.recommendedPrice,44499);
  }
});

test('fingerprint SHA is the exact already-downloaded byte digest',async()=>{
  const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  const value=await imageFingerprints('data:image/svg+xml;base64,'+bytes.toString('base64'));
  assert.equal(value.contentSha256,createHash('sha256').update(bytes).digest('hex'));
});

const productionSettings=JSON.parse(fs.readFileSync(new URL('../config/settings.json',import.meta.url),'utf8'));
async function crowdedReplay({prior=false,knownCount=1,change=()=>{},settings={}}={}){
  const record=observed(),calls=[];
  if(prior){record.candidate={...record.candidate,id:'z-prior-known',title:record.own.title,description:record.own.description};}
  const target=record.candidate;
  const known=Array.from({length:knownCount},(_,index)=>({...target,id:index?target.id+'-'+index:target.id,price:41999+index*100}));
  const cardFor=detail=>({id:detail.id,title:detail.title,sellerId:detail.seller.id,price:detail.price,image:detail.images[0],source:'recommendation',recommendationScore:.999});
  const cheap=Array.from({length:10},(_,index)=>({...cardFor(target),id:'z-cheap-'+index,price:6000+index*100,image:'https://example.test/cheap-'+index+'.jpg'}));
  const cards=[...cheap,...known.map(cardFor)];
  const details=new Map([...known.map(detail=>[detail.id,detail]),...cheap.map(card=>[card.id,{...target,id:card.id,price:card.price,images:[card.image],condition:'開封済み',description:'中古 開封済み 2BOXをまとめて販売します。'}])]);
  const item={id:record.own.id,accountId:'melon',platform:'yahoo_fleamarket',sellerId:record.own.seller.id,title:record.own.title,ownPrice:44499,image:ownImage,
    yahoo:{searchCheckedAt:new Date().toISOString(),...(prior?{status:'ok',rulesVersion:MATCHING_RULES_VERSION,checkedAt:'2026-01-01T00:00:00Z',audit:{ownItemId:record.own.id,accountId:'melon'},
      candidates:known.map(detail=>({...cardFor(detail),matchMethod:'strong_visual_primary_product'}))}:{})}};
  change({record,item,cards,details,known});
  const result=await yahooCompare(null,item,{...productionSettings,...settings},{
    fetchYahooItemBundle:async id=>{if(id===item.id)return {detail:record.own,recommendations:cards};calls.push(id);return {detail:details.get(id)}},
    fetchYahooResult:async()=>({items:[]}),
    imageFingerprints:async url=>url===ownImage?fingerprint(record.ownPrimary,100):fingerprint({...record.candidatePrimary,url},prior?100:200)
  });
  return {result,calls,targetId:target.id};
}

test('production eight-detail budget reaches the reviewed eleventh offer before ten cheaper wrong lots',async()=>{
  assert.equal(productionSettings.maxYahooDetailChecks,8);
  const {result,calls,targetId}=await crowdedReplay();
  assert.equal(calls[0],targetId);assert.equal(calls.length,8);
  assert.equal(calls.filter(id=>id.startsWith('z-cheap-')).length,7);
  assert.equal(result.candidates[0]?.id,targetId);assert.equal(result.candidates[0]?.price,41999);
  const decision=pricingDecision({id:'z685606778',ownPrice:44499,yahoo:result});
  assert.equal(decision.recommendedPrice,41998);assert.equal(decision.canRecommend,true);assert.equal(decision.complete,false);
  assert.equal(result.candidates[0]?.matchMethod,'reviewed_sealed_box_identity');
  const checkedWrongLots=result.rejected.filter(row=>calls.includes(row.id)&&row.id.startsWith('z-cheap-'));
  assert.equal(checkedWrongLots.length,7);
  assert.ok(checkedWrongLots.every(row=>['sale_unit_mismatch','explicit_variant_mismatch','condition_or_packaging_mismatch'].includes(row.reason)),JSON.stringify(checkedWrongLots));
});

test('manual candidate queue hint binds current own snapshot and exact card identity only',()=>{
  const record=observed(),card={id:record.candidate.id,sellerId:record.candidate.seller.id,title:record.candidate.title,image:otherImage};
  const options={platform:'yahoo',own:record.own,ownPrimary:record.ownPrimary,candidate:card};
  assert.equal(reviewedListingCandidate(options),true);
  for(const key of ['id','sellerId','title','image'])assert.equal(reviewedListingCandidate({...options,candidate:{...card,[key]:card[key]+'changed'}}),false,key);
  assert.equal(reviewedListingCandidate({...options,own:{...record.own,description:record.own.description+'変更'}}),false);
  assert.equal(reviewedListingCandidate({...options,ownPrimary:{...record.ownPrimary,contentSha256:null}}),false);
});

test('known prior competitors get at most two rechecks and leave six default slots for cheaper discoveries',async()=>{
  const {result,calls,targetId}=await crowdedReplay({prior:true,knownCount:3});
  assert.deepEqual(calls.slice(0,2),[targetId,targetId+'-1']);
  assert.equal(calls.length,8);assert.equal(calls.filter(id=>id.startsWith('z-cheap-')).length,6);
  assert.equal(calls.includes(targetId+'-2'),false);assert.equal(result.competitorCount,2);
});

test('prior priority requires the same account, own listing, current rules and unchanged live card fields',async()=>{
  for(const change of [
    x=>x.item.yahoo.audit.accountId='other-account',x=>x.item.yahoo.audit.ownItemId='other-item',
    x=>x.item.yahoo.rulesVersion=MATCHING_RULES_VERSION-1,x=>x.item.yahoo.status='error',
    x=>x.item.yahoo.checkedAt=null,x=>x.item.yahoo.candidates[0].price=0,
    x=>x.item.yahoo.candidates[0].matchMethod='unknown_method',
    x=>x.cards.at(-1).title+=' 別柄',x=>x.cards.at(-1).image+='?changed',x=>x.cards.at(-1).sellerId='other-seller'
  ]){
    const {result,calls,targetId}=await crowdedReplay({prior:true,change});
    assert.equal(calls.includes(targetId),false,String(change));assert.equal(result.competitorCount,0);
  }
});

test('priority never bypasses live stock, description, ownership or saved rejection gates',async()=>{
  for(const prior of [false,true])for(const change of [
    x=>x.known[0].status='SOLD',x=>x.known[0].description+='\n2BOXを販売します。',
    x=>x.known[0].condition='開封済み',x=>x.known[0].price=NaN
  ]){
    const {result,calls,targetId}=await crowdedReplay({prior,change});
    assert.equal(calls[0],targetId);assert.equal(result.competitorCount,0,String(change));
    assert.equal(result.recommendedPrice,44499);
  }
  for(const prior of [false,true]){
    const candidateId=prior?'z-prior-known':'z696507894';
    const ownedOffers=buildOwnedOffers([{id:'managed-elsewhere',platform:'yahoo_fleamarket',sellerId:'p59959877'}]);
    const owned=await crowdedReplay({prior,settings:{ownedOffers}});assert.equal(owned.calls.includes(candidateId),false);assert.equal(owned.result.competitorCount,0);
    const rejected=await crowdedReplay({prior,settings:{matchCorrections:[{accountId:'melon',itemId:'z685606778',platform:'yahoo',candidateId,updatedAt:new Date().toISOString(),deleted:false}]}});
    assert.equal(rejected.calls.includes(candidateId),false);assert.equal(rejected.result.competitorCount,0);
  }
});
