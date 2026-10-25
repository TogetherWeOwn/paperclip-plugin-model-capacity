import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatePriorityResourceSlots } from '../src/priority-resources.mjs';
import { allocateKeptAndRoutedCaps } from '../src/concurrency.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Independent boundary acceptance for the guarded priority-resource matcher.
// All fixtures are synthetic and offline. No timing assertions, no live I/O.
// The matcher is active only with blocking priority plus reviewer admissions:
// fractional account flow may combine inside ONE pool, while integer per-agent
// pool-count search prevents fractions in unrelated pools from funding a run.
// A fixed work counter bounds discrete search and flow regardless of backlog;
// on exhaustion only the already-proved feasible prefix is kept with
// resourceStatus 'search-limited'.

const agent = (agentId, queued = 1, allocationWeight = 1, running = 0) => ({
  agentId, queued, allocationWeight, running,
});
const rowsOf = result => [...result.kept, ...result.routed];
const totalOf = rows => rows.reduce((sum, row) => sum + row.allocated, 0);
const rowOf = (rows, id) => {
  const row = rows.find(entry => entry.agentId === id);
  assert.ok(row, `${id}: expected an allocation row`);
  return row;
};
const baseInput = (extra = {}) => ({
  target: 8,
  maxTotal: 8,
  demandFactor: 1,
  blockingPriority: true,
  agents: [agent('alpha', 1), agent('beta', 1)],
  keepAgentIds: [],
  keptByAgent: {},
  accounts: [{ accountId: 'codex:a', pool: 'codex' }],
  perAccount: [{ accountId: 'codex:a', slots: 1 }],
  pacePools: [{ pool: 'codex', cap: 1 }],
  reviewerAccountIdsByAgent: { alpha: ['codex:a'], beta: ['codex:a'] },
  ...extra,
});

test('fractional overlapping subsets require reassignment within one pool', () => {
  // Same pool: narrow can only use b+c (0.6+0.4=1 exactly) while flex can use
  // any account. A greedy grant that spends b on flex strands narrow; the
  // fractional flow must rematch flex to a. If rematching regressed to greedy
  // or per-account rounding, the total would fall below 2.
  for (const reverse of [false, true]) {
    const agents = [agent('flex'), agent('narrow')];
    if (reverse) agents.reverse();
    const spec = baseInput({
      target: 2,
      maxTotal: 2,
      agents,
      accounts: [
        { accountId: 'codex:a', pool: 'codex' },
        { accountId: 'codex:b', pool: 'codex' },
        { accountId: 'codex:c', pool: 'codex' },
      ],
      perAccount: [
        { accountId: 'codex:a', slots: 1 },
        { accountId: 'codex:b', slots: 0.6 },
        { accountId: 'codex:c', slots: 0.4 },
      ],
      pacePools: [{ pool: 'codex', cap: 2 }],
      reviewerAccountIdsByAgent: {
        flex: ['codex:a', 'codex:b', 'codex:c'],
        narrow: ['codex:b', 'codex:c'],
      },
    });
    const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
    assert.equal(totalOf(rows), 2, `reverse=${reverse}: feasible rematch must not strand capacity`);
    assert.equal(rowOf(rows, 'flex').allocated, 1);
    assert.equal(rowOf(rows, 'narrow').allocated, 1);
  }
});

test('cross-pool fractions never manufacture a run', () => {
  // Two pools each hold 0.6. Split across pools, 0.6+0.6 must NOT fund 1:
  // each agent request stays whole inside one pool. If cross-pool fractions
  // combined, this total would rise above 0.
  const spec = baseInput({
    agents: [agent('low', 8, 1), agent('high', 1, 404)],
    accounts: [
      { accountId: 'codex:a', pool: 'codex' },
      { accountId: 'claude:b', pool: 'claude' },
    ],
    perAccount: [
      { accountId: 'codex:a', slots: 0.6 },
      { accountId: 'claude:b', slots: 0.6 },
    ],
    pacePools: [{ pool: 'codex', cap: 1 }, { pool: 'claude', cap: 1 }],
    reviewerAccountIdsByAgent: {
      low: ['codex:a', 'claude:b'],
      high: ['codex:a', 'claude:b'],
    },
  });
  const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
  assert.equal(totalOf(rows), 0);
  assert.equal(rowOf(rows, 'low').allocated, 0);
  assert.equal(rowOf(rows, 'high').allocated, 0);
});

