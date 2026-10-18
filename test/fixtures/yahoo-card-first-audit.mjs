import {buildOwnedOffers} from '../../public/owned-offers.js';
import {violetReports} from './yahoo-violet-reports.mjs';
export const frozenAt='2026-10-16T21:00:00.000Z';
export const primary={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
const baseTitle='APEX ヴァイオレット・エヴァーガーデン 自動手記人形Ver. 1/7 フィギュア 新品 未使用 1点 特典付き';
const baseDescription='新品 未使用 フィギュア1点 特典付き';
function make(key,options={}){
 const item={id:'controlled-own-'+key,accountId:options.accountId||'melon',platform:'yahoo',sellerId:'controlled-owner',title:baseTitle,ownPrice:28499,image:'controlled-own-image'};
 const ownDetail={...item,status:'OPEN',price:item.ownPrice,seller:{id:item.sellerId},description:baseDescription,images:[item.image]};
 const id='controlled-candidate-'+key;
 const card={id,url:'https://paypayfleamarket.yahoo.co.jp/item/'+id,title:baseTitle,price:28000,sellerId:'external',image:'controlled-candidate-image',
  source:'recommendation',observedAt:frozenAt,itemStatus:'OPEN',priceKind:'ordinary',
  availabilityEvidence:{itemId:id,source:'current_search_card',observedAt:frozenAt}};
 const detail={id,title:card.title,price:card.price,seller:{id:card.sellerId},status:'OPEN',description:baseDescription,images:[card.image]};
 const row={key,expectedComparable:Object.hasOwn(options,'expectedComparable')?options.expectedComparable:true,item,ownDetail,card,bundle:{detail,shipping:{shippingKnown:true,currency:'JPY',shippingJPY:0,shippingSource:'target_price_area'}},
  ownDetailObservation:{itemId:item.id,sourceUrl:'https://paypayfleamarket.yahoo.co.jp/item/'+item.id,observedAt:frozenAt},
  ownPrimary:{...primary,url:item.image,contentSha256:'a'.repeat(64),imageObservedAt:frozenAt},cardPrimary:{...primary,url:card.image,contentSha256:'b'.repeat(64),imageObservedAt:frozenAt},ownImageKind:'photo',cardImageKind:'photo'};
 options.change?.(row);return row;
}
export function frozenYahooCardFirstCases(){
 const rows=[
  make('same-photo-low'),make('same-official-low',{change:r=>{r.ownImageKind=r.cardImageKind='official'}}),
  make('official-vs-real',{change:r=>{r.ownImageKind='official';r.cardImageKind='photo'}}),
  make('unknown-image-kind',{change:r=>{r.cardImageKind='unknown'}}),
  make('image-score-low',{change:r=>{r.cardPrimary={...r.cardPrimary,colorGrid:Array(768).fill(130)}}}),
  make('very-low-genuine',{change:r=>{r.card.price=r.bundle.detail.price=10000}}),
  make('visible-box-conflict',{expectedComparable:false,change:r=>{r.card.title=r.bundle.detail.title=baseTitle+' 2点セット';r.bundle.detail.description='新品 未使用 フィギュア2点セット 特典付き'}}),
  make('missing-bonus',{expectedComparable:false,change:r=>{r.card.title=r.bundle.detail.title=baseTitle.replace(' 特典付き','');r.bundle.detail.description='新品 未使用 フィギュア1点 特典なし'}}),
  make('visible-sold',{expectedComparable:false,change:r=>{r.card.itemStatus=r.bundle.detail.status='SOLD'}}),
  make('sparse-recommendation-stock',{change:r=>{r.card.itemStatus=null;delete r.card.availabilityEvidence}}),
  make('own-account',{expectedComparable:false,change:r=>{r.card.sellerId=r.bundle.detail.seller.id=r.item.sellerId}}),
  make('coupon-only',{change:r=>{r.card.price=27000;r.card.priceKind='coupon'}}),
  make('secondary-logo-only',{change:r=>{r.cardPrimary={...r.cardPrimary,dHash:'ffffffff00000000'}}}),
  make('hidden-sale-unit-conflict',{expectedComparable:false,change:r=>{r.bundle.detail.description='新品 未使用 フィギュア2点セット 特典付き'}}),
  make('hidden-sold-conflict',{expectedComparable:false,change:r=>{r.bundle.detail.status='SOLD'}}),
  make('missing-detail-response',{expectedComparable:null,change:r=>{r.bundle=null}})
 ];
 // Only titles/prices and suitcase ID originate from user evidence. These
 // rows intentionally lack a current availability receipt, like today's parser.
 for(const report of violetReports)for(const accountId of ['melon','local-1789214704376','account-p6579087'])rows.push(make(report.key+'-'+accountId,{accountId,change:r=>{
  r.item.title=r.ownDetail.title=report.ownTitle;r.card.title=r.bundle.detail.title=report.candidateTitle;
  r.ownDetail.description=r.bundle.detail.description='新品 未使用 フィギュア1点'+(report.key==='suitcase'?' 特典付き':'');
  r.card.itemStatus=null;delete r.card.availabilityEvidence;
 }}));
 return rows;
}
export const fixtureDisclosure='Controlled frozen evidence, not a live sample. User-reported Violet titles and ordinary prices are reused; IDs (except the separate reported suitcase fixture), sale descriptions, current stock receipts, photo provenance and fingerprints here are synthetic. Hidden-conflict rows deliberately give indistinguishable cards opposite detail truth.';

export const frozenSettings=rows=>({ownedOffers:buildOwnedOffers([],rows.map(row=>row.item)),ownedOffersComplete:true});
