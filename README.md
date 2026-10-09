# Model Capacity plugin (v0.2.19, all-providers)

Picks the model (and effort) for every run and sets how many agent runs
should run in parallel, so every account's allowance is used before it
resets. Two inputs: CLIProxy burn telemetry and Artificial Analysis
free-API quality data. Purely deterministic -- no classifiers, no vetoes.

**v0.2.5 = SHADOW BY DEFAULT, enforce-capable opt-in.** The default
manifest (`manifest`, the one `package.json` points at) holds NO
`run.model.resolve` capability and no `modelRouting`: the plugin observes
and changes nothing. Every minute the tick records what it *would* have
decided (`GET /shadow`), the concurrency target (`GET /capacity`),
per-account ladders (`GET /ladder`), and the per-agent cap spread
(`GET /caps`); decisions are recorded event-time from `agent.run.started`.
The enforce-capable variant is `enforceManifest` (= `buildManifest({
modelResolve: true })`): it adds `run.model.resolve` with a minimal
`modelRouting.envKeys` list (only the context-ceiling keys `decide` ever
sets) and is installed only after security sign-off. Even then the hook is
gated by the `enforce` config flag (default `false`): with enforcement off
it answers `keep` and nothing changes.

**v0.2.2 = ALL-PROVIDERS.** Arms are data-driven: the lane feed's per-account
`models` lists are the ONLY provider->models source -- no provider list is
hardcoded anywhere, so a new account or model added to CLIProxy is picked up
with zero code changes. AA slugs resolve by normalization (provider-prefix
strip, dots->dashes, `-free`/`-1m`/date-suffix strip, `-contributor` to xhigh
effort) plus a small `MODEL_AA_OVERRIDES` table for verified mismatches
(operator-extendable via `modelAaOverrides`). Models with no AA match build
no arm and are reported `unscored` on `/capacity` (with the serving
accounts), never silently dropped and never invented. Families without fleet
success history route as capped trials (doer and other roles by default;
thinkers never; adapter-gated) until measured success graduates them; reactive accounts (vendor publishes no
meter) are eligible while healthy. Shadow decisions are recorded event-time
from `agent.run.started` when the resolver is absent, and run->account
mapping uses resolved actual models.

**v0.2.6 = RUN-ACCOUNTING FIXES.** Trial budgets are consumed in all three
decision paths (tick, hook, event-time); the per-account reactive/trial
cap counts per-account in-flight plus per-account pending in every path
while provider-pool totals order allocation only; terminal runIds are
retained for the full ring horizon; `agent.run.cancelled` is subscribed
and terminal; terminal `payload.modelDecision.model` is authoritative for
attribution and graduation.

**v0.2.19 = USABLE TARGET, POOLED CALIBRATION, SMOOTHING, QUALITY-AWARE
PLACEMENT, ELIGIBILITY FROM DATA.** Five changes found while the enforce
install ran live:

1. *The target counts only capacity the roles can use.* An account's slots
   count for a role when, after the role's exclusions (the quality minimum,
   the outcome gate and the `excludeFamilies` override below), the role's
   floor..ceiling
   rung window and trial-role gating, it has a reachable arm
   (`roleLadderAccess`, checked against `decide()` in the tests). The target
   is the sum over roles of (the role's share of queued demand) x (slots of
   the accounts that role can use), so a lane no role can use, or one only
   the idle role can use, adds nothing. A trial-only account is clipped to the
   trial in-flight cap. An uncalibrated (anchor) burn estimate is floored at
   the median measured per-run burn, so a guessed-cheap anchor cannot mint
   more slots than a measured peer. `/capacity` shows `target` (usable),
   `targetRaw` (before smoothing), `targetUnweighted` (quota only, the old
   sum), per-role `roles`, and per-account `eligibleRoles` / `usableSlots`.
2. *Pooled providers calibrate and place as one pool.* CLIProxy round-robins
   a provider's credentials but a run maps to one lane, so per-lane E was one
   lane's delta over every pool run (about pool-width too low) and the
   sibling lanes never calibrated. Same-provider lanes that share a served
   model (or lack a model list) now form a calibration group:
   `E = sum(lane deltas) / runs on any member`, read by every member
   (`calibrationGroups` on `/capacity`). Placement treats a provider's lanes
   as one candidate (shares sum against the pooled in-flight) and spreads
   decisions over the pool's lanes.
