import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const NOW = Date.parse('2026-10-25T06:00:00Z');
const TERRA = 'gpt-5.6-terra';
const SOL = 'gpt-6.1-sol';
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const key = stateKey => ({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
const previous = model => ({ runId: 'prior-run', model, decisionId: 'prior-decision' });

// Real hook boundary, real ladder/selection/readiness, synthetic external I/O.
// Terra is cheaper; Sol is better and more expensive, so neither dominates.
async function start(options = {}) {
  const { solWindow = 1000000, config = {}, account = {}, agent = null } = options;
  const terraWindow = Object.hasOwn(options, 'terraWindow') ? options.terraWindow : 372000;
  const store = new Map();
  const jobs = new Map();
  const events = new Map();
  const rawConfig = {
    enforce: true,
    cliproxy: { laneKeySecretRef: SECRET },
    armMap: [
      { aaSlug: 'gpt-5-6-terra', model: TERRA, family: 'terra', effort: 'high', providers: ['codex'] },
      { aaSlug: 'gpt-6-1-sol', model: SOL, family: 'sol', effort: 'high', providers: ['codex'] },
    ],
    roles: { minQuality: { doer: null, other: null, thinker: null } },
    reviewReserve: { enabled: false },
    ...config,
  };
  const lane = {
    lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy',
    models: [TERRA, SOL], quality: 'live', observedAt: new Date(NOW).toISOString(),
    weekly: { used: 0.1, resetsAt: new Date(NOW + 24 * 3600000).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(NOW + 4 * 3600000).toISOString() },
    ...account,
  };
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => rawConfig },
    state: {
      get: async k => store.get(JSON.stringify(k)) ?? null,
      set: async (k, v) => { store.set(JSON.stringify(k), v); },
    },
    secrets: { resolve: async () => 'synthetic-lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({
      observedAt: new Date(NOW).toISOString(), servedModels: [TERRA, SOL], accounts: [lane],
    }, NOW) }) },
    agents: { get: async () => agent },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { events.set(name, fn); } },
    logger: { info() {}, error() {}, warn() {} },
  });
  store.set(JSON.stringify(key('aa-snapshot-v1')), {
    fetchedAt: new Date(NOW).toISOString(), duplicateSlugs: [],
    rows: [
      { slug: 'gpt-5-6-terra', intelligenceIndex: 55, intelligenceIndexCostPerTask: 1,
        price1mInputTokens: 1, price1mOutputTokens: 4,
        ...(terraWindow === undefined ? {} : { contextWindowTokens: terraWindow }) },
      { slug: 'gpt-6-1-sol', intelligenceIndex: 60, intelligenceIndexCostPerTask: 2,
        price1mInputTokens: 2, price1mOutputTokens: 8, contextWindowTokens: solWindow },
    ],
  });
  await plugin.onConfigChanged(rawConfig, { companyId: 'acme' });
  if (agent) {
    for (const type of ['agent.run.started', 'agent.run.finished']) {
      await events.get(type)({
        type, companyId: 'acme', entityId: 'agent-cache-run',
        payload: { run: { agentId: 'agent-9', model: SOL, adapterType: 'claude-code' } },
        occurredAt: new Date(NOW).toISOString(),
      });
    }
  }
  await jobs.get('shadow-tick')({ companyId: 'acme' });
  return {
    hook: (extra = {}) => plugin.onResolveRunModel({
      runId: 'context-hook', companyId: 'acme', agentId: 'agent-9', issueId: 'issue-1',
      adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
      agentDefaultModel: SOL, previous: null, issueOverrideModel: null, deadlineMs: 1500,
      ...extra,
    }),
    api: async routeKey => (await plugin.onApiRequest({ companyId: 'acme', routeKey })).body,
  };
}

test('normal hook: a resumed 1M model cannot move to Terra 372k without a token count', async () => {
  const d = await start();
  const out = await d.hook({ previous: previous(SOL) });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL, 'unknown usage must not shrink the previous model window');
});

test('normal hook: decorated previous.model still protects the resumed window', async () => {
  const d = await start();
  const out = await d.hook({ previous: previous(`codex/${SOL}(high)`) });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
});

test('normal hook: a genuinely fresh session can use Terra 372k', async () => {
  const d = await start();
  const out = await d.hook();
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, TERRA);
});

test('normal hook: equal windows retain the exact fresh and resumed wire decision', async () => {
  const fresh = await start({ terraWindow: 1000000 });
  const resumed = await start({ terraWindow: 1000000 });
  const want = JSON.stringify({
    kind: 'decide', decisionId: 'mc-context-hook-codex-c1-r0-gpt-5-6-terra',
    model: TERRA, effort: 'high', env: {}, source: 'model-capacity',
    reason: 'rung 0 on codex:c1 (doer)',
  });
  assert.equal(JSON.stringify(await fresh.hook()), want);
  assert.equal(JSON.stringify(await resumed.hook({ previous: previous(SOL) })), want);
});

test('an exact served-id window cap must constrain routing, not only the emitted env', async () => {
  const d = await start({
    terraWindow: 1000000,
    config: { contextCaps: { servedIds: { [TERRA]: { maxTokens: 372000, autoCompactTokens: 350000 } } } },
  });
  const out = await d.hook({ previous: previous(SOL) });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL, 'AA 1M metadata cannot make a capped 372k route safe for a resumed 1M model');
});

test('reviewer hook: configured Terra arm cannot shrink a resumed Sol window', async () => {
  const d = await start({ config: { reviewerRouting: {
    agentIds: ['reviewer-1'], arms: [
      { provider: 'codex', model: TERRA, effort: 'high' },
      { provider: 'codex', model: SOL, effort: 'high' },
    ],
  } } });
  const out = await d.hook({ agentId: 'reviewer-1', previous: previous(SOL) });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
});

test('reviewer hook: a fresh review remains eligible for Terra', async () => {
  const d = await start({ config: { reviewerRouting: {
    agentIds: ['reviewer-1'], arms: [{ provider: 'codex', model: TERRA, effort: 'high' }],
  } } });
  const out = await d.hook({ agentId: 'reviewer-1' });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, TERRA);
});

for (const terraWindow of [null, undefined, 0]) {
  test(`missing or invalid window (${terraWindow}) uses the agent configured 500k, not a 1M default`, async () => {
    const d = await start({
      terraWindow,
      agent: { id: 'agent-9', adapterType: 'claude-code', adapterConfig: {
        model: SOL, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000' },
      } },
    });
    const out = await d.hook({ previous: previous(SOL) });
    assert.equal(out.kind, 'decide');
    assert.equal(out.model, SOL, 'an unknown arm window is not evidence that it can hold a resumed 1M session');
  });
}

test('an unknown previous model falls back to the configured agent window, not zero context', async () => {
  const d = await start({ agent: { id: 'agent-9', adapterType: 'claude-code', adapterConfig: {
    model: SOL, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '500000' },
  } } });
  const out = await d.hook({ previous: previous('unlisted-prior-model') });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
});

test('context safety cannot bypass weekly exhaustion or credential readiness', async () => {
  for (const account of [
    { weekly: { used: 1, resetsAt: new Date(NOW + 24 * 3600000).toISOString() } },
    { credentialAvailability: { version: 1, models: [] } },
  ]) {
    const d = await start({ account, config: { credentialReadiness: { enforce: true } } });
    const out = await d.hook({ previous: previous(SOL) });
    assert.equal(out.kind, 'defer', JSON.stringify({ account, out }));
  }
});
