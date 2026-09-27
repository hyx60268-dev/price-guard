import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const summary=JSON.parse(await fs.readFile('data/change-summary.json','utf8'));
if(summary.firstRun || !summary.hasChanges){
  console.log(summary.firstRun?'首次运行只建立基准，不发送提醒':'数据无变化，不发送提醒');
  process.exit(0);
}

const fingerprint=crypto.createHash('sha256').update(JSON.stringify((summary.changes||[]).map(change=>({
  type:change.type,id:change.id,fields:change.fields||[],before:change.before||null,after:change.after||null
})).sort((a,b)=>`${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)))).digest('hex');
const notificationMarker=`<!-- PRICE_GUARD_NOTIFICATION:${fingerprint} -->`;
const fingerprintFile='state/last-notification-hash.txt';
const priorFingerprint=await fs.readFile(fingerprintFile,'utf8').catch(()=>'');
if(priorFingerprint.trim()===fingerprint){console.log('与上一条提醒完全相同，跳过重复通知');process.exit(0)}

async function githubNotificationExists(){
  if(!process.env.GITHUB_TOKEN||!process.env.GITHUB_REPOSITORY)return false;
  const endpoint=`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues?state=all&per_page=100&sort=created&direction=desc`;
  const response=await fetch(endpoint,{headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'user-agent':'price-guard','x-github-api-version':'2022-11-28'}});
  if(!response.ok){console.warn(`重复提醒查询失败：HTTP ${response.status}`);return false}
  const issues=await response.json();
  return Array.isArray(issues)&&issues.some(issue=>String(issue.body||'').includes(notificationMarker));
}

if(await githubNotificationExists()){
  console.log('GitHub 中已记录完全相同的变化，跳过重复通知');
  await fs.mkdir('state',{recursive:true});await fs.writeFile(fingerprintFile,fingerprint);
  process.exit(0);
}

const dashboard=process.env.DASHBOARD_URL||`https://${(process.env.GITHUB_REPOSITORY_OWNER||'').toLowerCase()}.github.io/${(process.env.GITHUB_REPOSITORY||'/price-guard').split('/')[1]||'price-guard'}/`;
const message=`价格守卫发现 ${summary.total} 项变化：新增 ${summary.added}、下架 ${summary.removed}、价格/成本变化 ${summary.updated}。\n${dashboard}`;
function changeText(change){
  if(change.after?.staleListingSuggested===true)return `30天未售，建议评估删除｜${change.title||change.id}`;
  const signal=change.signal||change.after?.priceSignal;
  const action=change.type==='added'?'新增':change.type==='removed'?'下架':signal==='raise'?'建议提价':signal==='lower'?'建议降价':'价格/利润变化';
  return `${action}｜${change.title||change.id}`;
}
let sent=false;
if(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY){
  const endpoint=`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`;
  const headers={authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'content-type':'application/json','user-agent':'price-guard','x-github-api-version':'2022-11-28'};
  const lines=(summary.changes||[]).slice(0,20).map(changeText),remaining=Math.max(0,(summary.changes||[]).length-lines.length);
  // Keep the alert in GitHub without mentioning or assigning a user. Both
  // actions are direct GitHub email triggers and violate GitHub-only alerts.
  const payload={title:`价格变动提醒：${summary.total} 项`,body:`${message}\n\n${lines.map(line=>`- ${line}`).join('\n')}${remaining?`\n- 以及另外 ${remaining} 项`:''}\n\n这是自动提醒。商品明细和利润只在加密仪表盘中显示。\n${notificationMarker}`,labels:[]};
  const response=await fetch(endpoint,{
    method:'POST',headers,body:JSON.stringify(payload)
  });
  if(!response.ok) throw new Error(`GitHub 手机提醒失败：HTTP ${response.status} ${await response.text()}`);
  console.log('已创建 GitHub Issue 提醒'); sent=true;
}

if(sent){await fs.mkdir('state',{recursive:true});await fs.writeFile(fingerprintFile,fingerprint)}
else throw new Error('检测到变化，但没有可用的 GitHub Token，无法创建 GitHub Issue 通知');
