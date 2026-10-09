import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Per-role target, smoothing and pooled calibration end to end through the shadow tick, on the live
// shape of 2026-10-09: eight Meta lanes behind one round-robin pool (every
// Muse run is recorded on lane-1), a lane that only serves gpt-oss, and a
// Claude lane thinkers and doers can both use.

const T0 = Date.parse('2026-10-09T12:00:00Z');
const MIN = 60 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const aaRows = () => ([
  { slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 60, intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 66, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gpt-oss-120b', intelligenceIndex: 33, intelligenceIndexCostPerTask: 4, price1mInputTokens: 0.1, price1mOutputTokens: 0.4 },
]);

const META_LANES = 8;
const lane = (o, now) => ({
  lane: o.lane, provider: o.provider, accountKey: o.key, health: 'healthy', models: o.models,
  pool: o.pool ?? null,
  weekly: { used: o.weekly, resetsAt: new Date(T0 + 4 * 24 * 60 * MIN).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(now + 4 * 60 * MIN).toISOString() },
  observedAt: new Date(now).toISOString(), quality: 'live',
});

// Each Meta lane burns `metaDeltaPerStep` of its own weekly quota per step;
// the Claude lane burns more per run (it is the expensive arm).
function fleet({ now, step, metaDeltaPerStep = 0.002 }) {
  const lanes = [];
  for (let i = 1; i <= META_LANES; i++) {
    lanes.push(lane({
      lane: `meta-lane-${i}`, provider: 'meta', key: `meta-lane-${i}`,
      models: ['muse-spark-1.3-contributor'], weekly: 0.24 + step * metaDeltaPerStep,
    }, now));
  }
  lanes.push(lane({
    lane: 'claude-lane-1', provider: 'claude', key: 'claude-lane-1',
    models: ['claude-sonnet-5-5'], weekly: 0.2 + step * 0.01,
  }, now));
  lanes.push(lane({
    lane: 'antigravity-lane-2', provider: 'antigravity', key: 'antigravity-lane-2', pool: 'partner',
    models: ['gpt-oss-120b'], weekly: 0.05,
  }, now));
  return lanes;
}

const startedEvt = (runId, atMs, agentId, model) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId, model } }, occurredAt: new Date(atMs).toISOString(),
});

function drive({ config = {}, queued = null, issuesList = null } = {}) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = T0;
  let accounts = [];
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ observedAt: new Date(now).toISOString(), accounts }) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: {
      get: async () => null,
      list: async ({ status }) => {
        if (issuesList) return issuesList(status);
        return (queued?.[status] ?? []);
      },
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_SKEY), { fetchedAt: new Date(T0).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    store,
    // One minute-tick at `at` with the lane payload for `step`.
    step: async ({ at, step, metaDeltaPerStep, fire = [] }) => {
      now = at;
      accounts = fleet({ now, step, metaDeltaPerStep });
      for (const e of fire) await handlers.get(e.type)(e);
      await jobs.get('shadow-tick')({});
    },
    capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body,
    caps: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'caps' })).body,
    setNow: (t) => { now = t; },
  };
}

const ROLES_CONFIG = {
  roles: {
    thinkerAgentIds: ['planner'],
    doerAgentIds: ['eng'],
    excludeFamilies: { doer: ['oss'], thinker: ['muse'], other: [] },
  },
};
const issue = (id, assigneeAgentId, status = 'todo') => ({ id, assigneeAgentId, status });

// 13 Muse runs started over the 24-minute span, all recorded on the first
// Meta lane the model maps to.
const museRuns = () => Array.from({ length: 13 }, (_, i) =>
  startedEvt(`muse-${i}`, T0 + 1 * MIN + i * MIN, 'eng', 'muse-spark-1.3-contributor'));

async function runScenario(d, { extraSteps = 0 } = {}) {
  await d.setup();
  await d.step({ at: T0, step: 0 });
  await d.step({ at: T0 + 12 * MIN, step: 1, fire: museRuns() });
  await d.step({ at: T0 + 24 * MIN, step: 2 });
  for (let i = 0; i < extraSteps; i++) await d.step({ at: T0 + (36 + 12 * i) * MIN, step: 3 + i });
  return d.capacity();
}

