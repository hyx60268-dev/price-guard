import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt } from './lib/crypto.mjs';
import { mergePortalUserRecords,portalUserRecordsForResult,portalUsersForResult,writeOutputs } from './lib/publish.mjs';
import { accountIdFromProfile,calculateManualFields,manualCostFor,mergeDiscoveryReviews,mergeDismissedDiscoveries,mergeManualCosts } from './lib/state.mjs';
import { decodeSyncBody } from './lib/sync-payload.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');

const event=JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
const issue=event.issue||{},owner=event.repository?.owner?.login||process.env.GITHUB_REPOSITORY_OWNER;
const title=String(issue.title||''),userMatch=title.match(/^\[Price Guard Sync(?::([a-z0-9_-]+))?\]/i);
if(!userMatch)throw new Error('不是价格守卫同步请求');
const statePath=path.join(root,'state','latest.json.enc');
const previous=JSON.parse(decrypt(await fs.readFile(statePath),password).toString('utf8'));
const username=(userMatch[1]||'admin').toLowerCase();
let portalUserRecords=portalUserRecordsForResult(previous),portalUser=portalUsersForResult(previous).find(user=>user.username===username);
if(username==='admin'){
  if(issue.user?.login!==owner)throw new Error('总管理员同步只接受仓库所有者提交');
}else{
  if(!portalUser)throw new Error(`未配置的多人账号：${username}`);
  if(portalUser.githubLogin&&String(issue.user?.login||'').toLowerCase()!==portalUser.githubLogin.toLowerCase())throw new Error(`GitHub 身份无权同步 ${username}`);
}
const payload=decodeSyncBody(issue.body,username==='admin'?password:portalUser.password);
if(username!=='admin'&&!portalUser.githubLogin){
  const githubLogin=String(issue.user?.login||'').trim();if(!githubLogin)throw new Error('无法读取 GitHub 身份');
  portalUserRecords=portalUserRecords.map(user=>user.username===username?{...user,githubLogin,updatedAt:payload.issuedAt||new Date().toISOString()}:user);
  portalUser={...portalUser,githubLogin};
}
if(username==='admin'&&Array.isArray(payload.portalUsers)){
  if(payload.portalUsers.length>50)throw new Error('多人账号数量超过 50 个');
  portalUserRecords=mergePortalUserRecords(portalUserRecords,payload.portalUsers);
}
const allowedAccountIds=username==='admin'?null:new Set(portalUser.accountIds||[]);
const email=String(payload.notificationEmail||'').trim().toLowerCase();
if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('通知邮箱格式不正确');

const rawIncomingCosts=payload.manualCosts&&typeof payload.manualCosts==='object'&&!Array.isArray(payload.manualCosts)?payload.manualCosts:{};
const incomingCosts=allowedAccountIds?Object.fromEntries(Object.entries(rawIncomingCosts).filter(([,record])=>allowedAccountIds.has(record?.accountId))):rawIncomingCosts;
if(Object.keys(incomingCosts).length>1500)throw new Error('成本记录数量异常');
const manualCosts=mergeManualCosts(previous.manualCosts||{},incomingCosts);
const incomingDismissed=username==='admin'&&payload.dismissedDiscoveries&&typeof payload.dismissedDiscoveries==='object'&&!Array.isArray(payload.dismissedDiscoveries)?payload.dismissedDiscoveries:{};
if(Object.keys(incomingDismissed).length>3000)throw new Error('已上传记录数量异常');
const dismissedDiscoveries=mergeDismissedDiscoveries(previous.dismissedDiscoveries||{},incomingDismissed);
const incomingReviews=username==='admin'&&payload.discoveryReviews&&typeof payload.discoveryReviews==='object'&&!Array.isArray(payload.discoveryReviews)?payload.discoveryReviews:{};
if(Object.keys(incomingReviews).length>3000)throw new Error('人工核验记录数量异常');
const discoveryReviews=mergeDiscoveryReviews(previous.discoveryReviews||{},incomingReviews);
const portalPreferences={...(previous.portalPreferences||{}),[username]:{notificationEmail:email,updatedAt:payload.issuedAt||new Date().toISOString()}};

