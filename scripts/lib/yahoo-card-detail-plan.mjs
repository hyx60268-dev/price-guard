import {distinctiveCoverage,productFamily} from './rules.mjs';

// Offline ordering only. This does not accept a quote, infer stock, remove a
// candidate, or spend a request. The caller keeps explicit conflicts separate.
export function planYahooCardDetailOrder({ownTitle='',ownPriceJPY,rows=[]}={}){
 if(!Array.isArray(rows)||rows.length>200)throw Error('invalid_card_plan');
 const seen=new Set(),family=productFamily(ownTitle);
 const planned=rows.map((row,index)=>{
  if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id))throw Error('invalid_card_plan');
  seen.add(row.id);
  const title=typeof row.title==='string'?row.title:'',anchors=distinctiveCoverage(ownTitle,title);
  const related=Boolean(family&&productFamily(title)===family&&anchors.score>=.78&&
   anchors.matchedLength>=6&&anchors.matchedCount>=2&&anchors.tokenCount>=2);
  const priceKnown=Number.isFinite(row.priceJPY)&&row.priceJPY>0&&Number.isFinite(ownPriceJPY)&&ownPriceJPY>0;
  const ratio=priceKnown?row.priceJPY/ownPriceJPY:null;
  const tier=related&&ratio!==null&&ratio>=.75&&ratio<1?'related_near_price':related?'related_other_price':'unknown_identity';
  return {id:row.id,index,tier,priceKnown,priceJPY:priceKnown?row.priceJPY:null};
 });
 const priceOrder=(a,b)=>(a.priceJPY??Infinity)-(b.priceJPY??Infinity)||a.index-b.index;
 const priority={related_near_price:0,related_other_price:1,unknown_identity:2};
 const pending=[...planned].sort((a,b)=>priority[a.tier]-priority[b.tier]||priceOrder(a,b)),ordered=[];
 while(pending.length){
  // One slot out of four explores the lowest remaining uncertain candidate.
  // It is not a permanent exclusion or a claim that nearby prices are identical.
  const explore=ordered.length%4===3;
  const unknown=explore?pending.filter(row=>row.tier==='unknown_identity').sort(priceOrder)[0]:null;
  const selected=unknown||pending[0];pending.splice(pending.indexOf(selected),1);
  ordered.push({id:selected.id,tier:selected.tier,exploration:unknown===selected});
 }
 return {version:1,scope:'offline_order_only',canRecommend:false,allInputRowsRetained:ordered.length===rows.length,
  counts:Object.fromEntries(Object.keys(priority).map(tier=>[tier,planned.filter(row=>row.tier===tier).length])),rows:ordered};
}
