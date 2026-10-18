# Yahoo profile observation receipt

Status: isolated pure module and tests. No collector, scan, hydration, pricing, cost,
publication, credential, or deployment behavior is changed by this patch.

## Source evidence and limits

The repository's existing `scripts/lib/yahoo.mjs` profile parser reads
`props.initialState.searchState.search.result`. `liveItem` uses `id`, `title`,
`price`, `thumbnailImageUrl`, `itemStatus`, and `sellerId`; profile discovery also
accepts `seller.id`. The existing `test/yahoo-batch-quotes.test.mjs` fixtures use
zero-based `offset`, `totalResultsAvailable`, and the same card fields.
`test/yahoo-profile-history.test.mjs` covers historical SOLD cards and profiles
without `offset`. These are repository parser/fixture facts, not a new observation
of Yahoo's current schema. No source requests were made for this module.

A card can establish the displayed price, OPEN/SOLD status, title, image URL, and
listing/seller ID at the original body observation time. It cannot establish the
current description, selected variant, shipping, complete physical identity,
procurement price, or a current recommendation set. The image URL is the profile
thumbnail field, not proof that image bytes or a detail page remained unchanged.
Current recommendation sets still require item-detail pages. Profile reuse only
avoids own-detail requests for an explicitly provisional lane whose separate
identity contract permits older bound evidence. It does not make recommendations
bulk-readable and does not enable automatic pricing or cost verification.

## API

`yahooProfileObservation({account,pages,now})` takes:

- `account`: the already-authorized configured `{id,platform,profileUrl,sellerId?}`.
  Platform is `yahoo` or `yahoo_fleamarket`; the canonical public profile URL must
  identify the same seller as `sellerId`, when present. This helper does not grant
  account access or establish ownership merely because a caller supplies an ID.
- `pages`: ordered `{pageNumber,requestedUrl,response,result}` entries, captured
  from the profile reads already performed by discovery.
- `response`: original `fetchYahooPage` metadata: `{url,status,redirected,
  fromCache,observedAt}`. Do not replace missing source metadata with the requested
  URL or the current clock. Conflicting response URL/status aliases are rejected.
- `result`: the raw parsed search result, before seller fallback, deduplication,
  or filtering to OPEN inventory.
- `now`: the calling cycle's numeric epoch-millisecond clock for rejecting future
  observations. All input/output observation clocks are numeric epoch milliseconds.

Successful output:

```js
{
  version: 1, complete: true, enumerationComplete: true,
  pageObservationValid: true, reason: null,
  accountId, profileUrl, sellerId, total, totalEvidence: 'observed',
  uniqueIds, fromCache: false,
  membershipIds, membershipEvidence: 'profile_page_membership_only',
  quoteEligibleCount, quoteIneligibleCount, cardIneligibleCount,
  quoteIneligibleReasons, ownershipConflictCount,
  observedAt, maxObservedAt, // minimum/maximum original page body times
  pageObservations: [{pageNumber, pageUrl, observedAt, returned,
    offsetEvidence: 'observed' /* or 'absent' */}],
  rowObservations: [{id, observedAt, cardEligible, reason}],
  cards: [{id, accountId, title, priceJPY, imageUrl, itemStatus, sellerId,
    profileUrl, pageUrl, pageNumber, observedAt, source: 'current_profile_card'}],
  schemaReceipts: [/* public-safe schema diagnostics, one per page */]
}
```

Each card keeps its own page's time, including when it differs from the aggregate
minimum. No parse/processing/identity/description/quote verification clock is added.
The consuming cycle must enforce its current-observation window using that time;
re-running this pure helper later never makes an earlier body observation fresh.
Numeric prices and unsigned integer decimal strings are accepted; coercible
objects, whitespace, zero, negative, noninteger, nonfinite, and unsafe prices make
that row ineligible without destroying otherwise complete ID enumeration.

Completeness requires exact page count, page URLs/order, consistent integer totals,
page cardinalities (100 except the last), and unique valid listing IDs. An offset
is validated when present; absence is recorded, never fabricated. Both OPEN and
SOLD listings, including historical rows with missing quote fields, contribute to
`membershipIds` and the full denominator. Membership means only that an ID appeared
on the bound profile page. It is conservative exclusion evidence for a configured
own profile, not an observation of that listing's seller or OPEN status.

Card eligibility is separate. `cards` contains only fully typed title/image/price/
status observations with an explicit matching raw seller. Unknown status, missing
seller, missing image, or an invalid price removes that row from `cards`, not from
`membershipIds`. Foreign/conflicting raw sellers add an `ownershipConflictCount`
and a `seller_conflict` reason, with no quote observation for that row. Missing
raw sellers are never filled from the profile URL. The denominator is always
`membershipIds`/`total`, never `cards.length`.

Every valid enumerated ID also has a private `rowObservations` entry with its
original page's `observedAt`, whether or not a typed card survives. `cardEligible`
means the typed OPEN/SOLD card is present; `reason` is the first fixed diagnostic
code or null. A typed SOLD row has `cardEligible:true` and `reason:'not_open'`,
while a SOLD row missing image/seller has `cardEligible:false`.

