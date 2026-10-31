import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { allocateDemandCaps } from '../src/concurrency.mjs';

const NOW = Date.parse('2026-10-21T08:00:00Z');
const COMPANY = 'acme';
const REVIEWER = 'reviewer';
const CAPACITY_KEY = {
  scopeKind: 'company', scopeId: COMPANY, namespace: 'model-capacity', stateKey: 'capacity-v1',
};
const issues = (agentId, n) => Array.from({ length: n }, (_, i) => ({
  id: `${agentId}-issue-${i}`, assigneeAgentId: agentId, status: i % 2 ? 'todo' : 'in_progress',
}));
const heartbeat = (id, overrides = {}) => ({
  id, company_id: COMPANY, agent_id: REVIEWER, status: 'queued', invocation_source: 'on_demand',
  trigger_detail: null, context_snapshot: '{}', started_at: null, finished_at: null,
  ...overrides,
});

// Exact fleet target is a persisted /capacity input, not a burn-calibration
// hypothesis. Keep this suite about /caps demand collection and distribution.
function capacity({ running = { reviewer: 1, large: 2, small: 1 }, keepAgentIds = [REVIEWER] } = {}) {
  return {
    atMs: NOW, target: 53, maxTotal: 75, calibration: 'measured', demandFactor: 1,
    agentRunning: Object.fromEntries(Object.entries(running).map(([id, n]) => [id, { running: n, overPace: false }])),
    keepAgentIds,
    keptByAgent: Object.fromEntries(keepAgentIds.map(id => [id, { accountId: 'meta:1' }])),
    accounts: [{ accountId: 'meta:1', pool: 'meta' }, { accountId: 'codex:1', pool: 'codex' }],
    perAccount: [{ accountId: 'meta:1', slots: 75 }, { accountId: 'codex:1', slots: 75 }],
    paceGuard: { pools: [{ pool: 'meta', cap: 75 }, { pool: 'codex', cap: null }] },
    breakerUnavailableAccountIds: [],
  };
}

// The SDK contract is agents.getQueuedRunCounts({ companyId }) ->
// [{ agentId, queued }], aggregated host-side. Derive the same per-agent
// queued counts from the raw run rows, applying the predicate the host
// applies in prod (queued status + same-company rows only) so the fixture
// stays honest. No real database or runtime grant is used.
function queuedCounts(runs, companyId) {
  const counts = new Map();
  for (const run of runs) {
    if (run.company_id !== companyId) continue;
    if (run.status !== 'queued') continue;
    if (typeof run.agent_id !== 'string' || run.agent_id.length === 0) continue;
    counts.set(run.agent_id, (counts.get(run.agent_id) ?? 0) + 1);
  }
  return [...counts].map(([agentId, queued]) => ({ agentId, queued }));
}

async function drive(t, {
  openIssues = [...issues(REVIEWER, 283), ...issues('large', 100), ...issues('small', 40)],
  runs = [], cap = capacity(), config = {}, failHeartbeatQuery = false, missingHeartbeatQuery = false,
} = {}) {
  void t;
  const store = new Map([[JSON.stringify(CAPACITY_KEY), cap]]);
  const queuedCalls = [];
  const io = {
    state: {
      get: async key => store.get(JSON.stringify(key)) ?? null,
      set: async (key, value) => { store.set(JSON.stringify(key), value); },
    },
    issues: { list: async ({ status }) => openIssues.filter(issue => issue.status === status) },
    jobs: { register() {} }, events: { on() {} }, logger: { info() {}, error() {} },
    agents: { getQueuedRunCounts: async ({ companyId } = {}) => {
      queuedCalls.push({ companyId });
      if (failHeartbeatQuery) throw new Error('queued-counts-host must not leak');
      return queuedCounts(runs, companyId);
    } },
  };
  if (missingHeartbeatQuery) delete io.agents;
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup(io);
  await plugin.onConfigChanged({ pacing: { holdAheadPts: null },
    roles: { keepAgentIds: cap.keepAgentIds }, ...config }, { companyId: COMPANY });
  return {
    queuedCalls,
    caps: async () => {
      const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
      assert.equal(response.status, 200);
      assert.equal(response.body.target, 53);
      return response.body;
    },
  };
}

