import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { allocateKeptAndRoutedCaps } from '../src/concurrency.mjs';
import { createReviewDemandReader, normalizeReviewDemand, eligibleReviewHead } from '../src/review-demand.mjs';

const NOW = Date.parse('2026-10-25T08:00:00Z');
const ref = { type: 'secret_ref', secretId: '11111111-1111-1111-1111-111111111111' };
const check = (name, conclusion = 'SUCCESS', status = 'COMPLETED') => ({ __typename: 'CheckRun', name, status, conclusion });
function pull(number, contexts = [check('ci-ok'), check('pr-lint'), check('Paperclip Review', 'ACTION_REQUIRED')], overrides = {}) {
  const oid = number.toString(16).padStart(40, '0');
  return { number, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: { nodes: contexts, pageInfo: { hasNextPage: false } } } } }] }, ...overrides };
}
function response(nodes, pageInfo = { hasNextPage: false, endCursor: null }) {
  return { data: { repository: { pullRequests: { nodes, pageInfo } } } };
}
function snapshot() {
  return { atMs: NOW, target: 20, maxTotal: 75, calibration: 'measured', demandFactor: 1,
    agentRunning: { reviewer: { running: 1 } }, keepAgentIds: ['reviewer'],
    keptByAgent: { reviewer: { accountId: 'meta:a' } },
    reviewerAccountIdsByAgent: { reviewer: ['codex:a', 'claude:a'] },
    accounts: [{ accountId: 'meta:a', pool: 'meta' }, { accountId: 'codex:a', pool: 'codex' }, { accountId: 'claude:a', pool: 'claude' }],
    perAccount: [{ accountId: 'meta:a', slots: 0 }, { accountId: 'codex:a', slots: 6 }, { accountId: 'claude:a', slots: 2 }],
    paceGuard: { pools: [{ pool: 'meta', cap: 0 }, { pool: 'codex', cap: 6 }, { pool: 'claude', cap: 2 }] } };
}
async function drive({ nodes = [], queued = 0, cap = snapshot(), fail = false } = {}) {
  const store = new Map([['capacity-v1', cap]]);
  const calls = [];
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    state: { get: async k => store.get(k.stateKey), set: async (k, v) => store.set(k.stateKey, v) },
    issues: { list: async () => [] }, agents: { getQueuedRunCounts: async () => [{ agentId: 'reviewer', queued }] },
    jobs: { register() {} }, events: { on() {} }, logger: { info() {}, error() {} },
    secrets: { resolve: async () => 'fixture-only' },
    http: { fetch: async (url, init) => { calls.push({ url, init }); if (fail) throw new Error('private-upstream-text'); return { status: 200, json: async () => response(nodes) }; } },
  });
  await plugin.onConfigChanged({ roles: { keepAgentIds: ['reviewer'] },
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'meta', model: 'muse-wonder-full-1.0-contributor' }, { provider: 'codex', model: 'gpt-6.1-sol' }] },
    reviewDemand: { repositories: ['example/product'], tokenSecretRef: ref, requiredChecks: ['ci-ok', 'pr-lint'] },
  }, { companyId: 'acme' });
  const read = async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'caps' })).body;
  return { read, calls };
}

test('Meta exhausted plus 80 eligible heads scales reviewer using helper headroom', async () => {
  const d = await drive({ nodes: Array.from({ length: 80 }, (_, i) => pull(i + 1)), queued: 1 });
  const body = await d.read();
  const row = body.agents.find(a => a.agentId === 'reviewer');
  assert.ok(row?.maxConcurrentRuns >= 4, JSON.stringify(body));
  assert.equal(row.queued, 81);
  assert.equal(row.reviewEligibleHeads, 80);
  assert.equal(row.heartbeatQueued, 1);
  assert.ok(row.maxConcurrentRuns <= 8, 'helper pool slots are a hard ceiling');
  assert.equal(d.calls[0].url, 'https://api.github.com/graphql');
});

test('no eligible heads preserves queued heartbeat demand', async () => {
  const d = await drive({ queued: 2 });
  const row = (await d.read()).agents.find(a => a.agentId === 'reviewer');
  assert.equal(row.queued, 2);
  assert.equal(row.reviewEligibleHeads, 0);
  assert.equal(row.maxConcurrentRuns, 3);
});

test('all reviewer arms exhausted preserves only the running floor', async () => {
  const cap = snapshot();
  cap.reviewerAccountIdsByAgent.reviewer = [];
  const d = await drive({ cap, nodes: Array.from({ length: 80 }, (_, i) => pull(i + 1)) });
  const row = (await d.read()).agents.find(a => a.agentId === 'reviewer');
  assert.equal(row.maxConcurrentRuns, 1);
});