test('same-pool fractions combine to fund whole slots with weighted winner', () => {
  // Same 0.6+0.6 budget inside one pool funds exactly 1. Weighted D'Hondt
  // picks highest (queued+1)*weight/(granted+1): high (2*404=808) beats low
  // (9*1=9). If same-pool combining regressed, the total would fall to 0;
  // if weighting regressed to input order, the wrong agent would win.
  const spec = baseInput({
    agents: [agent('low', 8, 1), agent('high', 1, 404)],
    accounts: [
      { accountId: 'codex:a', pool: 'codex' },
      { accountId: 'codex:b', pool: 'codex' },
    ],
    perAccount: [
      { accountId: 'codex:a', slots: 0.6 },
      { accountId: 'codex:b', slots: 0.6 },
    ],
    pacePools: [{ pool: 'codex', cap: 1 }],
    reviewerAccountIdsByAgent: {
      low: ['codex:a', 'codex:b'],
      high: ['codex:a', 'codex:b'],
    },
  });
  const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
  assert.equal(totalOf(rows), 1);
  assert.equal(rowOf(rows, 'high').allocated, 1);
  assert.equal(rowOf(rows, 'low').allocated, 0);
});

test('mixed burn and pace gate fractional funding', () => {
  // Same pool, one paced and one burn account. Fractions combine across the
  // burn boundary, but the paced cap still gates the paced share: with the
  // paced budget at 0, a lone burn 0.6 cannot fund 1, while a burn 1.0 can.
  const shape = (pacedSlots, burnSlots, cap) => baseInput({
    target: 2,
    maxTotal: 2,
    agents: [agent('alpha'), agent('beta')],
    accounts: [
      { accountId: 'codex:paced', pool: 'codex' },
      { accountId: 'codex:burn', pool: 'codex' },
    ],
    perAccount: [
      { accountId: 'codex:paced', slots: pacedSlots },
      { accountId: 'codex:burn', slots: burnSlots },
    ],
    pacePools: [{ pool: 'codex', cap, burnAccountIds: ['codex:burn'] }],
    reviewerAccountIdsByAgent: {
      alpha: ['codex:paced', 'codex:burn'],
      beta: ['codex:paced', 'codex:burn'],
    },
  });
  const combined = rowsOf(allocateKeptAndRoutedCaps(shape(0.6, 0.6, 1)));
  assert.equal(totalOf(combined), 1, 'paced 0.6 + burn 0.6 funds 1 within one pool');
  assert.equal(rowOf(combined, 'alpha').allocated, 1);
  const gated = rowsOf(allocateKeptAndRoutedCaps(shape(0.6, 0.6, 0)));
  assert.equal(totalOf(gated), 0, 'paced cap 0 leaves only burn 0.6, which cannot fund 1');
  const exempt = rowsOf(allocateKeptAndRoutedCaps(shape(0.6, 1, 0)));
  assert.equal(totalOf(exempt), 1, 'burn 1.0 funds 1 despite paced cap 0');
});

