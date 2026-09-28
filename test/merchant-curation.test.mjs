import test from 'node:test';
import assert from 'node:assert/strict';
import { curateMerchantProducts,sameMerchantProduct } from '../scripts/lib/merchant-curation.mjs';
const a={sourceId:'a',sourcePlatform:'yahoo',sourceTitle:'【中国限定】Anker AeroClip 2 ワイヤレスイヤホン 張凌赫 コラボ 限定ギフトボックス レッド',event:'listed'},b={...a,sourceId:'b',sourceTitle:'【中国限定】Anker ワイヤレスイヤホン 張凌赫 コラボ ギフトボックスセット AeroClip2 レッドイヤホン',event:'sold'};
test('screenshot relist and sold records become one product with both observations',()=>{
 const r=curateMerchantProducts([a,b]);assert.equal(r.products.length,1);assert.equal(r.products[0].observations.length,2);assert.equal(r.mergedListings,1);
 const title='聖闘士聖衣神話EX サジタリアス星矢 黄金聖衣の継承者 BANDAI 中国限定';assert.equal(sameMerchantProduct({title:'新発売 '+title},{title}),true);
});
test('all managed inventory excludes same products from external merchants',()=>{
 assert.equal(curateMerchantProducts([a,b],{items:[{title:a.sourceTitle,accountId:'other-account'}]}).products.length,0);
 assert.equal(curateMerchantProducts([a],{managedAccounts:[{id:'shop',platform:'yahoo',sellerId:'owner'}]},).products.length,1);
 assert.equal(curateMerchantProducts([{...a,seller:{id:'owner'}}],{managedAccounts:[{id:'shop',platform:'yahoo',sellerId:'owner'}]}).products.length,0);
});
test('deduplication preserves color, packaging, quantity and card artwork distinctions',()=>{
 assert.equal(sameMerchantProduct(a,{...a,sourceTitle:a.sourceTitle.replace('レッド','ブルー')}),false);
 assert.equal(sameMerchantProduct({title:'中国限定 HIRONO フィギュア 単品'},{title:'中国限定 HIRONO フィギュア 12個セット'}),false);
 const card={title:'中国限定 ゼンゼロ 葉瞬光 SS コレクションカード',image:'https://images.test/a'};
 assert.equal(sameMerchantProduct(card,{...card,image:'https://images.test/b'}),false);
});