test('only proven green current heads without a verdict add demand, deduplicated per PR head', async () => {
  const ci = [check('ci-ok'), check('pr-lint')];
  const nodes = [pull(1), pull(1), pull(2, ci),
    pull(3, [...ci, check('Paperclip Review')]),
    pull(4, [...ci, check('Paperclip Review', 'FAILURE')]),
    pull(5, ci, { isDraft: true }), pull(6, ci, { mergeable: 'CONFLICTING' }),
    pull(7, ci, { mergeable: 'UNKNOWN' }), pull(8, [check('ci-ok', 'FAILURE'), check('pr-lint')]),
    pull(9, [check('ci-ok', null, 'IN_PROGRESS'), check('pr-lint')]), pull(10, [check('pr-lint')]),
    pull(11, ci, { commits: { nodes: [{ commit: { oid: 'different-head' } }] } }),
    pull(12, [...ci, { __typename: 'StatusContext', context: 'CodeRabbit', state: 'PENDING' }])];
  const d = await drive({ nodes });
  const row = (await d.read()).agents.find(a => a.agentId === 'reviewer');
  assert.equal(row.reviewEligibleHeads, 3, 'heads 1, 2 and 12 only');
  await d.read();
  assert.equal(d.calls.length, 1, 'short cache avoids repeated network work');
});

test('failed census is unavailable rather than stale demand or leaked upstream text', async () => {
  const d = await drive({ queued: 2, fail: true });
  const body = await d.read();
  const row = body.agents.find(a => a.agentId === 'reviewer');
  assert.equal(row.queued, 2);
  assert.equal(body.reviewDemand.status, 'unavailable');
  assert.ok(!JSON.stringify(body).includes('private-upstream-text'));
});

test('reviewer helper pools are shared once with fixed agents and other reviewers', () => {
  const cap = snapshot();
  const out = allocateKeptAndRoutedCaps({ ...cap,
    agents: [{ agentId: 'fixed', running: 0, queued: 4 }, { agentId: 'reviewer', running: 1, queued: 80 }, { agentId: 'second', running: 0, queued: 80 }],
    keepAgentIds: ['fixed', 'reviewer'], keptByAgent: { fixed: { accountId: 'codex:a' }, reviewer: { accountId: 'meta:a' } },
    reviewerAccountIdsByAgent: { reviewer: ['codex:a', 'claude:a'], second: ['codex:a', 'claude:a'] },
    pacePools: cap.paceGuard.pools,
  });
  const rows = [...out.kept, ...out.routed];
  assert.ok(rows.reduce((n, a) => n + a.allocated, 0) <= 8, JSON.stringify(rows));
  assert.ok(rows.find(a => a.agentId === 'reviewer').allocated > 1);
});


test('duplicate successful required checks do not hide a review-eligible head', () => {
  assert.equal(eligibleReviewHead(pull(1, [check('ci-ok'), check('pr-lint'), check('pr-lint')]), ['ci-ok', 'pr-lint']), true);
});

test('fixed consumers cannot lend the same account slots to a reviewer subset', () => {
  const out = allocateKeptAndRoutedCaps({ target: 20, maxTotal: 75, demandFactor: 1,
    agents: [{ agentId: 'fixed', running: 0, queued: 4 }, { agentId: 'reviewer', running: 0, queued: 80 }],
    keepAgentIds: ['fixed'], keptByAgent: { fixed: { accountId: 'codex:a' } },
    reviewerAccountIdsByAgent: { reviewer: ['codex:a'] },
    accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: 'codex:b', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:a', slots: 6 }, { accountId: 'codex:b', slots: 10 }],
    pacePools: [{ pool: 'codex', cap: 16 }],
  });
  assert.equal(out.kept.find(a => a.agentId === 'reviewer').allocated, 2);
});

for (const bad of [
  { errors: [{ message: 'private-detail' }], ...response([pull(1)]) },
  response([pull(1)], { hasNextPage: true, endCursor: null }),
  { data: { repository: null } },
]) {
  test('partial or malformed census never publishes a positive count', async () => {
    const read = createReviewDemandReader({ clock: () => NOW });
    const result = await read({ secrets: { resolve: async () => 'fixture-only' },
      http: { fetch: async () => ({ status: 200, json: async () => bad }) } },
    'acme', normalizeReviewDemand({ repositories: ['example/product'], tokenSecretRef: ref }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.eligibleHeads, 0);
    assert.ok(!JSON.stringify(result).includes('private-detail'));
  });
}

test('census paginates and deduplicates heads, with company-scoped single-flight caching', async () => {
  const read = createReviewDemandReader({ clock: () => NOW });
  const calls = [];
  const ctx = { secrets: { resolve: async (_ref, opts) => { calls.push(opts.companyId); return 'fixture-only'; } },
    http: { fetch: async (_url, init) => ({ status: 200, json: async () => {
      const cursor = JSON.parse(init.body).variables.cursor;
      return cursor ? response([pull(1), pull(2)]) : response([pull(1)], { hasNextPage: true, endCursor: 'page-2' });
    } }) } };
  const cfg = normalizeReviewDemand({ repositories: ['example/product'], tokenSecretRef: ref });
  const [a, b] = await Promise.all([read(ctx, 'acme', cfg), read(ctx, 'acme', cfg)]);
  assert.equal(a.eligibleHeads, 2);
  assert.equal(b.eligibleHeads, 2);
  await read(ctx, 'other-company', cfg);
  assert.deepEqual(calls, ['acme', 'other-company']);
});

test('a failed refresh replaces positive demand, while disabled configuration performs zero I/O', async () => {
  let now = NOW;
  let fail = false;
  let calls = 0;
  const read = createReviewDemandReader({ clock: () => now });
  const ctx = { secrets: { resolve: async () => 'fixture-only' }, http: { fetch: async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    if (fail) throw new Error('private-detail');
    return { status: 200, json: async () => response([pull(1)]) };
  } } };
  const cfg = normalizeReviewDemand({ repositories: ['example/product'], tokenSecretRef: ref });
  assert.equal((await read(ctx, 'acme', cfg)).eligibleHeads, 1);
  now += 300_000; fail = true;
  assert.equal((await read(ctx, 'acme', cfg)).eligibleHeads, 0);
  assert.equal((await read(ctx, 'acme', null)).status, 'disabled');
  assert.equal(calls, 2);
});


