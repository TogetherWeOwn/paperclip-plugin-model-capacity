# Changelog

## 0.2.46 — 2026-10-15

- Learn per-account effective burn from meter-aligned credential usage counters. Pooled calibration remains a cold-start prior, not permanent equal-plan sizing. No provider-specific plan configuration.
- Quantization-aware geometric shrinkage: provisional evidence from 1 percentage point and at least four requests; full confidence after four points. Low-burn outliers receive bounded provisional weight immediately; weights clamp to 0.25–8.
- Scale account target shares and sustainable in-flight budgets by learned burn; pool admission sums those budgets. Keep actual credential routing separate from model/pool admission.
- Keep weekly and five-hour units separate; defend against duplicate/stale meters, counter resets/epochs and missing attribution. Older feeds retain pooled behavior. A missing or reset peer counter leaves the whole group on the pooled prior instead of pricing relative weights without a run scale (capacity-overestimate fix).
- Generic per-account credit pools: a weekly-spent account with a spendable balance stays available, paced to drain over the credit (else weekly) horizon. Free-grant types (`credits.freeTypes`, default `codex-credits`) spend by default; paid types only when listed. Unknown types and zero/unknown balances are never capacity. Needs a `credits` feed field from the lane producer (see README).
- Expose configurable smoothing with existing 30-minute ordinary-up/burn/cap, 10-minute down and 6-hour stale defaults; verified headroom ramps upward with a 5-minute half-life over a bounded 30-minute event.
- Add provider-agnostic unit coverage and 30-minute Meta/Codex/Claude fleet simulations proving approximately 4:1 sustainable slot budgets without oscillation. Preserve readiness, trial, exhaustion, reserve and hard fleet guards. New fallback and credits coverage: 734 green.

Based on main b0a5628 (PR #36), whose package/manifest already declare 0.2.45. This supersedes the pending 0.2.44 install; live rollout remains an Operator action after exact-head review and CI.
