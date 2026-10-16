import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateYahooDetail,yahooCompare} from '../scripts/lib/yahoo.mjs';
const title='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア';
const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const item={id:'own',platform:'yahoo',sellerId:'owner',title,ownPrice:28499,image:'own-image'};
const ownDetail={...item,price:item.ownPrice,status:'OPEN',description:'新品 未使用 フィギュア1点',images:[item.image],seller:{id:'owner'}};
const card={id:'candidate',title,price:28000,sellerId:'external',image:'candidate-image'};
const detail={...card,description:ownDetail.description,status:'OPEN',images:[card.image],seller:{id:card.sellerId}};
const shipping={shippingKnown:true,currency:'JPY',shippingJPY:0};

test('ordinary and known candidate detail bind response ID before images and acceptance on every account',async()=>{
 for(const accountId of ['melon','local-1789214704376','account-p6579087'])for(const knownOnly of [false,true]){
  for(const wrongId of ['different-response-item',undefined,null]){
   let imageReads=0;
   const result=await evaluateYahooDetail({item:{...item,accountId},card,bundle:{detail:{...detail,id:wrongId},shipping},ownDetail,knownOnly,
    ownSellerId:item.sellerId,ownConditionText:ownDetail.description,ownFingerprints:[fp],ownImageEvidence:[fp]},
    {imageFingerprints:async()=>{imageReads++;return fp}});
   assert.equal(result.candidate,undefined);assert.equal(result.rejection.reason,'detail_id_mismatch');
   assert.equal(result.currentDetailRead,false);assert.equal(result.currentPrimaryImageScore,null);assert.equal(imageReads,0);
  }
 }
});

test('actual ordinary yahooCompare cannot turn another item response into a lower quotation',async()=>{
 const requested=[];
 const result=await yahooCompare(null,item,{}, {
  fetchYahooResult:async()=>({items:[{...card,thumbnailImageUrl:card.image,itemStatus:'OPEN'}]}),
  fetchYahooItemBundle:async id=>{requested.push(id);return {detail:id===item.id?ownDetail:{...detail,id:'wrong-item'},shipping,recommendations:[]}},
  imageFingerprints:async()=>fp
 });
 assert.deepEqual(requested,['own','candidate']);assert.equal(result.candidates.length,0);
 assert.ok(result.rejected.some(row=>row.id===card.id&&row.reason==='detail_id_mismatch'));
 assert.equal(result.recommendedPrice,item.ownPrice);assert.equal(result.status,'incomplete');
});
