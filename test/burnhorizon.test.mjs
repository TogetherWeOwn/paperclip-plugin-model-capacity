import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBurnHorizon, residualQuantileMs, burnHorizon,
  DEFAULT_BURN_HORIZON,
} from '../src/burnhorizon.mjs';
import { parseFreeResets } from '../src/cliproxy.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const H = 3600000;
const D = 24 * H;
const T0 = Date.parse('2026-10-13T05:03:51Z'); // last Codex free reset at test time

test('normalizeBurnHorizon defaults and coercion', () => {
  assert.deepEqual(normalizeBurnHorizon(undefined), {
    enabled: true, quantile: 0.5, maxBurnFactor: 3, minHistory: 3, providerQuantiles: {},
  });
  assert.equal(DEFAULT_BURN_HORIZON.quantile, 0.5);
  const bad = normalizeBurnHorizon({ enabled: 'yes', quantile: 7, maxBurnFactor: 0, minHistory: 0 });
  assert.deepEqual([bad.enabled, bad.quantile, bad.maxBurnFactor, bad.minHistory],
    [true, 0.5, 3, 3]);
  const pq = normalizeBurnHorizon({ providerQuantiles: { codex: 0.25, meta: 'x', '': 0.5, z: 1 } });
  assert.deepEqual(pq.providerQuantiles, { codex: 0.25 });
});

test('residualQuantileMs is the quantile of gaps outliving since', () => {
  const gaps = [2 * D, 4 * D, 8 * D];
  assert.equal(residualQuantileMs(gaps, 0, 0.5), 4 * D);
  // 1d in: residuals are 1d, 3d, 7d -> median 3d.
  assert.equal(residualQuantileMs(gaps, 1 * D, 0.5), 3 * D);
  // Overdue (nothing outlives since): null, never a forced rate.
  assert.equal(residualQuantileMs(gaps, 9 * D, 0.5), null);
  assert.equal(residualQuantileMs([], 0, 0.5), null);
  assert.equal(residualQuantileMs(null, 0, 0.5), null);
});

test('backtest-anchored quantile: p50 of representative gaps ~ median wait', () => {
  // Representative Codex gaps (days): near the measured p10/p25/p40/p50/p75.
  const gaps = [1.24, 2.04, 2.97, 4.02, 7.96].map((d) => d * D);
  const med = residualQuantileMs(gaps, 0, 0.5);
  assert.ok(Math.abs(med - 2.97 * D) < H, `median residual ~2.97d, got ${med / D}d`);
  const q25 = residualQuantileMs(gaps, 0, 0.25);
  assert.ok(Math.abs(q25 - 2.04 * D) < H, `p25 residual ~2.04d, got ${q25 / D}d`);
});

test('burnHorizon fails open without data or when disabled', () => {
  const feed = { provider: 'codex', lastAtMs: T0, gapsMs: [2 * D, 4 * D, 8 * D] };
  const resetAtMs = T0 + 7 * D;
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs, feed: null, cfg: {} }), null);
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs, feed: { provider: 'x', lastAtMs: null, gapsMs: [] }, cfg: {} }), null);
  // Unknown regular reset reads as no horizon: there is no linear baseline
  // to clamp a burn rate against, so the caller keeps its nulls.
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs: null, feed, cfg: {} }), null);
  assert.equal(burnHorizon({ nowMs: T0, feed, cfg: {} }), null);
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs: feed, feed, cfg: {} }), null);
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs, feed, cfg: { enabled: false } }), null);
  // Fewer gaps than minHistory: untrusted.
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs, feed: { ...feed, gapsMs: [2 * D] }, cfg: {} }), null);
});

test('burnHorizon lands at lastAt + median residual when inside the week', () => {
  const feed = { provider: 'codex', lastAtMs: T0, gapsMs: [2 * D, 4 * D, 8 * D] };
  const resetAtMs = T0 + 7 * D;
  const b = burnHorizon({ nowMs: T0, resetAtMs, feed, cfg: {} });
  assert.ok(b, 'expected a horizon');
  assert.ok(Math.abs(b.horizonMs - (T0 + 4 * D)) < H, `H ~ T0+4d, got +${(b.horizonMs - T0) / D}d`);
  assert.equal(b.quantile, 0.5);
  assert.equal(b.gaps, 3);
});

test('burnHorizon is null when the regular reset binds first', () => {
  const feed = { provider: 'codex', lastAtMs: T0, gapsMs: [10 * D, 12 * D, 14 * D] };
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs: T0 + 7 * D, feed, cfg: {} }), null);
});

test('burnHorizon conditions on survival: H slides out as time passes', () => {
  const feed = { provider: 'codex', lastAtMs: T0, gapsMs: [2 * D, 4 * D, 8 * D] };
  const resetAtMs = T0 + 7 * D;
  const early = burnHorizon({ nowMs: T0, resetAtMs, feed, cfg: {} });
  const late = burnHorizon({ nowMs: T0 + 3 * D, resetAtMs, feed, cfg: {} });
  assert.ok(early);
  // 3d in, residuals are (8-3)=5d over [4d? no: gaps>3d are 4d,8d -> 1d,5d] -> median 5d -> H=T0+8d, past reset -> null.
  assert.equal(late, null);
});

