import { PRICING_RULES_VERSION, pricingDecision } from './pricing-policy.js';
import { isOwnedOffer, isSelfOffer, normalizeOfferPlatform } from './owned-offers.js';
import { rejectedByMemory } from './match-memory.js';

// Read-only presentation of an individual detail read. These records never
// enter pricingDecision, coverage, automatic prices, or procurement costs.
const methods=new Set(['detail_type_quantity_text_images','detail_type_quantity_equivalent_text','strong_visual_primary_product','exact_bidirectional_title_identity','same_packaging_assortment','lottery_release_prize_character','same_sealed_single_box_primary','reviewed_sealed_box_identity']);
const text=value=>typeof value==='string'?value.trim():'';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function detailTime(value,now,maxAgeHours){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))return null;
 const stamp=Date.parse(value);
 if(!Number.isFinite(stamp)||new Date(stamp).toISOString().replace('.000Z','Z')!==value.replace('.000Z','Z')||stamp>now||now-stamp>maxAgeHours*3600000)return null;
 return stamp;
}
function detailUrl(row){
 if(!/^z\d+$/.test(text(row.id)))return null;
 const canonical=`https://paypayfleamarket.yahoo.co.jp/item/${row.id}`;
 // An exact item URL rejects alternate IDs, query-carried data, credentials,
 // non-HTTPS links, and recommendation/search pages without repairing them.
 return row.url===canonical?canonical:null;
}
function hasOwnership(index,item){
 const platform=normalizeOfferPlatform(item.platform,item.ownUrl||item.url),group=index?.[platform],yahoo=index?.yahoo;
 return Boolean(group?.items instanceof Set&&group?.sellers instanceof Set&&yahoo?.items instanceof Set&&yahoo?.sellers instanceof Set&&group.items.has(item.id));
}
export function savedYahooDetailObservations(item={}, {ownershipIndex,corrections,now=Date.now(),maxAgeHours=6}={}){
 if(!item||typeof item!=='object'||!Number.isFinite(now)||!Number.isFinite(maxAgeHours)||maxAgeHours<=0||!text(item.id)||!text(item.accountId)||!hasOwnership(ownershipIndex,item)||!corrections||typeof corrections!=='object'||Array.isArray(corrections))return [];
 if(Object.values(corrections).some(record=>!record||typeof record!=='object'||Array.isArray(record)))return [];
 const source=item.yahoo,audit=source?.audit;
 if(!source||!Array.isArray(source.candidates)||!Number.isInteger(source.rulesVersion)||source.rulesVersion<=0||source.rulesVersion>PRICING_RULES_VERSION||audit?.rulesVersion!==source.rulesVersion||audit?.ownItemId!==item.id||audit?.accountId!==item.accountId)return [];
 if(item.itemStatus&&item.itemStatus!=='OPEN'||['own_not_open','own_availability_unconfirmed'].includes(source.status)||/^own_/.test(source.knownRefresh?.reason||''))return [];
 const deferred=source.cacheReason==='request_error'||Boolean(text(source.deferredReason))||source.knownRefresh?.mode==='details_only'&&source.searchComplete===false;
 if(!deferred||!['cached','incomplete','error'].includes(source.status))return [];
 try{if(pricingDecision(item,{now,maxAgeHours}).canRecommend)return []}catch{return []}
 const rejected=[...(Array.isArray(source.rejected)?source.rejected:[]),...(Array.isArray(source.knownRefresh?.rejected)?source.knownRefresh.rejected:[])];
 const observations=new Map();
 for(const row of source.candidates){
  if(!row||typeof row!=='object'||row.isOwn||!text(row.sellerId)||!methods.has(row.matchMethod)||row.itemStatus!=='OPEN'||row.status&&row.status!=='OPEN'||row.priceSource!=='current_target_detail'||row.shippingSource!=='target_price_area'||row.shippingJPY!==0||!Number.isSafeInteger(row.price)||row.price<=0)continue;
  if(row.rulesVersion!==undefined&&row.rulesVersion!==source.rulesVersion)continue;
  const url=detailUrl(row),stamp=detailTime(row.checkedAt,now,maxAgeHours);
  if(!url||stamp===null||isSelfOffer(item,'yahoo',row)||isOwnedOffer(ownershipIndex,'yahoo',row)||rejectedByMemory(corrections,item,'yahoo',row)||rejected.some(value=>value?.id===row.id))continue;
  if([item.sellerId,item.sourceDetail?.sellerId,item.sourceDetail?.seller?.id].some(id=>id&&String(id)===row.sellerId))continue;
  // The audit binds only the saved account/listing IDs. It does not bind the
  // current target's title, images or sale contents, so even current-version
  // reads are explicitly pending same-product verification in this UI lane.
  const observation={id:row.id,url,title:text(row.title)||row.id,price:row.price,shippingJPY:0,checkedAt:row.checkedAt,historicalRules:source.rulesVersion!==PRICING_RULES_VERSION};
  const previous=observations.get(row.id);
  if(!previous||stamp>Date.parse(previous.checkedAt))observations.set(row.id,observation);
 }
 return [...observations.values()].sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt));
}
export function comparisonObservationsMarkup(item={},options={}){
 const rows=savedYahooDetailObservations(item,options);
 if(!rows.length)return '';
 return `<section class="manualbox comparison-observations" aria-label="已保存的 Yahoo 详情读数"><h3>已保存的 Yahoo 详情读数</h3><p>广搜更新未完成，暂不生成自动建议</p><p class="muted">以下来自详情子检查，仅展示保存读数；不代表本轮最终比价、最低同款或当前可购承诺。</p><ul class="samples">${rows.map(row=>`<li data-observation-id="${escape(row.id)}"><a target="_blank" rel="noopener" href="${escape(row.url)}">${escape(row.title)} ↗</a><span><b>¥${row.price.toLocaleString('ja-JP')}</b> · 记录时运费 ¥0</span><span>${row.historicalRules?'历史规则读数，未按当前规则核验同款':'历史详情读数，当前同款关系待核验'}</span><span>详情原始读取时间：<time datetime="${escape(row.checkedAt)}">${escape(row.checkedAt)}</time></span></li>`).join('')}</ul></section>`;
}