test('#4 the eight Meta lanes calibrate as one pool with the full per-run burn', async () => {
  const d = drive({ config: ROLES_CONFIG, queued: { todo: [issue('i1', 'eng')], in_progress: [] } });
  const cap = await runScenario(d);
  const metaRows = cap.perAccount.filter(a => a.accountId.startsWith('meta:'));
  assert.equal(metaRows.length, META_LANES);
  const groupId = metaRows[0].calibrationGroup;
  assert.ok(metaRows.every(r => r.calibrationGroup === groupId), 'one group');
  // Every lane measured, every lane the same E -- before, only lane-1 had
  // one and the other seven sat on the anchor.
  assert.ok(metaRows.every(r => r.calibrated === true && r.reason === 'ok'), JSON.stringify(metaRows.map(r => r.reason)));
  const E = metaRows[0].measuredBurnPerRunPct;
  assert.ok(metaRows.every(r => r.measuredBurnPerRunPct === E));
  const group = cap.calibrationGroups[groupId];
  assert.equal(group.members, META_LANES);
  assert.equal(group.contributing, META_LANES);
  // 8 lanes x 0.004 weekly over the 24 min span / 13 runs; the legacy
  // per-lane figure would be one eighth of that.
  const expected = (META_LANES * 0.004) / group.runs;
  assert.ok(Math.abs(group.rawBurnPerRunPct - expected) < 1e-9, `${group.rawBurnPerRunPct} vs ${expected}`);
  assert.ok(group.runs >= 13);
});

const queue = (agent, n) => Array.from({ length: n }, (_, i) => issue(`${agent}-${i}`, agent));

test('#1 capacity no role can use adds nothing; the report keeps the quota-only sum', async () => {
  const d = drive({
    config: ROLES_CONFIG,
    queued: { todo: [...queue('eng', 30), ...queue('planner', 30)], in_progress: [] },
  });
  const cap = await runScenario(d);
  assert.equal(cap.demandSource, 'issues');
  assert.deepEqual([cap.roles.doer.demand, cap.roles.thinker.demand], [30, 30]);
  const ag = cap.perAccount.find(a => a.accountId.startsWith('antigravity:'));
  // Doers exclude oss; oss is a trial arm thinkers never take. Only 'other'
  // agents may run trials there, and none has queued work.
  assert.deepEqual(ag.eligibleRoles, ['other']);
  assert.equal(ag.trialOnly, true);
  assert.ok(ag.usableSlots <= 2 + 1e-9, 'a trial-only lane never counts past the trial cap');
  // Thinkers exclude Meta: only the Claude lane serves them.
  const meta = cap.perAccount.find(a => a.accountId === 'meta:meta-lane-1');
  assert.ok(meta.eligibleRoles.includes('doer'));
  assert.ok(!meta.eligibleRoles.includes('thinker'));
  assert.ok(cap.roles.thinker.accounts === 1 && cap.roles.doer.accounts >= META_LANES);
  assert.ok(cap.targetUnweighted >= cap.targetRaw, `${cap.targetUnweighted} < ${cap.targetRaw}`);
  // Deep queues on both roles: the served target is every slot a queued role
  // can use, and the lane only 'other' agents could use (nobody queued) is
  // out of the bound.
  const usable = cap.perAccount.filter(r => r.eligibleRoles.some(x => x !== 'other')).reduce((sum, r) => sum + r.usableSlots, 0);
  assert.ok(Math.abs(cap.demandBound - usable) < 1e-9, `bound ${cap.demandBound} vs ${usable}`);
  assert.ok(cap.target > 0 && cap.target <= cap.demandBound + 1e-9);
});

test('#1 with only thinker work queued, Meta capacity drops out of the served target', async () => {
  const doerWork = drive({ config: ROLES_CONFIG, queued: { todo: queue('eng', 40), in_progress: [] } });
  const thinkerWork = drive({ config: ROLES_CONFIG, queued: { todo: queue('planner', 40), in_progress: [] } });
  const [a, b] = [await runScenario(doerWork), await runScenario(thinkerWork)];
  // The capacity series does not move with the queue; the bound does.
  assert.ok(Math.abs(a.targetRaw - b.targetRaw) < 1e-9, 'queue composition does not move the capacity target');
  assert.ok(b.demandBound < a.demandBound, `thinker-only ${b.demandBound} should be below doer-only ${a.demandBound}`);
  const claude = b.perAccount.find(r => r.accountId === 'claude:claude-lane-1');
  assert.ok(Math.abs(b.demandBound - claude.slots) < 1e-9, 'only the Claude lane counts for thinkers');
  assert.ok(b.target <= b.demandBound + 1e-9);
});

