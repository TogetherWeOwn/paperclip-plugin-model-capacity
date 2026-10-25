import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateKeptAndRoutedCaps } from '../src/concurrency.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Independent offline acceptance. All SDK state, queues and relation rows are synthetic.
const NOW = Date.parse('2026-10-25T18:00:00Z');
const COMPANY = 'acme';
const agent = (agentId, queued = 1, allocationWeight = 1, running = 0) => ({ agentId, queued, allocationWeight, running });
const rowsOf = result => [...result.kept, ...result.routed];
const total = rows => rows.reduce((sum, row) => sum + row.allocated, 0);
const rowOf = (rows, id) => {
  const row = rows.find(row => row.agentId === id);
  assert.ok(row, `${id}: expected an allocation row`);
  return row;
};
const input = (extra = {}) => ({
  target: 8, maxTotal: 8, demandFactor: 1, blockingPriority: true,
  agents: [agent('low', 100), agent('high', 1, 404)],
  keepAgentIds: [], keptByAgent: {},
  accounts: [{ accountId: 'codex:a', pool: 'codex' }],
  perAccount: [{ accountId: 'codex:a', slots: 1 }],
  pacePools: [{ pool: 'codex', cap: 1 }],
  reviewerAccountIdsByAgent: { low: ['codex:a'], high: ['codex:a'] },
  ...extra,
});
const issue = (id, assigneeAgentId, priority = 'low') => ({
  id, assigneeAgentId, priority, status: 'todo', blockedBy: [],
});
function priorityGraph(low, high, ordinary) {
  return [issue('low-root', low), issue('critical-root', high, 'critical'),
    ...Array.from({ length: 100 }, (_, i) => ({
      ...issue(`dependent-${i}`, null), status: 'blocked', blockedBy: [{ id: 'critical-root' }],
    })), ...(ordinary ? [issue('ordinary-root', ordinary)] : [])];
}

// Exercise setup, config validation/invalidation, graph reads, heartbeat overlay,
// allocation and final API publication. Persisted capacity is an explicit SDK fixture;
// the companion restart suite instead produces its snapshot through a real tick.
async function capsFor(spec, { issues, blockingPriority = true } = {}) {
  const store = new Map([['capacity-v1', {
    atMs: NOW, target: spec.target, maxTotal: spec.maxTotal, calibration: 'measured',
    demandFactor: spec.demandFactor, keepAgentIds: spec.keepAgentIds,
    keptByAgent: spec.keptByAgent, accounts: spec.accounts, perAccount: spec.perAccount,
    paceGuard: { pools: spec.pacePools }, reviewerAccountIdsByAgent: spec.reviewerAccountIdsByAgent,
    breakerUnavailableAccountIds: spec.unavailableAccountIds ?? [],
    agentRunning: Object.fromEntries(spec.agents.filter(a => a.running > 0)
      .map(a => [a.agentId, { running: a.running }])),
  }]]);
  const reviews = Object.keys(spec.reviewerAccountIdsByAgent);
  const heartbeatIds = new Set([...spec.keepAgentIds, ...reviews]);
  const ready = issues ?? spec.agents.map(a => issue(`root-${a.agentId}`, a.agentId));
  const raw = {
    ...(blockingPriority == null ? {} : { allocation: { blockingPriority } }),
    roles: { keepAgentIds: [...heartbeatIds], doerAgentIds: spec.agents.filter(a => !heartbeatIds.has(a.agentId)).map(a => a.agentId) },
    reviewerRouting: { agentIds: reviews, arms: [{ provider: 'codex', model: 'gpt-6.1-sol' }] },
    reviewDemand: { enabled: false }, reviewReserve: { enabled: false },
  };
  const reads = [];
  let networkCalls = 0;
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => raw },
    state: {
      get: async key => store.get(key.stateKey) ?? null,
      set: async (key, value) => { store.set(key.stateKey, value); },
    },
    agents: { get: async () => null, getQueuedRunCounts: async () => spec.agents.filter(a => heartbeatIds.has(a.agentId))
      .map(a => ({ agentId: a.agentId, queued: a.queued })) },
    issues: { get: async () => null, list: async ({ companyId, status }) => {
      assert.equal(companyId, COMPANY);
      reads.push(status);
      return ready.filter(row => row.status === status);
    } },
    secrets: { resolve: async () => { throw new Error('no secret resolution expected'); } },
    http: { fetch: async () => { networkCalls++; throw new Error('no network expected'); } },
    jobs: { register() {} }, events: { on() {} }, logger: { info() {}, error() {} },
  });
  assert.deepEqual(await plugin.onValidateConfig(raw), { ok: true });
  await plugin.onConfigChanged(raw, { companyId: COMPANY });
  const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
  assert.equal(response.status, 200);
  assert.equal(response.body.capsError, undefined);
  if (blockingPriority === true) assert.deepEqual(response.body.allocation, { blockingPriority: true });
  else assert.equal(response.body.allocation, undefined);
  assert.equal(networkCalls, 0);
  return { body: response.body, reads };
}

