// Shared by cloud publication and every client view. Old snapshots are evidence, not actions.
export const PRICING_RULES_VERSION=20;
export const PRICING_PLATFORMS=['yahoo','rakuma','mercari'];
export const PLATFORM_LABELS={yahoo:'Yahoo!フリマ',rakuma:'Rakuma',mercari:'煤炉 Mercari'};
const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
export function pricingDecision(item={}, {now=Date.now(),maxAgeHours=6,minimumRaiseGapJPY=1500}={}){
 const own=amount(item.ownPrice),coverage={},candidates=[],guards=[];
 for(const platform of PRICING_PLATFORMS){
  const source=item[platform]||{},stamp=Date.parse(source.checkedAt||'');
  const fresh=Number.isFinite(stamp)&&stamp<=now+60000&&now-stamp<=maxAgeHours*3600000;
  coverage[platform]=source.rulesVersion===PRICING_RULES_VERSION&&fresh&&['ok','cached'].includes(source.status)&&(source.evidenceStatus||source.status)!=='incomplete'&&source.cacheReason!=='request_error';
  if(source.rulesVersion!==PRICING_RULES_VERSION||!fresh)continue;
  for(const value of source.candidates||[])if(amount(value.price)&&value.matchMethod&&value.url&&!value.isOwn)candidates.push({...value,platform});
  for(const value of [source.raiseGuardMinPrice,source.plausibleMinPrice])if(amount(value))guards.push(value);
 }
 candidates.sort((a,b)=>a.price-b.price);
 const lowest=candidates[0]||null,complete=PRICING_PLATFORMS.every(p=>coverage[p]);
 let recommendedPrice=own;
 if(complete&&own&&lowest){
  const floor=Math.min(lowest.price,...guards),sellerCount=new Set(candidates.filter(c=>c.sellerId||c.sellerKey).map(c=>c.platform+':'+(c.sellerId||c.sellerKey))).size;
  if(lowest.price<=own)recommendedPrice=Math.max(1,Math.floor(lowest.price)-1);
  else if(sellerCount>=2&&floor-own>=minimumRaiseGapJPY&&(floor-own)/own>=.03)recommendedPrice=Math.max(own,Math.floor(floor)-1);
 }
 return {complete,coverage,lowest,recommendedPrice,priceSignal:recommendedPrice>own?'raise':recommendedPrice<own?'lower':'hold',comparisonIncomplete:!complete};
}
