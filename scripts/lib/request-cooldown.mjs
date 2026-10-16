// Keep long server deadlines intact while staying within setTimeout's signed
// 32-bit delay range. Recheck after every wake: another request may extend it.
const MAX_TIMER_MS=2147483647;

export class RequestDeferredError extends Error {
  constructor(reason,retryAt=0){
    super(reason);this.name='RequestDeferredError';this.code='request_deferred';this.reason=reason;
    this.retryAt=retryAt===Infinity?'indefinite':retryAt;
  }
}
export const isRequestDeferred=error=>error?.code==='request_deferred';
const timerWait=(ms,{signal}={})=>new Promise(resolve=>{
  const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve()};
  const timer=setTimeout(finish,ms);signal?.addEventListener('abort',finish,{once:true});
});

export function createRequestCooldown({intervalMs=()=>0,now=()=>Date.now(),wait=timerWait}={}){
  let tail=Promise.resolve(),nextRequestAt=0,wakeWait=null,cooldownRevision=0;
  let turns=0,waitMs=0,cooldownExtensions=0,waitingSince=null;
  const guard=deadline=>{
    if(now()>=deadline)throw new RequestDeferredError('request_deadline',nextRequestAt);
    if(nextRequestAt>=deadline)throw new RequestDeferredError('request_cooldown_deadline',nextRequestAt);
  };
  return {
    turn({deadline=Infinity}={}){
      // Reject an inadmissible hold before joining the queue. Recheck both at
      // admission and after every wake: concurrent 429s can extend the hold.
      // Infinity is a valid server hold, but not a finite caller deadline.
      const check=()=>{if(Number.isFinite(deadline))guard(deadline)};
      try{check()}catch(error){return Promise.reject(error)}
      let expired=false,timer;
      const turn=tail.then(async()=>{
        if(expired)throw new RequestDeferredError('request_deadline',nextRequestAt);
        check();let delay;
        while((delay=nextRequestAt-now())>0){
          const controller=new AbortController();wakeWait=()=>controller.abort();
          waitingSince=now();
          try{await wait(Math.min(MAX_TIMER_MS,delay,deadline-now()),{signal:controller.signal})}
          finally{waitMs+=Math.max(0,now()-waitingSince);waitingSince=null;wakeWait=null}
          check();
        }
        check();nextRequestAt=Math.max(nextRequestAt,now()+intervalMs());turns++;return cooldownRevision;
      });
      tail=turn.catch(()=>{});
      if(!Number.isFinite(deadline))return turn;
      // A short-lived caller must also exit while queued behind a caller with
      // a longer budget. Its queued closure will never admit a later request.
      const expiry=new Promise((_,reject)=>{
        const expire=()=>{const remaining=deadline-now();if(remaining>0){timer=setTimeout(expire,Math.min(MAX_TIMER_MS,remaining));return}expired=true;reject(new RequestDeferredError('request_deadline',nextRequestAt))};
        timer=setTimeout(expire,Math.min(MAX_TIMER_MS,Math.max(0,deadline-now())));
      });
      return Promise.race([turn,expiry]).finally(()=>clearTimeout(timer));
    },
    // Promise resolution is not the network start: a concurrent response can
    // extend the hold between admission and the caller's next microtask.
    isCurrent(admission){return admission===cooldownRevision},
    deferUntil(deadline){
      // Even a hold shorter than the next spacing slot invalidates a ticket
      // that has been admitted but has not actually started its request yet.
      if(deadline>now())cooldownRevision++;
      if(deadline>nextRequestAt){nextRequestAt=deadline;cooldownExtensions++;wakeWait?.()}
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
