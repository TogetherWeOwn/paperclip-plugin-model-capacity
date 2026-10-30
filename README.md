# Model Capacity plugin (0.3.1 native-router source; not activated)

Picks the model (and effort) for every run and sets how many agent runs
should run in parallel, so every account's allowance is used before it
resets. Two inputs: CLIProxy burn telemetry and Artificial Analysis
free-API quality data. Purely deterministic -- no classifiers, no vetoes.

## Build-time variants (no deployment)

Run `npm run build:variants -- --out-dir <new-output-directory>` to produce two
separately named npm tarballs, retaining plugin ID `togetherweown.model-capacity`:

- **0.3.1-transitional**: fork-image transitional dual-capability build, exit
  2026-11-30. Keeps the resolver body and `enforce` switch; native routing is
  governed independently by `router.enabled`. Never install on pristine upstream.
- **0.3.1-clean**: `ai.connections.route` only; no resolver handler, hook
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

The source package version is the base release line `0.3.1`; installable
artifacts carry `0.3.1-transitional` or `0.3.1-clean` in BOTH version and tarball
filename. Do not install an unbuilt source checkout as a release artifact.
Every worker boot logs its baked variant at WARN; transitional also logs
`exit=2026-11-30`, even before a company is configured. Clean artifacts delete
legacy hook retry/exhaustion state, not just handler registration. The package
builder refuses changed extraction boundaries rather than guessing.

### Manifest cache-bust decision

`src/manifest.enforce.mjs` is retired. Its replacement is a thin per-variant
`manifest.transitional.mjs` / `manifest.clean.mjs` entry shim, NOT a runtime
capability switch. Each re-exports the baked manifest with `?build=<stamp>`.
Native `server/src/services/plugin-loader.ts:1352-1371` re-imports the ENTRY
with an integer-mtime query, but ESM still caches its unqueried dependencies.
`test/release-packages.test.mjs` mirrors that loader: changing only entry mtime
reproduces stale dependency data; changing the dependency stamp observes a new
manifest at the same path/version. Keep the shim until actual staging G-T(e)
proves a safe alternative. Local cache characterization is NOT a staging
install/reinstall claim. The stamp covers source, package metadata and builder.

Pre-0.3 history: the fork hook selected model/effort and the old `enforce`
flag governed it. Only the dated transitional package retains that path for
unmigrated agents. It is not the native router's architecture or enable switch.

## Native router and quota producer (activation gates remain)

The `router` block in `config.example.json` contains fictitious company/owner
UUIDs and two worked example accounts; replace them before using the generator.
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
verdict. An omitted effort cannot attest the runner default and fails closed
when a finite floor is configured, even if every *scored* variant passes. With
a null floor, every known variant must still pass the other gates. Unknown or
unscored evidence with a configured floor also fails closed. Runtime floors
are not suspended to rescue an empty role, and neither pins nor burn bypass them.
Set **per-membership** `router.accounts[].pools[poolKey].effort` alongside
`model`, for example `{ "model": "gpt-6.1-terra", "effort": "high" }`. The
generator copies this to native `member.profile.effort`; dry-run, apply and
read-only `--check` all use that same desired profile. Do not hand-edit a saved
profile to work around the registry. Explicit-effort generation uses only that
effort's quality arms, not a stronger sibling. Omission remains valid for legacy
registries/shadow, but cannot satisfy a finite runtime floor without an explicit
host-supported issue override; no runner default is guessed.

The upstream effort fold (`server/src/services/ai-connection-router.ts:58-67`,
contract e2cfdc7e) looks up the **full prefixed model ID**. Those IDs fall back to
`minimal|low|medium|high|xhigh` for Codex (`packages/adapters/codex-local/src/index.ts:64-110`)
and `low|medium|high` for ACPX Claude (`packages/adapters/claude-local/src/index.ts:26-35`).
Both config schemas and registry/member validation reject unsupported values,
including Codex `max|ultra` and Claude `minimal|xhigh|max`; bare-model catalog
support is not proof that a prefixed effort will fold. These are host folding
limits, not proof that a gateway/provider supports any model/effort. Re-verify
on each upstream upgrade. The portable upstream effort-fold fixture tests this
boundary only; it does not replace native harness or staging proofs.

Changing a saved effort changes the pool revision. Stage the pool disabled as
required by the generator, apply the registry change, run a CLEAN `--check`, then
repeat config test/save/confirm with the NEW revision before routing. An old
attestation rejects that changed pool even with a fresh quota snapshot. A real
issue effort override is still checked at its effective effort and cannot
borrow the profile's stronger score. Fresh AA/scored-fleet **and outcome**
evidence is an activation precondition even when all role floors are `null`:
stale or absent policy evidence fails closed before floor evaluation.

