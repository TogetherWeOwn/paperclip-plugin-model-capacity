import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decide.mjs';
import { servedIdForArm, canonicalModelName } from '../src/arms.mjs';
import { classifyArmError, DEFAULT_BREAKERS } from '../src/breakers.mjs';
import { buildLadder } from '../src/ladder.mjs';
import { versionTuple } from '../src/cross-account.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const NOW = Date.parse('2026-10-12T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };

// The account's feed models hold the provider-prefixed id: the decision must
// emit that exact id, never the canonical bare id (bare ids 400 on Devin and
// misbill to Codex when another provider serves the bare id).
test('devin account emits the exact provider-prefixed served id', async () => {
  const lane = {
    observedAt: new Date(NOW).toISOString(),
    servedModels: ['devin/gpt-5-5', 'devin/gpt-5-4'],
    accounts: [{
      lane: 'devin-lane-1', provider: 'devin', accountKey: 'devin-lane-1',
      health: 'healthy', meter: 'reactive',
      models: ['devin/gpt-5-5', 'devin/gpt-5-4'],
      weekly: { used: null, resetsAt: null },
      fiveHour: { used: null, resetsAt: null },
      observedAt: new Date(NOW).toISOString(), quality: 'reactive',
    }],
  };
  const rows = [
    { slug: 'gpt-5-5', intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: 'gpt-5-4', intelligenceIndex: 60, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ];
  const config = { enforce: true, cliproxy: { laneKeySecretRef: SECRET } };
  const store = new Map();
  const jobs = new Map();
  const key = k => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { devin: ['gpt-5-5', 'gpt-5-4'] } }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => jobs.set(n, fn) },
    events: { on: () => {} },
    logger: { info() {}, error() {}, warn() {} },
  });
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
    { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  await jobs.get('shadow-tick')({});
  const hook = await plugin.onResolveRunModel({
    runId: 'run-1', companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
    issueId: null, deadlineMs: 1500,
  });
  assert.equal(hook.kind, 'decide');
  assert.ok(String(hook.model).startsWith('devin/'), `expected devin/ prefix, got ${hook.model}`);
  assert.equal(canonicalModelName(hook.model), 'gpt-5-5');
});

// A bare id the account serves only prefixed must still resolve to the
// prefixed emission at the helper level. When the account lists the bare id
// it keeps emitting it unchanged -- even alongside a prefixed alias, and
// even a foreign prefix never beats the account's own bare id. An account
// listing ONLY a prefixed alias still emits the bare id whenever it is
// served (native lanes never take a prefixed alias); the alias is emitted
// only when the bare id is unserved or the provider is prefixed-only.
test('servedIdForArm maps bare arms to the account exact served id', () => {
  assert.equal(servedIdForArm(['devin/gpt-5-5', 'devin/gpt-5-4'], 'gpt-5-5', 'devin'), 'devin/gpt-5-5');
  assert.equal(servedIdForArm(['gpt-6-luna'], 'gpt-6-luna', 'codex'), 'gpt-6-luna');
  assert.equal(servedIdForArm(null, 'gpt-5-5', 'devin'), 'gpt-5-5');
  assert.equal(servedIdForArm(['devin/gpt-5-5'], 'gpt-6-luna', 'devin'), 'gpt-6-luna');
  assert.equal(servedIdForArm(['gpt-6.1-sol', 'openai/gpt-6.1-sol'], 'gpt-6.1-sol', 'codex'), 'gpt-6.1-sol');
  assert.equal(servedIdForArm(['claude-sonnet-5-5', 'devin/claude-sonnet-5-5'], 'claude-sonnet-5-5', 'claude'), 'claude-sonnet-5-5');
});

