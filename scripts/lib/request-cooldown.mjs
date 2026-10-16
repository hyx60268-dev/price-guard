// Keep long server deadlines intact while staying within setTimeout's signed
// 32-bit delay range. Recheck after every wake: another request may extend it.
const MAX_TIMER_MS=2147483647;

export function createRequestCooldown({intervalMs=()=>0,now=()=>Date.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let tail=Promise.resolve(),nextRequestAt=0;
  let turns=0,waitMs=0,cooldownExtensions=0,waitingSince=null;
  return {
    turn(){
      const turn=tail.then(async()=>{
        let delay;
        while((delay=nextRequestAt-now())>0){
          waitingSince=now();
          try{await wait(Math.min(MAX_TIMER_MS,delay))}
          finally{waitMs+=Math.max(0,now()-waitingSince);waitingSince=null}
        }
        nextRequestAt=Math.max(nextRequestAt,now()+intervalMs());turns++;
      });
      tail=turn.catch(()=>{});
      return turn;
    },
    deferUntil(deadline){
      if(deadline>nextRequestAt){nextRequestAt=deadline;cooldownExtensions++}
    },
    // Cumulative gate wait can overlap in-flight requests or unrelated work.
    // It is not a scan's wall-clock delay; snapshots contain no request data.
    stats(){return {turns,waitMs:waitMs+(waitingSince===null?0:Math.max(0,now()-waitingSince)),cooldownExtensions,nextRequestAt}}
  };
}

export function retryAfterDeadline(value,now=Date.now()){
  const raw=String(value??'').trim();
  // Keep accepting fractional seconds as before. An overflowing numeric delay
  // becomes an indefinite hold, never an immediate timer or a shortened retry.
  if(/^\d+(?:\.\d+)?$/.test(raw)){
    const seconds=Number(raw);
    return seconds>0?now+seconds*1000:null;
  }
  // HTTP-date supports the current wire format and the two legacy formats.
  const httpDate=/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/;
  const deadline=httpDate.test(raw)?Date.parse(raw.endsWith(' GMT')?raw:raw+' GMT'):NaN;
  return Number.isFinite(deadline)&&deadline>now?deadline:null;
}
