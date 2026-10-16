import fs from 'node:fs/promises';
import { readYahooSellerBatch } from './lib/yahoo-batch-quotes.mjs';

const sellerIds=process.argv.slice(2);
if(!sellerIds.length)throw Error('Provide public Yahoo seller IDs, for example p12345678');
const settings=JSON.parse(await fs.readFile(new URL('../config/settings.json',import.meta.url),'utf8'));
const sellers=await readYahooSellerBatch(sellerIds,settings);
console.log(JSON.stringify({observedAt:new Date().toISOString(),requestIntervalMs:settings.yahooRequestIntervalMs,
 permission:'public seller HTML; no credentials, hidden API, rate increase or production writes',
 sellers:sellers.map(({quotes,...seller})=>({...seller,quoteCount:quotes.length,openCount:quotes.filter(q=>q.availability==='available').length,
  currentQuoteFields:['id','sellerId','title','image','condition','itemPriceJPY','availability','quoteObservedAt'],
  unavailableEvidence:['sale description','shipping amount','reliable listing revision'],identityRenewed:false,automaticCostCreated:false}))},null,2));
