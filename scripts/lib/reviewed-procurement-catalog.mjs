import {createHash} from 'node:crypto';

// A human comparison establishes product identity only, never sealed condition,
// price, stock or freight. Live readers must verify those separately.
const reviews=[
  {
    "id": "narberal-z679021554-al20744-20261007",
    "reviewedAt": "2026-10-07",
    "observation": "Live boxed product and retailer gallery manually compared: matching red-and-black bunny ears, black corset with white cross lacing, white lace trim, golden staff, rose-decorated stone pedestal and sitting pose. Own back-box explicitly prints Narberal Gamma so-bin Ver. and 1/8. This confirms the catalogue product only; sealed condition and exact production batch are not inferred. Own third and fifth packaging photos were inspected, not substituted into the primary-image score.",
    "own": {
      "id": "z679021554",
      "sellerId": "p6579087",
      "title": "ALTER オーバーロード ナーベラル・ガンマ so-bin Ver.フィギュア",
      "descriptionSha256": "4b071eefc90120a19f6947febf7999e43c7079ae65e553422f6015013a2a031f",
      "condition": "未使用",
      "image": "https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/df683a7ebea962737028bd2830aacc9e5928b694/i-img981x1200-17888949831044ibi4t.jpg",
      "imageSha256": "0c8c3ae78f828fb22ee16aea922f2261e13557a1f9b6c527c7327effc0203354"
    },
    "supplier": {
      "source": "alter_shanghai",
      "canonicalUrl": "https://www.alter-shanghai.cn/m/spotPage/298.html",
      "sellerKey": "alter_shanghai:retail",
      "skuId": "AL20744",
      "selectedVariant": "AL20744 / 娜贝拉尔·伽玛 so-bin Ver.【再版】 / 1/8",
      "title": "娜贝拉尔·伽玛 so-bin Ver.【再版】",
      "descriptionSha256": "5a41a303f0fb9adb937de33ca78e4a3b456f9dbf865634fcad52c9e1955eea1f",
      "condition": "retail_unspecified",
      "image": "https://www.alter-shanghai.cn/files/images/narberal_all1.jpg",
      "imageSha256": "cbd0e49d8ebeccef043aab93e28448d656a339b3eb684e8f4864bc6b416a3906"
    }
  }
];
const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
export const catalogueTextDigest=value=>createHash('sha256').update(text(value),'utf8').digest('hex');
const condition=value=>text(typeof value==='string'?value:value?.name||value?.text||value?.label||value?.key||'');
const firstImage=item=>{const first=item.sourceDetail?.images?.[0]||item.images?.[0];return typeof first==='string'?first:first?.url||item.image||''};
const ownDescription=item=>item.sourceDetail?.description??item.yahoo?.ownDescription??item.description??'';
function ownSnapshot(item={}){
 return {id:String(item.id||''),sellerId:String(item.sourceDetail?.seller?.id||item.sourceDetail?.sellerId||item.seller?.id||item.sellerId||''),
  title:text(item.title),descriptionSha256:catalogueTextDigest(ownDescription(item)),
  condition:condition(item.sourceDetail?.condition??item.yahoo?.ownCondition??item.condition),image:firstImage(item)};
}
function supplierSnapshot(quote={}){
 return {source:quote.source,canonicalUrl:quote.canonicalUrl,sellerKey:quote.sellerKey,skuId:String(quote.skuId||''),
  selectedVariant:text(quote.selectedVariant),title:text(quote.detailTitle),descriptionSha256:catalogueTextDigest(quote.detailDescription),
  condition:quote.condition,image:quote.detailImages?.[0]};
}
const fieldsEqual=(current,snapshot)=>Object.keys(current).every(key=>current[key]===snapshot?.[key]);
function evidence(review){
 return {id:review.id,method:'reviewed_catalog_identity',reviewedAt:review.reviewedAt,
  scope:'catalogue_product_only',sealVerified:false,own:{...review.own},supplier:{...review.supplier}};
}
export function matchesProcurementCatalogueReview({item,quote,ownPrimary,sourcePrimary},review){
 if(!review?.id||!review.reviewedAt||!review.observation||!item?.accountId)return false;
 if(!fieldsEqual(ownSnapshot(item),review.own)||!fieldsEqual(supplierSnapshot(quote),review.supplier))return false;
 if(item.image!==review.own.image||!text(ownDescription(item))||!text(quote.detailDescription))return false;
 if(item.sourceDetail?.status&&item.sourceDetail.status!=='OPEN')return false;
 return [[ownPrimary,review.own],[sourcePrimary,review.supplier]].every(([primary,snapshot])=>
  /^[a-f0-9]{64}$/.test(snapshot.imageSha256||'')&&primary?.url===snapshot.image&&primary.contentSha256===snapshot.imageSha256);
}
export function reviewedProcurementCatalogIdentity(input={}){
 const review=reviews.find(row=>matchesProcurementCatalogueReview(input,row));
 return review?evidence(review):null;
}
export function currentReviewedProcurementCatalogIdentity({item,offer}={}){
 const review=reviews.find(row=>row.id===offer?.catalogIdentity?.id);
 if(!review||!item?.accountId||item.image!==review.own.image||
  !fieldsEqual(ownSnapshot(item),review.own)||!fieldsEqual(supplierSnapshot(offer),review.supplier))return null;
 if(item.sourceDetail?.status&&item.sourceDetail.status!=='OPEN')return null;
 return JSON.stringify(offer.catalogIdentity)===JSON.stringify(evidence(review))?evidence(review):null;
}
