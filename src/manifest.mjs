/**
 * Plugin manifest. v0.2.2 = ALL-PROVIDERS (data-driven arms, trial lanes,
 * reactive-account eligibility, event-time shadow). v0.2.9 = SHADOW BY
 * DEFAULT: the default export holds NO `run.model.resolve` capability and no
 * modelRouting; it observes and records only. The enforce-capable variant
 * (`enforceManifest` = `buildManifest({ modelResolve: true })`) is opt-in and
 * ships only after security sign-off; even then the `enforce` config flag
 * (default false) keeps the hook answering `keep` until the operator flips it.
 *
 * v0.2.19 = USABLE TARGET + POOLED CALIBRATION + SMOOTHING + QUALITY-AWARE
 * PLACEMENT: the concurrency target counts only capacity some role can use
 * (family exclusions, role rung window, trial gating) weighted by queued
 * demand; same-provider lanes that share a served model calibrate and place
 * as one pool; the pooled burn and the target are EWMA-smoothed and the
 * per-agent caps carry decay hysteresis; account placement blends fleet arm
 * quality with a bounded unspent-allowance term (`placement` config; weight
 * 0 restores pure water-filling); /capacity reports per-family run
 * outcomes. No capability, egress, secret or env-key change.
 *
 * v0.2.20 = RESERVED PER-AGENT FLOORS: `caps.reservedFloors` holds queued
 * agents at `min(demand, clamp(base + floor(queued / perQueued), base,
 * max))`, applied after the allocator and the hold with reason
 * `reserved-floor`; floors win the fleet ceiling and suspend while every
 * tracked arm is breaker-open. Empty by default. No capability, egress,
 * secret or env-key change.
 *
 * v0.2.21 = WEEKLY EXHAUSTION OVERRIDES AN IDLE 5H METER: an account whose
 * weekly remainder is at or below 1% reads headroom = that remainder (source
 * `weekly`), reports action `excluded`, and counts as unhealthy for the
 * eligibility empty-role guard and the concurrency census. Above the floor
 * the 5h meter stays the burst guard. No capability, egress, secret or
 * env-key change.
 *
 * v0.2.22 = BREAKER STATE PERSISTS: breaker-v1 was keyed by the in-memory
 * NUL-joined pair key; Postgres jsonb rejects the NUL escape, so every
 * write with a known or tripped arm failed and the tick's state froze.
 * Persisted keys are now the JSON pair; loading re-keys from each entry.
 * No capability, egress, secret or env-key change.
 *
 * v0.2.23 = PINNED AGENTS: `roles.keepAgentIds` (empty default) lists agents
 * whose runs always keep their configured model. The hook answers keep for
 * them, the event-time path never routes them, and the shadow tick records
 * the kept model on the account that serves it. No capability, egress,
 * secret or env-key change.
 *
 * v0.2.24 = DECIDE CLIMBS PAST EMPTY RUNGS: when no arm fits at or below the
 * pacing pointer (lower arms excluded for the role or over the burn check),
 * decide walks up to the role ceiling before deferring. Exclusions, the
 * burn check and the role window still apply. No capability, egress,
 * secret or env-key change.
 *
 * v0.2.25 = EXACT SERVED IDS: a lane feed with servedModels filters arms
 * before scoring or building ladders; older feeds remain fail-open. No new
 * capability, egress, secret or env-key change.
 *
 * v0.2.26 = OUTCOME BENCHMARK SKIPS UNSERVABLE FAMILIES: a family that
 * cannot serve a role is never the outcome gate's benchmark for it, so it
 * cannot gate the families that can: the operator's list, a quality-gated
 * family, one whose arms are all covered by `arm:` tokens, or one with no
 * arm in the fleet (its runs stay in the 24h window). The benchmark follows
 * the quality suspension, so a suspended quality gate lets its families
 * benchmark again. No capability, egress, secret or env-key change.
 *
 * v0.2.40 = PACE-GUARD DEFER REASON COUNT: the mixed-hold defer reason
 * counts distinct unpaced accounts (the duplicate-pass order listed each
 * account twice). The deferred-mark TTL, the mixed-hold defer and
 * `paceGuard.unattributedInFlight` shipped in 0.2.39 and are unchanged.
 * No capability, egress, secret or env-key change.
 *
 * v0.2.41 = PROVIDER-PREFIXED EMISSION FOR AGGREGATOR LANES: decisions emit
 * the account's exact served id (`servedIdForArm`: a `devin/<id>` lane emits
 * `devin/<id>`, never the bare id that 400s as unknown provider or misbills
 * to the native lane serving the bare id; native alias-only accounts keep
 * the bare emission). The servedModels guard requires the account's exact
 * emitted id (`servedIdForArm`) to occur in the served list, so
 * prefixed-only arms stay servable and a bare id no route serves stays
 * refused, with the same fail-open on feeds that publish no list.
 * `400 unknown provider` / `unrecognized_model`
 * classify breaker-fatal, and a new decide `unservable` failure class never
 * escalates onto the next rung of the same account. Same-family newer-version
 * dominance runs inside each account ladder (dash minors compare, so
 * gpt-5-5 displaces gpt-5-4 on flat cost). 1M claude decoration keeps the
 * prefix. No capability, egress, secret or env-key change.
 *
 * v0.2.45 = DOER-STARVATION SCOPE: per-provider liveRuns/idle on the supply
 * signal (one provider's reviewer traffic no longer masks another provider's
 * idle headroom) plus a C*-vs-live-doer starvation wake sustained across
 * ticks (default gap >= 4 runs for 10 minutes, persisted start, unknown
 * target never wakes). Review-response fixes ride along (history-span
 * warmup, bypass stamp restore, allocator-parity reviewer/supply, durable
 * wake seq). No capability, egress, secret or env-key change.
 *
 * v0.2.53 = BURN MODE + PER-LANE PACE GUARD + WHOLE-PERCENT RATE: config
 *   burnMode.accounts (id, lane, feed label/email, provider:*, ! excludes)
 *   paces named accounts to min(reset, now + horizonMinutes), never paces or
 *   reserve-holds them and routes to them first; the pool pace guard judges
 *   each lane on its own plan (a behind-plan lane is never throttled by a
 *   spent sibling); a flat whole-percent meter extends its rate window to
 *   the last tick (6h) and never reads 0 with runs in flight. No capability,
 *   egress, secret or env-key change.
 * v0.2.70 = READ-ONLY MODEL INVENTORY ON /capacity: `modelInventory` keeps
 *   the raw, canonical and emitted spelling of every reported model id side
 *   by side with per-account served present/absent/unknown (absent list reads
 *   unknown, fail-open as routing does), the linked unscored/unservable/
 *   readiness evidence, and explicit unknown markers for protocol/tool/
 *   reasoning compatibility and configured-model coverage (other-agent
 *   adapter configuration is restricted). Pure reporting; routing reads
 *   nothing from it. No capability, egress, secret or env-key change.
 * v0.2.71 = ALERT-ONLY FAILURE-CLUSTER DETECTOR: failed-run events feed
 *   per-account counters in plugin state; >= 3 allowlisted failures for one
 *   account inside a 15-minute event-time window creates/updates exactly one
 *   stable-origin managed alert issue (transition-only writes, never per
 *   run) and reports error through plugin health until the cluster clears.
 *   Opt-in via `failureClusterAlert` (disabled by default; writes only with
 *   an explicit assignee agent id). Alert-only: no disabling, no routing
 *   change, no enforce-flag touch. Adds exactly `issues.create` +
 *   `issues.update` (create/update field allowlists + ownership checks in
 *   failure-clusters.mjs); no other capability, egress, secret or env key.
 * v0.2.72 = POLICY-CACHE INVALIDATION ON CONFIG CHANGE: per-company config
 *   generations fence the cached routing policy; a source replacement at
 *   unchanged TTL refetches, a config change retires the live view (the
 *   resolve hook defers instead of routing on a stale snapshot), and a late
 *   old-generation tick cannot publish. Cache hits never refresh source
 *   observation time or extend evidence/authorization expiry. Company and
 *   source identity isolate entries. No capability, egress, secret or
 *   env-key change.
 * v0.2.66 = synthetic.new lanes, spent at their regeneration rate:
 *   synthetic / synthetic-infinite are prefixed-only (emit synthetic/<id>,
 *   never the bare id CLIProxy 400s or routes to another provider);
 *   burnMode.floors holds a matched account at a level floor (at or below
 *   it the account takes no runs; no bar reading = no runs), reading the
 *   lane's regenerating bar (feed meterInfo.weeklyUsed) else its weekly
 *   meter, and a burn account above its floor routes before other burn
 *   accounts, so spend tracks regeneration and the bar is never full;
 *   contextCaps.servedIds sets a context ceiling per emitted model id
 *   (synthetic serves 524,288 tokens); a trials.roles entry 'role:family'
 *   ('thinker:glm') opens one trial family to one role. Empty or missing
 *   config decides exactly as before. No capability, egress or secret
 *   change; env keys unchanged.
 * v0.2.65 = Sol/Luna context caps on every path: GPT-6.1 Sol runs at
 *   contextCaps.solMaxTokens 890000 / solAutoCompactTokens 870000 (no price
 *   cap: no long-context fee on subscription usage, OpenAI 2026-10-11; 32k /
 *   52k under the ~922k input ceiling measured 2026-10-22), Luna and
 *   pre-6.1 Sol ids stay at lunaMaxTokens 260000 / lunaAutoCompactTokens
 *   240000 (legacy solLuna* keys alias Luna).
 *   One env builder (contextCapsEnv) serves decide(), routed reviews (0.2.61
 *   emitted env {}), kept/pinned agents and the stale-snapshot keep (a keep
 *   on a Sol/Luna model answers a decide on the same model with the caps).
 *   The Sol window is a ceiling a tier cap can only lower; other arms keep
 *   tier cap, else Luna caps. No capability, egress or secret change; env
 *   keys unchanged.
 * v0.2.64 = double-quantum regression lock-in: the 12:31Z recurrence (two
 *   lanes, one quantum each on under one attributed run) is replayed as a
 *   test; both lanes keep the group prior and hold their slots. No behavior,
 *   capability, egress, secret or env-key change.
 * v0.2.63 = account-weekly guards: a weekly sample prices only on >=10
 *   attributed runs and only when its baseline agrees with the group prior
 *   within 4x; otherwise the prior is kept and /capacity names the rejection
 *   (calibrationRejectionReason), the attempted runs and the unattributed
 *   request share (1 - prior/baseline) per lane and per group. No capability,
 *   egress, secret or env-key change.
 * v0.2.62 = AA cost carry: the refresh carries the last known cost and prices
 *   forward per slug when a refresh drops them (marked costCarriedFrom), and
 *   a scored arm with no cost anywhere takes the family then fleet median
 *   (marked costEstimated) instead of losing its ladder rungs. /capacity
 *   arms report both marks. No capability, egress, secret or env-key change.
 * v0.2.61 = per-account burn deadlines: burnMode.deadlines maps an account
 *   matcher (same identity semantics as accounts) to a strict ISO-8601
 *   timestamp with an explicit Z or numeric offset; a burn account matching
 *   a future deadline paces to
 *   min(reset, burn horizon, now + horizonMinutes, deadline), and /capacity
 *   reports the winning bound as paceTargetAt/paceTargetSource
 *   (reset | horizon | deadline). Past deadlines are ignored; empty or
 *   missing deadlines decide bit-for-bit as before. No capability, egress,
 *   secret or env-key change.
 * v0.2.60 = reviewer routing obeys the pace guard: held lanes are not candidates, and a review that only held lanes
 *   could serve defers instead of keeping its pinned model unpaced.
 * v0.2.59 = pace guard follows measured burn: an ahead lane whose measured rate exceeds its required rate has its
 *   paced slots scaled by required/measured (floor 0.1), so expensive runs cannot outspend the plan.
 * v0.2.58 = runnable kept/review demand: kept agents and reviewerRouting agents
 *   count actual queued heartbeat runs (new capability
 *   agents.queued_counts.read) instead of assigned open cards, so stale
 *   review backlog cannot claim the fleet target; /caps reports demandSource
 *   per agent (issues | heartbeat-runs | heartbeat-runs-unavailable).
 * v0.2.57 = burn accounts that the lane feed degraded only by its utilization floor (healthReason 'peak utilization')
 *   stay allocatable until weekly >= 0.995 or the five-hour bucket is full; other degraded causes stay excluded.
 * v0.2.56 = kept-agent caps: a pool pace cap bounds only its paced accounts; burn-mode accounts (exempt from
 *   the pace guard) add their slots on top, so a kept Reviewer on burn lanes is not clamped to the paced lanes.
 * v0.2.55 = cheapest capable model: pacing never climbs to pricier rungs for spend (pacing.climbForSpend, default
 *   false); unused quota goes to throughput.
 * v0.2.54 = burn-mode accounts count their burn end in the fleet C* need.
 * v0.2.53 = REVIEWER ROUTING ACROSS PROVIDERS: reviewer.providers falls back
 *   to reviewReserve.providers (Claude AND Meta lanes size reviewer slots);
 *   optional reviewerRouting { agentIds?, arms } routes listed review agents
 *   to the best arm (burn-mode accounts, then the pool most behind plan)
 *   instead of keep, falling back to keep; /capacity reviewer.routing shows
 *   the decision. Absent config = unchanged. No capability, egress, secret
 *   or env-key change.
 *
 * v0.2.52 = PENDING ARM-ID DISAMBIGUATION: the pending enforced path passes
 *   the decided served id (wouldModel) into the arm-id strip, so a dynamic
 *   arm whose served id ends in an effort word keys verbatim like its
 *   backfilled record while operator armIds keep stripping; the pool anchor
 *   index passes the same context.
 * v0.2.51 = REVIEW NITS: arm keys keep served model ids verbatim unless the
 *   dash suffix equals the keyed effort; the redundant modelMatch branch folds
 *   into the enforced path (no behavior change); target-0 alarm call-site test.
 * v0.2.50 = MUSE MAX EFFORT: Meta accepts reasoning.effort=max for Muse 1.3
 *   Contributor, so the Muse family cap is max (ultra still refused) and
 *   muse-spark-1.3-contributor gains a max arm above its xhigh arm.
 * v0.2.49 = ARM-AWARE BURN CALIBRATION: burn per run is measured per arm
 * (model+effort) per calibration pool instead of per account. Pooled meter
 * deltas split across the arms that ran in the span by responsibility; pricing
 * follows the current ledger run mix with cost-anchor priors for unmeasured
 * arms (rescaled off the measured arms, measurement-era anchors recorded per
 * arm), so an arm switch reprices within one tick instead of waiting out
 * meter quanta. A dominant-arm change segments the pooled EWMA and the
 * members' old-mix individual estimates at once past a 60% share and 25%
 * reprice hysteresis; only enforced (or model-confirmed) decisions attribute
 * by arm id, others key by the executed model, and fresh counter estimates
 * re-base onto the mix price on a segmented tick. Ledger decisions record
 * effort and the shadow log exposes the decided arm. No capability, egress,
 * secret or env-key change.
 *
 * v0.2.48 = AA LEADERBOARD RESILIENCE (2026-10-17 fleet stall): a leaderboard
 * fetch or parse failure keeps the previous snapshot's leaderboard-derived
 * rows and never stores an empty leaderboardSlugs over a non-empty one; the
 * parser reads the current `initialModels` page (any first slug) plus the
 * legacy `models` embed and maps the renamed terminalBench21/40 and
 * percentile/quartile speed fields to the canonical names; error-level logs
 * fire when every account ladder is empty or the served target reads 0 with
 * healthy accounts. 0.2.47 shipped first, so this takes 0.2.48.
 * No capability, egress, secret or env-key change.
 *
 * v0.2.47 = PLAN-FIRST CREDIT FALLBACK: credit-funded lanes sort after
 * subscription lanes with role-usable headroom; credit-funded capacity does
 * not inflate role concurrency while plan capacity remains. The
 * credits.priority setting defaults to fallback and can be set to normal to
 * restore the previous ordering. No capability, egress, secret or env-key change.
 *
 * v0.2.46 = PER-ACCOUNT PLAN CALIBRATION + CREDIT POOLS + VERIFIED RAMP:
 * meter-aligned per-account burn individualizes E within a calibration
 * group (pooled E stays the cold-start prior; a missing or reset peer
 * counter leaves the whole group on the prior); weekly-spent accounts with
 * a spendable free-credit balance stay available, paced to drain the credit
 * pool over the credit horizon. Upward capacity events (new account, reset,
 * guard end, recovery) no longer serve the raw target at once: the v0.2.44
 * instant bypass is retired and verified additional capacity ramps on a
 * 5-minute half-life over a bounded 30-minute window, only for
 * already-calibrated accounts (an uncalibrated feed addition keeps full
 * damping); the rung-cooldown bypass on upward transitions is unchanged.
 * No capability, egress, secret or env-key change.
 *
 * v0.2.44 = REVIEWER ROUTING + CAPACITY AUTO-HEAL: reviewer is a first-class
 * role (runnable capacity from qualified providers, default Claude only, plus
 * the hold/resume signal the review gate reads); feed diffs bypass the rung
 * cooldown and target smoothing on upward transitions (new account, reset,
 * guard end, recovery) and persist a capacityChange wake event; new-account
 * warmup ignores measured rates from < 60 min of history (linear/burn-horizon
 * position pacing until then); /capacity gains reviewer, capacityChange and a
 * demand-aware supplySignal for idle fleets with headroom near reset.
 * 0.2.43 is claimed by an open PR, so this takes 0.2.44. No capability,
 * egress, secret or env-key change.
 *
 * v0.2.42 = BURN HORIZON FOR PROVIDER FREE RESETS: accounts pace to
 * min(regular reset, H) with H = lastFreeReset + Q_q(residual gaps) from the
 * feed's `freeResets` section (Codex seeded from codex-reset.com, every
 * provider from the host restore ledger; backtest q=0.5 default). The horizon
 * feeds the required rate, the plan position and the C* concurrency need
 * (one pace term throughout: targetShare and C* stay the same ratio); 5h
 * guard, exhaustion floor and review reserve are untouched. No data, or an
 * unknown regular reset, reads as today's linear pace bit-for-bit;
 * `burnHorizon.enabled:false` is the kill switch. No capability, egress,
 * secret or env-key change.
 *
 * v0.2.39 = REVIEW-RESERVE REVIEW ROUND: pinned review runs price from
 * their pinned model (hottest arm only when the model matches nothing), so
 * a Haiku-pinned reviewer no longer burns at Opus price; a one-sided
 * rMin/rMax inversion against the other bound's default fails validation
 * instead of silently resetting both bounds. No capability, egress, secret
 * or env-key change.
 *
 * v0.2.38 = CROSS-ACCOUNT DOMINANCE + AGGREGATOR FALLBACK-ONLY: a rung is
 * dropped when the same family has a newer or better arm (higher fleet Q,
 * cost <=) on any qualified account with headroom, so old Sol on Devin no
 * longer survives next to gpt-6.1-sol on Codex. Devin duplicates of a
 * qualified native's models are held back from the first routing pass (used
 * only when the native and unique arms place nothing); Devin-unique models
 * (swe-*, etc.) keep band 1. No capability, egress, secret or env-key change.
 *
 * v0.2.37 = OPT-IN CREDENTIAL READINESS: `credentialReadiness.enforce`
 * (default false) gates credential-readiness admission. Off mode admits
 * evidence-free feeds like the pre-enforcement behavior while still parsing
 * and reporting readiness in `/capacity`; on mode keeps exact fail-closed
 * enforcement. No capability, egress, secret or env-key change.
 *
 * v0.2.35 = OPERATOR LIST YIELDS ON STRUCTURAL EMPTINESS: when the
 * operator's list alone would leave a role with no arm anywhere in the
 * fleet-wide arm set, the fewest of its entries are suspended for that
 * role, strongest banned family first, and the data gates keep as much
 * strength as the role allows (`manual-suspended` in /capacity). The
 * structural view is readiness-independent (unfiltered ranking rungs), so
 * a lane outage, an excluded account, an open breaker, or transient
 * all-cooling/expired/zero-serving evidence never lifts the list; the
 * role defers until the lane recovers. Emptiness is judged on the
 * operator list alone, never with the data gates on. A single-provider
 * fleet keeps deciding every role. No capability, egress, secret or
 * env-key change.
 *
 * v0.2.30 = TIER-AWARE QUOTA BURN: `burnPerRunPct` prices the context-tier
 * multiplier while `contextCaps.tierAffectsQuota` holds (default true), so
 * pacing, the decide burn check, concurrency and target shares see the
 * effective cost on subscription lanes where quota charges the tier price.
 * False restores base-cost burn. No cap is emitted for the infeasible 100k
 * Haiku cliff (sessions start at ~133k p10). No capability, egress, secret
 * or env-key change.
 *
 * v0.2.28 = PACE GUARD: a provider pool whose lanes average above the linear
 * weekly plan (plus `pacing.guard.marginPct`) is held at max(1, ceil(paced
 * slots)) runs in flight; further runs go to other pools or the hook defers
 * (`pacing.guard.retryAfterMs`). The hook, the event-time path and the
 * shadow tick order accounts through the same guard, so they agree.
 * Unknown plan position or share, and reactive lanes, fail open.
 * `/capacity` reports `paceGuard`. No capability, egress, secret or env-key
 * change.
 *
 * v0.2.32 = LANE HOST PIN: the lane host is no longer written in the public
 * source. src/lane-host.mjs holds a non-routable placeholder and the package
 * build replaces that one file with the real origin; the manifest enum, the
 * config validator and the config fallback all read it, so the key still
 * goes to exactly one compile-time origin. An unpinned build refuses the
 * lane read before it resolves the lane key, and onHealth reports degraded.
 * With the pin overlaid: no capability, egress, secret or env-key change.
 *
 * v0.2.36 = REVIEW RESERVE: the demand-driven share of each reserved
 * provider's pace (default: claude) held back for review runs -- native port
 * of the host stopgap. Per-provider R = clamp(review need / sustainable
 * capacity, 0.10, 0.95); need is the APF-style demand envelope (mean + 1
 * stdev over the trailing 3 closed hourly review-burn hours, instant rise,
 * 3h half-life decay) plus queued reviews x measured % per review run over
 * 8h. No review waiting: the reserve is lent (R at the floor, nothing held)
 * and reclaimed through admission. Accounts above (elapsed + margin) x (1 -
 * R) on the weekly or 5h window are held for non-review runs (released in
 * the last 24h / 45 min before each reset); review runs
 * (`reviewReserve.agentIds`, default `roles.keepAgentIds`) and pinned agents
 * bypass. Review burn prices `burnPerRunPct`, so tier-multiplied models burn
 * at tier price. `/capacity` reports `reviewReserve`. `enabled: false`
 * restores pre-reserve admission. No capability, egress, secret or env-key
 * change.
 *
 * v0.2.14 = ARM CIRCUIT BREAKER: per-(account, arm) self-protection that
 * learns from finished-run failed events. Two arm-fatal failures (provider-
 * side model errors: unknown provider/model, auth_unavailable, missing
 * entity, 400-about-model) in 30 min open the breaker for 6h (doubling per
 * consecutive reopen, capped at 48h); a half-open single enforced probe
 * closes it on success. Transients (429, overload, disconnects, context
 * exhaustion) never trip. State persists bounded per company; /capacity
 * surfaces `armBreakers`.
 *
 * v0.2.13 = LOAD-GUARD FIX: the tick calls loadLedger directly, so a
 * failed ledger-v1 read aborts before any persist (plus a loadedOk persist
 * guard); the memory-only fallback stays on the event / event-time / hook
 * paths only. The post-await merge still saves runs recorded mid-load.
 *
 * v0.2.12 = LOAD RACE FIX: the load merges the post-await map entry, so
 * runs recorded while the state read is pending survive.
 *
 * v0.2.10 = LEDGER ACCOUNTING: run accounting lives in one pure module
 * (src/ledger.mjs), one record per runId; restart reconcile marks but never
 * deletes; the shadow log is append-only.
 *
 * v0.2.11 = REVIEW ROUND 5: calibration counts actual burn (enforced picks
 * only); persist trim sheds dead weight and hard-bounds the ledger blob;
 * GET /shadow honors the requested limit; single-flight ledger loads; SDK
 * reads pass companyId positionally (no object-form first attempt).
 *
 * v0.1.2: burn telemetry comes from ONE host-published lane endpoint
 * (GET {baseUrl}{accountsPath}, X-Api-Key lane key). The plugin worker
 * cannot reach CLIProxy directly (private IPs are blocked) and the
 * management key stays on the host.
 */

