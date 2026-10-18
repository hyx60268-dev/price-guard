# Bounded real comparison validation: activation plan

Local integration only; `config/comparison-audit.json` remains disabled. This plan
is for a single separately approved validation, not a recurring window or a
promise of complete 20-minute inventory coverage.

## Purpose and sample

Freeze the two current Violet own-listing recommendation sets after current
complete Yahoo-owned inventory enumeration. Compare the card-first classification
with the existing full-detail verifier on exactly those frozen candidate IDs.
The two target account/listing bindings and known candidate IDs are supplied only
in the separately reviewed activation, not hardcoded here. A delisted or relisted
target is not silently substituted. Known competitors absent from the frozen
recommendations are reported absent, not injected into the paired population.

Retain all raw/unique/eligible/lower-price counts, paired and unpaired counts,
source timestamps, reasons, and bounded request receipts in encrypted state.
Prioritize a known frozen competitor, meaningful lower-price cards, other
lower-price cards, then higher-price cards. Weak low-price headings remain eligible
for detail checks. Exclude all owned accounts/history, saved corrections, and
explicitly closed cards before source requests. Later detail observations are
separate times; this is not a claim of simultaneous ground truth.

## Limits and tradeoff

- Same original 12-minute scan deadline and 5-second internal Yahoo gate.
- At most 80 actual Yahoo page attempts, including every current inventory page,
  the two own detail pages, and competitor pages. Manual redirects, one attempt.
- At most 64 competitor detail attempts; initially 32 each, unused allowance may
  transfer only after the other target has no eligible pending/in-flight work.
- The latest production enumeration used 17 profile pages. If repeated exactly,
  17 + 2 own reads leaves at most 61 competitor page attempts, before failures.
  The page count is measured again, not assumed. An incomplete own inventory blocks
  all target/candidate access. Eighty starts at the unchanged five-second spacing
  need at least 395 seconds of spacing, excluding response and image work; no
  runtime guarantee follows from that lower bound.
- Images use the existing bounded loader/cache, serially, with one manual request
  per audit download and no denial retry. Actual starts, settled/pending counts,
  completed-body bytes and settled duration are separate. An unfinished body is
  not zero network bytes; interrupted totals remain explicitly incomplete.
- This validation occupies one normal cycle. Ordinary comparisons, procurement,
  merchant catch-up and image-share preparation do not run in parallel with it.
  All accounts/inventory and their original evidence clocks remain; all ordinary
  price/cost obligations are visibly deferred. This cycle cannot pass full-inventory
  acceptance merely because the selected sample was paired.

## Prerequisite release and one-time activation

1. Review and test the disabled code against current main; exact-head CI must pass.
   The normal disabled deployment prepares an empty non-secret execution ledger
   only from one of the reviewed pre-feature state SHAs, under existing scan
   admission and the global `pages` lock. Verify publication/cache receipt and
   recoverable encrypted state. Missing/corrupt/untrusted state is a blocker.
2. Before the one activating commit, verify no competing writer, normal minimum
   cadence, and all current source holds. Retain every hold; wait the full hold
   rather than retrying denied sources. No token, credential, fee or permission
   change is needed.
3. Only after separate approval, set two exact current targets, a new non-secret
   request ID, issuance and at-most-two-hour expiry; put its exact audit marker in
   the one activation commit. Only its first `push` attempt on current main can
   consume the ledger. A normal later push/cron does not reactivate it; old reruns,
   stale heads, expiry, missing ledger or conflicting consumption fail closed.
4. Follow that one run through source termination, encrypted publication and
   manifest readback. Verify the consumed ledger survives. Do not create a second
   request ID or window to compensate for an incomplete result.

Local fsync/CAS plus append-only restored receipts protects surviving state. A
catastrophic runner loss before remote persistence can lose a local update; this
is not a global crash-proof exactly-once guarantee. Missing restored ledgers fail
closed, with current-head/first-attempt/expiry gates as additional bounds.

## Acceptance evidence

Report the original two own-page times and freeze time; all frozen cards and
lower-price population; paired/unpaired and accepted/rejected/unknown results;
real page counts by purpose and settled/pending image metrics; price changes
between card and detail; own/variant/quantity/bonus/condition failures; any
known competitor absent from the sample; state/publication receipts and all
normal obligations deferred. A partial sample does not yield a false-negative
rate for unpaired candidates. The user's full-inventory comparison/cost target
remains separately open.

## Rollback

Keep or restore `enabled:false`; ordinary scans retain the legacy engine and
Yahoo-first policy. Preserve the consumed ledger and old source/evidence clocks.
If source or publication safety regresses, revert the audit integration through
checked code review without deleting state or opening another validation window.
