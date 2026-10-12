import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAggregatorAccount,
  isFallbackOnlyView,
  nativeQualifiedModels,
  crossAccountDominated,
  versionTuple,
  compareVersions,
  hasHeadroom,
} from '../src/cross-account.mjs';
import { orderAccountsForRun } from '../src/select.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

const view = (accountId, partial = {}) => ({
  accountId,
  resetAtMs: null,
  headroomPct: 0.9,
  health: 'healthy',
  measuredRatePerHour: null,
  requiredRatePerHour: null,
  ...partial,
});

test('aggregator detection: devin provider, laneProvider, or account prefix', () => {
  assert.equal(isAggregatorAccount(view('devin:lane-1', { provider: 'devin' })), true);
  assert.equal(isAggregatorAccount(view('x', { provider: 'Devin' })), true);
  assert.equal(isAggregatorAccount(view('y', { laneProvider: 'devin' })), true);
  assert.equal(isAggregatorAccount(view('devin:lane-9')), true);
  assert.equal(isAggregatorAccount(view('codex:codex-lane-1', { provider: 'codex' })), false);
  assert.equal(isAggregatorAccount(view('claude:a', { provider: 'claude' })), false);
});

test('native qualified models: only healthy headroom natives count, never aggregators', () => {
  const models = nativeQualifiedModels([
    view('codex:lane-1', { provider: 'codex', models: ['gpt-6.1-sol'] }),
    view('devin:lane-1', { provider: 'devin', meter: 'reactive', headroomPct: null, models: ['gpt-6-sol'] }),
    view('claude:dead', { provider: 'claude', health: 'exhausted', models: ['claude-opus-5-5'] }),
    view('claude:thin', { provider: 'claude', headroomPct: 0.04, models: ['claude-haiku-5-5'] }),
  ]);
  assert.deepEqual([...models].sort(), ['gpt-6.1-sol']);
});

test('fallback-only: aggregator serving only duplicated models; unique keeps band 1', () => {
  const native = new Set(['gpt-6-sol']);
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin', models: ['devin/gpt-6-sol'] }), native),
    true,
    'provider-prefixed id canonicalizes to the native model',
  );
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin', models: ['gpt-6-sol', 'swe-2'] }), native),
    false,
    'a unique model (swe-*) keeps band 1',
  );
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin' }), native),
    false,
    'no models list fails open',
  );
  assert.equal(
    isFallbackOnlyView(view('codex:lane-1', { provider: 'codex', models: ['gpt-6-sol'] }), native),
    false,
    'natives are never fallback-only',
  );
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin', models: ['gpt-6-sol'], fallbackOnly: false }), native),
    false,
    'explicit flag wins',
  );
});

test('fallback-only aggregator sorts after metered-ahead; unique stays reactive', () => {
  const ids = (views) => orderAccountsForRun(views).map(v => v.accountId);
  assert.deepEqual(ids([
    view('codex:ahead', {
      provider: 'codex', models: ['gpt-6.1-sol'],
      measuredRatePerHour: 0.011, requiredRatePerHour: 0.01,
    }),
    view('devin:dup', { provider: 'devin', meter: 'reactive', headroomPct: null, models: ['gpt-6.1-sol'] }),
  ]), ['codex:ahead', 'devin:dup']);
  assert.deepEqual(ids([
    view('codex:ahead', {
      provider: 'codex', models: ['gpt-6.1-sol'],
      measuredRatePerHour: 0.011, requiredRatePerHour: 0.01,
    }),
    view('devin:unique', { provider: 'devin', meter: 'reactive', headroomPct: null, models: ['swe-2'] }),
  ]), ['devin:unique', 'codex:ahead']);
});

test('hasHeadroom: metered with headroom only; reactive never counts', () => {
  assert.equal(hasHeadroom(view('a', { headroomPct: 0.9 })), true);
  assert.equal(hasHeadroom(view('b', { headroomPct: 0.04 })), false);
  assert.equal(hasHeadroom(view('c', { meter: 'reactive', headroomPct: null })), false);
  assert.equal(hasHeadroom(view('d', { health: 'exhausted', headroomPct: 0.9 })), false);
});

test('version parsing compares dotted generations', () => {
  assert.deepEqual(versionTuple('gpt-6.1-sol'), [6, 1]);
  assert.deepEqual(versionTuple('gpt-6-sol'), [6]);
  assert.ok(compareVersions(versionTuple('gpt-6.1-sol'), versionTuple('gpt-6-sol')) > 0);
  assert.equal(compareVersions(versionTuple('gpt-6-sol'), versionTuple('gpt-6-sol')), 0);
  assert.deepEqual(versionTuple('swe-2'), [2]);
});