for (const rename of [false, true]) for (const reverse of [false, true]) for (const ordinary of [false, true]) {
  const low = rename ? 'z-review' : 'a-review';
  const high = rename ? 'a-review' : 'z-review';
  const label = `rename=${rename}, reverse=${reverse}, ordinary=${ordinary}`;
  const make = () => {
    const spec = input({
      agents: [agent(low, 100), agent(high, 1, 404), ...(ordinary ? [agent('worker', 1)] : [])],
      reviewerAccountIdsByAgent: { [low]: ['codex:a'], [high]: ['codex:a'] },
      accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: 'codex:empty', pool: 'codex' }],
      perAccount: [{ accountId: 'codex:a', slots: 1 }, { accountId: 'codex:empty', slots: 0 }],
    });
    if (reverse) {
      spec.agents.reverse(); spec.accounts.reverse(); spec.perAccount.reverse();
      spec.reviewerAccountIdsByAgent = Object.fromEntries(Object.entries(spec.reviewerAccountIdsByAgent).reverse());
    }
    return spec;
  };
  const check = rows => {
    assert.equal(rowOf(rows, high).allocated, 1, 'physical shared scarcity must participate in weighted selection');
    assert.equal(rowOf(rows, low).allocated, 0);
    if (ordinary) assert.equal(rowOf(rows, 'worker').allocated, 1);
    assert.equal(total(rows), ordinary ? 2 : 1);
  };
  test(`pure scarce-account weighted winner (${label})`, () => check(rowsOf(allocateKeptAndRoutedCaps(make()))));
  test(`caps scarce-account graph-weighted winner (${label})`, async () => {
    const { body, reads } = await capsFor(make(), { issues: priorityGraph(low, high, ordinary ? 'worker' : null) });
    assert.deepEqual(rowOf(body.agents, low).allocationPriority, { cardPriority: 'low', blockingFanOut: 0, weight: 1 });
    assert.deepEqual(rowOf(body.agents, high).allocationPriority, { cardPriority: 'critical', blockingFanOut: 100, weight: 404 });
    assert.equal(rowOf(body.agents, low).queued, 100);
    assert.equal(rowOf(body.agents, high).queued, 1);
    assert.deepEqual(reads.slice().sort(), ['backlog', 'blocked', 'in_progress', 'in_review', 'todo']);
    check(body.agents);
  });
}

for (const { name, agents, slots, expected } of [
  { name: 'one-to-three shares', agents: [agent('low', 9, 1), agent('high', 9, 3)], slots: 4, expected: { low: 1, high: 3 } },
  { name: 'three distinct shares', agents: [agent('a', 4, 1), agent('b', 4, 2), agent('c', 4, 3)], slots: 6, expected: { a: 1, b: 2, c: 3 } },
  { name: 'tiny winner redistributes useful remainder', agents: [agent('low', 20), agent('high', 1, 404)], slots: 3, expected: { low: 2, high: 1 } },
  { name: 'queue size still participates in weights', agents: [agent('low', 7), agent('high', 1, 4)], slots: 4, expected: { low: 3, high: 1 } },
]) {
  test(`shared physical budget weights: ${name}`, () => {
    const rows = rowsOf(allocateKeptAndRoutedCaps(input({
      target: 16, maxTotal: 16, agents,
      reviewerAccountIdsByAgent: Object.fromEntries(agents.map(a => [a.agentId, ['codex:a']])),
      perAccount: [{ accountId: 'codex:a', slots }], pacePools: [{ pool: 'codex', cap: slots }],
    })));
    assert.deepEqual(Object.fromEntries(rows.map(a => [a.agentId, a.allocated])), expected);
    assert.equal(total(rows), slots);
  });
}