// Alias-only native accounts keep the base bare emission whenever the bare
// id is served: base emitted bare for every native account, readiness keys
// on the bare id, and the host route serves it. Prefixed emission is for
// unserved bare ids and prefixed-only providers (devin, opencode-go).
test('servedIdForArm keeps native alias-only accounts on the bare emission', () => {
  const both = new Set(['gpt-6.1-sol', 'openai/gpt-6.1-sol', 'claude-sonnet-5-5', 'claude/claude-sonnet-5-5']);
  assert.equal(servedIdForArm(['openai/gpt-6.1-sol'], 'gpt-6.1-sol', 'codex', both), 'gpt-6.1-sol');
  assert.equal(servedIdForArm(['claude/claude-sonnet-5-5'], 'claude-sonnet-5-5', 'claude', both), 'claude-sonnet-5-5');
  assert.equal(servedIdForArm(['claude/claude-sonnet-5-5'], 'claude-sonnet-5-5', 'claude', [...both]), 'claude-sonnet-5-5');
  // Bare unserved: the listed alias is the only route.
  assert.equal(servedIdForArm(['openai/gpt-6.1-sol'], 'gpt-6.1-sol', 'codex', new Set(['openai/gpt-6.1-sol'])), 'openai/gpt-6.1-sol');
  // Prefixed-only providers emit the alias even fail-open (no served list).
  assert.equal(servedIdForArm(['devin/gpt-5-5'], 'gpt-5-5', 'devin', null), 'devin/gpt-5-5');
  assert.equal(servedIdForArm(['opencode-go/hy3-preview'], 'hy3-preview', 'opencode-go', null), 'opencode-go/hy3-preview');
  // synthetic.new lanes are prefixed-only: never the bare id (unknown to CLIProxy, or another provider's model).
  assert.equal(servedIdForArm(['synthetic/deepseek-v4.1-flash-1017'], 'deepseek-v4.1-flash-1017', 'synthetic', null),
    'synthetic/deepseek-v4.1-flash-1017');
  assert.equal(servedIdForArm(['synthetic/kimi-k3'], 'kimi-k3', 'synthetic', new Set(['kimi-k3', 'synthetic/kimi-k3'])),
    'synthetic/kimi-k3');
  assert.equal(servedIdForArm(['synthetic-infinite/deepseek-v4.1-flash'], 'deepseek-v4.1-flash', 'synthetic-infinite', null),
    'synthetic-infinite/deepseek-v4.1-flash');
  // A prefixed-only account that ALSO lists the bare id still emits its own prefixed alias.
  assert.equal(servedIdForArm(['kimi-k3', 'synthetic/kimi-k3'], 'kimi-k3', 'synthetic', new Set(['kimi-k3', 'synthetic/kimi-k3'])),
    'synthetic/kimi-k3');
  assert.equal(servedIdForArm(['gpt-5-5', 'devin/gpt-5-5'], 'gpt-5-5', 'devin', null), 'devin/gpt-5-5');
  // ... but only its OWN prefix: a foreign alias never beats the listed bare id.
  assert.equal(servedIdForArm(['kimi-k3', 'other/kimi-k3'], 'kimi-k3', 'synthetic', null), 'kimi-k3');
  // Native fail-open (no served list) stays byte-identical to base: bare.
  assert.equal(servedIdForArm(['openai/gpt-6.1-sol'], 'gpt-6.1-sol', 'codex', null), 'gpt-6.1-sol');
  assert.equal(servedIdForArm(['claude/claude-sonnet-5-5'], 'claude-sonnet-5-5', 'claude', null), 'claude-sonnet-5-5');
  // Devin keeps the prefixed emission when the bare id is unserved.
  assert.equal(servedIdForArm(['devin/gpt-5-5'], 'gpt-5-5', 'devin', new Set(['devin/gpt-5-5'])), 'devin/gpt-5-5');
});

