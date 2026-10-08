# Model Capacity plugin (v0.2.1, enforce-capable)

Picks the model (and effort) for every run and sets how many agent runs
should run in parallel, so every account's allowance is used before it
resets. Two inputs: CLIProxy burn telemetry and Artificial Analysis
free-API quality data. Purely deterministic -- no classifiers, no vetoes.

**v0.2.1 = ENFORCE-CAPABLE, default off.** The manifest holds
`run.model.resolve` with a minimal `modelRouting.envKeys` list (only the
two context-ceiling keys `decide` ever sets). The hook itself is gated by
the `enforce` config flag (default `false`): with enforcement off it
answers `keep` and nothing changes. Every minute the tick records what it
*would* have decided (`GET /shadow`), the concurrency target
(`GET /capacity`), per-account ladders (`GET /ladder`), and the per-agent
cap spread (`GET /caps`). `buildManifest({ modelResolve: false })` still
builds the shadow-only variant for tests.

## How it decides (per account, per run)

1. **Arms** (model x effort) the account's provider can serve, joined to
   the AA snapshot by slug. Ladders never cross providers. The snapshot
   merges two sources per slug: the free API list plus the public
   leaderboard page (full flat fields incl. cost and prices). The
   leaderboard wins for fields it has; the API fills gaps.
2. **Quality Q** = z-scored AA composite with null-renormalization
   (missing metrics are excluded, never zero-imputed). Terminal-bench
   reads Hard, falling back to V40 then V21; hle scores at weight .10.
   Coverage is measured against the metrics actually present among that
   account's arms (common support), so a free-tier gap hitting every arm
   shrinks the denominator instead of failing every arm.
3. **Cost C** = `intelligenceIndexCostPerTask` when present, else an
   estimate from per-million-token prices x the median effective
   tokens-per-task of arms that have both (flagged `costEstimated` on
   the rung). A priced arm is never dropped for missing cost.
4. **Pareto filter** drops dominated arms; survivors are rungs L0..Ln.
   Low-coverage arms (< 0.6) cap at one rung above cheapest; incumbents
   keep rungs unless a strictly-dominating newcomer appears.
5. **Rate pacing** compares measured burn rate against required rate:
   `e = measuredRate - requiredRate`, where required = remaining/hoursToReset
   and measured = weekly-used delta per hour over the trailing 60 min of
   lane readings (needs 2+ readings spanning 10+ min, so the measured rate
   appears ~10-15 min after install; counter resets are
   rejected). Readings are stamped with the payload's `observedAt`, and only
   exact duplicates are skipped, so cached payloads never fake movement.
   Deadband is +-15% relative; position vs. the linear schedule
   only breaks ties while no rate is measured yet. At most one rung per
   10 min. The 5h guard overrides everything: above 80% the account floors
   and sheds load, rejoining below 50%.
6. **Per-run signals only**: role floor/ceiling, +1 rung per retry,
   test-fail +1, rate-limit reroutes, context-window filter. `defer`
   happens only when no account has headroom.
7. **Concurrency** `C* = sum(requiredRate_a/E_a) x D` (Little's law,
   `D = 0.186h` measured fleet mean run duration). `E_a` is calibrated
   per account from lane weekly-used deltas divided by heartbeat runs
   started on the account in the span (runs mapped by provider, falling
   back to model-family hints). Until any `E` is measured the result is
   `calibration: weak` with no target and no caps. Guard-capped accounts
   contribute zero; a 75 hard ceiling binds the total.

