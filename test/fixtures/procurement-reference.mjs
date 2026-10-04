import { PUBLIC_PROCUREMENT_VERIFICATION, procurementQuoteSelection } from '../../scripts/lib/procurement-evidence.mjs';
export function publicProcurementItem(now=Date.parse('2026-10-01T17:00:00Z')){
 const checkedAt=new Date(now).toISOString();
 const target={accountId:'shop-a',id:'z123456789',title:'Anker AeroClip 2 张凌赫 红色礼盒 1套',image:'https://inventory.example/anker-red.jpg',description:'红色整套礼盒 1 套，含 AeroClip 2 耳机。',condition:'新品、未使用'};
 const samples=[90,100].map((unitCNY,i)=>({source:'jd',id:String(100000000001+i),skuId:String(100000000001+i),
  url:'https://item.jd.com/'+(100000000001+i)+'.html',canonicalUrl:'https://item.jd.com/'+(100000000001+i)+'.html',
  sellerKey:'jd:shop'+i,sellerName:'测试供货商'+i,sellerIdentityKey:'测试供货商'+i,
  selectedVariant:'红色整套礼盒',unitCNY,shippingCNY:10,landedCNY:unitCNY+10,price:unitCNY+10,currency:'CNY',inStock:true,skuVerified:true,shippingKnown:true,
  priceSource:'target_detail',detailTitle:target.title,detailDescription:'红色整套礼盒 1 套，含 AeroClip 2 耳机。',
  detailImages:['https://pictures.example/shop'+i+'/red-box.jpg'],checkedAt,verification:PUBLIC_PROCUREMENT_VERIFICATION,
  identity:{primaryImageScore:.99,titleScore:.8,accepted:true},target:{...target}}));
 return {...target,sourceDetail:{description:target.description,condition:target.condition},averageCNY:100,referenceProvider:'public_cn',procurementSource:{status:'ok',averageCNY:100,
  verification:PUBLIC_PROCUREMENT_VERIFICATION,checkedAt,reviewedAt:checkedAt,reviewVersion:1,target:{...target},samples,selectedQuote:procurementQuoteSelection(samples[0]),selectionMode:'compared_seller_offer'}};
}
