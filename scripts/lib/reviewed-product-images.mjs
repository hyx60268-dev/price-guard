import { sameMerchantProduct } from './merchant-curation.mjs';

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
  sourceUrl:'https://booth.pm/ja/items/8885115',sourceName:'BOOTH · 霧の郵便局',caption:'牙医初始服装玩偶实拍',kind:'physical_photo',verification:'reviewed_exact_product_variant',reviewedAt:'2026-10-01T12:55:00Z'
 }];
 if(!/Anker/i.test(title)||!/AeroClip\s*2/i.test(title)||!/張凌赫/.test(title)||!/ギフトボックス/.test(title)||!/レッド/.test(title)||/まとめ買い|ホワイト|ブルー|ブラック|単品/.test(title))return [];
 const known='【中国限定】Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 コラボ 限定ギフトボックス レッド';
 if(!sameMerchantProduct({title},{title:known}))return [];
 return [
  ['13','thjiaa-1cfr.jpg','限定礼盒打开后的实拍'],
  ['14','thjiaa-1afa.jpg','酒红耳机与联名配件实拍']
 ].map(([page,file,caption])=>({url:'https://img-cms.pchome.net/article/1ka/pl/4l/'+file+'?x-oss-process=image/format,jpg/resize,m_lfit,w_1000,/quality,q_100',sourceUrl:'https://article.pchome.net/content-2197942-'+page+'.html',sourceName:'PChome',caption,kind:'physical_photo',verification:'reviewed_exact_product_variant',reviewedAt:'2026-10-01T12:12:00Z'}));
}
