// Generated, non-marketplace evidence. The first 29 pages have 2,320 retained
// card observations / 1,833 distinct IDs, matching only a known count ratio.
// Text/image/detail sizes below are synthetic, not sampled production payloads.
const T=Date.parse('2026-10-18T05:00:00Z');
const url=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
export function generatedYahooPageRetentionEvents({sourceCount=100,cardsPerSource=96,detailCharacters=4200}={}) {
  return Array.from({length:sourceCount},(_,sourceIndex)=>{
    const id=`fixture-source-${sourceIndex}`,at=T+sourceIndex;
    const detail={id,title:'合成の検証用 商品ページ',description:'合成の説明文。'.repeat(Math.ceil(detailCharacters/7)).slice(0,detailCharacters),
      price:19999.5,status:'OPEN',seller:{id:`fixture-seller-${sourceIndex}`},images:[`https://fixture.invalid/detail/${id}.jpg`]};
    const cards=Array.from({length:cardsPerSource},(_,cardIndex)=>{
      const number=Math.floor(sourceIndex*1753/28)+cardIndex,id=`fixture-card-${number}`;
      return {id,url:url(id),title:`合成の検証用 APEX スケールフィギュア 完成品 ${number} `+'商品仕様・付属品を別途確認するための情報 '.repeat(3),
        image:`https://fixture.invalid/images/items/${id}/`+'a'.repeat(112)+'.jpg?width=300&height=300&quality=80',
        sellerId:`fixture-seller-${number%300}`,price:9999.5+(number%20000),priceKind:'ordinary',currency:'JPY',
        priceField:'recommendItems.items.price',priceSource:'yahoo_recommendation_receipt_v1',recommendationSection:'similar',observedAt:new Date(at).toISOString()};
    });
    // A pre-existing decoded body, no transport or parser work is initiated.
    const html=`<synthetic-fixture>${JSON.stringify({detail,cards})}</synthetic-fixture>`;
    return {page:{html,url:url(id),status:200,redirected:false,fromCache:false,observedAt:at},requestedItemId:id,role:'candidate',detail,
      shipping:{shippingKnown:true,currency:'JPY',shippingJPY:0},recommendationReceipt:{version:1,requestedItemId:id,sourceUrl:url(id),
        observedAt:new Date(at).toISOString(),cards,totalCards:cards.length,invalidCards:0,sectionsTruncated:false}};
  });
}
export const generatedYahooPageRetentionTime=T;
