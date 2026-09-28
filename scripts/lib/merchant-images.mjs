import { fetchYahooResult,fetchYahooItemBundle,exactQueryFor } from './yahoo.mjs';
import { sameMerchantProduct } from './merchant-curation.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { imageFingerprints,primaryProductSimilarity } from './image.mjs';

// An independent public image lookup, not a procurement reference. No guessed
// price, currency, shipping or search thumbnail is accepted as cost evidence.
export async function findMerchantImages(item,{settings={},deadline=Infinity,search=fetchYahooResult,detail=fetchYahooItemBundle,fingerprint=imageFingerprints}={}){
 if(!item.description||Date.now()>=deadline)return [];
 const source=(item.images||[])[0]||item.image;if(!source)return [];
 const query=exactQueryFor(item.title),result=await search(`https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(query)}`,settings);
 const own=await fingerprint(source),photos=[];
 for(const card of (result.items||[]).filter(c=>c.id!==item.id&&sameMerchantProduct({title:item.title,image:source},{title:c.title,image:c.thumbnailImageUrl})).slice(0,3)){
  if(Date.now()>=deadline)break;
  const d=(await detail(card.id,settings)).detail;
  if(d.id!==card.id||String(d.seller?.id||'')===item.merchant?.id||!d.description)continue;
  const images=(d.images||[]).map(i=>typeof i==='string'?i:i.url).filter(u=>/^https:\/\//.test(u||''));
  const score=primaryProductSimilarity(own,await fingerprint(images[0]));
  if(!Number.isFinite(score)||score<.94||!sameMerchantProduct(item,{title:d.title,description:d.description,image:images[0]}))continue;
  if(!offerIdentityGuard({ownTitle:item.title,ownDescription:item.description,candidateTitle:d.title,candidateDescription:d.description,primaryImageScore:score}).accepted)continue;
  for(const url of images)photos.push({url,sourceUrl:`https://paypayfleamarket.yahoo.co.jp/item/${d.id}`,platform:'yahoo',verification:'detail_identity_primary_image',primaryImageScore:score});
  if(photos.length)break;
 }
 return photos.slice(0,8);
}
