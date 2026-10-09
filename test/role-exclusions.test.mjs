import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, normalizeExcludedFamilies, filterRungsByExcludedFamilies, rungsHaveEligibleArms } from '../src/decide.mjs';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';

// Role-based family exclusions (live: doers on muse-spark hit the Muse
// early-stop, succeeding in 2-3 min with no tool calls and no source work).
// Default (no config): bit-identical behavior, non-thinker = doer.

const T0 = 1_750_000_000_000;
const MIN = 60 * 1000;
const arm = (armId, model, family, Q) => ({ armId, model, effort: 'max', family, Q, C: 1, contextWindow: 1000000 });
const rungs = () => [
  { rung: 0, arms: [arm('muse-arm', 'muse-spark-1.3-contributor', 'muse', 9), arm('haiku-arm', 'claude-haiku-5-5', 'haiku', 5)] },
];
const base = {
  runId: 'run-1', agentId: 'agent-1', pointer: 0,
  fiveHourHeadroomPct: 0.5, burnPerRunPct: { 'muse-arm': 0.0005, 'haiku-arm': 0.0005 },
  reservePct: 0.05, accountId: 'meta:m1',
};

test('excluded families never win, even at top Q; other roles unaffected', () => {
  const d = decide({ ...base, role: 'doer', ladderRungs: rungs(), excludedFamilies: ['muse'] });
  assert.equal(d.kind, 'decide');
  assert.equal(d.model, 'claude-haiku-5-5');
  const t = decide({ ...base, role: 'thinker', ladderRungs: rungs(), excludedFamilies: ['muse'] });
  assert.equal(t.model, 'claude-haiku-5-5');
  const o = decide({ ...base, role: 'other', ladderRungs: rungs(), excludedFamilies: [] });
  assert.equal(o.model, 'muse-spark-1.3-contributor');
  // Fully excluded rung groups fall through to defer, like headroom misses.
  const all = decide({ ...base, role: 'doer', ladderRungs: [{ rung: 0, arms: [rungs()[0].arms[0]] }], excludedFamilies: ['muse'] });
  assert.equal(all.kind, 'defer');
});

test('empty exclusions are bit-identical to no exclusions', () => {
  for (const role of ['doer', 'thinker', 'other']) {
    assert.deepEqual(
      decide({ ...base, role, ladderRungs: rungs(), excludedFamilies: [] }),
      decide({ ...base, role, ladderRungs: rungs() }));
  }
});

test('rung-shell filtering helpers', () => {
  assert.deepEqual(normalizeExcludedFamilies(['Muse', 'muse', '', 42, null]), ['muse']);
  assert.deepEqual(normalizeExcludedFamilies('muse'), []);
  const filtered = filterRungsByExcludedFamilies(
    [...rungs(), { rung: 1, arms: [arm('muse-2', 'm', 'muse', 1)] }], ['MUSE']);
  assert.deepEqual(filtered.map(g => g.arms.length), [1, 0]);
  assert.equal(rungsHaveEligibleArms(filtered), true);
  assert.equal(rungsHaveEligibleArms(filterRungsByExcludedFamilies(rungs(), ['muse', 'haiku'])), false);
  // Empty exclusions return the input untouched.
  const input = rungs();
  assert.equal(filterRungsByExcludedFamilies(input, []), input);
});

test('resolveConfig defaults; validator rejects bad role shapes', () => {
  assert.deepEqual(resolveConfig({}).roles.doerAgentIds, []);
  assert.deepEqual(resolveConfig({}).roles.excludeFamilies, { doer: [], thinker: [], other: [] });
  assert.deepEqual(resolveConfig({ roles: { excludeFamilies: { doer: ['MUSE', 'muse'] } } }).roles.excludeFamilies.doer, ['muse']);
  assert.deepEqual(validateConfigShape({}), []);
  assert.deepEqual(validateConfigShape({ roles: { doerAgentIds: ['a'], excludeFamilies: { other: [] } } }), []);
  for (const bad of [
    { roles: { doerAgentIds: 'eng' } },
    { roles: { excludeFamilies: 'muse' } },
    { roles: { excludeFamilies: [] } },
    { roles: { excludeFamilies: { doer: 'muse' } } },
    { roles: { excludeFamilies: { doer: [42] } } },
    { roles: { excludeFamilies: { admin: [] } } },
  ]) {
    assert.ok(validateConfigShape(bad).length > 0, JSON.stringify(bad));
  }
});

// --- Plugin wiring: meta holds the biggest deficit, but excluded roles skip it.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const aaRows = () => ([
  { slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 70, intelligenceIndexCostPerTask: 40, price1mInputTokens: 2, price1mOutputTokens: 8 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);
const lane = (laneName, provider, key, weeklyUsed, fiveHourUsed = 0.1) => ({
  lane: laneName, provider, accountKey: key, health: 'healthy',
  weekly: { used: weeklyUsed, resetsAt: '2026-10-15T22:59:00Z' },
  fiveHour: { used: fiveHourUsed, resetsAt: '2026-10-09T03:59:00Z' },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
});

function drive({ config = {} }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          observedAt: new Date(TICK).toISOString(),
          // Meta holds the biggest shortfall (near-full weekly allowance
          // against a cheaper per-run burn elsewhere); claude is nearly
          // exhausted weekly but keeps five-hour headroom, so it stays
          // decidable. Fresh lanes order by shortfall, meta first.
          accounts: [lane('meta-1', 'meta', 'm1', 0.05, 0.05), lane('claude-1', 'claude', 'a1', 0.95)],
        }),
      }),
    },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
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
    hook: (runId, agentId) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId, issueId: null,
      adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
      agentDefaultModel: null, previous: null, issueOverrideModel: null,
      deadlineMs: 1500,
    }),
    capacity: () => plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' }),
  };
}

const EXCL_CONFIG = {
  enforce: true,
  roles: {
    doerAgentIds: ['eng-doer'],
    thinkerAgentIds: ['planner'],
    excludeFamilies: { doer: ['muse'], thinker: ['muse'], other: [] },
  },
};

test('doer skips the biggest-deficit account when its arms are excluded (no defer)', async () => {
  const d = drive({ config: EXCL_CONFIG });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-doer-1', 'eng-doer');
  assert.equal(h.kind, 'decide');
  assert.match(h.model, /haiku/);
  assert.ok(!h.model.includes('muse'));
});

test('other agents still get muse; thinkers skip it too', async () => {
  const d = drive({ config: EXCL_CONFIG });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-other-1', 'helper');
  assert.equal(h.kind, 'decide');
  assert.match(h.model, /muse-spark/);
  const t = await d.hook('run-thinker-1', 'planner');
  assert.equal(t.kind, 'decide');
  assert.match(t.model, /haiku/);
});

test('absent roles config keeps legacy behavior: non-thinker is a doer, muse wins', async () => {
  const d = drive({ config: { enforce: true } });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-legacy-1', 'eng-doer');
  assert.equal(h.kind, 'decide');
  assert.match(h.model, /muse-spark/);
});

test('/capacity exposes the per-role effective exclusions', async () => {
  const d = drive({ config: EXCL_CONFIG });
  await d.setup();
  await d.tick();
  const cap = await d.capacity();
  assert.deepEqual(cap.body.roleExclusions, { doer: ['muse'], thinker: ['muse'], other: [] });
  const d0 = drive({ config: { enforce: true } });
  await d0.setup();
  await d0.tick();
  assert.deepEqual((await d0.capacity()).body.roleExclusions, { doer: [], thinker: [], other: [] });
});
