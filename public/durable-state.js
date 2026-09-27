const time=record=>Date.parse(record?.updatedAt||'')||0;
export function mergeAccounts(base=[],incoming=[]){
  const output=new Map();
  for(const record of [...base,...incoming]){
    if(!record?.id||!record.profileUrl)continue;
    const current=output.get(record.id);
    if(!current||time(record)>time(current)||time(record)===time(current)&&record.enabled===false)output.set(record.id,{...current,...record});
  }
  return [...output.values()];
}
export const normalizeCostTitle=value=>String(value||'').normalize('NFKC').toLowerCase()
  .replace(/中国限定|海外限定|日本未発売|日本非売品|正規品|新品|未使用|未開封|公式|送料無料|匿名配送/gi,'')
  .replace(/[\s·・,:：，。!！?？【】\[\]()（）<>《》“”"'‘’\-_/／+＋×]/g,'');

export function resolveCostRecord(costs={},item={},aliases={},inventory=[]){
  const account=item.accountId||'default',ids=new Set([item.id]);
  let id=item.id;
  while(id){const old=aliases[`${account}:${id}`]||(id===item.id?item.relistedFrom:null);if(!old||ids.has(old))break;ids.add(old);id=old}
  const entries=Object.entries(costs).filter(([key,record])=>record&&(record.accountId===account||!record.accountId&&key.startsWith(`${account}:`)));
  const newest=records=>records.reduce((best,next)=>!best||time(next)>time(best)||time(next)===time(best)&&next.deleted?next:best,null);
  const direct=entries.filter(([key,record])=>ids.has(record.itemId)||[...ids].some(id=>key===`${account}:${id}`||key===`${account}:item:${id}`)).map(([,record])=>record);
  if(direct.length)return newest(direct);
  const title=normalizeCostTitle(item.title);
  if(!title)return null;
  if(inventory.filter(other=>other.accountId===account&&normalizeCostTitle(other.title)===title).length>1)return null;
  const matches=entries.filter(([key,record])=>{
    // A general search query must never bind different product variants.
    if(record.title)return normalizeCostTitle(record.title)===title;
    return key===`${account}:title:${title}`||(record.identityKeys||[]).includes(`${account}:title:${title}`);
  }).map(([,record])=>record);
  if(new Set(matches.map(record=>record.itemId).filter(Boolean)).size>1)return null;
  return newest(matches);
}
