import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateDemandCaps, allocateKeptAndRoutedCaps } from '../src/concurrency.mjs';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';

const COMPANY = 'acme';
const NOW = Date.parse('2026-10-25T12:00:00Z');
const issue = (id, agentId, overrides = {}) => ({
  id, assigneeAgentId: agentId, status: 'todo', priority: 'medium', blockedBy: [], ...overrides,
});
const chain = () => [
  issue('repair', 'operator'),
  issue('design', 'designer', { status: 'blocked', blockedBy: [{ id: 'repair' }] }),
  issue('build', 'builder', { status: 'blocked', blockedBy: [{ id: 'design' }] }),
  ...Array.from({ length: 4 }, (_, i) => issue(`ordinary-${i}`, 'worker')),
];
const asMap = rows => new Map(rows.map(row => [row.agentId, row]));
const total = rows => rows.reduce((sum, row) => sum + row.allocated, 0);

async function drive({ issues = chain(), config = {}, target = 1, running = {}, maxTotal = 75,
  failStatus = null, hold = {}, kept = [], queuedCounts = [],
} = {}) {
  let now = NOW;
  const cap = {
    atMs: NOW, calibration: 'measured', target, maxTotal,
    agentRunning: Object.fromEntries(Object.entries(running).map(([id, n]) => [id, { running: n }])),
    keepAgentIds: kept,
    keptByAgent: Object.fromEntries(kept.map(id => [id, { accountId: 'pool:1' }])),
    accounts: [{ accountId: 'pool:1', pool: 'paid' }],
    perAccount: [{ accountId: 'pool:1', slots: 75 }],
  };
  const store = new Map([
    ['capacity-v1', cap], ['caps-hold-v1', { agents: hold }],
  ]);
  const reads = [];
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    state: {
      get: async key => store.get(key.stateKey) ?? null,
      set: async (key, value) => { store.set(key.stateKey, value); },
    },
    issues: { list: async ({ companyId, status }) => {
      assert.equal(companyId, COMPANY);
      reads.push(status);
      if (status === failStatus) throw new Error('private upstream error');
      return issues.filter(row => !status || row.status === status);
    } },
    agents: { getQueuedRunCounts: async () => queuedCounts },
    jobs: { register() {} }, events: { on() {} }, logger: { info() {}, error() {} },
  });
  await plugin.onConfigChanged(config, { companyId: COMPANY });
  return {
    reads, cap, store,
    configure: config => plugin.onConfigChanged(config, { companyId: COMPANY }),
    advance: ms => { now += ms; },
    caps: async () => {
      const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
      assert.equal(response.status, 200);
      return response.body;
    },
  };
}
const enabled = { allocation: { blockingPriority: true } };

test('blocking priority is strictly opt-in in config and manifest', () => {
  assert.equal(resolveConfig({}).allocation.blockingPriority, false);
  assert.equal(resolveConfig(enabled).allocation.blockingPriority, true);
  assert.equal(manifest.instanceConfigSchema.properties.allocation.properties.blockingPriority.default, false);
  assert.deepEqual(validateConfigShape(enabled), []);
  for (const allocation of [true, [], { blockingPriority: 'true' }, { unknown: true }]) {
    assert.ok(validateConfigShape({ allocation }).length > 0);
  }
  assert.ok(!manifest.capabilities.includes('issue.relations.read'));
});

test('flag off produces byte-identical caps and makes no extra issue reads', async () => {
  const before = await drive();
  const off = await drive({ config: { allocation: { blockingPriority: false } } });
  assert.equal(JSON.stringify(await off.caps()), JSON.stringify(await before.caps()));
  assert.deepEqual(off.reads.sort(), ['in_progress', 'todo']);
  assert.ok(!Object.hasOwn(await off.caps(), 'allocation'));
});