3. *Smoothing.* The pooled E and the served target are EWMA-smoothed (30 min
   half-life, six hour staleness; a zero target or a weak calibration passes
   through so a safety shed is never lagged). Per-agent caps on `GET /caps`
   get asymmetric hysteresis: increases pass at once (a cap under demand
   throttles real work), decreases decay on the half-life and never below
   `running` or the new want (reason `held`, with `baseAllocated`).
4. *Placement weighs arm quality; outcomes are reported.* Inside a need band
   accounts rank by `qualityWeight x fleet quality + allowanceWeight x
   allowance`: fleet quality is the arm's z-score across every served arm
   (per-account Q cannot compare across accounts), allowance is the pool's
   unspent share on [-1, 1]. The allowance term spans at most
   `2 x allowanceWeight` (default 0.7 z), so spare allowance breaks ties
   between similar arms and cannot outbid a larger quality gap; bands (pace)
   still come first. `placement.qualityWeight: 0` restores pure
   water-filling. `/capacity` -> `familyOutcomes` reports per family whether
   finished runs did their job: the run's issue moved to a disposition
   (done / in_review / blocked / cancelled) or the run created a work
   product. A comment-only disposition needs `issue.comments.read`, which
   this plugin does not hold, so it reads `noChange`; the rate compares
   families on equal terms rather than measuring absolute progress.
5. *Eligibility from data.* Which arms may serve a role is decided by a
   per-role quality minimum and a measured-outcome gate, not a hand-written
   ban list (section "Eligibility from data" below). `excludeFamilies` stays
   as an emergency override and logs a warning while it is non-empty.

**v0.2.7 = DECIDED-ACCOUNT PRESSURE + 1M CLAUDE EMIT.** The per-account
in-flight the caps check now includes decided (ring-carry) pressure per
accountId, so enforced runs count against their lane until a terminal event
instead of resetting every tick; the tick moves (never duplicates) a mapped
run's pressure unit onto the decided pool/account; the hook ignores the
run's own started-before-hook shadow entry and its enforced entry replaces
it; the clamp bound covers non-terminal carry inside the horizon (long runs
keep steering); the lane feed path is pinned like baseUrl. Separately, 1M
claude arms on Claude-CLI adapters emit `<model>(<effort>)[1m]` (the CLI
ignores MAX_CONTEXT_TOKENS for claude-* ids; it is never set for them),
and run mapping normalizes `[1m]` and effort parens away.

**v0.2.8 = CARRIED-RING RECONCILE + RELATIVE-ONLY DEADBAND + ACCOUNT
CHURN (reconcile behavior superseded by v0.2.10 below).** On a worker's
first tick per company the carried ring reconciles
against the run feed: entries whose runs are not verifiably non-terminal
count 0 (`reconciledRingDropped`; the persisted ring self-heals), because
the clamp bound includes the carry and cannot catch dead-run inflation
itself. The rate deadband is relative-only (±15% of required, no absolute
floor, `rateMinDeadbandPerHour` retired): a stall reads as maximum deficit
and any real shortfall on a small-required account climbs. Accounts are
fully feed-driven: vanished accounts get no decisions and drop out of the
report and target, brand-new providers/models are eligible on the next
tick with zero config, and non-healthy accounts freeze their pointer and
report action `excluded` instead of a misleading hold.

**v0.2.9 = EXCLUDED QUOTA + PERSIST-GATED RECONCILE.** Unhealthy accounts
contribute zero quota to the concurrency target (their measured burn still
calibrates, but dead quota is not sustainable concurrency), and the
reconcile-once flag sets only after a successful persist, so a tick that
dies mid-write reconciles again on the next tick instead of trusting memory.

