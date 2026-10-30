# Model Capacity plugin (0.3.0 native-router source; not activated)

Picks the model (and effort) for every run and sets how many agent runs
should run in parallel, so every account's allowance is used before it
resets. Two inputs: CLIProxy burn telemetry and Artificial Analysis
free-API quality data. Purely deterministic -- no classifiers, no vetoes.

## Build-time variants (no deployment)

Run `npm run build:variants -- --out-dir <new-output-directory>` to produce two
separately named npm tarballs, retaining plugin ID `togetherweown.model-capacity`:

- **0.3.0-transitional**: fork-image transitional dual-capability build, exit
  2026-11-30. Keeps the resolver body and `enforce` switch; native routing is
  governed independently by `router.enabled`. Never install on pristine upstream.
- **0.3.0 clean**: `ai.connections.route` only; no resolver handler, hook
  capability, `modelRouting` declaration, `MODEL_ROUTING_ENV_KEYS` export, or
  `enforce` config field. It is the source worker's default variant.

Artifacts contain baked manifest data and variant-locked factories, not a runtime
capability switch. Thin per-variant manifest/worker entry shims include a source
content stamp so changed manifests can bypass the ESM cache on same-version
reinstalls. Unit tests unpack the actual tarballs, import both worker exports,
and exercise the real committed upstream manifest validator: clean is accepted,
transitional is rejected at the fork-only capability. A same-path/same-version
ESM characterization test proves the shim dependency is cache-busted. These are
**local package proofs**, not staging install/reinstall or G-T runtime evidence;
those native staging gates remain required before any activation.

Historical hook/ladder sections below describe the retained transitional path,
not the clean build's routing mechanism.

## Native router and quota producer (activation gates remain)

The `router` block in `config.example.json` contains fictitious company/owner
UUIDs and a worked example account; replace them before using the generator.
`enabled` defaults to `false`, including when omitted. Both build variants
register `onRouteAiConnection` and declare `ai.connections.route` plus router
catalog metadata. The operator CLI and pure registry, quality, and drift
libraries remain available (see the generator section). Pool
`thresholdPercent` is ignored by this plugin; pacing is reset-relative.

The native `quota-refresh` job (`* * * * *`) replaces `shadow-tick`. It is the
single scheduled quota-feed consumer; the retained hook's capacity computation
reuses that same read. A company-scoped config lifecycle event starts one
asynchronous initial refresh without blocking worker readiness. The job enforces
a ten-second fetch deadline, preserves the prior publication on fetch/parse/state
failure, and rate-limits sanitized failure diagnostics to ten minutes per class.
The upstream SDK drops AbortSignal at its RPC boundary, so the deadline also
locally discards late HTTP answers; it cannot cancel that outstanding host RPC.

`src/snapshot.mjs` builds frozen account views, bounded meter histories and
controller state. One `router-quota-v1` company-state envelope is persisted before
memory publication. Observations older than 120 seconds, missing weekly meters
or non-future weekly resets fail closed. `joinRegistryFeed` runs each tick;
missing non-exempt accounts produce warnings and `staleMemberIds`. An exemption
suppresses only the join warning, never inventing a meter. Snapshot age remains
independent of account observation age.

**A2: operator verification plus a per-call tripwire, not worker inspection.**
Upstream `packages/plugins/sdk/src/types.ts:2205-2313` exposes no native AI pool
inspection client. Full drift/ownership inspection therefore stays in the
read-only generator `--check`, with operator board auth; the plugin never
receives that token or generator batch. The default quota job publishes quota
only, with `inspection: "operator-check"`, no attestation or drift overlay in
its snapshot, and no fabricated `pool-inspection-unavailable` error. The injected
`inspectPools` branch remains a test/operator seam for exercising the real
`checkPoolDrift` library; it is not supplied by the production worker.

Each `router.pools[]` entry may carry all five verified fields together:
`poolId`, `pluginKey`, `expectedRevision`, `expectedMemberOrder`, and
`members[{memberId,accountKey,connectionId,grantId}]`. These assert only what a
clean operator `--check` verified at write time. They are not an inventory or
live truth. Entries without those fields remain valid for M1 shadow, but never
authorize a real call. The example config shows one fictitious verified pool
and two unverified pools; replace the example identifiers with verified reads.
Both manifests schema-validate types, UUIDs, unknown keys, and all-or-none
fields. Worker validation additionally checks registry membership, deterministic
member IDs, matching member sets, and unique pool/binding IDs.

`routeDecision` compares the CURRENT validated config entry with the host call's
pool UUID, plugin key, revision, FULL `memberOrder`, and each candidate's binding
IDs. Host `pool.members` is candidate-narrowed, including for pins, so it is not
compared to the full order (upstream `server/src/services/ai-connection-router.ts:263`).
Any mismatch returns `unavailable`, including for pinned runs; diagnostics name
the tripwire and pool/revisions, never connection/grant IDs. Snapshot contents
cannot attest a pool. The company-scoped frozen fence moves synchronously ONLY
on `onConfigChanged`, before a refresh starts, and clears even on a rejected
notification. The native callback and `plugin.getRouterConfig(companyId)`
share that synchronous call-time accessor; neither reuses a tick's attestation.
The callback performs no SDK reads, network calls, state writes, reservations,
or timer work. Every call emits sanitized R8 facts; R9 configuration failures
and unambiguous dropped-member cases additionally emit error/warning evidence.

Runtime quality/outcome policy reads the current role configuration and the
legacy quota tick's in-memory scored fleet/outcome evidence. It checks the
candidate's **effective runtime effort**, not generation's existential model
verdict. An omitted effort is accepted only when every known variant passes;
unknown/unscored evidence with a configured floor fails closed. Runtime floors
are not suspended to rescue an empty role, and neither pins nor burn bypass them.

**R2 activation blocker, verified against the target upstream source:**
`server/src/services/heartbeat/run-lifecycle.ts:1342-1406` publishes
`agent.run.*` events without model, account, or `contextSnapshot.aiRouterSelection`.
A run-start event is a claim, not evidence of the subsequently selected account.
The SDK agents/issues clients expose no run-selection reader. Therefore these
native events alone cannot satisfy the promised between-tick account overlay.
Model-attributed event fixtures prove the overlay mechanism, **not upstream
availability of that metadata**. Account-less starts are counted visibly under
`/capacity.nativeRouter.unattributedInFlight` and on R8 logs; they are never
attributed from an agent default or a callback reservation. An upstream native
run-account event/read contract (or an explicit revised acceptance contract) is
required before R2/U21 can be claimed end-to-end or activation proceeds.

For attributable events, run-ID sets deduplicate starts/terminal notifications
across ticks. A successful quota publication replaces the base and rebases the
overlay in one synchronous step. Sequence checkpoints retain events received
while persistence is awaiting IO; failed/superseded ticks do not reset it.

The transitional resolver body is byte-identical to branch handoff `52f4c97`.
That handoff already differs from the supplied read-only 0.2.72 reference;
this slice does not port or undo those unrelated differences. Deployed 0.2.73
behavioral parity is a separate required proof, not established by that hash.

Operator sequence (no deployment is authorized by this documentation):

1. Generator `--apply`, then a CLEAN `--check`; copy the verified live pool read
   and binding IDs into ordinary plugin config (account keys from memberIndex).
2. POST `/api/plugins/:pluginId/config/test` with `{companyId,configJson}` and
   require `{valid:true}`. `valid:false` or `supported:false` means do not save.
3. POST `/api/plugins/:pluginId/config` with the same body, then CONFIRM through
   `/capacity.nativeRouter.verifiedPools`: the entry must deep-equal ALL saved
   verified fields plus poolKey, not merely be present by poolKey. This read-time
   echo comes ONLY from the effective fence, never persisted config or quota state.
   It contains IDs only, not credentials. For removal, confirm no entry for that
   poolKey. Routing then uses this fence immediately, subject to a fresh quota snapshot.

The save endpoint schema-validates but PERSISTS BEFORE notifying the worker;
notification errors are non-fatal (`server/src/routes/plugins.ts:2402-2476`).
Relational validation before save exists ONLY at `/config/test` (:2541-2559).
A successful save is therefore not proof of delivery. If a revision-8 edit still
echoes revision 7, the old state remains effective; a revision-8 call fails closed.
Re-POST the same config or restart the plugin worker to re-deliver it, then
re-confirm deep equality (startup replays configChanged in
`server/src/services/plugin-loader.ts:2370-2392`). Never infer delivery from GET config.

Run `--check` before and after every migration checkpoint and Paperclip/plugin
upgrade, plus weekly through the existing native routine-assigned agent task,
never a host timer. A failed check requires removing that pool's verified fields
through the same test/save/confirm sequence, fixing drift, then re-verifying and
reposting. Any pool save bumps its revision and self-closes routing until the
new revision is attested. Between operator checks this design DOES NOT detect
grant/install status changes, connection edits without pool saves, selectable
verdict changes, foreign pools outside config, or a wrong but self-consistent
operator attestation. Host authorization still narrows candidates. A persisted
edit whose notification failed leaves the echoed OLD fence effective. These
weaker between-check guarantees are explicit, not a claim of live inspection.

For unbound pools, the job runs synthetic requests through the same pure
`routeDecision` with `router.enabled` overridden to `true`. This is a registry
and quota simulation, not proof that native connections/pools are installed or
selectable. It uses the current tick's immutable quota view **before** the native
inspection/drift overlay: M1 must record account selections or quota exhaustion
before native pools are created at M3, including in the worker without an
inspector. Quota freshness, missing feed members, and credential evidence still
apply. Only the job's local synthetic call explicitly bypasses the attestation
tripwire via a JS-only option; neither config nor host payload can enable it.
The test/operator inspector seam retains its real-routing drift overlay;
shadow never authorizes a run or changes the real master switch. Both the
snapshot and bounded shadow records commit in the same persist-before-publish
envelope exposed through `/capacity.nativeRouter`. Known bound pools are excluded
from synthetic shadow, mapped through verified tick config in production or the
inspected pool list on the seam. If any live router binding cannot be mapped to a
known pool ID, the job conservatively suppresses **all** synthetic records
for that tick, publishes `shadowSuppressedReason: "pool-bindings-unmapped"`, and
emits a rate-limited warning. It does not guess pool names from UUIDs or claim
those missing records as M1 shadow evidence; quota publication still proceeds.
With no bindings (M1), all configured pools retain their synthetic evaluation.

The policy-backed planner uses the existing `roles.other` floor/outcome gate for
reviewer pools; it fails closed on unknown models and requires scored arm and
outcome evidence. Its model-level verdict is existential over effort variants;
**slice 4** must supply the runtime-effort floor guarantee, burn/overlay/event
wiring and callback registration before claiming selection-policy compliance.
Projection accepts measured per-run cost inputs but defaults to zero where no
credible per-run history exists; it never invents headroom.

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

## Reviewer backlog demand (v0.2.69; opt-in, activation gated)

A slot-metered review gate may enqueue only one review at a time even when many
CI-green PRs await review. Queued heartbeat runs alone cannot size that reviewer.
`reviewDemand` adds proven review-eligible **current PR heads** to heartbeat demand:

```json
{
  "reviewDemand": {
    "repositories": ["example/product"],
    "tokenSecretRef": { "type": "secret_ref", "secretId": "<existing-read-only-token-secret-id>" },
    "requiredChecks": ["ci-ok", "pr-lint"]
  }
}
```

This optional plugin reader uses a fixed read-only GitHub GraphQL query. The
native chat review history starts after admission (and its list is limited to
100 rows); it cannot reveal heads outside the gate. The SDK does not expose
chat review reads or another plugin's private state. No direct database access,
core patch, new credential, or host script is used. **Design approval is not
activation, credential-binding, installation or release approval.** Before
activation, the authorized custodian must evidence the installed host/SDK build
and its fixed-target transport (DNS/IP pinning, private-IP refusal, TLS hostname
verification and no redirect following), plus the existing secret reference's
version, repository selection, read-only metadata scopes, expiry and revocation
path. The SDK drops `RequestInit.redirect`; a mocked `manual` flag is not
transport proof. Incompatible or unverified transport leaves the source disabled.
Absent configuration or `enabled: false` performs no new source I/O.

Only open, non-draft, mergeable PRs whose configured CI checks all succeeded at
the current head count. Missing checks, unknown mergeability, mismatched commit
IDs and truncated check rollups do not count. A same-head Paperclip Review
success/failure is a verdict, not new demand; a missing, pending, or
`ACTION_REQUIRED` review is waiting. Required CI names are explicit because
optional third-party reviews may remain pending; configure the actual CI gate
names for the selected repositories. This signal changes sizing only, never
review/merge admission. Different gate-name sets need separate configuration
in a later extension; do not weaken the list to fit a heterogeneous scope.

The reader caches only aggregate results for five minutes per company/full
configuration (including secret version), coalesces concurrent reads, rejects
non-200/followed responses, and caps collection at 25 repositories, 50 pages,
100 PRs/page and 100 check contexts/head. Owner/repository lengths are bounded
to 39/100 characters; opaque upstream cursors to 4096. Local configuration events
invalidate completed and pending cache generations; no subsequent page is issued
and no pending positive result is published after invalidation. Re-enable starts
fresh. Secret/page/census logical waits are bounded to 5/10/20 seconds. These
logical deadlines do not cancel native I/O: an already-issued request may drain
within the evidenced host transport cap. A failed, partial or rate-limited census
returns `unavailable` and zero added demand, never stale headroom. If configuration
changes during caps processing, that response preserves only running floors,
returns `target: null` and `capsError: "configuration-changed"`, and does not
mislabel the result as breaker cooling. Unavailable
results may be cached too; recovery can therefore take up to five minutes. `/caps.reviewDemand` reports health/count/time; review agents report
`heartbeatQueued` and `reviewEligibleHeads`. The shadow tick includes these heads
before bounding the fleet target. A shared backlog is split once, weighted by the
capacity each reviewer can actually use after heartbeat demand and existing
account/pool/fleet guards; empty admissions and spent pools receive no new shares.
Equal usable capacity splits evenly, with deterministic remainder assignment.

Reviewer identities come from `reviewReserve.agentIds` (defaulting to
`roles.keepAgentIds`) and `reviewerRouting.agentIds`, independently of routing.
Fixed-model reviewers count heads but remain constrained to their serving pool.
Routed reviewer caps use every account admitted by their configured routing arms,
not just the adapter default model's pool. Existing arm/readiness/breaker,
headroom and pace guards remain in force. With blocking priority off, fixed-model
agents reserve first; reviewers share the remaining account/pool budgets and
fleet ceiling. When it is on, all new fixed/reviewer/ordinary slots compete by
resource-feasible weighted quanta as described below. Routing order is unchanged:
this change does not alter primary/helper preference.
The admission snapshot expires after two minutes. Newly stamped admissions also
belong to the producing plugin instance and configuration generation: restart or
configuration change requires a new tick before those helper grants can resume.
Exhausted arms preserve only existing running floors. Undo: disable `reviewDemand` to remove the new
source, or reinstall the prior release to restore the previous cap allocator.

## Role-aware AA task ranking (unreleased)

`taskRanking.mode` is **`shadow` by default**. It computes a proposed route and
adds evidence to `/capacity`; it does not change existing routes, concurrency,
pacing targets, reserves, credit permissions or rate limits. `off` keeps the
legacy scorer/selector. `enforce` opts into role-specific frontiers and
cost-first placement **within existing policy buckets**. The separate plugin
`enforce` flag and opt-in `run.model.resolve` manifest remain authoritative.
This feature cannot enable resolution by itself.

### Quality and identity

AA observations attach to the exact model **and effort**, not a model family.
Discovery enumerates AA effort rows only for served models, deduplicates
classic/dynamic bindings and preserves the exact emitted endpoint ID. Existing
classic bindings verify their already-supported efforts. Other variants remain
`effort-unverified` unless `taskRanking.effortSupport` explicitly lists their
verified efforts by **exact emitted ID**. A family ceiling is not evidence of
endpoint support. Provider/price/contributor aliases can compose, but generation
suffixes are never stripped. Configured benchmark borrowing is labelled
`borrowed`, not measured evidence. A max-row override cannot manufacture a
high-effort measurement. Contributor-only Muse and the GPT-6.1 Sol identity
fences apply in the new path.

Initial profile weights are configurable **priors**, not learned optimal weights:

| Metric | Doer / Other | Reviewer (advisory) | Thinker |
| --- | ---: | ---: | ---: |
| Terminal-Bench 4.0 | .45 | .25 | 0 |
| SciCode | .15 | 0 | 0 |
| HLE | 0 | .20 | .25 |
| GPQA | 0 | 0 | .15 |
| CritPt | 0 | 0 | .15 |
| GDPval normalized | 0 | 0 | .15 |
| LCR | .15 | .20 | .15 |
| IFBench | .15 | .20 | .10 |
| Omniscience non-hallucination | .10 | .15 | .05 |

An explicit `roleMetricWeights[role]` replaces that profile; it does not partially
merge defaults. Finite nonnegative weights, supported metric names, nonempty
profiles and known aggregate/component conflicts are validated. The registry
also classifies cost, feasibility, latency, legacy and diagnostic observations;
using all available evidence does **not** mean double-counting every column.
Hard / 2.1 / 4.0 Terminal-Bench and tau2 / Banking never cross-fill. The legacy
API `codingIndex` is not renamed to Coding Agent Index v2. Headline Omniscience
is higher-is-better on [-100,100]; non-hallucination is higher-is-better on [0,1].
Invalid observations are excluded individually, never zero-filled. Legacy
scoring (including its historical Omniscience inversion) stays isolated for
`off`/`shadow` routing compatibility.

Each role has account-local scores for its frontier and unique-model-effort
fleet scores for capability comparisons. Borrowed/unverified observations and
account copies cannot skew normalization. Common-support and absolute profile
coverage are reported separately. Benchmark trust needs at least .60 absolute
coverage and task-aligned primary evidence (current coding evidence for coding
roles, reasoning evidence for thinkers). Existing EEE freshness/blend settings
and numeric `roles.minQuality` values remain unchanged. Small-population and
known-data empty-role suspensions are explicit; they never grant missing or
borrowed AA evidence normal benchmark trust. `other` initially inherits doer;
an operator can explicitly choose an ops profile using ITBench SRE/tool-use
metrics without introducing another scheduling role or classifier.

Per-run adapter, trial, context, credential, breaker, exclusion and headroom
feasibility is checked before task-frontier pruning, using the same pure
`decide` path as enforcement. An ineligible cheap dominator cannot hide a
feasible backup. Surplus quality/allowance is a tie-breaker, not a reason to buy
a more expensive capable arm. Funding/credit fallback, burn/floor, need bands,
native/aggregator fallback, role rung windows and explicit retry policy still
have authority; this is **not unconditional global cost minimization**.

Configured reviewers remain policy-trusted incumbents, including missing-AA
reviewers. Reviewer metrics are advisory, not permission to substitute a cheaper
model or risk tier. In new enforce mode an approved feasible Meta primary wins
after funding/admission; fallback reasons name quota/headroom, credential,
servability or pace constraints. No approved feasible arm means defer, not
ordinary builder overflow—even on deferral exhaustion. Tick/event observation,
review preview and enforcement share this boundary. Policy incumbency does not
bypass the contributor-only Muse, Sol identity or emitted-servability fences;
reviewer readiness and breaker checks use the policy's exact arm identity.

In task enforce mode, exhaustion may choose another explicitly admitted
model-effort, but cannot issue the legacy bounded default `keep` (including a
caps-only `decide`). The native request does not carry the default effort, so
an admitted sibling effort cannot prove the configured default safe. If no
explicit feasible decision exists, the resolver continues to defer.

### Cost units and calibration boundary

`aaCostPerTask` is AA's **Intelligence Index benchmark workload** cost, not our
cost per merged issue or valid review. `taskCostProxy` applies the existing
context-tier multiplier once. Cost carry retains original per-field ages;
price-profile, family-median and fleet-median fallback sources are explicit.
For example, AA observations of $0.31914442375664703 and $1.3987235612691513
establish a benchmark-workload cost difference, not a fleet productivity ratio.
Token-price blends are not substituted for measured AA workload cost.

`estimatedApiEquivalentPerAcceptedTask` stays null and calibration reports
`awaiting-native-attributed-outcomes`. Lifecycle/issue summaries do not supply
verified actual effort/endpoint pricing, complete failed-attempt usage or
accepted-artifact adjudication. There is **no collector, core-table access,
new model-evaluation traffic, paid subscription or additional egress** here.
`calibration.enabled=true` is rejected until a supported native attributed
outcome surface exists.

The pure calibration helper/tests implement `P/A = (P/N) * (N/A)` over closed
role-task episodes, including failed/rework attempts once, episode-level ratio
uncertainty, sample gates and shrinkage toward the AA proxy. Qualification
requires at least 30 closed tasks, 10 verified accepted outcomes, complete
attribution/usage/pricing, a seven-day window and a 95% relative confidence
half-width <= .5. Pending work is censored; zero acceptance is unusable, never
zero cost. Acceptance must certify a merged/test-passing artifact plus its
observation window, or a valid review with adjudicated finding/escape evidence;
process success, issue status and a reviewer's own score do not establish it.
Learned task cost is never fed back into quota burn. Reconciled cash is separate
and otherwise null; verified-free cash can be zero while resource cost and
quota consumption remain positive.

### Audit and rollout

`/capacity.taskRanking` includes all discovered/unmatched/dominated candidates,
exact effort/slug/match type, metric observations and provenance, AA/EEE
contributions, coverage, trust/minimum verdicts, cost/fallback/tier evidence,
calibration readiness, policy buckets and concrete cheaper-alternative refusal
reasons. Static benchmark dominance is not a hard per-run exclusion. Route
comparisons are **explicit deterministic preview scenarios** (role, configured
adapter type or unknown, null context, no retries), not live task outcomes or
performance measurements. Reviewer routing reports primary/fallback and policy
trust separately.