test('allocator ignores priority weights unless explicitly enabled', () => {
  const agents = [
    { agentId: 'worker', running: 2, queued: 5, allocationWeight: 1 },
    { agentId: 'operator', running: 0, queued: 1, allocationWeight: 100 },
  ];
  assert.deepEqual(allocateDemandCaps(3, agents), allocateDemandCaps(3,
    agents.map(({ allocationWeight, ...agent }) => agent)));
  assert.deepEqual(allocateDemandCaps(3, agents, 75, { blockingPriority: false }),
    allocateDemandCaps(3, agents));
});

test('transitive blockers win the first scarce slot despite a larger ordinary queue', async () => {
  const d = await drive({ config: enabled });
  const body = await d.caps();
  const rows = asMap(body.agents);
  assert.equal(rows.get('operator').allocated, 1);
  assert.equal(rows.get('worker').allocated, 0);
  assert.equal(total(body.agents), 1);
  assert.equal(body.allocation.blockingPriority, true);
  assert.equal(rows.get('operator').allocationPriority.blockingFanOut, 2);
});

test('critical > high > medium > low with equal demand and fan-out', async () => {
  for (const [higher, lower] of [['critical', 'high'], ['high', 'medium'], ['medium', 'low']]) {
    const d = await drive({ config: enabled, issues: [
      issue('a', 'a-lower', { priority: lower }), issue('z', 'z-higher', { priority: higher }),
    ] });
    const body = await d.caps();
    assert.equal(asMap(body.agents).get('z-higher').allocated, 1);
    assert.equal(asMap(body.agents).get('a-lower').allocated, 0);
    assert.equal(total(body.agents), 1);
  }
});

test('fan-out counts unique open descendants, not duplicate paths, terminal cards or cycles', async () => {
  const d = await drive({ config: enabled, issues: [
    issue('root', 'operator', { blockedBy: [{ id: 'leaf' }] }),
    issue('left', null, { status: 'blocked', blockedBy: [{ id: 'root' }, { id: 'root' }] }),
    issue('right', null, { status: 'in_review', blockedBy: [{ id: 'root' }] }),
    issue('leaf', null, { status: 'backlog', blockedBy: [{ id: 'left' }, { id: 'right' }] }),
    issue('done', null, { status: 'done', blockedBy: [{ id: 'root' }] }),
    issue('cancelled', null, { status: 'cancelled', blockedBy: [{ id: 'root' }] }),
  ] });
  const root = asMap((await d.caps()).agents).get('operator');
  assert.equal(root.allocationPriority.blockingFanOut, 3);
});

test('fan-out is capped at 100 and uses the highest runnable card priority', async () => {
  const d = await drive({ config: enabled, issues: [
    issue('root', 'operator', { priority: 'low' }),
    issue('other-root', 'operator', { status: 'in_progress', priority: 'critical' }),
    ...Array.from({ length: 130 }, (_, i) => issue(`blocked-${i}`, null,
      { status: 'blocked', blockedBy: [{ id: 'root' }] })),
  ] });
  const row = asMap((await d.caps()).agents).get('operator');
  assert.deepEqual(row.allocationPriority, { blockingFanOut: 100, cardPriority: 'critical', weight: 404 });
});

test('native blocks-only snapshots are also supported', async () => {
  const issues = [
    { id: 'root', status: 'todo', priority: 'medium', assigneeAgentId: 'operator', blocks: [{ id: 'child' }] },
    { id: 'child', status: 'blocked', blocks: [], assigneeAgentId: null },
  ];
  const d = await drive({ config: enabled, issues });
  assert.equal(asMap((await d.caps()).agents).get('operator').allocationPriority.blockingFanOut, 1);
});

test('priority reads, including failures, are memoized for one capacity tick', async () => {
  for (const failStatus of [null, 'blocked']) {
    const d = await drive({ config: enabled, failStatus });
    await d.caps();
    const first = d.reads.filter(s => s === 'blocked').length;
    assert.equal(first, 1);
    d.advance(30000); // Outlive the ordinary 20s demand memo, but not the capacity tick.
    await d.caps();
    assert.equal(d.reads.filter(s => s === 'blocked').length, first);
    d.cap.atMs += 60000;
    await d.caps();
    assert.equal(d.reads.filter(s => s === 'blocked').length, first + 1);
  }
});

