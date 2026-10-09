import test from 'node:test';
import assert from 'node:assert/strict';
import { orderAccountsForRun, allowanceOf, DEFAULT_PLACEMENT } from '../src/select.mjs';
import { decide, placementArm } from '../src/decide.mjs';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';

// Placement ignored model quality. 06:25-08:45Z two thirds
// of all runs went to Muse because Meta had the most unspent allowance.

const view = (accountId, partial = {}) => ({
  accountId, resetAtMs: null, headroomPct: 0.9, health: 'healthy',
  measuredRatePerHour: null, requiredRatePerHour: null, inFlight: 0, ...partial,
});
const ids = (views, opts) => orderAccountsForRun(views, opts).map(v => v.accountId);
const P = DEFAULT_PLACEMENT;

test('allowance is the unspent share of the pool target, bounded to [-1, 1]', () => {
  assert.equal(allowanceOf(5, 5), 1);
  assert.equal(allowanceOf(0, 5), 0);
  assert.equal(allowanceOf(-5, 5), -1);
  assert.equal(allowanceOf(40, 5), 1, 'bounded above');
  assert.equal(allowanceOf(-40, 5), -1, 'bounded below');
  assert.equal(allowanceOf(0.5, 0), 0.5, 'unknown target: share floors at 1');
});

test('a large quality gap beats the biggest unspent allowance', () => {
  // Meta: far more room (target 9, nothing running) but a weaker arm.
  const views = [
    view('meta:lane-1', { targetShare: 9, placementQ: -0.2 }),
    view('claude:a1', { targetShare: 2, inFlight: 1, placementQ: 1.1 }),
  ];
  assert.deepEqual(ids(views, { placement: P }), ['claude:a1', 'meta:lane-1']);
  // The old order (placement off) is the failure being fixed.
  assert.deepEqual(ids(views, { placement: null }), ['meta:lane-1', 'claude:a1']);
});

test('similar quality: unspent allowance breaks the tie', () => {
  const views = [
    view('a', { targetShare: 2, inFlight: 2, placementQ: 0.55 }),
    view('b', { targetShare: 6, inFlight: 0, placementQ: 0.45 }),
  ];
  assert.deepEqual(ids(views, { placement: P }), ['b', 'a']);
});

test('allowance cannot outbid a gap wider than twice its weight', () => {
  const gap = 2 * P.allowanceWeight + 0.05;
  const views = [
    view('best', { targetShare: 1, inFlight: 9, placementQ: gap }),
    view('worst', { targetShare: 9, inFlight: 0, placementQ: 0 }),
  ];
  assert.equal(ids(views, { placement: P })[0], 'best');
  const narrow = [
    view('best', { targetShare: 1, inFlight: 9, placementQ: 2 * P.allowanceWeight - 0.05 }),
    view('worst', { targetShare: 9, inFlight: 0, placementQ: 0 }),
  ];
  assert.equal(ids(narrow, { placement: P })[0], 'worst');
});

test('need bands still dominate quality: an ahead-of-plan account waits', () => {
  const views = [
    view('ahead', { targetShare: 9, placementQ: 2, measuredRatePerHour: 0.011, requiredRatePerHour: 0.01 }),
    view('behind', { targetShare: 1, placementQ: -1, measuredRatePerHour: 0.001, requiredRatePerHour: 0.01 }),
  ];
  assert.deepEqual(ids(views, { placement: P }), ['behind', 'ahead']);
});

test('qualityWeight 0, no placement, or no quality anywhere keeps the water-filling order', () => {
  const views = [
    view('a', { targetShare: 5, inFlight: 0, placementQ: -3 }),
    view('b', { targetShare: 1, inFlight: 0, placementQ: 3 }),
  ];
  const legacy = ids(views, {});
  assert.deepEqual(ids(views, { placement: { qualityWeight: 0, allowanceWeight: 0.35 } }), legacy);
  assert.deepEqual(ids(views, { placement: null }), legacy);
  const noQ = views.map(v => ({ ...v, placementQ: null }));
  assert.deepEqual(ids(noQ, { placement: P }), legacy);
});

test('ten sequential picks: better arm first, spare capacity still gets used', () => {
  // Targets 6 (strong arm) / 6 (weaker arm); the strong arm takes the early
  // runs, but once it is full the weaker one is used rather than idling.
  const state = { strong: 0, weak: 0 };
  const picks = [];
  for (let i = 0; i < 12; i++) {
    const [w] = orderAccountsForRun([
      view('strong', { targetShare: 6, inFlight: state.strong, placementQ: 0.6 }),
      view('weak', { targetShare: 6, inFlight: state.weak, placementQ: 0.2 }),
    ], { placement: P });
    state[w.accountId] += 1;
    picks.push(w.accountId);
  }
  assert.equal(picks[0], 'strong');
  assert.ok(state.strong > state.weak, JSON.stringify(state));
  assert.ok(state.weak >= 3, `the weaker account is not starved: ${JSON.stringify(state)}`);
});