Sol/Luna decisions carry `CLAUDE_CODE_MAX_CONTEXT_TOKENS=260000` to stay
under the 272k price cliff, plus the `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
watermark (configurable via `contextCaps.autoCompactEnvKey`; null omits
it). These two keys are exactly the manifest's `modelRouting.envKeys`:
`decide` returns model/effort first-class and sets nothing else.

The resolve hook is memory-only: it reads the live view the last tick
published and performs zero I/O, so it always answers inside the host's
1.5s RPC deadline. Unknown company, `enforce: false`, a human operator
override (`issueOverrideModel`), and tick staleness over 120s all answer
`keep`. Only an all-accounts-no-headroom fleet answers `defer`
(`retryAfterMs` 60000). Every enforced decision lands in the shadow ring
with `enforced:true` on the next tick.

`GET /caps` spreads the concurrency target over agents with queued/ready
work (assigned `todo` + `in_progress` issues, grouped by assignee):
floor 1 per active agent, largest-remainder weighting by queued count,
never above `maxTotal` (75). Weak calibration (no target) returns
`agents: []`.

## Configuration

See `config.example.json`. Secrets are Paperclip `secret_ref` objects,
resolved at call time and never stored:

- `aa.apiKeySecretRef` -- existing company secret
  `ARTIFICIALANALYSIS_API_KEY` (free tier) fits here.
- `cliproxy.laneKeySecretRef` -- Paperclip secret holding the lane key
  for the host-published CLIProxy telemetry endpoint:
  `GET {cliproxy.baseUrl}{cliproxy.accountsPath}`
  (defaults `https://router.infextion.net` +
  `/telemetry/cliproxy/live/accounts.json`), sent as the `X-Api-Key`
  header. The response carries per-account `weekly`/`fiveHour`
  `{ used (0..1|null), resetsAt (ISO|null) }` plus a `quality`
  flag. Until the ref is wired the plugin runs degraded: no live reads,
  ladders frozen, shadow records the gap.

The CLIProxy client only ever issues that one GET. Anything else is
blocked in code and covered by the allowlist test. The plugin worker
never touches CLIProxy directly (private IPs are blocked from
`ctx.http.fetch`) and the CLIProxy management key stays on the host --
the host service does passive-first plus single-account live pull,
server-side. Readings are cached 45s (`cliproxy.cacheTtlSec`).

Heartbeat runs come from a restricted SELECT on the whitelisted core
table `heartbeat_runs` (manifest `database` declaration +
`database.namespace.read`; `migrate` is declared-but-unexercised because
the host schema validator requires it, and the plugin owns no tables).
Without the capability the tick degrades to events-only and says so
(`runsSource`, `runsDbError` on `/capacity`). Each shadow entry records
`actualModel` plus `modelMatch` (did shadow agree with
reality; null while the actual model is unknown). The actual model
resolves heartbeat usage_json first, then the issue's assignee adapter
override (preferred), then the agent's adapter config -- via the
already-declared `issues.read` / `agents.read`, no new capabilities.
Rungs are always
served strictly ascending in cost (stability pins yield to fresh cost
order whenever they would invert it), and `requiredRatePerHour` is a
number whenever remaining% and reset are both known -- null (unknown)
otherwise, never a silent zero.

## Layout

- `src/manifest.mjs` -- enforce-capable manifest + `buildManifest` variant flag
- `src/cliproxy.mjs`, `src/aa.mjs` -- edge clients (pure + guards)
- `src/arms.mjs`, `src/quality.mjs`, `src/ladder.mjs` -- ladder math
- `src/pacing.mjs`, `src/decide.mjs`, `src/concurrency.mjs` -- control
- `src/shadow.mjs` -- bounded shadow ring
- `src/plugin.mjs` -- worker wiring; `src/worker.mjs` -- entrypoint
- `test/` -- `node --test`, no build step: `npm test`

## Open questions

- Wire `cliproxy.laneKeySecretRef` to the lane key (owner decision, see
  above). `cliproxy.baseUrl`/`accountsPath` are configurable but default
  to the live lane.
- Verify the AA `omniscience` field direction (currently treated as a
  hallucination rate and negated per spec).
- Per-run burn calibration starts from a configured reference anchor
  (flagged `weak`) until lane usage deltas over heartbeat runs are
  observed; then `E_a` is measured per account (see step 7).
- zai/xai/opencode accounts are unmapped: AA carries candidate slugs
  (grok-*, kimi, qwen, deepseek, glm, minimax) but the CLIProxy model ids
  for those lanes are unconfirmed, so no arm rows are invented for them.
  Runs on those providers are counted as unmapped, never misattributed.
