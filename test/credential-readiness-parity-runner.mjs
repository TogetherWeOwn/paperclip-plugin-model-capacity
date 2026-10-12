import { pathToFileURL } from 'node:url';

const TICK = Date.parse('2026-10-11T12:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';
const MODELS = [MODEL_A, MODEL_B];
const ARM_MAP = MODELS.map(model => ({
  aaSlug: model, model, effort: 'max', family: 'sol', providers: ['partner'],
}));
const AA_ROWS = MODELS.map((slug, i) => ({
  slug, intelligenceIndex: 80 - i * 10, intelligenceIndexCostPerTask: 10 + i * 5,
  price1mInputTokens: 1 + i, price1mOutputTokens: 4 + i,
}));
const NS = 'model-capacity';
const stateKey = key => ({ scopeKind: 'company', scopeId: 'parity', namespace: NS, stateKey: key });
const keyOf = value => JSON.stringify(value);

function account(accountKey, models, { provider = 'partner', health = 'healthy' } = {}) {
  return {
    provider, accountKey, health, meter: 'reactive',
    ...(models === null ? {} : { models }),
    weekly: { used: 0.3 },
    observedAt: new Date(TICK).toISOString(),
  };
}

function evidence(accountKey, ready, nowMs) {
  return {
    version: 1,
    models: MODELS.map(model => ({
      model, provider: 'partner', accountId: `partner:${accountKey}`,
      servingCredentials: 2, readyCredentials: ready ? 1 : 0,
      observedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 120000).toISOString(),
    })),
  };
}

function makeScenario(name) {
  switch (name) {
    case 'pool-mate-empty-model-list':
      return [account('empty', []), account('working', null)];
    case 'breaker-open-lane':
      return [account('breaker', null)];
    case 'mixed-evidence': {
      const ready = account('ready', null);
      ready.credentialAvailability = evidence('ready', true, TICK);
      const cooling = account('cooling', null);
      cooling.credentialAvailability = evidence('cooling', false, TICK);
      return [ready, cooling];
    }
    case 'ordinary':
    case 'tick-decided':
    case 'stale-view':
    case 'future-view':
    case 'backward-clock-step':
      return [account('ordinary', null)];
    default:
      throw new Error(`unknown parity scenario: ${name}`);
  }
}

function normalizeHook(result) {
  return {
    kind: result?.kind ?? null,
    model: result?.model ?? null,
    reason: result?.reason ?? null,
    retryAfterMs: result?.retryAfterMs ?? null,
  };
}

function normalizeEntries(entries) {
  return entries.map(row => ({
    runId: row.runId,
    accountId: row.accountId ?? null,
    armId: row.armId ?? null,
    wouldModel: row.wouldModel ?? null,
    eventTime: row.eventTime === true,
    enforced: row.enforced === true,
    reason: row.reason ?? null,
  })).sort((a, b) => a.runId.localeCompare(b.runId));
}

function normalizeLadder(ladders) {
  const out = {};
  for (const id of Object.keys(ladders ?? {}).sort()) {
    out[id] = (ladders[id]?.rungs ?? []).map(r => r?.armId ?? r?.model ?? null);
  }
  return out;
}

export async function runParityCorpus(pluginFactory, repoRoot) {
  const cases = {};
  for (const name of [
    'ordinary', 'pool-mate-empty-model-list', 'breaker-open-lane',
    'stale-view', 'future-view', 'backward-clock-step',
    'tick-decided', 'mixed-evidence',
  ]) {
    cases[name] = await runCase(pluginFactory, repoRoot, name);
  }
  return cases;
}

