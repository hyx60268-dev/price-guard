import { pricingDecision, PRICING_RULES_VERSION, PRICING_PLATFORMS, PLATFORM_LABELS } from './pricing-policy.js';

const labels={queued:'排队扫描',stale:'数据过期',error:'采集失败',insufficient:'信息不足',ready:'核验完成'};
export function pricingStatus(item={},options={}){
 const decision=pricingDecision(item,options),now=options.now??Date.now();
 const platforms=PRICING_PLATFORMS.map(platform=>{
  const source=item[platform]||{},stamp=Date.parse(source.checkedAt||'');
  let state='ready',reason='已取得有效比价结果';
  if(!decision.coverage[platform]){
   if(source.status==='error'||source.cacheReason==='request_error'){
    state='error';reason='本次采集失败，等待云端重试';
   }else if(!source.rulesVersion||source.rulesVersion!==PRICING_RULES_VERSION){
    state='queued';reason='等待按当前规则扫描';
   }else if(!Number.isFinite(stamp)||['not_requested','deferred_limit','pending'].includes(source.status)){
    state='queued';reason='等待云端批次扫描';
   }else if(stamp>now+60000||now-stamp>(options.maxAgeHours??6)*3600000){
    state='stale';reason='结果已失效，等待重新扫描';
   }else{
    state='insufficient';
    const reasons=(source.rejected||[]).map(row=>row.reason);
    reason=reasons.includes('shipping_unconfirmed')?'运费未确认':reasons.includes('detail_error')?'部分商品详情读取失败':source.searchComplete===false?'搜索结果尚未完整读取':'同款、在售状态或低价候选尚未确认';
   }
  }
  return {platform,name:PLATFORM_LABELS[platform],state,label:labels[state],reason};
 });
 // Show the actionable failure first; details retain every platform's reason.
 const state=['error','insufficient','stale','queued'].find(value=>platforms.some(p=>p.state===value))||'ready';
 return {state,label:labels[state],platforms,complete:decision.complete,decision};
}

export function pricingSummary(items=[],options={}){
 const counts={ready:0,queued:0,stale:0,error:0,insufficient:0};let actionable=0;
 for(const item of items){const status=pricingStatus(item,options);counts[status.state]++;if(status.complete&&status.decision.priceSignal!=='hold')actionable++;}
 const total=items.length,remaining=total-counts.ready;
 return {total,...counts,remaining,actionable,
  label:!actionable&&remaining?(counts.queued+counts.stale?'比价更新中':'比价未完成'):'建议调价',
  value:!actionable&&remaining?'—':actionable,
  note:remaining?`已核验 ${counts.ready}/${total} 件，另有 ${remaining} 件未完成；当前建议仅覆盖已核验商品。`:`已核验 ${counts.ready}/${total} 件${total&&!actionable?'，暂无需要调价的商品。':'。'}`};
}