test('fractional admitted slots combine within a shared reviewer pool', () => {
  const out = allocateKeptAndRoutedCaps({ target: 20, maxTotal: 75, demandFactor: 1,
    agents: [{ agentId: 'reviewer', running: 0, queued: 80 }],
    reviewerAccountIdsByAgent: { reviewer: ['codex:a', 'codex:b'] },
    accounts: [{ accountId: 'codex:a', pool: 'codex' }, { accountId: 'codex:b', pool: 'codex' }],
    perAccount: [{ accountId: 'codex:a', slots: 0.5 }, { accountId: 'codex:b', slots: 0.5 }],
    pacePools: [{ pool: 'codex', cap: 1 }],
  });
  assert.equal(out.kept.find(a => a.agentId === 'reviewer').allocated, 1);
});

test('a followed redirect response is refused even when it contains valid-looking demand', async () => {
  const read = createReviewDemandReader({ clock: () => NOW });
  const result = await read({ secrets: { resolve: async () => 'fixture-only' },
    http: { fetch: async () => ({ status: 200, redirected: true, json: async () => response([pull(1)]) }) } },
  'acme', normalizeReviewDemand({ repositories: ['example/product'], tokenSecretRef: ref }));
  assert.equal(result.status, 'unavailable');
});

test('hung host HTTP is bounded independently of RequestInit AbortSignal support', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const read = createReviewDemandReader({ clock: () => NOW });
  let settled = false;
  const pending = read({ secrets: { resolve: async () => 'fixture-only' },
    http: { fetch: async () => { signalStarted(); return new Promise(() => {}); } } },
  'acme', normalizeReviewDemand({ repositories: ['example/product'], tokenSecretRef: ref })).then(r => { settled = true; return r; });
  await started;
  t.mock.timers.tick(10_001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  assert.equal((await pending).status, 'unavailable');
});

test('backward clock movement cannot pin a positive backlog cache', async () => {
  let now = NOW;
  let calls = 0;
  const read = createReviewDemandReader({ clock: () => now });
  const ctx = { secrets: { resolve: async () => 'fixture-only' }, http: { fetch: async () => {
    calls++; return { status: 200, json: async () => response([pull(1)]) };
  } } };
  const cfg = normalizeReviewDemand({ repositories: ['example/product'], tokenSecretRef: ref });
  await read(ctx, 'acme', cfg);
  now--;
  await read(ctx, 'acme', cfg);
  assert.equal(calls, 2);
});

test('future admission snapshots cannot grant helper capacity', async () => {
  const cap = snapshot(); cap.atMs = NOW + 60_000;
  const d = await drive({ cap, nodes: [pull(1), pull(2), pull(3), pull(4)] });
  const body = await d.read();
  const row = body.agents.find(a => a.agentId === 'reviewer');
  assert.equal(row.maxConcurrentRuns, 1);
  assert.equal(body.reviewDemand.reason, 'review-admission-stale');
  assert.equal(d.calls.length, 0, 'stale capacity does not trigger live source work');
});


test('a reviewer without a current admission map cannot borrow unrestricted routed capacity', async () => {
  const cap = snapshot(); cap.keepAgentIds = []; delete cap.reviewerAccountIdsByAgent;
  const d = await drive({ cap, nodes: [pull(1), pull(2), pull(3), pull(4)] });
  const row = (await d.read()).agents.find(a => a.agentId === 'reviewer');
  assert.equal(row.maxConcurrentRuns, 1);
});


test('new fixed and helper reservations leave room for ordinary running floors', () => {
  const cap = snapshot();
  const out = allocateKeptAndRoutedCaps({ ...cap, target: 8, maxTotal: 8,
    agents: [{ agentId: 'fixed', running: 0, queued: 80 }, { agentId: 'reviewer', running: 0, queued: 80 }, { agentId: 'ordinary', running: 7, queued: 0 }],
    keepAgentIds: ['fixed'], keptByAgent: { fixed: { accountId: 'codex:a' } }, pacePools: cap.paceGuard.pools,
  });
  const rows = [...out.kept, ...out.routed];
  assert.equal(rows.find(a => a.agentId === 'ordinary').allocated, 7);
  assert.ok(rows.reduce((sum, a) => sum + a.allocated, 0) <= 8, JSON.stringify(rows));
});
