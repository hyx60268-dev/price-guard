# Current profile prices with historical identity (offline prototype)

This is a distinct, non-actionable observation layer. It does not feed legacy
`candidates`, confirmed-lowest prices, completion statistics, or procurement.
The observation consumer remains disabled and pure. The local integration now
retains original profile receipts and new successful detail-pair bindings; it does
not perform competitor profile probes or consume these bindings for prices.

## Inputs and storage

`yahoo-profile-observation.mjs` supplies source-bound current profile cards. A card
has `id, accountId, title, priceJPY, imageUrl, itemStatus, sellerId, profileUrl,
pageUrl, pageNumber, observedAt, source: current_profile_card`. Original numeric
page timestamps remain unchanged. Full ownership-ID enumeration is separate
from each row's quote eligibility. A successful single page can supply positive
observations; absence in that page never means sold or a complete search.

`retainYahooProfileIdentity` is called beside an accepted real detail verification
and requires a new evaluator-emitted `verificationContext`, the actual then-current rules version, target-bound own/candidate
IDs and sellers, the original transport observation times, and the historical
verification time. It returns only an identity binding, heading/image indicators,
relisting lineage and original clocks. It does not fabricate a timestamp for
legacy records lacking a retained clock. Existing `fetchYahooItemBundle` must
expose its already-returned `page.observedAt` instead of substituting `Date.now()`.
Its source response is already fetched; retaining the metadata needs zero reads.
The evaluator digest binds account, item/relisting identity, both retained detail
snapshots (including description/image URLs/category fields), rule version and original numeric
body times. It is captured before image awaits and checked again afterwards.
The exact evaluator verification clock is retained; callers cannot re-time it.
This digest is a local input-binding receipt, not a cryptographic authentication
signature. Missing legacy context does not prevent ordinary strict quotes, but
cannot mint a new history binding. Real reusable binding count is UNKNOWN and
first-cycle savings are not guaranteed. Normal successful reads can bootstrap
new receipts without added requests. The local transport now passes original body clocks, and normal successful
`yahooCompare` results attach valid bindings as `candidate.profileIdentity`. The
full encrypted state retains them; compact member publication strips them.
Missing current clocks explicitly remove inherited bindings. No live binding
count has yet been measured.

Keep these bindings and private card values in existing encrypted state. Public
schema logs must only contain the separate safe field/type/count projection.
Never dump private inventory, descriptions, HTML, cookies or raw source objects.
The user-authenticated UI projection is `yahooProfilePricePresentation`.

## Runtime contract

`observeYahooProfilePair` checks current own and competitor profile timestamps,
page URLs, statuses, prices and seller IDs; complete all-account own exclusion;
saved corrections including retained relisting lineage; matching original
identity IDs, rules, titles and image URLs. It uses the current own profile price,
not a stale inventory price. Current SOLD is excluded; missing/stale competitor
cards remain unresolved and cannot refresh an old price. Cross-receipt merging
uses per-ID original row time, never input order. A newer quote-ineligible row
blocks an older OPEN card; equal-time conflicting rows remain unresolved.
`rowObservations` retains each page's original time even when a row has no typed
card. Missing legacy row clocks block fallback, rather than borrowing aggregate
min/max time. A newer full enumeration missing a previously seen ID makes its
old price unresolved using the earliest original page time; this does not assert
a sale. A single-page absence never invalidates a positive observation. Full membership, usable OPEN count, known closed IDs and unverified
rows remain separately visible, including unlinked rows with missing fields.

A title/image change requests the relevant detail. Large price differences also
request detail. Neither path automatically calls the old verifier using a fake
current own detail. The caller must obtain the needed current evidence before
returning to strict verification.

When unchanged indicators and the historical pair binding suffice, the output
contains `ownPriceObservedAt`, `candidatePriceObservedAt`,
`historicalIdentityVerifiedAt`, and both old `descriptionObservedAt` values.
`identityVerifiedAt` and `detailCheckedAt` are null; `detailVerified`,
`canRecommend`, `comparisonComplete`, and `procurementCostEligible` are false.
The label says current shop prices for a historical match, not refreshed terms.
Same image URL is only an unchanged indicator; current image bytes are unknown.
Current descriptions, quantity, bonus and condition can have changed invisibly.

## Root-plan replay and limitations

The replay uses actual aggregate counts (635 Yahoo own listings, 17 own profile
pages, 123 linked targets, 140 unique linked offers, 35 sellers) but SYNTHETIC
per-item cards and historical bindings. Production eligible-binding counts,
per-seller offer distribution, seller-page placement and current raw schema are
unknown. No real accuracy rate or production speedup is established.

A hypothetical full field-refresh plan counts 17 profile + 635 own detail + 140
known competitor detail pages = 792. If all 140 known offers are in one page for
each of 35 sellers, the profile plan is 17 + 35 = 52. This is an optimistic root
count with weaker, clearly provisional sale-term assurance. It excludes images,
new discovery, changed-identity details, procurement, holds and workflow overhead.
The replay leaves 512 own items with no known pair and ZERO complete comparisons.
If those 512 targets must still refresh their two recommendation sections, their
own detail roots remain: even the optimistic plan becomes 17 + 512 + 35 = 564
(228 fewer, 28.8%, roughly 46.9 minutes of five-second gate start spacing), before
new candidate validation or cost work. Therefore 792→52 must never be presented
as the achievable full-inventory price-and-cost plan or production speedup.

Do not crawl every seller's entire inventory by default. The pure planner probes
at most one page for a seller with multiple known IDs; singleton IDs use detail.
For 35 one-page probes, H known offers found, and missing-ID detail fallback,
candidate reads are 35 + 140 - H. It saves requests only when H > 35; H=0 would
cost 175 vs 140. The actual hit distribution must be measured within normal
source budgets. Positive cards can be reused immediately even if the full seller
inventory is not traversed. New candidates are not discovered by replaying old
recommendations; only genuinely current returned cards are new observations.

## Acceptance

Tests invoke the real Yahoo verifier to mint historical pairs, preserve 25-hour-old
identity clocks with current profile prices, reject changed fields/self/sold/old
rules, and show two unavoidable false provisional hints when only the hidden
current description changes (quantity or missing bonus). Those are not accepted
quotes. Existing full-detail verification remains necessary for actionable
repricing and costs. This prototype does not meet the 20-minute full-price-and-cost
product acceptance by itself.

## Integration patches

The isolated base is the old PR598 checkpoint plus the independently landed
PR599 accuracy changes. Do not overwrite a current Yahoo source file with this
worktree version. Apply only the narrow
`price-guard-profile-verification-context-yahoo.patch` to `evaluateYahooDetail`
and its call site, alongside the new pure modules in
`price-guard-profile-batch-offline.patch`. Transport-clock preservation is a
separate prerequisite already implemented by the scan owner. None of these
patches calls the retainer or registry from production scan: activation and
encrypted-state retention still need a reviewed integration.