test('same-tick demand and weights share one ready-card snapshot beyond the ordinary TTL', async () => {
  const issues = chain();
  const d = await drive({ issues, config: enabled });
  const first = await d.caps();
  issues[0] = { ...issues[0], assigneeAgentId: 'replacement' };
  d.advance(30000);
  const second = await d.caps();
  assert.deepEqual(second.agents, first.agents);
  for (const status of ['todo', 'in_progress', 'backlog', 'in_review', 'blocked']) {
    assert.equal(d.reads.filter(read => read === status).length, 1);
  }
});

test('a new tick refreshes ready cards even inside the ordinary demand TTL', async () => {
  const issues = chain();
  const d = await drive({ issues, config: enabled });
  await d.caps();
  issues[0] = { ...issues[0], assigneeAgentId: 'replacement' };
  d.advance(5000);
  d.cap.atMs += 5000;
  const rows = asMap((await d.caps()).agents);
  assert.equal(rows.has('operator'), false);
  assert.equal(rows.get('replacement').allocated, 1);
  assert.equal(rows.get('replacement').allocationPriority.blockingFanOut, 2);
});

test('priority read failure falls back to exact legacy allocations without leaking errors', async () => {
  const legacy = await drive();
  const d = await drive({ config: enabled, failStatus: 'blocked' });
  const body = await d.caps();
  assert.deepEqual(body.agents, (await legacy.caps()).agents);
  assert.equal(body.allocation.blockingPriority, false);
  assert.equal(body.allocation.error, 'priority-unavailable');
  assert.ok(!JSON.stringify(body).includes('private upstream error'));
});

test('unavailable priority metadata retains ordinary demand refreshes within the tick', async () => {
  const issues = chain();
  const legacy = await drive({ issues });
  const d = await drive({ issues, config: enabled, failStatus: 'blocked' });
  await legacy.caps();
  await d.caps();
  issues[0] = { ...issues[0], assigneeAgentId: 'replacement' };
  legacy.advance(30000);
  d.advance(30000);
  assert.deepEqual((await d.caps()).agents, (await legacy.caps()).agents);
  assert.equal(d.reads.filter(status => status === 'blocked').length, 1);
});

test('unavailable metadata also preserves the legacy TTL across a new capacity tick', async () => {
  const issues = chain();
  const legacy = await drive({ issues });
  const d = await drive({ issues, config: enabled, failStatus: 'blocked' });
  await legacy.caps();
  await d.caps();
  issues[0] = { ...issues[0], assigneeAgentId: 'replacement' };
  legacy.advance(5000);
  d.advance(5000);
  legacy.cap.atMs += 5000;
  d.cap.atMs += 5000;
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await d.caps()).agents, (await legacy.caps()).agents);
  }
});

test('SDK payloads without relation arrays degrade instead of pretending there are no blockers', async () => {
  const issues = chain().map(({ blockedBy, ...row }) => row);
  const legacy = await drive({ issues });
  const d = await drive({ issues, config: enabled });
  const body = await d.caps();
  assert.deepEqual(body.agents, (await legacy.caps()).agents);
  assert.equal(body.allocation.blockingPriority, false);
  assert.equal(body.allocation.error, 'priority-unavailable');
});

test('empty issue snapshots cannot establish native relation support', async () => {
  const options = { issues: [], queuedCounts: [{ agentId: 'worker', queued: 4 }] };
  const config = { reviewerRouting: { agentIds: ['worker'], arms: [{ provider: 'paid', model: 'test-model' }] } };
  const legacy = await drive({ ...options, config });
  const d = await drive({ ...options, config: { ...config, ...enabled } });
  const body = await d.caps();
  assert.deepEqual(body.agents, (await legacy.caps()).agents);
  assert.deepEqual(body.allocation, { blockingPriority: false, error: 'priority-unavailable' });
});