**A4 interim attribution contract, verified against target upstream source:**
`server/src/services/heartbeat/run-lifecycle.ts:1342-1406` publishes
`agent.run.*` events without model, account, or `contextSnapshot.aiRouterSelection`.
A run-start event is a claim, not evidence of the subsequently selected account.
The SDK agents/issues clients expose no run-selection reader. These native events
alone cannot prove end-to-end per-account R2 anti-herding. Until upstream provides
that contract, the existing ledger (including agent-config-seeded records) and
lifecycle events remain the accepted interim source. Agent-config attribution is
not promoted to observed run-account evidence: a model-less lifecycle start counts
under `/capacity.nativeRouter.unattributedInFlight` and R8 logs, even when its
ledger record contains a configured model. Its terminal event cannot subtract
another run's observed account pressure. Model-attributed fixtures prove the overlay
mechanism, **not upstream availability of that metadata**. Exit the interim when a
native run-account event/read contract ships; never add callback reservations.

Per amendment A4, G-1 pristine-upstream and G-T fork-image staging proofs belong to
**slice 5 rollout**, not slice-4 code acceptance. Slice 4 is accepted on code and
local package/tests with `router.enabled` defaulting false. Do not claim native
staging, deployed-hook parity, or end-to-end account attribution from those tests;
complete rollout gates before enabling or deploying the router.

For attributable events, run-ID sets deduplicate starts/terminal notifications
across ticks. A successful quota publication replaces the base (including the
IDs of runs actually counted there) and rebases the overlay in one synchronous
step. A terminal event never releases another run's base pressure. Sequence
checkpoints retain events received while persistence is awaiting IO;
failed/superseded ticks do not reset it.

