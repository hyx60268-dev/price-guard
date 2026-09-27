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

const dashboard=process.env.DASHBOARD_URL||`https://${(process.env.GITHUB_REPOSITORY_OWNER||'').toLowerCase()}.github.io/${(process.env.GITHUB_REPOSITORY||'/price-guard').split('/')[1]||'price-guard'}/`;
const message=`价格守卫发现 ${summary.total} 项变化：新增 ${summary.added}、下架 ${summary.removed}、价格/成本变化 ${summary.updated}。\n${dashboard}`;
function changeText(change){
  if(change.after?.staleListingSuggested===true)return `30天未售，建议评估删除｜${change.title||change.id}`;
  const signal=change.signal||change.after?.priceSignal;
  const action=change.type==='added'?'新增':change.type==='removed'?'下架':signal==='raise'?'建议提价':signal==='lower'?'建议降价':'价格/利润变化';
  return `${action}｜${change.title||change.id}`;
}
const lines=(summary.changes||[]).slice(0,20).map(changeText),remaining=Math.max(0,(summary.changes||[]).length-lines.length);
const body=`### 价格变动提醒：${summary.total} 项\n\n${message}\n\n${lines.map(line=>`- ${line}`).join('\n')}${remaining?`\n- 以及另外 ${remaining} 项`:''}\n\n商品明细和利润只在加密仪表盘中显示。\n\n${notificationMarker}\n`;
// GitHub Issues can generate email even without an explicit @mention when the
// repository is watched. A workflow summary is retained inside GitHub Actions
// but never creates an Issue, mention, assignment or project-originated email.
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,body);
console.log('已写入 GitHub Actions 运行摘要（不创建 Issue，不触发项目邮件）');
await fs.mkdir('state',{recursive:true});await fs.writeFile(fingerprintFile,fingerprint);