import { DEFAULT_BASE_URL, DEFAULT_ACCOUNTS_PATH, LANE_ACCOUNTS_PATH_ALLOWLIST } from './cliproxy.mjs';
import { LANE_BASE_URLS } from './lane-host.mjs';
import { REVIEW_REPOSITORY_PATTERN } from './review-demand.mjs';

export const PLUGIN_ID = 'togetherweown.model-capacity';
export const PLUGIN_VERSION = '0.2.75';

/**
 * Lane endpoint allowlist: the ONLY host `cliproxy.baseUrl` may name.
 * The origin comes from the build-time pin in lane-host.mjs.
 */
export const LANE_BASE_URL_ALLOWLIST = Object.freeze([...LANE_BASE_URLS]);

/**
 * Env keys a run.model.resolve decision may set. Minimal by construction:
 * `decide` returns model/effort first-class and only ever sets the keys
 * below, so none of model-selection's PIN_LANE / ANCILLARY keys
 * (PAPERCLIP_ASSIGNED_MODEL, CLAUDE_CODE_SUBAGENT_MODEL,
 * ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL,
 * ANTHROPIC_SMALL_FAST_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL) are needed.
 */
export const MODEL_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
];

const SECRET_REF = {
  type: 'object',
  required: ['type', 'secretId'],
  additionalProperties: true,
  properties: {
    type: { const: 'secret_ref' },
    secretId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    version: { type: ['string', 'integer'] },
  },
};