The integration pass merges already-reviewed mainline `dc86ae4` (PRs #74/#75),
restoring the superseded-default defer guards and reviewer
`suppressAccountFallback` inputs missing from the original port handoff. It
introduces no new hook algorithm. The transitional resolver body now matches
BOTH mainline and the supplied read-only 0.2.72 reference byte-for-byte, SHA256
`a88973e149e624c3331b089c710044326847273a86766a5f3af46c3255827da2`.
Extraction is from the exact `async onResolveRunModel(params)` declaration
through its closing property delimiter, with whitespace retained. The tarball
regression pins that independent reference hash (not a hash of our own source)
and checks the entire packaged transitional source after only the build-time
factory lock. The stale handoff hash was `18864d3f6999532b854a43b39db1a0d18e2052af13b0bb116af94d9c8380f03d`;
the new assertion failed on that hash before mainline reconciliation. Mainline's
frozen default-parity corpus and reviewer/Devin regression suites also execute
against the unpacked transitional artifact. This establishes source/package
retention, NOT live fork-image install or production behavior proof; G-T and
independent integration review remain open.

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

**M7 clean-config handoff:** only after the required seven consecutive days
with zero hook resolutions, prepare the config with the top-level `enforce`
field REMOVED before validating or re-POSTing it under the clean manifest.
Retain `router.enabled`, the registry, and all verified pool fields. The clean
schema has `additionalProperties:false` and will reject even `enforce:false`;
worker-side tolerance is not server acceptance. Use the same config
test/save/verified-echo sequence for the scrubbed config and confirm it again
after the separately authorized clean install. Never re-POST an old transitional
config unchanged at M7. This is a migration prerequisite, not a deployment step
performed by this build.

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
outcome evidence. Its omitted-effort model verdict is existential over effort
variants; an explicit membership effort restricts its evidence. The native callback enforces the
effective-effort floor separately, without generation's gate suspensions.
The A4 interim R2 attribution limitation remains explicit; native staging
gates above must pass before activation.
Projection accepts measured per-run cost inputs but defaults to zero where no
credible per-run history exists; it never invents headroom.


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

Keep the real origin out of the public repo. Never commit an overlaid origin or credential. Build the variant artifacts
after applying the private pin; do not hand-edit a packed manifest.


## Native pool operator generator (offline build; staging first)

`node scripts/generate-pool.mjs --help` documents the four modes. The default
`--dry-run` makes **only GET requests and zero filesystem writes**, even when
live sessions block migration. It prints full pool **SaveInput** JSON, complete
bindings, per-(agent,member) selectable verdicts, excluded memberships and session
blockers. Unknown/ambiguous target identities fail closed. Provisional UUIDs on a
fresh target are explicitly marked: they are only valid-schema plan placeholders,
not claims that connections or grants already exist. Apply always discovers the
real host-generated IDs; member UUIDv5 identities stay stable.

On pinned native 2026.1023.0 the agent configuration endpoint has no revision
CAS and redacts runtime values. Binding checks permission there but uses the
unrestricted agent detail as its whole-object base, refusing restricted or
redacted details. It records the newest config revision and updatedAt before
reading the base and verifies one new revision and the full result after PATCH.
**This detects but cannot prevent concurrent writes lost between read and
PATCH.** Use only during a controlled single-writer cutover. The upstream
revision-bearing endpoint still uses CAS. CLI `--help` states this limitation.

On failure the CLI reports completed operations, unresolved intents and a
`rollbackArgv` array for the journal rollback command. A binding verification
failure also records the base revision and timestamp in the journal and reports
the native revision rollback route when available. Inspect live state first:
revision rollback restores the whole agent configuration and may overwrite other
changes; journal rollback rebinds only when its conflict checks allow it. A lost
PATCH response may leave the write applied; pending does not mean absent. If no
base revision exists, use the journal's rebind recovery, subject to its checks.

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
supplies the effective config fence and per-call tripwire above. Runtime
effort-floor checks and callback registration are implemented. U15 is delivered in `test/lane-denylist.test.mjs`: the existing
lane request builder enforces the pinned origin and exact accounts path even
before config normalization. It cannot emit a direct queue/RESP request.


## Native expiring burn and per-account scorecards

The native quota job now persists `src/scorecard.mjs` accounting in the same
`router-quota-v1` envelope as its immutable quota snapshot. Every minute it joins
registry + lane meter/Keeper usage + observed ledger model evidence, including
feed accounts excluded from the registry. Eligibility minutes require the same
runtime quality/outcome policy and quota/credential gates, evaluated job-side;
callback retries never increment counters or write state. A cold policy cache is
not evidence of eligibility. Inputs are quota ratios; public used/unused values
are percentages. API routes use the upstream declared plugin-local GET shape
(`packages/shared/src/types/plugin.ts`, `PluginApiRouteDeclaration`), not custom
board routes or a host producer.

`GET /api/plugins/<plugin-id>/api/scorecard?companyId=<company-id>` returns
`{atMs, rows, burn, warnings}`; the identical object is folded into `/capacity`
as `scorecard`. Durable state is readable after worker restart before the first
successful feed refresh; an uninitialized scorecard has `atMs:null, rows:[]`.
Each account retains eight reset windows, with two-period-capped incremental
minutes and immutable final unused readings latched at reset. Window and rolling
24h rates use their own bounded history rather than the short pacing history.
Keeper counter deltas are epoch/window-scoped. Ledger served counts are a
separate incremental cross-check over observed prefixed models (shadow decisions
are not runs); a >2% mismatch emits a sanitized warning and shows both counts.
Missing meters/counters or downtime remain `feed-gap`, never fabricated no-demand.

`waitsCaused` intentionally stays **null**, with a per-row `waitsNote` explaining
that the host does not expose per-account wait attribution. `poolWaitsObserved`
remains empty pending staging G3's event-shape proof; neither callback logs nor
invented event payloads substitute for that gate. Unit and fake-host integration
tests are not G3 evidence, nor evidence of production rollout.

Native burn uses **`burn`**, separate from the transitional hook's unchanged
`burnMode`. For example, replace the intentionally expired/empty example config
block with a deliberate short-lived drain:

```json
{
  "burn": {
    "accountKeys": ["codex-example"],
    "providers": [],
    "expiresAt": "2026-11-02T00:00:00Z",
    "endAtUsedPct": 0.995,
    "mode": "prefer"
  }
}
```

A parseable explicit-timezone `expiresAt` is required. A past expiry is valid
config but inactive, with a standing `burn: expired <timestamp>; inactive
(expiresAt in past)` warning in the job and capacity/scorecard views. The job
copies per-account expiry, scope and early-end thresholds into the snapshot;
selection independently checks expiry between ticks. Burn bypasses only pace
holds and ranks eligible targets first. It never alters fixed model profiles,
quality floors, hard caps, credentials, pins, or heartbeat/lifecycle selection.
`prefer` falls back normally; `exclusive` loudly warns, skips non-targets, and
waits for the earliest target eligibility or burn expiry (subject to the host's
60-second minimum). Config writes are the only control surface and may trigger
a worker rebuild/native-wait wave; batch toggles in low-demand windows.

These are source and test deliverables only: router activation stays off by
default. G-1/G-T staging, G3 event evidence and every production migration gate
remain outstanding. No deployment, host timer, direct database write or change
to the transitional hook's legacy burn semantics is authorized by these tests.


## Configuration and quality data

`config.example.json` contains **two fictitious Responses/Codex accounts**,
one shape-valid two-member builder attestation, and two unverified role pools.
All identifiers/prefixes are examples, not live authorization. Native routing
and Messages are off. Burn is disabled by empty `accountKeys: []` and
`providers: []` plus an intentionally past expiry; the standing expiry warning
is expected. Add real secret REFERENCES separately; unset optional references
are omitted, not `null` (the host schema expects objects when present).
The builder removes the transitional-only top-level `enforce` field from the
clean package's example. Validate against the installed variant's schema.

The daily `aa-refresh` job remains the quality input. Keep `armMap`, role
floors, outcome evidence and `taskRanking` policy consistent with the registry;
no hand-written selectable booleans bypass policy. `select`, `pacing`,
`eligibility`, quality/AA, tiers, cost and calibration retain their existing
policies. `thresholdPercent` is **inert** for this router (0/90/100 invariance
is tested); do not use the host's legacy threshold as a quota controller.
`reviewReserve`, `freeLanes`, reviewer policy and credential-readiness settings
remain separately gated. They are not a substitute for native pool ownership,
profile/effort compatibility, or per-run account attribution.

The only scheduled quota consumer is `quota-refresh`: GET the pinned lane's
`/telemetry/cliproxy/live/accounts.json` with its lane-key secret reference.
The AA job has its separate allowlisted quality endpoints. No plugin request
is allowed to consume a usage queue, subscribe to a second feed, query a vendor
usage API or borrow an operator board token. Keeper remains the sole queue
consumer. There is no new host producer, timer, hook or direct DB path.

## Read-only environment-pin checklist (S1)

```sh
node scripts/audit-env-pins.mjs --target https://staging.example.com \
  --company-id 00000000-0000-4000-8000-000000000001
```

Run against staging first, with an existing config-readable board credential
in `PAPERCLIP_BOARD_TOKEN`; never put credentials in argv or an evidence file.
The command makes **one GET** to the native company-agent listing and makes no
API or filesystem writes. Output includes only target, company/agent UUIDs,
exact matched keys and allowlisted model families. No names, model IDs,
secret IDs, arbitrary env values, raw HTTP errors, pin deletion, session reset,
binding change or wakeup. `auditEnvPins(agents, {companyId})` also supports a
caller-supplied in-memory inventory without network access.

The exact keys are `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL`, and `PAPERCLIP_ASSIGNED_MODEL`. A redacted API
value reports family `redacted`, a secret binding `secret-ref`, and an
unrecognized value `unknown`: **never infer the model from the key or agent's
default, never resolve secrets to improve the report**. Native board reads
redact plain env values (`server/src/redaction.ts:983-1010`); they cannot prove
the actual family. A restricted view may omit env wholesale, so an empty
checklist under insufficient config-read scope is not proof of no pins.

This is a documented MCP gap, not an alternative task/agent control plane:
`server/src/services/public-mcp/expanded-capabilities.ts:104` explicitly
excludes env from `paperclip_get_agent`. The one-shot fallback is the existing
GET in `server/src/routes/agents.ts:3903-3920`, with redirect refusal and
sanitized failures. Draft registry entry below names the exit. All actual
agent migration updates remain Paperclip MCP work.

S2 migration is separate: prove no live task sessions or an authorized,
verified drained/reset plan BEFORE binding; back up reversible config using
native protected evidence handling; bind the role pool, delete only the named
pins via MCP, then prove same-account child traffic (G7a). Do not copy redacted
placeholders back as real env values. Restore on mismatch and stop the batch.
S5 is stricter for Messages/ACPX: **do not delete pins or migrate that lane
until U-SF is present in the running image and G7b proves the projected
small-fast env follows the selected prefixed model**. No static small-fast
pin and no unaccounted default fallback. Keep `allowMessages=false` until
both ACPX P1b and U-SF/G7b are proven. Host workflow subagent policy is unchanged.

## Migration and rollback boundaries

The approved §14 order remains M0 native staging proof, M1 transitional
install with native routing off, hook retained and >=24h shadow comparison,
M2 separately approved CLIProxy prefix/affinity/least-privilege-key work,
M3 disabled pool generation/verification then native router enablement,
M4 one Responses/Codex canary for 24-48h with PC1-PC5 evidence,
M5 small builder then thinker batches (reviewer last), M6 Messages/ACPX only
after P1b and U-SF are present in the running image, M7 clean handoff only after
**seven consecutive days with zero hook resolutions** then 24h verification,
M8 retirement of obsolete host producers, and M9 explicit re-entry of any
standing burn with a future expiry. This is a pointer, not permission
to deploy or collapse any per-step approvals. Use the approved migration spec
for exact conditions and evidence. Never bind pools while `router.enabled`
is false. Zero authorized candidates returns **`unavailable`**, even when the
router is disabled; this is a loud authorization/registry failure, not a
normal quota wait. Other R9 failures retain their documented precedence.

Burn toggles and other config saves can trigger a worker restart/native-wait
wave. Batch them in low-demand windows; do not flip burn every minute. Disable
native routing only after unbinding/rolling back the affected native pools.
During a mixed canary, rollback uses the transitional package, never a
hook-free clean package or a direct jump to the old hook-only release. Replay
native generator compensation and restore protected prior agent config under
the migration's approvals. No direct DB recovery or comment-to-wake.

### Companion operator-registry draft (documentation only)

Proposed rows for the operator registry; **no unit, producer, credential or
production setting is changed by this PR**. Owner for each migration is the
host operator; the reason is the approved native-router migration plus the
Paperclip-native-only rule. Dates are hard exits, not silent extensions.

| Unit / producer | Purpose and remaining owner reason | Native target and exit |
| --- | --- | --- |
| `cliproxy-live-accounts.service`, including `keeper_usage_query.py` shell-out and `.cache-usage.json` self-cache | Transitional management-key boundary bridge for accounts feed; plugin may only read sanitized lane | Scoped read-only CLIProxy management credential in native quota job; earlier of first read-only-key release + 30 days and **2027-01-31**; re-justify-or-remove review **2027-01-15** |
| `cliproxy-usage-snapshot.timer` / `cliproxy_usage_snapshot.py` | Legacy per-provider files/vendor probes feeding lane; retained only until consumer migration | `/capacity` + `/scorecard`; M8 or **2026-12-31**, whichever is earlier |
| `model-prompt-stats.timer` | Legacy cost/prompt stats included in lane | Plugin cost math on Keeper counters embedded in lane; M8 or **2026-12-31**, earlier |
| `eee-build.timer` | Legacy benchmark-prior file | Native AA/quality path or explicit owner-visible accepted loss; M8 or **2026-12-31**, earlier |
| `synthetic-snapshot.timer` / `synthetic_snapshot.py` | Legacy provider snapshot | Direct lane/native views; M8 or **2026-12-31**, earlier |
| `review-reserve.timer` / `ops/model-capacity/review_reserve.py` | Historical reserve producer; registry says retired 2026-10-25; read-only unit inspection 2026-10-30 found timer not-found/inactive | Native reviewer reserve. Remove obsolete lane read by **2026-11-30** after writer census; if another live writer is found, name it explicitly with hard exit **2026-12-31** |
| `keeper-usage-state.json` writer: `ops/cliproxy-live/live_accounts.py::_keeper_save_state` | Lane's own incremental Keeper counter checkpoint (source lines 115, 135-140, 174), not an unnamed Keeper-side unit | Native quota state / scoped credential path; exits WITH live-accounts, hard **2027-01-31** and earlier-release condition above |
| Transitional build / fork capability | Keeps unmigrated agents on hook during mixed canary | Clean variant at M7; hard **2026-11-30**, no automatic extension |
| `/caps` consumers (historical `model-capacity-caps.timer`) | Freeze response shape during canary; registry says retired 2026-10-26; read-only unit inspection found disabled/inactive, but that is not a complete consumer census | Native pool membership/run caps; every discovered live consumer gets its own row and **2026-12-31** exit. Full G-1 code/unit census remains pending. Until proven empty, retain route in BOTH variants; if empty, deprecate transitional and remove clean under Q7 |
| One-shot `scripts/audit-env-pins.mjs` (no installed automation) | MCP omits adapter env; allowlisted, sanitized GET-only migration inventory | Add safe pin-key/family inventory to native MCP; retire fallback at that upstream release, review/remove by **2026-11-30** |

The reserve source still reads `review-reserve.json` unless its OFF marker is
present; inactive timer evidence alone does not prove nobody else writes it.
A complete producer/caps census is intentionally OPEN, not guessed from static
code or historical registry status. Do not apply these draft rows or stop units
as part of the build. The companion ops change belongs to rollout.

## Builder Definition of Done (§17) and evidence

This is the code/release checklist, **not** a claim that rollout is complete.
Tests named G-1 in this repo are local schema/packaging proofs only. Evidence
must distinguish those from actual native staging installs and real traffic.

- [x] Both installable variant packages are built from one source tree with
  variant in filename/version; stable plugin ID; factory locked at build time.
  Evidence: `test/router-variant-packages.test.mjs`,
  `test/release-packages.test.mjs`; `npm run build:variants -- --out-dir DIR`.
- [x] Startup WARN every boot reports baked variant and transitional exit date.
  Evidence: packed-worker boot subtests in `router-variant-packages.test.mjs`.
- [x] Old manifest entrypoint retired with per-variant dependency cache-bust
  retained. Evidence: loader-mtime negative control and stamp-positive control
  in `release-packages.test.mjs`; actual G-T(e) staging remains unchecked below.
- [x] Clean **runtime `src/`** contains no retired hook capability/handler,
  `model_decision_pending`, `usage-queue`, `enforceManifest`, or hook retry
  maps. Evidence: unpacked-tarball token test, U19 per-file difference allowlist.
  Tests/docs retain historical names intentionally; they are not runtime code.
- [x] Native lane request construction is allowlisted; selector reserve pin and
  plugin identity assertions are tested. Evidence: `lane-denylist.test.mjs`,
  `router-reserve-guard.test.mjs`, `router.test.mjs`, `generator-conformance.test.mjs` and
  upstream-schema fixtures. Legacy selector calls retain their old hook semantics;
  these tests do not claim whole-file legacy behavior was changed to the new pin.
- [x] S1 read-only pin audit, two-account example, empty/expired burn example,
  inert threshold, single-consumer rule, dated transitional residual, burn
  restart wave and zero-candidate note documented. Evidence:
  `audit-env-pins.test.mjs`, `release-config.test.mjs` and sections above.
- [x] Full `npm test` command run locally (including legacy pacing/select/
  eligibility/ledger and native router/quota/overlay/scorecard suites).
  Exact head/count and commands are recorded in the draft PR verification.
- [x] Draft companion registry rows include every Q3 dependency, named Keeper
  writer, reserve uncertainty, caps disposition, residual and MCP audit gap.
  They are NOT applied host changes; remaining census work is explicit.
- [x] **Reference/mainline hook source parity**: merge mainline PRs #74/#75
  in a distinct integration commit; transitional artifact resolver hash matches
  both main `dc86ae4` and the read-only 0.2.72 reference above, with an empty
  byte diff. Test-first regression rejects the stale port handoff. Independent
  integration review and live G-T behavior proof are still required below.
- [ ] Full-src reserve/caps-consumer/producer census and any required Q7 clean
  route retirement; local port-call-site tests are narrower evidence.
- [ ] Staging evidence G-1, G-T (both handlers simultaneously on fork image,
  same-version reinstall and manifest cache proof), G0/G0b and G1-G9, including
  G3 wait-event shape, G3b pre-stated bound/herding numbers, G4b session refusal,
  G7a child account proof and rollback replay. No api/evidence package has been
  fabricated from mocks. A4 makes these activation/rollout gates.
- [ ] P1b/ACPX and U-SF/G7b: **pending** real-running-image proofs. Messages
  remain default-off (`allowMessages=false`), not a passing claim.
- [ ] Production registry dry-run (keys/prefixes only, selectable verdicts and
  live-session list) reviewed and attached under migration approval. The
  builder does not query production agent env or generate production writes.
- [x] Production untouched by this build: no deploy, publish, config/API write,
  CLIProxy change, host timer/hook or DB write. Only source/git/PR changes.
- [ ] Dual independent 5/5 review and all required CI on the exact head before
  merge. A draft PR is not review approval or production authorization.

## Development and source map

Node >=24. Install development dependencies with
`npm ci --ignore-scripts --legacy-peer-deps`; run `npm test` and
`npm run check:public-pin`. Runtime scripts use native Node modules; schema
fixtures use dev-only Zod/Ajv and carry source-checkout/hash provenance.

- `src/manifest.mjs`, `src/build-variant.mjs`, `src/worker.mjs`: source manifest,
  build constant and unchanged worker entry shape. `scripts/build-variants.mjs`
  emits both artifacts without installing/publishing them.
- `src/router.mjs`, `src/registry.mjs`, `src/snapshot.mjs`, `src/views.mjs`,
  `src/overlay.mjs`, `src/quota-refresh.mjs`: native
  memory-only selection, validated identity, quota state and lifecycle wiring.
- `src/scorecard.mjs`, `src/burnmode.mjs`, `src/ledger.mjs`: reset-window
  acceptance accounting, explicit expiring native burn, observed model joins.
- `src/aa.mjs`, quality/arms/ladder/cost/calibration/pacing/select modules:
  existing deterministic inputs/math; not a new provider-ranking service.
- `src/plugin.mjs`: SDK lifecycle/API wiring; `scripts/generate-pool.mjs` and
  pool saga/client modules: explicit operator migration, never worker startup.
- `scripts/audit-env-pins.mjs`: GET-only S1 inventory with minimal output.
- `test/fixtures/upstream-schemas`: portable committed upstream schemas;
  mutation conformance tests reuse them rather than invent routes/payloads.

No local core patch is required. Intended native mechanisms are documented in
Paperclip `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md`, the SDK plugin types and
`server/src/services/ai-connection-router.ts`; the source fixtures pin the
contract used here. Upgrade the fixtures deliberately when upstream changes.

## Retained mainline transitional controls

The following controls were already merged in mainline PRs #74/#75. They
remain opt-in; this port does not activate them or change their hook behavior.

## Weekly ahead hard hold (compatibility paths only)

`pacing.holdAheadPts` (default `0.10`; `null` opts out) holds an account at
**zero new slots** when `weeklyUsed - linearTarget` exceeds that many percentage
points of the whole weekly allowance, even while the account is idle. Equality
is inside the band. The next tick releases the account when time or a reset
brings its lead back within the band. Invalid values are rejected, not read as
disabled. `pacing.guard.enabled: false` disables this layer and the ordinary
pace cap together.

The hold is evaluated on **each account's own weekly position**, never its
pool average, and has two layers:

1. **Weekly hard hold** as above.
2. **Ordinary pace cap** above `pacing.guard.marginPct` (default `0.02`):
   allowance is `targetShare * meanRunDurationHours` with measured rate
   correction. A pool's cap is `max(1, ceil(sum(allowances)))`, except that
   hard-held accounts contribute zero and an entirely hard-held non-burn pool
   has cap **zero**.

Burn-mode accounts explicitly opt into spending and bypass both layers.
Reactive (unmetered) accounts are never weekly-held. A **known** weekly lead is
sufficient for a hard hold even when run duration or target share is unknown;
an unknown weekly position never creates one.

**Conservative admission:** weekly holds never suspend for an empty role or a
temporarily full alternative. A role with only held accounts waits; no restored
allowance is lent or rematched to another role. Health, headroom, review reserves,
role exclusions, readiness, current-price, trial and breaker gates retain their
authority in every task-ranking mode. Compatibility suspension diagnostics remain
empty (`paceGuard.roleSafety` and `holdSuspendedAccountIds`).

**Shared model routes:** selecting an account label does not bind the proxy's
credential. If an emitted model can reach any known weekly-held non-burn
credential, the plugin refuses that emission and chooses an already-approved
safe alternative or returns a bounded defer. Unknown serving inventory is not
proof of safety. Defaults, effort changes, policy arms, duplicate passes and
exhaustion fallback cannot reopen the same route. A burn credential sharing an
indistinguishable route can therefore wait too; it remains burn-exempt, but does
not authorize use of the held non-burn credential. Distinct safe emissions and
burn-only routes remain usable. No credential aliases or proxy changes are made.

Pool verdicts name `hardHeldAccountIds` and report state `hard-held` (all
non-burn accounts held) or `lanes-paced` (mixed). Existing runs are never
cancelled. `/caps` preserves running floors but cannot create new fixed-model
or reviewer slots on a hard-held account. `paceGuard.rawPools` retains
role-independent hold facts for global `/caps` consumers; `paceGuard.pools` is
the doer-role admission view. Every running run continues charging its recorded
account and pool, even after its route becomes held or ineligible; it is never
rematched to a new candidate. Reviewer-local ordinary caps include other agents'
ordinary pool pressure. Burn identity and running pressure survive role filters.

When this layer is enabled, new fixed/reviewer grants require a feature-compatible
snapshot from the current producer instance and configuration/admission generation,
no older than 120 seconds and not future-dated. A failed refresh, old-policy,
pre-feature or incompatible snapshot preserves running floors but grants no
affected new slots, reporting `weekly-hold-evidence-unavailable`. Opting out of
the weekly layer retains the existing disabled-hold freshness behavior.

**Plan endpoint:** the linear target is `elapsedFraction * (1 - configuredFloor)`,
reaching **100% minus the explicit floor at reset**, with no additional pacing
remainder. `burnMode.floors` matchers supply that level floor (also for accounts
outside burn mode) only when the floor governs the weekly meter; when a
regenerating bar is present the floor governs that bar instead and does not
reduce the weekly target. No weekly floor means a zero floor for this plan.
Required rate and concurrency need use
`max(0, 1 - floor - weeklyUsed) / hoursToPaceReset`, while reported
`remainingPct` stays the true raw remainder. `/capacity.accounts` exposes
`planTargetUsedPct` and `spendableRemaining`. Credit fallback still paces its
own credit balance. This is a target, not a guarantee: demand, task sizes,
five-hour limits, review reserves, health and configured floors can still
prevent using every remaining unit. No reserve, exhaustion guard, role
exclusion or credential gate is weakened.

**Where it applies.** These layers size the legacy allocator that
`/caps` and the retained transitional resolver use. The native
`ai.connections.route` callback selects with `pacing: null`
(`src/router.mjs`) and has its own ahead and measured-rate-too-fast hold
(`src/snapshot.mjs`); this weekly hold is **not** native admission protection
and must not be described as such. Enabling the native router does not port it.
Protection is limited to compatibility decisions and grants this plugin controls,
not native or unrelated proxy traffic.
`/caps` keeps its response shape in both build variants until the consumer
census proves it empty.

**Rollback:** set `pacing.holdAheadPts: null` (keep the ordinary pace cap) or
`pacing.guard.enabled: false` (both layers). No state migration is involved and
no running work is cancelled.

## Newest version per account (opt-in)

`roles.newestVersionOnly.enabled` defaults to `false`; absent or disabled leaves
legacy routing unchanged. When enabled, each account's served model list (or
inferred provider arms when the list is absent) defines its own universe. Older
versions of the same parsed product line are structurally excluded even when the
newest version is unscored or unavailable. Models with unknown identities or
versions fail open. Distinct products, such as Flash and Flash Lite, do not
supersede one another merely because they share a family.

