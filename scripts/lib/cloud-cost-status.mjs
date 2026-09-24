import { XIANYU_VERIFICATION, verifiedCostEvidence } from './xianyu-evidence.mjs';

// Publication, a loaded login file, and search cards are not cost acceptance.
// Count only a fresh reference backed by the current detail-evidence contract.
export function cloudCostStatus(result = {}, now = Date.now()) {
  const hours = Number(result.settings?.xianyuFreshHours) || 168;
  const verified = (result.items || []).filter(item => {
    const cost = item.xianyu || {}, time = Date.parse(cost.checkedAt || '');
    const evidence = verifiedCostEvidence(cost.samples);
    return cost.verification === XIANYU_VERIFICATION && evidence.ready &&
      Number.isFinite(item.averageCNY) && item.averageCNY > 0 &&
      Math.abs(item.averageCNY - evidence.median) < .01 &&
      Number.isFinite(time) && time <= now + 300000 && now - time < hours * 3600000;
  });
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
  const blocked = Boolean(statuses.blocked);
  const loginRequired = Boolean(statuses.login_required || result.login?.xianyuAuthExpired || result.login?.xianyuRequired && !blocked);
  const status = blocked ? 'blocked' : loginRequired ? 'login_required' :
    inaccessible ? 'detail_inaccessible' : verified.length ? (coverage.complete?'verified':'partial') : attempted ? 'no_verified_cost' : 'not_verified';
  return { execution: 'cloud', status, accepted: status === 'verified',
    attempted, newlyVerified, verifiedReferences: verified.length, coverage, statuses, reasons,
    message: {
      blocked: '闲鱼详情安全验证受阻，云端自动成本未通过验收',
      login_required: '云端登录状态不能访问闲鱼详情，自动成本未通过验收',
      detail_inaccessible: '闲鱼目标详情读取失败，本轮未完成成本核验',
      partial: '已有自动参考，但全量商品尚未完成核验',
      verified: '已取得有详情实价和独立卖家证据的自动参考',
      no_verified_cost: '本轮已检查，但未取得合格的自动成本',
      not_verified: '尚无已核验的云端自动成本'
    }[status] };
}
