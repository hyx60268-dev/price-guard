import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt } from './lib/crypto.mjs';
import { writeOutputs } from './lib/publish.mjs';
import { accountIdFromProfile,calculateManualFields,manualCostFor,mergeManualCosts } from './lib/state.mjs';
import { decodeSyncBody } from './lib/sync-payload.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');

const event=JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
const issue=event.issue||{},owner=event.repository?.owner?.login||process.env.GITHUB_REPOSITORY_OWNER;
if(issue.user?.login!==owner)throw new Error('只接受仓库所有者提交的同步请求');
if(!String(issue.title||'').startsWith('[Price Guard Sync]'))throw new Error('不是价格守卫同步请求');
const payload=decodeSyncBody(issue.body,password);

const statePath=path.join(root,'state','latest.json.enc');
const previous=JSON.parse(decrypt(await fs.readFile(statePath),password).toString('utf8'));
const incomingCosts=payload.manualCosts&&typeof payload.manualCosts==='object'&&!Array.isArray(payload.manualCosts)?payload.manualCosts:{};
if(Object.keys(incomingCosts).length>1500)throw new Error('成本记录数量异常');
const manualCosts=mergeManualCosts(previous.manualCosts||{},incomingCosts);

const settings=previous.settings||JSON.parse(await fs.readFile(path.join(root,'config','settings.json'),'utf8'));
const configured=JSON.parse(await fs.readFile(path.join(root,'config','accounts.json'),'utf8')).accounts||[];
const staticIds=new Set(configured.map(account=>account.id));
const existing=new Map((previous.managedAccounts||[]).map(account=>[account.id,account]));
for(const raw of payload.managedAccounts||[]){
  const profileUrl=String(raw?.profileUrl||'').trim().replace(/\/+$/,'');
  if(!/^https:\/\/paypayfleamarket\.yahoo\.co\.jp\/user\/[^/?#]+$/i.test(profileUrl))continue;
  const id=String(raw.id||accountIdFromProfile(profileUrl)).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)||accountIdFromProfile(profileUrl);
  if(staticIds.has(id))continue;
  existing.set(id,{id,name:String(raw.name||id).trim().slice(0,80),profileUrl,enabled:raw.enabled!==false,managed:true,updatedAt:raw.updatedAt||payload.issuedAt||new Date().toISOString()});
}
for(const id of payload.deletedAccountIds||[])if(!staticIds.has(id))existing.delete(id);
if(existing.size>30)throw new Error('云端账号数量超过 30 个');
const managedAccounts=[...existing.values()];
const managedById=new Map(managedAccounts.map(account=>[account.id,account]));
const activeIds=new Set([...configured.filter(account=>account.enabled!==false).map(account=>account.id),...managedAccounts.filter(account=>account.enabled!==false).map(account=>account.id)]);
const defaultAccountId=configured.find(account=>account.enabled!==false)?.id;

const relistAliases=previous.relistAliases||{};
const items=(previous.items||[]).map(item=>({...item,accountId:item.accountId||defaultAccountId})).filter(item=>activeIds.has(item.accountId)).map(item=>{
  const manual=manualCostFor(manualCosts,item,relistAliases);
  return {...item,...calculateManualFields(item,manual,settings)};
});
const byAccount=new Map();
for(const item of items){const list=byAccount.get(item.accountId)||[];list.push(item);byAccount.set(item.accountId,list)}
const accounts=(previous.accounts||[]).filter(account=>activeIds.has(account.id)).map(account=>{
  const accountItems=byAccount.get(account.id)||[];
  const managed=managedById.get(account.id);
  return {...account,...(managed?{name:managed.name,profileUrl:managed.profileUrl,managed:true}:{}),items:accountItems,itemCount:accountItems.length};
});
for(const account of managedAccounts.filter(account=>account.enabled!==false))if(!accounts.some(current=>current.id===account.id)){
  accounts.push({id:account.id,name:account.name,profileUrl:account.profileUrl,managed:true,profileStatus:'pending_sync',profileError:'',
    profileDelta:{added:[],removed:[],relisted:[],unchanged:0},itemCount:0,lastCatalogCount:0,
    scanStats:{yahoo:0,yahooLive:0,yahooCached:0,yahooDeferred:0,xianyuRequested:0,xianyuScanned:0,xianyuCached:0,xianyuSkipped:0},items:[]});
}

const cloudSyncedAt=new Date().toISOString();
const result={...previous,version:5,cloudSyncedAt,dataRevision:cloudSyncedAt,settings,manualCosts,managedAccounts,accounts,items};
const {summary}=await writeOutputs({root,result,previous,password});
if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`synced_at=${cloudSyncedAt}\naccounts=${accounts.length}\ncosts=${Object.keys(manualCosts).length}\n`);
console.log(`同步完成：${summary.accounts.length} 个账号，${Object.keys(manualCosts).length} 条加密成本记录`);
