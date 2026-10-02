import test from 'node:test';
import assert from 'node:assert/strict';
import { externalImageQueries,externalSearchQueries,imageSearchRelevance,parseImageSearchResults } from '../scripts/lib/external-images.mjs';
import { xianyuQueryFor } from '../scripts/lib/discovery.mjs';
import { localizeSearchTerms } from '../scripts/lib/search-localization.mjs';
import { procurementSource,alternativeProcurementCost } from '../scripts/lib/procurement-sources.mjs';

const wardrobe='52TOYS クレヨンしんちゃん 小新の衣橱系列 ぬいぐるみチャーム 1BOX 4個入り';
const lotso='52TOYS×トイ・ストーリー LOTSO MINIME 2 ロッツォ ミニフィギュア 1BOX 6個入り';
const wardrobeCandidate='52TOYS蜡笔小新衣橱毛绒盲盒OOTD玩偶挂件潮玩玩具包挂送礼礼物-淘宝Taobao | 天猫Tmall';
const lotsoCandidate='52toys Blindbox ロッツォ ミニミー2 6個入り1box｜ホビーの総合通販サイト ホビーストック';
const rss=rows=>'<rss><channel>'+rows.map(([url,title])=>'<item><title><![CDATA['+title+']]></title><link>'+url+'</link></item>').join('')+'</channel></rss>';

test('cloud wardrobe and LOTSO candidates survive equivalent Chinese/Japanese search wording',()=>{
 for(const [query,title] of [[wardrobe,wardrobeCandidate],[lotso,lotsoCandidate]]){
  assert.ok(imageSearchRelevance(query+' 购买 现货',{title})>=.35);
  assert.equal(parseImageSearchResults(rss([['https://shop.test/item',title]]),'bing',query+' 购买 现货').candidates.length,1);
 }
 assert.match(externalSearchQueries(wardrobe)[0],/蜡笔小新 小新的衣橱系列/);
 assert.match(externalSearchQueries(lotso)[0],/草莓熊 MINIME2/);
});

test('shared 52TOYS brand and matching packaging cannot replace character or series anchors',()=>{
 for(const title of ['52TOYS 蜡笔小新澡堂 毛绒盲盒 1BOX 4个装','52TOYS 蜡笔小新动感超人 盲盒 1BOX 4个装','52TOYS 玩具总动员 WARM EMBRACE 毛绒挂件 1BOX 8个装','Anker AeroClip2 白色 礼盒'])assert.equal(imageSearchRelevance(wardrobe,{title}),0,title);
 for(const title of ['52TOYS 草莓熊 MINIME3 迷你手办 1BOX 6个装','52TOYS 玩具总动员 巴斯光年 MINIME2 1BOX 6个装','52TOYS 蜡笔小新 1BOX 6个装'])assert.equal(imageSearchRelevance(lotso,{title}),0,title);
});

test('observed mixed-language procurement queries retain model, colour, packaging and quantities',()=>{
 const cases=[
  ['スターバックス ヒョウ柄 タンブラー サングラスケース 850ml',['星巴克','豹纹','随行杯','墨镜盒','850ml']],
  ['スターバックス ドット柄 ステンレスボトル 430ml スカーフハンドル付き',['波点','不锈钢','430ml','丝巾手柄']],
  ['52TOYS×トイ・ストーリー WARM EMBRACE ぬいぐるみチャーム 1BOX 8個入り',['52TOYS','玩具总动员','WARM EMBRACE','1BOX','8个装']],
  ['YADEA ×ゼンレスゾーンゼロ コラボ ギフトボックス',['YADEA','绝区零','联名','礼盒']],
  ['The Monsters Trilogy精霊三部曲 Kasing Lungによる絵本',['The Monsters Trilogy','精灵三部曲','Kasing Lung','绘本']],
  ['あんさんぶるスターズ 鳴上嵐 ワイヤレスイヤホン LCD搭載 bilibili',['偶像梦幻祭','鸣上岚','无线耳机','LCD显示屏','bilibili']],
  [wardrobe+' ブラック 10cm',['1BOX','4个装','黑色','10cm']],
  ['シークレット MEGA ROYAL MOLLY 100% シリーズ',['隐藏款','MEGA ROYAL MOLLY','100%','系列']]
 ];
 for(const [title,words] of cases){const query=externalSearchQueries(title)[0];for(const word of words)assert.ok(query.includes(word),query+' lacks '+word)}
});

test('search localization does not truncate trailing identity or change legacy final-match queries',()=>{
 const long=wardrobe+' '+('联名 '.repeat(30))+'1BOX 4個入り ブラック 10cm';
 const query=externalSearchQueries(long)[0];assert.ok(query.length>80);assert.match(query,/1BOX 4个装 黑色 10cm$/);
 assert.equal(xianyuQueryFor(long).length,80);
 assert.match(externalImageQueries(wardrobe)[0],/クレヨンしんちゃん/);
 assert.match(externalImageQueries(wardrobe)[0],/1BOX 4個入り/);
 assert.match(externalSearchQueries(wardrobe,'official')[0],/官方 商品图$/);
 assert.match(externalSearchQueries(wardrobe,'physical')[0],/实拍 开箱 多角度$/);
 assert.match(localizeSearchTerms('MINIME 2 ミニミー3 AeroClip2 1BOX 6個入り'),/MINIME2 MINIME3 AeroClip2 1BOX 6个装/);
});

