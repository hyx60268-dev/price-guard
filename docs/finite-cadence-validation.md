# Bounded cadence validation

## Why this exists

The existing `7,27,47 * * * *` schedule is still configured and active, but the observed GitHub schedule events have gaps of several hours. Once an event exists, the scan job starts promptly. A code change cannot establish why GitHub omitted those events. This opt-in experiment removes dependence on a new cron event between six slots; it does not establish an indefinite scheduler guarantee or increase source capacity.

## Activation and bounds

The checked-in configuration is disabled. A reviewed main commit may enable `config/cadence-validation.json` with a unique request ID and include exactly the corresponding `[price-guard-cadence:<requestId>]` marker in its head commit message. Only a push changing that file or an explicit manual dispatch can open a window. A later ordinary push has no matching marker and cannot restart it. Workflow reruns are rejected. There are exactly six sequential slots at minutes 0, 20, 40, 60, 80 and 100 from the anchor; a slot more than five minutes late is skipped without catch-up. A new main revision stops obsolete queued slots.

The activating ordinary push yields source-scan ownership to the window, while retaining its interface publication path. Existing cron, ordinary push, manual invocation and the window share the same `pages` writer lock and admission receipt. The receipt records a claim only; it never updates any quote or completion clock. Unrelated entrances require a 20-minute gap. Successive distinct slots from the same controller tolerate at most five minutes of startup jitter, reported as the actual start and completion gaps. A fresh recent scan may still cause an initial slot to be skipped; the final report must fail in that case.

Each operational transaction retains the existing scanner, source rates, budgets, accounts, safety thresholds, encrypted state, publication and existing daily merchant catch-up. Waiting happens outside the writer lock. No token scope, secret, paid runner or external scheduler is added. On this public repository the existing standard `ubuntu-latest` runners are used. This finite experiment incurs six normal scan transactions plus bounded waiting jobs, not an unlimited loop.

## Failure and durability

Operational failure or cancellation stops dependent slots. Known product acceptance failure, such as unavailable cost or incomplete inventory coverage, stays visibly red in a separate job while subsequent planned observations may continue. Exceptions, corrupt status and publication mismatch are operational failures; they are not swallowed as an expected product failure.

Every completed finite slot must upload a uniquely named encrypted checkpoint and expose an artifact ID before its dependent slot may proceed. The next slot stages that artifact and conservatively merges it with current cache and published state, retaining the longest source holds and newest admission claim. Included access state covers Yahoo, Rakuma, external search and Xianyu. It excludes Xianyu session credentials. Corrupt or missing required state fails closed. Rakuma denial checkpoints preserve original HTTP status and Retry-After; a missing usable Retry-After uses an internal one-hour hold, not a claimed provider limit.

GitHub Actions cache remains best-effort and evictable. A crash or a failed unrelated ordinary writer whose new private hold never reaches cache/publication cannot be reconstructed from an older completed-slot artifact. This experiment does not claim globally crash-safe cooldown storage. The local Rakuma pending marker prevents restart from treating a partially written checkpoint as permission, but it cannot recover a vanished runner filesystem.

## Acceptance and rollback

Report actual source start/end times, inventory completeness, price checks, verified cost and simultaneous completion for every slot. Final acceptance requires six real observations, valid complete denominators and price/cost counts, both original product checkers passing, and both start/completion gaps and scan duration within 20 minutes. Deployment or a successful operational transaction alone is not product acceptance. Current missing supplier coverage remains a known reason acceptance will fail.

For a regression, disable the config in a reviewed main commit; the new main SHA fences future slots in the old window. An in-flight writer is allowed to finish safely. If the extracted transaction itself regresses, restore the previous ordinary workflow entry and retain source-access safety fixes and encrypted state. Do not erase state, shorten a server hold, or retry blocked sources to force a green result.

### Bounded reported-item verification

`priorityItemIds` may name at most two confirmed current listing IDs for slot 0 only. The existing scan priority input reorders tasks already admitted from current inventory; it does not add listings, raise request budgets/rates, change account membership or the all-inventory coverage denominator. Remaining five slots use ordinary priorities. Do not copy historical closed IDs into activation configuration; identify current live listings from the restored results first. Disabled configuration has no priorities.
