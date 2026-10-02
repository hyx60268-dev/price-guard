import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,identityVariantFacets,hasExplicitVariantMismatch,semanticQuantity,semanticSameItem,sealedSingleBoxEquivalent,visualListingEquivalent} from '../scripts/lib/rules.mjs';
import {offerIdentityGuard} from '../scripts/lib/offer-identity.mjs';
import {yahooCompare} from '../scripts/lib/yahoo.mjs';
const ownTitle="海外限定 ポケモン30周年 梦点睛 ピカチュウ フィギュア 1BOX";
const title="新品未開封 ポケモン 30周年 夢描点睛 第4弾 4代目 ピカチュウ フィギュア 1BOX 12個入り 正規品";
// Titles and candidate specification prose come from the reported live pages.
// Own prose is the complete observed description; it never says 12 figures.
const ownDescription="ポケモン30周年記念「梦点睛」シリーズより、ピカチュウのブラインドフィギュアBOXです。 さまざまなポケモンカードとピカチュウを組み合わせたデザインで、カードのイラストから飛び出したような立体感のあるフィギュアシリーズとなっています。 ・作品：ポケットモンスター ・キャラクター：ピカチュウ ・シリーズ：30周年記念「梦点睛」 ・種類：ブラインドフィギュア ・ラインナップ：通常12種＋シークレット ・海外限定 ・BOX未開封 それぞれ異なるカードデザインとピカチュウのポーズを楽しめる、コレクション性の高いシリーズです。 ポケモン30周年記念グッズを集めている方や、ピカチュウがお好きな方にもおすすめです。 こちらはBOX単位での出品となります。 未開封商品のため、中身の種類は確認しておりません。 ※ブラインド商品のため、封入内容はランダムとなります。 ※シークレットの封入を保証するものではございません。 ※海外限定商品のため、外箱に初期スレ、へこみ、角傷みなどがある場合がございます。 ※商品の状態は掲載画像をご確認のうえ、ご購入をお願いいたします。 即購入OKです。";
const description="【商品情報】\n・簡体字中国語版\n・新品未開封\n・メーカー純正BOX\n・1BOX＝12個入り\n・全13種類（通常12種類＋シークレット1種類）\n・ピカチュウをテーマにしたシリーズ\n【1個の内容】\n・ランダムフィギュア 1個\n・対応するポケモンのトレーディングカード 1枚\n・「30周年記念」パック 1パック（6枚入り）\nブラインド商品";
const ownFull=ownTitle+'\n'+ownDescription,candidateFull=title+'\n'+description;
const fp=(value=100)=>({dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[value,value,value],colorGrid:Array(768).fill(value)});
async function replay({ownText=ownTitle,candidateTitle=title,ownBody=ownDescription,candidateBody=description,primary=true,secondary=false}={}){
 const item={id:'z685606778',title:ownText,ownPrice:44499,image:'own-primary',yahoo:{searchCheckedAt:new Date().toISOString()}};
 const candidate={id:'z696507894',title:candidateTitle,price:41999,image:'candidate-primary',sellerId:'competitor',source:'recommendation',recommendationScore:.999};
 return yahooCompare(null,item,{},{fetchYahooItemBundle:async id=>id===item.id?{detail:{id:item.id,title:ownText,description:ownBody,status:'OPEN',images:['own-primary',...(secondary?['shared-secondary']:[])]},recommendations:[candidate]}:{detail:{id:candidate.id,title:candidateTitle,description:candidateBody,status:'OPEN',price:41999,couponPrice:40999,seller:{id:'competitor'},images:['candidate-primary',...(secondary?['shared-secondary']:[])]}},fetchYahooResult:async()=>({items:[]}),imageFingerprints:async url=>fp(url==='candidate-primary'&&!primary?200:100)});
}
test('actual Pokemon collection spellings normalize without erasing generation identity',()=>{
 for(const name of ['梦点睛','夢点睛','絵夢点睛','絵夢点晴','夢描点睛'])assert.equal(normalize(name),'emutenkai');
 for(const a of ['3代目','第3代目','第3弾'])for(const b of ['4代目','第4代目','第4弾']){
  const left=ownTitle+' '+a,right=title.replace('第4弾 4代目',b);
  assert.equal(hasExplicitVariantMismatch(left,right),true,a+' / '+b);
  assert.equal(offerIdentityGuard({ownTitle:left,ownDescription,candidateTitle:right,candidateDescription:description,checkImages:false}).accepted,false);
 }
 assert.deepEqual([...identityVariantFacets(ownTitle+' 4代目').waves],['4']);
 assert.equal(hasExplicitVariantMismatch(ownTitle+' 第3弾 4代目',title),true);
 for(const value of ['商品 3代目','ポケモン フィギュア 3代目','夢点睛 3代目','ポケモン 梦点睛 文庫 3代目',ownTitle+' 2026/4/3',ownTitle+'\n梱包担当は3代目です。'])assert.deepEqual([...identityVariantFacets(value).waves],[],value);
});
test('a sealed single outer box uses primary carton evidence without inventing missing inner quantity',()=>{
 assert.equal(semanticQuantity(ownFull),null);assert.equal(semanticQuantity(candidateFull),12);
 assert.equal(semanticQuantity('ポケモン フィギュア 単品 ランダム'),1);
 assert.equal(semanticQuantity('ポケモン フィギュア 1BOX\n内容はランダムです。'),null);
 assert.equal(semanticSameItem({query:ownTitle,candidate:title}).accepted,false);
 assert.equal(visualListingEquivalent({query:ownFull,candidate:candidateFull,imageScore:1}),false);
 assert.equal(sealedSingleBoxEquivalent({query:ownFull,candidate:candidateFull,primaryImageScore:1}),true);
 for(const score of [null,.7,.979])assert.equal(sealedSingleBoxEquivalent({query:ownFull,candidate:candidateFull,primaryImageScore:score}),false);
 assert.equal(semanticQuantity(ownFull),null);
});
test('single-box exception rejects explicit counts, generations, characters, colours, packaging and selection conflicts',()=>{
 const positive={query:ownFull,candidate:candidateFull,primaryImageScore:1};
 for(const changed of [candidateFull.replaceAll('1BOX','2BOX'),candidateFull.replace('第4弾 4代目','第3弾 3代目'),candidateFull.replaceAll('ピカチュウ','イーブイ'),candidateFull+'\n開封済み',candidateFull+'\n外箱のみ',candidateFull+'\n欠品あり',candidateFull+'\n12小箱セット',candidateFull+'\n12体セット',candidateFull+'\n好きな款を選べる',candidateFull+'\n商品は1個のみ。残りは見本です。',candidateFull.replace('第4弾 4代目','第3弾 4代目')]){
  const query=changed.includes('第3弾')?ownFull.replace('1BOX','第4弾 1BOX'):ownFull;
  assert.equal(sealedSingleBoxEquivalent({...positive,query,candidate:changed}),false,changed);
 }
 assert.equal(sealedSingleBoxEquivalent({...positive,query:ownFull.replace('1BOX','1BOX 6個入り')}),false);
 assert.equal(sealedSingleBoxEquivalent({...positive,query:ownFull.replace('1BOX','1BOX イエロー'),candidate:candidateFull.replace('1BOX','1BOX ブルー')}),false);
 assert.equal(sealedSingleBoxEquivalent({...positive,query:'POPMART NARUTO 暁 フィギュア 未開封 セット',candidate:'POPMART NARUTO 暁 フィギュア 未開封 12体セット'}),false);
});
test('Yahoo replay compares the verified single carton using listed 41999, never coupon 40999',async()=>{
 const result=await replay();assert.equal(result.detailCheckedCount,1);assert.equal(result.competitorCount,1);assert.equal(result.recommendedPrice,41998);assert.equal(result.candidates[0].price,41999);assert.equal(result.candidates[0].matchMethod,'same_sealed_single_box_primary');
 // This replay controls the fingerprint input; real matching still needs a cloud run.
 assert.equal(semanticQuantity(ownFull),null);
});
test('shared secondary imagery cannot prove a sealed box with a different primary photograph',async()=>{
 const result=await replay({primary:false,secondary:true});assert.equal(result.competitorCount,0);assert.equal(result.recommendedPrice,44499);const rejected=result.rejected.find(row=>row.reason==='collectible_variant_image_unconfirmed');assert.ok(rejected);assert.equal(rejected.imageScore,1);assert.ok(Number.isFinite(rejected.primaryImageScore)&&rejected.primaryImageScore<.98);
});
test('Yahoo real-body replay preserves explicit version and complete-versus-loose package rejection',async()=>{
 for(const options of [{ownText:ownTitle+' 第3弾'},{ownText:ownTitle.replace('1BOX','2BOX')},{ownBody:'新品未開封 1BOX 6個入り'},{candidateBody:description+'\n箱なし、フィギュア12体セットです。'},{candidateBody:description+'\n商品は1個のみ。残りは見本です。'},{candidateTitle:title.replace('第4弾 4代目','第3弾 4代目')}]){
  const result=await replay(options);assert.equal(result.competitorCount,0,JSON.stringify(options));assert.equal(result.recommendedPrice,44499);
 }
});
