import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decrypt } from './lib/crypto.mjs';

const runFile=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'..');
const password=process.env.DASHBOARD_PASSWORD,token=process.env.GITHUB_TOKEN,repository=process.env.GITHUB_REPOSITORY||'';
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
const [owner,repo]=repository.split('/');
if(!owner||!repo)throw new Error('缺少 GITHUB_REPOSITORY');
const syncTitle=/^\[Price Guard Sync(?::[a-z0-9_-]+)?\]/i;
const headers={authorization:`Bearer ${token}`,'content-type':'application/json','user-agent':'price-guard','x-github-api-version':'2022-11-28'};

async function github(pathname,options={}){
  if(!token)throw new Error('缺少 GITHUB_TOKEN，无法处理同步队列');
  const response=await fetch(`https://api.github.com/repos/${repository}${pathname}`,{...options,headers:{...headers,...options.headers}});
  if(!response.ok)throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0,300)}`);
  return response.status===204?null:response.json();
}

async function currentEvent(){
  try{return JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH,'utf8'))}catch{return {}}
}

async function pendingIssues(){
  const listed=[];
  for(let page=1;page<=10;page++){
    const batch=await github(`/issues?state=open&per_page=100&sort=created&direction=asc&page=${page}`);listed.push(...(batch||[]));
    if((batch||[]).length<100)break;
  }
  const byNumber=new Map(listed.filter(issue=>!issue.pull_request&&syncTitle.test(String(issue.title||''))).map(issue=>[issue.number,issue]));
  const event=await currentEvent(),current=event.issue;
  if(current?.number&&syncTitle.test(String(current.title||''))&&!byNumber.has(current.number))byNumber.set(current.number,current);
  return [...byNumber.values()].sort((a,b)=>Number(a.number)-Number(b.number));
}

async function stateSummary(){
  const bytes=await fs.readFile(path.join(root,'state','latest.json.enc'));
  const state=JSON.parse(decrypt(bytes,password).toString('utf8'));
  return {accounts:state.accounts?.length||0,costs:Object.keys(state.manualCosts||{}).length,dismissed:Object.keys(state.dismissedDiscoveries||{}).length};
}

const issues=await pendingIssues(),event=await currentEvent();
if(!issues.length){
  if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,'processed=0\nfailed=0\n');
  if(event.issue&&syncTitle.test(String(event.issue.title||'')))throw new Error('同步请求尚未出现在 GitHub 队列，请重新运行');
  console.log('没有等待处理的加密同步请求');
  process.exit(0);
}

const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'price-guard-sync-'));
let processed=0,failed=0;
try{
  for(const issue of issues){
    const eventPath=path.join(temporary,`issue-${issue.number}.json`);
    await fs.writeFile(eventPath,JSON.stringify({issue,repository:{owner:{login:owner},name:repo,full_name:repository}}));
    let syncError=null;
    try{
      const {stdout,stderr}=await runFile(process.execPath,['scripts/sync-input.mjs'],{
        cwd:root,maxBuffer:10*1024*1024,env:{...process.env,GITHUB_EVENT_PATH:eventPath,GITHUB_OUTPUT:''}
      });
      if(stdout.trim())console.log(stdout.trim());if(stderr.trim())console.warn(stderr.trim());
      // writeOutputs already saved the complete encrypted scan baseline.
      // The public phone payload is intentionally compact and must not replace it.
    }catch(error){syncError=error}
    if(syncError){
      const detail=String(syncError?.stderr||syncError?.message||syncError).replace(/\s+/g,' ').slice(0,500);
      console.error(`同步 Issue #${issue.number} 失败：${detail}`);
      // Leave the durable input open: an I/O failure may be transient or partial.
      failed++;
      continue;
    }
    const summary=await stateSummary();processed++;
    console.log(`Issue #${issue.number} 已合并，保留请求直到部署成功`);
  }
}finally{await fs.rm(temporary,{recursive:true,force:true})}

const summary=processed?await stateSummary():{accounts:0,costs:0,dismissed:0};
if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`processed=${processed}\nfailed=${failed}\naccounts=${summary.accounts}\ncosts=${summary.costs}\ndismissed=${summary.dismissed}\n`);
console.log(`同步队列处理完成：成功 ${processed}，失败 ${failed}`);
if(!processed&&failed)process.exitCode=1;
