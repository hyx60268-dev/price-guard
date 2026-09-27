# 2026-09-27 comparison and shop-source changes

## Verified causes

- A nearest verified competitor gap above JPY 1,500 could still be hidden by the
  old 82%-of-median condition. Suggestions now use the nearest verified/plausible
  floor, never a higher median. One detail-verified offer is explicitly labelled
  as a single-sample reference. Raw one-seller prices remain insufficient.
- Title-only quantity omissions rejected pairs before sale descriptions were read.
  Recall now fetches details; the shared sale-unit and colour gates still decide
  acceptance. Identity anchors come from headings, quantities from sale contents.
- Pendant wording incorrectly overrode plush material/category. Outer-box-only
  opening was misread as an empty-box sale. These are general parsing fixes.
- Cached incomplete/error results hid their original evidence status. Versioned
  coverage now separates checked, remaining and unresolved counts by platform.
- Equal shop round-robin alone repeatedly spent slots on small shops while a
  large shop retained old-rule rows. Priority groups now finish new-rule rows
  before revisiting already-refreshed inventories.

## Live checks (not a full-inventory acceptance)

- Yahoo z682813506 / z659329294: the competitor's description explicitly says
  two plush keychains. Replay using historical JPY 13,899 gives JPY 19,998 against
  the verified JPY 19,999 pair. Singles remain excluded.
- Yahoo z682857272 / z669459194: JPY 10,900, inner bag sealed, box and card included;
  no longer rejected as an empty-box offer. Replay finds the candidate.
- Yahoo z692285448: current JPY 6,600, seller explicitly declares non-official
  merchandise and no outer box. z692128416: JPY 8,600, used, no box/card. These are
  not interchangeable with a new licensed complete product.
- Dragon Ball z691430192: user's historical price JPY 19,680; current price was
  manually changed before this investigation. z683651804 at JPY 21,400 says outer
  box discoloration; z674837598 at JPY 21,500 says outer box damage. Do not use those
  as proof of the lowest pristine offer. Camera-angle/short-title candidates can
  remain unresolved; this release does not claim they are all identified.
- Public Rakuma shop HTML parsed 36 profile cards, including bracketed prices and
  pagination links. Controlled integration tests cover multiple pages, sold items,
  own-listing routing, foreign hosts and preserved account isolation.

## Rakuma is an inventory source too

The shared URL parser accepts https://fril.jp/shop/<id> and Yahoo /user/<id>.
Browser entry, encrypted sync, account merge, paginated inventory, source detail
fetch, cross-platform price comparison and dashboard labels use platform-aware
routing. No Rakuma ID is sent to Yahoo as an own-item ID. No user Rakuma profile
has been invented or bound automatically.

## Acceptance still required after deployment

Run the complete test suite, then inspect the published code SHA and per-platform
`pricingCoverage` for every configured account. Test count is not product count.
The published pre-fix snapshot had 634 listings and only 47 live Yahoo checks in
that run; it was not a full scan. Coverage is incomplete until all remaining and
unresolved rows are cleared. Never report successful Xianyu cost collection from
these pricing changes; it has a separate acceptance gate.