const settings=previous.settings||JSON.parse(await fs.readFile(path.join(root,'config','settings.json'),'utf8'));
const configured=JSON.parse(await fs.readFile(path.join(root,'config','accounts.json'),'utf8')).accounts||[];
const staticIds=new Set(configured.map(account=>account.id));
const existing=new Map((previous.managedAccounts||[]).map(account=>[account.id,account]));
const mutableAccountIds=new Set(portalUser?.accountIds||[]);
const configuredByProfile=new Map(configured.map(account=>[String(account.profileUrl||'').replace(/\/+$/,''),account]));
const existingByProfile=()=>new Map([...existing.values()].map(account=>[String(account.profileUrl||'').replace(/\/+$/,''),account]));
for(const raw of payload.managedAccounts||[]){
  const profileUrl=String(raw?.profileUrl||'').trim().replace(/\/+$/,'');
  if(!/^https:\/\/paypayfleamarket\.yahoo\.co\.jp\/user\/[^/?#]+$/i.test(profileUrl))continue;
  const id=String(raw.id||accountIdFromProfile(profileUrl)).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)||accountIdFromProfile(profileUrl);
  const configuredMatch=configuredByProfile.get(profileUrl),managedMatch=existingByProfile().get(profileUrl);
  if(username!=='admin'){
    const claimedId=configuredMatch?.id||managedMatch?.id||id;
    if((configuredMatch||managedMatch)&&!mutableAccountIds.has(claimedId))throw new Error('这个 Yahoo 店铺已属于其他账号，不能重复绑定');
    if(existing.has(id)&&!mutableAccountIds.has(id))throw new Error('这个 Yahoo 店铺编号已属于其他账号');
    if(configuredMatch){mutableAccountIds.add(configuredMatch.id);continue}
  }
  if(staticIds.has(id))continue;
  const targetId=managedMatch?.id||id;
  existing.set(targetId,{...managedMatch,id:targetId,name:String(raw.name||targetId).trim().slice(0,80),profileUrl,enabled:raw.enabled!==false,managed:true,
    ownerUsername:managedMatch?.ownerUsername||raw.ownerUsername||(username==='admin'?'admin':username),updatedAt:raw.updatedAt||payload.issuedAt||new Date().toISOString()});
  if(username!=='admin')mutableAccountIds.add(targetId);
}
for(const id of payload.deletedAccountIds||[]){
  if(staticIds.has(id))continue;
  const account=existing.get(id);
  if(username==='admin'||mutableAccountIds.has(id)&&(!account?.ownerUsername||account.ownerUsername===username)){existing.delete(id);if(username!=='admin')mutableAccountIds.delete(id)}
}
if(existing.size>100)throw new Error('云端账号数量超过 100 个');
if(username!=='admin')portalUserRecords=portalUserRecords.map(user=>user.username===username?{...user,accountIds:[...mutableAccountIds],updatedAt:payload.issuedAt||new Date().toISOString()}:user);
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
const result={...previous,version:6,cloudSyncedAt,dataRevision:cloudSyncedAt,settings,manualCosts,portalPreferences,dismissedDiscoveries,discoveryReviews,portalUsers:portalUserRecords,managedAccounts,accounts,items};
const {summary}=await writeOutputs({root,result,previous,password});
// A cost/account/upload sync also deploys the static site. Preserve the latest
// encrypted discovery payload so that this lightweight deployment cannot blank
// the discovery tab until the next six-hour scan.
for(const filename of ['discovery.json.enc','discovery-status.json']){
  const source=path.join(root,'state',filename),target=path.join(root,'public','data',filename);
  try{await fs.copyFile(source,target)}catch(error){if(error?.code!=='ENOENT')throw error}
}
if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`synced_at=${cloudSyncedAt}\naccounts=${accounts.length}\ncosts=${Object.keys(manualCosts).length}\ndismissed=${Object.keys(dismissedDiscoveries).length}\n`);
console.log(`同步完成：${summary.accounts.length} 个账号，${Object.keys(manualCosts).length} 条加密成本记录，${Object.keys(dismissedDiscoveries).length} 个已上传选品`);
