import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateKeptAndRoutedCaps } from '../src/concurrency.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// Offline integration acceptance: SDK, census, lane and secret responses are synthetic.
const NOW = Date.parse('2026-10-25T18:00:00Z');
const COMPANY = 'acme';
const REF = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555', version: 1 };
const agent = (agentId, queued, allocationWeight = 1, running = 0) => ({ agentId, queued, allocationWeight, running });
const rowsOf = result => [...result.kept, ...result.routed];
const total = rows => rows.reduce((sum, row) => sum + row.allocated, 0);
const rowOf = (rows, id) => rows.find(row => row.agentId === id);
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function allocation(extra = {}) {
  return {
    target: 1, maxTotal: 8, demandFactor: 1, blockingPriority: true,
    agents: [agent('review', 1), agent('worker', 1, 404)],
    keepAgentIds: ['review'], keptByAgent: { review: { accountId: 'meta:spent' } },
    reviewerAccountIdsByAgent: { review: ['codex:a'] },
    accounts: [{ accountId: 'meta:spent', pool: 'meta' }, { accountId: 'codex:a', pool: 'codex' }],
    perAccount: [{ accountId: 'meta:spent', slots: 0 }, { accountId: 'codex:a', slots: 8 }],
    pacePools: [{ pool: 'meta', cap: 0 }, { pool: 'codex', cap: 8 }],
    ...extra,
  };
}
function fixedAndReview(extra = {}) {
  return allocation({
    agents: [agent('fixed', 1), agent('review', 1, 404)],
    keepAgentIds: ['fixed', 'review'],
    keptByAgent: { fixed: { accountId: 'codex:a' }, review: { accountId: 'meta:spent' } },
    ...extra,
  });
}

for (const reverse of [false, true]) {
  test(`priority integration: high-priority ordinary work beats a low-priority helper (reversed=${reverse})`, () => {
    const input = allocation();
    if (reverse) input.agents.reverse();
    const rows = rowsOf(allocateKeptAndRoutedCaps(input));
    assert.equal(rowOf(rows, 'worker').allocated, 1, 'the scarce slot belongs to higher-priority useful demand');
    assert.equal(rowOf(rows, 'review').allocated, 0);
    assert.equal(total(rows), 1);
  });
}

test('priority integration: high-priority review work beats a low-priority fixed reservation', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(fixedAndReview()));
  assert.equal(rowOf(rows, 'review').allocated, 1, 'fixed reservations cannot precede the global weighted split');
  assert.equal(rowOf(rows, 'fixed').allocated, 0);
  assert.equal(total(rows), 1);
});

test('priority integration: helper reviewers compete by weight, not identity order', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(allocation({
    agents: [agent('a-low', 1), agent('z-high', 1, 404)],
    reviewerAccountIdsByAgent: { 'a-low': ['codex:a'], 'z-high': ['codex:a'] },
    keepAgentIds: [], keptByAgent: {},
  })));
  assert.equal(rowOf(rows, 'z-high').allocated, 1);
  assert.equal(rowOf(rows, 'a-low').allocated, 0);
  assert.equal(total(rows), 1);
});

test('priority integration: fixed and helper queues cannot reserve ahead of high-priority ordinary work', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(fixedAndReview({
    target: 2, agents: [agent('fixed', 8), agent('review', 8), agent('worker', 2, 404)],
  })));
  assert.equal(rowOf(rows, 'worker').allocated, 2);
  assert.equal(rowOf(rows, 'fixed').allocated, 0);
  assert.equal(rowOf(rows, 'review').allocated, 0);
  assert.equal(total(rows), 2);
});

test('priority integration: a tiny high-priority review queue releases unused shares to fixed work', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(fixedAndReview({
    target: 3, agents: [agent('fixed', 5), agent('review', 1, 404)],
  })));
  assert.equal(rowOf(rows, 'review').allocated, 1);
  assert.equal(rowOf(rows, 'fixed').allocated, 2);
  assert.equal(total(rows), 3, 'bounded useful demand must redistribute all usable shares');
});

test('priority integration: ordinary running is retained before fixed or review starts compete', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(fixedAndReview({
    target: 2, agents: [agent('fixed', 4), agent('review', 1, 404), agent('worker', 0, 1, 1)],
  })));
  assert.equal(rowOf(rows, 'worker').allocated, 1);
  assert.equal(rowOf(rows, 'review').allocated, 1);
  assert.equal(rowOf(rows, 'fixed').allocated, 0);
  assert.equal(total(rows), 2);
});

test('priority integration: over-target running floors survive without authorizing any new slots', () => {
  const input = fixedAndReview({
    target: 1, maxTotal: 2,
    agents: [agent('fixed', 4, 1, 1), agent('review', 8, 404, 2), agent('worker', 3, 2, 1)],
  });
  const rows = rowsOf(allocateKeptAndRoutedCaps(input));
  for (const row of rows) assert.equal(row.allocated, row.running);
  assert.equal(total(rows), 4, 'pre-existing running is the only permitted fleet overshoot');
});

