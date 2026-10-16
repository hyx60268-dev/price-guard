# Yahoo-first execution

The owner requested Yahoo accounts first (メロン, 老板雅虎, 桃香雅虎), with Rakuma last. This changes execution priority, not the all-account 20-minute acceptance requirement.

## Observed prior behavior

The scanner previously awaited inventory discovery for every account before starting price work, then immediately launched Yahoo, Rakuma, Mercari, Xianyu, and public procurement workers concurrently. Awaiting those promises in a different order would not change when source requests started. Rakuma's independent source gate did not directly consume Yahoo gate admissions, but both worked within the same run wall-clock budget.

## Changed behavior

- Build every account's context from existing encrypted state/catalog locally first. Resolve the historical default account before sorting.
- Use the existing source readers and holds, with one original scan start/deadline. The default legacy scanner runs Yahoo inventory, then Yahoo-target pricing and procurement together, then the later account groups. Rakuma is last.
- Within Yahoo, use the configured account order for the first turn and alternate accounts. Item priorities still apply inside each account. Known-offer and public procurement work preserve these account turns.
- Maintain one shared public procurement count/deadline and one Xianyu allowance for the whole scan. No reset grants a later phase extra allowance. Rakuma's existing request boundary now also receives the same run deadline.
- Wait for all started phase workers to settle before a subsequent phase can start. A phase error stops later stages. Cancellation cannot race a still-running callback into the next phase.
- If the run deadline prevents a later stage, preserve its inventory, quotes and original evidence times. Set `deferred_due_to_priority`, keep the full inventory denominator, and do not count the deferred stage as current successful coverage.
- Build ownership exclusions from all configured accounts, including prior inventory of deferred accounts. Rebuild after observed inventory updates. Manual costs, permanent corrections and relist aliases retain their existing storage paths.
- The disabled experimental graph engine is not activated or reworked by this repair. Its prior all-root contract remains separate; production's legacy engine uses the priority policy.

This gives Yahoo the requested priority. It may reduce Rakuma coverage when Yahoo consumes the shared deadline. It does not establish all-inventory completion, a faster source rate, or an on-time schedule. Production must report per-account inventory status, actual source observation times, valid quote counts and missing costs.

## Unadmitted queue attempts

The existing source gate can have its next permitted turn after the shared deadline while a few wall-clock seconds remain. Previously, the outer worker admitted hundreds of items, each threw immediately, and `lastFullAttemptAt` advanced in `finally`. Those errors were not hundreds of network requests.

The scanner now checks the existing gate before attempting a full comparison. These unadmitted rows retain their prior attempt clocks and are reported in aggregate. A concurrent deferral after entry also leaves attempt clocks unchanged when neither the own bundle nor a search response has returned. If the comparison already consumed a response (including an observation shared within the same scan), it may record the comparison attempt and preserve its completed scheduling checkpoint. No quote or search verification time is advanced by these changes. The counters describe comparison control flow, not HTTP request counts.
