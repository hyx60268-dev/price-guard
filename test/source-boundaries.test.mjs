import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverYahooProfile,yahooCompare } from '../scripts/lib/yahoo.mjs';
import { primaryProductSimilarity } from '../scripts/lib/image.mjs';

test('a successfully read empty Yahoo shop is authoritative; incomplete pages are not',async()=>{
  const empty=await discoverYahooProfile(null,'https://example.test/user/a',{}, {fetchYahooResult:async()=>({items:[],totalResultsAvailable:0})});
  assert.equal(empty.complete,true);
  assert.deepEqual(empty.items,[]);
  await assert.rejects(discoverYahooProfile(null,'https://example.test/user/a',{}, {fetchYahooResult:async()=>({items:[],totalResultsAvailable:101})}),/分页不完整/);
});
test('blank placeholders never establish primary product identity',()=>{
  const blank={dHash:'0000000000000000',aHash:'ffffffffffffffff',centerHash:'0000000000000000',colorGrid:Array(768).fill(255)};
  assert.equal(primaryProductSimilarity(blank,blank),null);
});
test('search-card visual recall reaches detail verification without being a recommendation',async()=>{
  const ownTitle='中国限定 鬼滅の刃 冨岡義勇 アクリルスタンド',title='アクリルスタンド';
  const own={id:'own',title:ownTitle,description:'新品 未使用',images:['same'],status:'OPEN'};
  const candidate={id:'candidate',title,price:5000,thumbnailImageUrl:'same',itemStatus:'OPEN'};
  const fp={dHash:'00ff00ff00ff00ff',aHash:'00ff00ff00ff00ff',centerHash:'00ff00ff00ff00ff',color:[100,100,100],colorGrid:Array(768).fill(100)};
  const result=await yahooCompare(null,{id:'own',title:ownTitle,ownPrice:10000,image:'same'},{forceYahooBroadSearch:true},{
    fetchYahooItemBundle:async id=>id==='own'?{detail:own,recommendations:[]}:{detail:{...own,id,title:ownTitle,price:5000,seller:{id:'other'}}},
    fetchYahooResult:async()=>({items:[candidate]}),imageFingerprints:async()=>fp
  });
  assert.equal(result.competitorCount,1);
  assert.equal(result.candidates[0].id,'candidate');
  assert.equal(result.candidates[0].visualRecall,true);
});
