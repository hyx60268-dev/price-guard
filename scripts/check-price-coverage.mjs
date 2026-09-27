import fs from 'node:fs/promises';

const status=JSON.parse(await fs.readFile('public/data/status.json','utf8'));
const coverage=status.pricingCoverage||{};
const platforms=coverage.platforms||{};
const summary={codeSha:status.codeSha||null,checkedAt:status.checkedAt||null,total:status.total||0,
  inventoryComplete:Boolean(coverage.inventoryComplete),complete:Boolean(coverage.complete),platforms};
console.log('[FULL PRICE COVERAGE]',JSON.stringify(summary));
if(!coverage.complete){
  const details=Object.entries(platforms).map(([name,value])=>`${name}: ${value.checked||0}/${value.total||0}，剩余 ${value.remaining||0}，待确认 ${value.incomplete||0}`).join('；');
  throw new Error(`全账号全商品价格核验尚未完成。${details||'没有生成覆盖数据'}。本轮进度已发布，后续云端轮转将从未核验商品继续。`);
}
