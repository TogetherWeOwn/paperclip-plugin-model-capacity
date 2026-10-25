import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const COMPANY = 'acme';
const NOW = Date.parse('2026-10-25T12:00:00Z');
const MIN = 60000;
const issue = id => ({ id, assigneeAgentId: 'worker', status: 'todo', priority: 'medium', blockedBy: [] });
const worker = caps => caps.agents.find(row => row.agentId === 'worker');
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

// Hold a real tick at its first post-demand write; API calls remain runnable
// while the SDK state RPC is pending. No wall-clock sleeps or private cache seam.
async function drive({ failRelations = false } = {}) {
  let now = NOW;
  let used = 0.3;
  let writeBarrier = null;
  let listBarrier = null;
  const issues = Array.from({ length: 11 }, (_, i) => issue(`q-${i}`));
  const config = {
    allocation: { blockingPriority: true }, roles: { doerAgentIds: ['worker'] },
    concurrency: { meanRunDurationHours: 1.1, maxTotal: 75 },
  };
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const reads = [];
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => ({ ...config, cliproxy: {
      laneKeySecretRef: { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' },
    } }) },
    state: {
      get: async key => store.get(key.stateKey) ?? null,
      set: async (key, value) => {
        if (writeBarrier && key.stateKey === 'pacing-v1') {
          const barrier = writeBarrier;
          writeBarrier = null;
          barrier.entered.resolve();
          await barrier.release.promise;
        }
        store.set(key.stateKey, value);
      },
    },
    secrets: { resolve: async () => 'synthetic-lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({
      observedAt: new Date(now).toISOString(),
      accounts: [{
        lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy', models: ['gpt-6.1-sol'],
        weekly: { used, resetsAt: new Date(NOW + 2 * 60 * MIN).toISOString() },
        fiveHour: { used: 0.1, resetsAt: new Date(NOW + 4 * 60 * MIN).toISOString() },
        observedAt: new Date(now).toISOString(), quality: 'live',
      }],
    }, now) }) },
    agents: { get: async () => null, getQueuedRunCounts: async () => [] },
    issues: { get: async () => null, list: async ({ companyId, status }) => {
      assert.equal(companyId, COMPANY);
      reads.push(status);
      const rows = issues.filter(row => row.status === status);
      if (status === 'todo' && listBarrier) {
        const barrier = listBarrier;
        listBarrier = null;
        barrier.entered.resolve();
        await barrier.release.promise;
      }
      if (failRelations && status === 'blocked') throw new Error('synthetic relation failure');
      return rows;
    } },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { handlers.set(name, fn); } }, logger: { info() {}, error() {} },
  });
  store.set('aa-snapshot-v1', {
    fetchedAt: new Date(NOW).toISOString(), duplicateSlugs: [],
    rows: [{ slug: 'gpt-6.1-sol', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30,
      price1mInputTokens: 5, price1mOutputTokens: 25 }],
  });
  await plugin.onConfigChanged(config, { companyId: COMPANY });
  const barrier = () => ({ entered: deferred(), release: deferred() });
  const api = async routeKey => {
    const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey });
    assert.equal(response.status, 200);
    return response.body;
  };
  return {
    issues, store, reads, api,
    configure: () => plugin.onConfigChanged(config, { companyId: COMPANY }),
    setNow: ms => { now = ms; },
    setUsed: value => { used = value; },
    holdWrite: () => { writeBarrier = barrier(); return writeBarrier; },
    holdList: () => { listBarrier = barrier(); return listBarrier; },
    tick: () => jobs.get('shadow-tick')({ companyId: COMPANY }),
    run: (id, type) => handlers.get(type)({
      type, companyId: COMPANY, entityId: id, occurredAt: new Date(now).toISOString(),
      payload: { run: { agentId: 'worker', provider: 'codex', model: 'gpt-6.1-sol' } },
    }),
  };
}

const measured = atMs => ({ atMs, target: 20, maxTotal: 75, calibration: 'measured', agentRunning: {} });

