// Operational alert only. Per-offer price validity remains in pricing-policy.js.
export const UPDATE_DELAY_MS=2*60*60*1000;
export function snapshotFreshness(checkedAt,{now=Date.now(),maxAgeMs=UPDATE_DELAY_MS}={}){
 const timestamp=Date.parse(checkedAt||'');
 if(!Number.isFinite(timestamp)||timestamp>now+60_000)return {state:'unknown',timestamp:null,ageMs:null};
 const ageMs=Math.max(0,now-timestamp);
 return {state:ageMs>maxAgeMs?'delayed':'fresh',timestamp,ageMs};
}
export function elapsedLabel(ageMs){
 if(!Number.isFinite(ageMs))return '时间未知';
 const minutes=Math.floor(Math.max(0,ageMs)/60_000);
 if(minutes<60)return `${minutes} 分钟`;
 const hours=Math.floor(minutes/60);
 return hours<24?`${hours} 小时 ${minutes%60} 分钟`:`${Math.floor(hours/24)} 天 ${hours%24} 小时`;
}
