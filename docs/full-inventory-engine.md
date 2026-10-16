# Bounded full-inventory price execution

The normal price workflow selects `legacy`. The first monitored `full_inventory_graph` run completed in 722.061 seconds but yielded 0 complete price comparisons (9 current observations), versus 80 complete comparisons in the preceding legacy run. The default was rolled back; source-safety and state-preservation fixes remain. Graph mode is available only as an explicit validation option and must not be treated as production acceptance. Both engines use the existing encrypted-state writer and scan deadline.

## What changes

- Register every active item from every configured account before dispatch. A deadline, blocked source, unknown pagination or unsupported source leaves explicit missing work; it cannot remove items from the denominator.
- Coalesce exact public requests within a cycle while retaining the actual observation time. Exact query equality is not a same-SKU conclusion. Each target keeps its own identity, ownership, correction, quantity, colour, condition, price and shipping decision.
- Alternate mandatory root reads and candidate reads within each source so admitted work can produce useful validated offers rather than only creating an unfinished search frontier. Within each account, missing/overdue work has admission priority over recently attempted work; this prevents starvation after partial attempts but never makes cross-cycle rotation satisfy a complete cycle.
- Reuse the same current own-detail observation for price matching and the existing independent procurement workers. No previous description or cost timestamp becomes current by reuse.
- Publish current accepted offers and explicit partial/stale outcomes at the bounded deadline. The normal writer job has a 25-minute outer timeout; the existing 12-minute collection budget and source request gates are unchanged.
- Read workflow state and a counts-only recent scheduled-run total through the existing workflow token. These diagnostics do not alter scheduling or promise dispatch cadence.

## Acceptance and remaining capabilities

Publication success is separate from full-cycle acceptance. All current product prices and verified procurement costs, complete inventories, duration and completion cadence must pass `cycleCoverage` before the 20-minute requirement is satisfied. Partial results do not count as a complete cycle.

The observed 1,461-item inventory required 627 distinct Yahoo queries, 813 distinct Rakuma queries and 1,461 own-detail reads: at least 2,901 pages before candidate details, pagination, images and procurement. These are exact request counts, not proven canonical product groups. The current internal request intervals are not documented provider throughput limits, and no higher safe throughput was established.

Yahoo first-page results can supply validated offers. A reported total larger than the returned page remains incomplete because a permitted, verified continuation is not implemented. Rakuma search and seller pagination must be contiguous and source-bound. Current list cards alone cannot prove unchanged descriptions, packaging, condition or shipping; own-detail reads remain required until a trustworthy change signal or binding protocol is verified.

There are no eligible supplier mappings in the graph configuration. Existing independent cost workers retain their evidence checks and their genuine source limitations. Xianyu authentication remains deferred. An incomplete cost or a retained historical cost never counts as a current verified procurement observation.

Source access denials stop the affected source. Existing Yahoo persisted cooldowns remain authoritative; local deferrals preserve their original classification and retry time. No alternate reader, increased request rate, additional credentials or finite cadence controller is introduced. This is not crash-safe global access-control coordination across every separate workflow.

## Monitored rollout and rollback

1. Run the complete local suite and exact-head CI before merging.
2. Observe the normal cloud writer through encrypted restore, inventory collection, graph execution, state save, deployment and the independent cycle-acceptance step.
3. Compare total inventory, account coverage, current price observations, accepted complete comparisons, actual source errors, request/coalescing counts, elapsed time and original evidence timestamps. Different selected cohorts alone cannot prove a regression or speedup.
4. If the new path causes a demonstrated regression, restore the workflow's `PRICE_SCAN_ENGINE` fallback and input default to `legacy`, or dispatch the existing `legacy` option. The encrypted state schema and old engine remain compatible. Do not increase budgets or bypass source holds to make a rollout appear successful.