test('burnHorizon clamps to maxBurnFactor x linear', () => {
  const feed = { provider: 'codex', lastAtMs: T0, gapsMs: [0.5 * D, 0.6 * D, 0.7 * D] };
  const resetAtMs = T0 + 7 * D;
  const b = burnHorizon({ nowMs: T0, resetAtMs, feed, cfg: { maxBurnFactor: 2 } });
  assert.ok(b, 'expected a clamped horizon, not null');
  // Linear week is 7d; 2x burn means the horizon cannot sit inside 3.5d.
  assert.ok(b.horizonMs - T0 >= 3.5 * D - H, `clamped H >= 3.5d, got ${(b.horizonMs - T0) / D}d`);
});

test('burnHorizon honors per-provider quantile overrides', () => {
  const feed = { provider: 'codex', lastAtMs: T0, gapsMs: [2 * D, 4 * D, 8 * D] };
  const resetAtMs = T0 + 7 * D;
  // maxBurnFactor 10 keeps the clamp clear of the raw p25 horizon (the
  // default x3 clamp would lift T0+2d to the T0+2.33d floor: see clamp test).
  const b = burnHorizon({ nowMs: T0, resetAtMs, feed, cfg: { providerQuantiles: { codex: 0.25 }, maxBurnFactor: 10 } });
  assert.ok(b);
  assert.equal(b.quantile, 0.25);
  assert.ok(Math.abs(b.horizonMs - (T0 + 2 * D)) < H, `p25 H ~ T0+2d, got +${(b.horizonMs - T0) / D}d`);
});

test('parseFreeResets reads the feed section; malformed degrades to null', () => {
  assert.equal(parseFreeResets({}, Date.now()), null);
  assert.equal(parseFreeResets({ freeResets: { codex: 'nope' } }, Date.now()), null);
  const body = {
    freeResets: {
      codex: {
        lastAt: '2026-10-13T05:03:51Z',
        history: ['2026-10-07T03:35:09Z', '2026-10-11T04:01:09Z', '2026-10-13T05:03:51Z'],
        source: 'codex-reset.com/api/timeline',
      },
      meta: { lastAt: '2026-10-12T19:41:00Z', history: ['2026-10-12T19:41:00Z'], source: 'feed-ledger' },
    },
  };
  const fr = parseFreeResets(body, Date.now());
  assert.ok(fr && fr.codex && fr.meta);
  assert.equal(fr.codex.lastAtMs, T0);
  assert.equal(fr.codex.gapsMs.length, 2);
  assert.ok(Math.abs(fr.codex.gapsMs[0] - (Date.parse('2026-10-11T04:01:09Z') - Date.parse('2026-10-07T03:35:09Z'))) < 1000);
  assert.deepEqual(fr.meta.gapsMs, []);
});

test('end to end: feed history yields a pace horizon inside the week', () => {
  const fr = parseFreeResets({
    freeResets: {
      codex: {
        lastAt: '2026-10-13T05:03:51Z',
        history: ['2026-10-02T21:18:48Z', '2026-10-07T03:35:09Z', '2026-10-11T04:01:09Z', '2026-10-13T05:03:51Z'],
        source: 'codex-reset.com/api/timeline',
      },
    },
  }, T0);
  assert.equal(fr.codex.gapsMs.length, 3);
  const b = burnHorizon({ nowMs: T0, resetAtMs: T0 + 7 * D, feed: fr.codex, cfg: {} });
  assert.ok(b, 'expected a horizon from 3 gaps');
  // Gaps ~4.26d, ~4.11d, ~2.04d -> median residual ~4.11d -> H ~ T0+4.1d.
  assert.ok(b.horizonMs - T0 > 3 * D && b.horizonMs - T0 < 5 * D,
    `H ~ +4.1d, got +${(b.horizonMs - T0) / D}d`);
});

test('end to end: fewer gaps than minHistory reads as linear (null)', () => {
  const fr = parseFreeResets({
    freeResets: { meta: { lastAt: '2026-10-12T19:41:00Z', history: ['2026-10-12T19:41:00Z'], source: 'feed-ledger' } },
  }, T0);
  assert.deepEqual(fr.meta.gapsMs, []);
  assert.equal(burnHorizon({ nowMs: T0, resetAtMs: T0 + 7 * D, feed: fr.meta, cfg: {} }), null);
});

// --- through the plugin: the tick's persisted capacity is the observable ---

