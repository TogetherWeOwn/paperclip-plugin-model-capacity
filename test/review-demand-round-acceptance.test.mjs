import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { createReviewDemandReader, eligibleReviewHead, normalizeReviewDemand } from '../src/review-demand.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// Independent acceptance: all IO, readiness and calibration traffic is synthetic.
// No live HTTP, credentials, SDK installation or production state is involved.
const T0 = Date.parse('2026-10-25T08:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const REF = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555', version: 1 };
const CHECKS = ['ci-ok', 'pr-lint'];
const SONNET = 'claude-sonnet-5-5';
const WONDER = 'muse-wonder-full-1.0-contributor';
const source = () => ({ repositories: ['example/product'], tokenSecretRef: { ...REF }, requiredChecks: CHECKS });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const check = name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
function pull(number) {
  const oid = number.toString(16).padStart(40, '0');
  return { number, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: {
      contexts: { nodes: CHECKS.map(check), pageInfo: { hasNextPage: false } },
    } } }] } };
}
const page = nodes => ({ data: { repository: { pullRequests: {
  nodes, pageInfo: { hasNextPage: false, endCursor: null },
} } } });
const response = nodes => ({ status: 200, text: async () => JSON.stringify(page(nodes)) });
const routedConfig = (ids = ['reviewer']) => ({
  roles: { keepAgentIds: ids }, reviewReserve: { enabled: false },
  reviewerRouting: { agentIds: ids, arms: [{ provider: 'codex', model: 'gpt-6.1-sol' }] },
  reviewDemand: source(),
});
function admissionSnapshot(ids = ['reviewer']) {
  return { atMs: T0, target: 8, maxTotal: 8, calibration: 'measured', demandFactor: 1,
    agentRunning: {}, keepAgentIds: ids,
    keptByAgent: Object.fromEntries(ids.map(id => [id, { accountId: 'meta:a' }])),
    reviewerAccountIdsByAgent: Object.fromEntries(ids.map(id => [id, ['codex:a']])),
    accounts: [{ accountId: 'meta:a', pool: 'meta' }, { accountId: 'codex:a', pool: 'codex' },
      { accountId: 'codex:empty', pool: 'codex' }],
    perAccount: [{ accountId: 'meta:a', slots: 0 }, { accountId: 'codex:a', slots: 8 },
      { accountId: 'codex:empty', slots: 0 }],
    paceGuard: { pools: [{ pool: 'meta', cap: 0 }, { pool: 'codex', cap: 8 }] } };
}
async function capsFixture({ cap = admissionSnapshot(), raw = routedConfig(), heads = 0,
  heartbeats = [], holdGate = null } = {}) {
  const store = new Map([['capacity-v1', cap]]);
  const calls = [];
  const holdReached = deferred();
  const plugin = createModelCapacityPlugin({ clock: () => T0, requirePinnedLaneHost: false });
  await plugin.setup({
    state: { get: async k => {
      if (k.stateKey === 'caps-hold-v1' && holdGate) {
        holdReached.resolve();
        await holdGate.promise;
      }
      return store.get(k.stateKey) ?? null;
    }, set: async (k, v) => { store.set(k.stateKey, v); } },
    issues: { list: async () => [] },
    agents: { getQueuedRunCounts: async () => heartbeats },
    jobs: { register() {} }, events: { on() {} }, logger: { info() {}, error() {} },
    secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async (url, init) => {
      assert.equal(url, 'https://api.github.com/graphql');
      calls.push(JSON.parse(init.body).variables);
      return response(Array.from({ length: heads }, (_, i) => pull(i + 1)));
    } },
  });
  await plugin.onConfigChanged(raw, { companyId: 'acme' });
  return { calls, holdReached, plugin, raw, store,
    read: async () => {
      const result = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'caps' });
      assert.equal(result.status, 200);
      return result.body;
    } };
}
const rowOf = (body, id) => body.agents.find(a => a.agentId === id);

