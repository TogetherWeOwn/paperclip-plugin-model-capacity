import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decide.mjs';
import { servedIdForArm, canonicalModelName } from '../src/arms.mjs';
import { classifyArmError, DEFAULT_BREAKERS } from '../src/breakers.mjs';
import { buildLadder } from '../src/ladder.mjs';
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
// prefixed emission at the helper level (codex accounts serving the bare id
// keep emitting it unchanged).
test('servedIdForArm maps bare arms to the account exact served id', () => {
  assert.equal(servedIdForArm(['devin/gpt-5-5', 'devin/gpt-5-4'], 'gpt-5-5', 'devin'), 'devin/gpt-5-5');
  assert.equal(servedIdForArm(['gpt-6-luna'], 'gpt-6-luna', 'codex'), 'gpt-6-luna');
  assert.equal(servedIdForArm(null, 'gpt-5-5', 'devin'), 'gpt-5-5');
  assert.equal(servedIdForArm(['devin/gpt-5-5'], 'gpt-6-luna', 'devin'), 'gpt-6-luna');
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
