import { MATCHING_RULES_VERSION } from './rules.mjs';
import { isOwnedOffer } from '../../public/owned-offers.js';
import { rejectedByMemory } from '../../public/match-memory.js';

const methods=new Set(['detail_type_quantity_text_images','detail_type_quantity_equivalent_text','strong_visual_primary_product','exact_bidirectional_title_identity','same_packaging_assortment','lottery_release_prize_character','same_sealed_single_box_primary','reviewed_sealed_box_identity']);
const timestamp=value=>{const result=Date.parse(value||'');return Number.isFinite(result)?result:0};
const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const visibleHtml=value=>{
 const stack=[],voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);let output='';
 for(const token of String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,'').match(/<!--[^]*?-->|<[^>]*>|[^<]+/g)||[]){
  const closing=token.match(/^<\/([\w-]+)/),opening=token.match(/^<([\w-]+)\b([^>]*)>/);
  if(closing){const name=closing[1].toLowerCase(),index=stack.map(row=>row.name).lastIndexOf(name);if(!stack.some(row=>row.hidden))output+=token;if(index>=0)stack.length=index;continue}
  if(opening){const name=opening[1].toLowerCase(),attrs=opening[2],hidden=stack.some(row=>row.hidden)||/\shidden(?:\s|=|$)/i.test(attrs)||/aria-hidden\s*=\s*["']?true/i.test(attrs)||/style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\s|;|["']))/i.test(attrs);
   if(!hidden)output+=token;if(!voidTags.has(name)&&!token.endsWith('/>'))stack.push({name,hidden});continue}
  if(!stack.some(row=>row.hidden))output+=token;
 }return output;
};
const htmlText=value=>String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&nbsp;/g,' ').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();