for (const failRelations of [false, true]) {
  test(`old published caps cannot evict an in-progress tick snapshot (failure=${failRelations})`, async () => {
    const d = await drive({ failRelations });
    await d.tick();
    // Calibrate the real target while keeping the same eleven-card queue.
    d.setNow(NOW + 10 * MIN);
    for (let i = 0; i < 6; i++) await d.run(`run-${i}`, 'agent.run.started');
    d.setNow(NOW + 20 * MIN);
    for (let i = 0; i < 2; i++) await d.run(`run-${i}`, 'agent.run.finished');
    d.setNow(NOW + 30 * MIN);
    d.setUsed(0.328);
    await d.tick();
    const published = await d.api('capacity');
    assert.equal(published.atMs, NOW + 30 * MIN);
    d.setNow(NOW + 31 * MIN);
    const barrier = d.holdWrite();
    const tick = d.tick();
    let old, oldReads, oldReadStart;
    try {
      await barrier.entered.promise;
      assert.equal((await d.api('capacity')).atMs, published.atMs);
      // Expire the ordinary ready TTL during the tick's bounded state RPCs.
      // The older API call must not replace the new tick's priority promise.
      d.setNow(NOW + 31 * MIN + 28000);
      d.issues.splice(1);
      oldReadStart = d.reads.length;
      old = await d.api('caps');
      oldReads = d.reads.length;
    } finally {
      barrier.release.resolve();
      await tick;
    }
    const before = d.reads.length;
    const capacity = await d.api('capacity');
    const caps = await d.api('caps');
    assert.equal(capacity.atMs, NOW + 31 * MIN);
    assert.equal(capacity.demandBound, 15);
    assert.equal(caps.atMs, capacity.atMs);
    assert.equal(worker(caps).queued, failRelations ? 1 : 11);
    assert.deepEqual(caps.allocation, failRelations
      ? { blockingPriority: false, error: 'priority-unavailable' }
      : { blockingPriority: true });
    // Fallback intentionally keeps legacy TTL demand, but does not retry the
    // failed priority read. Active mode retains the target's exact snapshot.
    assert.equal(d.reads.length, before);
    assert.equal(old.atMs, published.atMs);
    assert.equal(worker(old).queued, failRelations ? 1 : 11);
    assert.equal(oldReads, failRelations ? oldReadStart + 2 : oldReadStart);
  });
}

test('overlapping caps calls share the same pending per-tick snapshot', async () => {
  const d = await drive();
  d.store.set('capacity-v1', measured(NOW));
  const barrier = d.holdList();
  const first = d.api('caps');
  let second;
  try {
    await barrier.entered.promise;
    second = d.api('caps');
    // Drain microtasks so both handlers reach their issue-read await.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(d.reads, ['todo', 'in_progress']);
  } finally {
    barrier.release.resolve();
  }
  const caps = await Promise.all([first, second]);
  assert.deepEqual(caps[0], caps[1]);
  assert.equal(worker(caps[0]).queued, 11);
  assert.deepEqual(d.reads.sort(), ['backlog', 'blocked', 'in_progress', 'in_review', 'todo']);
});

test('retain the two newest ticks, not the last two request arrival times', async () => {
  const d = await drive();
  for (let tick = 0; tick < 4; tick++) {
    d.setNow(NOW + tick * MIN);
    d.store.set('capacity-v1', measured(NOW + tick * MIN));
    await d.api('caps');
  }
  d.issues.splice(1);
  d.setNow(NOW + 3 * MIN + 28000);
  const before = d.reads.length;
  // An already-started stale API request may still carry an older capacity.
  // It can rebuild its evicted snapshot but must not evict either newer tick.
  d.store.set('capacity-v1', measured(NOW));
  assert.equal(worker(await d.api('caps')).queued, 1);
  assert.equal(d.reads.length, before + 5);
  for (const tick of [2, 3]) {
    d.store.set('capacity-v1', measured(NOW + tick * MIN));
    assert.equal(worker(await d.api('caps')).queued, 11);
  }
  assert.equal(d.reads.length, before + 5);
  d.setNow(NOW + 4 * MIN);
  await d.configure();
  assert.equal(worker(await d.api('caps')).queued, 1);
  assert.equal(d.reads.length, before + 10);
});
