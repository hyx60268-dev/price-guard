import fs from 'node:fs/promises';
import { decrypt } from './lib/crypto.mjs';
import { acknowledgePublishedSync } from './lib/sync-receipts.mjs';

const repository=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN;
if(!repository||!token)throw new Error('缺少 GitHub 发布确认凭据');
const state=JSON.parse(decrypt(await fs.readFile(new URL('../state/latest.json.enc',import.meta.url)),process.env.DASHBOARD_PASSWORD));
async function github(path,options={}){
  const response=await fetch(`https://api.github.com/repos/${repository}${path}`,{...options,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-github-api-version':'2022-11-28'}});
  if(!response.ok)throw new Error(`GitHub 发布确认失败：${response.status}`);
  return response.status===204?null:response.json();
}
const count=await acknowledgePublishedSync({state,
  listIssues:async()=>{
    const issues=[];
    for(let page=1;page<=10;page++){
      const batch=await github(`/issues?state=open&per_page=100&sort=created&direction=asc&page=${page}`);
      issues.push(...batch.filter(issue=>!issue.pull_request));if(batch.length<100)break;
    }
    return issues;
  },
  closeIssue:number=>github(`/issues/${number}`,{method:'PATCH',body:JSON.stringify({state:'closed'})}),
  requestMerchantScan:process.env.REQUEST_ACCOUNT_SCAN==='1'?()=>github('/actions/workflows/merchant-monitor.yml/dispatches',{method:'POST',body:JSON.stringify({ref:'main'})}):undefined,
  requestScan:process.env.REQUEST_ACCOUNT_SCAN==='1'?()=>github('/actions/workflows/price-guard.yml/dispatches',{method:'POST',body:JSON.stringify({ref:'main'})}):undefined
});
console.log(`已确认发布 ${count} 个同步请求`);
