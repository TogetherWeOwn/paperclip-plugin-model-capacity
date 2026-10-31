import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';
import { NOW, OPUS, config, lane, rows } from './weekly-compatibility-fixture.mjs';

const REF = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const FREE = 'nvidia-nim/step-5-preview-nim';
const key = stateKey => JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
const row = (body, agentId = 'ordinary') => {
  const found = body.agents.find(entry => entry.agentId === agentId);
  assert.ok(found, `the real ${agentId} running/demand row must exist`);
  assert.equal(found.maxConcurrentRuns, found.allocated);
  return found;
};
const check = name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const reviewHead = number => {
  const oid = String(number).padStart(40, '0');
  return { number, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: {
      contexts: { nodes: [check('ci-ok'), check('pr-lint')], pageInfo: { hasNextPage: false } },
    } } }] } };
};

// Only external SDK/feed IO is synthetic. The same plugin instance produces,
// fails to refresh, consumes its exact last-good blob, and recovers for real.
async function produced({ holds = true, constrained = true, kind = 'ordinary', reserved = false, reviewHeads = false } = {}) {
  let current = config(), now = NOW, fail = false, failures = 0, publicationRead = null;
  current.concurrency.meanRunDurationHours = 4;
  if (!holds) current.pacing = { holdAheadPts: null };
  if (!constrained) {
    current.roles.keepAgentIds = [];
    delete current.reviewerRouting;
    current.reviewReserve.agentIds = [];
  }
  if (kind === 'burn') current.burnMode = { accounts: ['claude:one'] };
  if (reserved) current.caps = { reservedFloors: { ordinary: { base: 4, perQueued: 1, max: 8 } } };
  if (kind === 'free') {
    current.taskRanking.mode = 'off';
    current.roles.minQuality = { doer: .4, thinker: .4, other: .4 };
    current.freeLanes = { enabled: true, lowRiskAgentIds: ['ordinary'], providers: {
      'nvidia-nim': { requestsPerMinute: 36, requestsPerMinutePerSlot: 12 },
    } };
    current.placement = { freeCostProviders: ['nvidia-nim'] };
    current.modelAaOverrides = { 'step-5-preview-nim': { slug: 'step-5', effort: 'max' } };
  }
  if (reviewHeads) current.reviewDemand = { enabled: true, repositories: ['example/product'],
    tokenSecretRef: REF, requiredChecks: ['ci-ok', 'pr-lint'] };
  const accounts = [lane('one', kind === 'burn' ? .85 : .3, kind === 'burn' ? 120 : 84)];
  if (kind === 'free') accounts.push({ lane: 'n1', accountKey: 'n1', provider: 'nvidia-nim',
    meter: 'reactive', plan: 'free', health: 'healthy', models: [FREE],
    weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
    observedAt: new Date(NOW).toISOString(), quality: 'live' });
  const store = new Map(), jobs = new Map(), events = new Map();
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  const io = {
    config: { get: async () => ({ ...current, cliproxy: { laneKeySecretRef: REF } }) },
    state: { get: async k => {
      if (k.stateKey === 'capacity-v1' && publicationRead) {
        const duringRead = publicationRead; publicationRead = null; await duringRead();
      }
      return store.get(JSON.stringify(k)) ?? null;
    }, set: async (k, value) => { store.set(JSON.stringify(k), value); } },
    secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async url => {
      if (url === 'https://api.github.com/graphql') return { status: 200, json: async () => ({
        data: { repository: { pullRequests: { nodes: [reviewHead(1), reviewHead(2)],
          pageInfo: { hasNextPage: false, endCursor: null } } } },
      }) };
      assert.match(url, /\/telemetry\/cliproxy\/live\/accounts\.json$/);
      if (fail) { failures++; throw new Error('synthetic-refresh-failed'); }
      return { status: 200, json: async () => withSyntheticReadiness({
        observedAt: new Date(now).toISOString(), servedModels: [OPUS, FREE],
        accounts: accounts.map(account => ({ ...account, observedAt: new Date(now).toISOString() })),
      }, now, { emitted: ['step-5-preview-nim'] }) };
    } },
    agents: { get: async () => ({ adapterType: 'claude-code' }), getQueuedRunCounts: async () => reviewHeads ? [{ agentId: 'review', queued: 0 }] : [] },
    issues: { get: async () => null, list: async ({ status }) => status === 'todo' && (reserved || kind === 'free')
      ? Array.from({ length: 4 }, (_, i) => ({ id: `ordinary-queued-${i}`, status: 'todo',
        assigneeAgentId: 'ordinary', blockedBy: [] })) : [] },
    jobs: { register: (name, fn) => jobs.set(name, fn) },
    events: { on: (name, fn) => events.set(name, fn) }, logger: { info() {}, warn() {}, error() {} },
  };
  const paidRows = kind === 'free' ? [{ slug: OPUS, intelligenceIndex: 62,
    intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 }] : rows();
  store.set(key('aa-snapshot-v1'), { fetchedAt: new Date(NOW).toISOString(), duplicateSlugs: [], rows: [
    ...paidRows, { slug: 'step-5', intelligenceIndex: 72, intelligenceIndexCostPerTask: 9,
      price1mInputTokens: 1, price1mOutputTokens: 4 },
  ] });
  await plugin.setup(io);
  assert.deepEqual(await plugin.onValidateConfig(current), { ok: true });
  await plugin.onConfigChanged(current, { companyId: 'acme' });
  const api = async routeKey => {
    const response = await plugin.onApiRequest({ companyId: 'acme', routeKey });
    assert.equal(response.status, 200); return response.body;
  };
  const d = {
    store, current: () => current, snapshot: () => store.get(key('capacity-v1')),
    setNow: value => { now = value; }, failures: () => failures,
    fail: value => { fail = value; }, seed: snapshot => store.set(key('capacity-v1'), snapshot),
    tick: () => jobs.get('quota-refresh')({ companyId: 'acme' }),
    caps: () => api('caps'), capacity: () => api('capacity'),
    duringPublicationRead: fn => { publicationRead = fn; },
    configure: async next => { current = next; await plugin.onConfigChanged(next, { companyId: 'acme' }); },
    size: () => {
      const snapshot = d.snapshot(); snapshot.target = 8; snapshot.calibration = 'measured';
      for (const account of snapshot.perAccount) account.slots = 8;
      if (constrained) snapshot.keptByAgent.fixed = { accountId: 'claude:one' };
    },
  };
  await d.tick();
  await events.get('agent.run.started')({ type: 'agent.run.started', companyId: 'acme',
    entityId: 'ordinary-publication-running', occurredAt: new Date(now).toISOString(),
    payload: { run: { agentId: 'ordinary', provider: 'claude', model: OPUS } } });
  await d.tick(); d.size();
  const fresh = await d.caps();
  assert.equal(row(fresh).running, 1, 'a real event-backed ordinary running row, not heartbeat-only demand');
  assert.equal(d.snapshot().agentRunning.ordinary.running, 1);
  assert.ok(!d.snapshot().keepAgentIds.includes('ordinary'));
  assert.ok(!Object.hasOwn(d.snapshot().reviewerAccountIdsByAgent, 'ordinary'));
  if (holds && constrained) assert.deepEqual(d.snapshot().weeklyRouteFacts.hardHeldAccountIds, [], 'these credentials are not weekly-held');
  return { d, fresh };
}