test('malformed native relation entries fall back rather than silently losing edges', async () => {
  for (const relation of ['root', null, {}, { id: 42 }, { id: '' }]) {
    const issues = [issue('root', 'operator'), issue('child', null, { status: 'blocked', blockedBy: [relation] })];
    const legacy = await drive({ issues });
    const d = await drive({ issues, config: enabled });
    const body = await d.caps();
    assert.deepEqual(body.agents, (await legacy.caps()).agents);
    assert.deepEqual(body.allocation, { blockingPriority: false, error: 'priority-unavailable' });
  }
});

test('contradictory complete relation directions fall back; consistent directions remain usable', async () => {
  for (const consistent of [false, true]) {
    const d = await drive({ config: enabled, issues: [
      issue('root', 'operator', { blocks: [{ id: 'child' }] }),
      issue('child', null, { status: 'blocked', blockedBy: consistent ? [{ id: 'root' }] : [], blocks: [] }),
    ] });
    const body = await d.caps();
    assert.equal(body.allocation.blockingPriority, consistent);
    if (consistent) assert.equal(asMap(body.agents).get('operator').allocationPriority.blockingFanOut, 1);
    else assert.equal(body.allocation.error, 'priority-unavailable');
  }
});

test('failure of the existing demand read preserves the existing safe error response', async () => {
  const d = await drive({ config: enabled, failStatus: 'todo' });
  const body = await d.caps();
  assert.deepEqual(body.agents, []);
  assert.equal(body.capsError, 'issues-unavailable');
});

test('priority mode preserves running and never grants beyond target or ceiling', () => {
  for (const target of [0, 0.9, 1, 2, 5, 12, 30, 100]) {
    for (const maxTotal of [1, 3, 10, 75]) {
      const agents = [
        { agentId: 'operator', running: 2, queued: 20, allocationWeight: 404 },
        { agentId: 'worker', running: 1, queued: 50, allocationWeight: 1 },
      ];
      const rows = allocateDemandCaps(target, agents, maxTotal, { blockingPriority: true });
      assert.ok(total(rows) <= Math.max(3, Math.min(Math.round(target), maxTotal)), `${target}/${maxTotal}`);
      for (const row of rows) assert.ok(row.allocated >= row.running);
    }
  }
});

test('idle routed headroom does not amplify stale ready-card priority over real queued work', () => {
  const rows = allocateDemandCaps(2, [
    { agentId: 'idle-reviewer', running: 1, queued: 0, allocationWeight: 404 },
    { agentId: 'worker', running: 0, queued: 5, allocationWeight: 1 },
  ], 75, { blockingPriority: true });
  assert.equal(asMap(rows).get('idle-reviewer').allocated, 1);
  assert.equal(asMap(rows).get('worker').allocated, 1);
});

test('priority shares stop at useful demand and redistribute to waiting agents', () => {
  const rows = allocateDemandCaps(10, [
    { agentId: 'blocker', running: 0, queued: 1, allocationWeight: 404 },
    { agentId: 'worker', running: 0, queued: 100, allocationWeight: 1 },
  ], 75, { blockingPriority: true });
  assert.equal(asMap(rows).get('blocker').allocated, 1);
  assert.equal(asMap(rows).get('worker').allocated, 9);
  assert.equal(total(rows), 10);
});

test('saturated kept pools release slots to other kept pools before leaving capacity idle', () => {
  for (const smallSlots of [0, 1]) {
    const result = allocateKeptAndRoutedCaps({
      target: 2, maxTotal: 75, blockingPriority: true,
      agents: [
        { agentId: 'blocker', running: 0, queued: 10, allocationWeight: 404 },
        { agentId: 'worker', running: 0, queued: 10, allocationWeight: 1 },
      ],
      keepAgentIds: ['blocker', 'worker'],
      keptByAgent: { blocker: { accountId: 'small' }, worker: { accountId: 'large' } },
      accounts: [{ accountId: 'small', pool: 'small' }, { accountId: 'large', pool: 'large' }],
      perAccount: [{ accountId: 'small', slots: smallSlots }, { accountId: 'large', slots: 10 }],
    });
    assert.equal(asMap(result.kept).get('blocker').allocated, smallSlots);
    assert.equal(asMap(result.kept).get('worker').allocated, 2 - smallSlots);
    assert.equal(total([...result.kept, ...result.routed]), 2);
  }
});