test('multi-pool integer split funds a two-slot flexible agent', () => {
  // Flexible agent needs 2 across two pools while each restricted agent needs
  // 1 in its own pool. Pools hold 2 each, so the only feasible placement
  // splits flex 1+1. If pool counts were fractional or greedy, a 2-in-one-pool
  // placement would strand a restricted agent and the total would fall below 4.
  const spec = baseInput({
    target: 4,
    maxTotal: 4,
    agents: [agent('flex', 2), agent('sole-p0', 1), agent('sole-p1', 1)],
    accounts: [
      { accountId: 'codex:a', pool: 'codex' },
      { accountId: 'codex:b', pool: 'codex' },
      { accountId: 'claude:c', pool: 'claude' },
      { accountId: 'claude:d', pool: 'claude' },
    ],
    perAccount: [
      { accountId: 'codex:a', slots: 1 },
      { accountId: 'codex:b', slots: 1 },
      { accountId: 'claude:c', slots: 1 },
      { accountId: 'claude:d', slots: 1 },
    ],
    pacePools: [{ pool: 'codex', cap: 2 }, { pool: 'claude', cap: 2 }],
    reviewerAccountIdsByAgent: {
      flex: ['codex:a', 'codex:b', 'claude:c', 'claude:d'],
      'sole-p0': ['codex:a', 'codex:b'],
      'sole-p1': ['claude:c', 'claude:d'],
    },
  });
  const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
  assert.equal(totalOf(rows), 4);
  assert.equal(rowOf(rows, 'flex').allocated, 2);
  assert.equal(rowOf(rows, 'sole-p0').allocated, 1);
  assert.equal(rowOf(rows, 'sole-p1').allocated, 1);
});

test('multi-pool chain reallocates around flexible admissions', () => {
  // Three pools in a cycle: each agent admits two pools, each pool holds 1.
  // No agent is fixed, so the search must chain placements to reach 3. A
  // first-fit pool choice without backtracking strands one agent.
  const spec = baseInput({
    target: 3,
    maxTotal: 3,
    agents: [agent('chain-a'), agent('chain-b'), agent('chain-c')],
    accounts: [
      { accountId: 'pool-a:seat', pool: 'pool-a' },
      { accountId: 'pool-b:seat', pool: 'pool-b' },
      { accountId: 'pool-c:seat', pool: 'pool-c' },
    ],
    perAccount: [
      { accountId: 'pool-a:seat', slots: 1 },
      { accountId: 'pool-b:seat', slots: 1 },
      { accountId: 'pool-c:seat', slots: 1 },
    ],
    pacePools: [
      { pool: 'pool-a', cap: 1 },
      { pool: 'pool-b', cap: 1 },
      { pool: 'pool-c', cap: 1 },
    ],
    reviewerAccountIdsByAgent: {
      'chain-a': ['pool-a:seat', 'pool-b:seat'],
      'chain-b': ['pool-b:seat', 'pool-c:seat'],
      'chain-c': ['pool-c:seat', 'pool-a:seat'],
    },
  });
  const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
  assert.equal(totalOf(rows), 3);
  for (const id of ['chain-a', 'chain-b', 'chain-c']) {
    assert.equal(rowOf(rows, id).allocated, 1);
  }
});

test('bounded search returns a feasible prefix with search-limited status', () => {
  // Deterministic exhaustion: two agents with large useful demand against one
  // ample account. The fixed work bound must stop the discrete search with a
  // finite feasible prefix, never an overgrant and never all-or-nothing.
  const rows = [
    { agentId: 'alpha', queued: 5000, allocationWeight: 1 },
    { agentId: 'beta', queued: 5000, allocationWeight: 1 },
  ];
  const noHeadroomIds = new Set(['alpha', 'beta']);
  const admissions = new Map([['alpha', ['acct:shared']], ['beta', ['acct:shared']]]);
  const freshBudgets = () => ({
    accountPool: new Map([['acct:shared', 'shared']]),
    accountLeft: new Map([['acct:shared', 10000]]),
    poolLeft: new Map([['shared', 10000]]),
    pacedLeft: new Map([['shared', 10000]]),
    burn: new Set(),
  });
  const available = 5000;
  const first = allocatePriorityResourceSlots({
    rows, available, noHeadroomIds, admissions, ...freshBudgets(),
  });
  assert.ok(Array.isArray(first.extras));
  assert.equal(first.extras.length, rows.length);
  for (const extra of first.extras) {
    assert.ok(Number.isFinite(extra), 'finite return');
    assert.ok(Number.isInteger(extra), 'whole-slot quanta');
    assert.ok(extra >= 0);
  }
  assert.equal(first.resourceStatus, 'search-limited');
  const granted = first.extras.reduce((sum, n) => sum + n, 0);
  assert.ok(granted > 0, 'preserves already-proved grants instead of zeroing');
  assert.ok(granted < available, 'stops short of the unbounded target');
  first.extras.forEach((extra, i) => {
    assert.ok(extra <= rows[i].queued, 'never beyond useful demand');
  });
  assert.ok(granted <= 10000, 'never beyond account and pool budgets');
  assert.ok(Math.abs(first.extras[0] - first.extras[1]) <= 1, 'equal weights split evenly');
  // The kept prefix is already proved feasible: requesting exactly it again
  // reproduces the same grants without hitting the bound.
  const second = allocatePriorityResourceSlots({
    rows, available: granted, noHeadroomIds, admissions, ...freshBudgets(),
  });
  assert.deepEqual(second.extras, first.extras);
  assert.equal(second.resourceStatus, undefined);
});

