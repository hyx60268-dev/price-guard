// Media work shares the fixed graph budget. Cached fingerprints retain their
// original image observation; neither use nor cancellation renews that clock.
export function graphImageReader(read,context={}, {now=Date.now}={}){
  const active=()=>!context.signal?.aborted&&(!Number.isFinite(context.deadlineAt)||now()<context.deadlineAt);
  return async url=>{
    if(!url||!active())return null;
    const result=await read(url,{signal:context.signal,deadlineAt:context.deadlineAt,now});
    return active()?result:null;
  };
}