test('running counts above the target are preserved with no new slots', async () => {
  const d = await drive({ config: enabled, running: { operator: 3, worker: 9 }, target: 0.9 });
  const body = await d.caps();
  assert.equal(total(body.agents), 12);
  assert.ok(body.agents.every(row => row.allocated === row.running));
});

test('priority survives cap smoothing and reports conflicting reserved floors as blocked', async () => {
  const d = await drive({
    config: { ...enabled, caps: { reservedFloors: { worker: { base: 8, perQueued: 20, max: 8 } } } },
    hold: { worker: { value: 50, atMs: NOW } },
  });
  const body = await d.caps();
  assert.equal(total(body.agents), 1);
  assert.equal(asMap(body.agents).get('operator').allocated, 1);
  assert.equal(body.reservedFloors.worker.blocked, true);
});

test('kept agents cannot take the priority winner slot or consume routed running slots', async () => {
  const d = await drive({
    config: enabled, kept: ['worker'], queuedCounts: [{ agentId: 'worker', queued: 4 }],
  });
  const body = await d.caps();
  assert.equal(asMap(body.agents).get('operator').allocated, 1);
  assert.equal(total(body.agents), 1);
  const allocation = allocateKeptAndRoutedCaps({
    target: 3, maxTotal: 75, blockingPriority: true,
    agents: [
      { agentId: 'routed', running: 2, queued: 50, allocationWeight: 1 },
      { agentId: 'kept', running: 0, queued: 4, allocationWeight: 404 },
    ],
    keepAgentIds: ['kept'], keptByAgent: { kept: { accountId: 'pool:1' } },
    accounts: [{ accountId: 'pool:1', pool: 'paid' }], perAccount: [{ accountId: 'pool:1', slots: 75 }],
  });
  assert.equal(total([...allocation.kept, ...allocation.routed]), 3);
  assert.equal(allocation.kept[0].allocated, 1);
  assert.equal(allocation.routed[0].allocated, 2);
});

test('enabling after a legacy cached read refreshes the ready-card snapshot', async () => {
  const d = await drive();
  await d.caps();
  await d.configure(enabled);
  const body = await d.caps();
  assert.equal(body.allocation.blockingPriority, true);
  assert.equal(total(body.agents), 1);
  assert.equal(asMap(body.agents).get('operator').allocationPriority.blockingFanOut, 2);
});

test('concurrent caps requests share one priority snapshot', async () => {
  const d = await drive({ config: enabled });
  const bodies = await Promise.all([d.caps(), d.caps(), d.caps()]);
  assert.ok(bodies.every(body => body.allocation.blockingPriority));
  for (const status of ['backlog', 'in_review', 'blocked']) {
    assert.equal(d.reads.filter(read => read === status).length, 1);
  }
});

test('a shared downstream card counts once across multiple roots owned by the same agent', async () => {
  const d = await drive({ config: enabled, issues: [
    issue('one', 'operator'), issue('two', 'operator'),
    issue('shared', null, { status: 'blocked', blockedBy: [{ id: 'one' }, { id: 'two' }] }),
  ] });
  assert.equal(asMap((await d.caps()).agents).get('operator').allocationPriority.blockingFanOut, 1);
});

test('unknown priorities are medium and prototype-looking ids remain plain keys', async () => {
  const d = await drive({ config: enabled, issues: [
    issue('__proto__', '__proto__', { priority: 'toString' }),
    issue('child', null, { status: 'blocked', blockedBy: [{ id: '__proto__' }] }),
  ] });
  const row = asMap((await d.caps()).agents).get('__proto__');
  assert.deepEqual(row.allocationPriority, { blockingFanOut: 1, cardPriority: 'medium', weight: 4 });
  assert.equal(Object.prototype.blockingFanOut, undefined);
});

