import fs from 'node:fs/promises';
import path from 'node:path';
import { compareSnapshots } from './changes.mjs';
import { encryptFile } from './crypto.mjs';
import { makeWorkbook } from './excel.mjs';

function safeUsername(value=''){return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,48)}
function safeEmail(value=''){
  const email=String(value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254?email:'';
}

function normalizePortalUserRecords(values=[]){
  const seen=new Map();
  for(const raw of values){
    const username=safeUsername(raw?.username);
    if(!username||username==='admin')throw new Error(`多人账号名称无效：${raw?.username||''}`);
    const enabled=raw?.enabled!==false;
    if(enabled&&String(raw?.password||'').length<8)throw new Error(`多人账号 ${username} 的密码至少需要 8 位`);
    const record={username,displayName:String(raw?.displayName||username).slice(0,80),password:enabled?String(raw.password):'',
      githubLogin:String(raw?.githubLogin||'').trim(),notificationEmail:safeEmail(raw?.notificationEmail),
      accountIds:[...new Set((raw?.accountIds||[]).map(String).filter(Boolean))],enabled,updatedAt:raw?.updatedAt||new Date(0).toISOString()};
    const current=seen.get(username),nextTime=Date.parse(record.updatedAt)||0,currentTime=Date.parse(current?.updatedAt||'')||0;
    if(!current||nextTime>=currentTime)seen.set(username,record);
  }
  return [...seen.values()];
}

export function mergePortalUserRecords(base=[],incoming=[]){
  return normalizePortalUserRecords([...(base||[]),...(incoming||[])]);
}

export function portalUsersFromEnv(value=process.env.PORTAL_USERS_JSON||''){
  if(!value)return [];
  let parsed;
  try{parsed=JSON.parse(value)}catch{throw new Error('PORTAL_USERS_JSON 不是有效 JSON')}
  if(!Array.isArray(parsed))throw new Error('PORTAL_USERS_JSON 必须是数组');
  return normalizePortalUserRecords(parsed).filter(user=>user.enabled!==false);
}

export function portalUserRecordsForResult(result={},envValue=process.env.PORTAL_USERS_JSON||''){
  return mergePortalUserRecords(portalUsersFromEnv(envValue),result.portalUsers||[]);
}

export function portalUsersForResult(result={},envValue=process.env.PORTAL_USERS_JSON||''){
  return portalUserRecordsForResult(result,envValue).filter(user=>user.enabled!==false);
}

export function scopeResultForPortalUser(result,user){
  const allowed=new Set(user.accountIds||[]);
  const accounts=(result.accounts||[]).filter(account=>allowed.has(account.id));
  const items=(result.items||[]).filter(item=>allowed.has(item.accountId));
  const manualCosts=Object.fromEntries(Object.entries(result.manualCosts||{}).filter(([,record])=>allowed.has(record?.accountId)));
  const managedAccounts=(result.managedAccounts||[]).filter(account=>allowed.has(account.id));
  const notificationEmail=safeEmail(result.portalPreferences?.[user.username]?.notificationEmail||user.notificationEmail);
  return {...result,portalUsers:undefined,portalPreferences:undefined,portalUser:{username:user.username,displayName:user.displayName,role:'member',notificationEmail},accounts,items,manualCosts,managedAccounts,
    ownedTitleHistory:items.map(item=>item.title).filter(Boolean)};
}

export function dashboardSummary(result,changeSummary){
  const items=result.items||[];
  const scanTotals=(result.accounts||[]).reduce((sum,account)=>({
    yahoo:sum.yahoo+(account.scanStats?.yahoo||0),
    yahooLive:sum.yahooLive+(account.scanStats?.yahooLive||0),
    yahooCached:sum.yahooCached+(account.scanStats?.yahooCached||0),
    yahooDeferred:sum.yahooDeferred+(account.scanStats?.yahooDeferred||0),
    xianyuRequested:sum.xianyuRequested+(account.scanStats?.xianyuRequested||0),
    xianyuScanned:sum.xianyuScanned+(account.scanStats?.xianyuScanned||0),
    xianyuVerifiedNew:sum.xianyuVerifiedNew+(account.scanStats?.xianyuVerifiedNew||0),
    xianyuCached:sum.xianyuCached+(account.scanStats?.xianyuCached||0),
    xianyuSkipped:sum.xianyuSkipped+(account.scanStats?.xianyuSkipped||0)
  }),{yahoo:0,yahooLive:0,yahooCached:0,yahooDeferred:0,xianyuRequested:0,xianyuScanned:0,xianyuVerifiedNew:0,xianyuCached:0,xianyuSkipped:0});
  return {
    version:result.version,checkedAt:result.checkedAt,codeSha:result.scanMeta?.codeSha||null,cloudSyncedAt:result.cloudSyncedAt||null,
    dataRevision:result.dataRevision||result.cloudSyncedAt||result.checkedAt,total:items.length,
    accounts:(result.accounts||[]).map(account=>({id:account.id,name:account.name,count:account.itemCount,profileStatus:account.profileStatus,profileDelta:account.profileDelta,scanStats:account.scanStats})),
    repricing:items.filter(item=>item.recommendedPrice!==item.ownPrice).length,
    underpriced:items.filter(item=>item.yahoo?.underpriced).length,
    currentLow:items.filter(item=>item.currentUnder1500).length,
    afterLow:items.filter(item=>item.afterUnder1500).length,
    manual:items.filter(item=>item.confidence!=='高').length,
    needsManualPurchase:items.filter(item=>item.needsManualPurchase).length,scanTotals,
    xianyuLoginRequired:Boolean(result.login?.xianyuRequired),xianyuAuthExpired:Boolean(result.login?.xianyuAuthExpired),xianyuMode:result.login?.xianyuMode||'unknown',
    changes:{total:changeSummary.total,firstRun:changeSummary.firstRun},durationSeconds:result.scanMeta?.durationSeconds??null
  };
}

export async function writeOutputs({root,result,previous,password}){
  await Promise.all(['data','public/data'].map(directory=>fs.mkdir(path.join(root,directory),{recursive:true})));
  result.dataRevision=result.dataRevision||result.cloudSyncedAt||result.checkedAt||new Date().toISOString();
  result.portalUsers=portalUserRecordsForResult(result);
  const portalUsers=result.portalUsers.filter(user=>user.enabled!==false);
  const changeSummary=compareSnapshots(previous,result);
  result.changes={...changeSummary,changes:changeSummary.changes.slice(0,100)};
  const jsonPath=path.join(root,'data','latest.json'),xlsxPath=path.join(root,'data','latest.xlsx');
  await fs.writeFile(jsonPath,JSON.stringify(result,null,2));
  await makeWorkbook(result,xlsxPath);
  await Promise.all([
    encryptFile(jsonPath,path.join(root,'public','data','latest.json.enc'),password),
    encryptFile(xlsxPath,path.join(root,'public','data','latest.xlsx.enc'),password)
  ]);
  const summary=dashboardSummary(result,changeSummary);
  await Promise.all([
    fs.writeFile(path.join(root,'public','data','status.json'),JSON.stringify(summary,null,2)),
    fs.writeFile(path.join(root,'data','change-summary.json'),JSON.stringify(changeSummary,null,2))
  ]);
  const usersDir=path.join(root,'public','data','users');
  await fs.mkdir(usersDir,{recursive:true});
  const manifest=[{username:'admin',displayName:'总管理员',role:'admin'},...portalUsers.map(user=>({username:user.username,displayName:user.displayName,role:'member'}))];
  await fs.writeFile(path.join(root,'public','data','users.json'),JSON.stringify({version:1,users:manifest},null,2));
  for(const user of portalUsers){
    const scoped=scopeResultForPortalUser(result,user),userRoot=path.join(usersDir,user.username);
    await fs.mkdir(userRoot,{recursive:true});
    const userJson=path.join(root,'data',`portal-${user.username}.json`),userXlsx=path.join(root,'data',`portal-${user.username}.xlsx`);
    await fs.writeFile(userJson,JSON.stringify(scoped,null,2));
    await makeWorkbook(scoped,userXlsx);
    await Promise.all([
      encryptFile(userJson,path.join(userRoot,'latest.json.enc'),user.password),
      encryptFile(userXlsx,path.join(userRoot,'latest.xlsx.enc'),user.password),
      fs.writeFile(path.join(userRoot,'status.json'),JSON.stringify(dashboardSummary(scoped,{total:0,firstRun:false}),null,2))
    ]);
    await Promise.allSettled([fs.unlink(userJson),fs.unlink(userXlsx)]);
  }
  await Promise.allSettled([fs.unlink(jsonPath),fs.unlink(xlsxPath)]);
  return {summary,changeSummary};
}
