# Official-upstream proposal-only contract

## Target and provenance

- Host tag: `v2026.1012.0`.
- Host commit: `bba6a45f0d364cfd962ac59b3bdf2426a8222adb`.
- Baseline plugin commit: `8672c4108436acc8b5ac94f26d06241a069392df`.
- `src/official-capabilities.json` is an exact extraction of the host's
  `packages/shared/src/constants.ts` `PLUGIN_CAPABILITIES`, with the source
  file SHA-256. `assertOfficialManifest` fails closed on any unknown capability.
- Both manifest exports use only this official list. There is no `modelRouting`
  declaration or registered `onResolveRunModel` hook. No host migration or
  fork-only queued-count API is required.

## Proposal contract

The supported scheduled job refreshes the existing selection view and computes
per-agent candidates. Selection continues to use the existing `decide` and
account-order policy: cheapest capable rung, quality/role/context boundaries,
quota, pace, credential readiness and breaker filters. This change does not
turn a recommendation into a run admission mechanism.

`GET /proposals?companyId=<company UUID>` exposes:

- `target: {tag, commit}`, `mode: "propose-only"`, `writeEnabled: false`;
- `status: "hold"` with a stable reason when inputs are unavailable;
- per-agent proposal summaries: ID, status/reason, changed model/effort,
  owned context env values and changed `maxConcurrentRuns`;
- `application.reason: "actuator-authority-not-qualified"` for a proposed
  change. It is deliberately not an applied receipt.

Only summaries are persisted. Existing env bindings and unrelated runtime
settings are never copied into the proposal endpoint or proposal state. The
transient `buildAgentProposal` helper constructs a PATCH candidate while
preserving those settings in memory. An unchanged candidate returns `noop`.
The owned environment keys are:

- `CLAUDE_CODE_MAX_CONTEXT_TOKENS`;
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`;
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.

The candidate removes obsolete owned caps when selection no longer emits them.
It preserves unrelated env bindings and heartbeat/runtime siblings. Concurrency
is at `runtimeConfig.heartbeat.maxConcurrentRuns`, clamped to **1..50**.
A missing/non-finite or below-one allocation is a **hold with no PATCH**.
Zero is not an off switch. A positive cap is a proposed default, not a strict
fleet quota, and cannot express a total stop on the official host. No
pause/resume or external pacer is substituted.

Official stable exposes no SDK queued-heartbeat census. Kept/review agents'
queued demand is reported as unavailable, never approximated from their stale
assigned-card backlog. This can withhold idle-agent cap recommendations and
must be measured during shadow qualification.

Proposals do not create synthetic ledger runs, reserve trial capacity or claim
half-open probes. `agent.run.started`, `agent.run.finished`,
`agent.run.failed` and `agent.run.cancelled` continue to own actual run facts.
Historical enforced records remain readable; no state or history is erased.

## Per-card pins

Official `PluginIssuesClient.create` accepts `assigneeAdapterOverrides`;
`PluginIssuesClient.update` does not. Callers creating an issue can use
`buildIssueModelOverrides({model, effort}, existingOverrides)` to construct
`{adapterConfig: {model, effort}}` defaults. Explicit existing issue model and
effort values take precedence. This helper does not create or update an issue
and adds no issue-write capability. The host's native issue overrides take
precedence over agent defaults at run start.

## Actuator is NOT QUALIFIED

`WRITE_ACTUATOR_ENABLED` is a hard-coded **false**. `applyAgentProposal`
performs **no secret resolution and no HTTP request**, even if a legacy config
sets `enforce: true`. It returns a hold, not a simulated success. This candidate
does not yet implement a write-capable public-API executor.

The proposed future design is public HTTPS `PATCH /api/agents/:id`, only on
change, using an existing narrowly authorized identity via `secrets.read-ref`.
A public hostname alone is not a safe destination pin. Any write-enabled
successor must bind token destination, company, permitted agents/fields, secret
reference, timeouts, redirect refusal, fresh read/diff/no-op and failure-closed
authorization to an independently reviewed artifact. Never use loopback,
`agents.managed`, a broader credential or a host pacer as a fallback.

There is a concrete official-host authority conflict to resolve first:

- `server/src/routes/agents.ts:2922-2930` classifies `env` as a local adapter
  host-command setting.
- `:2949-2959` allows specific credential references, not plain context-cap env.
- `:2963-2977` rejects those env mutations from agent keys on local adapters;
  `:5653-5658` applies the guard on PATCH.
- `packages/shared/src/validators/agent.ts:171-203` lists standard, task-bridge
  and skill-test key scopes, not a field-scoped actuator key.

These references are to the exact official commit above, not a running host.
No mutation was used to probe the boundary. A security scope verdict must
resolve the identity/custody/field contract; tests do not grant authority.

## Qualification and rollback

This source candidate requires independent acceptance coverage and review.
An offline capability/selection check is not proof of an installed host,
24-hour shadow agreement, quota safety, a release, or deployment approval.
Do not install or enable writes based on this document. Keep write mode disabled
until the exact artifact receives favorable scope review and all rollout gates.

ACT: replace unsupported resolver/census surfaces with supported observation
and proposals. WHY: load against the pinned official capability contract
without carrying host features. UNDO: revert the plugin code commit or retain
the prior plugin artifact. There are no agent writes or migrations to undo;
retain existing plugin state and all source history.

Offline checks:

```sh
node --test test/decide.test.mjs test/ledger.test.mjs test/pacing.test.mjs
npm test
npm run check:public-pin
```

The full suite still contains v0.2 resolver/census and version assertions that
need independent test-author migration. Do not skip them or represent that
suite as green. Package a candidate without publishing with `npm pack`; record
the exact tarball hash separately from the source commit. A corrected candidate
will have different bytes even if its version stays the same before release.
