import { advice,calculateCost } from './rules.mjs';

const generic=/中国限定|海外限定|日本未発売|日本非売品|正規品|新品|未使用|未開封|公式|送料無料|匿名配送/gi;

export function normalizeProductIdentity(value=''){
  return String(value).normalize('NFKC').toLowerCase().replace(generic,'')
    .replace(/[\s·・,:：，。!！?？【】\[\]()（）<>《》“”"'‘’\-_/／+＋×]/g,'');
}

export function accountIdFromProfile(profileUrl=''){
  const id=String(profileUrl).match(/\/user\/([^/?#]+)/i)?.[1];
  return id?`account-${id.toLowerCase()}`:`account-${Date.now()}`;
}

export function itemIdentityKeys(item={},accountIdOverride){
  const accountId=accountIdOverride||item.accountId||'default';
  const keys=[];
  const query=normalizeProductIdentity(item.xianyuQuery||'');
  const title=normalizeProductIdentity(item.title||'');
  if(query)keys.push(`${accountId}:query:${query}`);
  if(title)keys.push(`${accountId}:title:${title}`);
  return [...new Set(keys)];
}

export function manualCostKey(item={},accountIdOverride){
  return itemIdentityKeys(item,accountIdOverride)[0]||`${accountIdOverride||item.accountId||'default'}:item:${item.id||'unknown'}`;
}

function finite(value){
  const number=value===''||value===null||value===undefined?null:Number(value);
  return Number.isFinite(number)?number:null;
}

export function normalizeManualCostRecord(record={},item={}){
  const accountId=record.accountId||item.accountId||'default';
  return {
    deleted:Boolean(record.deleted),
    purchaseCNY:finite(record.purchaseCNY),
    manualFeeCNY:finite(record.manualFeeCNY),
    shippingJPY:finite(record.shippingJPY),
    updatedAt:record.updatedAt||new Date(0).toISOString(),
    accountId,
    itemId:record.itemId||item.id||'',
    title:record.title||item.title||'',
    xianyuQuery:record.xianyuQuery||item.xianyuQuery||'',
    identityKeys:[...new Set([...(record.identityKeys||[]),...itemIdentityKeys({...item,accountId})])]
  };
}

function timestamp(record){
  const value=Date.parse(record?.updatedAt||'');
  return Number.isFinite(value)?value:0;
}

export function mergeManualCosts(base={},incoming={}){
  const output={...base};
  for(const [key,value] of Object.entries(incoming||{})){
    if(!value||typeof value!=='object')continue;
    const next=normalizeManualCostRecord(value);
    const current=output[key];
    if(!current||timestamp(next)>=timestamp(current))output[key]=next;
  }
  return output;
}

export function mergeDismissedDiscoveries(base={},incoming={}){
  const output={...base};
  for(const [key,value] of Object.entries(incoming||{})){
    if(!value||typeof value!=='object')continue;
    const next={...value,productKey:String(value.productKey||key),title:String(value.title||''),updatedAt:value.updatedAt||new Date(0).toISOString()};
    const current=output[key];
    if(!current||timestamp(next)>=timestamp(current))output[key]=next;
  }
  return output;
}

export function discoveryDismissalKey(item={}){
  return String(item.productKey||normalizeProductIdentity(item.sourceTitle||item.proposedTitle||item.title||'')||item.id||'');
}

export function manualCostFor(costs={},item={},aliases={}){
  const accountId=item.accountId||'default';
  const directKeys=[`${accountId}:${item.id}`,`${accountId}:item:${item.id}`,...itemIdentityKeys(item)];
  const oldId=aliases?.[`${accountId}:${item.id}`]||item.relistedFrom;
  if(oldId)directKeys.push(`${accountId}:${oldId}`,`${accountId}:item:${oldId}`);
  let best=null;
  for(const key of directKeys)if(costs[key]){
    const candidate=normalizeManualCostRecord(costs[key],item);
    if(!best||timestamp(candidate)>timestamp(best))best=candidate;
  }
  const wanted=new Set(itemIdentityKeys(item));
  for(const record of Object.values(costs||{})){
    const normalized=normalizeManualCostRecord(record);
    if(normalized.accountId!==accountId)continue;
    if(normalized.itemId===item.id||normalized.identityKeys.some(key=>wanted.has(key))){
      if(!best||timestamp(normalized)>timestamp(best))best=normalized;
    }
  }
  return best&&!best.deleted?normalizeManualCostRecord(best,item):null;
}

export function calculateManualFields(item,record,settings){
  const normalized=record?normalizeManualCostRecord(record,item):null;
  const manualPurchaseCNY=finite(normalized?.purchaseCNY);
  const purchaseCNY=manualPurchaseCNY??finite(item.averageCNY);
  const manualFeeCNY=finite(normalized?.manualFeeCNY);
  const shippingJPY=finite(normalized?.shippingJPY);
  const costJPY=calculateCost(purchaseCNY,manualFeeCNY,shippingJPY,settings);
  const currentProfitJPY=Number.isFinite(costJPY)?item.ownPrice-costJPY:null;
  const afterProfitJPY=Number.isFinite(costJPY)?item.recommendedPrice-costJPY:null;
  return {
    manualCost:normalized,
    manualPurchaseCNY,
    purchaseCNY,
    manualFeeCNY,
    shippingJPY,
    costJPY,
    currentProfitJPY,
    afterProfitJPY,
    currentUnder1500:Number.isFinite(currentProfitJPY)&&currentProfitJPY<settings.profitWarningJPY,
    afterUnder1500:Number.isFinite(afterProfitJPY)&&afterProfitJPY<settings.profitWarningJPY,
    advice:advice({ownPrice:item.ownPrice,recommendedPrice:item.recommendedPrice,cost:costJPY,warning:settings.profitWarningJPY})
  };
}

export function mergeAccountConfigs(configured=[],managed=[]){
  const deleted=new Set((managed||[]).filter(account=>account?.enabled===false).map(account=>account.id));
  const configuredIds=new Set((configured||[]).map(account=>account.id));
  const output=[],seenProfiles=new Set(),seenIds=new Set();
  for(const source of [...configured,...managed]){
    if(!source?.profileUrl||source.enabled===false||(!configuredIds.has(source.id)&&deleted.has(source.id)))continue;
    const profile=String(source.profileUrl).replace(/\/+$/,'');
    if(seenProfiles.has(profile)||seenIds.has(source.id))continue;
    seenProfiles.add(profile);seenIds.add(source.id);
    output.push({
      id:source.id||accountIdFromProfile(profile),name:source.name||source.id||'Yahoo账号',
      platform:'yahoo_fleamarket',profileUrl:profile,catalogFile:source.catalogFile||'',enabled:true,
      managed:!source.catalogFile
    });
  }
  return output;
}