test('pools: lanes share one candidate -- shares sum, in-flight is the pool count', () => {
  // Eight Meta lanes, share 1 each, 6 runs in the pool: pool shortfall 8 - 6
  // = 2 for every lane. A lone claude lane with share 3, none running (3).
  // Pre-pool the lane compared ITS share (1) with the pool count (6) and
  // every Meta lane read -5.
  const meta = Array.from({ length: 8 }, (_, i) =>
    view(`meta:lane-${i + 1}`, { pool: 'meta', targetShare: 1, inFlight: 6 }));
  const claude = view('claude:a1', { pool: 'claude', targetShare: 3, inFlight: 0 });
  assert.equal(ids([...meta, claude], {})[0], 'claude:a1');
  // Give Meta a 3-run pool count: 8 - 3 = 5 beats claude's 3.
  const quiet = meta.map(v => ({ ...v, inFlight: 3 }));
  assert.ok(ids([...quiet, claude], {})[0].startsWith('meta:'));
});

test('inside a pool the least-loaded lane is picked, so decisions spread over lanes', () => {
  const lanes = [
    view('meta:lane-1', { pool: 'meta', targetShare: 1, inFlight: 4, laneInFlight: 4 }),
    view('meta:lane-2', { pool: 'meta', targetShare: 1, inFlight: 4, laneInFlight: 0 }),
    view('meta:lane-3', { pool: 'meta', targetShare: 1, inFlight: 4, laneInFlight: 2 }),
  ];
  assert.deepEqual(ids(lanes, {}), ['meta:lane-2', 'meta:lane-3', 'meta:lane-1']);
});

// --- placementArm: the arm decide() would pick, scored on the fleet scale.

const arm = (armId, family, Q, qFleet, extra = {}) =>
  ({ armId, model: armId, effort: 'max', family, Q, qFleet, C: 1, trial: false, contextWindow: 1000000, ...extra });
const bands = { thinker: { floorRung: 2, ceilingRung: null }, doer: { floorRung: 0, ceilingRung: null } };

test('placementArm reports the fleet quality of the arm decide() picks', () => {
  const rungs = [
    { rung: 0, arms: [arm('haiku', 'haiku', 0, -0.4)] },
    { rung: 1, arms: [arm('sonnet-a', 'sonnet', 0.2, 0.3), arm('sonnet-b', 'sonnet', 0.5, 0.6)] },
    { rung: 2, arms: [arm('opus', 'opus', 1, 1.2)] },
  ];
  assert.deepEqual(placementArm(rungs, { role: 'doer', roleBands: bands, pointer: 1 }), { armId: 'sonnet-b', family: 'sonnet', rung: 1, quality: 0.6 });
  // Thinkers are floored at rung 2.
  assert.equal(placementArm(rungs, { role: 'thinker', roleBands: bands, pointer: 0 }).armId, 'opus');
  // Excluded families fall through to the next rung down.
  assert.equal(placementArm(rungs, { role: 'doer', roleBands: bands, pointer: 2, excludedFamilies: ['opus'] }).armId, 'sonnet-b');
  // Nothing reachable.
  assert.equal(placementArm(rungs, { role: 'thinker', roleBands: bands, pointer: 2, excludedFamilies: ['opus'] }), null);
});

test('thinkers score on the thinker blend', () => {
  const rungs = [{ rung: 0, arms: [arm('a', 'x', 0, 0.1, { qThinker: 0.2, qFleetThinker: 0.9 })] }];
  const flat = { thinker: { floorRung: 0, ceilingRung: null }, doer: { floorRung: 0, ceilingRung: null } };
  assert.equal(placementArm(rungs, { role: 'thinker', roleBands: flat, pointer: 0 }).quality, 0.9);
  assert.equal(placementArm(rungs, { role: 'doer', roleBands: flat, pointer: 0 }).quality, 0.1);
});