const arm = (accountId, armId, family, model, Q, C) => ({ accountId, armId, family, model, Q, C });

test('cross-account dominance: better Sol on qualified Codex drops old Sol on Devin', () => {
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 1);
  assert.equal(dominated[0].accountId, 'devin:devin-lane-1');
  assert.equal(dominated[0].armId, 'gpt-6-sol');
});

test('no dominance when the better arm has no headroom, costs more, or is another family', () => {
  const better = arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72);
  const old = arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72);
  assert.equal(crossAccountDominated([better, old], new Set()).length, 0, 'unqualified dominator');
  assert.equal(
    crossAccountDominated([better, old], new Set(['devin:devin-lane-1'])).length, 0,
    'reactive-only qualification never dominates',
  );
  assert.equal(
    crossAccountDominated([
      { ...better, C: 0.90 },
      old,
    ], new Set(['codex:codex-lane-1'])).length, 0,
    'higher cost never dominates',
  );
  assert.equal(
    crossAccountDominated([
      arm('codex:codex-lane-1', 'gpt-6-1-luna', 'luna', 'gpt-6.1-luna', 0.90, 0.10),
      old,
    ], new Set(['codex:codex-lane-1'])).length, 0,
    'another family never dominates',
  );
  assert.equal(
    crossAccountDominated([
      arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.05, 0.72),
      old,
    ], new Set(['codex:codex-lane-1'])).length, 0,
    'lower Q never dominates',
  );
});

test('newer version with equal Q and cost still dominates', () => {
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.30, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.30, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 1);
});

test('null Q/C arms never dominate and are never dropped here', () => {
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'ghost', 'sol', 'ghost-sol', null, 0.10),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 0);
});

test('10-11 regression: ahead-of-plan Codex with 91% left beats reactive Devin old Sol', () => {
  // codex-lane-1: 9% used (headroom 0.91) but measured ahead of plan, so
  // band 2. Devin: healthy reactive serving only old Sol, band 1.
  const codex = view('codex:codex-lane-1', {
    provider: 'codex', models: ['gpt-6.1-sol'],
    headroomPct: 0.91, measuredRatePerHour: 0.011, requiredRatePerHour: 0.01,
    placementQ: 0.35,
  });
  const devin = view('devin:devin-lane-1', {
    provider: 'devin', meter: 'reactive', headroomPct: null,
    models: ['gpt-6-sol'], placementQ: 0.10,
  });
  // Dominance removes old Sol from Devin: Codex is qualified with headroom
  // and its Sol scores higher at equal-or-lower cost.
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 1);
  // Devin's ladder is now empty for the role, so the candidate loop skips
  // it and the run lands on Codex gpt-6.1-sol even though Devin orders first.
  const devinArmsLeft = 0;
  const order = orderAccountsForRun([codex, devin]).map(v => v.accountId);
  assert.deepEqual(order[0], 'devin:devin-lane-1', 'bands unchanged: reactive still orders first');
  const eligible = (accountId) => (accountId === 'devin:devin-lane-1' ? devinArmsLeft : 1);
  const pick = order.find(id => eligible(id) > 0);
  assert.equal(pick, 'codex:codex-lane-1', 'empty Devin ladder is skipped: Codex serves gpt-6.1-sol');
});

test('dominators with an open or half-open breaker never dominate', () => {
  const mk = (breaker) => ([
    { ...arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72), breaker },
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ]);
  const qualified = new Set(['codex:codex-lane-1']);
  assert.equal(crossAccountDominated(mk('open'), qualified).length, 0, 'open breaker: no dominance');
  assert.equal(crossAccountDominated(mk('half-open'), qualified).length, 0, 'half-open probe: no dominance');
  assert.equal(crossAccountDominated(mk('closed'), qualified).length, 1, 'closed breaker still dominates');
  // Arms without a breaker field predate the wiring: fail open, still dominate.
  assert.equal(crossAccountDominated([
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ], qualified).length, 1, 'missing breaker fails open');
});

