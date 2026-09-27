import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const file='data/discovery-change-summary.json';
let summary;try{summary=JSON.parse(await fs.readFile(file,'utf8'))}catch{process.exit(0)}
if(summary.firstRun||!summary.hasChanges||!summary.added){
  console.log(summary.firstRun?'选品发现首次运行只建立基准':'没有新增热卖选品');process.exit(0);
}
const fingerprint=crypto.createHash('sha256').update(JSON.stringify({
  added:[...(summary.addedIds||[])].sort(),removed:[...(summary.removedIds||[])].sort()
})).digest('hex');
const notificationMarker=`<!-- PRICE_GUARD_DISCOVERY_NOTIFICATION:${fingerprint} -->`;
const fingerprintFile='state/last-discovery-notification-hash.txt';
const priorFingerprint=await fs.readFile(fingerprintFile,'utf8').catch(()=>'');
if(priorFingerprint.trim()===fingerprint){console.log('与上一条选品提醒完全相同，跳过重复通知');process.exit(0)}

const dashboard=process.env.DASHBOARD_URL||`https://${(process.env.GITHUB_REPOSITORY_OWNER||'').toLowerCase()}.github.io/${(process.env.GITHUB_REPOSITORY||'/price-guard').split('/')[1]||'price-guard'}/`;
const message=`选品发现新增 ${summary.added} 个候选（已核验 ${summary.addedReady||0}，待复核 ${summary.addedPending||0}），可在仪表盘查看月销量、售价、闲鱼采购价和图片。\n${dashboard}`;
const body=`### 发现 ${summary.added} 个热卖选品\n\n${message}\n\n详情只在密码解锁后的仪表盘显示。\n\n${notificationMarker}\n`;
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,body);
console.log('已写入 GitHub Actions 运行摘要（不创建 Issue，不触发项目邮件）');
await fs.mkdir('state',{recursive:true});await fs.writeFile(fingerprintFile,fingerprint);