const byId = body => new Map(body.agents.map(agent => [agent.agentId, agent]));
function assertRoutedShare(body, keptCap) {
  const actual = byId(body);
  const expected = allocateDemandCaps(53 - keptCap, [
    { agentId: 'large', running: 2, queued: 100 },
    { agentId: 'small', running: 1, queued: 40 },
  ], 53 - keptCap);
  for (const agent of expected) {
    const row = actual.get(agent.agentId);
    assert.ok(row, `${agent.agentId} has an allocation`);
    assert.equal(row.running, agent.running);
    assert.equal(row.queued, agent.queued, 'routed backlog still comes from assigned issues');
    assert.equal(row.allocated, agent.allocated, 'use existing proportional allocator on the real remainder');
    assert.equal(row.maxConcurrentRuns, row.allocated);
    assert.ok(row.allocated > row.running, 'real routed backlog is not stranded at running floors');
  }
  assert.ok(actual.get('large').allocated > actual.get('small').allocated, 'unequal backlog gets unequal shares');
  assert.equal(body.agents.reduce((sum, row) => sum + row.allocated, 0), 53, 'no stale backlog consumes or invents fleet slots');
}

test('target 53 routes its real remainder proportionally when kept demand is small', async t => {
  const d = await drive(t, { openIssues: [...issues('large', 100), ...issues('small', 40)] });
  const body = await d.caps();
  const reviewer = byId(body).get(REVIEWER);
  assert.equal(reviewer.allocated, 1, 'no kept idle headroom beyond runnable demand');
  assertRoutedShare(body, reviewer.allocated);
});

test('queued census is not truncated to the issue-subtree API newest-100 limit', async t => {
  const d = await drive(t, { runs: Array.from({ length: 121 }, (_, i) => heartbeat(`queued-${i}`)) });
  const reviewer = byId(await d.caps()).get(REVIEWER);
  assert.equal(reviewer.queued, 121);
  assert.equal(reviewer.demand, 122);
});

test('283 kept open cards with one running heartbeat do not consume target 53', async t => {
  const d = await drive(t);
  const body = await d.caps();
  const reviewer = byId(body).get(REVIEWER);
  assert.ok(reviewer);
  assert.equal(reviewer.running, 1);
  assert.equal(reviewer.queued, 0, 'assigned open cards are not queued review runs');
  assert.equal(reviewer.demand, 1);
  assert.equal(reviewer.allocated, 1, 'only runnable demand reserves kept fleet slots');
  assertRoutedShare(body, reviewer.allocated);
});

test('queued heartbeat runs add to kept demand once; running rows do not double count', async t => {
  const d = await drive(t, { runs: [
    heartbeat('queued-a'), heartbeat('queued-b'),
    heartbeat('running', { status: 'running', started_at: new Date(NOW).toISOString() }),
  ] });
  const body = await d.caps();
  const reviewer = byId(body).get(REVIEWER);
  assert.equal(reviewer.queued, 2);
  assert.equal(reviewer.running, 1);
  assert.equal(reviewer.demand, 3);
  assert.equal(reviewer.allocated, 3);
  assertRoutedShare(body, 3);
});

test('queued-only kept agent with no assigned issues is discovered', async t => {
  const d = await drive(t, {
    openIssues: [...issues('large', 100), ...issues('small', 40)],
    cap: capacity({ running: { large: 2, small: 1 } }),
    runs: [heartbeat('no-issue-run')],
  });
  const reviewer = byId(await d.caps()).get(REVIEWER);
  assert.ok(reviewer, 'queued heartbeat demand must not depend on an assigned issue or a running ledger entry');
  assert.equal(reviewer.running, 0);
  assert.equal(reviewer.queued, 1);
  assert.equal(reviewer.demand, 1);
  assert.equal(reviewer.allocated, 1);
});

