const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=value=>/^https:\/\//i.test(value||'')?escape(value):'#';
const cny=value=>Number.isFinite(value)?'¥'+value.toLocaleString('zh-CN',{maximumFractionDigits:2}):'待核验';
export function procurementLabel(item={}){return item.referenceProvider==='public_cn'?(item.referenceSourceLabel||'国内公开采购参考'):'闲鱼采购参考';}
export function publicProcurementMarkup(item={}){
 const cost=item.procurementSource||{},samples=cost.samples||[],selected=item.referenceProvider==='public_cn';
 const statuses={ok:selected?'已用于采购参考':'已有核验参考',incomplete:'规格、库存、运费或卖家证据待补齐',no_verified_cost:'尚无满足条件的采购参考',no_results:'本轮未找到可核验的采购商品',error:'部分采购来源暂时无法读取',unavailable:'采购来源暂时受限，后续继续检查',deferred:'本轮检查时间已用完，后续继续核验'};
 const status=statuses[cost.status]||'等待云端检查';
 return `<section class="procurement-evidence"><h3>国内公开采购渠道</h3><p>${escape(status)}${cost.checkedAt?' · '+escape(new Date(cost.checkedAt).toLocaleString('zh-CN')):''}</p><p class="muted">来源独立核对规格、库存、人民币详情实价与国内运费，至少两家独立卖家通过后才生成参考。闲鱼受限时仍可执行。</p><ul class="samples">${samples.map(sample=>`<li><a target="_blank" rel="noopener" href="${link(sample.url||sample.canonicalUrl)}">${escape(sample.sellerName||sample.source||'采购来源')} · ${escape(sample.detailTitle||sample.title||'已核验商品')}</a><span>商品 ${cny(sample.unitCNY)}＋国内运费 ${cny(sample.shippingCNY)}＝${cny(sample.landedCNY??sample.price)}</span></li>`).join('')||'<li>尚未取得足够的合格详情报价。</li>'}</ul></section>`;
}
