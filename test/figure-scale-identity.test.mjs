import test from 'node:test';
import assert from 'node:assert/strict';
import {hasExplicitVariantMismatch,identityVariantFacets,visualListingEquivalent} from '../scripts/lib/rules.mjs';
import {offerIdentityGuard} from '../scripts/lib/offer-identity.mjs';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
const own='Myethos 荒蕪ラップランド1/7フィギュア',other='Myethos 荒蕪ラップランド1/8フィギュア';
const scales=value=>[...(identityVariantFacets(value).figureScales||[])];

test('reported Myethos 1/7 and 1/8 remain different physical figures with perfect image similarity',()=>{
 assert.equal(hasExplicitVariantMismatch(own,other),true);
 assert.equal(hasExplicitVariantMismatch(other,own),true);
 assert.equal(offerIdentityGuard({ownTitle:own,candidateTitle:other,ownDescription:'新品未開封 1点',candidateDescription:'新品未開封 1点',primaryImageScore:1}).reason,'explicit_variant_mismatch');
 assert.equal(visualListingEquivalent({query:own,candidate:other,imageScore:1}),false);
});

test('figure and model scale extraction supports real fraction spacing without supplying omitted scale',()=>{
 for(const [title,expected] of [[own,'1/7'],['ALTER 1／7 スケール フィギュア','1/7'],['Myethos 1 / 7 scale figure','1/7'],['模型 1/144','1/144'],['RG ガンプラ1/144','1/144'],['手办 1/7 比例','1/7']])assert.deepEqual(scales(title),[expected],title);
 assert.equal(hasExplicitVariantMismatch(own,own.replace('1/7','1／7')),false);
 assert.equal(hasExplicitVariantMismatch(own,own.replace('1/7','')),false);
 assert.equal(hasExplicitVariantMismatch('ガンプラ 1/100','ガンプラ 1/144'),true);
 assert.deepEqual(scales('Myethos フィギュア\n【スケール】1/7\n1/8発送'),['1/7']);
 assert.deepEqual(scales(own+'\n他にも1/8フィギュアを出品しています。'),['1/7']);
});

test('release dates, calendar ranges and chapter indices never become model-scale evidence',()=>{
 for(const title of ['フィギュア 2026/1/7 発売','フィギュア 2026年1/7 発売','フィギュア 1/7発売','フィギュア 発売日 1/7','フィギュア 発売日は1/7','フィギュア 1/7に発売','figure released 1/7','フィギュア 1/7.5','フィギュア 1/7～1/8発送','フィギュア 1/7から1/8まで','フィギュア 1/7(水)入荷','フィギュア 発送 1/7-1/8','フィギュア 予約期間:1/7〜1/8','フィギュア 1/7/2026 発売','フィギュア 1/7時点の在庫','小説 第1/7章','模型の作り方 書籍 第1/7章','figure study chapter 1/7','塗装ガイド 図1/7 フィギュア'])assert.deepEqual(scales(title),[],title);
 assert.deepEqual(scales('Myethos 1/7スケールフィギュア 1/8発送'),['1/7']);
 for(const verb of ['購入','更新','到着','入手','发货','到货','收货','购买'])for(const dated of ['1/7'+verb,verb+'1/7']){const title='Myethos 1/8 フィギュア '+dated;assert.deepEqual(scales(title),['1/8'],title);assert.equal(hasExplicitVariantMismatch(title,'Myethos 1/8 フィギュア'),false,title)}
 assert.equal(hasExplicitVariantMismatch('Myethos フィギュア 1/7発売','Myethos フィギュア 1/8発売'),false);
});

test('scale evidence preserves colour and quantity hard constraints',()=>{
 assert.equal(hasExplicitVariantMismatch(own+' ブラック',own+' ホワイト'),true);
 assert.equal(hasExplicitVariantMismatch(own+' 1点',own+' 2点'),true);
 assert.equal(hasExplicitVariantMismatch(own,own+' 1/8スケール'),true);
});

const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
for(const accountId of ['melon','local-1789214704376','account-p6579087'])test(accountId+': Yahoo cannot turn another scale into a cheaper competitor',async()=>{
 const item={accountId,id:'own-scale',title:own,ownPrice:27000,image:'own-primary',yahoo:{searchCheckedAt:new Date().toISOString()}};
 const candidate={id:'other-scale',title:other,price:25000,image:'other-primary',sellerId:'external-seller',source:'recommendation',recommendationScore:.999};
 const result=await yahooCompare(null,item,{}, {fetchYahooItemBundle:async id=>id===item.id?{detail:{id,title:own,description:'新品未開封 1点',images:['own-primary']},recommendations:[candidate]}:{detail:{id,title:other,description:'新品未開封 1点',status:'OPEN',price:25000,seller:{id:'external-seller'},images:['other-primary']}},fetchYahooResult:async()=>({items:[]}),imageFingerprints:async()=>fp});
 assert.equal(result.competitorCount,0);assert.equal(result.recommendedPrice,27000);
 assert.ok(result.rejected.some(row=>['variant_mismatch','explicit_variant_mismatch'].includes(row.reason)));
});
