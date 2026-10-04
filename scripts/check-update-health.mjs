import fs from 'node:fs/promises';
import { inspectUpdateHealth } from './lib/update-health.mjs';

const repository=process.env.GITHUB_REPOSITORY||'';
const [owner,name]=repository.split('/');
const report=await inspectUpdateHealth({
  repository,token:process.env.GITHUB_TOKEN,runId:process.env.GITHUB_RUN_ID,
  baseUrl:process.env.PUBLISHED_BASE_URL||'https://'+owner+'.github.io/'+name+'/data/'
});
console.log('[更新健康检查] '+JSON.stringify(report));
const lines=[
  '## 数据更新检查',
  report.healthy?'已发布数据仍在更新。':'**数据更新异常：'+report.reason+'**',
  '最近数据时间：'+(report.checkedAt||'未取得'),
  ...(Number.isFinite(report.ageMinutes)?['距今 '+report.ageMinutes+' 分钟（正常检查阈值 90 分钟）。']:[]),
  ...report.queueDiagnostics.map(run=>'- [任务 '+run.runId+']('+run.url+')：'+run.status+' / '+run.reason),
  ...(report.diagnosticsIncomplete?['部分队列诊断未取得；不能据此判断队列为空。']:[]),
  '本检查只读取公开状态与 Actions 队列；扫描、审批、发布和同步任务继续按原保护执行。'
];
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
if(!report.healthy){
  console.error('::error::已发布数据未持续更新，请查看本任务摘要中的时间和队列链接。');
  process.exitCode=1;
}
