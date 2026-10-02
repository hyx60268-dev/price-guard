import { externalSearchQueries,searchExternalImages } from './lib/external-images.mjs';

// Public search recall check, not photograph or procurement acceptance.
// No marketplace sessions, costs or private account configuration are loaded.
const querySet=process.env.IMAGE_SOURCE_PROOF_SET||'baseline';
if(!['baseline','procurement'].includes(querySet))throw Error('Unknown public search proof set');
const titles=querySet==='procurement'?[
 '52TOYS クレヨンしんちゃん 小新の衣橱系列 ぬいぐるみチャーム 1BOX 4個入り',
 '52TOYS×トイ・ストーリー LOTSO MINIME 2 ロッツォ ミニフィギュア 1BOX 6個入り'
]:['中国限定 第五人格 画家 初期衣装 ぬいぐるみ','中国限定 Anker AeroClip2 張凌赫 コラボ レッド ギフトボックス'];
let passed=true;
for(const title of titles){
 let candidates=0;
 for(const query of externalSearchQueries(title).slice(0,2))for(const provider of ['bing','bing_web','duckduckgo']){
  try{
   const result=await searchExternalImages(query,{provider,deadline:Date.now()+15000});candidates+=result.candidates.length;
   console.log(JSON.stringify({title,query,provider,...result}));
  }catch(error){console.log(JSON.stringify({title,query,provider,error:error.message}))}
 }
 console.log(JSON.stringify({title,searchRecallPassed:candidates>0}));if(!candidates)passed=false;
}
if(!passed)process.exitCode=1;
