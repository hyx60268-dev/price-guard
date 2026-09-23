import fs from 'node:fs/promises';

// Run AFTER deployment so a failed cost source cannot suppress Yahoo updates.
const file = new URL('../public/data/status.json', import.meta.url);
const status = JSON.parse(await fs.readFile(file, 'utf8'));
const cost = status.cloudCost;
console.log('[CLOUD COST ACCEPTANCE]', JSON.stringify({ codeSha: status.codeSha, checkedAt: status.checkedAt, ...cost }));
if (!cost?.accepted || cost.verifiedReferences < 1 || process.env.GITHUB_SHA && status.codeSha !== process.env.GITHUB_SHA) {
  console.error('::error title=闲鱼云端成本验收未通过::' + (cost?.message || '缺少本版本的成本核验结果') + '。网页发布与闲鱼成本成功是两个独立结果。');
  process.exitCode = 1;
}
