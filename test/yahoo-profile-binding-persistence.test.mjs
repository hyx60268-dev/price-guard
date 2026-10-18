import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
const root=process.env.PRICE_GUARD_PROFILE_BINDING_REVIEW_ROOT||fileURLToPath(new URL('..',import.meta.url));
const moduleAt=relative=>import(pathToFileURL(path.join(root,relative)).href);
const {yahooCompare}=await moduleAt('scripts/lib/yahoo.mjs');
const {compactDashboardResult}=await moduleAt('scripts/lib/publish.mjs');
const {buildOwnedOffers}=await moduleAt('public/owned-offers.js');
const {encrypt,decrypt}=await moduleAt('scripts/lib/crypto.mjs');
const {PRICING_RULES_VERSION}=await moduleAt('public/pricing-policy.js');
const {observeYahooProfilePair}=await moduleAt('scripts/lib/yahoo-profile-identity.mjs');
const now=Date.now(),old=now-25*3600_000;
const title='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 特典付き';
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
async function scan({missing,withPrior=false,badBonus=false}={}){
 const own={id:'controlled-own',accountId:'controlled-account',platform:'yahoo',title,sellerId:'p1',ownPrice:28499,image:'https://images.example.invalid/own.jpg'};
 const ownDetail={id:own.id,title,price:28499,status:'OPEN',description:'新品 未使用 フィギュア1点 特典付き',images:[own.image],seller:{id:'p1'}};
 const candidate={id:'controlled-candidate',title,price:28000,sellerId:'p2',image:'https://images.example.invalid/candidate.jpg'};
 const detail={...candidate,status:'OPEN',description:badBonus?'新品 未使用 フィギュア1点 特典なし':ownDetail.description,images:[candidate.image],seller:{id:'p2'}};
 if(withPrior)own.yahoo={candidates:[{...candidate,profileIdentity:{source:'stale_prior_identity_sentinel',identityVerifiedAt:new Date(old-1).toISOString()}}]};
 const reads=[],settings={ownedOffers:buildOwnedOffers([],[own]),ownedOffersComplete:true};
 const result=await yahooCompare(null,own,settings,{
  fetchYahooItemBundle:async id=>{reads.push(id);return id===own.id
   ?{detail:ownDetail,recommendations:[candidate],...(missing==='own'?{}:{observedAt:old})}
   :{detail,recommendations:[],...(missing==='candidate'?{}:{observedAt:old+10})}},
  fetchYahooResult:async()=>({items:[],observedAt:old+5}),imageFingerprints:async()=>fp,
 });
 return {own,ownDetail,detail,result,reads,settings};
}
test('normal accepted detail becomes a source-bound private identity and survives JSON/encrypted state round trip',async()=>{
 const row=await scan(),identity=row.result.candidates[0]?.profileIdentity;
 assert.ok(identity);assert.deepEqual(row.reads,['controlled-own','controlled-candidate']);
 assert.equal(identity.rulesVersion,PRICING_RULES_VERSION);assert.equal(identity.accountId,row.own.accountId);
 assert.equal(identity.own.detailObservedAt,new Date(old).toISOString());assert.equal(identity.own.descriptionObservedAt,new Date(old).toISOString());
 assert.equal(identity.candidate.detailObservedAt,new Date(old+10).toISOString());assert.equal(identity.own.description,undefined);
 const json=JSON.stringify({accounts:[],items:[{...row.own,yahoo:row.result}]});
 const stored=JSON.parse(decrypt(encrypt(Buffer.from(json),'local-test-password-only'),'local-test-password-only').toString());
 assert.deepEqual(stored.items[0].yahoo.candidates[0].profileIdentity,identity);
 const card=(detail,accountId)=>({id:detail.id,accountId,sellerId:detail.seller.id,title:detail.title,priceJPY:detail.price,imageUrl:detail.images[0],itemStatus:'OPEN',
  profileUrl:`https://paypayfleamarket.yahoo.co.jp/user/${detail.seller.id}`,pageUrl:`https://paypayfleamarket.yahoo.co.jp/user/${detail.seller.id}?page=1`,pageNumber:1,observedAt:Date.now(),source:'current_profile_card'});
 const hint=observeYahooProfilePair({ownCard:card(row.ownDetail,row.own.accountId),candidateCard:card(row.detail,'controlled-seller'),identity:stored.items[0].yahoo.candidates[0].profileIdentity,settings:row.settings,now:Date.now()});
 assert.equal(hint.mode,'profile_observation');assert.equal(hint.observation.ownDescriptionObservedAt,identity.own.descriptionObservedAt);assert.equal(hint.observation.detailVerified,false);
});
for(const missing of ['own','candidate'])test(`missing original ${missing} body clock keeps ordinary quote but cannot inherit a cached profile identity`,async()=>{
 const row=await scan({missing,withPrior:true});assert.equal(row.result.candidates.length,1);
 assert.equal(row.result.candidates[0].profileIdentity,undefined);assert.deepEqual(row.reads,['controlled-own','controlled-candidate']);
});
test('a new accepted bound verification replaces, rather than re-times, any stale cached identity',async()=>{
 const row=await scan({withPrior:true});const identity=row.result.candidates[0].profileIdentity;
 assert.equal(identity.source,'accepted_detail_pair');assert.equal(identity.own.detailObservedAt,new Date(old).toISOString());
 assert.equal(JSON.stringify(identity).includes('stale_prior_identity_sentinel'),false);
});
test('rejected bonus mismatch creates no retained identity and compact dashboard strips private identity snapshots',async()=>{
 const rejected=await scan({badBonus:true,withPrior:true});assert.equal(rejected.result.candidates.length,0);
 const row=await scan(),state={accounts:[],items:[{...row.own,yahoo:row.result}]};
 const compact=compactDashboardResult(state);assert.equal(compact.items[0].yahoo.candidates[0].profileIdentity,undefined);
 assert.equal(JSON.stringify(compact).includes('descriptionObservedAt'),false);assert.equal(JSON.stringify(compact).includes('accepted_detail_pair'),false);
 assert.ok(state.items[0].yahoo.candidates[0].profileIdentity);
});
