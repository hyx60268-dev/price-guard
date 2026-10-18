# Bounded normal-scan geometric candidate ranking (local production candidate, not deployed)

## Exact scope

`settings.yahooGeometryPriority === true` opts one normal Yahoo comparison into byte capture and geometric routing. This local candidate enables that setting and `yahooGeometryReallocate`, conditional on the workflow's successful local runtime readiness check. The earlier disabled 15-file artifact is a different tree. Known-only refreshes are unchanged. There is no new audit request ID, marketplace reader, image downloader, model, service or credential. This branch is local and has not been deployed.

The existing loader briefly owns downloaded image bytes but its persistent `body-*.json` files contain fingerprints only. The new AsyncLocalStorage scope captures successful current bodies (including SHA computation reuse) from the existing loader. It never fills an empty byte cache by requesting an image. An explicitly HTTP-fresh fingerprint may therefore have no geometry bytes. Each lookup binds exact URL, content SHA-256 and original image observation timestamp. Bodies are copied, RAM-bounded and cleared when the comparison exits; they never enter state/publication.

Normal scanning already fingerprints up to 20 weak-title visual-recall cards, plus own images. This candidate reallocates at most four of those existing **fingerprint calls**, retaining at least 16 original low-price/unknown selections, to recommendation cards priced 75%–less than 100% of the own price. Price proximity is routing only, not same-product evidence. Lowest-price and unknown-price originals and the first representative of each source remain protected. Candidate ownership, permanent corrections and explicit specification/context conflicts are checked first.

Changed image selection can change cache hit rate. An explicit regression has 20 warmed originals with zero new card downloads versus 16 warmed originals plus four new card downloads. Equal 20-call caps do **not** mean equal fetches, bytes or transfer time. Image Promise concurrency and HTML frequency are unchanged. No second downloader/refill is added.

Runtime/batch/deadline or own-byte unavailability detected before selection retains the exact original 20 choices. If a process fails **after** reassignment, there is no refill; the four displaced originals remain unprocessed, unresolved, counted below the price floor and keep coverage incomplete. The original detail queue is used where its inputs remain available, but this does not restore the old 20 image results. This candidate does not geometrically inspect the entire frozen recommendation set.

## Queue and accuracy

The geometry algorithm is Harris multi-scale patches plus affine RANSAC. It is not a semantic product model. A known different-product/shared-textured-background example produces a false ranking hint. Geometry cannot supply a price, accept identity, refresh evidence clocks, or reject low-scoring/unknown candidates.

Only at most **one** of the original detail slots can be reserved for geometry. Known offers, the original cheapest candidate, due unresolved retry and ordinary unknown exploration retain their reservations. Geometry-only additions are excluded from ordinary lowest/rest queues, preventing many high hints from taking every slot. Unselected hints stay in the preliminary unresolved/raise-guard set. Every chosen candidate still passes the unmodified full detail verifier, including actual listing ID, OPEN status, all managed ownership, corrections, quantity, bonus, condition and variant requirements.

The already independently reviewed conservative card-conflict helper prevents a clear specification conflict from being rescued through geometry. Unknown or missing terms are not conflicts.

## Resource/failure boundary

- Per comparison pool: at most 32 bodies / 16 MiB; each body at most 12,000,000 bytes.
- Process input: at most 21 images / 20 pairs / 16 MiB actual input bytes, encoded as base64. No URL or source-provided file path is accepted by the Node producer.
- One process for the batch, not one per candidate. Fixed repository worker path, Python isolated mode.
- Child environment whitelist: PATH, LANG and three BLAS/OMP thread controls. No dashboard key or other process secret is inherited.
- 768 MiB virtual address space, 30 seconds cumulative child CPU, one numerical-library thread, at most 10 seconds wall clock (shorter if source deadline is nearer).
- Per Node scan process at most three batches and 30 seconds accumulated geometric work. Concurrent calls do not queue additional work.
- At most 128 KiB stdout; fixed fields/hash binding checked; stderr is discarded. Missing dependencies, invalid output, wrong hash, incomplete pairs, timeout, cancellation or memory failure yield no geometric priority and no refill. Before-selection readiness failure preserves original image selection; after-selection failure has the unresolved displacement boundary described above.
- The Python worker also checks 16-million-pixel input images, decodes verified bytes and uses bounded feature storage. Maximum declared inputs are not a performance guarantee: resource failure remains possible and must fall back.