test('better search recall still rejects unverified detail quotes and unsupported Taobao summary pages',async()=>{
 const seen=[],read=[],fp={dHash:'123456789abcdef0',aHash:'123456789abcdef0',centerHash:'123456789abcdef0',colorGrid:[1,80,150,60,180,240]};
 const subject={accountId:'a',id:'owned',title:wardrobe,image:'https://images.test/source',description:'新品未開封 1BOX 4個入り'};
 const result=await alternativeProcurementCost(subject,{fingerprint:async()=>fp,search:async(query,options)=>{
  seen.push(query);return parseImageSearchResults(rss([['https://item.jd.com/123456.html',wardrobeCandidate],['https://www.taobao.com/list/item/product',wardrobeCandidate]]),'bing',query,options);
 },detail:async url=>{read.push(url);return {status:'incomplete',reason:'sku_unconfirmed'}}});
 assert.match(seen[0],/蜡笔小新 小新的衣橱系列/);assert.deepEqual(read,['https://item.jd.com/123456.html']);
 assert.equal(result.detailCheckedCount,1);assert.equal(result.sellerCount,0);assert.equal(result.averageCNY,null);assert.ok(result.diagnostics.some(row=>row.reason==='sku_unconfirmed'));
 assert.equal(procurementSource('https://www.taobao.com/list/item/product'),null);
 assert.equal(procurementSource('https://world.taobao.com/item/123456'),null);
});

test('real JD Minime series 2 search title is recall evidence only and keeps edition boundaries',async()=>{
 // Cloud proof 36980721935 rejected this actual JD title before the alias fix.
 const url='https://item.jd.com/100362919034.html';
 const title='【52TOYS草莓熊Minime系列2-整盒6包】52TOYS草莓熊Minime系列2 萌粒盲盒潮玩手办玩具整盒6包（内含18只）【行情 报价 ...';
 const query=externalSearchQueries(lotso)[0];
 assert.equal((query.match(/草莓熊/g)||[]).length,1);
 assert.match(query,/MINIME2/);assert.match(query,/1BOX 6个装/);
 const found=parseImageSearchResults(rss([[url,title]]),'bing',query);
 assert.equal(found.candidates[0]?.url,url);
 assert.ok(imageSearchRelevance(query,{title:'Disney Lotso Minime Series 2 Blind Box | 52toys'})>=.35);
 for(const wrong of [title.replaceAll('系列2','系列3'),title.replaceAll('系列2','系列20'),title.replaceAll('草莓熊','巴斯光年'),title.replaceAll('Minime系列2','WARM EMBRACE')])assert.equal(imageSearchRelevance(query,{title:wrong}),0,wrong);
 // Six packs containing 18 figures is not accepted as six figures from a search card.
 const fp={dHash:'123456789abcdef0',aHash:'123456789abcdef0',centerHash:'123456789abcdef0',colorGrid:[1,80,150,60,180,240]},seen=[];
 const result=await alternativeProcurementCost({accountId:'a',id:'lotso',title:lotso,image:'https://images.test/source'}, {
  fingerprint:async()=>fp,search:async(q,options)=>parseImageSearchResults(rss([[url,title]]),'bing',q,options),
  detail:async u=>{seen.push(u);return {status:'incomplete',reason:'selected_sku_unsettled'}}
 });
 assert.deepEqual(seen,[url]);assert.equal(result.sellerCount,0);assert.equal(result.averageCNY,null);assert.equal(result.samples.length,0);
 assert.ok(result.diagnostics.some(row=>row.reason==='selected_sku_unsettled'));
});

test('official wardrobe naming improves queries without mapping OOTD or dropping sale units',()=>{
 // Official 52TOYS post: https://www.sina.cn/news/detail/5308591897840148.html
 // Store link: /ja/products/crayon-shinchan-wardrobe-series-plush-keychain-blind-box
 const query=externalSearchQueries(wardrobe)[0];
 assert.match(query,/蜡笔小新 小新的衣橱系列 毛绒盲盒挂件 1BOX 4个装/);
 for(const title of ['52TOYS 蜡笔小新小新的衣橱系列毛绒盲盒挂件玩偶潮玩礼物整盒4只','52TOYS 蠟筆小新 小新的衣櫥系列 毛絨盲盒 整盒4只','CRAYON SHINCHAN WARDROBE SERIES Plush Keychain Blind Box 52TOYS'])assert.ok(imageSearchRelevance(query,{title})>=.35,title);
 for(const title of ['52TOYS蜡笔小新早古毛绒公仔OOTD毛绒盲盒挂件玩偶整盒4只','52TOYS CRAYON SHINCHAN VINTAGE PLUSH OOTD SERIES 1BOX 4个装','52TOYS Official Store | Blind Boxes, Figures & Plush','52toys蜡笔小新毛绒搪胶盲盒 书包挂件手办送礼首选'])assert.equal(imageSearchRelevance(query,{title}),0,title);
 assert.match(externalSearchQueries(wardrobe+' レッド ブラック 10cm 2BOX')[0],/1BOX 4个装 红色 黑色 10cm 2BOX$/);
});
