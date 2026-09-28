export function syncHandoff({repo,username,body,date=new Date(),limit=7000}){
 const title=`[Price Guard Sync:${username}] ${date.toLocaleString('zh-CN')}`;
 const empty=`https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}`;
 const prefilled=`${empty}&body=${encodeURIComponent(body)}`;
 return {body,url:prefilled.length<limit?prefilled:empty,prefilled:prefilled.length<limit};
}
export async function copySyncBody(body,clipboard){
 if(!clipboard?.writeText)return false;
 try{await clipboard.writeText(body);return true}catch{return false}
}
