const day=86400000;
const valid=(value,now)=>{const time=Date.parse(value||'');return Number.isFinite(time)&&time<=now?time:null};

export function listingAge(item,previous={},profileStatus='cached',now=Date.now()) {
  // Never inherit a sold/removed listing's age merely because a relisted title matches.
  const same=previous.id===item.id&&previous.accountId===item.accountId;
  const history=same?previous.listingAge||{}:{};
  const priorFirst=valid(history.firstObservedAt,now);
  const firstObservedAt=priorFirst!==null?new Date(priorFirst).toISOString():profileStatus==='live'?new Date(now).toISOString():null;
  const published=(item.yahoo?.ownListingId===item.id?valid(item.yahoo?.ownListedAt,now):null)??valid(history.publishedAt,now);
  const since=published??valid(firstObservedAt,now);
  const active=profileStatus==='live'&&item.itemStatus==='OPEN';
  const ageDays=since===null?null:Math.floor((now-since)/day);
  const eligible=active&&ageDays!==null&&ageDays>=30;
  return {firstObservedAt,publishedAt:published===null?null:new Date(published).toISOString(),
    lastConfirmedAt:active?new Date(now).toISOString():history.lastConfirmedAt||null,
    source:published!==null?'platform_open_date':firstObservedAt?'first_observed':'unknown',days:ageDays,
    eligible,status:!active?'live_status_unconfirmed':since===null?'age_unknown':eligible?'review_removal':'under_30_days',
    message:eligible?`本条商品已在售至少 ${ageDays} 天，建议评估删除或重新整理出品；不会自动下架`:
      !active?'当前在售状态未确认，暂不建议删除':since===null?'上架时间待确认':`本条商品已在售至少 ${ageDays} 天`};
}
