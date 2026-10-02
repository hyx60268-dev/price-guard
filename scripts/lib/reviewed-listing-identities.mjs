import { createHash } from 'node:crypto';

// Positive visual evidence is separate from reject-only matchCorrections.
// The user reported this exact pair; both live pages and the printed yellow
// 30th-anniversary carton were manually checked. Thirteen printed panel designs
// identify the package, not an inferred number of figures inside the own BOX.
// Each side binds live identity, full prose, condition and primary photo bytes.
// Nothing here records a price or changes a normal automatic image threshold.
const reviews=[{
  id:'yahoo-pokemon-carton-z685606778-z696507894-20261002',
  reviewedAt:'2026-10-02',platform:'yahoo',kind:'reviewed_listing_identity',
  scope:'one_sealed_factory_outer_box',
  evidence:'User-reported pair; live title, full description and primary photographs manually reviewed. Same yellow 30th-anniversary Pikachu carton, thirteen printed panels, central Pikachu and matching left pink panel arrangement; different photographic backgrounds.',
  own:{id:'z685606778',sellerId:'p76217154',
    title:'海外限定 ポケモン30周年 梦点睛 ピカチュウ フィギュア 1BOX',
    descriptionSha256:'c1c913d9c2c336a0729e941d74bcf8d168039eeec111c36ef7a13ac976db1842',
    condition:'未使用',
    image:'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0209/users/aa1954d0eebeb0f0f7bd68ff5ed1999553cba189/i-img1101x1200-1789662132990x7977t.jpg',
    imageSha256:'1286414ddccbde05f9ab601a0d6cbb4ccd2b7e8a5adcf27fc8b99b0ec44ca603'},
  candidate:{id:'z696507894',sellerId:'p59959877',
    title:'新品未開封 ポケモン 30周年 夢描点睛 第4弾 4代目 ピカチュウ フィギュア 1BOX 12個入り 正規品',
    descriptionSha256:'9944d0f146d5f4fa1a81db840061673a49367b487e92e95763fa609aae75fd2e',
    condition:'未使用',
    image:'https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0210/users/6aa9cce46b086b8efaedf39aa01c3fb136c1c313/i-img1027x1200-1790874923313ge6mu7.jpg',
    imageSha256:'8f6b6abf9b7e2ff5d606ccd6eca439b0284eae4027769e7c3b4ea0b72a01a64d'}
}];

const text=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
// DOM line wrapping may insert/remove whitespace; every non-whitespace character remains bound.
const sha=value=>createHash('sha256').update(text(value).replace(/\s+/g,''),'utf8').digest('hex');
function conditionText(value){return typeof value==='string'?value:value?.name||value?.text||value?.label||value?.key||''}
function snapshotMatches(detail,primary,snapshot){
  const first=detail?.images?.[0],url=typeof first==='string'?first:first?.url;
  // Missing current detail evidence, including an image download failure, is
  // never replaced by an old item's thumbnail or a previous reviewed snapshot.
  return detail?.status==='OPEN'&&String(detail.id||'')===snapshot.id&&
    String(detail.seller?.id||detail.sellerId||'')===snapshot.sellerId&&
    text(detail.title)===text(snapshot.title)&&Boolean(text(detail.description))&&
    sha(detail.description)===snapshot.descriptionSha256&&
    typeof snapshot.condition==='string'&&text(conditionText(detail.condition))===snapshot.condition&&
    url===snapshot.image&&primary?.url===snapshot.image&&
    /^[a-f0-9]{64}$/.test(snapshot.imageSha256||'')&&primary?.contentSha256===snapshot.imageSha256;
}

// Queueing evidence only: an exact known card may be checked before unknown
// cheap recommendations. Current candidate description/condition/photo bytes
// remain unverified here and MUST pass reviewedListingIdentity after fetching.
export function reviewedListingCandidate({platform,own,ownPrimary,candidate}={}){
  return reviews.some(row=>row.platform===platform&&snapshotMatches(own,ownPrimary,row.own)&&
    String(candidate?.id||'')===row.candidate.id&&String(candidate?.sellerId||'')===row.candidate.sellerId&&
    text(candidate?.title)===text(row.candidate.title)&&candidate?.image===row.candidate.image);
}

// This only supplies reviewed visual identity. The caller must still enforce
// live availability/price, global owned sellers, rejection memory and all hard
// colour, character, version, quantity, packaging and condition constraints.
// It cannot approve another listing ID, relisting, platform or reversed pair.
export function reviewedListingIdentity({platform,own,candidate,ownPrimary,candidatePrimary}={}){
  const review=reviews.find(row=>row.platform===platform&&snapshotMatches(own,ownPrimary,row.own)&&snapshotMatches(candidate,candidatePrimary,row.candidate));
  return review?{id:review.id,kind:review.kind,scope:review.scope,reviewedAt:review.reviewedAt,
    ownId:review.own.id,candidateId:review.candidate.id,
    ownUrl:'https://paypayfleamarket.yahoo.co.jp/item/'+review.own.id,
    candidateUrl:'https://paypayfleamarket.yahoo.co.jp/item/'+review.candidate.id}:null;
}