// A real tick produces the target and admission map: no capacity-v1 injection.
async function tickFixture() {
  let now = T0;
  let step = 0;
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const calls = [];
  const errors = [];
  const raw = {
    cliproxy: { laneKeySecretRef: REF }, reviewReserve: { enabled: false },
    roles: { keepAgentIds: ['reviewer'], doerAgentIds: ['eng'],
      minQuality: { doer: null, thinker: null, other: null }, outcomeGate: { enabled: false } },
    reviewer: { providers: ['claude', 'meta'] },
    reviewerRouting: { agentIds: ['reviewer'], arms: [
      { provider: 'meta', model: WONDER, effort: 'max' },
      { provider: 'claude', model: SONNET, effort: 'high' },
    ] },
    reviewDemand: source(),
  };
  const lane = (provider, accountKey, models, used) => ({
    lane: `${provider}-${accountKey}`, provider, accountKey, health: 'healthy', models,
    weekly: { used, resetsAt: new Date(T0 + 24 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(now + 4 * HOUR).toISOString() },
    observedAt: new Date(now).toISOString(), quality: 'live',
  });
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => raw },
    state: { get: async k => store.get(k.stateKey) ?? null,
      set: async (k, v) => { store.set(k.stateKey, v); } },
    secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async (url, init) => {
      if (url === 'https://api.github.com/graphql') {
        calls.push(JSON.parse(init.body).variables);
        return response(Array.from({ length: 80 }, (_, i) => pull(i + 1)));
      }
      assert.match(url, /\/telemetry\/cliproxy\/live\/accounts\.json$/);
      return { status: 200, json: async () => withSyntheticReadiness({
        observedAt: new Date(now).toISOString(), accounts: [
          lane('claude', 'a', [SONNET], 0.2 + step * 0.01),
          lane('claude', 'b', [SONNET], 0.2 + step * 0.01),
          // A healthy live lane does not imply admission for the selected arm.
          lane('claude', 'unserved', ['claude-haiku-5-5'], 0.2 + step * 0.01),
          lane('meta', 'spent', [WONDER], 1),
        ],
      }, now) };
    } },
    agents: { get: async () => ({ adapterType: 'claude-code' }), getQueuedRunCounts: async () => [] },
    issues: { get: async () => null, list: async ({ status }) => status === 'todo'
      ? [{ id: 'one-doer-card', assigneeAgentId: 'eng', status: 'todo' }] : [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { handlers.set(name, fn); } },
    logger: { info() {}, error: (...args) => { errors.push(args); } },
  });
  store.set('aa-snapshot-v1', { fetchedAt: new Date(T0).toISOString(), duplicateSlugs: [], rows: [
    { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
    { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
    { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ] });
  await plugin.onConfigChanged(raw, { companyId: 'acme' });
  for (step = 0; step < 3; step++) {
    now = T0 + step * 12 * MIN;
    if (step > 0) for (let i = 0; i < 12; i++) {
      const runId = `measured-${step}-${i}`;
      const at = now - (12 - i) * MIN;
      for (const [type, delay] of [['agent.run.started', 0], ['agent.run.finished', 1000]]) {
        await handlers.get(type)({ type, companyId: 'acme', entityId: runId,
          payload: { run: { agentId: 'eng', model: SONNET, provider: 'claude' } },
          occurredAt: new Date(at + delay).toISOString() });
      }
    }
    try {
      await jobs.get('quota-refresh')({ companyId: 'acme' });
    } catch (error) {
      throw new Error(`synthetic tick ${step}: ${JSON.stringify(errors)}`, { cause: error });
    }
  }
  const api = async routeKey => (await plugin.onApiRequest({ companyId: 'acme', routeKey })).body;
  return { api, store, calls };
}

test('round acceptance: real tick sizes 80 heads beyond a single queued doer card', async t => {
  const d = await tickFixture();
  const cap = await d.api('capacity');
  const helpers = cap.perAccount.filter(a => ['claude:a', 'claude:b'].includes(a.accountId));
  assert.equal(helpers.length, 2);
  assert.ok(helpers.every(a => a.calibrated && a.measuredBurnPerRunPct > 0), JSON.stringify(helpers));
  const slots = helpers.reduce((n, a) => n + a.slots, 0);
  assert.ok(slots >= 4, `measured helper slots ${slots}`);
  assert.equal(cap.perAccount.find(a => a.accountId === 'meta:spent').slots, 0);
  assert.deepEqual(cap.agentRunning, {}, 'calibration runs finished; running cannot inflate the bound');
  const body = await d.api('caps');
  t.diagnostic(JSON.stringify({ helperSlots: slots, target: cap.target, demandBound: cap.demandBound,
    reviewer: rowOf(body, 'reviewer'), censusCalls: d.calls.length }));
  assert.ok(cap.target >= 4, `computed target ${cap.target} must see review demand, not only one issue`);
  assert.equal(body.target, cap.target);
  assert.equal(body.reviewDemand.eligibleHeads, 80);
  assert.equal(rowOf(body, 'reviewer')?.reviewEligibleHeads, 80);
  assert.ok(rowOf(body, 'reviewer')?.maxConcurrentRuns >= 4, JSON.stringify(body));
});

test('round acceptance: real tick publishes only actually admitted helper accounts', async () => {
  const d = await tickFixture();
  const cap = await d.api('capacity');
  assert.ok(cap.accounts.some(a => a.accountId === 'claude:unserved'), 'refused account is live, not absent');
  assert.deepEqual([...cap.reviewerAccountIdsByAgent.reviewer].sort(), ['claude:a', 'claude:b']);
});

for (const blockedAdmission of [[], ['codex:empty']]) {
  test(`round acceptance: one head reaches funded peer instead of ${JSON.stringify(blockedAdmission)}`, async () => {
    const ids = ['a-blocked', 'b-admitted'];
    const cap = admissionSnapshot(ids);
    cap.reviewerAccountIdsByAgent['a-blocked'] = blockedAdmission;
    const d = await capsFixture({ cap, raw: routedConfig(ids), heads: 1 });
    const body = await d.read();
    assert.equal(body.reviewDemand.eligibleHeads, 1);
    assert.equal(rowOf(body, 'b-admitted')?.reviewEligibleHeads, 1);
    assert.equal(rowOf(body, 'b-admitted')?.maxConcurrentRuns, 1);
    assert.equal(rowOf(body, 'a-blocked')?.reviewEligibleHeads ?? 0, 0);
    assert.equal(body.agents.reduce((n, a) => n + (a.reviewEligibleHeads ?? 0), 0), 1);
  });
}

test('round acceptance: empty admission preserves a blocked reviewer running floor', async () => {
  const ids = ['a-blocked', 'b-admitted'];
  const cap = admissionSnapshot(ids);
  cap.agentRunning = { 'a-blocked': { running: 2 } };
  cap.reviewerAccountIdsByAgent['a-blocked'] = [];
  const d = await capsFixture({ cap, raw: routedConfig(ids), heads: 3 });
  assert.equal(rowOf(await d.read(), 'a-blocked')?.maxConcurrentRuns, 2);
});

for (const routing of [undefined, { enabled: false, agentIds: ['reviewer'], arms: [{ provider: 'codex', model: 'gpt-6.1-sol' }] }]) {
  test(`round acceptance: fixed reserved reviewer counts ten heads with routing ${routing ? 'disabled' : 'absent'}`, async () => {
    const cap = admissionSnapshot();
    delete cap.reviewerAccountIdsByAgent;
    cap.keptByAgent.reviewer = { accountId: 'meta:a' };
    cap.perAccount[0].slots = 3;
    cap.paceGuard.pools[0].cap = 3;
    const raw = { roles: { keepAgentIds: ['reviewer'] }, reviewReserve: { agentIds: ['reviewer'], providers: ['meta'] },
      reviewDemand: source(), ...(routing ? { reviewerRouting: routing } : {}) };
    const d = await capsFixture({ cap, raw, heads: 10 });
    const body = await d.read();
    assert.equal(d.calls.length, 1, 'fixed reviewers need the source even without routing');
    assert.equal(body.reviewDemand.eligibleHeads, 10);
    assert.equal(rowOf(body, 'reviewer')?.reviewEligibleHeads, 10);
    assert.equal(rowOf(body, 'reviewer')?.maxConcurrentRuns, 3, 'fixed pool only; eight helper slots cannot be borrowed');
  });
}

for (const change of ['disable', 'repository', 're-enable']) {
  test(`round acceptance: ${change} after resolved census cannot publish stale caps`, async () => {
    const gate = deferred();
    const d = await capsFixture({ heads: 8, holdGate: gate });
    const pending = d.read();
    await d.holdReached.promise;
    assert.equal(d.calls.length, 1, 'census has resolved and allocation reached caps-hold-v1');
    try {
      if (change === 'repository') {
        await d.plugin.onConfigChanged({ ...d.raw, reviewDemand: { ...source(), repositories: ['example/replacement'] } }, { companyId: 'acme' });
      } else {
        await d.plugin.onConfigChanged({ ...d.raw, reviewDemand: { enabled: false } }, { companyId: 'acme' });
        if (change === 're-enable') await d.plugin.onConfigChanged(d.raw, { companyId: 'acme' });
      }
    } finally {
      gate.resolve();
    }
    const body = await pending;
    assert.equal(body.reviewDemand?.eligibleHeads ?? 0, 0, 'resolved old-generation count must not escape');
    assert.equal(body.agents.reduce((n, a) => n + Math.max(0, a.maxConcurrentRuns - a.running), 0), 0,
      'invalidation must revoke already-computed grants too');
  });
}

for (const age of [120_001, -60_000]) {
  test(`round acceptance: admission age ${age} blocks positive heartbeat grants without census`, async () => {
    const cap = admissionSnapshot();
    cap.atMs = T0 - age;
    cap.agentRunning = { reviewer: { running: 2 } };
    const raw = { ...routedConfig(), reviewDemand: { enabled: false } };
    const d = await capsFixture({ cap, raw, heartbeats: [{ agentId: 'reviewer', queued: 7 }] });
    const body = await d.read();
    const row = rowOf(body, 'reviewer');
    assert.equal(row?.queued, 7, 'positive heartbeat demand must reach allocator freshness guard');
    assert.equal(row?.maxConcurrentRuns, 2);
    assert.equal(d.calls.length, 0, 'this is independent of the census staleness gate');
  });
}

test('round acceptance: idle reviewer is discovered from positive heads alone', async () => {
  const d = await capsFixture({ heads: 1 });
  const body = await d.read();
  assert.equal(rowOf(body, 'reviewer')?.running, 0);
  assert.equal(rowOf(body, 'reviewer')?.heartbeatQueued, 0);
  assert.equal(rowOf(body, 'reviewer')?.reviewEligibleHeads, 1);
  assert.equal(rowOf(body, 'reviewer')?.maxConcurrentRuns, 1);
});

test('round acceptance: three shared heads split exactly two and one across admitted idle reviewers', async () => {
  const ids = ['a-reviewer', 'b-reviewer'];
  const d = await capsFixture({ cap: admissionSnapshot(ids), raw: routedConfig(ids), heads: 3 });
  const body = await d.read();
  assert.deepEqual(ids.map(id => rowOf(body, id)?.reviewEligibleHeads), [2, 1]);
  assert.deepEqual(ids.map(id => rowOf(body, id)?.maxConcurrentRuns), [2, 1]);
  assert.equal(body.agents.reduce((n, a) => n + a.reviewEligibleHeads, 0), 3);
});

function ambiguousPull() {
  const p = pull(1);
  // First commit is fully qualifying; only cardinality makes this invalid.
  p.commits.nodes.push(pull(2).commits.nodes[0]);
  return p;
}

test('round acceptance: extra commit invalidates an otherwise matching green first head', () => {
  assert.equal(eligibleReviewHead(pull(1), CHECKS), true, 'positive control');
  assert.equal(eligibleReviewHead(ambiguousPull(), CHECKS), false);
});

test('round acceptance: reader counts zero for a multi-commit evidence response', async () => {
  const read = createReviewDemandReader({ clock: () => T0 });
  let calls = 0;
  const result = await read({ secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async () => { calls++; return response([ambiguousPull()]); } } }, 'acme', normalizeReviewDemand(source()));
  assert.equal(calls, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.eligibleHeads, 0);
});
