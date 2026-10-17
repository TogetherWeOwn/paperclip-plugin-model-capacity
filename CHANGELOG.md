# Changelog

## 0.2.49 — 2026-10-17

- Arm-aware burn calibration: burn per run is measured per arm (model+effort) per calibration pool, not per account. Pooled meter deltas split across the arms that ran in the span by responsibility (each arm's prior burn times its run count, scaled to the observed delta); a pure-span sample measures its arm exactly. Pricing follows the current ledger run mix over the pacing window, with cost-anchor priors for never-measured arms, so switching doers from an expensive arm to a cheap arm raises slots within one tick of ledger evidence instead of waiting for quantized meter quanta.
- A dominant-arm change segments old-mix measurements immediately: the pooled EWMA restarts and members' persisted individual estimates are discarded until fresh per-account evidence re-accumulates (a first-seen mix that reprices the pool by more than 25% segments too, so an upgrade onto an already-switched fleet recovers on the first tick). Arm-less runs (no decision, no model) price as their own `unattributed` segment rather than vanishing from the denominator.
- Ledger decisions record effort; the shadow log exposes the decided `armId` (parity golden regenerated: only the newly visible arm id differs).
- Regression: an expensive-to-cheap arm switch raises concurrency slots within one tick (`test/arm-calibration.test.mjs`). Full suite: 776 green.

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
