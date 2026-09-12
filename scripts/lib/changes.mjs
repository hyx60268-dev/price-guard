const trackedFields=['ownPrice','lowestPrice','recommendedPrice','averageCNY','costJPY','afterProfitJPY','advice'];

const same=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?Math.round(a*100)===Math.round(b*100):a===b;

export function compareSnapshots(previous,current){
  if(!previous?.items?.length) return {firstRun:true,hasChanges:false,total:0,added:0,removed:0,updated:0,changes:[]};
  const key=item=>`${item.accountId||'default'}:${item.id}`;
  const before=new Map(previous.items.map(item=>[key(item),item]));
  const after=new Map(current.items.map(item=>[key(item),item]));
  const changes=[];
  for(const [id,item] of after){
    const old=before.get(id);
    if(!old){changes.push({type:'added',id,title:item.title,accountId:item.accountId});continue}
    const fields=trackedFields.filter(field=>!same(old[field],item[field]));
    if(fields.length) changes.push({type:'updated',id,title:item.title,accountId:item.accountId,fields,
      before:Object.fromEntries(fields.map(field=>[field,old[field]??null])),after:Object.fromEntries(fields.map(field=>[field,item[field]??null]))});
  }
  for(const [id,item] of before) if(!after.has(id)) changes.push({type:'removed',id,title:item.title,accountId:item.accountId});
  const count=type=>changes.filter(change=>change.type===type).length;
  return {firstRun:false,hasChanges:changes.length>0,total:changes.length,added:count('added'),removed:count('removed'),updated:count('updated'),changes};
}
