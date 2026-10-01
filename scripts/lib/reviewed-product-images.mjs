import { sameMerchantProduct } from './merchant-curation.mjs';
import { offerIdentityGuard } from './offer-identity.mjs';
import { conditionProfile,descriptionColorMismatch } from './rules.mjs';
import { merchantImageAssetKey } from '../../public/merchant-image-evidence.js';
const conditionText=value=>typeof value==='string'?value:value&&typeof value==='object'?[value.name,value.label,value.text].filter(v=>typeof v==='string').join(' '):'';
function redGiftBoxContentCompatible(item,title,known){
 const descriptions=[item.sourceDescription,item.description,item.sourceDetail?.description,item.yahoo?.ownDescription,conditionText(item.condition),conditionText(item.sourceDetail?.condition)].filter(v=>typeof v==='string'&&v.trim());
 const description=descriptions.join('\n'),full=(title+'\n'+description).normalize('NFKC');
 const packaging=conditionProfile(full);
 if(packaging.boxOnly||packaging.noBox)return false;
 // Check each observed sale description independently: joining a red title to
 // a white selected-variant line must not hide the contradictory colour.
 if(descriptions.some(value=>descriptionColorMismatch('レッド',value)))return false;
 if(/(?:単品|单品|單品|本体のみ|本體のみ|のみ販売|のみ出品|だけ販売|仅外盒|仅耳机|只有耳机)/i.test(full))return false;
 if(/(?:イヤホン|耳机|耳機|特典|付属品|周辺).{0,20}(?:欠品|なし|無し|付属しません|付きません|含まれません|不含)/i.test(full))return false;
 // Distinguish multiple complete sets from the number of accessories inside
 // one gift box. Do not infer the package count from marketing photographs.
 if(/(?:[2-9]\d*|[二三四五六七八九])\s*(?:セット|套|組)(?:\s*(?:まとめ|一緒|販売|出品|合售|一起|装)|\s*(?:です|になります|となります)|[。.!！]|$)/im.test(full)||/(?:ギフトボックス|礼盒|禮盒).{0,12}(?:[2-9]\d*|[二三四五六七八九])\s*(?:セット|套|組|個|箱)/i.test(full))return false;
 const heading=value=>value.replace(/ギフトボックスセット/g,'ギフトボックス').replace(/AeroClip\s*2/gi,'AeroClip2').replace(/レッドイヤホン/g,'レッド ワイヤレスイヤホン');
 return offerIdentityGuard({ownTitle:heading(known),ownDescription:'レッドの完全なギフトボックス',candidateTitle:heading(title),candidateDescription:description||title,checkImages:false}).accepted;
}

