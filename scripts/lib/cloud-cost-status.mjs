import { XIANYU_VERIFICATION } from './xianyu-evidence.mjs';
import { chooseProcurementReference, verifiedXianyuReference, verifiedPublicProcurementCache, hasCompletedPublicProcurementReview } from './procurement-reference.mjs';

// Publication, a loaded login file, and search cards are not cost acceptance.
// Count only a fresh reference backed by the current detail-evidence contract.
function xianyuCloudCostStatus(result = {}, now = Date.now()) {
  const hours = Number(result.settings?.xianyuFreshHours) || 168;
  const verified=(result.items||[]).filter(item=>verifiedXianyuReference(item,{now,xianyuFreshHours:hours}));
  const statuses = {}, reasons = {};
  let attempted = 0, newlyVerified = 0;
  for (const account of result.accounts || []) {
    const scan = account.scanStats || {};
    attempted += scan.xianyuScanned || 0;
    newlyVerified += scan.xianyuVerifiedNew || 0;
    for (const [key, count] of Object.entries(scan.xianyuStatuses || {})) statuses[key] = (statuses[key] || 0) + count;
    for (const [key, count] of Object.entries(scan.xianyuRejectionReasons || {})) reasons[key] = (reasons[key] || 0) + count;
  }
  const inventory = result.items || [];
  const reviewed = inventory.filter(item => {
    const cost=item.xianyu||{},time=Date.parse(cost.reviewedAt||'');
    return cost.reviewVersion===XIANYU_VERIFICATION&&Number.isFinite(time)&&time<=now+300000&&now-time<hours*3600000;
  }).length;
  const profilesComplete=(result.accounts||[]).every(account=>account.profileStatus==='live');
  const coverage={total:inventory.length,reviewed,remaining:inventory.length-reviewed,complete:inventory.length>0&&reviewed===inventory.length&&profilesComplete};
  const inaccessible=Boolean(statuses.detail_inaccessible||statuses.error);
  const access=result.login?.xianyuAccess;
  const cooling=access?.allowed===false;
  const blocked = Boolean(statuses.blocked);
  const loginRequired = Boolean(statuses.login_required || result.login?.xianyuAuthExpired || result.login?.xianyuRequired && !blocked);
  const status = blocked ? 'blocked' : cooling ? 'access_cooldown' : loginRequired ? 'login_required' :
    inaccessible ? 'detail_inaccessible' : verified.length ? (coverage.complete?'verified':'partial') : attempted ? 'no_verified_cost' : 'not_verified';
  return { execution: 'cloud', status, accepted: status === 'verified',
    attempted, newlyVerified, verifiedReferences: verified.length, coverage, statuses, reasons,
    access:access?{reason:access.reason,retryAt:access.retryAt,allowed:access.allowed}:undefined,
    message: {
      blocked: '闲鱼详情安全验证受阻，云端自动成本未通过验收',
      access_cooldown: '闲鱼访问受阻后正在冷却，自动成本尚未恢复；不会重复请求验证页面',
      login_required: '云端登录状态不能访问闲鱼详情，自动成本未通过验收',
      detail_inaccessible: '闲鱼目标详情读取失败，本轮未完成成本核验',
      partial: '已有自动参考，但全量商品尚未完成核验',
      verified: '已取得有详情实价和独立卖家证据的自动参考',
      no_verified_cost: '本轮已检查，但未取得合格的自动成本',
      not_verified: '尚无已核验的云端自动成本'
    }[status] };
}

