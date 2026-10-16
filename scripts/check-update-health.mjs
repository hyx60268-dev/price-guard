import fs from 'node:fs/promises';
import { inspectUpdateHealth } from './lib/update-health.mjs';

const repository=process.env.GITHUB_REPOSITORY||'';
const [owner,name]=repository.split('/');
const report=await inspectUpdateHealth({
  repository,token:process.env.GITHUB_TOKEN,runId:process.env.GITHUB_RUN_ID,
  baseUrl:process.env.PUBLISHED_BASE_URL||'https://'+owner+'.github.io/'+name+'/data/'
});
console.log('[更新健康检查] '+JSON.stringify(report));
const scheduler=report.schedulerDiagnostics;
const lines=[
  '## 数据更新检查',
  report.healthy?'已发布数据通过新鲜度检查。':'**数据更新异常：'+report.reason+'**',
  '最近数据时间：'+(report.checkedAt||'未取得'),
  ...(Number.isFinite(report.ageMinutes)?['距今 '+report.ageMinutes+' 分钟（正常检查阈值 90 分钟）。']:[]),
  '价格检查工作流状态：'+scheduler.workflowState+(scheduler.workflowState==='unknown'?'（未取得，不代表已停用）。':'。'),
  '最近 '+scheduler.recentWindowMinutes+' 分钟 schedule 触发的任务记录数：'+(scheduler.recentScheduledRunCount??'未取得')+'。',
  ...(scheduler.runRecordEvidence==='no_recent_schedule_run_records'?['此窗口内未发现新建的定时任务记录；不能将缺少记录归因于已有任务的并发锁等待。']:[]),
  ...(scheduler.incomplete?['调度证据未完整取得；未知状态不能视为已启用或已停用。']:[]),
  '数据新鲜度、工作流启用状态和任务记录数均不能证明每 20 分钟完成全量核验。',
  ...report.queueDiagnostics.map(run=>'- [任务 '+run.runId+']('+run.url+')：'+run.status+' / '+run.reason),
  ...(report.diagnosticsIncomplete?['部分队列诊断未取得；不能据此判断队列为空。']:[]),
  '本检查只读取公开状态与 Actions 队列；扫描、审批、发布和同步任务继续按原保护执行。'
];
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
if(!report.healthy){
  console.error('::error::已发布数据未持续更新，请查看本任务摘要中的时间和队列链接。');
  process.exitCode=1;
}
