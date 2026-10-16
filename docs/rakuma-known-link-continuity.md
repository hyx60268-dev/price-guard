# Rakuma URL continuity

This repair is based on legacy production `d6c53f8`. It does not enable the
full-inventory graph, change concurrency/request spacing, extend scan deadlines,
or change the configured six-detail budget.

## Failure boundary

Previously `rakumaCompare` recalled only current search cards. Its empty or
partial result replaced `prior.rakuma.candidates`; caught detail failures did the
same. Outer request failures could retain an eligible comparison cache, but a
rules-version change disabled that fallback. A comparison result was therefore
also the only stored discovery address book. Clearing unsafe price evidence
could inadvertently destroy useful URLs.

The reported 39-item/49-URL to 3-item/4-URL change cannot identify which
production items followed any of those paths. No private snapshots were used.

## Durable discovery, separate from quotes

`item.competitorDiscovery.rakuma` contains an exact account/listing/platform
scope and URL-only records. Each record carries canonical URL/ID, full own-detail
identity and profile-binding hashes, the original own observation time,
last verified/attempt times, and optional retirement time/reason. It contains no
price, title, image, seller, accepted match method, or substitute current card.

Only a newly accepted current detail bootstraps a record, with complete response
target, current seller, JPY price and applicable current fee-row evidence. Legacy
comparison audits cannot prove the original own-detail fingerprint, so they do
not seed. Same-source Rakuma own listings are the only supported hint targets in
this repair. Cross-platform collectors are unchanged.

The existing own-detail hydration cache retains its original observation. No
additional own read is introduced. A pre-repair cached own detail lacks the new
target-response proof and stays unseeded until its normal refresh. Consequently,
the first or second deployment cycle may legitimately have zero eligible hints.

Empty/incomplete discovery, unknown evidence, transport errors, deadlines, and
matching-rules upgrades keep the URL available for later verification. Changed
observed own identity/profile binding retires the old binding. Relists and other
accounts cannot inherit it. Explicit current SOLD, owned offers, corrections,
defects and unambiguous conflicting observed identity values can retire a URL;
generic missing/ambiguous quantity, condition, scale or wave evidence cannot.

SOLD is availability of the URL itself and remains closed across own identity
changes within this scoped store. A separate future policy for proving a sold
listing reopened is deliberately outside this repair. Other product-mismatch
tombstones remain bound to the original target.

Full and compact publication preserve these records. Restore merges per-record
tombstones from both snapshots rather than trusting the snapshot's overall
revision. Applicable retired URLs are also removed from restored quote evidence;
an unbound legacy quote is quarantined rather than assigned an invented identity.
Unrelated and explicitly different-bound quotes remain separate. Quarantine does
not advance timestamps or claim newly complete empty coverage.

## Existing bounded collector integration

At most one due hint, oldest actual attempt first, occupies a slot inside the
existing detail limit. Search/hint duplicates use one slot; displaced search
cards remain unresolved. Other due hints remain unknown obligations unless
independently settled through an admitted search-detail read.

A hinted URL must return HTTP 200 with original observation metadata, no redirect,
and an explicitly reported final target equal to the requested URL. Only that
detail supplies its new card. Current own identity, ownership, correction,
availability, seller, physical-offer/image and payable-price checks still apply.
Unknown hints never borrow a stored price and prevent false complete coverage;
independent accepted current cheaper quotes may still be useful.

`createOwnSourceLoader` preserves the original `fetchRakumaPage` metadata through
the same coalescer and request lane. The neutral
`marketplace-shipping-evidence.mjs` and its tests are backported from the reviewed
shipping helper in recovery `b7bc6bc`, with only module/export names changed. No
graph scheduler code is included. Fee amount still requires actual current
target-local proof; carrier metadata does not supply it.

## Counts-only rollout evidence

The `ラクマ既知URL継続` aggregate reports eligible/admitted/reverified hints,
bootstrapped records, unresolved due hints, pending/retired stored links,
binding invalidations, unknown admitted outcomes, and search-versus-hint detail
reads. No product IDs, titles, URLs, or raw observations are logged there.
`retired`/`invalidatedBinding` include tombstones encountered by executed workers;
`retiredLinks`/`pendingLinks` are their final stored totals, not whole-inventory
coverage. Deferred/fresh-cache workers do not invent an executed hint check.

The one-slot tradeoff can leave more incomplete comparisons; it does not prove
full inventory completion, procurement recovery, or achievement of the 20-minute
product requirement. A later bounded production cycle should separately inspect
source holds, new bootstraps, actual re-verification, honest incomplete coverage,
and unchanged data-preservation fields.

## Regression coverage

- Actual-parser multi-cycle empty/partial/error/deadline outcomes and raw clocks
- Current seller, image, currency, fee conditions, URL/status/redirect provenance
- Six-slot displacement/deduplication and all remaining unknown obligations
- Current SOLD/correction/ownership, ambiguous identity, changed target/relist scope
- Full/compact encrypted publication and obsolete-cache tombstone/quote fencing
- Real legacy scan entry point with injected public transport and independent cost
  workers stubbed only in a disposable fixture; success and source-denial paths

All verification uses deterministic fixtures and injected transport. No
marketplace requests or remote writes are part of local validation.
