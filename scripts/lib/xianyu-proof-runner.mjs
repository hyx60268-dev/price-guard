// A removed source listing must not abort diagnostics for all remaining items.
export async function runXianyuProof({items,fetchOwn,verify,persist,limit=3,log=console.log}) {
  const summary={selected:items.length,tested:0,accepted:0,sourceUnavailable:0};
  for(const item of items){
    if(summary.tested>=limit)break;
    let own;
    try{own=await fetchOwn(item)}catch(error){
      summary.sourceUnavailable++;log('[PROOF SOURCE UNAVAILABLE]',item.id,String(error));continue;
    }
    if(!own.detail?.description?.trim()){summary.sourceUnavailable++;log('[PROOF SOURCE UNAVAILABLE]',item.id,'missing description');continue}
    summary.tested++;log('[PROOF ITEM]',item.id,item.xianyuQuery);
    const result=await verify({...item,description:own.detail.description,yahoo:{ownDescription:own.detail.description,ownImages:(own.detail.images||[]).map(image=>typeof image==='string'?image:image.url).filter(Boolean)}});
    await persist(result);
    log('[PROOF RESULT]',JSON.stringify({id:item.id,status:result.status,accessibleDetailCount:result.accessibleDetailCount,cardCount:result.cardCount,preliminaryCount:result.preliminaryCount,verifiedCount:result.verifiedCount,sellerCount:result.sellerCount,averageCNY:result.averageCNY,rejected:result.rejected}));
    if(result.status==='ok'&&Number.isFinite(result.averageCNY)&&result.sellerCount>=2)summary.accepted++;
    if(['blocked','login_required'].includes(result.status)){log('[PROOF BLOCKED]',result.diagnostic||result.status);break}
  }
  return summary;
}
