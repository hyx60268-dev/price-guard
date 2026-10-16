import { conditionCompatible, descriptionColorMismatch, hasExplicitDefect, hasExplicitVariantMismatch, productFamily, saleUnitEquivalent } from './rules.mjs';

// Shared hard constraints, not a title-similarity score. Passing this guard is
// necessary but is never by itself proof that two offers are the same product.
const specText=value=>String(value).normalize('NFKC')
  .replace(/(\d+)\s*个/g,'$1個').replace(/(\d+)\s*张/g,'$1枚').replace(/(\d+)\s*册/g,'$1冊')
  .replace(/(蓝色|棕色|咖啡色|黑色|白色|米色|粉色|绿色|紫色|红色|黄色)/g,color=>` ${{蓝色:'ブルー',棕色:'ブラウン',咖啡色:'ブラウン',黑色:'ブラック',白色:'ホワイト',米色:'ベージュ',粉色:'ピンク',绿色:'グリーン',紫色:'パープル',红色:'レッド',黄色:'イエロー'}[color]} `);
function explicitBonusTerms(value=''){
 const text=String(value).normalize('NFKC');
 // Remove a complete negative phrase before looking for the short positive
 // marker 「付」, otherwise 「特典付属しない」looks like bonus included.
 const negative=/特典(?:カード)?\s*(?:は|が)?\s*(?:付きでは(?:ありません|ない)|付属(?:しません|しない|していません|していない|なし|無し)|付いて(?:いません|いない|ない)|付きません|ありません|なし|無し|欠品)/g;
 const absent=negative.test(text);negative.lastIndex=0;
 const positiveText=text.replace(negative,' ');
 const included=/特典(?:カード)?\s*(?:は|が)?\s*(?:付き|付属(?:します|する|しています|あり|(?=$|[\s、。・+＋]))|付(?=$|[\s、。・+＋])|あり|有り)/.test(positiveText);
 return {included,absent};
}

export function offerIdentityGuard({ ownTitle='', ownDescription='', candidateTitle='', candidateDescription='', ownCategory='', candidateCategory='', primaryImageScore=null, checkImages=true, checkFamily=true, requireDescriptions=true } = {}) {
  if(requireDescriptions&&(!ownDescription.trim()||!candidateDescription.trim()))return {accepted:false,reason:'sale_description_unavailable'};
  const own=specText(`${ownTitle}\n${ownDescription}`),candidate=specText(`${candidateTitle}\n${candidateDescription}`);
  if(hasExplicitDefect(candidateTitle,candidateDescription))return {accepted:false,reason:'defect'};
  if(!saleUnitEquivalent(own,candidate))return {accepted:false,reason:'sale_unit_mismatch'};
  // A matching heading cannot conceal a contradictory selected colour in the
  // sale description (for example white title, red-only actual contents).
  if(descriptionColorMismatch(own,candidate)||descriptionColorMismatch(own,specText(candidateDescription)))return {accepted:false,reason:'description_color_mismatch'};
  if(hasExplicitVariantMismatch(ownTitle,candidateTitle)||hasExplicitVariantMismatch(candidateTitle,ownTitle))return {accepted:false,reason:'explicit_variant_mismatch'};
  if(!conditionCompatible(own,candidate))return {accepted:false,reason:'condition_or_packaging_mismatch'};
  const family=productFamily(own,ownCategory),otherFamily=productFamily(candidate,candidateCategory);
  if(checkFamily&&family&&otherFamily&&family!==otherFamily)return {accepted:false,reason:'physical_product_type_unconfirmed'};
  if(checkImages&&['neck_pillow','acrylic_stand','acrylic_block','acrylic_shaker','card'].includes(family)&&
    (!Number.isFinite(primaryImageScore)||primaryImageScore<.98))return {accepted:false,reason:'primary_variant_unconfirmed'};
  const ownBonus=explicitBonusTerms(own),candidateBonus=explicitBonusTerms(candidate);
  // Identical product photos and matching model names cannot override an
  // explicit included/missing bonus in the actual sale terms.
  if(ownBonus.included&&ownBonus.absent||candidateBonus.included&&candidateBonus.absent)return {accepted:false,reason:'bonus_terms_inconsistent'};
  if(ownBonus.included&&candidateBonus.absent)return {accepted:false,reason:'bonus_terms_mismatch'};
  if(requireDescriptions&&ownBonus.included&&!candidateBonus.included)return {accepted:false,reason:'bonus_terms_unconfirmed'};
  // An extra bonus on the same physical product improves the competitor offer;
  // rules.visualListingEquivalent explicitly allows it. Do not drop that price.
  return {accepted:true,reason:'no_hard_identity_conflict',
    ...(candidateBonus.included&&!ownBonus.included?{bonusComparison:'candidate_extra_bonus'}:{})};
}