const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cliproxy: {
      type: 'object', additionalProperties: false,
      properties: {
        // Pinned: the lane key must never be sent to any other host. The
        // enum pins it at schema level; validateConfigShape rejects
        // anything else at config-validation time.
        baseUrl: { type: 'string', enum: [...LANE_BASE_URL_ALLOWLIST], default: DEFAULT_BASE_URL },
        // Pinned like baseUrl: the lane key is sent on this request, so
        // the schema pins the feed path and config validation rejects
        // anything else.
        accountsPath: { type: 'string', enum: [...LANE_ACCOUNTS_PATH_ALLOWLIST], default: DEFAULT_ACCOUNTS_PATH },
        laneKeySecretRef: { ...SECRET_REF, description: 'Paperclip secret holding the lane key for the host-published CLIProxy telemetry endpoint (GET {baseUrl}{accountsPath}, X-Api-Key header).' },
        cacheTtlSec: { type: 'integer', minimum: 5, default: 45 },
      },
    },
    aa: {
      type: 'object', additionalProperties: false,
      properties: {
        apiKeySecretRef: { ...SECRET_REF, description: 'Paperclip secret holding the Artificial Analysis free-API key.' },
        maxSnapshotAgeHours: { type: 'number', minimum: 1, default: 30 },
      },
    },
    armMap: {
      type: 'array',
      default: [],
      description: 'Operator arm overrides; empty means the built-in table.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['aaSlug', 'model', 'effort', 'family', 'providers'],
        properties: {
          aaSlug: { type: 'string', minLength: 1 },
          model: { type: 'string', minLength: 1 },
          effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
          family: { type: 'string', minLength: 1 },
          providers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    roles: {
      type: 'object', additionalProperties: false,
      properties: {
        thinkerAgentIds: { type: 'array', default: [], items: { type: 'string' } },
        doerAgentIds: { type: 'array', default: [], items: { type: 'string' } },
        keepAgentIds: { type: 'array', default: [], items: { type: 'string' }, description: 'Agents whose runs always keep their configured model: the hook answers keep and shadow reports the configured model. For gating roles pinned by the operator (e.g. the code reviewer).' },
        excludeFamilies: {
          type: 'object', default: {}, additionalProperties: false,
          description: 'Emergency override: families (or arm:<armId> tokens) removed from a role by hand. Eligibility is decided from data by minQuality and outcomeGate. If this list alone would leave a role with no arm, the fewest entries needed are suspended for that role (manual-suspended in /capacity). A warning is logged while this is non-empty.',
          properties: {
            doer: { type: 'array', default: [], items: { type: 'string' } },
            thinker: { type: 'array', default: [], items: { type: 'string' } },
            other: { type: 'array', default: [], items: { type: 'string' } },
          },
        },
        newestVersionOnly: {
          type: 'object', additionalProperties: false,
          description: 'Prefer newest model versions per account and product line. Disabled by default. Overrides can retain specific arms, models or products, alias products, or pin parsed identities.',
          properties: {
            enabled: { type: 'boolean', default: false },
            overrides: {
              type: 'object', additionalProperties: false,
              properties: {
                keep: { type: 'array', default: [], items: { type: 'string', minLength: 1 }, description: 'Arm IDs, model:<canonicalModel>, product:<productKey>, or arm:<armId> to retain.' },
                productAliases: { type: 'object', default: {}, additionalProperties: { type: 'string', minLength: 1 } },
                parsePins: { type: 'object', default: {}, additionalProperties: {
                  type: 'object', additionalProperties: false, required: ['product', 'version'],
                  properties: { product: { type: 'string', minLength: 1 }, version: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } } },
                } },
              },
            },
          },
        },
        accountFallback: {
          type: 'object', additionalProperties: false,
          description: 'Opt-in account-local fallback for doer and other roles; never relaxes thinker eligibility. minQuality is a fleet Q z-score floor.',
          properties: {
            enabled: { type: 'boolean', default: false },
            roles: { type: 'array', default: ['doer', 'other'], items: { type: 'string', enum: ['doer', 'other'] } },
            minQuality: { type: 'number', default: -0.5 },
          },
        },
        minQuality: {
          type: 'object', additionalProperties: false,
          description: 'Per-role minimum on the fleet-scored quality Q (AA plus the EEE prior, the ladder\'s weights and blend). An arm below the minimum is ineligible for that role on every account. null turns the minimum off for the role. Defaults: doer -1.0, thinker 0.4, other -1.0.',
          properties: {
            doer: { type: ['number', 'null'], default: -1.0 },
            thinker: { type: ['number', 'null'], default: 0.4 },
            other: { type: ['number', 'null'], default: -1.0 },
          },
        },
        outcomeGate: {
          type: 'object', additionalProperties: false,
          description: 'Measured-outcome gate per (family, role): a family whose recent finished runs made progress on their issue below minProgressRate, and below relativeToBest of the best-measured family for the role, is ineligible for that role until its evidence ages out of the window.',
          properties: {
            enabled: { type: 'boolean', default: true },
            minRuns: { type: 'integer', minimum: 1, default: 12 },
            minProgressRate: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
            relativeToBest: { type: 'number', minimum: 0, maximum: 1, default: 0.75 },
            windowHours: { type: 'number', exclusiveMinimum: 0, maximum: 24, default: 24 },
            lastRuns: { type: 'integer', minimum: 1, default: 40 },
          },
        },
        thinkerFloorRung: { type: 'integer', minimum: 0, default: 2 },
        thinkerCeilingRung: { type: ['integer', 'null'], minimum: 0, default: null },
        doerFloorRung: { type: 'integer', minimum: 0, default: 0 },
        doerCeilingRung: { type: ['integer', 'null'], minimum: 0, default: null },
      },
    },
    weights: {
      type: 'object', additionalProperties: false,
      description: 'Quality composite weights (research defaults summed to 1; v0.1.2 adds hle with the rest scaled x0.9).',
      properties: {
        terminalBench: { type: 'number', minimum: 0, default: 0.36 },
        scicode: { type: 'number', minimum: 0, default: 0.18 },
        tau2: { type: 'number', minimum: 0, default: 0.09 },
        apexAgents: { type: 'number', minimum: 0, default: 0.09 },
        intelligenceIndex: { type: 'number', minimum: 0, default: 0.09 },
        hle: { type: 'number', minimum: 0, default: 0.1 },
        omniscience: { type: 'number', minimum: 0, default: 0.045 },
        lcr: { type: 'number', minimum: 0, default: 0.045 },
      },
    },
    taskRanking: {
      type: 'object', additionalProperties: false,
      description: 'Role-aware AA task-workload cost priors. Shadow by default; cannot enable model resolution. Accepted-task calibration awaits native attributed outcomes.',
      properties: {
        mode: { type: 'string', enum: ['off', 'shadow', 'enforce'], default: 'shadow' },
        profileVersion: { type: 'string', enum: ['aa-role-v1'], default: 'aa-role-v1' },
        minAbsoluteCoverage: { type: 'number', minimum: .6, maximum: 1, default: .6 },
        roleMetricWeights: {
          type: 'object', additionalProperties: false,
          description: 'Explicit profiles replace defaults for that role. Registered metric keys only; aggregate/component conflicts fail validation.',
          properties: Object.fromEntries(['doer', 'reviewer', 'thinker', 'other'].map(role => [role, {
            type: 'object', minProperties: 1, additionalProperties: { type: 'number', minimum: 0 },
          }])),
        },
        effortSupport: {
          type: 'object',
          description: 'Verified endpoint effort support by exact emitted ID. Classic bindings retain their verified efforts; a family ceiling alone does not verify newly discovered variants.',
          additionalProperties: { type: 'array', minItems: 1, uniqueItems: true,
            items: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] } },
        },
        calibration: {
          type: 'object', additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', enum: [false], default: false },
            windowDays: { type: 'integer', minimum: 7, default: 7 },
            minClosedTasks: { type: 'integer', minimum: 30, default: 30 },
            minAcceptedTasks: { type: 'integer', minimum: 10, default: 10 },
            priorTasks: { type: 'integer', minimum: 30, default: 30 },
            maxRelativeCiHalfWidth: { type: 'number', exclusiveMinimum: 0, maximum: .5, default: .5 },
          },
        },
      },
    },
    eee: {
      type: 'object', additionalProperties: false,
      description: 'EEE benchmark prior (Phase 2): secondary quality signal blended beside AA. Absent/stale artifact keeps AA-only behavior bit-for-bit.',
      properties: {
        blendDoer: { type: 'number', minimum: 0, maximum: 1, default: 0.25 },
        blendThinker: { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
        weights: {
          type: 'object', additionalProperties: false,
          description: 'EEE composite weights (research §3 defaults summed to 1).',
          properties: {
            tb4: { type: 'number', minimum: 0, default: 0.35 },
            bfcl: { type: 'number', minimum: 0, default: 0.15 },
            sweVerified: { type: 'number', minimum: 0, default: 0.1 },
            hle: { type: 'number', minimum: 0, default: 0.1 },
            aaCoding: { type: 'number', minimum: 0, default: 0.1 },
            aaIntel: { type: 'number', minimum: 0, default: 0.15 },
            vals: { type: 'number', minimum: 0, default: 0.05 },
          },
        },
        maxAgeDays: { type: 'number', minimum: 1, default: 7 },
        firstPartyDiscount: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        decayHalfLifeDays: { type: 'number', minimum: 1, default: 120 },
      },
    },
    eeeBlendDoer: { type: 'number', minimum: 0, maximum: 1, default: 0.25 },
    eeeBlendThinker: { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
    eeeWeights: {
      type: 'object', additionalProperties: { type: 'number', minimum: 0 },
      description: 'Flat overrides for EEE composite weights (merged over eee.weights).',
    },
    eeeMaxAgeDays: { type: 'number', minimum: 1, default: 7 },
    eeeFirstPartyDiscount: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
    eeeDecayHalfLifeDays: { type: 'number', minimum: 1, default: 120 },
    pacing: {
      type: 'object', additionalProperties: false,
      properties: {
        deadband: { type: 'number', minimum: 0, default: 0.02 },
        rungCooldownMs: { type: 'integer', minimum: 60000, default: 600000 },
        guardHighPct: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
        guardRejoinPct: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        rateDeadbandRel: { type: 'number', minimum: 0, default: 0.15 },
        rateWindowMin: { type: 'number', minimum: 10, default: 60 },
        rateMinSpanMin: { type: 'number', minimum: 5, default: 10 },
        climbForSpend: { type: 'boolean', default: false, description: 'Owner rule 2026-10-20: false (default) keeps every account on its cheapest capable rung and spends unused quota through throughput; true restores the spend-driven climb to pricier rungs.' },
        guard: {
          type: 'object', additionalProperties: false,
          description: 'Pace guard: a provider pool whose lanes average above the linear weekly plan (plus marginPct) is held at max(1, ceil(paced slots)) runs in flight; further runs go to other pools or are deferred. Applies to the enforcing hook, the event-time path and the shadow tick alike. Unknown plan position, unknown share and reactive lanes fail open.',
          properties: {
            enabled: { type: 'boolean', default: true },
            marginPct: { type: 'number', minimum: 0, maximum: 1, default: 0.02, description: 'Lead on the plan (fraction of the weekly quota) tolerated before the cap applies.' },
            retryAfterMs: { type: 'integer', minimum: 1000, default: 300000, description: 'Retry hint when the hook defers because every eligible pool is held; longer than the plain no-headroom retry because a slot frees when a run finishes.' },
          },
        },
      },
    },
    burnHorizon: {
      type: 'object', additionalProperties: false,
      description: 'Burn horizon: pace each account to min(regular reset, H) with H = lastFreeReset + Q_q(residual inter-arrival gaps) from the feed freeResets section, so quota is spent when a provider free reset lands. Applies to the required rate and plan position only. No data, or enabled:false, reads as linear-to-regular-reset pacing.',
      properties: {
        enabled: { type: 'boolean', default: true },
        quantile: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.5, description: 'Quantile of the residual time-to-next-free-reset (backtest default 0.5).' },
        maxBurnFactor: { type: 'number', minimum: 1, default: 3, description: 'The burn rate never exceeds this multiple of the linear rate.' },
        minHistory: { type: 'integer', minimum: 1, default: 3, description: 'Minimum past gaps before a horizon is trusted.' },
        providerQuantiles: {
          type: 'object', additionalProperties: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
          description: 'Per-provider quantile overrides, e.g. { codex: 0.25 }.',
        },
      },
    },
    burnMode: {
      type: 'object', additionalProperties: false,
      description: 'Burn mode: named provider accounts spend their quota as fast as possible. Each entry matches an account id (meta:meta-lane-3), its lane/accountKey (meta-lane-3), its feed label or email (case-insensitive), or provider:* (every account of a provider); a leading ! excludes. Burn accounts pace to min(reset, burn horizon, now + horizonMinutes, deadline), are never capped by the pace guard or held by the review reserve, and are preferred by routing. deadlines maps the same matchers to ISO-8601 UTC timestamps: a burn account matching a future deadline paces to the earliest one (past deadlines are ignored). floors maps the same matchers to a remaining share: a matched account at or below it takes no runs, and a burn account above it routes first. Empty burns nothing.',
      properties: {
        accounts: { type: 'array', items: { type: 'string', minLength: 1 }, default: [] },
        horizonMinutes: { type: 'number', minimum: 1, default: 60, description: 'Pace horizon for burn accounts (minutes).' },
        deadlines: {
          type: 'object', additionalProperties: { type: 'string' }, default: {},
          description: 'Per-account burn deadlines: matcher (same identity semantics as accounts) to strict ISO-8601 timestamp with an explicit Z or numeric offset (e.g. 2026-10-27T00:00:00Z). A burn account paces to the earliest future deadline it matches; past deadlines are ignored.',
        },
        floors: {
          type: 'object', additionalProperties: { type: 'number', minimum: 0, exclusiveMaximum: 1 }, default: {},
          description: 'Level floors: matcher (same identity semantics as accounts, no ! entries) to the remaining share (0 to under 1) an account keeps, e.g. {"synthetic:*": 0.8}. The reading is the lane regenerating bar (feed meterInfo.weeklyUsed) else the weekly meter. At or below its floor, or with no reading, a matched account takes no runs; a burn account above its floor routes before other burn accounts, so a regenerating bar is spent at its regeneration rate and never sits full.',
        },
      },
    },
    reviewReserve: {
      type: 'object', additionalProperties: false,
      description: 'Review reserve: the demand-driven share of each reserved provider pace held back for review runs (native port of the host stopgap). A reserved-provider account above (elapsed + margin) x (1 - R) on the weekly or 5h window is held for non-review runs; review runs (agentIds, default roles.keepAgentIds) and pinned agents bypass. enabled:false restores pre-reserve admission.',
      properties: {
        enabled: { type: 'boolean', default: true },
        providers: { type: 'array', items: { type: 'string' }, default: ['claude'], description: 'Providers whose pace carries a review reserve.' },
        agentIds: { type: ['array', 'null'], items: { type: 'string' }, default: null, description: 'Review-agent ids admitted past the hold. Null (default) resolves to roles.keepAgentIds.' },
        windowH: { type: 'integer', minimum: 1, default: 6, description: 'Closed hourly burn buckets carried in plugin state.' },
        envWindowH: { type: 'integer', minimum: 1, default: 3, description: 'Demand-envelope window: trailing closed hours for mean + 1 stdev.' },
        envHalfLifeH: { type: 'number', exclusiveMinimum: 0, default: 3, description: 'Envelope decay half-life (hours): rises apply instantly, falls decay.' },
        drainH: { type: 'number', exclusiveMinimum: 0, default: 8, description: 'Backlog drain horizon (hours): queued x per-run % spread over this.' },
        rMin: { type: 'number', minimum: 0, maximum: 1, default: 0.10, description: 'Reserve floor (= lent value while no review waits).' },
        rMax: { type: 'number', minimum: 0, maximum: 1, default: 0.95, description: 'Reserve cap (also the fail-closed value when capacity is unmeasurable).' },
        releaseWeeklyH: { type: 'number', exclusiveMinimum: 0, default: 24, description: 'Weekly hold releases this many hours before the weekly reset.' },
        release5hMin: { type: 'number', exclusiveMinimum: 0, default: 45, description: '5h hold releases this many minutes before the 5h reset.' },
        marginW: { type: 'number', minimum: 0, maximum: 1, default: 0.10, description: 'Pace margin on the weekly allowance (mirrors the feed pace guard).' },
        margin5h: { type: 'number', minimum: 0, maximum: 1, default: 0.15, description: 'Pace margin on the 5h allowance (mirrors the feed pace guard).' },
        exhaustedPct: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.99, description: 'Weekly used fraction at/above which an account leaves reserve capacity.' },
        minRunsPerH: { type: 'number', exclusiveMinimum: 0, default: 0.1, description: 'Minimum runs/h before a measured % per review run is trusted.' },
        runsHalfLifeH: { type: 'number', exclusiveMinimum: 0, default: 6, description: 'Runs-rate EWMA half-life (hours) for the measured % per review run.' },
      },
    },
    reviewer: {
      type: 'object', additionalProperties: false,
      description: 'Reviewer as a first-class role: runnable review capacity from qualified providers plus the hold/resume signal the review gate reads. Claude qualifies today; other providers only after the operator opts them in.',
      properties: {
        providers: { type: 'array', items: { type: 'string' }, description: 'Providers whose accounts may serve review runs. Unset: reviewReserve.providers when set, else [claude].' },
        supplyHeadroomPct: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.30, description: 'Headroom fraction that counts as large unused supply.' },
        supplyHoursToReset: { type: 'number', exclusiveMinimum: 0, default: 120, description: 'Hours-to-reset under which unused headroom counts as close to reset.' },
        doerStarvationMarginRuns: { type: 'number', exclusiveMinimum: 0, default: 4, description: 'C*-vs-live-doer gap (runs) that counts as doer starvation.' },
        doerStarvationSustainMs: { type: 'number', exclusiveMinimum: 0, default: 600000, description: 'How long the gap must persist before the starvation wake fires.' },
      },
    },
    reviewDemand: {
      type: 'object', additionalProperties: false,
      description: 'Opt-in pre-admission PR-head census. Requires an explicitly approved read-only GitHub credential reference; absent/disabled performs no new HTTP reads.',
      anyOf: [{ required: ['enabled'], properties: { enabled: { const: false } } }, { required: ['repositories', 'tokenSecretRef'] }],
      properties: {
        enabled: { type: 'boolean', default: true },
        repositories: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'string', pattern: REVIEW_REPOSITORY_PATTERN.source } },
        tokenSecretRef: { ...SECRET_REF, description: 'Existing read-only GitHub token, never an App private key. No credential is created or rotated.' },
        requiredChecks: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200, not: { const: 'Paperclip Review' } }, default: ['ci-ok', 'pr-lint'] },
      },
    },
    reviewerRouting: {
      type: 'object', additionalProperties: false,
      anyOf: [
        { required: ['enabled'], properties: { enabled: { const: false } } },
        { required: ['arms'] },
      ],
      description: 'Reviewer routing: runs of the listed agents (default reviewReserve.agentIds) are routed to the first-ranked arm whose provider has a healthy, non-exhausted account with headroom instead of keeping the adapter model. Ranking: plan before credit headroom, burn-mode accounts, the pool most behind its pace plan, the most remaining quota per hour, then arm order. No arm qualifies: keep. Absent (or enabled:false) = keep, exactly as before. When disabled, arms may be omitted; supplied arms are still validated.',
      properties: {
        enabled: { type: 'boolean', default: true },
        agentIds: { type: ['array', 'null'], items: { type: 'string', minLength: 1 }, default: null, description: 'Review-agent ids routed. Null (default) resolves to reviewReserve.agentIds.' },
        arms: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', additionalProperties: false, required: ['provider', 'model'],
            properties: {
              provider: { type: 'string', minLength: 1, description: 'Provider pool, e.g. claude or meta.' },
              model: { type: 'string', minLength: 1, description: 'Model id emitted for the run, e.g. muse-wonder-full-1.0-contributor.' },
              effort: { type: 'string', minLength: 1, description: 'Effort emitted for the run, e.g. max.' },
            },
          },
        },
      },
    },
    concurrency: {
      type: 'object', additionalProperties: false,
      properties: {
        maxTotal: { type: 'integer', minimum: 1, default: 75 },
        meanRunDurationHours: { type: 'number', exclusiveMinimum: 0, default: 0.186 },
      },
    },
    allocation: {
      type: 'object', additionalProperties: false,
      properties: {
        blockingPriority: {
          type: 'boolean', default: false,
          description: 'Weight scarce new slots by unsatisfied demand, transitive open-card fan-out (capped at 100) and highest ready-card priority. Requires native relation arrays in issues.read payloads; missing fields or failed reads retain the legacy allocation. Active mode bounds new slots by target and ceiling, including smoothing and reserved floors.',
        },
      },
    },
    contextCaps: {
      type: 'object', additionalProperties: false,
      properties: {
        solMaxTokens: { type: 'integer', minimum: 1, default: 890000, description: 'GPT-6.1 Sol max context (CLAUDE_CODE_MAX_CONTEXT_TOKENS) on every path: decide, routed reviews, kept agents. A ceiling: a tier cap from the price-tier feed may lower it, never raise it. Default 890000 = 32k under the measured ~922k subscription input ceiling (2026-10-22: 917,354 accepted, ~941k context_too_large); no long-context fee on subscription usage (OpenAI 2026-10-11), so no price cap.' },
        solAutoCompactTokens: { type: 'integer', minimum: 1, default: 870000, description: 'GPT-6.1 Sol auto-compact watermark (never above solMaxTokens); 52k under the ~922k ceiling.' },
        lunaMaxTokens: { type: 'integer', minimum: 1, default: 260000, description: 'Max context for Luna and pre-6.1 Sol ids without a tier cap (under the 272k price cliff); an arm tier cap from the feed wins, as before.' },
        lunaAutoCompactTokens: { type: 'integer', minimum: 1, default: 240000, description: 'Auto-compact watermark for Luna and pre-6.1 Sol ids.' },
        solLunaMaxTokens: { type: 'integer', minimum: 1, description: 'Deprecated (0.2.65): alias of lunaMaxTokens (lunaMaxTokens wins). Never sets the GPT-6.1 Sol window.' },
        solLunaAutoCompactTokens: { type: 'integer', minimum: 1, description: 'Deprecated (0.2.65): alias of lunaAutoCompactTokens (lunaAutoCompactTokens wins). Never sets the GPT-6.1 Sol window.' },
        autoCompactEnvKey: { type: ['string', 'null'], default: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' },
        haikuMaxOutputTokens: { type: 'integer', minimum: 1, default: 64000 },
        tierAffectsQuota: { type: 'boolean', default: true, description: 'Apply context-tier multipliers to quota burn and pressure accounting, not only ladder order. True by default (subscription lanes charge tier price); false restores base-cost burn.' },
        servedIds: {
          type: 'object', default: {},
          description: 'Context ceiling per emitted model id (case-insensitive, provider prefix kept, (effort)/[1m] ignored), e.g. {"synthetic/glm-5.3": {"maxTokens": 480000, "autoCompactTokens": 450000}} for a lane that serves a smaller window than the model. Lowers the window every other rule picks, or sets one; never raises it.',
          additionalProperties: {
            type: 'object', additionalProperties: false, required: ['maxTokens'],
            properties: {
              maxTokens: { type: 'integer', minimum: 1 },
              autoCompactTokens: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    enforce: {
      type: 'boolean', default: false,
      description: 'Kill switch for run.model.resolve enforcement. False (default): the hook answers keep and nothing changes. True: the hook decides from cached tick state.',
    },
    credentialReadiness: {
      type: 'object', required: ['enforce'], additionalProperties: false,
      description: 'Credential-readiness admission is opt-in until every lane account publishes a valid envelope. Check /capacity counts before enabling.',
      properties: {
        enforce: { type: 'boolean', default: false },
      },
    },
    failureClusterAlert: {
      type: 'object', additionalProperties: false,
      description: 'Alert-only failure-cluster detector (default off). When enabled with an assignee agent id, >= 3 allowlisted failures for one account inside 15 minutes creates/updates one managed alert issue and reports error through health until the cluster clears. Disabled or unassigned: zero issue writes.',
      properties: {
        enabled: { type: 'boolean', default: false },
        assigneeAgentId: { type: 'string', default: '' },
      },
    },
    exhaustion: {
      type: 'object', additionalProperties: false,
      description: 'Deferral-exhaustion (Design B): the host retries a deferred run as a new runId up to 12 times and then freezes the card. When enabled, the hook stops deferring on the last attempts of the chain (default from attempt 11) and answers with the cheapest selectable free-overflow arm under the existing trial caps, else a bounded keep; metered pools ahead of plan are never selected. Disabled (default): every terminal still defers, exactly as before.',
      properties: {
        enabled: { type: 'boolean', default: false },
        finalAnswerFromAttempt: { type: 'integer', minimum: 1, maximum: 12, default: 11, description: '1-based chain attempt from which the hook answers instead of deferring (12 is the host retry budget).' },
      },
    },
    freeLanes: {
      type: 'object', additionalProperties: false,
      description: 'Opt-in additive free capacity outside paid C*. Only explicitly listed low-risk issue agents qualify. Provider request rates size slots, not an API request limiter.',
      properties: {
        enabled: { type: 'boolean', default: false },
        minQuality: { type: 'number', default: 0.4, description: 'Strict fleet-normalized quality floor for free arms. Unknown quality is denied.' },
        lowRiskAgentIds: { type: 'array', default: [], items: { type: 'string', minLength: 1 } },
        providers: { type: 'object', default: {}, additionalProperties: {
          type: 'object', additionalProperties: false, required: ['requestsPerMinute'],
          properties: {
            requestsPerMinute: { type: 'number', exclusiveMinimum: 0 },
            requestsPerMinutePerSlot: { type: 'number', exclusiveMinimum: 0, default: 12 },
            requestsPerDay: { type: 'integer', minimum: 1 },
            requestsPerRun: { type: 'number', exclusiveMinimum: 0, description: 'Required with a daily limit. Estimated requests reserved per admission, including failures.' },
          },
        } },
        demotion: { type: 'object', additionalProperties: false, properties: {
          lastRuns: { type: 'integer', minimum: 1, maximum: 1000, default: 10 },
          minSuccessRate: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
          windowHours: { type: 'number', exclusiveMinimum: 0, maximum: 24, default: 24 },
        } },
      },
    },
    trials: {
      type: 'object', additionalProperties: false,
      description: 'Trial lanes for model families without fleet success history (roles-gated, adapter-gated, in-flight-capped until measured success graduates them).',
      properties: {
        maxInFlightPerAccount: { type: 'integer', minimum: 1, default: 2 },
        maxInFlightPerAccountByProvider: {
          type: 'object', default: {},
          description: 'Provider-scoped reactive in-flight cap per account (lower-cased provider name to integer >= 1, e.g. {"nvidia-nim": 1}). Overrides maxInFlightPerAccount only for that provider; every other provider keeps the global value. Empty (default) keeps every provider on the global cap.',
          additionalProperties: { type: 'integer', minimum: 1 },
        },
        unscoredServedIds: {
          type: 'array', default: [], description: 'Exact served ids admitted as unscored trial arms with required provenance. Q remains null; normal trial roles, adapters and caps apply. Only legacy routing; proven families and banned models are refused. An unpriced unscored arm cannot route.',
          items: { type: 'object', additionalProperties: false, required: ['servedId', 'reason'], properties: { servedId: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } },
        },
        maxInFlightPerFamily: { type: 'integer', minimum: 1, default: 2 },
        minRuns: { type: 'integer', minimum: 1, default: 10 },
        minSuccessRate: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
        roles: {
          type: 'array', items: { type: 'string' }, default: ['doer', 'other'],
          description: 'Roles that may take trial arms. Default doer + other; thinkers never take trial traffic (unmeasured by definition). A role:family entry (thinker:glm) lets that role take trial arms of that family only.',
        },
        adapters: {
          type: 'object', default: { claude_local: ['*'], 'claude-code': ['*'] },
          description: 'Adapter type to trial-eligible families ("*" means any family). Unlisted adapters get no trial arms.',
          additionalProperties: { anyOf: [{ const: '*' }, { type: 'array', items: { type: 'string' } }] },
        },
      },
    },
    bannedModels: { type: 'array', default: [], items: { type: 'string', minLength: 1 }, description: 'Additional bare model ids; this list only widens the mandatory bans on gpt-6-sol and gpt-5.6-terra, which cannot be removed.' },
    modelAaOverrides: {
      type: 'object', default: {},
      description: 'Operator extensions to the AA-slug override table: CLIProxy model id to AA slug (or { slug, effort }). Merged over the built-in table.',
      additionalProperties: { anyOf: [{ type: 'string' }, { type: 'object' }] },
    },
    breakers: {
      type: 'object', additionalProperties: false,
      description: 'Arm circuit breaker: provider-side model errors open per-arm breakers (cool-off, half-open single probe). Balance/credit exhaustion is an unconditional immediate lane-wide trip; enabled:false is the kill switch.',
      properties: {
        enabled: { type: 'boolean', default: true },
        tripCount: { type: 'integer', minimum: 1, default: 2 },
        windowMin: { type: 'number', exclusiveMinimum: 0, default: 30 },
        cooloffHours: { type: 'number', exclusiveMinimum: 0, default: 6 },
        maxCooloffHours: { type: 'number', exclusiveMinimum: 0, default: 48 },
        probeTimeoutMs: { type: 'integer', minimum: 60000, default: 7200000 },
        fatalPatterns: {
          type: 'array', default: ['unknown provider for model', 'unknown provider', 'unrecognized_model', 'unrecognized model', 'auth_unavailable', 'no auth available', 'requested entity was not found', 'model_not_found', 'model not found', 'invalid model', 'unknown model', '400+model', 'model is unavailable', 'no healthy managed'],
          description: 'Case-insensitive substring hits; entries with "+" need every part ("400+model") and are vetoed by transient patterns. Balance/credit exhaustion is also recognized as an unconditional immediate lane-wide trip, even when a gateway wrapper omits 402.',
          items: { type: 'string' },
        },
        vetoPatterns: {
          type: 'array', default: ['context length', 'maximum context', 'context window', 'too many tokens', 'max_tokens', 'rate limit', 'rate_limit', '429', 'overload', 'disconnect', 'timeout', 'temporar', 'try again'],
          description: 'Transient guard: vetoes generic ("+") fatal patterns only, never specific ones.',
          items: { type: 'string' },
        },
      },
    },
    calibration: {
      type: 'object', additionalProperties: false,
      description: 'Reference anchor for per-run burn before per-run deltas are observed (flagged weak).',
      properties: {
        referenceArmId: { type: 'string', default: 'claude-haiku-5-5' },
        referenceBurnPerRunPct: { type: 'number', exclusiveMinimum: 0, default: 0.0005 },
      },
    },
    placement: {
      type: 'object', additionalProperties: false,
      description: 'Account placement blend: inside a need band, accounts rank by qualityWeight x fleet quality of the arm they would run + allowanceWeight x unspent allowance on [-1, 1]. The allowance term spans at most 2 x allowanceWeight z-units, so spare allowance breaks ties between similar arms and cannot outbid a larger quality gap. qualityWeight 0 restores pure water-filling.',
      properties: {
        qualityWeight: { type: 'number', minimum: 0, default: 1 },
        allowanceWeight: { type: 'number', minimum: 0, default: 0.35 },
        duplicateVersionPunctuationFolding: {
          type: 'boolean', default: false,
          description: 'Opt in to matching digit-separated dash and dot version spellings for per-arm aggregator duplicate fallback only; emission, benchmark matching and kept defaults are unchanged.',
        },
        freeCostServedIds: {
          type: 'object', default: {},
          description: 'Exact served id to included-price deadline and provenance. Legacy monetary C is zero until the real timezone-explicit ISO deadline; task ranking reports zero cash but still ranks by resource cost. The account and quota costs do not become free. After expiry normal pricing resumes; unscored arms without a price stop routing. Verify the offer applies to the actual serving integration before enabling.',
          additionalProperties: { type: 'object', additionalProperties: false, required: ['until', 'reason'], properties: { until: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } },
        },
        freeCostProviders: {
          type: 'array', default: [],
          description: "Providers whose 'free'-plan accounts place at zero monetary cost (e.g. [\"nvidia-nim\"]): costEffective and ladder cost read 0 while quality bars, quota/burn accounting and climbForSpend stay unchanged. Empty (default) prices every account from Artificial Analysis, exactly as before.",
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    caps: {
      type: 'object', additionalProperties: false,
      description: 'Reserved per-agent floors for /caps: empty by default (no behaviour change until set).',
      properties: {
        reservedFloors: {
          type: 'object', default: {},
          description: 'Agent id to floor: min(demand, clamp(base + floor(queued / perQueued), base, max)). Applied after the allocator and the hold; suspends while every tracked arm is breaker-open.',
          additionalProperties: {
            type: 'object', additionalProperties: false,
            properties: {
              base: { type: 'integer', minimum: 0, default: 4 },
              perQueued: { type: 'integer', minimum: 1, default: 20 },
              max: { type: 'integer', minimum: 0, default: 8 },
            },
          },
        },
      },
    },
    smoothing: {
      type: 'object', additionalProperties: false,
      description: 'Burn/cap damping and asymmetric fleet-target ramp. Verified headroom uses a bounded faster upward ramp; safety sheds are immediate.',
      properties: {
        halfLifeMin: { type: 'number', exclusiveMinimum: 0, default: 30 },
        targetDownHalfLifeMin: { type: 'number', exclusiveMinimum: 0, default: 10 },
        verifiedUpHalfLifeMin: { type: 'number', exclusiveMinimum: 0, default: 5 },
        verifiedUpWindowMin: { type: 'number', exclusiveMinimum: 0, default: 30 },
        staleHours: { type: 'number', exclusiveMinimum: 0, default: 6 },
      },
    },
    credits: {
      type: 'object', additionalProperties: false,
      description: 'Per-account credit pools: credit-funded capacity is a fallback after subscription headroom by default. Free-grant types spend by default; paid types only when listed.',
      properties: {
        priority: { type: 'string', enum: ['fallback', 'normal'], default: 'fallback', description: 'Use credits only after plan headroom (fallback), or allow the prior normal placement ordering.' },
        freeTypes: { type: 'array', items: { type: 'string' }, default: ['codex-credits'], description: 'Free-grant credit types, spendable without further opt-in.' },
        paidTypes: { type: 'array', items: { type: 'string' }, default: [], description: 'Paid credit types the operator additionally allows as capacity.' },
      },
    },
    shadow: {
      type: 'object', additionalProperties: false,
      properties: {
        maxEntries: { type: 'integer', minimum: 100, default: 2000 },
      },
    },
  },
};

/**
 * Build the manifest. Defaults to the shadow-only variant (no resolve
 * capability, no modelRouting). Pass `{ modelResolve: true }` for the
 * enforcement variant: it holds the `run.model.resolve` capability plus the
 * modelRouting envKeys declaration the host requires with it.
 */
export function buildManifest({ modelResolve = false } = {}) {
  const capabilities = [
    'jobs.schedule',
    'plugin.state.read',
    'plugin.state.write',
    'http.outbound',
    'secrets.read-ref',
    'events.subscribe',
    'agents.read',
    // 'agents.queued_counts.read' is declared only once upstream Paperclip ships
    // agents.getQueuedRunCounts: the host validates capabilities against its
    // PLUGIN_CAPABILITIES enum, so an unknown one rejects the whole manifest.
    // The queued-run read below stays optional and degrades to running-only.
    'issues.read',
    // Alert-only failure-cluster singleton (v0.2.71): create/update exactly
    // one stable-origin managed alert issue on cluster transitions. Gated by
    // the disabled-by-default `failureClusterAlert` block, field allowlists
    // and per-write ownership checks (see failure-clusters.mjs). No comment,
    // checkout, wakeup, interaction, document or relation writes.
    'issues.create',
    'issues.update',
    'api.routes.register',
    // No database capabilities: run facts come from SDK surfaces only
    // (agent.run.* events, issues.get, agents.get, the host-aggregated
    // agents.getQueuedRunCounts). The host executes plugin SQL unchanged,
    // so a core-table grant's tenant filter would be plugin-enforced
    // only -- refused scope, removed in v0.2.1.
  ];
  const out = {
    id: PLUGIN_ID,
    apiVersion: 1,
    version: PLUGIN_VERSION,
    displayName: modelResolve ? 'Model Capacity' : 'Model Capacity (Shadow)',
    description: modelResolve
      ? 'Model-capacity routing: paced per-account Pareto ladders from AA quality and CLIProxy burn data. Enforces run models only when the `enforce` config flag is true (default false: hook answers keep).'
      : 'Shadow model-capacity decisions: paced per-account Pareto ladders from AA quality and CLIProxy burn data. Observes only; it changes no runs and holds no resolve capability.',
    author: 'TogetherWeOwn',
    categories: ['automation'],
    capabilities,
    entrypoints: { worker: './src/worker.mjs' },
    instanceConfigSchema: CONFIG_SCHEMA,
    jobs: [
      {
        jobKey: 'aa-refresh',
        displayName: 'Refresh AA free-list snapshot',
        description: 'Daily fetch of the Artificial Analysis free model list plus the public leaderboard page (full flat fields incl. cost), merged per slug into plugin state. Keeps the prior snapshot on any fetch failure. Free API only.',
        schedule: '17 4 * * *',
      },
      {
        jobKey: 'shadow-tick',
        displayName: 'Shadow capacity tick',
        description: 'Every minute: refresh CLIProxy readings on demand, step per-account pacing pointers, recompute the concurrency target, and record what would have been decided for recently started runs. Writes shadow state only.',
        schedule: '* * * * *',
      },
    ],
    apiRoutes: [
      {
        routeKey: 'capacity',
        method: 'GET',
        path: '/capacity',
        auth: 'board-or-agent',
        capability: 'api.routes.register',
        checkoutPolicy: 'none',
        companyResolution: { from: 'query', key: 'companyId' },
      },
      {
        routeKey: 'shadow',
        method: 'GET',
        path: '/shadow',
        auth: 'board-or-agent',
        capability: 'api.routes.register',
        checkoutPolicy: 'none',
        companyResolution: { from: 'query', key: 'companyId' },
      },
      {
        routeKey: 'ladder',
        method: 'GET',
        path: '/ladder',
        auth: 'board-or-agent',
        capability: 'api.routes.register',
        checkoutPolicy: 'none',
        companyResolution: { from: 'query', key: 'companyId' },
      },
      {
        routeKey: 'caps',
        method: 'GET',
        path: '/caps',
        auth: 'board-or-agent',
        capability: 'api.routes.register',
        checkoutPolicy: 'none',
        companyResolution: { from: 'query', key: 'companyId' },
      },
    ],
  };
  if (modelResolve) {
    out.capabilities = [...capabilities, 'run.model.resolve'];
    out.displayName = 'Model Capacity';
    out.modelRouting = { envKeys: [...MODEL_ROUTING_ENV_KEYS] };
  }
  return out;
}

/** Default (and installed-by-default) manifest: shadow only, no resolve capability. */
export const manifest = buildManifest();

/** Opt-in enforce-capable manifest (runtime-gated by the `enforce: false` default). */
export const enforceManifest = buildManifest({ modelResolve: true });
export default manifest;
