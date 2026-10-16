# Violet reported price misses, 2026-10-16

## Observed facts

The user's screenshots show two different physical models at their own ordinary asking price of JPY 28,499. Each has a visually corresponding JPY 28,000 recommendation. The later competitor screenshots show JPY 27,000 only with a conditional coupon; that is not the ordinary comparable price.

- Suitcase: APEX 自動手記人形Ver. 1/7, competitor `z704300094`, seller `p59959877` (みお, 値下げ歓迎).
- Umbrella: the competitor title is `ヴァイオレット・エヴァーガーデン フィギュア グッドスマイルカンパニー`. The competitor ID is still unavailable from the screenshots. The user confirmed the same seller. Good Smile's [official product 60808](https://www.goodsmile.com/ja/product/60808/ヴァイオレット・エヴァーガーデン) lists ABC ANIMATION as manufacturer, Good Smile Company as distributor, and 1/7 scale, approximately 350 mm. Those brand names are not inherently contradictory.

The images also contain other physical models and sold market-price cards; neither is automatically valid current competitor evidence.

## Production evidence (JST)

1. [Run 38862354841, job 116847299515](https://github.com/hyx60268-dev/price-guard/actions/runs/38862354841/job/116847299515): 15:43:56.817, historical own suitcase listing `melon:z704304540` verified competitor `z704300094` at JPY 28,500 with free shipping and `exact_bidirectional_title_identity`. At 15:45:01.850 the broad comparison reported 97 unique cards, 2 accepted matches, and lowest JPY 28,500.
2. [Run 38885351758, job 116921642764](https://github.com/hyx60268-dev/price-guard/actions/runs/38885351758/job/116921642764): 19:13:58.561, the suitcase known-offer refresh returned `own_not_open` and preserved its prior quote time. At 19:16:03.119, broad comparison nevertheless reported 96 unique cards, 2 matches, and lowest JPY 28,499. The old `own_not_open` reason means that own status was not verified `OPEN`; it does not distinguish SOLD from missing status.
3. The same run: 19:17:18.597, umbrella own listing `melon:z705310958` reported 188 unique cards, 0 matches, and own-price fallback JPY 28,499. The 188 is merged, ID-deduplicated OPEN search cards, recommendation cards and prior verified cards. It is not 188 verified or recommended same-model products.
4. [Run 38912746797, job 117012399955](https://github.com/hyx60268-dev/price-guard/actions/runs/38912746797/job/117012399955): 23:18:27.523, umbrella `melon:z705310958` returned `request_cooldown_deadline`. This is not a successful fresh comparison. Only a cached image filename for `z704304540` is present in this run; that does not prove the suitcase's current active ID.

The code already parses all sections of the own page's `recommendsState`. Both competitor titles transcribed from the screenshots pass current `screenYahooCard` screening with title score 1, including when vector metadata is absent. No available log proves the actual umbrella JPY 28,000 ID was discovered or establishes its rejection reason. Saved rejection lists are truncated to 30 rows, or 12 in compact publication, so absence is not negative proof.

## Changes and scope

- `scripts/pricing-target-diagnostics.mjs`: offline, read-only inspection of already-restored encrypted state. Requires the existing `DASHBOARD_PASSWORD`; tries `state/latest.json.enc`, then the two published-state paths only if the earlier file is absent. It never requests a source, changes clocks, writes state or outputs other inventory/costs/descriptions.
- The diagnostic locates both exact titles across accounts and historical IDs, preserves separate differing copies, reports original quote/attempt times and bounded candidate reasons, and identifies recorded JPY 28,000 offers and the known suitcase competitor.
- `savedOpenTargetKeys` includes only saved OPEN records associated with a live inventory snapshot and no explicit own-unavailable result. A consumer must intersect them with this run's actual active inventory. It cannot resurrect a historical listing, enlarge a run budget or replace the denominator.
- The normal Yahoo comparison now stops after an explicitly non-OPEN own-detail observation instead of spending search/detail budget and producing a fresh quote timestamp. Known closed states and unknown availability have separate outcomes. This does not remove the listing from inventory; only the complete profile reconciliation can do that.
- The matching thresholds, owned-account protections, marketplace access state and cooldowns are unchanged.

The screenshot regression uses real reported titles/prices and the confirmed suitcase competitor ID. Any injected descriptions, OPEN flags and fingerprints are explicitly controlled test evidence, not live reconstructions. Live matching acceptance still requires current permitted source data.