// Keep access failures attached to their provider. An unavailable Xianyu session
// must not suppress independently verified procurement details from other stores.
export function cloudCostStatus(result={},now=Date.now()){
 const xianyu=xianyuCloudCostStatus(result,now),inventory=result.items||[];
 const verified=inventory.filter(item=>verifiedPublicProcurementCache(item,{now}));
 const reviewed=inventory.filter(item=>hasCompletedPublicProcurementReview(item,{now})).length;
 const profilesComplete=(result.accounts||[]).every(account=>account.profileStatus==='live');
 const coverage={total:inventory.length,reviewed,remaining:inventory.length-reviewed,complete:inventory.length>0&&reviewed===inventory.length&&profilesComplete};
 const statuses={},reasons={};let attempted=0,newlyVerified=0;
 for(const account of result.accounts||[]){
  const scan=account.scanStats||{};
  attempted+=Number(scan.procurementScanned)||0;newlyVerified+=Number(scan.procurementVerifiedNew)||0;
  for(const [key,count] of Object.entries(scan.procurementStatuses||{}))statuses[key]=(statuses[key]||0)+(Number(count)||0);
  for(const [key,count] of Object.entries(scan.procurementRejectedReasons||{}))reasons[key]=(reasons[key]||0)+(Number(count)||0);
 }
 const failed=Boolean(statuses.unavailable||statuses.error||statuses.blocked||statuses.login_required);
 const publicStatus=failed?'source_failed':verified.length?(coverage.complete?'verified':'partial'):attempted?'no_verified_cost':'not_verified';
 const publicSource={execution:'cloud',status:publicStatus,accepted:publicStatus==='verified',attempted,newlyVerified,
  verifiedReferences:verified.length,coverage,statuses,reasons,
  message:failed?'国内采购渠道本轮访问未完成':verified.length?'已取得国内采购渠道同款、运费与独立卖家证据':attempted?'已检查国内采购渠道，尚无合格参考':'国内采购渠道尚无已核验参考'};
 const sources={xianyu,public_cn:publicSource};
 if(!verified.length){
  // Source evidence can be sound while a stale/malformed published amount is
  // different. Overall acceptance also checks the amount the user would use.
  const displayedReferences=inventory.filter(item=>{
   const reference=verifiedXianyuReference(item,{now,xianyuFreshHours:Number(result.settings?.xianyuFreshHours)||168});
   return reference&&Number.isFinite(item.averageCNY)&&Math.abs(reference.averageCNY-item.averageCNY)<.01;
  }).length;
  const mismatch=xianyu.verifiedReferences>0&&!displayedReferences;
  return {...xianyu,status:mismatch&&['verified','partial'].includes(xianyu.status)?'no_verified_cost':xianyu.status,
   accepted:xianyu.accepted&&displayedReferences>0,verifiedReferences:displayedReferences,
   attempted:xianyu.attempted+attempted,newlyVerified:xianyu.newlyVerified+newlyVerified,sources,
   message:mismatch?'展示金额与核验证据不一致，自动采购参考未通过验收':xianyu.message};
 }
 const hours=Number(result.settings?.xianyuFreshHours)||168;
 const combinedReviewed=inventory.filter(item=>{
  const cost=item.xianyu||{},time=Date.parse(cost.reviewedAt||'');
  const xianyuReviewed=cost.reviewVersion===XIANYU_VERIFICATION&&Number.isFinite(time)&&time<=now+300000&&now-time<hours*3600000;
  return xianyuReviewed||hasCompletedPublicProcurementReview(item,{now});
 }).length;
 const combinedCoverage={total:inventory.length,reviewed:combinedReviewed,remaining:inventory.length-combinedReviewed,
  complete:inventory.length>0&&combinedReviewed===inventory.length&&profilesComplete};
 const references=inventory.filter(item=>{
  const selected=chooseProcurementReference(item,{now,xianyuFreshHours:hours});
  return selected&&Number.isFinite(item.averageCNY)&&Math.abs(selected.averageCNY-item.averageCNY)<.01;
 }).length;
 // A complete, independently accepted Xianyu path is sufficient even when
 // another provider failed. Keep that provider's failure in sources.public_cn.
 const coveredByAcceptedSource=xianyu.accepted||!failed;
 const status=references?(combinedCoverage.complete&&coveredByAcceptedSource?'verified':'partial'):'no_verified_cost';
 return {...xianyu,status,accepted:status==='verified',attempted:xianyu.attempted+attempted,
  newlyVerified:xianyu.newlyVerified+newlyVerified,verifiedReferences:references,coverage:combinedCoverage,sources,
  message:status==='verified'?'已取得可核验的自动采购参考；各渠道访问状态单独显示':
   status==='partial'?'已有可用采购参考，其他商品或渠道尚未完成核验':'采集参考与商品展示金额不一致，自动成本未通过验收'};
}
