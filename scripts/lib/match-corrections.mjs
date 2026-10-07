import { candidateId, correctionKey, mergeMatchCorrections } from '../../public/match-memory.js';
import { canonicalProcurementUrl } from './procurement-evidence.mjs';

export function acceptMatchCorrections(base={},incoming={},items=[],allowedAccountIds=null,now=Date.now()) {
  if(!incoming||typeof incoming!=='object'||Array.isArray(incoming)||Object.keys(incoming).length>3000)throw new Error('纠错记录格式或数量异常');
  const accepted={};
  for(const raw of Object.values(incoming)){
    if(!raw||!['yahoo','rakuma','mercari','xianyu','procurement'].includes(raw.platform))throw new Error('纠错平台无效');
    if(allowedAccountIds&&!allowedAccountIds.has(raw.accountId))throw new Error('无权修改其他店铺纠错');
    const item=items.find(item=>item.accountId===raw.accountId&&item.id===raw.itemId);
    const key=correctionKey(raw),existing=base[key];
    if(!item&&!existing)throw new Error('纠错商品不存在');
    const samples=raw.platform==='yahoo'?item?.yahoo?.candidates:raw.platform==='rakuma'?item?.rakuma?.candidates:raw.platform==='mercari'?item?.mercari?.candidates:
      raw.platform==='procurement'?[...(item?.procurementSource?.samples||[]),...(item?.procurementSource?.purchasableOffers||[])]:item?.xianyu?.samples;
    const sample=(samples||[]).find(row=>candidateId(raw.platform,row)===String(raw.candidateId)||raw.platform==='procurement'&&
      [row.id,row.skuId,canonicalProcurementUrl(row.canonicalUrl||row.url)].filter(Boolean).map(String).includes(String(raw.candidateId)));
    if(!existing&&!sample)throw new Error('只能纠正已展示的匹配样本');
    const time=Date.parse(raw.updatedAt||'');
    if(!Number.isFinite(time)||time>now+300000)throw new Error('纠错时间无效');
    // New procurement corrections use the observed canonical detail URL, never
    // a caller-provided URL. Existing IDs remain undoable for old clients.
    const id=existing?String(existing.candidateId):candidateId(raw.platform,sample);
    const record={accountId:raw.accountId,itemId:raw.itemId,platform:raw.platform,candidateId:id,
      ownTitle:existing?.ownTitle||item.title,ownImage:existing?.ownImage||item.image||'',
      reason:String(raw.reason||'not_same_product').slice(0,200),deleted:raw.deleted===true,updatedAt:new Date(time).toISOString()};
    if(raw.platform==='procurement'){
      const url=canonicalProcurementUrl(sample?.canonicalUrl||sample?.url||existing?.candidateUrl||existing?.candidateId);
      if(url)record.candidateUrl=url;
    }
    accepted[correctionKey(record)]=record;
  }
  return mergeMatchCorrections(base,accepted);
}
