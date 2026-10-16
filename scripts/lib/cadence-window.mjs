import {VALIDATION_SLOTS,SCAN_INTERVAL_MS} from './scan-admission.mjs';
export function cadenceActivation({event,config={},message='',attempt='1'}={}){
 if(attempt!=='1')throw Error('Finite validation cannot be restarted by workflow rerun');
 if(event==='workflow_dispatch')return true;
 return event==='push'&&config.enabled===true&&config.slots===VALIDATION_SLOTS&&/^[a-z0-9-]{8,64}$/.test(config.requestId||'')&&message.includes(`[price-guard-cadence:${config.requestId}]`);
}
export function cadenceSlotReport({admitted=false,reason='',slot,status,sha}={}){
 if(!admitted)return {slot,admitted:false,reason};
 const cycle=status?.cycleCoverage,start=Date.parse(cycle?.startedAt),finish=Date.parse(cycle?.finishedAt);
 if(status?.codeSha!==sha||!Number.isFinite(start)||!Number.isFinite(finish)||finish<start)throw Error('Missing current source-cycle observation');
 return {slot,admitted:true,codeSha:sha,startedAt:cycle.startedAt,finishedAt:cycle.finishedAt,inventoryComplete:cycle.inventoryComplete,total:cycle.total,priceComplete:cycle.priceComplete,costVerified:cycle.costVerified,completeItems:cycle.completeItems};
}
export function cadenceWindowReport(needs={}){
 const slots=Array.from({length:VALIDATION_SLOTS},(_,index)=>{
  const row=needs[`slot-${index}`];let observation=null;
  try{observation=JSON.parse(row?.outputs?.slot_report||'null')}catch{}
  return {index,result:row?.result||'missing',costExit:row?.outputs?.cost_exit??null,coverageExit:row?.outputs?.coverage_exit??null,observation};
 });
 const completed=slots.filter(row=>row.result==='success'&&row.observation?.admitted);
 const starts=completed.map(row=>Date.parse(row.observation.startedAt)),ends=completed.map(row=>Date.parse(row.observation.finishedAt));
 const gaps=starts.slice(1).map((start,index)=>start-starts[index]);
 const completionGaps=ends.slice(1).map((end,index)=>end-ends[index]);
 const reasons=[];
 if(completed.length!==VALIDATION_SLOTS)reasons.push('not_all_slots_observed');
 if(slots.some(row=>['failure','cancelled','missing'].includes(row.result)))reasons.push('operational_slot_failure');
 if(starts.some((start,index)=>!Number.isFinite(start)||!Number.isFinite(ends[index])||ends[index]<start)||gaps.some(gap=>gap<=0||gap>SCAN_INTERVAL_MS))reasons.push('observed_start_cadence_not_20_minutes');
 if(completionGaps.some(gap=>gap<=0||gap>SCAN_INTERVAL_MS))reasons.push('observed_completion_cadence_not_20_minutes');
 if(ends.some((end,index)=>end-starts[index]>SCAN_INTERVAL_MS))reasons.push('cycle_duration_exceeds_20_minutes');
 const fullCoverage=observation=>observation.inventoryComplete===true&&Number.isSafeInteger(observation.total)&&observation.total>0&&['priceComplete','costVerified','completeItems'].every(key=>Number.isSafeInteger(observation[key])&&observation[key]===observation.total);
 if(completed.some(row=>!fullCoverage(row.observation)))reasons.push('full_inventory_price_cost_incomplete');
 if(completed.some(row=>row.costExit!=='0'||row.coverageExit!=='0'))reasons.push('slot_product_acceptance_failed_or_missing');
 return {accepted:reasons.length===0,reasons,plannedSlots:VALIDATION_SLOTS,completedSlots:completed.length,startGapsSeconds:gaps.map(value=>value/1000),completionGapsSeconds:completionGaps.map(value=>value/1000),slots};
}
