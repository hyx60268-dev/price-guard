import fs from 'node:fs/promises';

const summary=JSON.parse(await fs.readFile('data/change-summary.json','utf8'));
if(summary.firstRun || !summary.hasChanges){
  console.log(summary.firstRun?'首次运行只建立基准，不发送提醒':'数据无变化，不发送提醒');
  process.exit(0);
}

const dashboard=process.env.DASHBOARD_URL||`https://${(process.env.GITHUB_REPOSITORY_OWNER||'').toLowerCase()}.github.io/${(process.env.GITHUB_REPOSITORY||'/price-guard').split('/')[1]||'price-guard'}/`;
const message=`价格守卫发现 ${summary.total} 项变化：新增 ${summary.added}、下架 ${summary.removed}、价格/成本变化 ${summary.updated}。\n${dashboard}`;
let sent=false;

if(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID){
  const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:message,disable_web_page_preview:true})
  });
  if(!response.ok) throw new Error(`Telegram 提醒失败：HTTP ${response.status} ${await response.text()}`);
  console.log('已发送 Telegram 手机提醒'); sent=true;
}

if(!sent && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY){
  const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`,{
    method:'POST',headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'content-type':'application/json','user-agent':'price-guard','x-github-api-version':'2022-11-28'},
    body:JSON.stringify({title:`价格变动提醒：${summary.total} 项`,body:`${message}\n\n这是自动提醒。商品明细和利润只在加密仪表盘中显示。`,labels:[]})
  });
  if(!response.ok) throw new Error(`GitHub 手机提醒失败：HTTP ${response.status} ${await response.text()}`);
  console.log('已创建 GitHub Issue 提醒'); sent=true;
}

if(!sent) console.warn('检测到变化，但未配置 Telegram 且没有可用的 GitHub Token');