function matchingInput({ fixed = false, multiPool = false, reverse = false, reverseAccounts = false, rename = false } = {}) {
  const flex = rename ? 'z-flex' : 'a-flex';
  const restricted = rename ? 'a-restricted' : 'z-restricted';
  const b = multiPool ? 'claude:b' : 'codex:b';
  const spec = input({
    target: 2, maxTotal: 2, agents: [agent(flex), agent(restricted)],
    accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: b, pool: multiPool ? 'claude' : 'codex' }],
    perAccount: [{ accountId: 'codex:a', slots: 1 }, { accountId: b, slots: 1 }],
    pacePools: multiPool ? [{ pool: 'codex', cap: 1 }, { pool: 'claude', cap: 1 }] : [{ pool: 'codex', cap: 2 }],
    keepAgentIds: fixed ? [flex, restricted] : [],
    keptByAgent: fixed ? { [flex]: { accountId: b } } : {},
    reviewerAccountIdsByAgent: { ...(fixed ? {} : { [flex]: ['codex:a', b] }), [restricted]: ['codex:a'] },
  });
  if (reverse) spec.agents.reverse();
  if (reverseAccounts) {
    spec.accounts.reverse(); spec.perAccount.reverse(); spec.pacePools.reverse();
    for (const ids of Object.values(spec.reviewerAccountIdsByAgent)) ids.reverse();
  }
  return spec;
}
for (const fixed of [false, true]) for (const multiPool of fixed ? [false] : [false, true]) {
  for (const rename of [false, true]) for (const reverse of [false, true]) for (const reverseAccounts of [false, true]) {
    const label = `fixed=${fixed}, multiPool=${multiPool}, rename=${rename}, reverse=${reverse}, accounts=${reverseAccounts}`;
    const spec = matchingInput({ fixed, multiPool, rename, reverse, reverseAccounts });
    const check = rows => {
      assert.equal(total(rows), 2, 'a feasible two-slot assignment must not strand capacity');
      for (const a of spec.agents) assert.equal(rowOf(rows, a.agentId).allocated, 1);
    };
    test(`pure constrained matching (${label})`, () => check(rowsOf(allocateKeptAndRoutedCaps(spec))));
    test(`caps constrained matching (${label})`, async () => check((await capsFor(spec)).body.agents));
  }
}