async function runCase(pluginFactory, repoRoot, name) {
  let now = TICK;
  let accounts = makeScenario(name);
  const lane = { observedAt: new Date(TICK).toISOString(), servedModels: MODELS, get accounts() { return accounts; } };
  const store = new Map();
  const jobs = new Map();
  const events = new Map();
  const config = {
    enforce: true,
    credentialReadiness: { enforce: false },
    cliproxy: { laneKeySecretRef: SECRET },
    armMap: ARM_MAP,
    roles: {
      doerAgentIds: ['agent-parity'],
      // Null bars: the quality gate suspends below 8 scored arms and the
      // corpus has 2, so any bar here would be a no-op either way.
      minQuality: { doer: null, thinker: null, other: null },
      outcomeGate: { enabled: false },
    },
    trials: { roles: ['doer'], adapters: { 'claude-code': ['*'] }, maxInFlightPerAccount: 8 },
  };
  // Test seam from the lane-host pin (main #14): the synthetic lane has no
  // pinned host. Old baseline factories ignore the unknown option.
  const plugin = pluginFactory({ clock: () => now, requirePinnedLaneHost: false });
  const ctx = {
    config: { get: async () => config },
    state: {
      get: async k => store.get(keyOf(k)) ?? null,
      set: async (k, value) => { store.set(keyOf(k), value); },
    },
    secrets: { resolve: async () => 'synthetic-key' },
    http: { fetch: async () => ({ status: 200, json: async () => lane }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (job, fn) => jobs.set(job, fn) },
    events: { on: (event, fn) => events.set(event, fn) },
    logger: { info() {}, error() {}, warn() {} },
  };
  await plugin.setup(ctx);
  store.set(keyOf(stateKey('aa-snapshot-v1')), {
    fetchedAt: new Date(TICK).toISOString(), rows: AA_ROWS, duplicateSlugs: [],
  });
  await plugin.onConfigChanged(config, { companyId: 'parity' });

  if (name === 'breaker-open-lane') {
    const breakers = await import(pathToFileURL(`${repoRoot}/src/breakers.mjs`).href);
    const breakerStore = breakers.createBreakerStore();
    const opts = breakers.sanitizeBreakers?.() ?? breakers.DEFAULT_BREAKERS;
    for (const model of MODELS) {
      for (const atMs of [TICK - 120000, TICK - 60000]) {
        breakers.recordArmFailure(breakerStore, 'partner:breaker', model, {
          atMs, errorText: 'model not found',
        }, atMs, opts);
      }
    }
    store.set(keyOf(stateKey('breaker-v1')), breakers.breakerStoreToJSON(breakerStore, { nowMs: TICK, cfg: opts }));
  }

  // Establish a measurable calibration sample so target and /caps are in the corpus.
  const ledgerKey = stateKey('ledger-v1');
  const ledger = [
    { runId: 'calibration-1', agentId: 'agent-parity', status: 'finished', provider: 'partner', startedAt: TICK - 50 * 60000, endedAt: TICK - 40 * 60000 },
    { runId: 'calibration-2', agentId: 'agent-parity', status: 'finished', provider: 'partner', startedAt: TICK - 30 * 60000, endedAt: TICK - 20 * 60000 },
  ];
  store.set(keyOf(ledgerKey), ledger);
  const rateKey = stateKey('rate-history-v1');
  const rateHistory = key => [
    { atMs: TICK - 60 * 60000, usedPct: 0.28 },
    { atMs: TICK, usedPct: 0.3 },
  ];
  store.set(keyOf(rateKey), Object.fromEntries(accounts.map(a => [
    `${a.provider}:${a.accountKey}`, rateHistory(`${a.provider}:${a.accountKey}`),
  ])));

  // Runs that start before the first tick have no live view at event time,
  // so only the tick's own candidate loop can decide them. Two runs: the
  // second is decided with the first already counting as pressure.
  if (name === 'tick-decided') {
    for (const runId of ['tick-decided-early-1', 'tick-decided-early-2']) {
      await events.get('agent.run.started')({
        type: 'agent.run.started', companyId: 'parity', entityId: runId,
        payload: { run: { agentId: 'agent-parity', adapterType: 'claude-code' } },
        occurredAt: new Date(now).toISOString(),
      });
    }
  }

  await jobs.get('shadow-tick')({});
  const hookRunId = `${name}-hook`;
  if (name === 'stale-view') now = TICK + 121000;
  if (name === 'future-view') now = TICK - 121000;
  if (name === 'backward-clock-step') now = TICK - 1000;
  const hook = normalizeHook(await plugin.onResolveRunModel({
    runId: hookRunId, companyId: 'parity', agentId: 'agent-parity',
    adapterType: 'claude-code', deadlineMs: 1500,
  }));

  const eventRunId = `${name}-event`;
  await events.get('agent.run.started')({
    type: 'agent.run.started', companyId: 'parity', entityId: eventRunId,
    payload: { run: { agentId: 'agent-parity', adapterType: 'claude-code' } },
    occurredAt: new Date(now).toISOString(),
  });
  await jobs.get('shadow-tick')({});
  const capacity = (await plugin.onApiRequest({ companyId: 'parity', routeKey: 'capacity' })).body;
  const caps = (await plugin.onApiRequest({ companyId: 'parity', routeKey: 'caps' })).body;
  const shadow = (await plugin.onApiRequest({ companyId: 'parity', routeKey: 'shadow' })).body;
  const ladder = (await plugin.onApiRequest({ companyId: 'parity', routeKey: 'ladder' })).body;
  return {
    hook,
    shadow: normalizeEntries(shadow.entries),
    ladder: normalizeLadder(ladder.ladders),
    target: capacity.target ?? null,
    targetRaw: capacity.targetRaw ?? null,
    caps: {
      target: caps.target ?? null,
      calibration: caps.calibration ?? null,
      agents: (caps.agents ?? []).map(row => ({ agentId: row.agentId, reason: row.reason })),
    },
  };
}

export async function loadPluginFactory(repoRoot) {
  const plugin = await import(pathToFileURL(`${repoRoot}/src/plugin.mjs`).href);
  return plugin.createModelCapacityPlugin;
}
