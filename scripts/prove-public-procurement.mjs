import { openContext } from './lib/browser.mjs';
import { readPublicProcurementDetail } from './lib/procurement-sources.mjs';
// Public SKU availability/price read only. This is not two-seller cost acceptance.
const opened=await openContext();let passed=true;
try{
 for(const [colour,title] of [['white','Anker AeroClip 2 张凌赫 ホワイト ギフトボックス'],['red','Anker AeroClip 2 张凌赫 レッド ギフトボックス']]){
  let row;
  try{row=await readPublicProcurementDetail('https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd',{item:{title},context:opened.context,deadline:Date.now()+75000});}
  catch(error){row={status:'error',reason:String(error.message).slice(0,400),diagnostic:error.diagnostic}}
  const quoted=row.status==='quoted'&&row.skuVerified===true&&row.shippingKnown===true&&row.inStock===true&&row.unitCNY>0;
  const valid=colour==='white'?quoted:quoted||row.reason==='out_of_stock';
  console.log('[公开采购来源实测]',JSON.stringify({colour,checkedAt:new Date().toISOString(),status:row.status,reason:row.reason,skuId:row.skuId,selectedVariant:row.selectedVariant,unitCNY:row.unitCNY,shippingCNY:row.shippingCNY,inStock:row.inStock,diagnostic:row.diagnostic,sourceReadAccepted:valid,automaticCostAccepted:false}));
  passed&&=valid;
 }
}finally{await opened.browser.close()}
if(!passed)process.exitCode=1;
