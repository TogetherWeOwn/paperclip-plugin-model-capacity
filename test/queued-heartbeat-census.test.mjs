import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

const NOW = Date.parse('2026-10-21T08:00:00Z');
const COMPANY = 'acme';
const REVIEWER = 'reviewer';
// Mirrors the plugin's 20s queued-census memo; the boundary test below pins
// both the serve-stale side (< 20s) and the refetch side (>= 20s).
const TTL_MS = 20000;
const CAPACITY_KEY = {
  scopeKind: 'company', scopeId: COMPANY, namespace: 'model-capacity', stateKey: 'capacity-v1',
};

function capacity() {
  return {
    atMs: NOW, target: 53, maxTotal: 75, calibration: 'measured', demandFactor: 1,
    agentRunning: { [REVIEWER]: { running: 1, overPace: false } },
    keepAgentIds: [REVIEWER],
    keptByAgent: { [REVIEWER]: { accountId: 'meta:1' } },
    accounts: [{ accountId: 'meta:1', pool: 'meta' }],
    perAccount: [{ accountId: 'meta:1', slots: 75 }],
    paceGuard: { pools: [{ pool: 'meta', cap: 75 }] },
    breakerUnavailableAccountIds: [],
  };
}

// Same SDK seam as the runnable-demand suite (agents.getQueuedRunCounts ->
// [{ agentId, queued }]), but with a mutable clock and mutable host rows so
// the census memo's TTL boundary and malformed-response handling can be
// pinned. Each drive owns a fresh plugin, hence a fresh memo.
async function drive({ rows = [], now = NOW } = {}) {
  const box = { rows, now };
  const store = new Map([[JSON.stringify(CAPACITY_KEY), capacity()]]);
  const queuedCalls = [];
  const errors = [];
  const io = {
    state: {
      get: async key => store.get(JSON.stringify(key)) ?? null,
      set: async (key, value) => { store.set(JSON.stringify(key), value); },
    },
    issues: { list: async () => [] },
    jobs: { register() {} }, events: { on() {} },
    logger: { info() {}, error: (...args) => { errors.push(args); } },
    agents: { getQueuedRunCounts: async ({ companyId } = {}) => {
      queuedCalls.push({ companyId, atMs: box.now });
      return box.rows;
    } },
  };
  const plugin = createModelCapacityPlugin({ clock: () => box.now, requirePinnedLaneHost: false });
  await plugin.setup(io);
  await plugin.onConfigChanged({ roles: { keepAgentIds: [REVIEWER] } }, { companyId: COMPANY });
  return {
    box, queuedCalls, errors,
    caps: async () => {
      const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
      assert.equal(response.status, 200);
      return new Map(response.body.agents.map(agent => [agent.agentId, agent]));
    },
  };
}

test('census memo serves stale inside 20s and refetches at the boundary', async () => {
  const d = await drive({ rows: [{ agentId: REVIEWER, queued: 1 }] });
  assert.equal((await d.caps()).get(REVIEWER).queued, 1);
  assert.equal(d.queuedCalls.length, 1);

  d.box.rows = [{ agentId: REVIEWER, queued: 5 }];
  d.box.now = NOW + TTL_MS - 1;
  const stale = await d.caps();
  assert.equal(stale.get(REVIEWER).queued, 1, 'memo hit serves the first census inside the TTL');
  assert.equal(stale.get(REVIEWER).demandSource, 'heartbeat-runs');
  assert.equal(d.queuedCalls.length, 1, 'no host refetch inside the TTL');

  d.box.now = NOW + TTL_MS;
  const fresh = await d.caps();
  assert.equal(fresh.get(REVIEWER).queued, 5, 'census refetches once the TTL elapses');
  assert.equal(fresh.get(REVIEWER).demandSource, 'heartbeat-runs');
  assert.equal(d.queuedCalls.length, 2, 'exactly one refetch at the boundary');
});

test('malformed census is unavailable and never cached; empty array is a healthy zero', async () => {
  const d = await drive({ rows: null });
  const malformed = await d.caps();
  assert.equal(malformed.get(REVIEWER).queued, 0);
  assert.equal(malformed.get(REVIEWER).demandSource, 'heartbeat-runs-unavailable');
  assert.equal(d.queuedCalls.length, 1);
  assert.ok(d.errors.length > 0, 'malformed host response is logged');

  d.box.rows = { counts: [{ agentId: REVIEWER, queued: 7 }] };
  const drifted = await d.caps();
  assert.equal(drifted.get(REVIEWER).queued, 0, 'object shape drift grants no kept slots');
  assert.equal(drifted.get(REVIEWER).demandSource, 'heartbeat-runs-unavailable');
  assert.equal(d.queuedCalls.length, 2, 'malformed census is never memoized');

  d.box.rows = [{ agentId: REVIEWER, queued: 3 }];
  const recovered = await d.caps();
  assert.equal(recovered.get(REVIEWER).queued, 3, 'a healthy read right after a malformed one is served');
  assert.equal(recovered.get(REVIEWER).demandSource, 'heartbeat-runs');
  assert.equal(d.queuedCalls.length, 3);

  d.box.rows = [];
  d.box.now = NOW + TTL_MS;
  const empty = await d.caps();
  assert.equal(empty.get(REVIEWER).queued, 0);
  assert.equal(empty.get(REVIEWER).demandSource, 'heartbeat-runs', 'empty array is a valid zero-demand census');
  assert.equal(d.queuedCalls.length, 4);
  await d.caps();
  assert.equal(d.queuedCalls.length, 4, 'valid empty census is memoized like any healthy read');
});

test('numeric-string queued counts coerce; unparseable counts drop to zero', async () => {
  const d = await drive({ rows: [
    { agentId: REVIEWER, queued: '7' },
    { agentId: 'ghost', queued: 'not-a-number' },
    { agentId: '', queued: 9 },
  ] });
  const rows = await d.caps();
  assert.equal(rows.get(REVIEWER).queued, 7, 'tolerant numeric coercion matches the other SDK reads');
  assert.equal(rows.get(REVIEWER).demand, 8);
  assert.equal(rows.get(REVIEWER).demandSource, 'heartbeat-runs');
  assert.ok(!rows.has('ghost'), 'unparseable counts never create demand');
});
