// SYNTHETIC observed-layout HTML. Structure follows existing rakuma.test.mjs
// parser fixtures; these are not captured live payloads or capacity evidence.
export const fixtureTitle='中国限定 スターバックス レオパード グリッター ブルー 370ml';
export const fixtureDescription='新品 未使用 ブルー 370ml 1本';
export const ownId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const candidateId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const otherId='cccccccccccccccccccccccccccccccc';
export const itemUrl=id=>`https://item.fril.jp/${id}`;
export const imageUrl=id=>`https://img.fril.jp/img/${id}/l/product.png`;
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;');
export function cardHtml({id=candidateId,title=fixtureTitle,price=7800,sellerId='200',sold=false}={}){
  return `<div class="item"><a href="${itemUrl(id)}" class="link_search_image" data-rat-itemid="${sellerId}/855341843" data-rat-item_name="${escape(title)}" data-rat-igenrenamepath="雑貨" data-rat-price="${price}"><img data-original="${imageUrl(2)}">${sold?'SOLD OUT':''}</a></div>`;
}
export function searchHtml({cards=[{}],nextUrl=null}={}){
  return `<div class="item-list">${cards.length?cards.map(cardHtml).join(''):'商品が見つかりません'}</div>${nextUrl?`<a rel="next" href="${escape(nextUrl)}">次へ</a>`:''}`;
}
export function detailHtml({id=candidateId,title=fixtureTitle,description=fixtureDescription,price=7800,currency='JPY',
  availability='InStock',sellerId='200',shipping='送料込',method='かんたんラクマパック',image=imageUrl(2)}={}){
  return `<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:title,description,category:'雑貨',image,
    offers:{price,priceCurrency:currency,availability:availability?`https://schema.org/${availability}`:''}})}</script>
  <script>{"seller_user_id":"${sellerId}"}</script><table><tr><th>配送料の負担</th><td>${shipping}</td></tr>
  <tr><th>配送方法</th><td>${method}</td></tr></table>`;
}
export function targetFixture(extra={}){
  return {id:ownId,accountId:'fixture-account',platform:'rakuma',comparisonMode:'same_platform',title:fixtureTitle,
    ownPrice:9000,own:{accessScope:'public',url:itemUrl(ownId)},...extra};
}
export const fixtureOwnedOffers=()=>({rakuma:{items:new Set([ownId]),sellers:new Set(['100'])}});