Before enabling enforcement, inspect these score distributions, coverage,
gate suspensions and each scenario difference against actual lane capabilities;
never lower thresholds just to admit models. Calibration can remain disabled
independently. Roll back with `taskRanking.mode=off`; the next existing native
tick publishes the retained legacy view. During a mode transition, startup without a view, or stale task evidence, the
resolver defers rather than keeping an unvetted default; explicit issue pins
retain authority. No core deployment, database migration,
new job, timer, host script or core patch is required; normal plugin packaging
and installation remain a separate step. Nothing in this PR enables
live enforcement or establishes an optimal model for every individual task.

Methodology: [AA intelligence benchmarking](https://artificialanalysis.ai/methodology/intelligence-benchmarking),
[AA coding-agent benchmarking](https://artificialanalysis.ai/methodology/coding-agents-benchmarking).

## Additive always-on free lanes (unreleased, default off)

`freeLanes.enabled=false` is the default. It adds no jobs, traffic or routing
changes. The existing enforce-capable manifest and `enforce=true` are still
required to select a model. This policy runs inside `run.model.resolve`; it
never edits an agent or changes credentials. There is no host pacer or core
patch.

When enabled, a configured **free-plan** account on a provider in
`placement.freeCostProviders` has a separate provider-wide slot budget. It
never enters paid C*, and its running count does not consume paid demand/caps.
`/capacity.paidTarget` remains paid C*. `/capacity.freeLanes.target` is the
additive budget. Existing consumers see their sum in `/capacity.target`
(also `totalTarget`), bounded by the hard `concurrency.maxTotal` process
ceiling. Free-only capacity reports `partial` calibration with the original
paid confidence in `paidCalibration`; unknown paid capacity is not invented.
`/caps` allocates from paid C* first, then adds free headroom
only to eligible agents, with `allocated` and the existing `maxConcurrentRuns`
field kept in sync. Free admissions never consume paid per-family trial caps.
It holds all existing free running counts even when free capacity is demoted,
paid calibration is weak, or the feature is disabled. If an increased paid
allocation meets existing free runs at the physical process ceiling, only
not-yet-running starts are trimmed; paid C* itself is unchanged. Existing
running work is never cancelled, even if it already exceeds that ceiling. A paid pace hold does not
hold a free provider. If free selection fails, ordinary paid routing continues.
Managed free accounts cannot bypass these checks via the ordinary or
exhaustion path. Other providers and paid trial caps are unchanged.

### Exact low-risk signals

The native hook does **not** carry task text, labels, difficulty, context size,
retry count or review adjudication. Do not infer them from a wake reason.
An operator must list **dedicated low-risk agents** in `lowRiskAgentIds` (for
example, agents whose only assignment is triage or read-only summaries).
Membership is a policy assertion about that agent's entire workload, not a
classifier for arbitrary builder work. Do not list general-purpose builders.
The hook additionally requires all of these existing signals:

- Nonempty `runId` and `issueId`: issue-backed work only.
- Agent role `doer` or `other`, from the existing thinker/doer ID lists.
- No `previous` decision for this company/agent/issue. The host has no failure
  class, so any previous attempt conservatively disqualifies free routing.
- No explicit issue model pin; no `roles.keepAgentIds` entry; no configured
  reviewer identity from reviewer routing or review reserve.
- `adapterType` must allow the family under `trials.adapters`, even after
  graduation. Unknown/unlisted adapters receive no free arm.

`invocationSource` and `wakeReason` are not sufficient evidence of low risk.
A monitor or comment wake can still perform high-impact work. Native human
assignment, explicit connection bindings/router pools and issue pins keep
precedence in Paperclip before this hook is called.

### Rate sizing, daily budget and limits

Slots are `floor(requestsPerMinute / requestsPerMinutePerSlot)`, shared across
**all accounts/keys on that provider**, never multiplied by account count.
The default intensity estimate is 12 requests/minute per running slot. Thus
36 RPM yields 3 slots and 20 RPM yields 1. Configure actual account-wide
provider limits and a conservative measured intensity; these are not provider
lookup tables. A rate below one slot yields zero slots, not a forced minimum.

With `requestsPerDay`, `requestsPerRun` is required. Each admission reserves
that many estimated requests until the UTC day ends, including failed or
cancelled runs. A duplicate hook call for the same admitted run does not
reserve again. The existing native tick persists reservations in company
plugin state (`free-lanes-v1`) along with the run ledger. Like pending routing
decisions, reservations after the last successful tick can be lost in a
worker crash. They are not a billing-grade counter.

**This hook admits runs, not individual provider requests.** The RPM intensity
and per-run reservations are estimates, not proof of compliance with actual
provider RPM/day usage. The proxy/provider's own request limiter remains
necessary. No new proxy limiter or provider integration ships here.
OpenRouter arms must emit an exact `:free` ID; a free-plan account alone cannot
make a paid ID free. Missing AA/served-ID bindings still deny routing (use
existing `modelAaOverrides` only for verified identities). Synthetic, including
its infinite lane, is paid and excluded. Workers AI is excluded because this
feed has no authoritative remaining-free-neurons signal; enabling a provider
name cannot grant permission for paid neurons. NIM `meta/muse-*` is excluded.

### Quality and automatic demotion

`freeLanes.minQuality` is independent of `roles.minQuality`. The default is
**0.4 fleet-normalized Q**, not AA Intelligence Index 40 or a success rate. It
keeps the existing capable-arm bar instead of lowering it just because a
model is free. The cached AA snapshot in
[`test/fixtures/free-lane-aa-evidence.json`](test/fixtures/free-lane-aa-evidence.json)
(2026-10-25) records Step 5 Intelligence Index 43.73 and Terminal-Bench 4.0
0.333, versus GPT-OSS 120B 11.60/0 and Llama 4 Maverick 9.30/0. That evidence
supports a capability floor rather than indiscriminate free routing; it does
not establish an optimal cut point or a task success guarantee. Q depends on
the served population and weights: inspect the current `/capacity` scores
before enabling. This separate floor is **never suspended** for a tiny/empty
population; a missing score is denied. In task-ranking enforce mode, exact
benchmark/effort trust, primary evidence and operational feasibility still
apply. Free policy replaces only the paid quality minimum, not these checks.
Manual exclusions, context caps, credential-readiness mode and arm breakers
remain authoritative.

Default demotion: fewer than 80% successful **measured outcomes among the last
10** for an exact `(free provider, arm)` in 24 hours removes that arm. A failed
run counts as failure. A finished run with a trusted issue baseline counts as
success on `progressed` and failure on `noChange`, using the existing native
status-progress collector. Cancelled/unknown outcomes are excluded, not
successes. All ten failures demote too; there is no best-arm exemption or
empty-role suspension. Evidence expires after the configured window, allowing
a bounded re-trial. Ledger retention can shorten available evidence.

This is an **operational progress proxy, not adjudicated review success**.
The SDK does not expose accepted-artifact/review outcomes. A successful process
exit alone is not evidence of a correct artifact. The feature does not claim
to detect failed reviews that native lifecycle/status signals do not expose.

### Enabling example (merge into existing configuration)

```json
{
  "enforce": true,
  "placement": { "freeCostProviders": ["nvidia-nim", "openrouter"] },
  "freeLanes": {
    "enabled": true,
    "minQuality": 0.4,
    "lowRiskAgentIds": ["dedicated-triage-agent"],
    "providers": {
      "nvidia-nim": { "requestsPerMinute": 36, "requestsPerMinutePerSlot": 12 },
      "openrouter": {
        "requestsPerMinute": 20,
        "requestsPerMinutePerSlot": 12,
        "requestsPerDay": 1000,
        "requestsPerRun": 100
      }
    },
    "demotion": { "lastRuns": 10, "minSuccessRate": 0.8, "windowHours": 24 }
  }
}
```

Replace the agent ID and validate rate/intensity assumptions for your account.
The OpenRouter daily example permits at most ten **new admissions** per UTC
day, not 1,000 agent runs. Only already served, benchmark-qualified,
adapter-compatible arms qualify. No API key, account, free model or live
configuration is created by this example. Enabling/editing waits for a matching
native tick, including the first tick after startup. A stale snapshot cannot
fall back to `keep` on a managed free default and bypass admission; it defers
until the native tick refreshes. Disabling stops new free decisions immediately. Roll back with
`freeLanes.enabled=false`. The flag-off regression also compares decisions,
capacity, caps, shadow and persisted state against the absent-feature path.

## Automatic account plan sizing

No provider/plan-size table is needed. The accounts feed can include credential-attributed
Keeper counters alongside each account's meters:

```json
{
  "observedAt": "2026-10-15T00:00:00Z",
  "usage": { "observedAt": "2026-10-15T00:00:00Z", "epoch": "keeper-generation-1", "requests": 12345 }
}
```

`requests` is a cumulative successful-request count **at the meter timestamp**, not at
feed-publish time. The stable `epoch` changes on source reset/rotation. Missing counters
are unknown, never zero. Optional token counters may accompany this contract; this
version uses request shares, so workload differences (tokens/request, model mix, cache)
are a limitation of the inferred effective capacity, not proof of a commercial plan tier.

The plugin derives per-account burn from its meter deltas and request share of actual
pool runs. The group value is the prior: one 1pp meter quantum and four requests admit
a provisional estimate; four quanta remove shrinkage. Low-burn outliers get conservative
provisional capacity immediately. Relative weights are bounded to 0.25–8; per-account
`targetShare` and sustainable slots scale once, and pool caps sum those slots. Five-hour
fractions are never mistaken for weekly fractions; five-hour-only evidence adjusts a
weekly prior by a relative weight. Missing/stale evidence retains bounded knowledge or
falls back to the pooled prior. When any peer's counters are missing or reset
mid-span there is no run scale, so the whole group keeps the pooled prior
(weight 1) instead of pricing relative weights against it. Resets and counter
epochs never bridge samples. Burn is measured per arm (model+effort) per pool,
not per account: each pooled sample splits across the arms that ran in its
span by responsibility, and pricing follows the current ledger run mix, so an
arm switch reprices within one tick instead of waiting for meter quanta.
Never-measured arms price off cost-anchor ratios rescaled by the measured
arms (measurement-era anchors ride with each arm estimate, so a switch onto
lanes that no longer serve the old arm still reprices); a dominant-arm change
segments the pooled average and the members' old-mix estimates at once, but
only when the new arm holds a clear (>=60%) share and reprices the pool by
more than 25%, so near-even mixes do not flap smoothing. Only enforced hook
decisions attribute burn by arm id; every other run keys by the model that
actually ran. Fresh counter-backed
estimates re-base onto the mix-priced group baseline on a segmented tick.
Runs with no attributable arm price as their own `unattributed` segment.

`/capacity` exposes weight, source, confidence and attributed-run equivalents. Verified
healthy calibrated additions/reset headroom use a 5-minute upward target half-life for
30 minutes. Ordinary upward/burn/cap damping remains 30 minutes, downward target damping
10 minutes, and staleness 6 hours. All five knobs live under `smoothing` (see example
config); zero/negative/non-finite values are invalid. Safety sheds still act immediately.

**Routing boundary:** the plugin chooses models and pool admission, not a credential
inside CLIProxy. A four-times-larger plan earns four-times the sustainable slot budget;
real traffic follows that budget only with quota-aware credential selection in the proxy.
Plain round-robin cannot guarantee per-account traffic shares. This release neither
modifies proxy strategy nor redeploys it.

## Routing cache lifecycle

Lane snapshots are isolated by company and resolved source configuration, including
endpoint, path, secret reference and TTL. Changing a source at the same TTL cannot
reuse its previous snapshot. Cache hits preserve the original source observation
and credential expiry; a tick does not make old evidence fresh.

Accepted policy/source changes retire the derived routing view until a compatible
tick publishes. During that gap, enforced routing defers rather than treating a
missing cache as permission to run. Explicit issue model overrides and the existing
enforcement-switch semantics remain unchanged. Config generations fence outstanding
reads and late view publication, including a change away from and back to an earlier
policy. This uses the existing plugin jobs, not agent wakes or a second scheduler.

## Credit pools (free grants and allowed paid types)

A weekly-spent account is normally excluded until its window resets. Providers
can grant credit pools on top of the metered allowance; the feed reports them
per account (nothing provider-specific on the plugin side):

```json
{
  "credits": [{ "type": "codex-credits", "hasCredits": true, "balance": 12.5,
                "fraction": 0.4, "resetsAt": "2026-10-22T01:44:14Z" }]
}
```

`hasCredits` with a positive `balance` keeps the account AVAILABLE, paced to
drain over the credit (else weekly) horizon; `fraction` (0..1 remaining, when
the feed can normalize it) quantifies the pace, otherwise the account drains
like a fresh window and the balance guard cuts it off at zero. Headroom
reports the quantified fraction, or a full window when the fraction is
unquantified, so the lane stays routable; the fleet concurrency target counts
the credit fraction over the credit reset horizon, and the rung controller
measures the credit-fraction drain (not the flat weekly meter). By default,
`credits.priority: "fallback"` places credit-funded lanes after subscription
lanes with usable headroom for the current role and excludes credit-funded
capacity from role concurrency targets while plan capacity is available. Set
it to `"normal"` to restore the prior quality/placement ordering. Credit lanes
carry no position signal — the credit window's start is unknowable from a
reset timestamp alone, so any schedule error would be fiction — and the
pointer holds at its rung until the measured drain rate takes over after the
warmup floor. Only types
listed under `credits.freeTypes` (default `["codex-credits"]`) or
`credits.paidTypes` (default `[]`) count; unknown types, a missing flag, and
a zero/unknown balance are never capacity.

Feed note: `live_accounts.py` does not emit `credits` yet; it should map the
CLIProxy auth-file quota signals (e.g. `X-Codex-Credits-Has-Credits` and
`X-Codex-Credits-Balance`) into this contract.

## Credential readiness admission

A served model ID and healthy account do **not** prove that a credential can
serve a run. To use opt-in credential-readiness admission, the lane producer
must publish this counts-only contract inside each account; while the flag is
off, missing evidence is reported but does not filter routing:

```json
{
  "provider": "partner",
  "accountKey": "bucket-a",
  "models": ["gemini-3.1-pro-low"],
  "credentialAvailability": {
    "version": 1,
    "models": [{
      "model": "gemini-3.1-pro-low",
      "provider": "partner",
      "accountId": "partner:bucket-a",
      "servingCredentials": 2,
      "readyCredentials": 1,
      "observedAt": "2026-10-11T14:49:00.000Z",
      "expiresAt": "2026-10-11T14:50:00.000Z"
    }]
  }
}
```

- `model` is the **exact proxy request ID** (`arm.model`), not an AA slug,
  discovery alias, provider-stripped guess, or family. Provider prefixes and
  alternate spellings never prove readiness for another ID. CLI effort and
  `[1m]` decorations generated by this plugin describe adapter settings;
  evidence still names the underlying `arm.model`, not arbitrary decorated
  strings. Producer/adapter mapping must be verified before enforcement.
- `provider` must equal the enclosing account's provider. `accountId` must
  equal `provider:accountKey` (legacy account-key fallback: `lane`, then `x`).
  Counts cover only credentials belonging to **that account/provider** and
  capable of serving **that exact request model**, after disabled/unservable
  credentials are excluded. `readyCredentials` counts their intersection
  with currently ready credentials, not a provider-wide total.
- Both counts are nonnegative safe integers; ready cannot exceed serving.
  Zero serving or zero ready closes the arm. One ready keeps it admissible;
  existing quota, role, context, trial and breaker gates still apply whenever
  `credentialReadiness.enforce` is enabled.
- Times must be real UTC calendar timestamps ending in `Z`, with optional
  1–3 fractional digits. They describe the underlying credential observation,
  not the HTTP fetch/cache/publication time. Expiry must follow observation;
  the consumer caps it at **observation + 120 seconds**. Future observations
  and evidence at/after expiry are ineligible. A future row rejected at parsing
  cannot become eligible merely because the clock catches up in a frozen view.
  A new ready observation is required to reopen an arm; expiry alone never
  declares recovery.
- Missing/invalid envelopes and missing model rows are explicit unknowns,
  never healthy. Identifiable invalid or duplicate rows close that exact
  model; an unidentifiable row invalidates the account envelope. Duplicate
  account IDs close readiness for those ambiguous buckets, not unrelated
  accounts. Unknown fields are discarded. Do not publish raw credential IDs, filenames,
  tokens, error messages, or credential management payloads.

All served arms are scored first; their Pareto survivors receive benchmark
rungs. With credential readiness enabled, admission narrows ready candidates
before account placement without changing fleet scoring/calibration or the
tier-price baseline. Benchmark incumbency, rung numbers and the durable pacing
range survive readiness flaps; empty benchmark rung slots remain in the
admission ladder so pointers and role floors/ceilings cannot shift silently.
The cached candidates include dominated alternatives: when an incumbent
expires, ranking can expose a still-ready backup at the lowest benchmark rung
whose incumbent strictly dominates it, including trial families with the same
bounded budgets. `maxRung` remains metadata; the decision engine does not
enforce it.

Credential-readiness admission is **opt-in** through
`credentialReadiness.enforce` (default `false`). Off mode still parses and
reports the counts-only evidence but does not filter allocation or emit
`credential-availability-*` enforcement warnings. This preserves legacy
routing for existing feeds. Before enabling, verify `/capacity` in off mode:
**every account** must report a valid envelope, and each served exact model ID
must have a matching row. `validEnvelopeAccounts` must equal `totalAccounts`;
check the per-model reasons and observation/expiry too. Readiness evidence is
not a readiness probe and does not guarantee a credential will remain usable.

When enabled, tick shadow, event-time shadow and enforced resolve recheck the
same evidence and expiry between ticks. A ready alternative may serve; if none
remains, event/hook admission defers for 60 seconds, while tick shadow records
no pick. The host stops an issue after **12 deferred attempts**, requiring a
human to move it back to todo. If every usable arm is excluded, the
concurrency target can become **zero** and `/caps` returns no allocations.
These are expected fail-closed consequences, not a signal to keep retrying.
Explicit operator overrides and `roles.keepAgentIds` remain operator-owned
exemptions, not proof of readiness. A fresh view is needed for changed evidence;
expired evidence alone never declares recovery.

`GET /capacity.credentialAvailability` reports `mode`, counts by reason, the
number of valid-envelope accounts and all accounts, plus counts-only model
admission rows and `alarm`. Inspect `atMs`, each row's `evaluatedAtMs` and
observation/expiry; persisted diagnostics are not a live probe. When enabled,
partial refusal logs `credential-availability-excluded`, total refusal logs
`credential-availability-all-unavailable`, and stale/invalid snapshots log
`credential-availability-stale-snapshot`. Warnings retain the per-company,
per-code hourly throttle.

Switching from **on to off** takes effect on the next hook or event call,
even during feed failures or a pending ledger load; a stale view answers
`keep`, matching the legacy behavior. Switching **off to on** takes effect
when the next tick publishes a fresh live view; until then, calls use that
existing view. To roll back, set `credentialReadiness.enforce` to `false`.
This only restores legacy admission; it does not repair the producer or mark
stale evidence as ready. No new endpoint, credential access, egress grant, or
model-config mutation is added.

**Bounded race:** readiness can change immediately after the producer observes
it or after the consumer admits a run. The 120-second maximum evidence age
bounds stale evidence, not the duration of a cooldown or a guarantee that a
run will succeed. The consumer does not reserve credentials. Producers must
use authoritative structured readiness/cooldown state and preserve its
observation time through caches; never refresh timers from frozen error-text
countdowns. Individual 429s are not automatically global fatal breakers.
Live installation, counts readback and before/after evaluation remain required.

**v0.2.2 = ALL-PROVIDERS.** Arms are data-driven: the lane feed's per-account
`models` lists are the ONLY provider->models source -- no provider list is
hardcoded anywhere, so a new account or model added to CLIProxy is picked up
with zero code changes. AA slugs resolve by normalization (provider-prefix
strip, dots->dashes, `-free`/`-1m`/date-suffix strip, `-contributor` to xhigh
effort) plus a small `MODEL_AA_OVERRIDES` table for verified mismatches
(operator-extendable via `modelAaOverrides`). Models with no AA match build
no arm and are reported `unscored` on `/capacity` (with the serving
accounts), never silently dropped and never invented. When the feed carries
top-level `servedModels` (exact CLIProxy `/v1/models` ids), only an arm whose
exact emitted id occurs in that list reaches a ladder: lanes serving an arm
solely under a provider-prefixed id (`devin/<id>`) stay servable, and the
decision emits the account's exact served id (a listed bare id is always
emitted unchanged, and an account listing only a prefixed alias still emits
the bare id whenever it is served -- so native lanes never take a prefixed
alias; the alias is emitted only when the bare id is unserved or the
provider is prefixed-only `devin`/`opencode-go`).
`/capacity.unservable`
reports refused `{ model, accountId, emitted }` entries; an absent or invalid
list leaves old routing unchanged and logs one warning. An empty valid list
refuses all arms. `/capacity.modelInventory` keeps the raw, canonical and
emitted spelling of every reported id side by side. `rawIdsByAccount` retains
which account reported each spelling alongside the combined `rawIds` list.
It reports per-account served present/absent/unknown and linked
unscored/unservable/readiness evidence; `counts.unservable` counts models
with refusal evidence, separately from absent-ID account/model pairs.
It includes explicit unknown markers for protocol/tool/reasoning compatibility and
configured-model coverage (other-agent adapter configuration is restricted).
Reporting only; routing reads nothing from it. Families without fleet success history route as capped trials (doer and other roles by default;
thinkers never; adapter-gated) until measured success graduates them; reactive accounts (vendor publishes no
meter) require health and fresh ready credential evidence. Shadow decisions are recorded event-time
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
   is the sum of the slots of every account some role can use, so a lane no
   role can use adds nothing; it does not move with the queue (an earlier
   share-of-queue weighting discounted a role-exclusive pool by the OTHER
   roles' queues, so two disjoint pools both under deep queues read half of
   what they sustain). A trial-only account is clipped to the trial in-flight
   cap. An uncalibrated (anchor) burn estimate is floored at the median
   measured per-run burn, so a guessed-cheap anchor cannot mint more slots
   than a measured peer. Queued work bounds the SERVED target instead:
   `demandBound` is the most runs the queued issues could fill at once (each
   role runs at most as many as it has queued, an account serves only its
   eligible roles; a max flow, exact by min cut over the three roles). It is
   applied after smoothing, so a queue surge lifts the served target at once
   rather than on the EWMA half-life. With no queued work, or an unreadable
   queue, it is null and any capacity some role can use counts. `/capacity`
   shows `target` (served), `targetRaw` (capacity, before smoothing),
   `demandBound`, `targetUnweighted` (quota only, the old sum), per-role
   `roles`, and per-account `eligibleRoles` / `usableSlots`.
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
and any real shortfall on a small-required account climbs. Since v0.2.55,
that spend-driven climb requires `pacing.climbForSpend: true`; the default
keeps the cheapest capable rung and uses spare quota for throughput. Accounts are
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
   The **pace guard** (below) is the hard brake behind this ordering: a
   pool that has spent ahead of its weekly plan stops taking runs at its
   cap instead of merely sorting last.
6. **Per-run signals only**: role floor/ceiling, +1 rung per retry,
   test-fail +1, rate-limit reroutes, context-window filter. Trial arms
   (families without fleet success: gemini, kimi, grok, claude-4-6, ...)
   take only the `trials.roles` roles (default doer and other; thinkers
   never; a `role:family` entry such as `thinker:glm` opens one family
   to one role), need an opted-in `adapterType` (`trials.adapters`;
   unlisted adapters get no trial arms), a free per-family in-flight slot
   (`trials.maxInFlightPerFamily`, default 2), and bypass the burn check
   (their burn is unmeasured by definition; the in-flight cap bounds the
   blast radius). `defer` happens when no account has headroom, or when
   the pace guard holds every pool that could serve the run.
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
8. **Allocation (water-filling, v0.2.3; v0.2.38 adds fallback band)**:
   each decision goes to the largest `(targetShare_a - inFlight_a)` inside
   the need band (metered-behind, then reactive, then metered-ahead/
   over-burning, then aggregator fallback-only last). A Devin lane serving
   only models a qualified native also serves is fallback-only (owner rule
   2026-09-17). On a mixed Devin lane, the duplicated models are held back
   from the first routing pass and route only when the native and
   Devin-unique arms place nothing; Devin-unique models (swe-*, etc.) keep
   the reactive band.
   A rung is also dropped fleet-wide when the same family has a newer or
   better arm (higher fleet Q, cost <=) on a qualified account with
   headroom, so old Sol on Devin never survives next to gpt-6.1-sol on
   Codex.
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

GPT-6.1 Sol runs carry `CLAUDE_CODE_MAX_CONTEXT_TOKENS=890000` and
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=870000` (`contextCaps.solMaxTokens` /
`solAutoCompactTokens`). There is no price cap: OpenAI charges no
long-context fee on GPT-6.1 Sol when usage draws from a subscription
(2026-10-11; the 272k surcharge applies to API pay-as-you-go only), and our
Sol lanes are subscription. The only limit is the server ceiling, measured
2026-10-22 through CLIProxy at ~922k input tokens (917,354 accepted, ~941k
rejected with `context_too_large`; 1.05M window minus 128k max output);
890000/870000 sit 32k/52k under it so a client compacts instead of failing.
Luna and pre-6.1 Sol ids
stay under the 272k price cliff at 260000/240000
(`contextCaps.lunaMaxTokens` / `lunaAutoCompactTokens`; the pre-0.2.65
`solLunaMaxTokens` / `solLunaAutoCompactTokens` keys alias the Luna caps
and never set the Sol window). The Sol window is a ceiling: an arm's
tier cap from the price-tier feed may lower it, never raise it; other
arms take their tier cap when they have one, else the Luna caps.
Every path that answers the host builds this env through one helper
(`contextCapsEnv`): `decide()` (burn-mode, trial and paced picks
included), routed reviews, and kept/pinned agents or the stale-snapshot
keep on a Sol/Luna model (answered as a decide on the same configured
model carrying the caps, since a `keep` carries no env). The auto-compact
key is configurable via `contextCaps.autoCompactEnvKey` (null omits it).
Runs the host never sends to the hook (no issue, human assignee, issue
model override, enforce off) cannot be capped here. Claude-* ids never get MAX_CONTEXT_TOKENS (the CLI ignores it for
them and runs haiku at a 200k window): when the arm's AA context window is
>= 1M and the run's adapter is `claude_local`/`claude-code`, the plugin
emits `<model>(<effort>)[1m]` instead, which the CLI strips and runs at 1M.
`decide` returns model/effort first-class and sets nothing else.

`contextCaps.servedIds` sets a ceiling per emitted model id, for lanes that
serve a model under a smaller window than the model's own: synthetic.new
serves GLM-5.3, DeepSeek V4.1 Flash 1017 and Kimi K3 at 524,288 tokens, so
`{"synthetic/glm-5.3": {"maxTokens": 480000, "autoCompactTokens": 450000}}`
keeps a long run compacting instead of failing with a 400. Keys match the
emitted id case-insensitively (provider prefix kept, `(effort)`/`[1m]`
ignored). The ceiling lowers whatever window the rules above pick, or sets
one when they pick none; it never raises one.

### Level floors (regenerating bars)

`burnMode.floors` maps an account matcher (same identity semantics as
`burnMode.accounts`) to the remaining share the account keeps, e.g.
`{"synthetic:*": 0.8}`. The reading is the lane's regenerating bar when the
feed carries one (`meterInfo.weeklyUsed`), else the weekly meter. At or
below its floor a matched account takes no runs (health `exhausted`,
`/capacity` reason `excluded: burn floor 80% reached (79.4% left)`); with no
reading it takes none either (fail closed). A burn account above its floor
routes before every other burn account.

synthetic.new sells one weekly credit bar that refills 2% every 202 min and
never resets. As a reactive burn lane it used to be drained to the feed's
5% reserve within hours. With a floor, each regeneration tick lifts the bar
over the floor, the next one or two eligible runs go to the lane, and the
bar drops back under it: spend equals regeneration, the bar is never full
(nothing regenerates into a full bar) and never falls further below the
floor than the runs already in flight (`trials.maxInFlightPerAccount`).

### Context-tier quota burn

Ladder order runs on the effective cost (`C_eff = base x E[multiplier]`).
Quota burn (`burnPerRunPct`) and everything derived from it -- the decide
headroom check, pacing, concurrency and target shares -- price the same
effective cost while `contextCaps.tierAffectsQuota` holds (default `true`).
Measured on subscription lanes, quota charges Haiku over 100k at well above
base (about 3x on a single-weight fit, 5x within noise), so a Haiku arm with
`fractionOver = 1` burns about 5x its base quota. Rollback is
`contextCaps.tierAffectsQuota: false`, or a release revert.

No 100k cap is emitted for Haiku: the compact window is feasibility-gated
(`p10 < 0.6 x T`), and Haiku sessions start at about 133k at p10, so a 100k
window cannot keep them under the cliff -- it would only burn context. If
the baseline prompt is cut below about 60k, a 100k cap becomes feasible;
measuring what fills the first request of a Haiku run is separate follow-up
work.

The resolve hook is memory-only: it reads the live view the last tick
published and performs zero I/O. The host's RPC deadline is 1.5s; local
synthetic tests do not establish a latency guarantee. Unknown company,
`enforce: false`, and a human operator
override (`issueOverrideModel`) answer `keep`. Enforced tick staleness over
120s, no fresh ready credentials, or no account with headroom answer `defer`
(`retryAfterMs` 60000); when every pool that could serve the run is held by
the pace guard the hook answers `defer` with `retryAfterMs` from
`pacing.guard` (300000 by default; the reason starts `pace guard:`). Every
enforced decision is recorded in the ledger
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
CURRENT demand (ledger `running` + queued work), never historical share.
Queued work is runnable work: kept agents (`roles.keepAgentIds`) and routed
review agents (`reviewerRouting.agentIds`) count actual queued heartbeat
runs (host aggregate `agents.getQueuedRunCounts`), because assigned open
cards overstate review demand by hundreds of idle chat-review cards; every
other agent counts assigned `todo`/`in_progress` issues. Below target
every agent covers its full demand (idle agents keep `running + 1`
headroom) while the want-sum fits the fleet ceiling; a wider spike shares
the ceiling out by demand instead, so one more queued item never halves
the fleet and the fleet sum stays within `maxTotal` (75). Every shed is
running-first: each agent keeps its running count, then only the remaining
new slots split by demand share -- at/above target the fleet starts nothing
new. No cap lands below `running`; only pre-existing running can hold a
total over target. Each entry reports `demand`, `running`, `allocated`,
`reason` (`full-demand` | `headroom` | `proportional` | `floor-running` |
`capped-ceiling` | `reserved-floor`), and `demandSource` (`issues` |
`heartbeat-runs` | `heartbeat-runs-unavailable`, the last when the
queued-run read is denied or unavailable: the agent keeps `running` with
`queued 0` and grants no new slots). Entries with a configured floor also
report `floor` (and `floorBlocked: true` while suspended); the body carries
`reservedFloors` (per-agent floor, applied, blocked) and `floorsSuspended`
for audit. Weak calibration (no target) returns `agents: []`.

### Blocking-priority allocation (unreleased, default OFF)

Enable through the plugin's company configuration, not a host scheduler:

```json
{ "allocation": { "blockingPriority": true } }
```

With complete native issue-relation data, **new** slots use largest-remainder
weights `(queued + 1) × (1 + min(100, blockingFanOut)) × priorityWeight`.
`blockingFanOut` is the union of readable, open cards transitively blocked by
an agent's assigned `todo`/`in_progress` cards. Duplicate paths, cycles and
the agent's seed cards do not increase it. Open statuses are `backlog`,
`todo`, `in_progress`, `in_review` and `blocked`; terminal cards do not count.
The highest priority among the ready cards supplies `priorityWeight`:
critical 4, high 3, medium 2, low 1 (unknown priority uses medium).
Agents without ready-card metadata use multiplier 1. Each agent's new share
stops at its queued demand (or one idle headroom slot for a running routed
agent, with neutral priority when its queue is empty); kept agents reserve no
idle headroom. When an agent or serving pool
saturates, its excess share is redistributed among remaining eligible agents,
including agents in other kept pools, rather than leaving usable slots idle.

When routed reviewer admissions are present, shared account subsets need an
additional resource constraint. That combined path awards whole slots by the
highest `((queued + 1) × priorityWeight) / (newSlots + 1)` (D'Hondt), where
`priorityWeight` includes the fan-out multiplier above, with agent-ID ties, testing the full
funding plan before each award. Flexible assignments are rematched rather than
consuming a constrained peer's only account. Fractional accounts can combine
inside one pool, never across unrelated pools. The ordinary-only path retains
largest-remainder shares; the combined path is not a claim of exact Hamilton
rounding. A fixed 8192-step search/flow budget bounds difficult multi-pool cases:
if reached, only the already-proven feasible prefix is returned and `/caps`
reports `allocation.resourceStatus: "search-limited"`. Such a response can
conservatively underfill; it never invents a slot to finish the search.

Active mode fits allocations to **both** the rounded integer fleet target and
`maxTotal`, rather than the legacy below-target burst to the ceiling. Existing
running counts always survive; if they already exceed a bound, no new slots
are granted. Kept/pinned agents compete with routed agents before reserving
pool-constrained shares. Smoothing cannot retain slots beyond the remaining
target, and a reserved floor that would raise the selected allocation is
reported blocked instead of overriding the priority decision. The flag does
not reorder an agent's own queue or preempt running work.

Only the already-declared `issues.read` capability is used. Ready-card reads
share the ordinary demand cache; three additional status-list reads complete
the graph once per capacity tick. Active counts and weights share that tick's
ready-card snapshot; each new tick refreshes it even inside the ordinary demand
TTL. Concurrent requests share the pending snapshot, including failed attempts.
The two newest tick snapshots are retained per company so an API request for the
still-published tick cannot evict the next tick's in-progress snapshot; older
requests cannot displace those newer entries. The capacity target uses the same
validated snapshot as active caps. An unavailable graph retains ordinary demand
refreshes for both the target and caps, as well as the legacy allocator. No
resolver-hook I/O, new permission, database access, egress or background job is added.

**Host compatibility gate:** the SDK `Issue` type exposes optional `blockedBy`
and `blocks` arrays, but that does not guarantee they are returned. In the
host source inspected for this change, `issues.list` omits relations by
default and `issues.get` enriches labels/watchdogs only. The SDK list input
also does not expose/forward the server's `includeBlockedBy` option. This host
therefore **cannot activate** the weighting using `issues.read` alone. The
plugin requires a nonempty open-card snapshot with a complete `blockedBy`
direction (or a complete `blocks` direction) whose entries have nonempty string
IDs. If both directions are complete, their readable open edges must agree.
It never treats absent or malformed fields, contradictory directions, or an
empty snapshot as proof of native relation support. Do not enable expecting an operational improvement until
a native SDK/host contract supplies those fields. No core patch or undeclared
RPC parameter is used to bypass this gate.

When requested, `/caps` reports `allocation.blockingPriority: true` only when
the snapshot is usable, with per-agent `allocationPriority` containing
`blockingFanOut`, `cardPriority` and `weight`. Failed reads or unavailable
relation arrays report `allocation: { blockingPriority: false,
error: "priority-unavailable" }` and retain the **exact legacy allocation**.
The existing demand-read failure still returns `capsError: issues-unavailable`
and no recommendation. Setting the flag to false (or omitting it) makes no
additional reads and preserves the existing response shape and allocation.

### Reserved per-agent floors

`caps.reservedFloors` maps an agent id to `{ base, perQueued, max }`, empty
by default (no behaviour change until set). The floor is
`min(demand, clamp(base + floor(queued / perQueued), base, max))` with
`demand = running + queued`: with `base 4, perQueued 20, max 8` it reads 4
at 10 queued, 6 at 40, 8 at 105, and demand itself when idle. Floors apply
last -- after the allocator and the hold -- so smoothing never takes a
floored cap below its floor (`reason: reserved-floor`, mirrored in
`maxConcurrentRuns`). Floors win the fleet ceiling: past it, agents give back
only slots above their protection line (`max(floor, running)` for floored
agents, running for the rest). While every
servable arm is breaker-open (fleet-wide cooling) floors suspend and floored
caps hold at running, so failed runs on cooled models cannot rise. Cost: past
target the fleet can run over it by at most the floors' new slots (8 for the
example entry); no agent loses a running slot.

### Pace guard

Ordering alone never stops spend: an account ahead of plan sorts into the
last need band, but when every account that can serve a run is ahead, one is
still picked, and a fleet ahead of plan keeps burning (a Claude lane went 78%
to 90% in two hours). The guard adds the brake. Per provider pool (lanes
that share one credential bucket):

    ahead  = mean(weeklyUsed - elapsedFraction) over the pool's lanes > marginPct
    slots  = sum over lanes of targetShare x meanRunDurationHours
    cap    = max(1, ceil(slots))

A pool that is ahead and already has `cap` runs in flight is **paced**: its
lanes leave the allocation order, so the run goes to another pool, or, when
no other pool decides it, the hook answers `defer` with a `pace guard: ...`
reason and `pacing.guard.retryAfterMs` -- even when an unpaced pool is left
but has nothing to decide (a full trial slot, say): the paced pool is a real
minutes-scale hold, and the reason names both holds. A pool that is not
ahead is never touched. `slots` is the same term as the per-account concurrency target, so
the cap follows the plan: it shrinks as an account spends ahead and widens as
the plan catches up. The minimum of 1 keeps a lightly-ahead account serving.

The enforcing hook, the event-time shadow path and the shadow tick all order
accounts through `orderAccountsWithPacing` with the same plan positions and
knobs, so they hold and release a pool alike (a run being decided never
counts against its own pool, and neither do runs the hook deferred). A held run gets no shadow decision;
`shadow.skippedPaced` counts them. `/capacity` carries `paceGuard`
(`enabled`, `marginPct`, `retryAfterMs`, `unattributedInFlight`, and one
entry per pool with `planAhead`, `pacedSlots`, `cap`, `inFlight` and
`state`: `paced`, `ahead`, `on-plan`, `not-measured`) and each account
carries `planAhead`.

Config (`pacing.guard`): `enabled` (default true), `marginPct` (default
0.02: lead on the plan tolerated before the cap applies), `retryAfterMs`
(default 300000). The retry hint is longer than the plain no-headroom
defer (60s) on purpose: a slot frees when a run finishes, and the host
gives up on a run after a fixed number of deferrals.

Fails open (the existing caps apply): a pool with ANY lane of unknown reset,
weekly reading or target share (leaving that lane out would size the cap from
the others alone), a pool that includes a reactive (unmetered) lane, or no
run duration. A lane whose every arm is breaker-open is not part of the
pool in any of the three paths; a lane without ready credentials is
likewise excluded only when `credentialReadiness.enforce` is on (off
mode admits it, matching legacy behavior).

Limits, measured on the fleet simulation (`test/pace-sim.test.mjs`):

- The guard acts only above plan plus margin. A pool behind plan is bounded
  by the concurrency caps, not by the guard; with caps held at the paced
  target the guard changes nothing, and with caps at 3x the target it is what
  keeps a fleet from running dry days early (out of quota at hour 98-110 of
  168 unguarded; 163 guarded, finishing at 99% with a lead on plan of at
  most 9 points).
- The floor of 1 in flight can overspend an account whose single run burns
  faster than the plan: one run in flight burns `E / D` of a lane's week per
  hour (E = weekly share one run costs, D = mean run hours), against a plan
  rate of 0.6%/h for a week. At E = 0.5% / D = 0.5h (1%/h) a lone lane is out
  of quota at hour 99, at E = 1% at hour 50, at E = 2% at hour 25. Pacing
  those needs a rate gate (fractional slots as a duty cycle); the guard
  does not have one.
- A pool is judged on the mean of its lanes. A pool of one lane far ahead and
  one far behind reads on plan; steering by lane needs the lane feed.
- The cap counts runs that are executing, read from the run ledger at the time
  of the decision: a finished run frees its slot at its terminal event, and a
  run the hook deferred (waiting, not running) is not counted, or two waiting
  runs would hold an idle one-slot pool until the host gave up on them. The
  set of deferred runs is memory-only: after a worker restart, a waiting run
  counts again until the hook next defers it (its next retry). A deferred
  mark lives at most 12 x `retryAfterMs` + 60s (the host abandons a run after
  12 deferred attempts): past that the run counts as in flight again, fail
  closed like a lost terminal event. The host cancels a deferred run at once
  and retries it as a new run under a new id, so a mark is never refreshed;
  the bound only matters when the run's terminal event is lost.
- Runs with no decided or actual account yet (fresh starts the tick has not
  attributed) are not counted toward any pool's cap: each may belong to any
  pool, or to none, so counting them lets one burst of fresh starts hold
  every pool for all the others and nothing is ever decided. The fail-open is
  explicit: `/capacity` publishes the unaccounted amount as
  `paceGuard.unattributedInFlight`.
- A reset more than one window (plus an hour) away, or already past, is an
  unknown plan position and fails open.
- A run whose terminal event never arrives (a worker restart can lose one)
  keeps its slot until the in-flight horizon, `max(3 x mean run duration,
  2h)`, the same horizon every in-flight count uses. On a pool with a cap of
  1 or 2 that can hold arrivals for up to two hours, longer than the host's
  deferral budget; `/capacity` shows `inFlight` against `cap` so it is
  visible. The guard errs towards spending less, never more.

### Deferral-exhaustion

The host clamps a plugin defer to [1s, 60s] and retries a deferred run as a
new run under a new id up to 12 times (`RUN_MODEL_RESOLVE_MAX_ATTEMPTS`),
then freezes the card. The per-runId deferred marks above therefore reset
every retry and can never see the chain end. `exhaustion.enabled`
(default `false`) counts consecutive **capacity** deferrals per issue+agent
instead, but only when both stable identifiers are present; calls without
one never share a synthetic streak. Stale credential-snapshot deferrals are
an evidence wait rather than capacity pressure and do not consume this
budget. From `exhaustion.finalAnswerFromAttempt` (default 11, 1-based) the
hook stops deferring and answers with the cheapest selectable free-overflow
arm (free-cost providers first, then trial arms, then the lowest burn), else
a bounded keep on the agent default model. Every non-defer answer, including
an exhaustion recovery, clears the streak so a later retry chain earns a new
grace period.

Only the pace-guard pool cap and the transient 5h reserve are relaxed at
exhaustion. Never bypassed -- for either a selected arm or bounded keep --
are trial role/adapter/family gates, credential readiness, the arm breaker,
role exclusions, the review reserve, known metered-headroom evidence,
reactive in-flight caps, and metered plan position. A healthy
admission-excluded account is never selected; a spent weekly meter and a
metered pool ahead of plan are never selected. The keep is allowed only when
the default model's serving account passes those hard gates; for
non-review runs it also cannot use a review-reserve-held account. Otherwise
the hook keeps deferring (strand rather than burn excluded, exhausted, or
held quota). The reviewer pace-hold defer answers the same way from the
final attempt. Decisions record `deferral-exhausted: <prior reason> ->
<arm|kept model>`; a failed scan appends per-account skip reasons to the
defer reason. With `enabled: false`, terminal defers retain their existing
behavior. Memory-only, no new capability, egress, secret or env key.

### Review reserve

The pace guard keeps the fleet on plan, but reviews starve anyway: review
runs arrive in bursts and compete with bulk work for the same pace. The
reserve holds a demand-driven share R of each reserved provider's pace
(default: `claude`) for review runs -- a native port of the host stopgap
that starved reviews 9 of 47 hours on 72h of fleet data, against 14 for a
rolling average and 38 for a fixed 50%.

Per reserved provider, each tick:

    burn/h   = closed hourly review burn (quota-% units, priced by
               burnPerRunPct, so tier-multiplied models burn at tier price;
               pinned runs price from their pinned model, hottest arm only
               when the model matches nothing)
    review   = mean + 1 stdev over the trailing `envWindowH` (3) closed
               hours; rises apply instantly, falls decay on `envHalfLifeH`
    backlog  = queued review runs x measured % per review run / `drainH` (8h)
    need     = review + backlog (all %/h)
    capacity = sum over the provider's accounts below 99% weekly of
               remaining% / hours-to-reset
    R        = clamp(need / capacity, `rMin` 0.10, `rMax` 0.95)

Kueue-style lending: with no review run waiting the reserve is lent to other
work (R sits at the floor, nothing is held) and is reclaimed through
admission as soon as one queues. Runs are never cancelled; the reserve only
gates admission of non-review runs. With measurable demand but no measurable
capacity the reserve fails closed at the cap, so reviews keep their share
rather than racing unreserved work to zero.

A reserved-provider account whose weekly OR 5h use sits above its scaled
allowance, `(elapsed + margin) x (1 - R)` per window (`marginW` 0.10 weekly,
`margin5h` 0.15, mirroring the feed pace guard), is **held** for non-review
runs: it leaves the allocation order in the tick, the hook and the
event-time path, and the hook answers `defer` with a `review reserve: ...`
reason. The hold releases per window in the last `releaseWeeklyH` (24h)
before a weekly reset and the last `release5hMin` (45 min) before a 5h
reset, so unused quota is not wasted. Unknown position on a window never
holds (fail open). Review runs (`reviewReserve.agentIds`, default
`roles.keepAgentIds`) see the unheld order, and pinned agents keep their
model before admission, so neither is ever held.

`/capacity` carries `reviewReserve` (`enabled`, `agentIds`, `providers`, per
provider `reserve`, `lent`, `needPctPerH`, `reviewRatePctPerH`,
`backlogRatePctPerH`, `capacityPctPerH`, `queuedReviews`, `reviewRunsPerH`,
`pctPerReviewRun`, `heldAccountIds` and per-account `held`/`window`, plus
the top-level `heldAccountIds`). `enabled: false` computes nothing and holds
nobody: admission is bit-for-bit the pre-reserve behavior.

## Reviewer routing and capacity auto-heal

The reviewer is a first-class role: the tick derives runnable review
capacity from qualified providers (`reviewer.providers`, falling back to
explicit `reviewReserve.providers`, then Claude only) and the review gate
reads `capacity.reviewer` (`hold`, `resume`, `qualifiedAccountIds`, `slots`).
Only accounts the allocator itself would serve count -- healthy,
reviewer-eligible, not `excluded` (e.g. weekly-exhausted), not floor-guard
pinned, with metered headroom above the allocator's 0.05 reserve. Reactive
lanes need no meter but must still pass the other eligibility checks.
With routing enabled for review agents, eligibility requires an admitted
configured reviewer arm, including its selected-effort breaker and
credential checks; healthy ordinary arms cannot supply reviewer capacity
on their own. Without routing, eligibility retains the non-trial arm check
for the role. When nobody qualifies the signal holds reviews until a
qualified provider recovers.

`/capacity` also carries `capacityChange` (per-tick `added`, `removed`,
`upwardAccountIds`, `downwardAccountIds`, `wake`) and `supplySignal`
(`providers` with `headroomPct`/`hoursToReset`, `wake`). `wake` pulses on
the transition tick only; `seq` and `lastWakeAtMs` persist across idle
ticks (and restarts), so a consumer polling slower than the 60s tick
compares them against what it last handled instead of racing the pulse.
`supplySignal` fires when at least one account clears both bars on its own
(headroom at/above `supplyHeadroomPct` with reset inside
`supplyHoursToReset`) while doers are idle -- one account's headroom is
never paired with another account's reset. Each provider entry also
carries its own `liveRuns`, `qualifyingAccounts` and `idle` flag, and wakes
when it qualifies and has zero live runs even while the fleet is busy --
fleet runs/h (e.g. reviewer traffic on one provider) must not mask another
provider's doer starvation. `supplySignal.doerStarvation` tracks the served
target C* against live doer runs and wakes when the gap (default >= 4 runs)
persists (default 10 minutes) while queued doer demand waits, so idle
in_progress/todo cards on healthy-provider agents get woken; a gap with
nothing queued (thinker-absorbed target, issues outage) never wakes, and an
unmeasurable target stays `unknown` and never wakes.

Two tick behaviors to know. New-account warmup: measured rates from under
60 minutes of retained history are not trusted (the span comes from the
full 90-minute history, not the trailing rate window), so control falls
back to burn-horizon/linear position pacing until the span clears -- thin
data never throttles, and a thin-data descend is a real position move that
executes. Auto-heal bypass: upward capacity transitions (new account,
weekly reset, guard end, health recovery) recompute at once with no rung
cooldown, while downward transitions keep today's debounce; a bypass tick
that moves nothing writes the account's original last-move stamp back, so
the rung cooldown survives the event.

Config (`reviewer`): `providers` (default `["claude"]`), `supplyHeadroomPct`
(default 0.30), `supplyHoursToReset` (default 120),
`doerStarvationMarginRuns` (default 4), `doerStarvationSustainMs`
(default 600000). Every knob is validated
so a typo fails closed at config load. Each account row also reports
`warmingUp`, `bypassedCooldown`, `rateBasis` (measurement availability;
`warmingUp` tells when control still falls back to position), `action` and
`reason`.

## Configuration

`placement.qualityWeight` (default 1) and `placement.allowanceWeight`
(default 0.35) tune the placement blend; `qualityWeight: 0` is the kill
switch back to pure water-filling.

### Eligibility from data

An arm serves a role only if it passes both gates; the operator list
`roles.excludeFamilies` is applied on top, yielding only on structural
emptiness (see Safety). Each exclusion is a token in the
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
to a disposition (done / in_review / blocked / cancelled), else *noChange*.
The signal is status-only: the host hands plugins the plain issue row, so a
PR or comment that leaves the issue's status alone is not seen. Failed runs
belong to the arm breaker, cancelled runs say nothing about the model, unreadable outcomes are not
misses. A family is gated for a role when it has at least `minRuns` judged
runs, its progress rate is below `minProgressRate`, AND below
`relativeToBest` of the best-measured family's rate for the same role. The
relative clause means the best family is never gated and a role where every
family reads low (reviewers answer in comments, which the plugin cannot
see) keeps all of them. A family that cannot serve the role is
still reported but is never the benchmark: the operator's list, a
quality-gated family, one whose arms are all covered by `arm:` tokens, or
one with no arm in the fleet does not gate the families that can serve it.
Recovery is by aging: a gated family gets no new
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
never be emptied into a defer loop by data. If the operator list alone would
leave a role with no arm anywhere in the fleet-wide arm set (a
single-provider fleet), the fewest of its entries are suspended for that
role, strongest banned family first, and the data gates keep as much
strength as the role allows (`manual-suspended`, with the `entries` named,
in `/capacity`). Otherwise the operator list applies as written. The lift is
structural only: a lane outage, an excluded account or open arm breakers
never lift the list; the role defers until the lane recovers. Only healthy,
non-excluded accounts with arms whose breakers are closed decide and place
runs.

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
  (`baseUrl` defaults to the host pinned at build time, see "Lane host
  pin" below; `accountsPath` to `/telemetry/cliproxy/live/accounts.json`),
  sent as the `X-Api-Key`
  header. The response carries per-account `weekly`/`fiveHour`
  `{ used (0..1|null), resetsAt (ISO|null) }`, a `quality`
  flag, the per-account model ids (`models`), the exact proxy-wide
  `GET /v1/models` ids (`servedModels` at the top level), the vendor-meter
  kind (`meter`: absent/`reactive` = the vendor publishes no usage numbers),
  and the pool name where applicable. Until the ref is wired the plugin runs
  degraded: no live reads, ladders frozen, shadow records the gap.

The CLIProxy client only ever issues that one GET. Anything else is
blocked in code and covered by the allowlist test. The plugin worker
never touches CLIProxy directly (private IPs are blocked from
`ctx.http.fetch`) and the CLIProxy management key stays on the host --
the host service does passive-first plus single-account live pull,
server-side. Readings are cached 45s (`cliproxy.cacheTtlSec`).

### Lane host pin

The lane key may only ever be sent to the origin pinned in
`src/lane-host.mjs` (`LANE_BASE_URLS`). It feeds three places: the
manifest `cliproxy.baseUrl` enum, `validateConfigShape` (rejects any
other `baseUrl`), and the `resolveConfig` fallback. The pin is
compile-time on purpose: config can name only a listed origin, so a
config write cannot redirect the key.

The public file ships a non-routable placeholder
(`https://lane-host.invalid`; RFC 2606 `.invalid` never resolves). An
unpinned build cannot leak the key: the lane read throws
`cliproxy-lane-host-unpinned` before the lane secret is resolved, so no
request is made, and `onHealth` reports `degraded` ("Lane host not
pinned"). `config.example.json` leaves `cliproxy.baseUrl` unset so the
same file validates against any pin. To deploy,
replace that one file at package-build time with your real origin, for
example:

```js
export const LANE_BASE_URLS = Object.freeze(['https://lane.example.com']);
```

Keep the real origin out of the public repo. Everything else in `src/`
stays byte-identical to the repo.

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

## Failure-cluster alerts (default off)

Failed-run events feed per-account counters in plugin state. When at
least 3 allowlisted failures (`claude_auth_required`,
`claude_transient_upstream`, `adapter_failed`) for one account land
inside a 15-minute event-time window, the detector creates or updates
exactly one stable-origin managed alert issue and reports `error`
through plugin health until the cluster clears:

```json
"failureClusterAlert": { "enabled": true, "assigneeAgentId": "<devops-agent-id>" }
```

Disabled (default) or unassigned means zero issue writes. Alert-only:
transition writes (cluster enter/exit/count-band escalation or de-escalation) on one
singleton issue, never per-run writes, never disables anything, never
touches routing or the `enforce` flag. The predicate counts only
`status: failed` (`timed_out` excluded) with the account extracted from
the model-decision reason (` on provider:account`). Note the window
runs over event time (failure time, else publish time), not run
creation time, so comparisons against a creation-time poll are
normalized-cluster comparisons, never identical. Adds exactly
`issues.create` + `issues.update`, with create/update field allowlists
and per-write ownership checks.

Undelivered transitions persist as one bounded pending snapshot (including
up to 10 recent transitions), independent of the live event window. If
issue writes fail through an entire cluster episode, recovery writes a
cleared catch-up record with its enter/exit history instead of losing the
alert. Retries use the same rendered content until the next material
transition, and health keeps reporting a write error until reconciliation
or delivery succeeds. Queued maintenance re-reads the current alert config
before starting, so disabling the detector also stops queued passes.
Timestamp fallback picks the first parseable failure/publish time before
using receipt time. Missing run identifiers count separately and render as
`unknown`; deduplication requires a real identifier (replayed identifier-less
events cannot be distinguished).

## Layout

- `src/manifest.mjs` -- shadow-default manifest, opt-in `enforceManifest`, `buildManifest` variant flag
- `src/failure-clusters.mjs` -- alert-only failure-cluster detector: event-time counters, transition evaluation, singleton reconciliation
- `src/cliproxy.mjs`, `src/aa.mjs` -- edge clients (pure + guards)
- `src/lane-host.mjs` -- build-time lane host pin (public placeholder; replaced at package build)
- `scripts/check-public-pin.mjs` -- CI-only: fails if the committed pin is not the placeholder (not shipped; an overlaid build fails it by design)
- `src/arms.mjs`, `src/quality.mjs`, `src/ladder.mjs` -- ladder math
- `src/pacing.mjs`, `src/decide.mjs`, `src/concurrency.mjs` -- control
- `src/pools.mjs` -- calibration groups and pooled burn per run
- `src/select.mjs`, `src/paceguard.mjs` -- account ordering and the pace guard
- `src/smoothing.mjs` -- EWMA and per-agent cap hysteresis
- `src/outcomes.mjs` -- run outcome classification and per-family report
- `src/shadow.mjs` -- bounded shadow ring (unit-tested legacy helper)
- `src/ledger.mjs` -- the run ledger: one record per runId, decided-first
  attribution, mark-but-never-delete reconcile, append-only shadow view
- `src/plugin.mjs` -- worker wiring; `src/worker.mjs` -- entrypoint
- `test/` -- `node --test`, no build step: `npm test`

## Open questions

- Wire `cliproxy.laneKeySecretRef` to the lane key (owner decision, see
  above). `cliproxy.baseUrl` and `accountsPath` accept only their pinned
  values: the build-time lane host (see "Lane host pin") and the feed path.
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

## Native pool operator generator (offline build; staging first)

`node scripts/generate-pool.mjs --help` documents the four modes. The default
`--dry-run` makes **only GET requests and zero filesystem writes**, even when
live sessions block migration. It prints full pool **SaveInput** JSON, complete
bindings, per-(agent,member) selectable verdicts, excluded memberships and session
blockers. Unknown/ambiguous target identities fail closed. Provisional UUIDs on a
fresh target are explicitly marked: they are only valid-schema plan placeholders,
not claims that connections or grants already exist. Apply always discovers the
real host-generated IDs; member UUIDv5 identities stay stable.

Inputs are operator files, never plugin startup configuration:

- `--registry registry.json`: the validated `router` block, including `companyId`
  and `ownerUserId`. Do not put `agentIds` or credentials in this registry.
- `--batch batch.json`: `{ "pools": { "builder": ["<agent UUID>"], "thinker":
  ["<another agent UUID>"] }, "sessionPlans": { "<agent UUID>": "drained" } }`.
  Every configured pool must occur. An agent cannot belong to two pool batches
  simultaneously because it has only one runtime pool binding. The batch is the
  authoritative install scope; include already-migrated agents that must retain
  access. Accounts shared across pools receive the union of those pools' agents.
- `--quality-evidence quality.json`: `{ "arms": [...], "roles": {...},
  "records": [...] }` from the plugin's quality/outcome policy, with record
  `role` and `family` fields. The CLI computes verdicts with the existing policy
  library at the host clock; it does not accept a hand-written boolean bypass.
- `--target https://paperclip.example`: a Paperclip origin (optional `/api`).
  Board auth comes **only** from `PAPERCLIP_BOARD_TOKEN` in the environment.
- `--gateway-base-url https://gateway.example/v1`: real gateway endpoint,
  HTTPS or loopback HTTP, no URL credentials, query or fragment.
- Apply only: `--secret-refs refs.json` containing
  `{ "account-one": { "env": "LANE_ACCOUNT_ONE_KEY" } }`. Resolve secrets into
  these environment variables with the operator's normal secret manager before
  invocation. These are references, never literal key values. Keys are injected
  into `apiKey` only inside the POST boundary, never plans, journals or errors.

Example (paths are local evidence inputs; no credentials in argv):

```sh
node scripts/generate-pool.mjs --dry-run \
  --target https://paperclip.example --gateway-base-url https://gateway.example/v1 \
  --registry registry.json --batch batch.json --quality-evidence quality.json
# After reviewing the dry plan, use the same arguments plus:
#   --apply --secret-refs refs.json --journal evidence/batch-1.jsonl
# Stage without activating/binding: add --keep-disabled.
# Read-only R9 primary signal: --check (exit 2 for drift, 0 when converged).
# For staged pools, --check --keep-disabled expects enabled:false.
# Compensation: --target https://paperclip.example --rollback evidence/batch-1.jsonl
```

`allAgents:false` is the default. Fleet-wide installation requires **both**
`--all-agents` and `"allAgentsApproved":true` in the batch's recorded migration
approval. Otherwise the generator refuses it. Do not use fleet-wide installs as
a shortcut around per-agent evidence.

### Native HTTP facts and operational prerequisites

The implementation is grounded in upstream checkout `e2cfdc7e`:

- `server/src/routes/ai-connections.ts`: POST creates an API-key connection,
  organization grant and installs **inline**. Summaries already contain grant
  IDs; there is no separate AI `createGrant` request. Pool POST carries
  `pluginKey` separately from `config`, omits companyId in the HTTP body, and
  requires `expectedRevision` on updates.
- `server/src/services/ai-connections.ts`: `list(..., _agentId)` does **not**
  validate installs. The generator reads the same AI summaries plus generic
  `grants`/`installs` and saved agent metadata and conservatively evaluates
  `select()`/`poolMemberRuntimeConfig()` rules. Output labels this
  `source:"host-read-evidence"`, **not** a native `select()` execution response.
  Restricted or unknown grant audiences are refused, even when the operator
  personally has access. No model prompts or credential reads are used as probes.
- `server/src/services/ai-connections.ts` rejects reconnect with changed routing;
  `server/src/services/tool-access.ts` rejects AI config PATCH. Therefore model
  changes use a **blue/green replacement**, not an invented update endpoint.
  Changed pools must be disabled natively before apply. The prior adopted
  connection is retained, disabled and renamed with the run ID, so compensation
  can restore it. The new connection takes the configured name and exact model
  set. Retired prior connections require operator cleanup after the migration's
  rollback window; they are never misreported as creations of this run.
- `server/src/routes/agents.ts` preserves an existing router binding if an update
  omits/nulls `aiConnection`. **An absent prior binding cannot be restored by
  this upstream API.** Activating migration therefore requires an explicit,
  valid, working prior native binding per agent, configured through the normal
  native management flow. Unbound agents can still dry-run/stage; activation is
  refused before any writes rather than leave an un-rollbackable binding.
  Binding writes obtain both the HMAC `configurationRevision` and redacted
  `runtimeConfig` PATCH base from `GET /agents/:id/configuration` (not the
  detail endpoint, which has no revision). The server restores redactions
  against that display when the revision matches. Writes retain unrelated
  settings and verify the saved binding afterwards. A prior `responsible_user`
  binding must include its provider **and method**, as upstream requires.

Keep the batch quiescent (no queued/running work or concurrent roster/connection
edits) until it completes. Live sessions without an explicit per-agent `reset`
plan are listed by dry-run and refused by apply. `drained` is not proof of drain:
re-listing must actually be empty. An authorized `reset` plan executes the native
per-task reset endpoint, re-lists after reset and immediately before binding,
then re-wakes the exact issue through the native wake endpoint with an idempotency
key. Only UUID / `issue:<UUID>` task keys are reset automatically; other task
kinds require native operator disposition, not comment-to-wake. `--keep-disabled`
never resets, binds or wakes agents. No paused agents are unpaused by the tool.

### Journal, compensation and recovery

Apply requires a **new** journal path (exclusive create, mode 0600), writes and
fsyncs each intent **before** its API call, then fsyncs its receipt before the
next step. Creations use unguessable temporary names so a lost create response
can be rediscovered as this run's object, not any pre-existing same-name object.
Final names are promoted with name-only PATCH or revision-checked pool save.
Pools are built disabled and `--check`-verified before separate activation saves.
Failures stop immediately and report the journal, known creations and unresolved
intents. An unresolved intent is not silently claimed to be unapplied.

The journal itself is the non-secret identity/mapping evidence file. Optional
`--mapping-journal prior.jsonl` reads the prior mapping as a cache, verifies every
connection/grant against the live host, reports stale IDs, and still rediscovers
before writing. Never reuse a journal path for another apply.

`--rollback` validates the entire journal and live inverse plan before mutation,
reauthorizes the named owner and exact target, recovers pending writes by read-only
inspection, and compensates in reverse order. Adopted pool configs/installation
scopes/names and prior agent bindings are restored; only journal-created pools
and connections are archived via their real native endpoints. Grant revocation
is inline in connection removal. Secret **IDs** are reported for separate cleanup
through the native secrets API, never read back or deleted blindly. Compensation
has its own durable intents and can resume after a lost deletion/restore response;
a torn last journal append is recovered from the preceding durable intent.

A completed active journal is **not** a delete script: drain its agents and disable
its pools natively before rollback. Any live session, changed binding, ownership
mismatch, target mismatch or unexpected pool revision stops compensation before
it starts. Retained task pins and credential/secret cleanup are native lifecycle
boundaries, not direct database work. Serialize operator batches; this is a saga,
not a cross-object transaction.

Tests include HTTP end-to-end CLI requests, lost responses/partial compensation,
registry growth and a two-protocol U18 golden. Portable fixtures in
`test/fixtures/upstream-schemas/` are upstream emitted schema modules or exact declaration
excerpts (unused exports/imports pruned), with source checkout and SHA256
provenance. Tests parse every emitted mutation body with upstream Zod schemas:
connection create/PATCH, pool save/DELETE, installs PUT, agent PATCH (including
rollback restoration), reset-session and wake. Bodyless connection DELETE is
also checked. The CLI test server rejects unverified mutation routes. Run `npm ci --ignore-scripts --legacy-peer-deps` then
`npm test`; the runtime CLI has no Zod dependency. Slice 3 supplies the quota
job / U14; amendment A2 assigns full drift inspection to operator `--check` and
adds the effective config fence and per-call tripwire above. Runtime effort-floor
enforcement and callback registration remain slice 4. U15 is now delivered in `test/lane-denylist.test.mjs`: the existing
lane request builder enforces the pinned origin and exact accounts path even
before config normalization. It cannot emit a direct queue/RESP request.

U16 (and the U23 counter boundaries) is delivered as the **job-side accounting
library** `src/scorecard.mjs`, tested in `test/scorecard.test.mjs`. Its pure
`tickScorecard(saved, {nowMs, periodMs, accounts, ...})` returns serializable
state; `scorecardRows(state)` returns isolated public rows. The future quota
job must supply joined account evidence (including `inScope:false` policy
exclusions), computed eligibility/floor/pacing verdicts and Keeper counters;
the reducer does not assume an idle account is eligible. Public usage/unused
figures are percentages; input quota readings are ratios. It latches each
reset window, caps interval accounting at two job periods, retains eight
windows per account, and distinguishes proved eligible-unpicked time from
unexplained/held/feed-gap leftovers. Keeper deltas are window/epoch scoped;
ledger totals stay separate and discrepancies emit warning facts. Wait
attribution remains honestly null pending the staging G3 event-shape proof.

These are library-level acceptance tests, **not a claim of runtime rollout**:
this generator change does not register the quota job, persist its scorecard
state, expose `GET /scorecard`, or fold rows into `/capacity`. Those runtime
integration requirements remain part of the port; no spec ownership has been
silently amended. This CLI does not wire the deployed hook, install a host
timer, or authorize any deployment.