test('priority fills every feasible slot across multiple shared, saturated and unavailable pools', () => {
  let seed = 0x51a7c0de;
  const random = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  for (let i = 0; i < 2000; i++) {
    const pools = Array.from({ length: 3 }, (_, j) => ({ accountId: `p${j}`, pool: `p${j}`, slots: random(12) }));
    const agents = Array.from({ length: 3 + random(10) }, (_, j) => ({
      agentId: `a${j}`, running: random(4), queued: random(20), allocationWeight: 1 + random(404),
    }));
    const kept = agents.filter((_, j) => j % 4 !== 3);
    const keptByAgent = Object.fromEntries(kept.map((agent, j) => [agent.agentId, { accountId: pools[j % 3].accountId }]));
    const unavailableAccountIds = random(2) ? ['p0'] : [];
    const target = random(80) / 2, maxTotal = 1 + random(40);
    const result = allocateKeptAndRoutedCaps({ target, maxTotal, agents, blockingPriority: true,
      keepAgentIds: kept.map(agent => agent.agentId), keptByAgent, accounts: pools, perAccount: pools,
      unavailableAccountIds,
    });
    const rows = [...result.kept, ...result.routed];
    const running = agents.reduce((sum, agent) => sum + agent.running, 0);
    let feasibleExtras = agents.filter(agent => !keptByAgent[agent.agentId])
      .reduce((sum, agent) => sum + (agent.running + agent.queued > 0 ? Math.max(agent.queued, 1) : 0), 0);
    for (const pool of pools) {
      const members = kept.filter(agent => keptByAgent[agent.agentId].accountId === pool.accountId);
      const poolRunning = members.reduce((sum, agent) => sum + agent.running, 0);
      const poolQueued = members.reduce((sum, agent) => sum + agent.queued, 0);
      const ceiling = unavailableAccountIds.includes(pool.accountId) ? 0 : pool.slots;
      feasibleExtras += Math.min(poolQueued, Math.max(0, ceiling - poolRunning));
      assert.ok(total(rows.filter(row => members.some(agent => agent.agentId === row.agentId))) <= Math.max(poolRunning, ceiling));
    }
    const budget = Math.max(0, Math.min(Math.round(target), maxTotal) - running);
    assert.equal(total(rows), running + Math.min(budget, feasibleExtras), `case ${i}`);
    assert.ok(rows.every(row => row.allocated >= row.running));
    assert.ok(result.kept.every(row => row.allocated <= row.demand));
    assert.ok(result.routed.every(row => row.allocated <= Math.max(row.demand, row.running + 1)));
  }
});

test('seeded kept/routed allocation sweep respects running and pool ceilings', () => {
  let seed = 123456789;
  const random = n => { seed = (1664525 * seed + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const agents = Array.from({ length: 3 + random(6) }, (_, j) => ({
      agentId: `a${j}`, running: random(5), queued: random(50), allocationWeight: 1 + random(404),
    }));
    const target = random(50) / 2, maxTotal = 1 + random(30), poolSlots = random(20);
    const result = allocateKeptAndRoutedCaps({
      target, maxTotal, agents, blockingPriority: true,
      keepAgentIds: ['a0', 'a1'], keptByAgent: { a0: { accountId: 'pool' }, a1: { accountId: 'pool' } },
      accounts: [{ accountId: 'pool', pool: 'paid' }], perAccount: [{ accountId: 'pool', slots: poolSlots }],
    });
    const rows = [...result.kept, ...result.routed];
    const running = agents.reduce((sum, agent) => sum + agent.running, 0);
    const keptRunning = agents[0].running + agents[1].running;
    assert.ok(total(rows) <= Math.max(running, Math.min(Math.round(target), maxTotal)));
    assert.ok(total(result.kept) <= Math.max(keptRunning, poolSlots));
    assert.ok(rows.every(row => row.allocated >= row.running));
  }
});
