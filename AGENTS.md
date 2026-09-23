# Price Guard maintenance contract

- Execution stays in the cloud. Do not replace it with a requirement for the user's computer or phone to remain powered on.
- A user's observed past success is evidence. Current failures do not establish that a feature never worked. Separate source access, matching accuracy, tests, scan coverage, and publication status.
- Shared physical-offer constraints live in `scripts/lib/offer-identity.mjs`. Yahoo pricing, Xianyu procurement and discovery must retain quantity, sale-content, colour, version and condition exclusions. Titles, recommendation cards, common character names and shared secondary images are not sufficient evidence.
- For each reported mismatch, add an enduring regression case, explain the general cause and run existing cases too. Include all three managed-shop contexts where applicable. A test count is not a product-review count.
- Preserve `matchCorrections`, including deletion tombstones, across sync, restore, relisting and scans. Respect account access. A correction may reject a candidate; it must never force acceptance past safety or product-identity gates.
- Keep manual costs, fees and notification preferences across matcher changes. Invalidate incompatible automatic evidence by version; do not invent replacement amounts.
- Thirty-day removal reminders concern the same still-open listing ID. Use platform opening date or the first observed live date. Never use update date, another listing's age, or failed/cached profile observations as current evidence. Never auto-delete marketplace listings.
- Run `npm test` before publication. New failures block release. For matcher fixes, preserve `test/fixtures/user-match-regressions.json` and extend it; do not delete failing user cases to get a green build.
- Cost acceptance requires actual detail prices and independent sellers. Respect login/security challenges. A successful deployment alone does not establish successful cost collection.