test('priority integration: fixed and helper consumers share account and pace-pool ceilings once', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(fixedAndReview({
    target: 20, maxTotal: 20,
    agents: [agent('fixed', 1), agent('review', 10, 404), agent('peer', 10)],
    accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: 'codex:b', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:a', slots: 3 }, { accountId: 'codex:b', slots: 5 }],
    pacePools: [{ pool: 'codex', cap: 5 }],
    reviewerAccountIdsByAgent: { review: ['codex:a'], peer: ['codex:b'] },
  })));
  assert.ok(total(rows) <= 5, JSON.stringify(rows));
  assert.ok(rowOf(rows, 'fixed').allocated + rowOf(rows, 'review').allocated <= 3, JSON.stringify(rows));
  assert.ok(rowOf(rows, 'peer').allocated <= 5);
  assert.equal(total(rows), 5, 'bounded competition must not strand reachable pool capacity');
});

test('priority integration: admitted fractional accounts combine without duplicating a shared pool', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(allocation({
    target: 8, maxTotal: 8, keepAgentIds: [], keptByAgent: {},
    agents: [agent('review', 8, 404), agent('peer', 8)],
    accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: 'codex:b', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:a', slots: 0.6 }, { accountId: 'codex:b', slots: 0.6 }],
    pacePools: [{ pool: 'codex', cap: 1 }],
    reviewerAccountIdsByAgent: { review: ['codex:a', 'codex:b'], peer: ['codex:a', 'codex:b'] },
  })));
  assert.equal(total(rows), 1);
  assert.ok(rows.every(row => row.allocated <= 1));
});

test('priority integration: unavailable helpers retain running but cannot consume new priority shares', () => {
  const rows = rowsOf(allocateKeptAndRoutedCaps(allocation({
    target: 3, agents: [agent('review', 8, 404, 1), agent('worker', 2)],
    unavailableAccountIds: ['codex:a'],
  })));
  assert.equal(rowOf(rows, 'review').allocated, 1);
  assert.equal(rowOf(rows, 'worker').allocated, 2);
  assert.equal(total(rows), 3);
});

test('priority integration: default-off retains the exact legacy helper allocation and metadata', () => {
  const { blockingPriority, ...input } = fixedAndReview({
    target: 2, agents: [agent('fixed', 1), agent('review', 3, 404), agent('worker', 2, 404)],
  });
  const implicit = allocateKeptAndRoutedCaps(input);
  const explicit = allocateKeptAndRoutedCaps({ ...input, blockingPriority: false });
  const noWeights = allocateKeptAndRoutedCaps({ ...input,
    agents: input.agents.map(({ allocationWeight, ...row }) => row),
  });
  assert.deepEqual(explicit, implicit);
  assert.deepEqual(implicit, noWeights);
  assert.equal(rowOf(rowsOf(implicit), 'fixed').allocated, 1);
  assert.equal(rowOf(rowsOf(implicit), 'review').allocated, 1);
  assert.equal(rowOf(rowsOf(implicit), 'worker').allocated, 0);
});

