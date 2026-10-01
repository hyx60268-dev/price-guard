import test from 'node:test';
import assert from 'node:assert/strict';
import { extractYahooBundleComponents,expandMerchantBundles } from '../scripts/lib/merchant-bundles.mjs';
import { merchantDetail } from '../scripts/lib/merchant-sources.mjs';
import { curateMerchantProducts,sameMerchantProduct,prepareMerchantVisuals } from '../scripts/lib/merchant-curation.mjs';
import { merchantListingDraft,merchantProducts } from '../scripts/lib/merchant-monitor.mjs';
import { postedMerchantRecord,merchantDismissed } from '../public/merchant-records.js';
const merchant={key:'yahoo:p59959877',id:'p59959877',platform:'yahoo'},titles=['NARUTO 20周年記念 海外限定版 金属カード ギフトボックス','POPMART正規品 NARUTO暁フィギュア 1BOX 10ピース入り'];
const children=[{id:'z682986658',title:titles[0],price:25500},{id:'z683442030',title:titles[1],price:18999}];
const links=children.map(c=>`<a href="/item/${c.id}"><img src="https://images.test/${c.id}.jpg" alt="${c.title}"><p>${c.title}</p><p>${c.price.toLocaleString('en-US')}円</p></a>`).join('');
const html=`<section id="blked"><h2>まとめ買いの商品（2点）</h2>${links}</section><section><a href="/item/z999"><img alt="別の商品"><p>1,000円</p></a></section>`;
test('z684770040 reads exactly the two linked products, never a recommendation or average price',async()=>{
 const parsed=extractYahooBundleComponents(html);assert.deepEqual(parsed.map(p=>[p.id,p.price]),[['z682986658',25500],['z683442030',18999]]);
 assert.deepEqual(extractYahooBundleComponents(html.replace('（2点）','（3点）')),[]);
 const fetchBundle=async id=>id==='z684770040'?{detail:{id,title:'＜まとめ買い＞ '+titles[0]+' 計2点',price:42000,status:'SOLD',seller:{id:merchant.id}},components:parsed}:{detail:{...children.find(c=>c.id===id),seller:{id:merchant.id},status:'SOLD',description:id==='z683442030'?'中国限定 1BOX 10ピース入り':'海外限定 金属カード',images:[{url:'https://images.test/'+id+'.jpg'}]}};
 const detail=await merchantDetail(merchant,{id:'z684770040'},{fetchBundle});assert.equal(detail.bundleComplete,true);
 const record={...detail,merchant,key:merchant.key+':z684770040',soldAt:new Date().toISOString(),firstSeenAt:new Date().toISOString()};
 const products=merchantProducts({a:record});assert.equal(products.length,2);assert.deepEqual(products.map(p=>p.sourcePriceJPY),[25500,18999]);assert.ok(products.every(p=>!p.sourceTitle.includes('まとめ買い')));
 const own={id:'our-figure',title:titles[1],image:'https://images.test/z683442030.jpg'};
 const curated=curateMerchantProducts(products,{items:[own]});assert.equal(curated.products.length,1);assert.equal(curated.products[0].sourceId,'z682986658');
 assert.deepEqual(expandMerchantBundles({old:{...record,bundleComplete:false}}),[]);
 const copy=merchantListingDraft({title:titles[1]});assert.match(copy.proposedDescription,/1BOX（10個入り）/);assert.doesNotMatch(copy.proposedDescription,/10BOX/);
});
const fp=url=>({url,dHash:'123456789abcdef0',aHash:'123456789abcdef0',centerHash:'123456789abcdef0',colorGrid:[1,80,150,60,180,240]});
test('same card artwork at different URLs is excluded across all shops and history; shared secondary image is insufficient',async()=>{
 const card={sourceTitle:'ゼンゼロ 閃魂コラボ 中国限定 仲夏幻夢 コレクションカード 葉瞬光 SS',sourceImages:['https://images.test/merchant'],sourceId:'card',sourcePlatform:'yahoo'};
 const owned={title:card.sourceTitle,image:'https://images.test/our-art',accountId:'boss'};const dashboard={listingHistory:{old:owned}};
 dashboard.merchantPrimaryImages=await prepareMerchantVisuals([card],dashboard,{fingerprint:async url=>fp(url)});
 assert.equal(curateMerchantProducts([card],dashboard).products.length,0);
 assert.equal(sameMerchantProduct({...card,sourceImages:['https://images.test/a','https://images.test/common']},{...card,sourceImages:['https://images.test/b','https://images.test/common']}),false);
 assert.equal(sameMerchantProduct({...card,primaryFingerprint:fp('https://images.test/merchant')},{...card,sourceImages:['https://images.test/different'],primaryFingerprint:{...fp('https://images.test/different'),colorGrid:[255,255,255,255,255,255]}}),false);
});
test('posted products are immediately hidden, persist across relists and honor deletion tombstones',()=>{
 const p={id:'a',sourceId:'x',sourcePlatform:'yahoo',sourceTitle:'中国限定 Anker AeroClip2 レッド ギフトボックス',sourceImages:['https://images.test/a']};
 const r=postedMerchantRecord(p),records={[r.productKey]:r};assert.equal(merchantDismissed(p,records),true);
 assert.equal(curateMerchantProducts([p],{dismissedDiscoveries:records}).products.length,0);
 assert.equal(merchantDismissed(p,{[r.productKey]:{...r,deleted:true}}),false);
 const white={...p,sourceId:'white',sourceTitle:p.sourceTitle.replace('レッド','ホワイト')};assert.equal(merchantDismissed(white,records),false);assert.equal(curateMerchantProducts([white],{dismissedDiscoveries:records}).products.length,1);
});