// Alias-only native accounts keep the bare 1M decoration: a claude account
// listing only `claude/claude-sonnet-5-5` (bare served) decides the bare id,
// so a 1M run decorates `claude-sonnet-5-5(max)[1m]` exactly as base did --
// never `claude/...[1m]`. A devin account serving only the prefixed id keeps
// the prefix through the decoration (`devin/...[1m]`).
test('alias-only claude account decorates the bare id at 1M, devin keeps its prefix', async () => {
  async function hookFor({ provider, models, servedModels, slug }) {
    const lane = {
      observedAt: new Date(NOW).toISOString(), servedModels,
      accounts: [{
        lane: `${provider}-lane-1`, provider, accountKey: `${provider}-lane-1`,
        health: 'healthy', meter: 'reactive', models,
        weekly: { used: null, resetsAt: null },
        fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(), quality: 'reactive',
      }],
    };
    const rows = [
      { slug, intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4, contextWindowTokens: 1000000 },
    ];
    const config = { enforce: true, cliproxy: { laneKeySecretRef: SECRET } };
    const store = new Map();
    const jobs = new Map();
    const key = k => JSON.stringify(k);
    const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
    await plugin.setup({
      config: { get: async () => config },
      state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
      secrets: { resolve: async () => 'lane-key' },
      http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { [provider]: [canonicalModelName(models[0])] } }) }) },
      agents: { get: async () => null },
      issues: { get: async () => null, list: async () => [] },
      jobs: { register: (n, fn) => jobs.set(n, fn) },
      events: { on: () => {} },
      logger: { info() {}, error() {}, warn() {} },
    });
    store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
      { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
    await plugin.onConfigChanged(config, { companyId: 'acme' });
    await jobs.get('shadow-tick')({});
    return plugin.onResolveRunModel({
      runId: 'run-1m', companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
      issueId: null, deadlineMs: 1500,
    });
  }
  const native = await hookFor({
    provider: 'claude', models: ['claude/claude-sonnet-5-5'],
    servedModels: ['claude-sonnet-5-5', 'claude/claude-sonnet-5-5'], slug: 'claude-sonnet-5-5',
  });
  assert.equal(native.kind, 'decide');
  assert.equal(native.model, 'claude-sonnet-5-5(max)[1m]');
  const devin = await hookFor({
    provider: 'devin', models: ['devin/claude-sonnet-5-5'],
    servedModels: ['devin/claude-sonnet-5-5'], slug: 'claude-sonnet-5-5',
  });
  assert.equal(devin.kind, 'decide');
  assert.equal(devin.model, 'devin/claude-sonnet-5-5(max)[1m]');
});

// Native alias-only accounts emit the listed alias end to end when the bare
// id is unserved: a codex account listing only `openai/gpt-6.1-sol` with
// servedModels holding only that alias must decide the alias (not the bare id
// that 400s, not a defer). Pins both servedIds call sites in plugin.mjs: the
// ladder site (emits the alias) and the guard site (keeps the account
// servable). Dropping the argument at either site must fail this test.
test('native alias-only account decides the listed alias when the bare id is unserved', async () => {
  const lane = {
    observedAt: new Date(NOW).toISOString(),
    servedModels: ['openai/gpt-6.1-sol'],
    accounts: [{
      lane: 'codex-lane-1', provider: 'codex', accountKey: 'codex-lane-1',
      health: 'healthy', meter: 'reactive',
      models: ['openai/gpt-6.1-sol'],
      weekly: { used: null, resetsAt: null },
      fiveHour: { used: null, resetsAt: null },
      observedAt: new Date(NOW).toISOString(), quality: 'reactive',
    }],
  };
  const rows = [
    { slug: 'gpt-6-1-sol', intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ];
  const config = { enforce: true, cliproxy: { laneKeySecretRef: SECRET } };
  const store = new Map();
  const jobs = new Map();
  const key = k => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { codex: ['gpt-6.1-sol'] } }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => jobs.set(n, fn) },
    events: { on: () => {} },
    logger: { info() {}, error() {}, warn() {} },
  });
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
    { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  await jobs.get('shadow-tick')({});
  const capacity = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' });
  assert.equal((capacity.body.unservable ?? []).length, 0);
  const ladder = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'ladder' });
  const rungs = (ladder.body.ladders['codex:codex-lane-1']?.rungs ?? []);
  assert.ok(rungs.some(r => r.model === 'openai/gpt-6.1-sol'), 'alias missing from ladder');
  assert.ok(!rungs.some(r => r.model === 'gpt-6.1-sol'), 'unserved bare id reached the ladder');
  const hook = await plugin.onResolveRunModel({
    runId: 'run-alias-only', companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
    issueId: null, deadlineMs: 1500,
  });
  assert.equal(hook.kind, 'decide');
  assert.equal(hook.model, 'openai/gpt-6.1-sol');
});