**v0.2.10 = ONE LEDGER, NEVER DELETE.** Run accounting is a single pure
module (`src/ledger.mjs`), one record per runId
`{runId, agentId, decidedAccount (+enforced), actualAccount, startedAt,
terminalAt, status}`. In-flight attribution is decided-first (a hook/shadow
decision always outranks the agent-config model guess, so enforced runs
count on their lane until a terminal event), else the resolved actual
account, else unattributed. In-flight = non-terminal and anchored inside
the stale horizon. Restart reconcile only marks horizon-old or
anchor-less records `unverified` (excluded, reported as
`reconciledUnverified`) -- it NEVER deletes, so the shadow log (an
append-only view over the same records, trimmed by size/age only)
survives restarts with enforced flags intact. This supersedes the v0.2.8
`reconciledRingDropped` behavior (retired): carried decisions inside the
horizon keep counting instead of dropping to 0. The tick, the hook, and
event-time all read and write through `recordDecision` / `recordStart` /
`recordTerminal` / `inFlightBy(pool|account)` / `trialInflight(family)`;
the parallel queues are gone. Hook/event-time pressure since the last tick
is structural (decisions the frozen live view does not yet reflect), so a
frozen clock can never double-count.

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
   take only the `trials.roles` roles (default doer and other; thinkers
   never), need an opted-in `adapterType` (`trials.adapters`;
   unlisted adapters get no trial arms), a free per-family in-flight slot
   (`trials.maxInFlightPerFamily`, default 2), and bypass the burn check
   (their burn is unmeasured by definition; the in-flight cap bounds the
   blast radius). `defer` happens only when no account has headroom.
   Run events rarely carry `adapterType`, so the tick resolves it from the
   agent record (`agents.read`, already declared; 10-min TTL, 500-entry
   cap, failures never cached) and stamps it onto the runs; the live view
   publishes the fresh map for the memory-only hook and event-time path.
   An agent that does not resolve keeps trial arms gated (stable defer).
7. **Concurrency** `C* = sum(requiredRate_a/E_a) x D` (Little's law,
   `D = 0.186h` measured fleet mean run duration). `E_a` is calibrated
   per calibration group (pooled lanes together, see v0.2.19) from lane
   weekly-used deltas divided by event runs started on the group in the
   span (runs mapped by exact served-model match off resolved actuals,
   falling back to provider, then model-family hints). Until any `E` is
   measured the result is `calibration: weak` with no target and no caps.
   Guard-capped accounts contribute zero; a 75 hard ceiling binds the
   total. Slots count only for roles that can use the account (v0.2.19).
8. **Allocation (water-filling, v0.2.3)**: each decision goes to the
   largest `(targetShare_a - inFlight_a)` inside the need band
   (metered-behind, then reactive, then metered-ahead/over-burning).
   `targetShare_a = requiredRate_a / E_a` (same term as the C*
   concurrency target). In-flight is pooled at the **provider level**:
   CLIProxy round-robins same-provider lanes onto shared credentials, so
   lane-level spreading is theater and provider pressure is real.
   In-flight is read fresh from the ledger per run (decided-first
   attribution, one record per runId) -- the order is re-sorted per run,
   so ten sequential decisions spread in proportion to target shares
   instead of herding onto one argmax winner. Reactive/trial caps still
   apply per account in every path (per-account in-flight plus decisions
   since the last tick); pooled totals order allocation only.

