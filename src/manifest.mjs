/**
 * Plugin manifest. v0.1.5 = SHADOW: no `run.model.resolve` capability.
 * Another plugin currently holds that capability and two holders conflict,
 * so the resolve hook ships implemented but unwired. v0.2.0 enables it by
 * switching to the `modelResolve` variant (capability + modelRouting).
 *
 * v0.1.2: burn telemetry comes from ONE host-published lane endpoint
 * (GET {baseUrl}{accountsPath}, X-Api-Key lane key). The plugin worker
 * cannot reach CLIProxy directly (private IPs are blocked) and the
 * management key stays on the host.
 */

export const PLUGIN_ID = 'togetherweown.model-capacity';
export const PLUGIN_VERSION = '0.1.5';

/** Env keys a run.model.resolve decision may set (v0.2.0 variant only). */
export const MODEL_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  // Provisional: no auto-compact watermark key was found in the host
  // codebase; the name below is configurable and unverified.
  'CLAUDE_CODE_AUTO_COMPACT_TOKENS',
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
        baseUrl: { type: 'string', default: 'https://router.infextion.net' },
        accountsPath: { type: 'string', default: '/telemetry/cliproxy/live/accounts.json' },
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
    pacing: {
      type: 'object', additionalProperties: false,
      properties: {
        deadband: { type: 'number', minimum: 0, default: 0.02 },
        rungCooldownMs: { type: 'integer', minimum: 60000, default: 600000 },
        guardHighPct: { type: 'number', minimum: 0, maximum: 1, default: 0.8 },
        guardRejoinPct: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        rateDeadbandRel: { type: 'number', minimum: 0, default: 0.15 },
        rateMinDeadbandPerHour: { type: 'number', minimum: 0, default: 0.005 },
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
        autoCompactEnvKey: { type: ['string', 'null'], default: 'CLAUDE_CODE_AUTO_COMPACT_TOKENS' },
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
    shadow: {
      type: 'object', additionalProperties: false,
      properties: {
        maxEntries: { type: 'integer', minimum: 100, default: 2000 },
      },
    },
  },
};

/**
 * Build the manifest. Pass `{ modelResolve: true }` for the v0.2.0
 * enforcement variant: it adds the `run.model.resolve` capability and the
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
    // Heartbeat-run backfill reads the whitelisted core table
    // `heartbeat_runs` (SELECT only, via the `database` declaration below).
    // `migrate` is declared but never exercised: the schema validator pairs
    // it with `namespace.read` unconditionally, and this plugin owns no
    // tables (migrations/ is deliberately empty). Never `namespace.write`.
    'database.namespace.read',
    'database.namespace.migrate',
  ];
  const out = {
    id: PLUGIN_ID,
    apiVersion: 1,
    version: PLUGIN_VERSION,
    displayName: 'Model Capacity (Shadow)',
    description: 'Shadow model-capacity decisions: paced per-account Pareto ladders from AA quality and CLIProxy burn data. v0.1.5 observes only; it changes no runs and holds no resolve capability.',
    author: 'TogetherWeOwn',
    categories: ['automation'],
    capabilities,
    entrypoints: { worker: './src/worker.mjs' },
    database: {
      namespaceSlug: 'model_capacity',
      migrationsDir: './migrations',
      // Exactly the one core table the shadow tick reads (restricted
      // SELECT in plugin.mjs RUNS_SQL); nothing else is allowlisted.
      coreReadTables: ['heartbeat_runs'],
    },
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
    ],
  };
  if (modelResolve) {
    out.capabilities = [...capabilities, 'run.model.resolve'];
    out.displayName = 'Model Capacity';
    out.modelRouting = { envKeys: [...MODEL_ROUTING_ENV_KEYS] };
  }
  return out;
}

/** v0.1.5 shadow manifest: no resolve capability, no modelRouting. */
export const manifest = buildManifest();
export default manifest;
