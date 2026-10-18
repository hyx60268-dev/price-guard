import {distinctiveCoverage,productFamily} from './rules.mjs';

const titleGates=Object.freeze(['own_family_missing','candidate_family_missing','family_different',
 'coverage_below_078','matched_length_below_6','matched_count_below_2','token_count_below_2']);
function titleEvidence(ownTitle,title){
 const family=productFamily(ownTitle),candidateFamily=productFamily(title),anchors=distinctiveCoverage(ownTitle,title);
 const failed=[!family,!candidateFamily,Boolean(family&&candidateFamily&&family!==candidateFamily),
  anchors.score<.78,anchors.matchedLength<6,anchors.matchedCount<2,anchors.tokenCount<2];
 return {family,candidateFamily,anchors,failed: titleGates.filter((_,index)=>failed[index]),related:!failed.some(Boolean)};
}

// Offline ordering only. This does not accept a quote, infer stock, remove a
// candidate, or spend a request. The caller keeps explicit conflicts separate.
export function planYahooCardDetailOrder({ownTitle='',ownPriceJPY,rows=[]}={}){
 if(!Array.isArray(rows)||rows.length>200)throw Error('invalid_card_plan');
 const seen=new Set();
 const planned=rows.map((row,index)=>{
  if(!row||typeof row.id!=='string'||!row.id||seen.has(row.id))throw Error('invalid_card_plan');
  seen.add(row.id);
  const title=typeof row.title==='string'?row.title:'',related=titleEvidence(ownTitle,title).related;
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

// Anonymous explanation of the unchanged ordering gates. No token strings,
// titles, source IDs, URLs, prices or acceptance result leave this projection.
export function summarizeYahooCardTitleGates({ownTitle='',ownPriceJPY,rows=[]}={}){
 if(typeof ownTitle!=='string'||!Array.isArray(rows)||rows.length>200)throw Error('invalid_card_gate_summary');
 const add=(hist,key)=>{hist[key]=(hist[key]||0)+1;};
 const summarize=values=>{
  const out={rows:values.length,related:0,unknown:0,firstFailedGate:{},failedGateCounts:Object.fromEntries(titleGates.map(key=>[key,0])),
   familyRelation:{own_missing:0,candidate_missing:0,different:0,same:0},scoreBuckets:{},matchedCountBuckets:{},matchedLengthBuckets:{},tokenCountBuckets:{},
   longSingleAnchorBlocked:0,anonymousFeatureCombinations:[]};
  const combinations=new Map();
  for(const row of values){
   const {family,candidateFamily,anchors,failed,related}=row.evidence;
   const relation=!family?'own_missing':!candidateFamily?'candidate_missing':family===candidateFamily?'same':'different';
   out.familyRelation[relation]++;out[related?'related':'unknown']++;
   add(out.firstFailedGate,failed[0]||'all_gates_passed');for(const gate of failed)out.failedGateCounts[gate]++;
   add(out.scoreBuckets,anchors.score===0?'zero':anchors.score<.5?'under_050':anchors.score<.78?'050_to_078':anchors.score<.9?'078_to_090':anchors.score<1?'090_to_100':'one');
   for(const [field,hist] of [['matchedCount','matchedCountBuckets'],['tokenCount','tokenCountBuckets']])add(out[hist],anchors[field]===0?'zero':anchors[field]===1?'one':anchors[field]===2?'two':'three_or_more');
   add(out.matchedLengthBuckets,anchors.matchedLength===0?'zero':anchors.matchedLength<6?'one_to_five':anchors.matchedLength<12?'six_to_eleven':'twelve_or_more');
   if(relation==='same'&&anchors.score>=.78&&anchors.matchedLength>=6&&anchors.matchedCount===1&&anchors.tokenCount===1)out.longSingleAnchorBlocked++;
   const feature={familyRelation:relation,score:Number(anchors.score.toFixed(4)),matchedCount:anchors.matchedCount,
    matchedLength:anchors.matchedLength,tokenCount:anchors.tokenCount,failedGates:failed};
   const key=JSON.stringify(feature);if(!combinations.has(key))combinations.set(key,{...feature,rows:0});combinations.get(key).rows++;
  }
  // Group identical numeric features; no stable row ordinal or listing ID.
  out.anonymousFeatureCombinations=[...combinations.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return out;
 };
 const values=rows.map(row=>{
  if(!row||typeof row.title!=='string')throw Error('invalid_card_gate_summary');
  const known=Number.isFinite(row.priceJPY)&&row.priceJPY>0&&Number.isFinite(ownPriceJPY)&&ownPriceJPY>0;
  const ratio=known?row.priceJPY/ownPriceJPY:null;
  return {evidence:titleEvidence(ownTitle,row.title),ratio};
 });
 const all=summarize(values),nearPrice=summarize(values.filter(row=>row.ratio!==null&&row.ratio>=.75&&row.ratio<1));
 // Numeric combinations are needed only for the requested small near-price
// slice; other scopes use aggregate buckets to keep output bounded and private.
 delete all.anonymousFeatureCombinations;
 return {version:1,scope:'unchanged_order_gate_diagnosis',canRecommend:false,all,nearPrice};
}
