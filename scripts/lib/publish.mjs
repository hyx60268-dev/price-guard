import fs from 'node:fs/promises';
import path from 'node:path';
import { compareSnapshots } from './changes.mjs';
import { encryptFile } from './crypto.mjs';
import { makeWorkbook } from './excel.mjs';

export function dashboardSummary(result,changeSummary){
  const items=result.items||[];
  const scanTotals=(result.accounts||[]).reduce((sum,account)=>({
    yahoo:sum.yahoo+(account.scanStats?.yahoo||0),
    yahooLive:sum.yahooLive+(account.scanStats?.yahooLive||0),
    yahooCached:sum.yahooCached+(account.scanStats?.yahooCached||0),
    yahooDeferred:sum.yahooDeferred+(account.scanStats?.yahooDeferred||0),
    xianyuRequested:sum.xianyuRequested+(account.scanStats?.xianyuRequested||0),
    xianyuScanned:sum.xianyuScanned+(account.scanStats?.xianyuScanned||0),
    xianyuCached:sum.xianyuCached+(account.scanStats?.xianyuCached||0),
    xianyuSkipped:sum.xianyuSkipped+(account.scanStats?.xianyuSkipped||0)
  }),{yahoo:0,yahooLive:0,yahooCached:0,yahooDeferred:0,xianyuRequested:0,xianyuScanned:0,xianyuCached:0,xianyuSkipped:0});
  return {
    version:result.version,checkedAt:result.checkedAt,cloudSyncedAt:result.cloudSyncedAt||null,
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
  await Promise.allSettled([fs.unlink(jsonPath),fs.unlink(xlsxPath)]);
  return {summary,changeSummary};
}
