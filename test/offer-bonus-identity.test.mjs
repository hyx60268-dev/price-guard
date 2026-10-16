import {pricingDecision,PRICING_RULES_VERSION} from '../public/pricing-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {offerIdentityGuard} from '../scripts/lib/offer-identity.mjs';
import {evaluateYahooDetail,exactQueryFor,yahooCompare} from '../scripts/lib/yahoo.mjs';
const title='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア';
const text='新品 未使用 フィギュア1点';
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};

test('missing own included bonus is rejected; an extra candidate bonus remains comparable',()=>{
 for(const absent of ['特典なし','特典無し','特典カードなし','特典は付属しません','特典カードはありません','特典付属しない','特典付きではありません','特典が付属していない','特典付属なし']){
  const args={ownTitle:title,ownDescription:text+' 特典付き',candidateTitle:title,candidateDescription:text+' '+absent,primaryImageScore:1};
  assert.equal(offerIdentityGuard(args).reason,'bonus_terms_mismatch',absent);
  const reversed=offerIdentityGuard({...args,ownDescription:args.candidateDescription,candidateDescription:args.ownDescription});
  assert.equal(reversed.accepted,true,absent);
  assert.equal(reversed.bonusComparison,'candidate_extra_bonus');
 }
});

test('contradictory bonus heading/body fails closed, while matching explicit terms preserve eligibility',()=>{
 assert.equal(offerIdentityGuard({ownTitle:title+' 特典付き',ownDescription:text,candidateTitle:title+' 特典付き',candidateDescription:text+' 特典なし',primaryImageScore:1}).reason,'bonus_terms_inconsistent');
 for(const terms of ['特典付き','特典なし',''])assert.equal(offerIdentityGuard({ownTitle:title,ownDescription:text+' '+terms,candidateTitle:title,candidateDescription:text+' '+terms,primaryImageScore:1}).accepted,true);
});

test('actual Yahoo detail verifier rejects missing bonus on each managed account despite identical images',async()=>{
 for(const accountId of ['melon','local-1789214704376','account-p6579087']){
  const item={id:'own',accountId,title:title+' 特典付き',ownPrice:28499,sellerId:'owner'},ownDetail={...item,description:text+' 特典付き',images:['own']};
  const card={id:'candidate',title,price:28000,sellerId:'external',image:'candidate'};
  const bundle={detail:{...card,status:'OPEN',description:text+' 特典なし',seller:{id:'external'},images:['candidate']}};
  const result=await evaluateYahooDetail({item,card,bundle,ownDetail,ownSellerId:'owner',ownConditionText:item.title+'\n'+ownDetail.description,
   exactQuery:exactQueryFor(item.title),ownFingerprints:[fp],ownImageEvidence:[fp]}, {imageFingerprints:async()=>fp});
  assert.equal(result.candidate,undefined);assert.equal(result.rejection.reason,'bonus_terms_mismatch');
 }
});

// Full collector regression: do not mistake the isolated identity guard for
// proof that the candidate survives real screening and lowest-price selection.
test('actual yahooCompare preserves a cheaper extra-bonus offer and rejects a missing own bonus on all accounts',async()=>{
 for(const accountId of ['melon','local-1789214704376','account-p6579087']){
  for(const [ownTerms,candidateTerms,accepted] of [['特典なし','特典付き',true],['特典付き','特典なし',false],['特典付き','特典付属しない',false],['特典付き','',false]]){
   const item={id:'own',platform:'yahoo',accountId,title:title+' '+ownTerms,ownPrice:28499,sellerId:'owner',image:'own-image'};
   const card={id:'candidate',title:title+' '+candidateTerms,price:28000,sellerId:'external',image:'candidate-image'};
   const result=await yahooCompare(null,item,{}, {
    fetchYahooResult:async()=>({items:[{...card,itemStatus:'OPEN',thumbnailImageUrl:card.image}]}),
    fetchYahooItemBundle:async id=>({detail:id===item.id?{...item,status:'OPEN',description:text+' '+ownTerms,seller:{id:'owner'},images:[item.image]}:
     {...card,status:'OPEN',description:text+' '+candidateTerms,seller:{id:'external'},images:[card.image]},recommendations:[]}),
    imageFingerprints:async()=>fp
   });
   assert.equal(result.detailCheckedCount,1,accountId+' '+candidateTerms);
   assert.equal(result.candidates.length,accepted?1:0,accountId+' '+candidateTerms);
   if(accepted){assert.equal(result.lowestPrice,28000);assert.equal(result.candidates[0].bonusComparison,'candidate_extra_bonus')}
   else assert.ok(result.rejected.some(row=>['bonus_terms_mismatch','bonus_terms_unconfirmed'].includes(row.reason)));
  }
 }
});

test('positive bonus statements with は or が cannot match an absent candidate bonus',()=>{
 for(const ownTerms of ['特典は付属します','特典が付属します']){
  assert.equal(offerIdentityGuard({ownTitle:title,ownDescription:text+' '+ownTerms,candidateTitle:title,candidateDescription:text+' 特典なし',primaryImageScore:1}).reason,'bonus_terms_mismatch');
 }
});

test('bonus rule revision invalidates old actionable quotes without changing timestamps or manual cost',()=>{
 const checkedAt='2026-10-16T21:00:00.000Z';
 const item={id:'own',platform:'yahoo',comparisonMode:'same_platform',ownPrice:28499,
  manualCost:{cny:1000,verifiedAt:'2026-10-01T00:00:00.000Z'},
  yahoo:{rulesVersion:22,status:'ok',checkedAt,searchCheckedAt:checkedAt,
   candidates:[{id:'old-no-bonus',price:28000,url:'https://paypayfleamarket.yahoo.co.jp/item/old-no-bonus',matchMethod:'exact_bidirectional_title_identity'}]}};
 const before=structuredClone(item),result=pricingDecision(item,{now:Date.parse(checkedAt)+1000});
 assert.equal(PRICING_RULES_VERSION,23);assert.equal(result.canRecommend,false);assert.equal(result.complete,false);
 assert.equal(result.lowest,null);assert.equal(result.recommendedPrice,item.ownPrice);
 assert.deepEqual(item,before); // pure invalidation, no invented observation or lost manual cost
 const fresh={...item,yahoo:{...item.yahoo,rulesVersion:PRICING_RULES_VERSION}};
 assert.equal(pricingDecision(fresh,{now:Date.parse(checkedAt)+1000}).canRecommend,true);
});

test('required own bonus absent from candidate terms remains unconfirmed despite matching body photos',()=>{
 assert.equal(offerIdentityGuard({ownTitle:title+' 特典付き',ownDescription:text,candidateTitle:title,candidateDescription:text,primaryImageScore:1}).reason,'bonus_terms_unconfirmed');
});

test('title-only screening keeps an unstated bonus for detail discovery and body evidence can confirm it',()=>{
 const args={ownTitle:title+' 特典付き',ownDescription:text,candidateTitle:title,candidateDescription:'',primaryImageScore:1};
 assert.equal(offerIdentityGuard({...args,ownDescription:'',requireDescriptions:false}).accepted,true);
 assert.equal(offerIdentityGuard({...args,candidateDescription:text+' 特典付き'}).accepted,true);
});


test('bare bonus-included headings bind required sale contents',()=>{
 for(const terms of ['特典付属','特典付属。','特典が付属、']){
  assert.equal(offerIdentityGuard({ownTitle:title+' '+terms,ownDescription:text,candidateTitle:title,candidateDescription:text+' 特典なし',primaryImageScore:1}).reason,'bonus_terms_mismatch',terms);
 }
});
