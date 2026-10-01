// A worker slot is stable so browser-backed callers can keep an isolated page per slot.
export async function mapLimit(values,limit,worker){
 const count=Math.max(1,Math.min(values.length||1,Math.floor(Number(limit)||1)));
 const output=new Array(values.length);let cursor=0;
 const settled=await Promise.allSettled(Array.from({length:count},async(_,slot)=>{
  while(true){const index=cursor++;if(index>=values.length)return;output[index]=await worker(values[index],index,slot)}
 }));
 const failed=settled.find(result=>result.status==='rejected');if(failed)throw failed.reason;
 return output;
}