test('allowedKeys predicate excludes unroutable dominators', () => {
  const arms = [
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ];
  const qualified = new Set(['codex:codex-lane-1']);
  assert.equal(
    crossAccountDominated(arms, qualified, { allowedKeys: new Set() }).length, 0,
    'empty allow-list: nothing dominates',
  );
  assert.equal(
    crossAccountDominated(arms, qualified, {
      allowedKeys: new Set(['codex:codex-lane-1\u0000gpt-6-1-sol']),
    }).length, 1,
    'listed dominator still dominates',
  );
});

// ---- Tick wiring: drive() harness (mirrors test/all-providers.test.mjs) ----

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'kimi-k3', intelligenceIndex: 55, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
  // TOG-21579 pair: same family, newer scores higher at equal cost.
  { slug: 'gpt-6-1-sol', intelligenceIndex: 68, intelligenceIndexCostPerTask: 20, price1mInputTokens: 4, price1mOutputTokens: 20 },
  { slug: 'gpt-6-sol', intelligenceIndex: 60, intelligenceIndexCostPerTask: 20, price1mInputTokens: 4, price1mOutputTokens: 20 },
]);

const rawAcct = (o) => ({
  lane: o.lane, provider: o.provider, accountKey: o.key,
  health: o.health ?? 'healthy', meter: o.meter ?? null, pool: o.pool ?? null,
  models: o.models ?? null,
  weekly: { used: o.weekly ?? null, resetsAt: o.reset ?? null },
  fiveHour: { used: o.fiveHour ?? null, resetsAt: o.reset5 ?? null },
  observedAt: o.observedAt ?? '2026-10-08T22:59:00Z', quality: o.quality ?? 'live',
});

const RESET = '2026-10-15T22:59:00Z';

const codexSol = (over = {}) => rawAcct({
  lane: 'codex-lane-1', provider: 'codex', key: 'codex-lane-1',
  weekly: 0.09, reset: RESET, fiveHour: 0.05,
  models: ['gpt-6.1-sol'], ...over,
});

const devinOldSol = (over = {}) => rawAcct({
  lane: 'devin-lane-1', provider: 'devin', key: 'devin-lane-1',
  meter: 'reactive', quality: 'reactive',
  models: ['gpt-6-sol'], ...over,
});

const claudeAcct = (over = {}) => rawAcct({
  lane: 'claude-1', provider: 'claude', key: 'a1',
  weekly: 0.3, reset: RESET, fiveHour: 0.1,
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], ...over,
});

const started = (runId, atMs, extra = {}, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', ...extra } },
  occurredAt: new Date(atMs).toISOString(),
});

// Admission is fail-closed on credential readiness (main #24): a lane feed
// with no version-1 credentialAvailability row for the exact emitted model
// id admits nothing. These fixtures exercise OTHER features (dominance,
// fallback), so the drive() lane states, explicitly and in plain data, that
// every discovered model is ready (observed at the fixture clock). Same wire
// shape a feed carries (cf. test/synthetic-readiness.mjs on main); kept
// inline so this branch stands alone without main's helper. On trees that
// predate the readiness gate the extra key is ignored.
const readyLane = (lane, nowMs) => ({
  ...lane,
  accounts: (lane.accounts ?? []).map(entry => {
    if (!entry || typeof entry !== 'object' || Object.hasOwn(entry, 'credentialAvailability')) return entry;
    const provider = entry.provider;
    const accountId = `${provider}:${entry.accountKey ?? entry.lane ?? 'x'}`;
    const discovered = (Array.isArray(entry.models) ? entry.models : [])
      .filter(m => typeof m === 'string' && !/[\/()\[\]]/.test(m));
    return {
      ...entry,
      credentialAvailability: {
        version: 1,
        models: discovered.map(model => ({
          model, provider, accountId,
          servingCredentials: 1, readyCredentials: 1,
          observedAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + 120000).toISOString(),
        })),
      },
    };
  }),
});

