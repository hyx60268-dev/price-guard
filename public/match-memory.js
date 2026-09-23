// Shared browser/server implementation. Corrections only reject evidence; they
// never force a match or bypass quantity, variant, availability or price checks.
export const correctionKey=record=>`${record.accountId}:${record.itemId}:${record.platform}:${record.candidateId}`;
export const candidateId=(platform,row)=>String(row?.id||String(row?.url||'').match(platform==='xianyu'?/[?&]id=(\d+)/:/\/item\/([^/?#]+)/)?.[1]||'');
export function mergeMatchCorrections(base={},incoming={}){
  const output={...base};
  for(const record of Object.values(incoming||{})){
    if(!record||!record.accountId||!record.itemId||!record.candidateId||!['yahoo','xianyu'].includes(record.platform))continue;
    const time=Date.parse(record.updatedAt||'');if(!Number.isFinite(time))continue;
    const key=correctionKey(record),old=Date.parse(output[key]?.updatedAt||'');
    if(!Number.isFinite(old)||time>old)output[key]={...record};
  }
  return output;
}
export function rejectedByMemory(records,item,platform,candidate){
  const id=candidateId(platform,candidate);
  return Object.values(records||{}).find(record=>!record.deleted&&record.accountId===item.accountId&&record.platform===platform&&record.candidateId===id&&
    (record.itemId===item.id||record.itemId===item.relistedFrom&&record.ownTitle===item.title&&record.ownImage===item.image));
}
export function invalidateCorrectedMatches(item,records={}){
  let next={...item};
  if((item.yahoo?.candidates||[]).some(row=>rejectedByMemory(records,item,'yahoo',row))){
    next={...next,lowestPrice:item.ownPrice,lowestUrl:item.ownUrl||item.url,recommendedPrice:item.ownPrice,priceSignal:'hold',difference:0,marketMedianPrice:null,marketSampleCount:0,
      yahoo:{...item.yahoo,rulesVersion:0,status:'incomplete',underpriced:false,lowestPrice:item.ownPrice,lowestUrl:item.ownUrl||item.url,recommendedPrice:item.ownPrice,
        marketMedianPrice:null,marketMinPrice:null,marketMaxPrice:null,marketSampleCount:0,matchLabel:'已按纠错停用旧建议，等待重新核验',
        candidates:item.yahoo.candidates.filter(row=>!rejectedByMemory(records,item,'yahoo',row))}};
  }
  if((item.xianyu?.samples||[]).some(row=>rejectedByMemory(records,item,'xianyu',row))){
    next={...next,averageCNY:null,costSource:'missing',xianyu:{...item.xianyu,status:'correction_pending',verification:null,averageCNY:null,samples:[]}};
  }
  return next;
}
