export function merchantNameFromTitle(platform,title=''){
 const decoded=String(title).replace(/&(?:amp|quot|apos|lt|gt|#39);/g,v=>({'&amp;':'&','&quot;':'"','&apos;':"'",'&#39;':"'",'&lt;':'<','&gt;':'>'})[v]);
 const name=platform==='yahoo'?decoded.match(/^(.+?)の出品リスト[｜|]/)?.[1]:platform==='mercari'?decoded.match(/^(.+?)\s*の出品した商品\s*[-－]/)?.[1]:null;
 return name?.trim().slice(0,80)||'';
}