async function failedReplay(d, age = 120001) {
  const lastGood = structuredClone(d.snapshot());
  d.fail(true); d.setNow(NOW + age);
  const before = d.failures();
  await d.tick().catch(error => assert.match(error.message, /quota-refresh-failed|synthetic-refresh-failed/));
  assert.equal(d.failures(), before + 1, 'a real refresh request must actually fail');
  d.seed(lastGood);
  assert.deepEqual(d.snapshot(), lastGood, 'consumer sees the exact last-good publication, without forged provenance');
  return d.caps();
}

for (const kind of ['ordinary', 'free', 'burn']) {
  test(`unavailable hold evidence contracts the complete ${kind} publication to real running floors`, async t => {
    const { d, fresh } = await produced({ kind });
    if (kind === 'free') t.diagnostic(JSON.stringify({ fresh, free: (await d.capacity()).freeLanes }));
    assert.ok(row(fresh).allocated > 1, 'fresh useful headroom exists before the failure');
    if (kind === 'ordinary') assert.equal(row(fresh).allocated, 2);
    const capacity = await d.capacity();
    if (kind === 'free') {
      assert.equal(capacity.freeLanes.target, 3, 'real additional free-lane headroom is enabled');
      assert.equal(row(fresh).freeAllocated, 3, 'the fresh publication actually grants the free headroom');
      assert.equal(row(fresh).allocated, 4, 'three free slots are additional to the real running floor');
    }
    if (kind === 'burn') assert.equal(capacity.accounts.find(account => account.accountId === 'claude:one').burnMode, true);
    const stale = await failedReplay(d);
    t.diagnostic(JSON.stringify({ kind, fresh: fresh.agents, stale }));
    assert.equal(stale.target, null);
    assert.equal(stale.capsError, 'weekly-hold-evidence-unavailable');
    assert.equal(row(stale).allocated, 1);
    assert.equal(row(stale).running, 1);
    assert.equal(row(stale).reason, 'weekly-hold-evidence-unavailable');
    if (kind === 'free') assert.equal(row(stale).freeAllocated ?? 0, 0);
    for (const entry of stale.agents) assert.equal(entry.allocated, entry.running);
    assert.deepEqual(d.snapshot().weeklyRouteFacts.hardHeldAccountIds, [], 'publication failure is not a held-credential relabelling');
    d.fail(false); await d.tick(); d.size();
    assert.equal(d.snapshot().atMs, NOW + 120001, 'the same instance publishes a new compatible refresh');
    const recovered = await d.caps();
    assert.equal(recovered.capsError, undefined);
    assert.equal(row(recovered).running, 1);
    assert.ok(row(recovered).allocated > 1, 'fresh recovery removes the temporary publication fence');
    if (kind === 'free') assert.equal(row(recovered).freeAllocated, 3);
  });
}

