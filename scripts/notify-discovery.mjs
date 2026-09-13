import fs from 'node:fs/promises';

const file='data/discovery-change-summary.json';
let summary;try{summary=JSON.parse(await fs.readFile(file,'utf8'))}catch{process.exit(0)}
if(summary.firstRun||!summary.hasChanges||!summary.added){
  console.log(summary.firstRun?'选品发现首次运行只建立基准':'没有新增的已核验热卖选品');process.exit(0);
}
const dashboard=process.env.DASHBOARD_URL||`https://${(process.env.GITHUB_REPOSITORY_OWNER||'').toLowerCase()}.github.io/${(process.env.GITHUB_REPOSITORY||'/price-guard').split('/')[1]||'price-guard'}/`;
const message=`选品发现新增 ${summary.added} 个已核验候选，可在仪表盘查看月销量、售价、闲鱼采购价和图片。\n${dashboard}`;
let sent=false;
if(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID){
  const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:message,disable_web_page_preview:true})});
  if(!response.ok)throw new Error(`Telegram 选品提醒失败：HTTP ${response.status}`);sent=true;
}
if(!sent&&process.env.GITHUB_TOKEN&&process.env.GITHUB_REPOSITORY){
  const owner=process.env.GITHUB_REPOSITORY_OWNER,headers={authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'content-type':'application/json','user-agent':'price-guard','x-github-api-version':'2022-11-28'};
  const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`,{method:'POST',headers,body:JSON.stringify({title:`发现 ${summary.added} 个热卖选品`,body:`${owner?`@${owner} `:''}${message}\n\n详情只在密码解锁后的仪表盘显示。`,assignees:owner?[owner]:[]})});
  if(!response.ok)throw new Error(`GitHub 选品提醒失败：HTTP ${response.status}`);
}