Consumers merging page receipts must use each ID's row observation time. A newer
ineligible row must block fallback to an older valid OPEN card even though that
newer receipt has no typed card for the ID. Do not drop these rows, derive their
times from the aggregate maximum, or use `membershipIds` alone as the merge
ledger. Row observations retain only the private ID, original time and fixed
eligibility diagnostics; they do not carry arbitrary raw field values.

A fully typed, explicitly seller-bound SOLD card remains in `cards` as positive
status evidence for excluding that known listing. It is not price-quote eligible
and receives no synthetic sold/open/first-seen date. `quoteEligibleCount` counts
only OPEN typed cards; `quoteIneligibleCount` includes SOLD and untyped rows;
`cardIneligibleCount` counts rows omitted from `cards`. The fixed-code reason
histogram counts rows per reason, so its sum can exceed the number of ineligible
rows when a row lacks several required fields. These are eligibility for layered
comparison inputs, never permission to reprice or claim full identity.

Invalid source/page metadata, incomplete pagination, duplicate IDs, or invalid
listing IDs makes the aggregate `complete:false`/`enumerationComplete:false`,
with a fixed code-only `reason`, empty `membershipIds`/`rowObservations`/`cards`, and safe
`schemaReceipts`. Existing prior inventory/identity remains unchanged. A complete
traversal is not an atomic marketplace snapshot: unchanged totals cannot prove no
seller edits happened between page reads, and absent description fields cannot
prove an unchanged description.

## Single-page positive observations

`yahooProfilePageObservation({account,page,now})` uses the same page envelope and
all the same transport/account/seller/card checks. It exposes valid, actually
appearing typed cards immediately without first reading the seller's other pages.
The result has `pageObservationValid:true`, `complete:false`, and
`enumerationComplete:false`. Its `membershipIds` are positive-only page membership.
No absent listing can become SOLD, removed, or fresh. A fully typed SOLD card is
explicit current exclusion evidence, unlike an absent known listing, which stays
unresolved. A page never supplies the full-inventory denominator.

Missing `totalResultsAvailable` is allowed only in this single-page lane and is
reported as `total:null`/`totalEvidence:'absent'`. A short returned page can still
supply its positive observations. Any observed offset/returned count/total must be
consistent; no offsets or totals are invented. A valid empty page without total
still cannot establish an empty shop. Source clocks remain unchanged on reuse.

The aggregate helper alone closes full enumeration. If an aggregate traversal
later fails, callers may retain previously valid *individual page* observations
for positive-only comparisons; they must not present that as complete inventory.

## Minimal integration points (proposed only)

1. In `discoverYahooProfile`'s existing `getResult`, preserve the actual transport
   metadata alongside `searchResult(extractNextData(page.html))` in a local array.
   Record each actual requested page number and URL. Do this before `liveItem`
   normalizes cards and before raw seller fallback or deduplication.
2. With the configured account available, pass that local array to
   `yahooProfileObservation`. If the existing discovery signature remains unchanged,
   pass an explicit configured account in settings or perform this call in the
   caller with a private raw-page envelope; do not infer an account ID from seller
   ID, browser identity, or another account's cached observation. Prefer keeping
   raw envelopes local and returning only the normalized private receipt.
3. Attach the normalized result to the private `profileDiscovery` context, e.g.
   `profileDiscovery.cardObservation`. If a test/dependency supplies only the older
   parsed result without real transport metadata, the new lane stays unavailable;
   never manufacture metadata to make those fixtures eligible.
4. The provisional comparison helper may consume `cards` after either an aggregate
   `enumerationComplete === true` or an explicit single-page
   `pageObservationValid === true`. Only the former provides the full enumeration
   denominator. The helper separately binds older verified identity/description
   to the same account, seller, listing, title, image and variant. Preserve original
   older clocks and explicitly report description freshness as unknown. Do not
   overwrite `sourceDetail.checkedAt`, `yahoo.checkedAt`, cost verification, or
   recommendation observations with the profile time.
5. Only `schemaReceipts` and explicitly selected count/reason fields may enter
   aggregate/public diagnostic logs. Keep cards, membership IDs, row/page observations,
   URLs, account IDs, and raw response/result envelopes in the
   existing private encrypted state, if persistence is needed. Do not spread the
   full receipt into public diagnostics. Existing account/source access gates and
   request counts remain unchanged.

## Safe schema diagnostics

`yahooProfileSchemaReceipt(result)` contains a version/source tag, card count,
fixed recognized field paths with presence/type histograms, missing seller count,
conflicting seller-field count, and a count of unrecognized root card fields.
It never copies IDs, titles, prices, image URLs, descriptions, account/profile
identifiers, arbitrary unknown keys, or field values.

Actual update-like field names matching a bounded grammar are reported only when
present, with types/counts only. No `updatedAt` or equivalent is invented, no value
is interpreted as a date, and no description-freshness claim is derived from it.
Production raw missing-seller/field coverage is not yet measured; the contract
must not be described as making all live inventory eligible until these
safe schema counts have been collected from the already-authorized existing reads.

## Verification

Run `node --test test/yahoo-profile-observation.test.mjs` and `npm test` before any
publication. Focused tests cover per-page clocks, cache/redirect/denial failures,
account/seller/source binding, pagination drift/duplicates, absent offsets, positive
SOLD exclusion, independent enumeration/quote eligibility, single-page positive
observations without absence claims, description/recommendation/cost exclusion, and
public diagnostic redaction.
