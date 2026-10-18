import {createHash} from 'node:crypto';
import {PRICING_RULES_VERSION} from '../../public/pricing-policy.js';

const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
const str=value=>typeof value==='string'?value:null;
const snapshot=detail=>({id:str(detail?.id),sellerId:str(detail?.seller?.id||detail?.sellerId),title:str(detail?.title),
 description:str(detail?.description),status:str(detail?.status),price:Number(detail?.price),
 images:(detail?.images||[]).map(image=>str(typeof image==='string'?image:image?.url)),condition:detail?.condition||null,
 category:detail?.category||null,categoryId:detail?.categoryId||null,categoryList:detail?.categoryList||null,productCategory:detail?.productCategory||null});

// A digest binding the pair and retained detail fields used by the actual evaluator. This
// is a binding receipt, not a signature, and grants no independent quote rights.
// Missing original transport clocks deliberately cannot mint future history.
export function yahooDetailVerificationDigest({item,ownDetail,candidateDetail,ownObservedAt,candidateObservedAt,rulesVersion=PRICING_RULES_VERSION}={}){
 if(!str(item?.accountId)||!str(item?.id)||!time(ownObservedAt)||!time(candidateObservedAt)||
  !Array.isArray(ownDetail?.images)||!Array.isArray(candidateDetail?.images))return null;
 const input={version:1,rulesVersion,item:{id:item.id,accountId:item.accountId,sellerId:str(item.sellerId),title:str(item.title),
  ownPrice:Number(item.ownPrice),relistedFrom:str(item.relistedFrom)},own:snapshot(ownDetail),candidate:snapshot(candidateDetail),ownObservedAt,candidateObservedAt};
 return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function yahooDetailVerificationContext({digest,verifiedAt,ownObservedAt,candidateObservedAt}={}){
 if(!digest||!time(verifiedAt)||verifiedAt<Math.max(ownObservedAt,candidateObservedAt))return null;
 return {version:1,source:'evaluate_yahoo_detail',rulesVersion:PRICING_RULES_VERSION,digest,
  ownObservedAt,candidateObservedAt,verifiedAt};
}