test('bounded search via fleet allocator respects target and demand budgets', () => {
  const spec = baseInput({
    target: 5000,
    maxTotal: 5000,
    agents: [agent('alpha', 5000), agent('beta', 5000)],
    accounts: [{ accountId: 'codex:shared', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:shared', slots: 10000 }],
    pacePools: [{ pool: 'codex', cap: 10000 }],
    reviewerAccountIdsByAgent: { alpha: ['codex:shared'], beta: ['codex:shared'] },
  });
  const result = allocateKeptAndRoutedCaps(spec);
  assert.equal(result.resourceStatus, 'search-limited');
  const rows = rowsOf(result);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(Number.isFinite(row.allocated));
    assert.ok(Number.isInteger(row.allocated));
    assert.equal(row.maxConcurrentRuns, row.allocated);
    assert.ok(row.allocated >= row.running);
    assert.ok(row.allocated <= row.demand, 'never beyond demand');
    assert.ok(row.allocated - row.running <= row.queued, 'new slots never beyond queued');
  }
  const granted = totalOf(rows);
  assert.ok(granted > 0, 'preserves already-proved grants');
  assert.ok(granted < spec.target, 'stops short of the unbounded target');
  assert.ok(granted <= 10000, 'never beyond account and pool budgets');
  const rerun = rowsOf(allocateKeptAndRoutedCaps({ ...spec, target: granted }));
  assert.deepEqual(
    rerun.map(row => row.allocated).sort(),
    rows.map(row => row.allocated).sort(),
    'feasible prefix reproduces without the bound',
  );
  assert.equal(allocateKeptAndRoutedCaps({ ...spec, target: granted }).resourceStatus, undefined);
});

const NOW = Date.parse('2026-10-25T18:00:00Z');
const COMPANY = 'acme';
const issueRow = (id, assigneeAgentId) => ({
  id, assigneeAgentId, priority: 'low', status: 'todo', blockedBy: [],
});

async function capsBodyFor(spec) {
  const store = new Map([['capacity-v1', {
    atMs: NOW,
    target: spec.target,
    maxTotal: spec.maxTotal,
    calibration: 'measured',
    demandFactor: spec.demandFactor,
    keepAgentIds: spec.keepAgentIds,
    keptByAgent: spec.keptByAgent,
    accounts: spec.accounts,
    perAccount: spec.perAccount,
    paceGuard: { pools: spec.pacePools },
    reviewerAccountIdsByAgent: spec.reviewerAccountIdsByAgent,
    breakerUnavailableAccountIds: [],
    agentRunning: {},
  }]]);
  const reviews = Object.keys(spec.reviewerAccountIdsByAgent);
  const heartbeatIds = new Set([...spec.keepAgentIds, ...reviews]);
  const ready = spec.agents.map(entry => issueRow(`root-${entry.agentId}`, entry.agentId));
  const raw = {
    allocation: { blockingPriority: true },
    roles: {
      keepAgentIds: [...heartbeatIds],
      doerAgentIds: spec.agents.filter(entry => !heartbeatIds.has(entry.agentId)).map(entry => entry.agentId),
    },
    reviewerRouting: { agentIds: reviews, arms: [{ provider: 'codex', model: 'probe' }] },
    reviewDemand: { enabled: false },
    reviewReserve: { enabled: false },
  };
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => raw },
    state: {
      get: async key => store.get(key.stateKey) ?? null,
      set: async (key, value) => { store.set(key.stateKey, value); },
    },
    agents: {
      get: async () => null,
      getQueuedRunCounts: async () => spec.agents.filter(entry => heartbeatIds.has(entry.agentId))
        .map(entry => ({ agentId: entry.agentId, queued: entry.queued })),
    },
    issues: {
      get: async () => null,
      list: async ({ companyId, status }) => {
        assert.equal(companyId, COMPANY);
        return ready.filter(entry => entry.status === status);
      },
    },
    secrets: { resolve: async () => { throw new Error('no secret resolution expected'); } },
    http: { fetch: async () => { throw new Error('no network expected'); } },
    jobs: { register() {} },
    events: { on() {} },
    logger: { info() {}, error() {} },
  });
  await plugin.onConfigChanged(raw, { companyId: COMPANY });
  const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
  assert.equal(response.status, 200);
  assert.equal(response.body.capsError, undefined);
  return response.body;
}

