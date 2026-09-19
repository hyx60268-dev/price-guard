import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { decrypt } from './lib/crypto.mjs';
import { portalUsersFromEnv } from './lib/publish.mjs';

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
let sent=false;

function safeEmail(value=''){
  const email=String(value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254?email:'';
}
function html(value=''){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function changeText(change){
  const action=change.type==='added'?'新增':change.type==='removed'?'下架':'价格/利润变化';
  return `${action}｜${change.title||change.id}`;
}
async function sendEmail(to,name,changes){
  const apiKey=process.env.RESEND_API_KEY,from=process.env.NOTIFY_FROM_EMAIL;
  if(!apiKey||!from)return false;
  const lines=changes.slice(0,30).map(changeText),remaining=Math.max(0,changes.length-lines.length);
  const text=`${name}，你负责的店铺有 ${changes.length} 项变化：\n\n${lines.join('\n')}${remaining?`\n以及另外 ${remaining} 项`:''}\n\n打开加密仪表盘：${dashboard}`;
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify({
    from,to:[to],subject:`[价格守卫] ${changes.length} 项店铺变化`,text,
    html:`<h2>${html(name)}，你负责的店铺有 ${changes.length} 项变化</h2><ul>${lines.map(line=>`<li>${html(line)}</li>`).join('')}</ul>${remaining?`<p>以及另外 ${remaining} 项</p>`:''}<p><a href="${html(dashboard)}">打开加密仪表盘查看价格与利润</a></p>`
  })});
  if(!response.ok)throw new Error(`邮箱提醒失败：HTTP ${response.status} ${await response.text()}`);
  return true;
}

if(process.env.DASHBOARD_PASSWORD&&process.env.RESEND_API_KEY&&process.env.NOTIFY_FROM_EMAIL){
  const encrypted=await fs.readFile('public/data/latest.json.enc');
  const latest=JSON.parse(decrypt(encrypted,process.env.DASHBOARD_PASSWORD).toString('utf8'));
  const preferences=latest.portalPreferences||{},changes=summary.changes||[],users=portalUsersFromEnv();
  const recipients=[
    {username:'admin',displayName:'总管理员',notificationEmail:safeEmail(preferences.admin?.notificationEmail),accountIds:null},
    ...users.map(user=>({...user,notificationEmail:safeEmail(preferences[user.username]?.notificationEmail||user.notificationEmail)}))
  ];
  for(const user of recipients){
    if(!user.notificationEmail)continue;
    const allowed=user.accountIds?new Set(user.accountIds):null,userChanges=allowed?changes.filter(change=>allowed.has(change.accountId)):changes;
    if(!userChanges.length)continue;
    await sendEmail(user.notificationEmail,user.displayName,userChanges);
    console.log(`已向 ${user.username} 发送 ${userChanges.length} 项专属邮箱提醒`);sent=true;
  }
}else console.warn('未配置 RESEND_API_KEY / NOTIFY_FROM_EMAIL，暂不发送分用户邮箱提醒');

if(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID){
  const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:message,disable_web_page_preview:true})
  });
  if(!response.ok) throw new Error(`Telegram 提醒失败：HTTP ${response.status} ${await response.text()}`);
  console.log('已发送 Telegram 手机提醒'); sent=true;
}

if(!sent && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY){
  const endpoint=`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`,owner=process.env.GITHUB_REPOSITORY_OWNER;
  const headers={authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'content-type':'application/json','user-agent':'price-guard','x-github-api-version':'2022-11-28'};
  const payload={title:`价格变动提醒：${summary.total} 项`,body:`${owner?`@${owner} `:''}${message}\n\n这是自动提醒。商品明细和利润只在加密仪表盘中显示。\n${notificationMarker}`,labels:[],assignees:owner?[owner]:[]};
  let response=await fetch(endpoint,{
    method:'POST',headers,body:JSON.stringify(payload)
  });
  // 某些仓库策略不允许 Actions 自动指派；仍保留不指派的提醒作为降级方案。
  if(!response.ok&&payload.assignees.length)response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({...payload,assignees:[]})});
  if(!response.ok) throw new Error(`GitHub 手机提醒失败：HTTP ${response.status} ${await response.text()}`);
  console.log('已创建 GitHub Issue 提醒'); sent=true;
}

if(sent){await fs.mkdir('state',{recursive:true});await fs.writeFile(fingerprintFile,fingerprint)}
else console.warn('检测到变化，但未配置 Telegram 且没有可用的 GitHub Token');