for (const option of ['disabled-hold', 'no-constrained-identities']) {
  test(`stale-only floor trigger preserves useful ${option} behavior`, async t => {
    const { d, fresh } = await produced({ holds: option !== 'disabled-hold', constrained: option !== 'no-constrained-identities' });
    assert.equal(row(fresh).allocated, 2);
    if (option === 'disabled-hold') assert.equal(d.snapshot().paceGuard.holdAheadPts, null);
    else {
      assert.deepEqual(d.snapshot().keepAgentIds, []);
      assert.deepEqual(d.snapshot().reviewerAccountIdsByAgent ?? {}, {});
    }
    const stale = await failedReplay(d);
    t.diagnostic(JSON.stringify({ option, fresh: fresh.agents, stale }));
    assert.equal(stale.capsError, undefined);
    assert.equal(row(stale).running, 1);
    assert.equal(row(stale).allocated, 2, 'do not broaden the hold-specific publication trigger');
  });
}

test('still-fresh last-good ordinary publication remains useful immediately before the freshness limit', async () => {
  const { d, fresh } = await produced();
  assert.equal(row(fresh).allocated, 2);
  const withinWindow = await failedReplay(d, 119999);
  assert.equal(withinWindow.capsError, undefined);
  assert.equal(row(withinWindow).allocated, 2);
});

test('cached smoothing and reserved floors cannot restore a new slot after the unavailable-evidence fence', async t => {
  const { d, fresh } = await produced({ reserved: true });
  assert.ok(row(fresh).allocated >= 4);
  assert.ok(row(fresh).floor >= 4, 'a configured reserved floor genuinely exists');
  await d.caps();
  const stale = await failedReplay(d);
  t.diagnostic(JSON.stringify({ fresh, stale }));
  assert.equal(stale.capsError, 'weekly-hold-evidence-unavailable');
  assert.equal(row(stale).running, 1);
  assert.equal(row(stale).allocated, 1);
  assert.equal(row(stale).reason, 'weekly-hold-evidence-unavailable');
});

test('fresh eligible review-head credit cannot reopen the unavailable weekly publication', async t => {
  const { d, fresh } = await produced({ reviewHeads: true });
  assert.equal(fresh.reviewDemand.status, 'ok');
  assert.equal(row(fresh, 'review').reviewEligibleHeads, 2);
  assert.ok(row(fresh, 'review').allocated > row(fresh, 'review').running);
  const stale = await failedReplay(d);
  t.diagnostic(JSON.stringify({ fresh, stale }));
  assert.equal(stale.capsError, 'weekly-hold-evidence-unavailable');
  assert.equal(stale.reviewDemand.eligibleHeads, 0);
  assert.equal(row(stale, 'ordinary').allocated, 1);
  const staleReview = stale.agents.find(entry => entry.agentId === 'review');
  assert.equal(staleReview?.allocated ?? 0, 0, 'unavailable demand cannot recreate a non-running reviewer');
  for (const entry of stale.agents) assert.equal(entry.allocated, entry.running);
});

for (const holds of [false, true]) {
  test(`configuration generation changed during publication IO denies every new slot (holds=${holds})`, async t => {
    const { d, fresh } = await produced({ holds });
    assert.equal(row(fresh).allocated, 2);
    d.duringPublicationRead(() => d.configure({ ...d.current(), concurrency: { ...d.current().concurrency, maxTotal: 7 } }));
    const changed = await d.caps();
    t.diagnostic(JSON.stringify(changed));
    assert.equal(row(changed).running, 1);
    assert.equal(row(changed).allocated, 1, 'the configuration fence is independent of hold enablement');
    for (const entry of changed.agents) assert.equal(entry.allocated, entry.running);
    assert.match(JSON.stringify(changed), /config|generation|changed/);
  });
}