// Same bare-unserved route through the 1M decoration: a claude account
// listing only `claude/claude-sonnet-5-5` with only the alias served must
// decide the prefixed 1M id (not the bare decoration, not a defer). Native
// prefixed `[1m]` ids therefore exist beyond the devin lane whenever the bare
// id is unserved.
test('native alias-only claude account decides the prefixed 1M id when the bare id is unserved', async () => {
  const lane = {
    observedAt: new Date(NOW).toISOString(),
    servedModels: ['claude/claude-sonnet-5-5'],
    accounts: [{
      lane: 'claude-lane-1', provider: 'claude', accountKey: 'claude-lane-1',
      health: 'healthy', meter: 'reactive',
      models: ['claude/claude-sonnet-5-5'],
      weekly: { used: null, resetsAt: null },
      fiveHour: { used: null, resetsAt: null },
      observedAt: new Date(NOW).toISOString(), quality: 'reactive',
    }],
  };
  const rows = [
    { slug: 'claude-sonnet-5-5', intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4, contextWindowTokens: 1000000 },
  ];
  const config = { enforce: true, cliproxy: { laneKeySecretRef: SECRET } };
  const store = new Map();
  const jobs = new Map();
  const key = k => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { claude: ['claude-sonnet-5-5'] } }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => jobs.set(n, fn) },
    events: { on: () => {} },
    logger: { info() {}, error() {}, warn() {} },
  });
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
    { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  await jobs.get('shadow-tick')({});
  const hook = await plugin.onResolveRunModel({
    runId: 'run-alias-1m', companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
    issueId: null, deadlineMs: 1500,
  });
  assert.equal(hook.kind, 'decide');
  assert.equal(hook.model, 'claude/claude-sonnet-5-5(max)[1m]');
});

// Unknown-provider failures are unservable for that (account, model): the
// error classifies breaker-fatal, and the decision never escalates onto the
// next rung of the same account the way test-fail retries do.
test('unknown-provider error is fatal and never escalates the rung', () => {
  assert.equal(classifyArmError('400 unknown provider for model gpt-5-4', DEFAULT_BREAKERS), 'fatal');
  assert.equal(classifyArmError('400 unrecognized_model for devin/gpt-5-4', DEFAULT_BREAKERS), 'fatal');
  const arm = (armId, model, Q) => ({ armId, model, effort: 'max', family: 'gpt', Q, C: 10, contextWindow: 1000000 });
  const ladderRungs = [
    { rung: 0, arms: [arm('gpt-5-4', 'gpt-5-4', 1)] },
    { rung: 1, arms: [arm('gpt-5-5', 'gpt-5-5', 2)] },
  ];
  const base = {
    runId: 'run-1', agentId: 'agent-1', role: 'doer', ladderRungs, pointer: 0,
    fiveHourHeadroomPct: 0.5, burnPerRunPct: { 'gpt-5-4': 0.001, 'gpt-5-5': 0.001 },
    reservePct: 0.05, accountId: 'devin:devin-lane-1',
  };
  const retry = decide({ ...base, retryCount: 1 });
  assert.equal(retry.rung, 1, 'ordinary retries still escalate');
  const unservable = decide({ ...base, retryCount: 1, failureClass: 'unservable' });
  assert.equal(unservable.kind, 'decide');
  assert.equal(unservable.rung, 0, 'unservable failures stay on the pointer rung');
});