test('queued eligibility is company-scoped and excludes retries and terminal statuses', async t => {
  const d = await drive(t, { runs: [
    ...['timer', 'assignment', 'on_demand', 'automation'].map(source => heartbeat(`queued-${source}`, { invocation_source: source })),
    ...['scheduled_retry', 'running', 'succeeded', 'interrupted', 'failed', 'cancelled', 'timed_out']
      .map(status => heartbeat(`not-queued-${status}`, { status })),
    heartbeat('foreign', { company_id: 'other-company' }),
    heartbeat('routed-queued', { agent_id: 'large' }),
  ] });
  const rows = byId(await d.caps());
  assert.equal(rows.get(REVIEWER).queued, 4, 'all and only actual queued heartbeat runs in this company count');
  assert.equal(rows.get(REVIEWER).demand, 5);
  assert.equal(rows.get('large').queued, 100, 'routed queued runs do not replace or inflate issue demand');
  assert.ok(d.queuedCalls.length > 0, 'supported SDK read seam was used');
  assert.ok(d.queuedCalls.every(call => call.companyId === COMPANY), 'queued census is company-scoped at the seam');
});

test('/caps carries per-agent machine-readable demandSource after allocation and smoothing', async t => {
  const d = await drive(t, { runs: [heartbeat('queued')] });
  for (let i = 0; i < 2; i++) {
    const rows = byId(await d.caps());
    assert.equal(rows.get(REVIEWER).demandSource, 'heartbeat-runs');
    assert.equal(rows.get('large').demandSource, 'issues');
    assert.equal(rows.get('small').demandSource, 'issues');
    assert.equal(rows.get(REVIEWER).demand, rows.get(REVIEWER).running + rows.get(REVIEWER).queued);
  }
});

for (const failure of ['query-denied', 'sdk-unavailable']) {
  test(`heartbeat ${failure}: no stale-issue fallback, keep running, preserve routed capacity`, async t => {
    const d = await drive(t, {
      runs: [heartbeat('unreadable')],
      failHeartbeatQuery: failure === 'query-denied', missingHeartbeatQuery: failure === 'sdk-unavailable',
    });
    const body = await d.caps();
    const rows = byId(body);
    const reviewer = rows.get(REVIEWER);
    assert.ok(reviewer, 'running kept agent remains visible even when queued demand is unknown');
    assert.equal(reviewer.running, 1);
    assert.equal(reviewer.queued, 0, 'unreadable queued demand must never fall back to assigned open cards');
    assert.equal(reviewer.allocated, reviewer.running, 'unknown queued runs grant no new kept slots');
    assert.equal(reviewer.demandSource, 'heartbeat-runs-unavailable');
    assert.equal(rows.get('large').demandSource, 'issues');
    assert.ok(!JSON.stringify(body).includes('queued-counts-host'), 'diagnostics never leak upstream query errors');
    assertRoutedShare(body, 1);
  });
}

test('routed review agents also use runnable heartbeat demand rather than review-card backlog', async t => {
  const d = await drive(t, {
    cap: capacity({ keepAgentIds: [] }),
    config: {
      reviewerRouting: { agentIds: [REVIEWER], arms: [{ provider: 'meta', model: 'muse-wonder-full-1.0-contributor' }] },
    },
    runs: [heartbeat('review-queue')],
  });
  const reviewer = byId(await d.caps()).get(REVIEWER);
  assert.equal(reviewer.queued, 1);
  assert.equal(reviewer.demand, 2);
  assert.equal(reviewer.demandSource, 'heartbeat-runs');
});

test('no kept or review agents preserves the existing routed issue-demand allocator', async t => {
  const d = await drive(t, {
    cap: capacity({ running: { large: 2, small: 1 }, keepAgentIds: [] }),
    openIssues: [...issues('large', 100), ...issues('small', 40)],
    runs: [heartbeat('irrelevant')],
  });
  const body = await d.caps();
  const expected = allocateDemandCaps(53, [
    { agentId: 'large', running: 2, queued: 100 }, { agentId: 'small', running: 1, queued: 40 },
  ], 75);
  const rows = byId(body);
  for (const agent of expected) {
    assert.equal(rows.get(agent.agentId).allocated, agent.allocated);
    assert.equal(rows.get(agent.agentId).queued, agent.queued);
  }
  assert.equal(body.agents.length, 2);
});