// Source gallery and both photographs were visually reviewed on 2026-10-01.
// This is an explicit product/variant mapping, not a claim that perceptual
// hashes can identify a new camera angle or infer an unobserved colour.
export function reviewedProductImages(item={}){
 const title=item.sourceTitle||item.title||'';
 // This listing and BOOTH gallery were compared visually: the brown fringe,
 // asymmetric embroidered eyes, white double straps and black hand accessory
 // match. Bind the review to both listing and observed primary photograph so
 // another Dentist skin, size, set or relist cannot inherit this evidence.
 const primary=(item.sourceImages||item.images||[item.image])[0];
 if((item.sourceId||item.id)==='m91581618076'&&title.normalize('NFKC').replace(/\s+/g,' ').trim()==='中国限定 第五人格 歯医者 初期衣装 ぬいぐるみ'&&primary==='https://static.mercdn.net/item/detail/orig/photos/m91581618076_1.jpg?1790594913')return [{
  url:'https://booth.pximg.net/04133347-0afe-4452-b6a9-7f968ac4d658/i/8885115/c7be4a49-1573-4133-9154-8283d96456d7_base_resized.jpg',
  sourceUrl:'https://booth.pm/ja/items/8885115',sourceName:'BOOTH · 霧の郵便局',caption:'牙医初始服装玩偶实拍',kind:'physical_photo',photoEvidence:{publisherId:'booth:04133347-0afe-4452-b6a9-7f968ac4d658',shootId:'booth:8885115',sceneId:'white-background-single-observation',angleId:'front',reviewedSameScene:false,reviewedAt:'2026-10-01T12:55:00Z'},verification:'reviewed_exact_product_variant',reviewedAt:'2026-10-01T12:55:00Z'
 }];
 if(!/Anker/i.test(title)||!/AeroClip\s*2/i.test(title)||!/張凌赫/.test(title)||!/ギフトボックス/.test(title)||!/レッド/.test(title)||/まとめ買い|ホワイト|ブルー|ブラック|単品/.test(title))return [];
 const known='【中国限定】Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 コラボ 限定ギフトボックス レッド';
 if(!sameMerchantProduct({title},{title:known})||!redGiftBoxContentCompatible(item,title,known))return [];
 // The official store's verified account and these two exact red-set images
 // were inspected on 2026-10-02. Its price is not procurement evidence.
 const officialSource='https://detail.youzan.com/show/goods?alias=2osy35s5abbdhtd&from_source=gbox_seo';
 const review='2026-10-01T16:55:00Z';
 const official=[
  ['FvKUPDWio0gslhL_H7rzFL8zQIi4','官方联名礼盒主图'],
  ['FoWCegMFo2LfYxeUZQaXuf9b8nFr','官方红色整套礼盒与配件图']
 ].map(([file,caption])=>({url:'https://img01.yzcdn.cn/upload_files/2026/09/16/'+file+'.jpg!middle.jpg',sourceUrl:officialSource,sourceName:'Anker安克官方商城',caption,kind:'official_image',verification:'reviewed_exact_product_variant',reviewedAt:review,provenance:{authority:'brand_official_store',publisherId:'youzan:41125317',reviewed:true,evidenceUrl:officialSource,evidence:'页面标注Anker安克官方商城及微信公众号认证；逐图核对红色礼盒'}}));
 // Pages 12-14 of one authored PChome gallery were inspected together: the
 // same white textured cloth/light wall, with exterior/open box/contents views.
 // Same-domain or same-author alone is not treated as visual scene evidence.
 const photographs=[
  ['12','thjiaa-20uz.jpg','红色礼盒外盒实拍','closed-box'],
  ['13','thjiaa-1cfr.jpg','限定礼盒打开后的实拍','open-box'],
  ['14','thjiaa-1afa.jpg','酒红耳机与联名配件实拍','contents-flatlay']
 ].map(([page,file,caption,angleId])=>({url:'https://img-cms.pchome.net/article/1ka/pl/4l/'+file+'?x-oss-process=image/format,jpg/resize,m_lfit,w_1000,/quality,q_100',sourceUrl:'https://article.pchome.net/content-2197942-'+page+'.html',sourceName:'PChome · 吕昊',caption,kind:'physical_photo',verification:'reviewed_exact_product_variant',reviewedAt:review,photoEvidence:{publisherId:'pchome:lvhao',shootId:'pchome:2197942',sceneId:'white-textured-cloth-light-wall',angleId,reviewedSameScene:true,reviewedAt:review,evidence:'同篇2026-09-21图赏第12/13/14页，白色纹理布与浅色背景逐图核对'}}));
 return [...official,...photographs];
}

// Re-evaluate our explicit registry against current sale text even when an old
// deployment stored the reviewed photos before these content guards existed.
// Automatically found reference images and unrelated reviewed registries are
// preserved; this function only owns the mappings declared in this module.
export function reconcileReviewedProductImages(item={},images=item.webImages||[]){
 const valid=new Set(reviewedProductImages(item).map(merchantImageAssetKey));
 const belongs=p=>{
  if(p?.verification!=='reviewed_exact_product_variant')return false;
  try{const u=new URL(p.sourceUrl);return u.hostname==='article.pchome.net'&&/^\/content-2197942(?:-\d+)?\.html$/.test(u.pathname)||u.hostname==='detail.youzan.com'&&u.pathname==='/show/goods'&&u.searchParams.get('alias')==='2osy35s5abbdhtd'||u.hostname==='booth.pm'&&u.pathname==='/ja/items/8885115'}catch{return false}
 };
 return images.filter(p=>!belongs(p)||valid.has(merchantImageAssetKey(p)));
}
