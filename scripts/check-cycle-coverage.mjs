import fs from 'node:fs/promises';
import { cycleAcceptance } from './lib/cycle-coverage.mjs';
import { observePublication } from './lib/publication-observation.mjs';

// After deployment: failed acceptance must not prevent publishing real progress.
const status=JSON.parse(await fs.readFile(new URL('../public/data/status.json',import.meta.url),'utf8'));
const report=cycleAcceptance(status,{codeSha:process.env.GITHUB_SHA});
report.publicationObservedAt=null;
if(process.env.PUBLISHED_STATUS_URL){
 const observation=await observePublication({url:process.env.PUBLISHED_STATUS_URL,expected:status});
 report.publicationObservedAt=observation.observedAt;
 report.publicationObservation=observation.attempts;
 if(!observation.observedAt){report.reasons.push('current_publication_not_observed');report.accepted=false;}
}
console.log('[FULL CYCLE ACCEPTANCE]',JSON.stringify(report));
if(process.env.GITHUB_STEP_SUMMARY){
 const cycle=report.cycleCoverage;
 const lines=['## 20分钟全量周期验收',report.accepted?'本轮采集、全量覆盖及连续周期已通过。':'尚未完成：'+report.reasons.join(', '),
  ...(cycle?.accounts||[]).map(row=>`- ${row.accountId}: 比价 ${row.priceComplete}/${row.total}，成本 ${row.costVerified}/${row.total}，同时完成 ${row.completeItems}/${row.total}；距上次完整周期 ${row.completionGapSeconds==null?'未建立基线':row.completionGapSeconds+' 秒'}`),
  '当前网页版本实际观察时间：'+(report.publicationObservedAt||'尚未验证'),
  '网页发布、首次积压恢复和持续完整周期分别验收；请求尝试或旧缓存不算本轮完成。'];
 await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
}
if(!report.accepted){console.error('::error title=20分钟全量周期未通过::'+report.reasons.join(', '));process.exitCode=1;}

if(process.env.ACCEPTANCE_RESULT_PATH)await fs.writeFile(process.env.ACCEPTANCE_RESULT_PATH,JSON.stringify({kind:report.reasons.includes('current_publication_not_observed')?'operational':'product',accepted:report.accepted}));