Overrides under `roles.newestVersionOnly.overrides` allow `keep` entries such as
`arm:<armId>`, `model:<canonicalModel>`, or `product:<productKey>`; a bare arm
or model ID is also accepted. An effort-scoped arm keep applies only to that
representation. `productAliases` maps parsed product keys to a shared key, and
`parsePins` assigns a `product` and numeric `version` to a model or arm when
parsing needs correction. Inspect the account view under `/capacity.newestVersion`
and ladder `supersededArmEvidence` before enabling: evidence includes retained
keeps, while the published exclusion arrays contain only actual exclusions.
A keep prevents version removal, not strict Pareto, cross-account dominance,
quality, readiness, breaker, or manual exclusions. Roll back by disabling the
flag; no model is automatically upgraded.

## Account fallback (opt-in)

`roles.accountFallback` defaults to disabled. When enabled, an account without
an eligible arm for a configured `doer` or `other` role can admit its best
eligible fallback candidate for that account and role only. The default roles
are `['doer', 'other']` and the default `minQuality` is `-0.5`; thinkers and
recognized reviewers do not receive this fallback. Existing manual, outcome,
version, readiness, breaker, trial and other safety fences remain in force;
finalization can suppress a provisional admission. Task-ranking enforce mode
is not supported. Inspect `/capacity.eligibility.accountFallback` for admitted
and suppressed rows and warnings. The dashboard reads global exclusions, so a
fallback admission does not remove the corresponding global exclusion there.