test('placementArm picks the same arm as decide() (headroom ample, no trial arms)', () => {
  const rungs = [
    { rung: 0, arms: [arm('haiku', 'haiku', 0, -0.4), arm('muse', 'muse', 0.9, 0.2)] },
    { rung: 1, arms: [arm('sonnet-a', 'sonnet', 0.2, 0.3), arm('sonnet-b', 'sonnet', 0.5, 0.6)] },
    { rung: 2, arms: [arm('opus', 'opus', 1, 1.2)] },
  ];
  const burn = Object.fromEntries(rungs.flatMap(g => g.arms).map(a => [a.armId, 0.0005]));
  for (const role of ['doer', 'thinker', 'other']) {
    for (const excludedFamilies of [[], ['muse'], ['opus'], ['sonnet', 'opus']]) {
      for (const pointer of [0, 1, 2]) {
        const placed = placementArm(rungs, { role, roleBands: bands, excludedFamilies, pointer });
        const d = decide({
          runId: 'r', agentId: 'a', role, ladderRungs: rungs, excludedFamilies, pointer,
          fiveHourHeadroomPct: 0.9, burnPerRunPct: burn, reservePct: 0.05, accountId: 'x', roleBands: bands,
        });
        assert.equal(placed?.armId ?? null, d.kind === 'decide' ? d.armId : null, `${role} ${excludedFamilies} p${pointer}`);
      }
    }
  }
});

test('trial arms are placed only for trial roles', () => {
  const rungs = [{ rung: 0, arms: [arm('oss', 'oss', 0, 0.5, { trial: true })] }];
  assert.equal(placementArm(rungs, { role: 'doer', roleBands: bands, pointer: 0, trialRoles: ['doer'] }).armId, 'oss');
  assert.equal(placementArm(rungs, { role: 'thinker', roleBands: { ...bands, thinker: { floorRung: 0 } }, pointer: 0, trialRoles: ['doer'] }), null);
});

// --- config

test('placement config: defaults, overrides, validation', () => {
  assert.deepEqual(resolveConfig({}).placement, { qualityWeight: 1, allowanceWeight: 0.35 });
  assert.deepEqual(resolveConfig({ placement: { qualityWeight: 0 } }).placement, { qualityWeight: 0, allowanceWeight: 0.35 });
  assert.deepEqual(validateConfigShape({ placement: { qualityWeight: 2, allowanceWeight: 0.1 } }), []);
  for (const bad of [{ placement: 'x' }, { placement: { qualityWeight: -1 } }, { placement: { allowanceWeight: 'a' } }]) {
    assert.ok(validateConfigShape(bad).length > 0, JSON.stringify(bad));
  }
});

// --- plugin wiring: Meta has by far the most unspent allowance but the
// weaker arm; Claude has little room but the stronger arm.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const aaRows = () => ([
  { slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 40, intelligenceIndexCostPerTask: 40, price1mInputTokens: 2, price1mOutputTokens: 8 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 60, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);
const lane = (laneName, provider, key, weeklyUsed, models) => ({
  lane: laneName, provider, accountKey: key, health: 'healthy', models,
  weekly: { used: weeklyUsed, resetsAt: '2026-10-15T22:59:00Z' },
  fiveHour: { used: 0.05, resetsAt: '2026-10-09T03:59:00Z' },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
});

function drive({ config = {} } = {}) {
  const store = new Map();
  const jobs = new Map();
  const skey = k => JSON.stringify(k);
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          observedAt: new Date(TICK).toISOString(),
          accounts: [
            lane('meta-1', 'meta', 'm1', 0.05, ['muse-spark-1.3-contributor']),
            lane('claude-1', 'claude', 'a1', 0.9, ['claude-haiku-5-5']),
          ],
        }),
      }),
    },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on() {} },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => TICK });
  return {
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_SKEY), { fetchedAt: new Date(TICK).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    hook: (runId, agentId = 'eng') => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId, issueId: null, adapterType: 'claude-code',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500,
    }),
    capacity: () => plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' }),
  };
}

test('the hook places on the stronger arm even though the weaker account has the most room', async () => {
  const d = drive({ config: { enforce: true } });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1');
  assert.equal(h.kind, 'decide');
  assert.match(h.model, /haiku/, `placed on ${h.model}`);
  // Switching the blend off restores the old pick (Meta: most unspent allowance).
  const off = drive({ config: { enforce: true, placement: { qualityWeight: 0 } } });
  await off.setup();
  await off.tick();
  const h0 = await off.hook('run-1');
  assert.match(h0.model, /muse-spark/, `placed on ${h0.model}`);
});

test('/capacity carries the fleet quality of each rung arm', async () => {
  const d = drive({ config: { enforce: true } });
  await d.setup();
  await d.tick();
  const cap = await d.capacity();
  const arms = cap.body.accounts.flatMap(a => a.arms);
  const haiku = arms.find(a => a.model === 'claude-haiku-5-5');
  const muse = arms.find(a => a.model.startsWith('muse-spark'));
  assert.ok(Number.isFinite(haiku.qFleet) && Number.isFinite(muse.qFleet));
  assert.ok(haiku.qFleet > muse.qFleet);
});
