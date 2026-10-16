import { XIANYU_VERIFICATION } from '../../scripts/lib/xianyu-evidence.mjs';
import { procurementTarget } from '../../scripts/lib/procurement-evidence.mjs';
import { XIANYU_COST_VERIFICATION,xianyuQuoteSelection,xianyuPurchaseTerms } from '../../scripts/lib/xianyu-procurement-evidence.mjs';
export function xianyuProcurementItem(now=Date.now(),changes={},prices=[95,105]){
 const item={accountId:'shop-a',id:'z123456789',title:'フィギュア ホワイト 1個',image:'https://images.example.org/own.jpg',description:'新品 ホワイト 1個',condition:'新品',...changes};
 const target=procurementTarget(item),checkedAt=new Date(now).toISOString(),detailTitle=item.title;
 const detailDescription=(target.description||detailTitle)+'。'+target.condition+'。现货，全国包邮。';
 const samples=prices.map((price,index)=>({id:String(index+1),url:'https://www.goofish.com/item?id='+(index+1),canonicalUrl:'https://www.goofish.com/item?id='+(index+1),
  sellerKey:'goofish:'+(index+100),price,unitCNY:price,landedCNY:price,currency:'CNY',currencyEvidence:'target_price_cny',priceSource:'target_detail',
  ...xianyuPurchaseTerms(detailDescription),quantity:1,selectedVariant:detailTitle,detailTitle,detailDescription,purchaseTermsText:detailDescription,detailImages:['https://images.example.org/'+index+'.jpg'],
  checkedAt,target:{...target},costVerification:XIANYU_COST_VERIFICATION,identity:{accepted:true},primaryImageScore:1}));
 const selected=samples.reduce((best,s)=>!best||s.price<best.price?s:best,null);
 return {...item,averageCNY:selected.price,xianyu:{status:'ok',averageCNY:selected.price,verification:XIANYU_VERIFICATION,costVerification:XIANYU_COST_VERIFICATION,
  target,checkedAt,reviewedAt:checkedAt,reviewVersion:XIANYU_VERIFICATION,samples,selectedQuote:xianyuQuoteSelection(selected)}};
}