The quality floor is a **fleet-relative z-score**, not an absolute model score:
it can change as the scored fleet changes. Examine current quality scores and
floors before choosing a threshold.

For a staged rollout, retain a genuine pre-newest capture and its capture-time
provenance (producer revision, both resolved feature flags and host timestamp)
and pass its historical fidelity gate before enabling newest. Deploy fallback
with the flag disabled and verify the fallback report is absent; only after the
newest-enabled capture and its producer-matched fidelity and parity gates pass
should fallback be enabled. Monitor admitted and suppressed rows for 24 hours.
A `superseded-version` suppression is an integration alarm; persistent
`cross-account-excluded` suppression on a dead account warrants review.
A capture without provenance cannot establish historical fidelity.

## Exact-id included pricing and missing-AA canaries (unreleased, opt-in)

These controls admit an arm **inside its existing account**, not a second free
account. They never enable live enforcement, acquire credentials, or add a job.
All keys are optional; empty maps/lists and punctuation folding off retain the
scored routing behavior. Mandatory bans remain unconditional: `gpt-6-sol` and
`gpt-5.6-terra`, including prefixed/dashed spellings, cannot build arms or enter
reviewer admission. `bannedModels` can only add bans.

```json
{
  "trials": {
    "unscoredServedIds": [
      { "servedId": "devin/swe-2", "reason": "Verify offer eligibility for the actual serving integration" }
    ],
    "maxInFlightPerAccountByProvider": { "devin": 1 }
  },
  "placement": {
    "duplicateVersionPunctuationFolding": true,
    "freeCostServedIds": {
      "devin/swe-2": {
        "until": "2026-11-30T23:59:59Z",
        "reason": "Example only; verify the included-price deadline before enabling"
      }
    }
  }
}
```