test('caps telemetry reports search-limited only on exhaustion', async () => {
  const exhausted = await capsBodyFor(baseInput({
    target: 5000,
    maxTotal: 5000,
    agents: [agent('alpha', 5000), agent('beta', 5000)],
    accounts: [{ accountId: 'codex:shared', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:shared', slots: 10000 }],
    pacePools: [{ pool: 'codex', cap: 10000 }],
    reviewerAccountIdsByAgent: { alpha: ['codex:shared'], beta: ['codex:shared'] },
  }));
  assert.deepEqual(
    exhausted.allocation,
    { blockingPriority: true, resourceStatus: 'search-limited' },
  );
  const granted = totalOf(exhausted.agents);
  assert.ok(granted > 0 && granted < 5000, 'finite feasible prefix below the target');
  for (const row of exhausted.agents) {
    assert.ok(Number.isFinite(row.allocated));
    assert.ok(row.allocated <= row.queued + row.running);
  }
  const small = await capsBodyFor(baseInput({
    target: 2,
    maxTotal: 2,
    agents: [agent('alpha'), agent('beta')],
    accounts: [{ accountId: 'codex:shared', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:shared', slots: 1 }],
    pacePools: [{ pool: 'codex', cap: 1 }],
    reviewerAccountIdsByAgent: { alpha: ['codex:shared'], beta: ['codex:shared'] },
  }));
  assert.deepEqual(small.allocation, { blockingPriority: true });
  assert.equal(totalOf(small.agents), 1);
});

test('guard stays off without blocking priority or reviewer admissions', () => {
  const large = {
    target: 5000,
    maxTotal: 5000,
    agents: [agent('alpha', 5000), agent('beta', 5000)],
    accounts: [{ accountId: 'codex:shared', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:shared', slots: 10000 }],
    pacePools: [{ pool: 'codex', cap: 10000 }],
    reviewerAccountIdsByAgent: { alpha: ['codex:shared'], beta: ['codex:shared'] },
  };
  const legacy = allocateKeptAndRoutedCaps(baseInput({ ...large, blockingPriority: false }));
  assert.equal(legacy.resourceStatus, undefined);
  assert.equal(totalOf(rowsOf(legacy)), 5000, 'legacy path still serves the full target');
  const ordinary = allocateKeptAndRoutedCaps(baseInput({
    ...large,
    agents: [agent('worker-alpha', 5000), agent('worker-beta', 5000)],
    reviewerAccountIdsByAgent: {},
  }));
  assert.equal(ordinary.resourceStatus, undefined);
  assert.equal(totalOf(rowsOf(ordinary)), 5000, 'ordinary-only path never reports search limits');
});
