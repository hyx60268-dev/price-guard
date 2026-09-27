import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRakumaDetail,extractRakumaSearchCards,rakumaCompare } from '../scripts/lib/rakuma.mjs';
import { acceptMatchCorrections } from '../scripts/lib/match-corrections.mjs';

const fp=value=>({dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[value,value,value],colorGrid:Array(768).fill(value)});
const id='3800d9ab35fad89e084d7a60b889abad',url=`https://item.fril.jp/${id}`;

function searchHtml({title,price=7800}){
  return `<div class="item"><a href="${url}" class="link_search_image" data-rat-itemid="21821488/855341843" data-rat-item_name="${title}" data-rat-igenre="123" data-rat-price="${price}"><img data-original="https://img.fril.jp/img/1/m/1.jpg"></a></div>`;
}
function detailHtml({title,description,price=7800,available=true}){
  return `<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:title,description,image:'https://img.fril.jp/img/1/l/1.jpg',offers:{price,availability:`https://schema.org/${available?'InStock':'OutOfStock'}`}})}</script><div data-rat-igenre="123"></div><table><tr><th>配送料の負担</th><td>送料込</td></tr></table>`;
}
async function compare({ownTitle,candidateTitle=ownTitle,ownDescription,candidateDescription=ownDescription,sameImage=true}){
  return rakumaCompare({id:'own',accountId:'melon',title:ownTitle,ownPrice:9000,image:'own-image',yahoo:{ownDescription,ownCategory:'雑貨',ownImages:['own-image']}},{maxRakumaDetailChecks:4},{
    fetchHtml:async requested=>requested.startsWith('https://fril.jp/s?')?searchHtml({title:candidateTitle}):detailHtml({title:candidateTitle,description:candidateDescription}),
    imageFingerprints:async requested=>fp(requested==='own-image'||sameImage?100:200)
  });
}

test('Rakuma public search and detail structures are parsed',()=>{
  const title='中国限定 スターバックス レオパード グリッター ブルー 370ml';
  const cards=extractRakumaSearchCards(searchHtml({title}));
  assert.equal(cards.length,1);assert.equal(cards[0].id,id);assert.equal(cards[0].price,7800);assert.match(cards[0].image,/img\.fril\.jp/);
  const detail=extractRakumaDetail(detailHtml({title,description:'新品 未使用 ブルー 370ml'}),url);
  assert.equal(detail.status,'OPEN');assert.equal(detail.price,7800);assert.equal(detail.description,'新品 未使用 ブルー 370ml');
});

test('Rakuma exact live item passes the same strict detail gate',async()=>{
  const title='中国限定 スターバックス レオパード グリッター ブルー 370ml';
  const result=await compare({ownTitle:title,ownDescription:'新品 未使用 ブルー 370ml 1本'});
  assert.equal(result.status,'ok');assert.equal(result.competitorCount,1);assert.equal(result.lowestPrice,7800);
});

test('Rakuma different colour is rejected even when the generic product name matches',async()=>{
  const ownTitle='中国限定 スターバックス レオパード グリッター ブルー 370ml';
  const candidateTitle='中国限定 スターバックス レオパード グリッター ブラウン 370ml';
  const result=await compare({ownTitle,candidateTitle,ownDescription:'新品 未使用 カラー：ブルー 370ml',candidateDescription:'新品 未使用 カラー：ブラウン 370ml'});
  assert.equal(result.competitorCount,0);assert.ok(result.rejected.some(row=>row.reason==='description_color_mismatch'||row.reason==='variant_mismatch'));
});

test('Rakuma single item cannot price a multi-item set',async()=>{
  const title='POP MART SKULLPANDA Petals in Four Acts シークレット';
  const result=await compare({ownTitle:`${title} 3個セット`,candidateTitle:title,ownDescription:'新品 未開封 3個セット 別売り不可',candidateDescription:'新品 未開封 1個'});
  assert.equal(result.competitorCount,0);assert.ok(result.rejected.some(row=>row.reason==='sale_unit_mismatch'));
});

test('saved Rakuma correction blocks a previously accepted candidate',async()=>{
  const title='中国限定 スターバックス レオパード グリッター ブルー 370ml';
  const record={accountId:'melon',itemId:'own',platform:'rakuma',candidateId:id,updatedAt:new Date().toISOString(),deleted:false};
  const result=await rakumaCompare({id:'own',accountId:'melon',title,ownPrice:9000,image:'own-image',yahoo:{ownDescription:'新品 未使用 ブルー 370ml',ownCategory:'雑貨',ownImages:['own-image']}},{maxRakumaDetailChecks:4,matchCorrections:{one:record}},{fetchHtml:async()=>searchHtml({title}),imageFingerprints:async()=>fp(100)});
  assert.equal(result.competitorCount,0);assert.ok(result.rejected.some(row=>row.reason==='saved_user_correction'));
});

test('encrypted sync accepts a correction for a displayed Rakuma candidate',()=>{
  const updatedAt=new Date().toISOString(),item={id:'own',accountId:'melon',title:'商品',image:'own',rakuma:{candidates:[{id,title:'候选'}]}};
  const incoming={one:{accountId:'melon',itemId:'own',platform:'rakuma',candidateId:id,reason:'not_same_product',updatedAt,deleted:false}};
  const accepted=acceptMatchCorrections({},incoming,[item],null,Date.now());
  assert.equal(Object.values(accepted)[0].platform,'rakuma');
});

test('Rakuma missing availability stays unknown and missing shipping is not silently free',()=>{
 const html=detailHtml({title:'Myethos フィギュア',description:'新品'});
 assert.equal(extractRakumaDetail(html.replace('https://schema.org/InStock',''),url).status,'UNKNOWN');
 assert.equal(extractRakumaDetail(html.replace('送料込','着払い'),url).shippingKnown,false);
});