// Shadow agreement stays true when the run reports the bare id of a prefixed
// decision: the lane routes `devin/<id>` while operators configure the bare
// id, so the match compares canonical ids, never exact strings.
test('shadow modelMatch agrees on bare actuals of prefixed decisions', async () => {
  const lane = {
    observedAt: new Date(NOW).toISOString(),
    servedModels: ['devin/gpt-5-5'],
    accounts: [{
      lane: 'devin-lane-1', provider: 'devin', accountKey: 'devin-lane-1',
      health: 'healthy', meter: 'reactive',
      models: ['devin/gpt-5-5'],
      weekly: { used: null, resetsAt: null },
      fiveHour: { used: null, resetsAt: null },
      observedAt: new Date(NOW).toISOString(), quality: 'reactive',
    }],
  };
  const rows = [
    { slug: 'gpt-5-5', intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ];
  const config = { enforce: true, cliproxy: { laneKeySecretRef: SECRET } };
  const store = new Map();
  const jobs = new Map();
  const events = new Map();
  const key = k => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { devin: ['gpt-5-5'] } }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => jobs.set(n, fn) },
    events: { on: (n, fn) => { events.set(n, fn); } },
    logger: { info() {}, error() {}, warn() {} },
  });
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
    { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  // The run reports the bare id (operator-configured); the lane routes prefixed.
  await events.get('agent.run.started')({
    type: 'agent.run.started', companyId: 'acme', entityId: 'run-bare',
    payload: { run: { agentId: 'agent-9', adapterType: 'claude-code', model: 'gpt-5-5' } },
    occurredAt: new Date(NOW).toISOString(),
  });
  await jobs.get('shadow-tick')({});
  const capacity = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' });
  const entry = capacity.body.entries.find(e => e.runId === 'run-bare');
  assert.ok(entry, 'shadow entry recorded');
  assert.equal(entry.wouldModel, 'devin/gpt-5-5(max)');
  assert.equal(entry.actualModel, 'gpt-5-5');
  assert.equal(entry.modelMatch, true);
});

// Same-family newer models dominate within one account even when the cost is
// flat: gpt-5-4 must leave the Devin ladder once gpt-5-5 scores at least as
// well at no higher cost.
test('same-family newer arm dominates on flat cost within one account', () => {
  const entries = [
    { armId: 'gpt-5-4', model: 'gpt-5-4', family: 'gpt', Q: 1, C: 10, coverage: 1 },
    { armId: 'gpt-5-5', model: 'gpt-5-5', family: 'gpt', Q: 1, C: 10, coverage: 1 },
  ];
  const { rungs, dominated } = buildLadder(entries);
  assert.ok(!rungs.some(r => r.armId === 'gpt-5-4'), 'gpt-5-4 leaves the ladder');
  assert.ok(rungs.some(r => r.armId === 'gpt-5-5'), 'gpt-5-5 stays');
  assert.ok(dominated.includes('gpt-5-4'));
});

// Context-size (`-1m`, `-256k`) and date (`-20250514`) suffixes are not
// versions: the long-context twin must not displace the standard variant on
// flat cost, and dated ids must not outrank dotted minors.
test('versionTuple ignores size and date suffixes', () => {
  assert.deepEqual(versionTuple('gpt-5-5'), [5, 5]);
  assert.deepEqual(versionTuple('claude-opus-4-6'), [4, 6]);
  assert.deepEqual(versionTuple('claude-opus-4-6-1m'), [4, 6]);
  assert.deepEqual(versionTuple('kimi-k3'), [3]);
  assert.deepEqual(versionTuple('kimi-k3-256k'), [3]);
  assert.deepEqual(versionTuple('claude-sonnet-4-20250514'), [4]);
  assert.deepEqual(versionTuple('claude-sonnet-4-5-20250929'), [4, 5]);
  const entries = [
    { armId: 'claude-opus-4-6', model: 'claude-opus-4-6', family: 'claude-4-6', Q: 1, C: 10, coverage: 1 },
    { armId: 'claude-opus-4-6-1m', model: 'claude-opus-4-6-1m', family: 'claude-4-6', Q: 1, C: 10, coverage: 1 },
  ];
  const { rungs } = buildLadder(entries);
  assert.ok(rungs.some(r => r.armId === 'claude-opus-4-6'), 'standard variant stays');
  assert.ok(rungs.some(r => r.armId === 'claude-opus-4-6-1m'), 'long-context twin stays');
});
