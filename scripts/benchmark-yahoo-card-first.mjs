import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {runYahooCardFirst} from './lib/yahoo-card-first.mjs';
import {evaluateYahooDetail,categoryText,exactQueryFor} from './lib/yahoo.mjs';
import {frozenYahooCardFirstCases,frozenAt,fixtureDisclosure,primary,frozenSettings} from '../test/fixtures/yahoo-card-first-audit.mjs';

export async function auditYahooCardFirst(){
 const rows=frozenYahooCardFirstCases(),results=new Map();let baselineReads=0;
 const verifyDetail=(row,bundle)=>evaluateYahooDetail({item:row.item,card:row.card,bundle,ownDetail:row.ownDetail,
  ownSellerId:row.item.sellerId,ownConditionText:row.ownDetail.title+'\n'+row.ownDetail.description,
  ownCategory:categoryText(row.ownDetail),exactQuery:exactQueryFor(row.item.title),
  ownFingerprints:[row.ownPrimary],ownImageEvidence:[row.ownPrimary],settings:{}},
  {imageFingerprints:async()=>primary});
 const readDetail=async row=>{if(!row.bundle)throw Error('controlled unavailable detail response');return structuredClone(row.bundle)};
 let start=performance.now();
 for(const row of rows){baselineReads++;try{results.set(row.key,await verifyDetail(row,await readDetail(row)))}catch(error){results.set(row.key,{error:String(error)})}}
 const baselineCpuWallMs=performance.now()-start;
 start=performance.now();const fast=await runYahooCardFirst(rows,{readDetail,verifyDetail,settings:frozenSettings(rows),now:Date.parse(frozenAt)});
 const cardFirstCpuWallMs=performance.now()-start;
 const details=fast.outcomes.map(outcome=>{
  const row=rows.find(r=>r.key===outcome.key),baseline=results.get(outcome.key),baselineLower=Boolean(baseline.candidate&&baseline.candidate.price<row.item.ownPrice);
  const cardLower=outcome.observation?.priceJPY<row.item.ownPrice;
  const detailLower=Boolean(outcome.detailResult?.candidate&&outcome.detailResult.candidate.price<row.item.ownPrice);
  const expectedLower=row.expectedComparable===true&&Number(row.bundle?.detail?.price)<row.item.ownPrice;
  return {key:row.key,expectedComparable:row.expectedComparable,expectedLower,cardId:row.card.id,ownPrice:row.item.ownPrice,cardPrice:row.card.price,
   baselineStatus:baseline.error?'unavailable':baseline.candidate?'accepted':'rejected',baselineReason:baseline.rejection?.reason||null,
   baselinePrice:baseline.candidate?.price??null,fastMode:outcome.mode,fastReason:outcome.reason,
   detailRead:outcome.mode==='detail_required',baselineLower,lowerPriceFlag:cardLower||detailLower,
   detailVerifiedLower:detailLower,missedLower:baselineLower&&!cardLower&&!detailLower,
   falseLowerFlag:!baseline.error&&!baselineLower&&(cardLower||detailLower),
   unverifiedLower:baselineLower&&cardLower&&!detailLower,baselineUnavailable:!!baseline.error,
   baselineFalseAcceptance:row.expectedComparable===false&&Boolean(baseline.candidate),
   fastFalseAcceptance:row.expectedComparable===false&&Boolean(outcome.detailResult?.candidate),
   gapJPY:baselineLower?row.item.ownPrice-baseline.candidate.price:null};
 });
 return {version:1,kind:'controlled_frozen_paired_audit',fixtureDisclosure,frozenAt,totalCases:rows.length,
  baseline:{detailRequests:baselineReads,cpuWallMs:baselineCpuWallMs,unavailable:details.filter(r=>r.baselineUnavailable).length},
  cardFirst:{detailRequests:fast.detailRequests,cpuWallMs:cardFirstCpuWallMs,cardOnlyObservations:fast.outcomes.filter(r=>r.mode==='card_observation').length,
   acceptedDetailQuotes:fast.outcomes.filter(r=>r.detailResult?.candidate).length,canRecommendFromCard:false},
  comparison:{detailRequestsSaved:baselineReads-fast.detailRequests,savingFraction:(baselineReads-fast.detailRequests)/baselineReads,
   baselineVerifiedLower:details.filter(r=>r.baselineLower).length,missedLowerFlags:details.filter(r=>r.missedLower),
   falseLowerFlags:details.filter(r=>r.falseLowerFlag),lowerFlaggedButNotDetailVerified:details.filter(r=>r.unverifiedLower),
   baselineUnavailable:details.filter(r=>r.baselineUnavailable),falseAcceptedDetailQuotesRelativeToBaseline:details.filter(r=>r.detailVerifiedLower&&!r.baselineLower),
   baselineFalseAcceptancesAgainstFixtureTruth:details.filter(r=>r.baselineFalseAcceptance),
   fastFalseAcceptancesAgainstFixtureTruth:details.filter(r=>r.fastFalseAcceptance)},
  groundTruth:{knownCases:details.filter(r=>r.expectedComparable!==null).length,unknownCases:details.filter(r=>r.expectedComparable===null).length,
   lowerOffers:details.filter(r=>r.expectedLower).length,
   missedLowerAlerts:details.filter(r=>r.expectedLower&&!r.lowerPriceFlag),
   falseLowerAlerts:details.filter(r=>r.expectedComparable===false&&r.lowerPriceFlag),
   baselineMissedLower:details.filter(r=>r.expectedLower&&!r.baselineLower),
   baselineFalseLower:details.filter(r=>r.expectedComparable===false&&r.baselineLower)},
  details,limits:['CPU timings exclude all network and cannot predict live elapsed time.','A provisional lower-price flag is not a verified comparable price.','No live false-negative rate is established.','Current raw recommendation parser has no available-stock receipt; provisional alerts retain availability unconfirmed.','No supplier-cost or production scheduling behavior is changed.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=await auditYahooCardFirst();const text=JSON.stringify(result,null,2)+'\n';if(process.argv[2])await fs.writeFile(process.argv[2],text);else process.stdout.write(text)}
