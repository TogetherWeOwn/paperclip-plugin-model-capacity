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

import { DEFAULT_ACCOUNTS_PATH, LANE_ACCOUNTS_PATH_ALLOWLIST } from './cliproxy.mjs';

export const PLUGIN_ID = 'togetherweown.model-capacity';
export const PLUGIN_VERSION = '0.2.22';

/** Lane endpoint allowlist: the ONLY host `cliproxy.baseUrl` may name. */
export const LANE_BASE_URL_ALLOWLIST = Object.freeze([
  'https://router.infextion.net',
]);

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
        baseUrl: { type: 'string', enum: [...LANE_BASE_URL_ALLOWLIST], default: 'https://router.infextion.net' },
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
        excludeFamilies: {
          type: 'object', default: {}, additionalProperties: false,
          description: 'Emergency override only: families (or arm:<armId> tokens) removed from a role by hand. Eligibility is decided from data by minQuality and outcomeGate; a warning is logged while this is non-empty.',
          properties: {
            doer: { type: 'array', default: [], items: { type: 'string' } },
            thinker: { type: 'array', default: [], items: { type: 'string' } },
            other: { type: 'array', default: [], items: { type: 'string' } },
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
      },
    },
    concurrency: {
      type: 'object', additionalProperties: false,
      properties: {
        maxTotal: { type: 'integer', minimum: 1, default: 75 },
        meanRunDurationHours: { type: 'number', exclusiveMinimum: 0, default: 0.186 },
      },
    },
    contextCaps: {
      type: 'object', additionalProperties: false,
      properties: {
        solLunaMaxTokens: { type: 'integer', minimum: 1, default: 260000 },
        solLunaAutoCompactTokens: { type: 'integer', minimum: 1, default: 240000 },
        autoCompactEnvKey: { type: ['string', 'null'], default: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' },
        haikuMaxOutputTokens: { type: 'integer', minimum: 1, default: 64000 },
      },
    },
    enforce: {
      type: 'boolean', default: false,
      description: 'Kill switch for run.model.resolve enforcement. False (default): the hook answers keep and nothing changes. True: the hook decides from cached tick state.',
    },
    trials: {
      type: 'object', additionalProperties: false,
      description: 'Trial lanes for model families without fleet success history (roles-gated, adapter-gated, in-flight-capped until measured success graduates them).',
      properties: {
        maxInFlightPerAccount: { type: 'integer', minimum: 1, default: 2 },
        maxInFlightPerFamily: { type: 'integer', minimum: 1, default: 2 },
        minRuns: { type: 'integer', minimum: 1, default: 10 },
        minSuccessRate: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
        roles: {
          type: 'array', items: { type: 'string' }, default: ['doer', 'other'],
          description: 'Roles that may take trial arms. Default doer + other; thinkers never take trial traffic (unmeasured by definition).',
        },
        adapters: {
          type: 'object', default: { claude_local: ['*'], 'claude-code': ['*'] },
          description: 'Adapter type to trial-eligible families ("*" means any family). Unlisted adapters get no trial arms.',
          additionalProperties: { anyOf: [{ const: '*' }, { type: 'array', items: { type: 'string' } }] },
        },
      },
    },
    modelAaOverrides: {
      type: 'object', default: {},
      description: 'Operator extensions to the AA-slug override table: CLIProxy model id to AA slug (or { slug, effort }). Merged over the built-in table.',
      additionalProperties: { anyOf: [{ type: 'string' }, { type: 'object' }] },
    },
    breakers: {
      type: 'object', additionalProperties: false,
      description: 'Arm circuit breaker: provider-side model errors open a per-arm breaker (cool-off, half-open single probe). enabled:false is the kill switch.',
      properties: {
        enabled: { type: 'boolean', default: true },
        tripCount: { type: 'integer', minimum: 1, default: 2 },
        windowMin: { type: 'number', exclusiveMinimum: 0, default: 30 },
        cooloffHours: { type: 'number', exclusiveMinimum: 0, default: 6 },
        maxCooloffHours: { type: 'number', exclusiveMinimum: 0, default: 48 },
        probeTimeoutMs: { type: 'integer', minimum: 60000, default: 7200000 },
        fatalPatterns: {
          type: 'array', default: ['unknown provider for model', 'auth_unavailable', 'no auth available', 'requested entity was not found', 'model_not_found', 'model not found', 'invalid model', 'unknown model', '400+model', 'model is unavailable', 'no healthy managed'],
          description: 'Case-insensitive substring hits; entries with "+" need every part ("400+model") and are vetoed by transient patterns.',
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
    'issues.read',
    'api.routes.register',
    // No database capabilities: run facts come from SDK surfaces only
    // (agent.run.* events, issues.get, agents.get). The host executes
    // plugin SQL unchanged, so a core-table grant's tenant filter would be
    // plugin-enforced only -- refused scope, removed in v0.2.1.
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
