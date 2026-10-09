# Model Capacity plugin (v0.2.3, all-providers)

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

**v0.2.2 = ALL-PROVIDERS.** Arms are data-driven: the lane feed's per-account
`models` lists are the ONLY provider->models source -- no provider list is
hardcoded anywhere, so a new account or model added to CLIProxy is picked up
with zero code changes. AA slugs resolve by normalization (provider-prefix
strip, dots->dashes, `-free`/`-1m`/date-suffix strip, `-contributor` to xhigh
effort) plus a small `MODEL_AA_OVERRIDES` table for verified mismatches
(operator-extendable via `modelAaOverrides`). Models with no AA match build
no arm and are reported `unscored` on `/capacity` (with the serving
accounts), never silently dropped and never invented. Families without fleet
success history route as capped trials (doer-only, adapter-gated) until
measured success graduates them; reactive accounts (vendor publishes no
meter) are eligible while healthy. Shadow decisions are recorded event-time
from `agent.run.started` when the resolver is absent, and run->account
mapping uses resolved actual models.

## How it decides (per account, per run)

1. **Arms** (model x effort) the account serves (its feed `models` list),
   joined to the AA snapshot by slug. Ladders are per account: a model the
   feed stops serving leaves every ladder automatically. The snapshot
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
   test-fail +1, rate-limit reroutes, context-window filter. Trial arms
   (families without fleet success: gemini, kimi, grok, claude-4-6, ...)
   are doer-only, need an opted-in `adapterType` (`trials.adapters`;
   unlisted adapters get no trial arms), a free per-family in-flight slot
   (`trials.maxInFlightPerFamily`, default 2), and bypass the burn check
   (their burn is unmeasured by definition; the in-flight cap bounds the
   blast radius). `defer` happens only when no account has headroom.
7. **Concurrency** `C* = sum(requiredRate_a/E_a) x D` (Little's law,
   `D = 0.186h` measured fleet mean run duration). `E_a` is calibrated
   per account from lane weekly-used deltas divided by event runs
   started on the account in the span (runs mapped by exact served-model
   match off resolved actuals, falling back to provider, then
   model-family hints). Until any `E` is measured the result is
   `calibration: weak` with no target and no caps. Guard-capped accounts
   contribute zero; a 75 hard ceiling binds the total.
8. **Allocation (water-filling, v0.2.3)**: each decision goes to the
   largest `(targetShare_a - inFlight_a)` inside the need band
   (metered-behind, then reactive, then metered-ahead/over-burning).
   `targetShare_a = requiredRate_a / E_a` (same term as the C*
   concurrency target). In-flight is pooled at the **provider level**:
   CLIProxy round-robins same-provider lanes onto shared credentials, so
   lane-level spreading is theater and provider pressure is real.
   In-flight = mapped running runs UNION fresh ring would-decisions for
   unfinished runs (deduped by runId) PLUS decisions already made this
   tick -- the order is re-sorted per run, so ten sequential decisions
   spread in proportion to target shares instead of herding onto one
   argmax winner. Reactive/trial caps still apply (per account, now also
   counting this tick's pending decisions as a single-tick burst bound).

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

Eligibility: health must read exactly `healthy` (unknown/unavailable/
exhausted/degraded accounts never qualify), and metered accounts need
known headroom above the reserve. Effective headroom is the 5h meter when
present, else the weekly remaining as a fallback pool guard -- but ONLY
for accounts whose feed entry carries a `models` list. A metered account
with no 5h signal and no `models` list is a broken reading (the CISO
unknown-headroom case) and stays excluded: it is NOT granted the weekly
fallback. A REACTIVE account is different: the vendor publishes no meter
at all (`meter`/`quality` reads `reactive`, no weekly numbers exist), so
there is no meter to be broken -- a healthy reactive account qualifies
WITHOUT headroom, is capped in flight per account (`trials.
maxInFlightPerAccount`, default 2), and ranks after metered-behind-plan
but before metered-ahead-of-plan (use-it-or-lose-it with unknown size).
Over-burning metered accounts sort last. Zero-cost models are fine as
doer trial arms; the AA `costPerTask` decides their rung, not their price.

Trial graduation is measured, not assumed: terminal runs with resolved
models feed per-family finished/failed counters (`/capacity` ->
`trialFamilies`), and a family graduates at `trials.minRuns` runs
(default 10) with `trials.minSuccessRate` success (default 0.8). The
agent-config source is a pinned model, not an observed execution, hence
the bar. Graduated families route as full members on the next tick.

Shadow records three provenances: tick decisions, `enforced:true` hook
decisions, and `eventTime:true` decisions recorded memory-only from
`agent.run.started` when the resolver is absent (live view + cached
config, zero I/O, stale views over 120s record nothing). The tick merges
all three, backfills actual models (entries first, then the runs they
came from), and never re-decides a recorded runId.

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
  `{ used (0..1|null), resetsAt (ISO|null) }`, a `quality`
  flag, the served model ids (`models`), the vendor-meter kind (`meter`:
  absent/`reactive` = the vendor publishes no usage numbers), and the pool
  name where applicable. Until the ref is wired the plugin runs degraded:
  no live reads, ladders frozen, shadow records the gap.

The CLIProxy client only ever issues that one GET. Anything else is
blocked in code and covered by the allowlist test. The plugin worker
never touches CLIProxy directly (private IPs are blocked from
`ctx.http.fetch`) and the CLIProxy management key stays on the host --
the host service does passive-first plus single-account live pull,
server-side. Readings are cached 45s (`cliproxy.cacheTtlSec`).

Run facts come from `agent.run.*` events only (started, finished,
failed), buffered in memory and merged with a persisted run ring in
plugin state -- no database capabilities exist (the host executes plugin
SQL unchanged, so a core-table grant's tenant filter would be
plugin-enforced only; refused scope, removed in v0.2.1). `/capacity`
says so (`runsSource: 'events'`). Each shadow entry records
`actualModel` plus `modelMatch` (did shadow agree with
reality; null while the actual model is unknown). The actual model
resolves the run event first, then the issue's assignee adapter
override, then the agent's adapter config -- via the
already-declared `issues.read` / `agents.read`, no new capabilities.
Unknown-resolution reasons are stable codes (`no-issue-id`,
`agent-read-unavailable`, ...), never upstream text.
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
- Graduated trial families on metered accounts route nowhere until their
  per-run burn calibrates (uncalibrated arms are skipped when headroom is
  known): most trial families live on reactive accounts, where the burn
  check does not apply, so this bites only if a trial family graduates on
  a metered lane. If it does, the fix is patience (E calibrates from lane
  deltas) or a `calibration` anchor, not code.
