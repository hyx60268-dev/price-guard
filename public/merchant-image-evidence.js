import { allowedMerchantPhotoSource } from './merchant-records.js';
// Only evidence attached by a product-specific review may label a photograph
// official or real. A hostname, a matching thumbnail, or a seller is insufficient.
export const usableMerchantImage=p=>!!p&&allowedMerchantPhotoSource(p.url)&&allowedMerchantPhotoSource(p.sourceUrl);
export function merchantImageAssetKey(p={}){
 if(p.assetId)return String(p.assetId);
 if(p.contentHash)return 'hash:'+p.contentHash;
 try{const u=new URL(p.url);u.hash='';for(const key of ['x-oss-process','imageView2','imageMogr2'])u.searchParams.delete(key);u.pathname=u.pathname.replace(/!(?:middle|small|large)\.(?:jpg|png)$/i,'');return u.href}catch{return String(p.url||'')}
}
const reviewed=p=>p.verification==='reviewed_exact_product_variant'&&Number.isFinite(Date.parse(p.reviewedAt||''));
const official=p=>reviewed(p)&&p.kind==='official_image'&&p.provenance?.authority==='brand_official_store'&&p.provenance?.reviewed===true&&allowedMerchantPhotoSource(p.provenance?.evidenceUrl);
const physical=p=>reviewed(p)&&p.kind==='physical_photo';
const rank=p=>official(p)?3:physical(p)?2:1;
export function mergeMerchantImages(...lists){
 const assets=new Map();
 for(const p of lists.flat().filter(usableMerchantImage)){const key=merchantImageAssetKey(p),old=assets.get(key);if(!old||rank(p)>rank(old)||rank(p)===rank(old)&&p.photoEvidence&&!old.photoEvidence)assets.set(key,p)}
 return [...assets.values()].sort((a,b)=>rank(b)-rank(a));
}
export function merchantImageSet(item={}){
 const all=mergeMerchantImages(item.webImages||[],item.xianyuImages||[]),officialImages=all.filter(official).slice(0,2),physicalImages=all.filter(physical);
 const byGroup=new Map();
 for(const p of physicalImages){
  const e=p.photoEvidence;
  if(!e?.publisherId||!e.shootId||!e.sceneId||!e.angleId||e.reviewedSameScene!==true||!Number.isFinite(Date.parse(e.reviewedAt||'')))continue;
  const key=JSON.stringify([e.publisherId,e.shootId,e.sceneId]);if(!byGroup.has(key))byGroup.set(key,{publisherId:e.publisherId,shootId:e.shootId,sceneId:e.sceneId,photos:[]});
  const group=byGroup.get(key);
  // Different URLs/sizes/crops and labels for one view never count as angles.
  if(!group.photos.some(old=>old.photoEvidence.angleId===e.angleId||old.visualAssetId&&old.visualAssetId===p.visualAssetId))group.photos.push(p);
 }
 const groups=[...byGroup.values()].sort((a,b)=>b.photos.length-a.photos.length),photos=(groups[0]?.photos||[]).slice(0,6);
 const selected=new Set([...officialImages,...photos].map(merchantImageAssetKey)),other=all.filter(p=>!selected.has(merchantImageAssetKey(p)));
 const missing=[],reasons=[];
 if(!officialImages.length){missing.push('official_images');reasons.push('official_provenance_missing')}
 if(photos.length<2){missing.push('coherent_photos');reasons.push(physicalImages.length?'photo_group_incomplete':'physical_photo_evidence_missing')}
 const complete=!missing.length;
 const candidates=(item.webImageDiagnostics?.candidates||[]).filter(p=>usableMerchantImage(p)&&!all.some(image=>merchantImageAssetKey(image)===merchantImageAssetKey(p)));
 return {official:officialImages,photos,other,groups,complete,status:complete?'complete':all.length?'partial':'missing',officialCount:officialImages.length,photoCount:photos.length,missing,reasons,candidates,candidateCount:other.length+candidates.length};
}