const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const AA_ROWS = [
  { slug: 'gpt-6-1-sol', intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
];

// Mid-window (5d of a 7d window left): elapsed > 0 so the plan position
// actually depends on the period end and moves with the horizon.
const codexLane = () => ({
  lane: 'codex-lane-1', provider: 'codex', accountKey: 'codex-lane-1', health: 'healthy',
  weekly: { used: 0.5, resetsAt: new Date(T0 + 5 * D).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(T0 + 4 * H).toISOString() },
  observedAt: new Date(T0).toISOString(), quality: 'live',
  models: ['gpt-6.1-sol'],
});

const CODEX_FEED = {
  codex: {
    lastAt: '2026-10-13T05:03:51Z',
    history: ['2026-10-02T21:18:48Z', '2026-10-07T03:35:09Z', '2026-10-11T04:01:09Z', '2026-10-13T05:03:51Z'],
    source: 'codex-reset.com/api/timeline',
  },
};

const SMOOTH_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'smoothing-v1' };

async function capacityBody({ config = {}, feedExtra = {}, lane = null, smoothE = null }) {
  const store = new Map();
  const jobs = new Map();
  const skey = (k) => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => T0, requirePinnedLaneHost: false });
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: { get: async (k) => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => withSyntheticReadiness(
          { observedAt: new Date(T0).toISOString(), accounts: [lane ?? codexLane()], ...feedExtra }, T0),
      }),
    },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on() {} },
    logger: { info() {}, error() {} },
  };
  await plugin.setup(io);
  store.set(skey(AA_KEY), { fetchedAt: new Date(T0).toISOString(), rows: AA_ROWS, duplicateSlugs: [] });
  // A carried smoothed burn-per-run puts the lane in the calibrated regime
  // (C* defined) without a multi-tick history.
  if (smoothE) store.set(skey(SMOOTH_SKEY), { E: smoothE });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  await jobs.get('shadow-tick')({ companyId: 'acme' });
  return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
}

test('fail-open bit-for-bit: enabled with no feed data matches the kill switch', async () => {
  const enabledNoData = await capacityBody({ config: {} });
  const killed = await capacityBody({ config: { burnHorizon: { enabled: false } } });
  assert.deepEqual(enabledNoData, killed);
});

test('engaged horizon quickens the required pace, within the clamp', async () => {
  const linear = await capacityBody({ config: { burnHorizon: { enabled: false } }, feedExtra: { freeResets: CODEX_FEED } });
  const burned = await capacityBody({ config: {}, feedExtra: { freeResets: CODEX_FEED } });
  const acct = (body) => body.accounts.find((a) => a.accountId === 'codex:codex-lane-1');
  const l = acct(linear);
  const b = acct(burned);
  assert.ok(l && b, 'expected the codex account in both capacity bodies');
  // Median residual ~4.0d < 7d week: the burn pace is quicker than linear ...
  assert.ok(b.requiredRatePerHour > l.requiredRatePerHour,
    `burn ${b.requiredRatePerHour} should exceed linear ${l.requiredRatePerHour}`);
  // ... but never faster than maxBurnFactor x linear.
  assert.ok(b.requiredRatePerHour <= 3 * l.requiredRatePerHour + 1e-12,
    `burn ${b.requiredRatePerHour} should stay within 3x linear ${l.requiredRatePerHour}`);
  // The plan position moves with the pace end too.
  assert.notEqual(b.planAhead, l.planAhead);
});

test('unknown weekly reset invents no pace even with feed data', async () => {
  const noReset = { ...codexLane(), weekly: { used: 0.5, resetsAt: null } };
  const body = await capacityBody({ config: {}, feedExtra: { freeResets: CODEX_FEED }, lane: noReset });
  const a = body.accounts.find((x) => x.accountId === 'codex:codex-lane-1');
  assert.ok(a, 'expected the codex account in the capacity body');
  assert.equal(a.requiredRatePerHour, null);
  assert.equal(a.targetShare, null);
  assert.equal(a.planAhead, null);
});

test('C* need paces to the burn end too (same term as targetShare)', async () => {
  const E = { 'codex:codex-lane-1': { value: 0.01, atMs: T0 } };
  const linear = await capacityBody({
    config: { burnHorizon: { enabled: false } }, feedExtra: { freeResets: CODEX_FEED }, smoothE: E,
  });
  const burned = await capacityBody({ config: {}, feedExtra: { freeResets: CODEX_FEED }, smoothE: E });
  assert.ok(linear.target > 0 && burned.target > 0,
    `calibrated C* expected, got linear=${linear.target} burned=${burned.target}`);
  assert.ok(burned.target > linear.target,
    `burn C* ${burned.target} should exceed linear C* ${linear.target}`);
  // Same term: the C* ratio tracks the required-rate ratio.
  const la = linear.accounts.find((x) => x.accountId === 'codex:codex-lane-1');
  const ba = burned.accounts.find((x) => x.accountId === 'codex:codex-lane-1');
  const rTarget = burned.target / linear.target;
  const rRate = ba.requiredRatePerHour / la.requiredRatePerHour;
  assert.ok(Math.abs(rTarget - rRate) < 0.05, `C* x${rTarget} should track rate x${rRate}`);
});