## Evidence and limits

Actual local Node child-process bridge, four historical screenshot pairs: 2 batches / 6 image inputs / 2,304,946 bytes / 4 pairs, around 1.89 seconds total. It returned the expected two same-artwork routing hints; no network or quote acceptance occurred. This is two historical mother artworks, not a production accuracy benchmark.

Independent original visual corpus: 20 historical pairs = 6 same-artwork renderings, 13 clearly different visible shapes, 1 dark-blue umbrella identity unknown. Another 10 synthetic pairs are separate, including the known shared-background false hint. The unknown is not counted as a true negative. No original bytes for the current frozen 192-card marketplace sample were available, so current-set recall cannot be computed.

Normal integration tests use real `yahooCompare`, image loader, queue and strict verifier, with controlled transport/geometry observations: three managed-account contexts preserve eight detail reads, route one candidate to the second slot, and retain incomplete coverage. Wrong type and SOLD candidates remain rejected. Ten simultaneous geometry-only hints still consume only one detail slot. HTTP-fresh/no-body cases do not refetch. These are fixtures, not live results.

## Production prerequisites and rollback

Production CI and the existing admitted scan transaction now declare Python 3.12 x64, fixed official binary wheels and SHA-256 hashes in `requirements-geometry.txt`. The dependency provenance note records official sources, licenses and cold wheel bytes. Python setup and installation/self-check each have a three-minute workflow timeout; this preparation is outside the source scan and may add up to six minutes before fallback. A generated local image self-check executes the real bounded worker before readiness can become 1; it performs zero marketplace requests. Production setup/install failure preserves the ordinary scan with readiness 0. CI requires the new runtime check to succeed. No model weights, service, credential, permission or paid infrastructure is added. Exact installation time remains to be measured on the runner. Workflow records virtualenv/install/generated-self-check elapsed times and pip cache-hit status; Python setup and end-to-end restore-to-publication times use Actions step/job timestamps. Dependency preparation counts against the user's 20-minute end-to-end goal even though source scan still has its own 12-minute budget.

The child environment contains only PATH/LANG and numerical thread controls. Python dependencies are installed in the job-local virtual environment; no dashboard key enters its process. The old one-time audit configuration/ledger is untouched.

Rollback is setting both geometry settings false or reverting this narrow patch. No ledger/state migration, quote invalidation or source clock reset is needed. The regression contract permits settings false for rollback. Source rate, 12-minute scan budget, 20-thumbnail-call cap and eight-detail cap are unchanged.

Counters distinguish baseline and selected processing calls, near-price reassignments, displaced unprocessed originals, actual fetch starts, settled attempts, completed decoded bytes, unknown interrupted bodies and aggregate transfer elapsed time. Per-comparison counters close with that comparison: late settlement is visible only globally, so fetches minus settledFetches exposes unfinished work. Aggregate durations are not scan wall time. Geometry reports available images, actual pairs, hints and at most one priority slot. A routing hint is never counted as a verified quote.

Local normal-flow regression uses the same controlled candidate input: original 20 thumbnail calls / eight details return zero accepted quotes; one bounded near-price image reassignment lets the original strict verifier accept one 28,000 fixture quote within the same caps, while coverage remains incomplete. Other tests cover successful and failed runtime after four reassignments, unavailable runtime before selection, existing holds, cancellation and partial/late image transfers. This is not a live result or a measured production speedup.

## Whole-inventory architecture remains separate

One geometry slot cannot solve one-own-page-per-item root amplification. At the unchanged configured 4–5.5-second Yahoo gate, an optimistic 20 minutes admits only 300–219 request starts. After 17 profiles, 283–202 remain; reading 630 own detail roots already exceeds that envelope. These are current internal settings, not a claim of immutable platform quotas.

A separate zero-network prototype is examining retaining recommendations from every already-read candidate detail page into a bounded observation pool and sharing them across compatible targets. The actual audit discarded candidate-page rails; their real additional recall/savings are unknown. Profile observations supply current card facts, not freshly verified descriptions. Source-request dedup already exists; previously observed two shared detail reads cannot be claimed again as new savings.
