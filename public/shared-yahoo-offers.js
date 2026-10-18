import {PRICING_RULES_VERSION} from './pricing-policy.js';
import {isOwnedOffer,normalizeOfferPlatform} from './owned-offers.js';
import {rejectedByMemory} from './match-memory.js';

const methods=new Set(['detail_type_quantity_text_images','detail_type_quantity_equivalent_text','strong_visual_primary_product','exact_bidirectional_title_identity','same_packaging_assortment','lottery_release_prize_character','same_sealed_single_box_primary','reviewed_sealed_box_identity']);
const canonical=id=>`https://paypayfleamarket.yahoo.co.jp/item/${id}`;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const stamp=value=>typeof value==='string'?Date.parse(value):NaN;
const safeUrl=value=>{try{const url=new URL(value);return typeof value==='string'&&url.protocol==='https:'&&!url.username&&!url.password}catch{return false}};
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));
const sourceKeys=['version','kind','url','status','redirected','observedAt','bodySha256Scope','bodySha256','parsedSha256'];
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
const escaped=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function sharedYahooTargetBinding(item={}){
 return {accountId:item.accountId,id:item.id,platform:normalizeOfferPlatform(item.platform),title:item.title,image:item.image,
  ownPrice:item.ownPrice,sellerId:item.sellerId};
}
function sourceBound(source,id,time){
 return source?.version===1&&source.kind==='original_yahoo_detail_body'&&source.url===canonical(id)&&source.status===200&&source.redirected===false&&
  source.observedAt===time&&source.bodySha256Scope==='decoded_response_html_utf8'&&hex(source.bodySha256)&&hex(source.parsedSha256);
}
// Separate display-only schema. No pricingDecision/coverage consumer imports
// these rows, even after strict pair verification succeeds.
export function currentSharedYahooOffers(item={}, {ownershipIndex,corrections,now=Date.now()}={}){
 const own=ownershipIndex?.yahoo;
 if(!safeId(item.id)||!safeId(item.accountId)||normalizeOfferPlatform(item.platform)!=='yahoo'||!(own?.items instanceof Set)||!(own?.sellers instanceof Set)||
  !own.items.has(item.id)||!own.sellers.has(item.sellerId)||!corrections||typeof corrections!=='object'||Array.isArray(corrections)||!Number.isFinite(now))return [];
 if(item.itemStatus!=='OPEN'||['own_not_open','own_availability_unconfirmed'].includes(item.yahoo?.status))return [];
 const target=JSON.stringify(sharedYahooTargetBinding(item)),seen=new Set(),output=[];
 for(const row of (Array.isArray(item.sharedYahooOffers)?item.sharedYahooOffers:[]).slice(0,32)){
  const candidateAt=stamp(row?.checkedAt),ownAt=stamp(row?.ownObservedAt),verifiedAt=stamp(row?.identityVerifiedAt),cycle=stamp(row?.cycleStartedAt);
  if(row?.version!==1||row.evidenceType!=='current_shared_detail_pair'||row.rulesVersion!==PRICING_RULES_VERSION||JSON.stringify(row.target)!==target||
   !safeId(row.id)||seen.has(row.id)||row.id===item.id||row.url!==canonical(row.id)||!safeId(row.sellerId)||typeof row.title!=='string'||!row.title.trim()||!safeUrl(row.image)||
   !Number.isFinite(row.price)||row.price<=0||row.currency!=='JPY'||row.shippingJPY!==0||row.shippingSource!=='target_price_area'||row.itemStatus!=='OPEN'||
   !methods.has(row.matchMethod)||row.discoveryComplete!==false||row.canRecommend!==false||row.costEligible!==false||
   ![candidateAt,ownAt,verifiedAt,cycle].every(Number.isFinite)||cycle>Math.min(candidateAt,ownAt)||Math.max(candidateAt,ownAt)>verifiedAt||verifiedAt>now||now-Math.min(candidateAt,ownAt)>=20*60_000||
   !sourceBound(row.ownSource,item.id,ownAt)||!sourceBound(row.candidateSource,row.id,candidateAt)||
   row.verification?.version!==1||row.verification.source!=='evaluate_yahoo_detail'||row.verification.rulesVersion!==PRICING_RULES_VERSION||!hex(row.verification.digest)||
   row.verification.ownObservedAt!==ownAt||row.verification.candidateObservedAt!==candidateAt||row.verification.verifiedAt!==verifiedAt||
   !Array.isArray(row.imageEvidence)||!row.imageEvidence.length||row.imageEvidence.length>20||
   row.imageEvidence.some(value=>!safeUrl(value?.url)||!hex(value.contentSha256)||!Number.isFinite(stamp(value.imageObservedAt))||stamp(value.imageObservedAt)>verifiedAt||!Number.isFinite(value.imageCacheExpiresAt)||value.imageCacheExpiresAt<=now)||
   isOwnedOffer(ownershipIndex,'yahoo',row)||rejectedByMemory(corrections,item,'yahoo',row))continue;
  seen.add(row.id);output.push({...pick(row,['version','evidenceType','rulesVersion','id','url','title','image','sellerId','price','currency','shippingJPY','shippingSource','itemStatus','matchMethod','checkedAt','ownObservedAt','identityVerifiedAt','cycleStartedAt','discoveryComplete','canRecommend','costEligible']),
   target:sharedYahooTargetBinding(item),ownSource:pick(row.ownSource,sourceKeys),candidateSource:pick(row.candidateSource,sourceKeys),
   verification:pick(row.verification,['version','source','rulesVersion','digest','ownObservedAt','candidateObservedAt','verifiedAt']),
   imageEvidence:row.imageEvidence.map(value=>pick(value,['url','contentSha256','imageObservedAt','imageCacheExpiresAt']))});
 }
 return output.sort((a,b)=>a.price-b.price).slice(0,5);
}
export function sharedYahooOffersMarkup(item,options={}){
 const rows=currentSharedYahooOffers(item,options);if(!rows.length)return '';
 return `<section class="manualbox shared-yahoo-offers" aria-label="共享详情核验报价"><h3>本轮已核验同款报价</h3><p>复用了已读取的详情与图片证据。其他候选发现范围仍未完成，此区域不生成自动调价或采购成本。</p><ul class="samples">${rows.map(row=>`<li><a href="${escaped(row.url)}" target="_blank" rel="noopener">${escaped(row.title)} ↗</a><span><b>¥${escaped(row.price.toLocaleString('ja-JP'))}</b> · 运费 ¥0</span><span>竞品详情读取：${escaped(row.checkedAt)}</span><span><a href="${escaped(row.ownSource.url)}" target="_blank" rel="noopener">自有商品 ↗</a> · 详情读取：${escaped(row.ownObservedAt)}</span><span>同款复核：${escaped(row.identityVerifiedAt)}</span></li>`).join('')}</ul></section>`;
}