// Independent exhaustive matching oracle for small INTEGER account budgets.
// It never imports the implementation's spend or priority helpers. The acceptance
// asks for reachability, not a particular tie-break between equally weighted rows.
function canAssign(needs, admissions, slots) {
  const pending = needs.flatMap((n, i) => Array(n).fill(i));
  const left = slots.slice();
  const visit = pos => {
    if (pos === pending.length) return true;
    for (const account of admissions[pending[pos]]) {
      if (left[account] < 1) continue;
      left[account]--;
      if (visit(pos + 1)) return true;
      left[account]++;
    }
    return false;
  };
  return visit(0);
}
function maxFeasible(admissions, slots, target) {
  let best = 0;
  for (let mask = 0; mask < 2 ** admissions.length; mask++) {
    const needs = admissions.map((_, i) => (mask >> i) & 1);
    const n = needs.reduce((sum, value) => sum + value, 0);
    if (n > best && n <= target && canAssign(needs, admissions, slots)) best = n;
  }
  return best;
}
test('feasibility oracle control: shared bottleneck, rematching, fleet bound and impossible assignments', () => {
  assert.equal(maxFeasible([[0], [0], [0]], [1, 1, 1], 3), 1);
  assert.equal(maxFeasible([[0, 1], [0, 2], [0, 2]], [1, 1, 1], 3), 3);
  assert.equal(maxFeasible([[0, 1], [0, 2], [0, 2]], [1, 1, 1], 2), 2);
  assert.equal(canAssign([1, 1, 1], [[0], [0], [0]], [1, 1, 1]), false);
  assert.equal(canAssign([1, 1, 1], [[0, 1], [0, 2], [0, 2]], [1, 1, 1]), true);
});
test('overlapping equal-size admissions leave every reachable account usable', () => {
  const spec = input({
    target: 3, maxTotal: 3, agents: [agent('a-flex'), agent('b-peer'), agent('c-peer')],
    accounts: ['a', 'b', 'c'].map(id => ({ accountId: `codex:${id}`, pool: 'codex' })),
    perAccount: ['a', 'b', 'c'].map(id => ({ accountId: `codex:${id}`, slots: 1 })),
    pacePools: [{ pool: 'codex', cap: 3 }],
    reviewerAccountIdsByAgent: { 'a-flex': ['codex:a', 'codex:b'], 'b-peer': ['codex:a', 'codex:c'], 'c-peer': ['codex:a', 'codex:c'] },
  });
  assert.equal(maxFeasible([[0, 1], [0, 2], [0, 2]], [1, 1, 1], 3), 3);
  const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
  assert.equal(total(rows), 3, 'equal admission counts do not imply interchangeable resources');
  assert.ok(rows.every(row => row.allocated === 1));
});
test('deterministic feasibility oracle: every three-reviewer admission graph over three slots', () => {
  const subsets = Array.from({ length: 7 }, (_, n) => [0, 1, 2].filter(i => ((n + 1) >> i) & 1));
  const failures = [];
  let checked = 0;
  for (const multiPool of [false, true]) for (const a of subsets) for (const b of subsets) for (const c of subsets) {
    const admissions = [a, b, c];
    const accounts = ['a', 'b', 'c'].map((id, i) => ({ accountId: `seat:${id}`, pool: multiPool ? `pool-${i}` : 'shared' }));
    const spec = input({
      target: 3, maxTotal: 3, agents: ['first', 'second', 'third'].map(id => agent(id)), accounts,
      perAccount: accounts.map(a => ({ accountId: a.accountId, slots: 1 })),
      pacePools: [...new Set(accounts.map(a => a.pool))].map(pool => ({ pool, cap: multiPool ? 1 : 3 })),
      reviewerAccountIdsByAgent: Object.fromEntries(['first', 'second', 'third']
        .map((id, i) => [id, admissions[i].map(j => accounts[j].accountId)])),
    });
    const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
    const actual = ['first', 'second', 'third'].map(id => rowOf(rows, id).allocated);
    const expected = maxFeasible(admissions, [1, 1, 1], 3);
    if (total(rows) !== expected || !canAssign(actual, admissions, [1, 1, 1])) {
      failures.push({ multiPool, admissions, actual, expected });
    }
    checked++;
  }
  assert.equal(checked, 686);
  assert.equal(failures.length, 0, `${failures.length}/${checked} feasibility mismatches: ${JSON.stringify(failures.slice(0, 8))}`);
});