const issue = (id, assigneeAgentId, priority = 'medium') => ({
  id, assigneeAgentId, priority, status: 'todo', blockedBy: [],
});
const source = () => ({ repositories: ['example/product'], tokenSecretRef: REF, requiredChecks: ['ci-ok', 'pr-lint'] });
const config = () => ({
  roles: { keepAgentIds: ['review'], doerAgentIds: ['worker'], minQuality: { doer: null, thinker: null, other: null } },
  allocation: { blockingPriority: true }, reviewReserve: { enabled: false },
  reviewerRouting: { agentIds: ['review'], arms: [{ provider: 'codex', model: 'gpt-6.1-sol' }] },
  reviewDemand: source(),
});
function capacity(extra = {}) {
  const input = allocation();
  return { atMs: NOW, target: 8, maxTotal: 8, calibration: 'measured', demandFactor: 1,
    agentRunning: {}, keepAgentIds: input.keepAgentIds, keptByAgent: input.keptByAgent,
    reviewerAccountIdsByAgent: input.reviewerAccountIdsByAgent,
    accounts: input.accounts, perAccount: input.perAccount, paceGuard: { pools: input.pacePools }, ...extra };
}
function pull(number) {
  const oid = number.toString(16).padStart(40, '0');
  return { number, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: {
      nodes: ['ci-ok', 'pr-lint'].map(name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
      pageInfo: { hasNextPage: false },
    } } } }] } };
}
async function drive({ cap = capacity(), raw = config(), issues = [], heads = 0, heartbeats = [], barrierAt = null } = {}) {
  const store = new Map([['capacity-v1', cap]]);
  const jobs = new Map();
  const reads = [];
  const barrier = { entered: deferred(), release: deferred() };
  let censusCalls = 0;
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => ({ ...raw, cliproxy: { laneKeySecretRef: REF } }) },
    state: { get: async key => {
      if (key.stateKey === 'caps-hold-v1' && barrierAt === 'hold') {
        barrier.entered.resolve();
        await barrier.release.promise;
      }
      return store.get(key.stateKey) ?? null;
    }, set: async (key, value) => { store.set(key.stateKey, value); } },
    issues: { get: async () => null, list: async ({ companyId, status }) => {
      assert.equal(companyId, COMPANY);
      reads.push(status);
      return issues.filter(row => row.status === status);
    } },
    agents: { get: async () => ({ adapterType: 'claude-code' }), getQueuedRunCounts: async () => heartbeats },
    secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async url => {
      if (url === 'https://api.github.com/graphql') {
        censusCalls++;
        if (barrierAt === 'census') {
          barrier.entered.resolve();
          await barrier.release.promise;
        }
        return { status: 200, json: async () => ({ data: { repository: { pullRequests: {
          nodes: Array.from({ length: heads }, (_, i) => pull(i + 1)), pageInfo: { hasNextPage: false, endCursor: null },
        } } } }) };
      }
      assert.match(url, /\/telemetry\/cliproxy\/live\/accounts\.json$/);
      return { status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(NOW).toISOString(), accounts: [
        { lane: 'codex-a', provider: 'codex', accountKey: 'a', health: 'healthy', models: ['gpt-6.1-sol'],
          weekly: { used: 0.2, resetsAt: new Date(NOW + 86400000).toISOString() },
          fiveHour: { used: 0.1, resetsAt: new Date(NOW + 14400000).toISOString() },
          observedAt: new Date(NOW).toISOString(), quality: 'live' },
      ] }, NOW) };
    } },
    jobs: { register: (name, fn) => jobs.set(name, fn) }, events: { on() {} }, logger: { info() {}, error() {} },
  });
  store.set('aa-snapshot-v1', { fetchedAt: new Date(NOW).toISOString(), duplicateSlugs: [], rows: [
    { slug: 'gpt-6.1-sol', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  ] });
  await plugin.onConfigChanged(raw, { companyId: COMPANY });
  return { store, barrier, reads, censusCalls: () => censusCalls,
    configure: next => plugin.onConfigChanged(next, { companyId: COMPANY }),
    tick: () => jobs.get('quota-refresh')({ companyId: COMPANY }),
    caps: async () => {
      const result = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
      assert.equal(result.status, 200);
      return result.body;
    } };
}

for (const blockingPriority of [false, true]) {
  test(`caps integration: helpers cannot spend additive free target as paid capacity (priority=${blockingPriority})`, async () => {
    const d = await drive({ heads: 80, raw: { ...config(), allocation: { blockingPriority } },
      cap: capacity({ target: 5, paidTarget: 2, totalTarget: 5, freeLanes: { target: 3 },
        agentRunning: { review: { running: 1 }, worker: { running: 0, freeRunning: 2 } } }),
      issues: [issue('worker-ready', 'worker')],
    });
    const body = await d.caps();
    assert.equal(body.target, 5, 'the reported fleet target remains additive');
    const paid = body.agents.reduce((sum, row) => sum + row.allocated - (row.freeAllocated ?? 0), 0);
    assert.equal(rowOf(body.agents, 'worker').freeAllocated, 2, 'persisted free running survives without live free admission');
    assert.ok(paid <= 2, JSON.stringify(body));
    assert.ok(rowOf(body.agents, 'review').allocated <= 2, 'review helper slots cannot spend the three free slots');
    assert.ok(total(body.agents) <= 4);
  });
}

for (const barrierAt of ['census', 'hold']) {
  for (const freeOnly of [false, true]) {
    test(`caps integration: invalidation at ${barrierAt} preserves ${freeOnly ? 'free-only' : 'paid and free'} running, no new work`, async () => {
      const raw = config();
      const running = freeOnly
        ? { worker: { running: 0, freeRunning: 2 } }
        : { review: { running: 2, freeRunning: 1 }, worker: { running: 1, freeRunning: 2 } };
      const d = await drive({ raw, heads: 8, barrierAt, heartbeats: [{ agentId: 'review', queued: 7 }],
        cap: capacity({ target: 8, paidTarget: 5, totalTarget: 8, freeLanes: { target: 3 }, agentRunning: running }),
        issues: [issue('worker-ready', 'worker', 'high')],
      });
      const pending = d.caps();
      await d.barrier.entered.promise;
      try {
        assert.equal(d.censusCalls(), 1, 'the configured synthetic source must actually be reached');
        await d.configure({ ...raw, reviewDemand: { enabled: false } });
      } finally {
        d.barrier.release.resolve();
      }
      const body = await pending;
      assert.equal(body.capsError, 'configuration-changed');
      assert.equal(body.target, null);
      for (const [id, active] of Object.entries(running)) {
        const expected = active.running + (active.freeRunning ?? 0);
        const row = rowOf(body.agents, id);
        assert.equal(row?.maxConcurrentRuns, expected, `${id}: preserve paid plus free running on invalidation`);
        assert.equal(row?.allocated, expected);
        assert.equal(row?.running, expected, 'running telemetry must use the same combined floor as the host cap');
      }
      assert.equal(total(body.agents), Object.values(running).reduce((sum, a) => sum + a.running + (a.freeRunning ?? 0), 0));
      assert.ok(body.agents.every(row => row.allocated === row.running), 'invalidation must never grant new work');
      assert.equal(body.reviewDemand.eligibleHeads, 0);
    });
  }
}

