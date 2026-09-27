import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('Mercari discovery reuses verified seed sales before the slower seller crawl',async()=>{
  const source=await fs.readFile(new URL('../scripts/discovery.mjs',import.meta.url),'utf8');
  const store=source.indexOf('seedSalesBySeller.get(item.sellerId).push(verifiedCard)');
  const convert=source.indexOf("addGroup(seller,group.items,'mercariSeedCandidates')");
  const sellerCrawl=source.indexOf('const selectedSellers=rotateDiscoverySellers');
  assert.ok(store>=0,'verified seed details must be retained');
  assert.ok(convert>store,'retained seed details must become product candidates');
  assert.ok(sellerCrawl>convert,'seed candidates must be emitted before the time-bounded seller crawl');
  assert.match(source,/mercariMissingDate/);
  assert.match(source,/mercariInsufficientRecentGroups/);
  assert.match(source,/mercariNonLimitedGroups/);
});
