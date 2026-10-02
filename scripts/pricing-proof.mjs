import fs from 'node:fs/promises';
import { fetchYahooItemBundle,yahooCompare } from './lib/yahoo.mjs';
import { rakumaCompare } from './lib/rakuma.mjs';
import { mercariCompare } from './lib/mercari.mjs';
import { openContext } from './lib/browser.mjs';
import { pricingDecision } from '../public/pricing-policy.js';

// Public diagnostic only: never publishes a partial inventory or changes prices.
const id=process.env.PRICING_PROOF_ITEM_ID||'z691562730';
if(!/^z\d+$/.test(id))throw Error('Invalid Yahoo item ID');
const settings=JSON.parse(await fs.readFile(new URL('../config/settings.json',import.meta.url)));
const own=(await fetchYahooItemBundle(id,settings)).detail;
if(own.status!=='OPEN')throw Error('Source listing is no longer open');
const item={id,platform:'yahoo',sellerId:String(own.seller?.id||own.sellerId||''),title:own.title,description:own.description,ownPrice:Number(own.price),image:own.images?.[0]?.url||own.images?.[0],url:`https://paypayfleamarket.yahoo.co.jp/item/${id}`,accountId:'public-diagnostic'};
let browser;
try{
 for(const platform of ['yahoo','rakuma','mercari']){
  try{
   if(platform==='yahoo')item.yahoo=await yahooCompare(null,item,{...settings,forceYahooBroadSearch:true});
   if(platform==='rakuma')item.rakuma=await rakumaCompare(item,settings);
   if(platform==='mercari'){const opened=await openContext();browser=opened.browser;item.mercari=await mercariCompare(await opened.context.newPage(),item,settings)}
  }catch(error){item[platform]={status:'error',error:String(error)}}
  console.log(platform,JSON.stringify(item[platform]));
 }
 const decision=pricingDecision(item);console.log('PRICING_DECISION',JSON.stringify(decision));
 await fs.mkdir('data',{recursive:true});await fs.writeFile('data/pricing-proof.json',JSON.stringify({checkedAt:new Date().toISOString(),item,decision},null,2));
 if(!decision.complete)process.exitCode=2;
}finally{await browser?.close()}
