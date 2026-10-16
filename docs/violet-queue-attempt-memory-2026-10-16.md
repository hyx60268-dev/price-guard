# Violet unresolved-detail rotation

## Verified production evidence

- [Six-slot run, slot 5](https://github.com/hyx60268-dev/price-guard/actions/runs/38928891995/job/117111312765): own listing `melon:z705310958`, checked `2026-10-16T17:55:27.163Z`, search `17:52:46.954Z`; 185 merged cards, 86 preliminary candidates, 8 details, 0 accepted offers, 64 unchecked lower candidates.
- The final eight outcomes were seven `physical_product_type_unconfirmed` and one `sale_description_unavailable`. Their actual IDs/prices/reasons are retained in `test/fixtures/yahoo-violet-queue.mjs`.
- The 500/500/650/880/950 JPY IDs also occur in the saved `15:53:39.368Z` and `17:13:51.110Z` results. Definitive packaging/defect outcomes moved behind newer candidates; these unresolved outcomes kept returning.
- The caller excluded `/unconfirmed|unavailable/` outcomes from `detailQueue.record`. Consequently, with unchanged own/card identity, those entries always had ordering time zero and returned to the cheapest-first queue. The ordinary queue's reserved cheapest slot alone was not responsible for all eight repetitions.
- The saved bounded rejection history still does not identify the reported 28,000 JPY umbrella listing. This patch does not claim that listing was recalled or matched live.

## Narrow change

Keep inspected `attempts` unchanged. Add separate `schedulingAttempts` only after the requested listing ID returns a title, positive price and status, but its type remains unconfirmed or its sale description is absent. The ledger changes selection, never acceptance or price-evidence clocks.

Type-unconfirmed responses are eligible for another read after 60 minutes. Missing-description responses retry after 20, then 40, then at most 60 minutes. No request is added to the existing eight-detail cap. At most two known offers remain reserved; the lowest eligible unknown remains reserved; one remaining slot serves the oldest due unresolved retry; other slots advance unseen/oldest work. Due retries cannot be permanently crowded out by new cards. New IDs, changed card title/image/seller/price, changed own account/listing/specifications/images/seller, or removed cards invalidate the respective scheduling memory.

The original preliminary set remains intact for unresolved-lower and raise guards. Delayed work keeps comparison coverage incomplete. All ownership, user-correction, OPEN, variant, condition, quantity and image gates stay in place. No price cutoff or matching relaxation is introduced.

No scheduling record is created for a source hold, request deadline, HTTP 403/429, transport error, wrong listing ID, or an unrequested card. The implementation deliberately covers only the two observed completed-response classes. Other failures retain their existing retry behavior. Partial queue progress is still discarded if the whole comparison throws a deferred error; that separate recovery issue is not changed here.

## Offline before/after comparison

Tests use the observed eight IDs/prices/reasons and screenshot own/rival titles. Missing descriptions, detail text, OPEN state and fingerprints are explicitly controlled. The ninth 28,000 JPY offer has a fixture ID, not a claimed real listing ID.

At a 20-minute second pass, using actual `yahooCompare` and the same maximum of eight details per pass:

| Replay | Detail calls over two passes | Distinct candidate IDs | Accepted controlled same-model offer |
| --- | ---: | ---: | --- |
| Old persisted state without scheduling memory | 16 | 8 | No |
| New scheduling memory | 10 | 9 | Yes, 28,000 JPY |

The ten calls are eight first-pass responses plus one due missing-description retry and the unseen fixture. The seven type-unconfirmed cards remain unresolved. This is a scheduler regression result, not proof of live product resolution or full-inventory cadence.

Additional regressions cover three managed-account contexts, a genuinely cheaper 400 JPY offer, unchanged-card recovery after expiry, identity invalidation, bounded repeat retries, due-retry fairness with two known offers, invalid future retry times, no forged observation clocks, all-managed-seller exclusion, permanent corrections, SOLD offers, and source/deadline failures.

## Cache obligation recommendation (not implemented)

The first slot reused the umbrella's `15:53:39.368Z` incomplete result when its task ran around `16:10:49Z`: it was younger than the 20-minute TTL. This correctly preserved the old clock but did not perform that slot's comparison obligation. At publication, cache age had exceeded 20 minutes; the task was not revisited.

Use separate predicates for display reuse and completion of a required source observation in the current scan. Keep old evidence available for display/fallback, but allow a scheduling early return only when the specific obligation is already satisfied by account/item-bound, in-cycle evidence. A fresh known-offer detail does not satisfy missing discovery/search/detail-frontier obligations. A failed attempt never satisfies a success obligation. Do not set `FORCE_FULL_SCAN`, reset platform holds, expand budgets, or change cycle-coverage counts to make an old cache count as current.

The narrow follow-up should gate the two Yahoo early returns in `scan.mjs` on this explicit obligation predicate and retain per-run deduplication. Regressions should cover an incomplete 17-minute cache before cycle start, current known detail with old discovery, a genuinely complete same-cycle result, a failed/held task, cross-account binding, unchanged observation clocks and unchanged total admission/deadline. This design needs separate review; it does not promise full coverage within the existing source capacity.