for (const stale of [false, true]) {
  test(`caps integration: pre-request admission generation ${stale ? 'mismatch keeps only running' : 'match admits queued work'}`, async () => {
    const raw = { ...config(), reviewDemand: { enabled: false } };
    const d = await drive({ raw, heartbeats: [{ agentId: 'review', queued: 7 }] });
    await d.tick();
    const produced = d.store.get('capacity-v1');
    assert.equal(typeof produced.reviewAdmissionEpoch, 'string', 'tick must publish its current instance epoch');
    assert.ok(produced.reviewAdmissionEpoch.length > 0);
    d.store.set('capacity-v1', capacity({
      reviewAdmissionGeneration: produced.reviewAdmissionGeneration,
      reviewAdmissionEpoch: produced.reviewAdmissionEpoch,
      agentRunning: { review: { running: 2 } },
    }));
    if (stale) await d.configure(raw);
    const body = await d.caps();
    const row = rowOf(body.agents, 'review');
    assert.equal(row.queued, 7);
    assert.equal(row.maxConcurrentRuns, stale ? 2 : 8);
    assert.equal(d.censusCalls(), 0, 'disabled census isolates the admission-generation fence');
  });
}

test('caps integration: role-demand overlay preserves cached issue counts and same-tick priority matching', async t => {
  const subject = 'snapshot-subject';
  const raw = { ...config(), roles: { ...config().roles, keepAgentIds: [subject] },
    reviewerRouting: { ...config().reviewerRouting, agentIds: [subject] } };
  const d = await drive({ raw, heads: 5, heartbeats: [{ agentId: subject, queued: 7 }], issues: [
    issue('subject-one', subject, 'critical'), issue('subject-two', subject), issue('subject-three', subject),
    issue('worker-one', 'worker', 'high'), issue('worker-two', 'worker'),
    { ...issue('descendant', null), status: 'blocked', blockedBy: [{ id: 'subject-one' }] },
  ] });
  // Observe, never alter, the actual count Map constructed from SDK issue rows.
  // Node isolates test files; this file runs its cases serially. Restore before assertions.
  const originalSet = Map.prototype.set;
  const countMaps = [];
  const observer = t.mock.method(Map.prototype, 'set', function (key, value) {
    if (key === subject && value === 1 && !countMaps.includes(this)) countMaps.push(this);
    return originalSet.call(this, key, value);
  });
  try {
    await d.tick();
    await d.tick(); // Same clock and same priority-cache tick, with a second role overlay.
  } finally {
    observer.mock.restore();
  }
  assert.equal(countMaps.length, 1, 'one original issue count Map is built and reused for the same tick');
  assert.equal(countMaps[0].get(subject), 3, 'five heads plus seven heartbeat runs must not replace three cached issue rows');
  assert.equal(countMaps[0].get('worker'), 2);
  d.store.set('capacity-v1', capacity({ keepAgentIds: [subject], keptByAgent: { [subject]: { accountId: 'meta:spent' } },
    reviewerAccountIdsByAgent: { [subject]: ['codex:a'] } }));
  const first = await d.caps();
  const second = await d.caps();
  assert.deepEqual(second.agents, first.agents, 'repeat caps uses the same original issue counts and priorities');
  const row = rowOf(first.agents, subject);
  assert.equal(row.queued, 12, 'caps overlays heartbeat plus heads separately from original issue demand');
  assert.deepEqual(row.allocationPriority, { blockingFanOut: 1, cardPriority: 'critical', weight: 8 });
  assert.equal(rowOf(first.agents, 'worker').queued, 2);
  assert.equal(countMaps[0].get(subject), 3, 'caps also must not mutate the cached issue counts');
  for (const status of ['todo', 'in_progress', 'backlog', 'in_review', 'blocked']) {
    assert.equal(d.reads.filter(read => read === status).length, 1, `${status}: same-tick snapshot is reused`);
  }
});