// Item-local price-area evidence only: no footer policy, recommendation, or
// arbitrary seller prose can supply shipping for this target listing.
export function yahooTargetShipping(html='',detail={}){
 const unknown={shippingKnown:false,shippingJPY:null,currency:null,shippingSource:null};
 const price=Number(detail.price);if(!detail.title||!Number.isFinite(price)||price<=0)return unknown;
 const clean=visibleHtml(html);
 const heading=[...clean.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].find(match=>normalize(htmlText(match[1]))===normalize(detail.title));
 if(!heading)return unknown;
 const start=heading.index+heading[0].length,endings=['</main>','</article>','<footer'].map(marker=>clean.toLowerCase().indexOf(marker,start)).filter(index=>index>=0);
 const tail=clean.slice(start,endings.length?Math.min(...endings):undefined).split(/<h[12]\b/i)[0].slice(0,12000);
 // Bind both observations to the same target price container. Yahoo repeats
 // responsive price spans; plain prose or site-wide shipping labels are not evidence.
 const root={children:[]},stack=[root],nodes=[];
 for(const token of tail.match(/<[^>]*>|[^<]+/g)||[]){
  const close=token.match(/^<\/([\w-]+)/),open=token.match(/^<([\w-]+)\b([^>]*)>/);
  if(close){const index=stack.map(node=>node.tag).lastIndexOf(close[1].toLowerCase());if(index>0)stack.length=index;continue}
  if(open){const node={tag:open[1].toLowerCase(),attrs:open[2],children:[],parent:stack.at(-1)};node.parent.children.push(node);nodes.push(node);if(!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(node.tag)&&!token.endsWith('/>'))stack.push(node)}
  else stack.at(-1).children.push(token);
 }
 const nodeText=node=>typeof node==='string'?node:node.children.map(nodeText).join(' ');
 const amounts=[String(price),price.toLocaleString('en-US')].map(value=>value.replace(/[.*+?^$\{\}()|[\]\\]/g,'\\$&'));
 const pricePattern=new RegExp('(?:^|[^0-9])(?:'+amounts.join('|')+')\\s*円');
 const confirmed=nodes.some(node=>/class\s*=\s*["'][^"']*ItemPrice__Component/.test(node.attrs)&&pricePattern.test(htmlText(nodeText(node)))&&
  node.parent.children.some(sibling=>typeof sibling!=='string'&&/class\s*=\s*["'][^"']*ItemDetail__ShippingFreeLabel/.test(sibling.attrs)&&htmlText(nodeText(sibling))==='送料無料'));
 if(!confirmed)return unknown;
 return {shippingKnown:true,shippingJPY:0,currency:'JPY',shippingSource:'target_price_area'};
}

export function knownYahooCandidates(item,settings={}){
 const prior=item?.yahoo||{},audit=prior.audit||{};
 if(item.platform&& !['yahoo','yahoo_fleamarket'].includes(item.platform))return [];
 if(!item.accountId||audit.accountId!==item.accountId||audit.ownItemId!==item.id||prior.rulesVersion!==MATCHING_RULES_VERSION||!timestamp(prior.checkedAt)||!['ok','incomplete'].includes(prior.evidenceStatus||prior.status))return [];
 const seen=new Set();
 return (prior.candidates||[]).filter(card=>{
  if(!card||seen.has(card.id)||!/^\w[\w-]*$/.test(card.id||'')||card.id===item.id||card.isOwn||!card.sellerId||!card.title||!card.image||!(Number(card.price)>0)||!methods.has(card.matchMethod))return false;
  if(isOwnedOffer(settings.ownedOffers,'yahoo',card)||rejectedByMemory(settings.matchCorrections,item,'yahoo',card)||item.sellerId&&card.sellerId===item.sellerId)return false;
  seen.add(card.id);return true;
 }).sort((a,b)=>Number(a.price)-Number(b.price));
}

export function yahooFullAttemptTime(prior={}){
 return timestamp(prior.lastFullAttemptAt)||Math.max(timestamp(prior.lastAttemptAt),timestamp(prior.checkedAt));
}

export function knownYahooRefreshTasks(contexts,settings={},now=Date.now()){
 const interval=Math.max(1,Number(settings.yahooFreshMinutes)||20)*60_000;
 const accountAttempt=context=>Math.max(0,...context.activeItems.map(item=>timestamp(context.previousById.get(item.id)?.yahoo?.knownLastAttemptAt)));
 const buckets=[...contexts].sort((a,b)=>accountAttempt(a)-accountAttempt(b)).map(context=>context.activeItems.map(item=>{
  const prior=context.previousById.get(item.id)||{};
  const observed={...item,yahoo:prior.yahoo};
  const candidates=knownYahooCandidates(observed,settings);
  const attempted=timestamp(prior.yahoo?.knownLastAttemptAt)||timestamp(prior.yahoo?.checkedAt);
  return {context,item,prior,candidates,attempted};
 }).filter(task=>task.candidates.length&&now-task.attempted>=interval).sort((a,b)=>a.attempted-b.attempted||String(a.item.id).localeCompare(String(b.item.id))));
 const tasks=[];for(let i=0;buckets.some(bucket=>i<bucket.length);i++)for(const bucket of buckets)if(bucket[i])tasks.push(bucket[i]);
 return tasks;
}

export function keepKnownYahooRefresh(prior={},result,attemptedAt=new Date().toISOString()){
 const lastFullAttemptAt=prior.lastFullAttemptAt||prior.lastAttemptAt||prior.checkedAt||null;
 if(result?.candidates?.length&&result.knownRefresh?.mode==='details_only'){
  return {...result,status:'incomplete',evidenceStatus:'incomplete',searchComplete:false,cacheReason:null,lastFullAttemptAt,knownLastAttemptAt:attemptedAt,lastAttemptAt:prior.lastAttemptAt||prior.checkedAt||null};
 }
 // Never relabel an old price as current after a failed read. Preserve the
 // evidence for history, but stop using it for repricing until a real check passes.
 return {...prior,cacheReason:'request_error',lastFullAttemptAt,knownLastAttemptAt:attemptedAt,
  knownRefresh:{mode:'failed',attemptedAt,reason:result?.knownRefresh?.reason||'no_verified_known_offer',rejected:(result?.rejected||[]).map(row=>({id:row.id,reason:row.reason})).slice(0,2)}};
}

export async function runKnownYahooRefresh(tasks,{lookup,deadline,limit=Infinity,concurrency=2,now=Date.now,log=()=>{}}={}){
 let cursor=0,admitted=0;const completed=new Map();
 await Promise.all(Array.from({length:Math.max(1,Math.min(2,concurrency))},async()=>{
  while(cursor<tasks.length&&admitted<limit&&now()<deadline){
   const task=tasks[cursor++];admitted++;
   let result;try{result=await lookup(task,{deadline})}catch{result=null}
   const attemptedAt=new Date(now()).toISOString(),value=keepKnownYahooRefresh(task.prior.yahoo||{},result,attemptedAt);
   completed.set(task.context.account.id+':'+task.item.id,{task,value});
   log({accountId:task.context.account.id,itemId:task.item.id,attemptedAt,verified:result?.candidates?.length||0,checkedAt:value.checkedAt||null,knownIds:(result?.candidates||[]).map(row=>row.id),reason:value.knownRefresh?.reason||null,offers:(result?.candidates||[]).map(row=>({id:row.id,price:row.price,sellerId:row.sellerId,shippingJPY:row.shippingJPY,shippingSource:row.shippingSource,matchMethod:row.matchMethod})),rejected:(result?.rejected||[]).map(row=>({id:row.id,reason:row.reason})).slice(0,2)});
  }
 }));
 return completed;
}
