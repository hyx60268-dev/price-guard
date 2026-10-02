import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { reviewedListingIdentity } from '../scripts/lib/reviewed-listing-identities.mjs';
import { yahooCompare } from '../scripts/lib/yahoo.mjs';
import { semanticQuantity,sealedSingleBoxEquivalent,sealedSingleBoxTextCompatible } from '../scripts/lib/rules.mjs';
import { buildOwnedOffers } from '../public/owned-offers.js';
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
