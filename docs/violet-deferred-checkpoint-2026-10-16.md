# Yahoo detail-queue checkpoint on deferred comparison

## Observed gap

Normal production run 38946944160 / job 117128343429 ended with the umbrella
listing `melon:z705310958` deferred at `2026-10-16T18:37:44.297Z`.
The published fallback retained its prior checked/search clocks and prior
185-card / eight-detail result. That log does not establish which network stage
failed, or that any particular umbrella detail was read in this run.

The code path did establish a resumability gap: `yahooCompare` threw away its
local scheduling progress when a later detail request deferred, and scan restored
only the earlier comparison. This repair addresses that path, not live candidate
identity or source access.

## Narrow contract

- A compare-private error carries only completed unresolved scheduling attempts.
  It never modifies a shared request/hold error or copies a partial comparison.
- Only the existing two response reasons qualify:
  `physical_product_type_unconfirmed` and `sale_description_unavailable`.
  The target response must have matching ID and valid title/status/price, and
  evaluation must return normally. Interrupted or unrequested reads do not count.
- The checkpoint requires observed OPEN own detail and a valid exact own key.
  It is also bound to account, listing ID, platform, normalized title, seller,
  image and own price. The consumer must supply the current item explicitly.
- New accepted/inspected attempts, candidates, prices, recommendation, rejection
  results, coverage counts and evidence clocks are not checkpointed. Only
  identity-valid previously saved inspected ordering is retained.
- A later normal planner validates the stored own key and every card key again.
  Changed identity clears memory. Existing bounded retries, exclusion gates and
  unresolved-lower protections remain effective.
- The fallback still has `cacheReason=request_error` and cannot authorize a new
  recommendation. Its checked/search clocks and prior source counts are unchanged.
- Checkpoint construction or consumption failure falls back to the original
  deferral. Disk persistence continues through the existing encrypted publication
  path. Checkpoint preparation does not mutate the old durable queue or claim
  that a save succeeded; no new file-write/atomicity mechanism is introduced.
- HTTP metadata and the exact source retry deadline are retained, including an
  indefinite hold. No source rate, budget, cooldown or cache obligation changes.

## Offline verification

Three managed-account contexts run actual `yahooCompare` with controlled source
responses, using the observed eight rejection IDs/prices/reasons from slot 5.
All detail prose, availability, images and the umbrella rival ID are fixtures.

The interruption fixture completes two unknown detail responses and then defers
on the third request. Without persisted memory, retry repeats those first two.
With the checkpoint encrypted, restored, compacted and reconciled, retry starts
at the third candidate. The next comparison uses seven detail calls within the
existing eight-call cap and reaches the controlled 28,000-yen candidate.
This is a regression proof, not evidence that the real umbrella offer was found.

Additional cases cover zero completed attempts, no prior comparison, own/search
stage deferrals, accepted partial quotes, concurrent shared errors across accounts,
changed own/card identity, 403/429/network failures, wrong response ID, interrupted
evaluation, checkpoint copy failure, actual failed file write, finite retry,
permanent user corrections, all-managed-account ownership and SOLD candidates.

The local ENOTDIR test verifies a rejected checkpoint write and subsequent retry
from the unchanged older saved file. It does not establish crash atomicity of
production writeOutputs, which this change does not modify.