for (const { name, extra, expected } of [
  { name: 'shared pace bounds both accounts once', extra: { pacePools: [{ pool: 'codex', cap: 3 }] }, expected: 3 },
  { name: 'demand factor scales account budgets', extra: { demandFactor: 0.5 }, expected: 2 },
  { name: 'burn adds only its own account budget beyond pace', extra: {
    perAccount: [{ accountId: 'codex:a', slots: 2 }, { accountId: 'codex:b', slots: 4 }],
    pacePools: [{ pool: 'codex', cap: 1, burnAccountIds: ['codex:a'] }],
  }, expected: 3 },
  { name: 'unavailable account contributes no budget', extra: { unavailableAccountIds: ['codex:a'] }, expected: 2 },
  { name: 'fleet ceiling bounds all helpers', extra: { maxTotal: 2 }, expected: 2 },
  { name: 'useful queue caps a high weight', extra: { agents: [agent('review', 1, 404)] }, expected: 1 },
]) {
  test(`budget control: ${name}`, () => {
    const spec = input({
      target: 12, maxTotal: 12, agents: [agent('review', 12, 404), agent('peer', 12)],
      accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: 'codex:b', pool: 'codex' }],
      perAccount: [{ accountId: 'codex:a', slots: 2 }, { accountId: 'codex:b', slots: 2 }],
      pacePools: [{ pool: 'codex', cap: 4 }],
      reviewerAccountIdsByAgent: { review: ['codex:a', 'codex:b'], peer: ['codex:a', 'codex:b'] }, ...extra,
    });
    const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
    assert.equal(total(rows), expected);
    for (const row of rows) {
      assert.equal(row.maxConcurrentRuns, row.allocated);
      assert.ok(row.allocated >= row.running);
      assert.ok(row.allocated - row.running <= row.queued);
    }
  });
}
for (const samePool of [false, true]) {
  test(`fraction control: ${samePool ? 'combine only within one pool' : 'never combine unrelated pools'}`, () => {
    const spec = input({
      agents: [agent('review', 8, 404), agent('peer', 8)],
      accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: 'claude:b', pool: samePool ? 'codex' : 'claude' }],
      perAccount: [{ accountId: 'codex:a', slots: 0.6 }, { accountId: 'claude:b', slots: 0.6 }],
      pacePools: samePool ? [{ pool: 'codex', cap: 1 }] : [{ pool: 'codex', cap: 1 }, { pool: 'claude', cap: 1 }],
      reviewerAccountIdsByAgent: { review: ['codex:a', 'claude:b'], peer: ['codex:a', 'claude:b'] },
    });
    assert.equal(total(rowsOf(allocateKeptAndRoutedCaps(spec))), samePool ? 1 : 0);
  });
}
test('running control: a running reviewer spends its shared account before priority grants', async () => {
  const spec = input({ agents: [agent('low', 0, 1, 1), agent('high', 2, 404)] });
  for (const rows of [rowsOf(allocateKeptAndRoutedCaps(spec)), (await capsFor(spec)).body.agents]) {
    assert.equal(rowOf(rows, 'low').allocated, 1);
    assert.equal(rowOf(rows, 'high').allocated, 0);
    assert.equal(total(rows), 1);
  }
});
test('running control: over-target running survives but grants no new work', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(input({
    target: 1, maxTotal: 2, agents: [agent('low', 100, 1, 2), agent('high', 1, 404, 1), agent('worker', 5, 2, 1)],
  })));
  assert.equal(total(rows), 4);
  for (const row of rows) assert.equal(row.allocated, row.running);
});
test('running control: unavailable helpers keep running and ordinary work uses only fleet remainder', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(input({
    target: 3, maxTotal: 3, agents: [agent('high', 20, 404, 1), agent('worker', 2)],
    unavailableAccountIds: ['codex:a'],
  })));
  assert.equal(rowOf(rows, 'high').allocated, 1);
  assert.equal(rowOf(rows, 'worker').allocated, 2);
  assert.equal(total(rows), 3);
});
test('running control: fixed serving account is charged before a restricted helper starts', () => {
  const spec = matchingInput({ fixed: true });
  spec.agents[0].running = 1;
  spec.agents[0].queued = 0;
  const rows = rowsOf(allocateKeptAndRoutedCaps(spec));
  assert.equal(total(rows), 2);
  assert.ok(rows.every(row => row.allocated === 1));
});
test('default-off control: explicit false, absent flag and absent weights are byte-equivalent legacy output', () => {
  const { blockingPriority, ...spec } = matchingInput({ fixed: true });
  const absent = allocateKeptAndRoutedCaps(spec);
  const explicit = allocateKeptAndRoutedCaps({ ...spec, blockingPriority: false });
  const weightless = allocateKeptAndRoutedCaps({ ...spec, agents: spec.agents.map(({ allocationWeight, ...a }) => a) });
  assert.deepEqual(explicit, absent);
  assert.deepEqual(weightless, absent);
  assert.equal(total(rowsOf(absent)), 2);
  assert.ok(rowsOf(absent).every(row => row.allocated === 1 && !Object.hasOwn(row, 'allocationWeight')));
});
test('caps default-off control: no priority telemetry or output change without the flag', async () => {
  const spec = matchingInput({ fixed: true });
  const absent = (await capsFor(spec, { blockingPriority: null })).body;
  const explicit = (await capsFor(spec, { blockingPriority: false })).body;
  assert.deepEqual(explicit, absent);
  assert.equal(total(absent.agents), 2);
  assert.ok(absent.agents.every(row => !Object.hasOwn(row, 'allocationPriority')));
});
