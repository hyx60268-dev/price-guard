const kinds=['profile','own','search','known','candidate','item_unclassified','other'];
function requestKind(url,purpose){
 let parsed;try{parsed=new URL(url)}catch{return 'other'}
 if(parsed.origin!=='https://paypayfleamarket.yahoo.co.jp')return 'other';
 if(/^\/user\/[^/]+$/.test(parsed.pathname))return 'profile';
 if(parsed.pathname.startsWith('/search/'))return 'search';
 if(/^\/item\/[^/]+$/.test(parsed.pathname))return ['own','known','candidate'].includes(purpose)?purpose:'item_unclassified';
 return 'other';
}

// Counts transport invocations, including denied/failed ones, not gate turns,
// logical callers or in-run cache hits. No URL, item, title or response text is
// retained in the aggregate report. Durations exclude rate-gate waiting.
export function createYahooReadObservations({now=()=>performance.now()}={}){
 const rows=Object.fromEntries(kinds.map(kind=>[kind,{requests:0,responses:0,completed:0,failed:0,decodedBodyBytes:0,durationMs:0}]));
 const statuses={};let unfinished=0,lateResponses=0;
 return {
  begin(url,purpose){
   const row=rows[requestKind(url,purpose)],start=now();row.requests++;unfinished++;let done=false,status=null;
   return {
    response(value){if(status!==null)return;if(Number.isInteger(value)&&value>=100&&value<=599){status=value;row.responses++;if(done)lateResponses++;statuses[value]=(statuses[value]||0)+1}},
    finish({bytes=0,complete=false}={}){if(done)return;done=true;unfinished--;row[complete?'completed':'failed']++;row.decodedBodyBytes+=Number.isSafeInteger(bytes)&&bytes>=0?bytes:0;row.durationMs+=Math.max(0,now()-start)}
   };
  },
  snapshot(){return {version:1,lateResponses,transportRequests:Object.values(rows).reduce((sum,row)=>sum+row.requests,0),unfinished,
   byPurpose:structuredClone(rows),httpStatuses:{...statuses},meaning:'Actual transport starts; durations exclude gate waiting. Bytes are UTF-8 bytes of decoded HTML, not compressed wire bytes. Shared observations do not cause a new transport start. Late headers are counted separately without changing completed evidence. Requests without response headers remain unknown, not proof of no denial.'}}
 };
}
