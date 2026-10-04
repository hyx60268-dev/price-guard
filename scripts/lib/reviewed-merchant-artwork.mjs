import { createHash } from 'node:crypto';
import { normalizeOfferPlatform } from '../../public/owned-offers.js';

// Inventory exclusion only. Different photographs of the same card cannot
// meet the duplicate-image threshold. This review supplies that missing visual
// evidence; it never approves a price or attaches these marketplace photographs.
const reviews=[{
 id:'yeshunguang-ss201-z693691302-z683731310-20261004',platform:'yahoo',
 reviewedAt:'2026-10-04',
 evidence:'Both live pages and primary photos inspected: same SS-201 artwork, character pose, upper-left round emblem and lower lettering; front and angled photographs on different backgrounds.',
 owned:{id:'z693691302',sellerId:'p76217154',title:'ゼンゼロ 閃魂コラボ 中国限定 仲夏幻夢 コレクションカード 葉瞬光 SS',
  descriptionSha256:'34af9304a0b144aca03518abc95826fc0b1bb244c0d96e5bc4620511a20a5227',
  image:'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/aa1954d0eebeb0f0f7bd68ff5ed1999553cba189/i-img1200x1139-17905653659655renmq.jpg',
  imageSha256:'1d38e8b967c58f88a27f101e689b7c177f1d7fc79514ea64340a262f21a2982d'},
 product:{id:'z683731310',sellerId:'p59959877',title:'ゼンゼロ 閃魂コラボ 中国限定 仲夏幻夢 コレクションカード 葉瞬光 SS',
  descriptionSha256:'a67e4b5deac09f60fe7ad33d2d0093c5cd4a3e01458885b6efeb2c66dcf90eb1',
  image:'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/6aa9cce46b086b8efaedf39aa01c3fb136c1c313/i-img924x1200-1789455503749i0m89i.jpg',
  imageSha256:'fd4e706f97f0184cd1dd4e8c09a7b948d2983050265c9d75344bcd491e959c32'}
}];
const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const digest=value=>createHash('sha256').update(text(value).replace(/\s+/g,''),'utf8').digest('hex');
const image=p=>(p.sourceImages||p.images||p.yahoo?.ownImages||[p.image])[0];
function snapshotMatches(item,snapshot,withBytes){
 const seller=String(item.seller?.id||item.sellerId||item.sourceDetail?.seller?.id||item.sourceDetail?.sellerId||'');
 const description=item.sourceDescription||item.description||item.yahoo?.ownDescription||item.sourceDetail?.description||'';
 return String(item.sourceId||item.id||'')===snapshot.id&&seller===snapshot.sellerId&&
  text(item.sourceTitle||item.title)===snapshot.title&&digest(description)===snapshot.descriptionSha256&&
  image(item)===snapshot.image&&(!withBytes||item.primaryFingerprint?.url===snapshot.image&&item.primaryFingerprint.contentSha256===snapshot.imageSha256);
}
// Used only to refresh older fingerprints which predate content SHA storage.
export function reviewedMerchantArtworkPair(product,owned,{withBytes=true}={}){
 const platform=p=>normalizeOfferPlatform(p.sourcePlatform||p.platform,p.sourceUrl||p.url||p.ownUrl);
 const review=reviews.find(r=>platform(product)===r.platform&&platform(owned)===r.platform&&
  snapshotMatches(product,r.product,withBytes)&&snapshotMatches(owned,r.owned,withBytes));
 return review?{id:review.id,kind:'reviewed_inventory_artwork',reviewedAt:review.reviewedAt,ownedId:review.owned.id,productId:review.product.id}:null;
}
