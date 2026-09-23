import { candidateId, correctionKey, mergeMatchCorrections } from '../../public/match-memory.js';

export function acceptMatchCorrections(base={},incoming={},items=[],allowedAccountIds=null,now=Date.now()) {
  if(!incoming||typeof incoming!=='object'||Array.isArray(incoming)||Object.keys(incoming).length>3000)throw new Error('纠错记录格式或数量异常');
  const accepted={};
  for(const raw of Object.values(incoming)){
    if(!raw||!['yahoo','xianyu'].includes(raw.platform))throw new Error('纠错平台无效');
    if(allowedAccountIds&&!allowedAccountIds.has(raw.accountId))throw new Error('无权修改其他店铺纠错');
    const item=items.find(item=>item.accountId===raw.accountId&&item.id===raw.itemId);
    const key=correctionKey(raw),existing=base[key];
    if(!item&&!existing)throw new Error('纠错商品不存在');
    const samples=raw.platform==='yahoo'?item?.yahoo?.candidates:item?.xianyu?.samples;
    if(!existing&&!(samples||[]).some(row=>candidateId(raw.platform,row)===String(raw.candidateId)))throw new Error('只能纠正已展示的匹配样本');
    const time=Date.parse(raw.updatedAt||'');
    if(!Number.isFinite(time)||time>now+300000)throw new Error('纠错时间无效');
    accepted[key]={accountId:raw.accountId,itemId:raw.itemId,platform:raw.platform,candidateId:String(raw.candidateId),
      ownTitle:existing?.ownTitle||item.title,ownImage:existing?.ownImage||item.image||'',
      reason:String(raw.reason||'not_same_product').slice(0,200),deleted:raw.deleted===true,updatedAt:new Date(time).toISOString()};
  }
  return mergeMatchCorrections(base,accepted);
}