test('#1 a queue surge lifts the served target at once, not on the EWMA half-life', async () => {
  // Thin queue: the served target is bounded by the few queued issues.
  const queued = { todo: queue('eng', 2), in_progress: [] };
  const d = drive({ config: ROLES_CONFIG, queued });
  const thin = await runScenario(d);
  assert.ok(thin.demandBound <= 2 + 1e-9, `thin bound ${thin.demandBound}`);
  assert.ok(thin.target <= 2 + 1e-9);
  // 60 more issues arrive. The capacity series is unchanged, so the
  // smoothed value does not lag: the served target jumps to the new bound.
  queued.todo = queue('eng', 60);
  await d.step({ at: T0 + 25 * MIN, step: 2 });
  const surge = await d.capacity();
  assert.ok(surge.demandBound > thin.demandBound + 1, `bound ${surge.demandBound}`);
  assert.ok(Math.abs(surge.target - Math.min(surge.demandBound, surge.smoothing.target ?? surge.targetRaw)) < 1.0 || surge.target > thin.target + 1,
    `served ${surge.target} should follow the queue, was ${thin.target}`);
  assert.ok(surge.target > 2 + 1, `served target ${surge.target} must not stay at the thin-queue level`);
});

test('#1 an unreadable queue counts any capacity some role can use, never a hollow target', async () => {
  const d = drive({ config: ROLES_CONFIG, issuesList: () => { throw new Error('boom'); } });
  const cap = await runScenario(d);
  assert.equal(cap.demandSource, 'unavailable');
  assert.ok(cap.targetRaw > 0);
});

test('#1 an uncalibrated anchor lane cannot out-mint a measured peer', async () => {
  const d = drive({ config: ROLES_CONFIG, queued: { todo: [issue('i1', 'eng')], in_progress: [] } });
  const cap = await runScenario(d);
  assert.ok(cap.medianMeasuredBurnPct > 0);
  for (const row of cap.perAccount.filter(r => r.reason === 'anchor-fallback')) {
    assert.ok(row.burnPerRunPct >= cap.medianMeasuredBurnPct - 1e-12, `${row.accountId} burn ${row.burnPerRunPct}`);
  }
});

test('#3 the served target is smoothed and the series is persisted', async () => {
  const d = drive({ config: ROLES_CONFIG, queued: { todo: [issue('i1', 'eng'), issue('i2', 'planner')], in_progress: [] } });
  const first = await runScenario(d);
  const persisted = d.store.get(JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'smoothing-v1' }));
  assert.ok(persisted && persisted.target && Number.isFinite(persisted.target.value));
  assert.ok(Object.keys(persisted.E).length >= 1);
  // A sudden burn jump moves the raw target; the served one moves less.
  await d.step({ at: T0 + 36 * MIN, step: 3, metaDeltaPerStep: 0.02 });
  const next = await d.capacity();
  const rawMove = Math.abs(next.targetRaw - first.targetRaw);
  const servedMove = Math.abs(next.target - first.target);
  assert.ok(rawMove > 0, 'the burn jump changes the raw target');
  assert.ok(servedMove < rawMove, `served ${servedMove} should move less than raw ${rawMove}`);
});

test('#3 a missing sample keeps the smoothed E instead of flipping calibration to weak', async () => {
  const d = drive({ config: ROLES_CONFIG, queued: { todo: [issue('i1', 'eng')], in_progress: [] } });
  const first = await runScenario(d);
  assert.notEqual(first.calibration, 'weak');
  // No new runs and flat usage: no measurable delta this tick.
  await d.step({ at: T0 + 36 * MIN, step: 2 });
  const next = await d.capacity();
  assert.notEqual(next.calibration, 'weak');
  assert.ok(next.target > 0);
});

test('#3 /caps holds the served wants: a dip does not drop the cap on the spot', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => issue(`q${i}`, 'eng'));
  const queue = { todo: many(12), in_progress: [] };
  const d = drive({ config: ROLES_CONFIG, queued: queue });
  await runScenario(d);
  // Finish the Muse runs so the caps run in the demand-following regime.
  const done = museRuns().map(e => ({ ...e, type: 'agent.run.finished', occurredAt: new Date(T0 + 25 * MIN).toISOString() }));
  await d.step({ at: T0 + 25 * MIN, step: 2, fire: done });
  const eng = (b) => b.agents.find(a => a.agentId === 'eng');
  const high = eng(await d.caps());
  assert.ok(high && high.allocated >= 12, JSON.stringify(high));
  // Five minutes later the queue has dipped to 3 (live: 16 -> 13 -> 9).
  queue.todo = many(3);
  d.setNow(T0 + 30 * MIN);
  const dip = eng(await d.caps());
  assert.equal(dip.baseAllocated ?? dip.allocated, 3, 'the unheld want is the new demand');
  assert.ok(dip.allocated > 3, `held above the dip: ${dip.allocated}`);
  assert.ok(dip.allocated <= high.allocated);
  assert.equal(dip.reason, 'held');
  // Hours later the hold has decayed to the want.
  d.setNow(T0 + 6 * 60 * MIN);
  const later = eng(await d.caps());
  assert.equal(later.allocated, 3);
});
