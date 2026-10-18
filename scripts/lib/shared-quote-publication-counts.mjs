import {buildOwnedOffers,isOwnedOffer,normalizeOfferPlatform} from '../../public/owned-offers.js';
import {rejectedByMemory} from '../../public/match-memory.js';
import {pricingDecision} from '../../public/pricing-policy.js';

const targetKey=item=>JSON.stringify([item.accountId,item.id]);
const pairKey=(item,id)=>JSON.stringify([item.accountId,item.id,id]);
const hasId=value=>typeof value==='string'&&value.length>0;
const failure=()=>({version:1,valid:false,reason:'summary_unavailable'});
function sharedRows(items){
 if(!Array.isArray(items))throw Error();
 const pairs=new Set(),targets=new Set(),lower=new Set();let rows=0;
 for(const item of items){
  if(item?.sharedYahooOffers===undefined)continue;
  if(!Array.isArray(item.sharedYahooOffers))throw Error();
  rows+=item.sharedYahooOffers.length;
  if(!item.sharedYahooOffers.length)continue;
  if(!hasId(item.accountId)||!hasId(item.id))throw Error();
  targets.add(targetKey(item));
  for(const offer of item.sharedYahooOffers){
   // Raw pre-filter rows can include invalid hints without an offer ID.
   if(!hasId(offer?.id))continue;
   const key=pairKey(item,offer.id);pairs.add(key);
   if(Number.isFinite(offer.price)&&Number.isFinite(item.ownPrice)&&offer.price<item.ownPrice)lower.add(key);
  }
 }
 return {rows,pairs,targets,lower};
}

// Capture before publication replaces sharedYahooOffers, without retaining any
// private rows or letting malformed diagnostic input interrupt publication.
export function countSharedQuoteRows(items=[]){
 try{const {rows,pairs,targets}=sharedRows(items);return {valid:true,rows,pairs:pairs.size,targets:targets.size};}
 catch{return failure();}
}

// This describes the actual full-state preparation snapshot after publication's
// currentSharedYahooOffers filter, not deployment, a member payload or browser
// visibility. Offers can expire later. No evidence or refresh clock is renewed.
export function summarizeSharedQuotePublication(result={}, {before,now=Date.now()}={}){
 try{
  if(!before?.valid||![before.rows,before.pairs,before.targets].every(value=>Number.isSafeInteger(value)&&value>=0)||!Number.isFinite(now))throw Error();
  const evaluatedAt=new Date(now).toISOString(),items=result.items||[],after=sharedRows(items);
  const stored=new Set(),eligible=new Set(),storedTargets=new Set(),eligibleTargets=new Set();
  // The global ownership/history context matters even when only one account has
  // shared quotes. Skip unrelated targets: this diagnostic must remain cheap.
  if(after.pairs.size){
   const ownership=buildOwnedOffers([...(result.accounts||[]),...(result.managedAccounts||[])],[...items,...Object.values(result.listingHistory||{})]);
   for(const item of items){
    const target=targetKey(item);
    if(!after.targets.has(target)||normalizeOfferPlatform(item.platform)!=='yahoo')continue;
    for(const candidate of item.yahoo?.candidates||[]){
     if(!hasId(candidate?.id))continue;
     const pair=pairKey(item,candidate.id);stored.add(pair);storedTargets.add(target);
     // Ask the real policy about each ordinary candidate. Shared offers never
     // enter candidates, pricing, costs or coverage, even for this calculation.
     if(!isOwnedOffer(ownership,'yahoo',candidate)&&!rejectedByMemory(result.matchCorrections,item,'yahoo',candidate)&&
      pricingDecision({...item,comparisonMode:'same_platform',yahoo:{...item.yahoo,candidates:[candidate]}},{now}).lowest?.id===candidate.id){
      eligible.add(pair);eligibleTargets.add(target);
     }
    }
   }
  }
  const overlap=set=>[...after.pairs].filter(pair=>set.has(pair)).length;
  const storedOverlap=overlap(stored),eligibleOverlap=overlap(eligible);
  return {version:1,valid:true,scope:'full_state_publication_preparation',evaluatedAt,
   preFilterSharedRows:before.rows,preFilterSharedPairs:before.pairs,preFilterSharedTargets:before.targets,
   postFilterSharedRows:after.rows,postFilterSharedPairs:after.pairs.size,postFilterSharedTargets:after.targets.size,
   samePairAlreadyInOrdinaryStorage:storedOverlap,pairsAbsentFromOrdinaryStorage:after.pairs.size-storedOverlap,
   samePairEligibleInOrdinaryPricing:eligibleOverlap,pairsAdditionalToEligibleOrdinaryPricing:after.pairs.size-eligibleOverlap,
   sharedTargetsWithoutAnyStoredOrdinaryCandidate:[...after.targets].filter(target=>!storedTargets.has(target)).length,
   sharedTargetsWithoutAnyEligibleOrdinaryQuote:[...after.targets].filter(target=>!eligibleTargets.has(target)).length,
   lowerListedSharedPairs:after.lower.size};
 }catch{return failure();}
}