- `trials.unscoredServedIds` requires exact, unique served ids with provenance.
  It cannot admit banned models or unscored members of already-proven families.
  Missing AA remains missing: `Q`, `qFleet`, AA row and context remain null.
  No quality score is borrowed. Admission is limited to legacy routing
  (`taskRanking.mode=off` or `shadow`), not enforced task ranking.
- `placement.freeCostServedIds` applies zero monetary cost **only to that exact
  served id**, through its timezone-explicit real-calendar deadline (inclusive).
  An expired scored arm resumes normal pricing; an unscored arm without a price
  is withdrawn. Hooks re-check expiry and rebuild benchmark shells without
  waiting for the next native tick. An unscored canary shares rung zero without
  moving scored benchmark rungs.
- Feasible free, still-ungraduated unscored canaries receive rung-zero exploration
  preference, bounded by existing role/adapter, family and account in-flight
  gates. Retry escalation retains authority. Existing terminal outcomes govern
  `minRuns`/`minSuccessRate` graduation and outcome exclusion. Graduation ends
  exploration preference without assigning quality; scored siblings can win
  again. This is not a fleet-wide free-first guarantee.
- Punctuation folding recognizes duplicate spellings such as `gpt-6-1-sol` and
  `gpt-6.1-sol`, without changing emitted ids. Only duplicate aggregator arms are
  held for native routes; unique arms on the same mixed account remain ordinary
  candidates. Reviewer duplicates likewise wait for an actually usable native
  reviewer route and release on native outage or holds.
- Free and paid arms share their account's cap, reservations and breaker namespace.
  Paid reviewer runs use the same account cap, including pending free work and
  self-run exclusion; a legacy kept default cannot escape a full reactive cap.

Accepted limits mirror `freeCostProviders`: quota burn still uses real resource
cost. Enforced task ranking reports zero cash for a scored included-price arm
but keeps its resource-cost frontier; an inexpensive paid arm may still dominate
it. The mixed account is **not** marked free, is not added to `freeLanes`, gains
no account-ordering boost or free-overflow privilege, and acquires no quota meter.