function drive({ nowMs, config = {}, laneAccounts = null, steps = null, issueGets = {}, agentGets = {}, rows = null }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
  let tickNo = 0;
  const resolveLane = () => {
    const accounts = typeof laneAccounts === 'function' ? laneAccounts(tickNo, now) : laneAccounts;
    return { observedAt: new Date(now).toISOString(), accounts: accounts ?? [] };
  };
  let lane = resolveLane();
  const fake = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => {
        if (JSON.stringify(v).includes('\\u0000')) throw new Error('unsupported Unicode escape sequence (\\u0000 cannot be converted to text)');
        store.set(skey(k), v);
      },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => readyLane(lane, now) }) },
    agents: {
      get: async (agentId, companyId) => {
        if (typeof agentId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return agentGets[agentId] ?? null;
      },
    },
    issues: {
      get: async (issueId, companyId) => {
        if (typeof issueId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return issueGets[issueId] ?? null;
      },
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  return {
    run: async () => {
      await plugin.setup(fake);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: rows ?? aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
      for (const s of steps ?? [{ now: nowMs }]) {
        now = s.now;
        lane = s.lane !== undefined ? s.lane : resolveLane();
        tickNo += 1;
        for (const e of s.fire ?? []) await handlers.get(e.type)(e);
        await jobs.get('shadow-tick')({});
      }
      return {
        shadow: await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' }),
        capacity: await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' }),
      };
    },
  };
}

const accountsById = (capacity) => new Map(capacity.body.accounts.map(a => [a.accountId, a]));

test('tick: ahead-of-plan Codex new Sol beats reactive Devin old Sol end to end', async () => {
  // 10-11 case through a real tick: Codex burns 2% -> 9% in 30 min (measured
  // far above required, so band 2) while Devin reactive serves old Sol.
  // Dominance drops the old Sol arm; the run lands on Codex gpt-6.1-sol.
  const laneAt = (weekly) => [codexSol({ weekly }), devinOldSol()];
  const at = TICK + 30 * 60000;
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: (tickNo, now) => laneAt(now <= TICK ? 0.02 : 0.09),
    steps: [
      { now: TICK },
      { now: at, fire: [started('run-sol-1', at - 60000, { adapterType: 'claude-code' })] },
    ],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 1);
  const [entry] = shadow.body.entries;
  assert.equal(entry.accountId, 'codex:codex-lane-1');
  assert.match(entry.wouldModel, /gpt-6\.1-sol/);
  const byId = accountsById(capacity);
  const codex = byId.get('codex:codex-lane-1');
  const devin = byId.get('devin:devin-lane-1');
  assert.ok(codex.arms.length > 0, 'Codex keeps its Sol arm');
  assert.deepEqual(devin.arms, [], 'dominance drops old Sol from Devin end to end');
});

test('tick: native at its reactive cap falls back to duplicate Devin (arms kept)', async () => {
  // Review probe: reactive claude + reactive devin serving the same 3 claude
  // models, 4 starts. The native caps at 2; the duplicate Devin lane must
  // serve the other 2 (fallbackOnly band 3, arms intact -- never deleted).
  const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  const fires = [];
  for (let i = 0; i < 4; i++) fires.push(started(`run-cap-${i}`, TICK - 60000));
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [
      claudeAcct({ lane: 'claude-1', key: 'r1', meter: 'reactive', quality: 'reactive', weekly: null, reset: null, fiveHour: null, models }),
      rawAcct({ lane: 'devin-1', provider: 'devin', key: 'd1', meter: 'reactive', quality: 'reactive', models }),
    ],
    steps: [{ now: TICK, fire: fires }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 4);
  assert.equal(capacity.body.shadow.skippedNoDecision, 0);
  const counts = {};
  for (const e of shadow.body.entries) counts[e.accountId] = (counts[e.accountId] ?? 0) + 1;
  assert.deepEqual(counts, { 'claude:r1': 2, 'devin:d1': 2 });
  const byId = accountsById(capacity);
  const devin = byId.get('devin:d1');
  assert.equal(devin.fallbackOnly, true);
  assert.ok(devin.arms.length > 0, 'duplicate Devin rungs are demoted, never deleted');
});

test('tick: metered dominator without a weekly reading never dominates', async () => {
  // Codex carries a 5h meter (headroom signal) but no weekly reading, so the
  // candidate loop can never route it (remainingPct == null). Its new Sol
  // must NOT dominate old Sol on Devin: the run lands on Devin instead.
  const at = TICK;
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [
      codexSol({ weekly: null, reset: null, fiveHour: 0.1 }),
      devinOldSol(),
    ],
    steps: [{ now: at, fire: [started('run-sol-nw', at - 60000, { adapterType: 'claude-code' })] }],
  });
  const { shadow, capacity } = await run();
  const byId = accountsById(capacity);
  const devin = byId.get('devin:devin-lane-1');
  assert.ok(devin.arms.length > 0, 'unroutable dominator drops nothing');
  assert.equal(shadow.body.entries.length, 1);
  assert.equal(shadow.body.entries[0].accountId, 'devin:devin-lane-1');
});
