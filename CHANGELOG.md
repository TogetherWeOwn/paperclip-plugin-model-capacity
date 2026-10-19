# Changelog

## 0.2.51 — 2026-10-19

- Review nits (week of 2026-10-19): arm keys no longer rewrite served model ids that end in effort words (`nemotron-3-ultra` keys `nemotron-3-ultra:max`, and `gemini-3.1-pro-low`/`-high` stay distinct arms) — the dash-suffix strip now applies only when the suffix equals the effort being keyed, and the pending-vs-backfilled operator-armId convergence is pinned by a test. The redundant `modelMatch === true` branch folds into the enforced path (no behavior change); the arm-id attribution docs are corrected (only enforced decisions attribute burn by arm id). The target-0 fleet alarm's call-site wiring is covered through the real shadow tick.

## 0.2.50 — 2026-10-19

- Muse max effort: Meta's responses API accepts `reasoning.effort=max` for `muse-spark-1.3-contributor` (it echoes `max` and rejects unknown values such as `ultra`; probed 2026-10-19). The Muse family cap moves from xhigh to max, and Spark 1.3 Contributor gains a static `muse-spark-1-3` (max) arm above its xhigh arm. On the AA snapshot the composite Q is 0.294 (max) vs -0.068 (xhigh), so the ladder prefers max and steps down to xhigh under pacing pressure.

## 0.2.49 — 2026-10-17

- Arm-aware burn calibration: burn per run is measured per arm (model+effort) per calibration pool, not per account. Pooled meter deltas split across the arms that ran in the span by responsibility (each arm's prior burn times its run count, scaled to the observed delta); a pure-span sample measures its arm exactly. Pricing follows the current ledger run mix over the pacing window, with cost-anchor priors for never-measured arms, so switching doers from an expensive arm to a cheap arm raises slots within one tick of ledger evidence instead of waiting for quantized meter quanta.
- A dominant-arm change segments old-mix measurements immediately: the pooled EWMA restarts and members' persisted individual estimates are discarded until fresh per-account evidence re-accumulates (a first-seen mix that reprices the pool by more than 25% segments too, so an upgrade onto an already-switched fleet recovers on the first tick). Arm-less runs (no decision, no model) price as their own `unattributed` segment rather than vanishing from the denominator.
- Ledger decisions record effort; the shadow log exposes the decided `armId` (parity golden regenerated: only the newly visible arm id differs).
- Review-round hardening (3/5 → fix): arm keys trust the decided arm id (and effort) only for enforced hook decisions; every other record keys by the model that actually ran (unknown/pending models bucket as unattributed); unmeasured-arm priors rescale off the measured arms' anchors with measurement-era anchors recorded per arm (a switch onto lanes that no longer serve the old arm still reprices); the pooled estimate is priced from the carried value first and restarts only on a fresh sample, and a dominant-arm flip segments only past a 60% share with a >25% reprice so near-even mixes never flap smoothing; fresh counter-backed estimates re-base onto the mix-priced group baseline on a segmented tick.
- Regression: an expensive-to-cheap arm switch raises concurrency slots within one tick (`test/arm-calibration.test.mjs` pure helpers plus `test/arm-tick.test.mjs` driving the real tick: one-tick reprice and segmentation, flat-meter persistence, noise hysteresis, executed-model attribution). Full suite: 781 green.

## 0.2.48 — 2026-10-17

- AA leaderboard resilience (fleet stall 10-17): a leaderboard fetch or parse failure keeps the previous snapshot's raw leaderboard layer — persisted separately on success as `leaderboardRows`, never the previous merged rows — and never stores an empty `leaderboardSlugs` over a non-empty one. The kept layer merges gap-fill only, so fresh API values (intelligence index, prices, coding index) always land and win; the stale layer only supplies fields the API left null.
- Parser reads the current `initialModels` page (any first slug) plus the legacy `models` embed; maps renamed `terminalBench21`/`terminalBench40` and `percentile05`/`quartile25`/`quartile75`/`percentile95` speed fields to the canonical `terminalbenchV*` / `outputTokensPerSecondP*` names. Fixture: `test/fixtures/aa-leaderboard-20261017.html` (4 real rows from today's page).
- Regression: a parse failure after a good snapshot keeps ladders non-empty with positive per-account share and never stalls the fleet target at 0 (`test/aa-refresh-keep-leaderboard.test.mjs`).
- Error-level alarms when every account ladder is empty or the served target reads 0 while healthy accounts with headroom remain. Guarded and zero-headroom accounts don't count toward the target-0 alarm (an all-guarded target 0 is the designed shed), and both alarms are rate-limited to at most once an hour per company.
- 0.2.47 shipped first, so this takes 0.2.48.

## 0.2.47 — 2026-10-16

- Make credit-funded capacity a fallback tier after subscription lanes with usable role headroom; exclude credit capacity from role concurrency targets while plan headroom remains.
- Add `credits.priority: "fallback" | "normal"`, defaulting to `fallback`.

## 0.2.46 — 2026-10-15

- Learn per-account effective burn from meter-aligned credential usage counters. Pooled calibration remains a cold-start prior, not permanent equal-plan sizing. No provider-specific plan configuration.
- Quantization-aware geometric shrinkage: provisional evidence from 1 percentage point and at least four requests; full confidence after four points. Low-burn outliers receive bounded provisional weight immediately; weights clamp to 0.25–8.
- Scale account target shares and sustainable in-flight budgets by learned burn; pool admission sums those budgets. Keep actual credential routing separate from model/pool admission.
- Keep weekly and five-hour units separate; defend against duplicate/stale meters, counter resets/epochs and missing attribution. Older feeds retain pooled behavior. A missing or reset peer counter leaves the whole group on the pooled prior instead of pricing relative weights without a run scale (capacity-overestimate fix).
- Generic per-account credit pools: a weekly-spent account with a spendable balance stays available, paced to drain over the credit (else weekly) horizon. Free-grant types (`credits.freeTypes`, default `codex-credits`) spend by default; paid types only when listed. Unknown types and zero/unknown balances are never capacity. Needs a `credits` feed field from the lane producer (see README).
- Expose configurable smoothing with existing 30-minute ordinary-up/burn/cap, 10-minute down and 6-hour stale defaults; verified headroom ramps upward with a 5-minute half-life over a bounded 30-minute event. The v0.2.44 instant raw-target serve on upward events is retired in favour of this ramp (calibrated accounts only); the rung-cooldown bypass is unchanged.
- Review #38 fixes: credit lanes without a fraction route at full-window headroom; C* counts the credit fraction over the credit reset horizon; the rung controller measures the credit-fraction drain series; a first estimate at weight 1 is not verified headroom (neutral 1x baseline).
- Add provider-agnostic unit coverage and 30-minute Meta/Codex/Claude fleet simulations proving approximately 4:1 sustainable slot budgets without oscillation. Preserve readiness, trial, exhaustion, reserve and hard fleet guards. New fallback and credits coverage: 734 green.

Based on main b0a5628 (PR #36), whose package/manifest already declare 0.2.45. This supersedes the pending 0.2.44 install; live rollout remains an Operator action after exact-head review and CI.