Sol/Luna decisions carry `CLAUDE_CODE_MAX_CONTEXT_TOKENS=260000` to stay
under the 272k price cliff, plus the `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
watermark (configurable via `contextCaps.autoCompactEnvKey`; null omits
it). Claude-* ids never get MAX_CONTEXT_TOKENS (the CLI ignores it for
them and runs haiku at a 200k window): when the arm's AA context window is
>= 1M and the run's adapter is `claude_local`/`claude-code`, the plugin
emits `<model>(<effort>)[1m]` instead, which the CLI strips and runs at 1M.
`decide` returns model/effort first-class and sets nothing else.

The resolve hook is memory-only: it reads the live view the last tick
published and performs zero I/O, so it always answers inside the host's
1.5s RPC deadline. Unknown company, `enforce: false`, a human operator
override (`issueOverrideModel`), and tick staleness over 120s all answer
`keep`. Only an all-accounts-no-headroom fleet answers `defer`
(`retryAfterMs` 60000). Every enforced decision is recorded in the ledger
with `enforced:true` (memory-only; the next tick persists it).

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
WITHOUT headroom, is capped in flight per account (plus that account's
pending decisions: `trials.
maxInFlightPerAccount`, default 2), and ranks after metered-behind-plan
but before metered-ahead-of-plan (use-it-or-lose-it with unknown size).
Over-burning metered accounts sort last. Zero-cost models are fine as
doer trial arms; the AA `costPerTask` decides their rung, not their price.

Trial graduation is measured, not assumed: terminal runs with resolved
models feed per-family finished/failed counters (`/capacity` ->
`trialFamilies`), and a family graduates at `trials.minRuns` runs
(default 10) with `trials.minSuccessRate` success (default 0.8). The run
model is authoritative in this order: terminal
`payload.modelDecision.model` (the applied decision), then resolved
actuals, then agent config -- the agent-config source is a pinned model,
not an observed execution, hence the bar. Cancelled runs are terminal
for slot accounting but feed neither counter. Trial budgets
(`trials.maxInFlightPerFamily`, default 2) are consumed in all three
decision paths (tick, hook, event-time), so a burst inside one tick
cannot overshoot. Graduated families route as full members on the next tick.

Shadow records three provenances: tick decisions, `enforced:true` hook
decisions, and `eventTime:true` decisions recorded memory-only from
`agent.run.started` when the resolver is absent (live view + cached
config, zero I/O, stale views over 120s record nothing). All three write
straight into the ledger (one record per runId, first decision wins,
enforced overwrites event-time) and the tick backfills actual models;
the tick never re-decides a recorded runId. Terminal records persist
until the shadow TTL trims them, so a run that finished more than 60
minutes ago still clears its slot after aging out of the rate window.
Records older than max(3 x mean run duration, 2h) with no terminal event
report under `/capacity` -> `staleInFlightDropped`; horizon-old or
anchor-less records are marked `unverified` and excluded (never
deleted). The clamp backstop is retired (`clampedInFlightDropped` always
0): single-counting is structural now.

`GET /caps` splits the concurrency target across agents in proportion to
CURRENT demand (ledger `running` + assigned `todo`/`in_progress` issues),
never historical share. Below target every agent covers its full demand
(idle agents keep `running + 1` headroom) while the want-sum fits the
fleet ceiling; a wider spike shares the ceiling out by demand instead,
so one more queued item never halves the fleet and the fleet sum stays
within `maxTotal` (75). Every shed is running-first: each agent keeps its
running count, then only the remaining new slots split by demand share --
at/above target the fleet starts nothing new. No cap lands below
`running`; only pre-existing running can hold a total over target.
Each entry reports `demand`, `running`, `allocated`, and `reason`
(`full-demand` | `headroom` | `proportional` | `floor-running` |
`capped-ceiling`). Weak calibration (no target) returns `agents: []`.

## Configuration

`placement.qualityWeight` (default 1) and `placement.allowanceWeight`
(default 0.35) tune the placement blend; `qualityWeight: 0` is the kill
switch back to pure water-filling.

### Eligibility from data

An arm serves a role only if it passes both gates; the operator list
`roles.excludeFamilies` is applied on top. Each exclusion is a token in the
list the decision code already honors: a family (`muse`) or one arm
(`arm:<armId>`), so the target, placement, the hook and the event-time path
all see the same set. `/capacity` shows it (`roleExclusionsEffective`) and
the evidence (`eligibility`): every arm's fleet Q (`qFleet`,
`qFleetThinker`) with its verdict and reasons per role, the outcome gate's
per-family evidence, and warnings.

**1. `roles.minQuality`** (`{ doer, thinker, other }`, number or `null`).
The minimum is on the same Q the ladder uses (AA metrics plus the EEE
prior, same weights and blend), scored once over the whole served fleet so
an arm has one Q per role across accounts (the per-account Q is relative to
one lane's arm set and cannot be compared across lanes). Thinkers are judged
on their own blend (`qFleetThinker`). Below the minimum the arm is
ineligible for that role on every account; an arm with no score fails closed;
`null` turns the minimum off for the role. New models are scored and placed
automatically. Q is a z-score, so a minimum is only meaningful over a
population: with fewer than 8 scored arms the minimum is not applied
(`fleet-too-small` warning).

**2. `roles.outcomeGate`** (per family and role, from the run ledger).
Evidence is the family's most recent `lastRuns` finished runs inside
`windowHours` whose outcome was judged: it *progressed* if the issue moved
to a disposition (done / in_review / blocked / cancelled) or the run created
a work product, else *noChange*. Failed runs belong to the arm breaker,
cancelled runs say nothing about the model, unreadable outcomes are not
misses. A family is gated for a role when it has at least `minRuns` judged
runs, its progress rate is below `minProgressRate`, AND below
`relativeToBest` of the best-measured family's rate for the same role. The
relative clause means the best family is never gated and a role where every
family reads low (reviewers answer in comments, which the plugin cannot
see) keeps all of them. Recovery is by aging: a gated family gets no new
runs, its evidence leaves the window (the ledger keeps 24 hours), it drops
under `minRuns` and is eligible again; if it still does not do the job,
`minRuns` runs later it is gated again.

The outcome gate judges a family as a whole for a role: the efforts of one
family are not separated (the quality minimum is per arm). Its sample is
small by nature, which is why it needs `minRuns` and a better-measured
comparison family before it acts. An arm with no benchmark score at all
cannot be placed on a ladder in the first place; it is listed as
`unscored` and fails a set minimum.

**Safety.** If the gates would leave a role with no arm on any account, the
outcome gate is given back for that role first, then the quality minimum
(`role-empty-suspended`, with the `gates` named, in `/capacity`); a role can
never be emptied into a defer loop by data. The operator list always
applies.

Defaults (all configurable):

| setting | default | meaning |
| --- | --- | --- |
| `roles.minQuality.doer` | -1.0 | doers: only the bottom tail is out |
| `roles.minQuality.thinker` | 0.4 | thinkers: Opus / Sonnet max, xhigh / Gemini 3.1 Pro |
| `roles.minQuality.other` | -1.0 | same as doers |
| `roles.outcomeGate.enabled` | true | |
| `roles.outcomeGate.minRuns` | 12 | judged runs before a family can be gated |
| `roles.outcomeGate.minProgressRate` | 0.5 | gate below this ... |
| `roles.outcomeGate.relativeToBest` | 0.75 | ... and below this share of the best family |
| `roles.outcomeGate.windowHours` | 24 | evidence window (clamped to the ledger's 24) |
| `roles.outcomeGate.lastRuns` | 40 | only the most recent N judged runs count |

Where the numbers come from (AA-only fleet Q, 2026-10-09 leaderboard; the
EEE prior only moves these by a quarter at most):

| family | Q, 20 classic arms | Q, 28 arms (+7 served models) |
| --- | --- | --- |
| opus | 1.31 .. 1.56 | 1.13 .. 1.32 |
| sonnet | -0.23 .. 0.89 | 0.10 .. 0.86 |
| gemini | - | 0.21 .. 0.83 |
| kimi | - | 0.45 |
| sol | 0.16 .. 0.20 | 0.31 .. 0.35 |
| muse | 0.63 | 0.32 |
| astra | -0.40 .. 0.31 | -0.11 .. 0.24 |
| haiku | -0.49 .. 0.01 | -0.10 .. 0.19 |
| glm | - | 0.06 |
| luna | -1.86 .. -0.17 | -1.07 .. 0.04 |
| grok / qwen | - | -0.14 / -0.33 |
| deepseek | - | -0.96 |
| gpt-oss | - | -1.75 |

Reading it: the doer floor at -1.0 removes gpt-oss and the weakest Luna
efforts and nothing else. The thinker floor at 0.4 separates Opus, Sonnet
and Gemini Pro from Codex, Muse, Haiku and Luna in the larger fleet, but the
gaps are about 0.1 and the fleet moves the line (in the 20-arm fleet Muse
scores 0.63 and Sonnet xhigh 0.32), so read `eligibility.arms` on the live
`/capacity` and adjust the number before relying on it. Q does not rank
Muse low; keeping it off doers is the outcome gate's job, and until the
gate has `minRuns` judged runs and a comparison family it has no verdict.

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
failed, cancelled), recorded into the per-company ledger in memory and
persisted each tick under `ledger-v1` (legacy `runs-v1` /
`shadow-ring-v1` keys are read once for upgrade migration) -- no
database capabilities exist (the host executes plugin
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

- `src/manifest.mjs` -- shadow-default manifest, opt-in `enforceManifest`, `buildManifest` variant flag
- `src/cliproxy.mjs`, `src/aa.mjs` -- edge clients (pure + guards)
- `src/arms.mjs`, `src/quality.mjs`, `src/ladder.mjs` -- ladder math
- `src/pacing.mjs`, `src/decide.mjs`, `src/concurrency.mjs` -- control
- `src/pools.mjs` -- calibration groups and pooled burn per run
- `src/smoothing.mjs` -- EWMA and per-agent cap hysteresis
- `src/outcomes.mjs` -- run outcome classification and per-family report
- `src/shadow.mjs` -- bounded shadow ring (unit-tested legacy helper)
- `src/ledger.mjs` -- the run ledger: one record per runId, decided-first
  attribution, mark-but-never-delete reconcile, append-only shadow view
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
