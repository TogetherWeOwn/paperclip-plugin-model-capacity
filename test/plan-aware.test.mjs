import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const T0 = Date.parse('2026-10-15T00:00:00Z');
const MIN = 60000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const skey = stateKey => JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });

function drive({ usage = true, smoothing = {}, provider = 'meta', model = 'muse-spark-1.3-contributor', slug = 'muse-spark-1-3-xhigh' } = {}) {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  let includeLarge = true;
  let epochOverride = null;
  let timeOffsetMs = 0;
  const fieldOverrides = {};
  const accounts = () => ['a', 'b', 'c', ...(includeLarge ? ['large'] : [])].map(k => ({
    lane: k, provider, accountKey: k, health: 'healthy', models: [model],
    // Same remaining quota at the final tick isolates the plan multiplier
    // from required-rate differences (each account has its own reset).
    weekly: { used: (k === 'large' ? 0.28 : 0.1) + step * (k === 'large' ? 0.01 : 0.04), resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
    observedAt: new Date(now).toISOString(), quality: 'live',
    ...(usage ? { usage: { observedAt: new Date(now).toISOString(), epoch: epochOverride ?? 'keeper-1', requests: 100 + step * 100 } } : {}),
    ...(fieldOverrides[k] ?? {}),
  }));
  const config = { cliproxy: { laneKeySecretRef: SECRET }, smoothing, reviewReserve: { enabled: false } };
  const io = {
    config: { get: async () => config },
    state: { get: async k => state.get(JSON.stringify(k)) ?? null, set: async (k, v) => state.set(JSON.stringify(k), v) },
    secrets: { resolve: async () => 'fixture' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: accounts() }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (k, fn) => jobs.set(k, fn) },
    events: { on: (k, fn) => handlers.set(k, fn) },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setup: async () => {
      await plugin.setup(io);
      state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug, intelligenceIndex: 60,
        intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: async i => {
      now = T0 + i * 5 * MIN + timeOffsetMs;
      step = i;
      // Forty runs per tick clear the 10-run attributed floor from the first
      // quantum, so the drive measures shrinkage instead of the fallback.
      if (i > 0) for (let n = 0; n < 40; n++) {
        await handlers.get('agent.run.started')({ companyId: 'acme', entityId: `run-${i}-${n}`,
          payload: { run: { agentId: 'eng', model } }, occurredAt: new Date(now - (n + 1) * 1000).toISOString() });
      }
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
    addLarge: flag => { includeLarge = flag; },
    setEpoch: e => { epochOverride = e; },
    addTime: ms => { timeOffsetMs += ms; },
    setAccount: (k, patch) => { fieldOverrides[k] = { ...(fieldOverrides[k] ?? {}), ...patch }; },
    state,
  };
}

for (const options of [
  { provider: 'meta' },
  { provider: 'codex', model: 'gpt-6.1-sol', slug: 'gpt-6-1-sol' },
  { provider: 'claude', model: 'claude-haiku-5-5', slug: 'claude-haiku-5-5' },
]) {
  test(`${options.provider}: 30-minute fleet simulation allocates ~4x sustainable in-flight budget without oscillation`, async () => {
    const d = drive(options);
    await d.setup();
    const ratios = [];
    let cap;
    for (let i = 0; i <= 6; i++) {
      cap = await d.tick(i);
      const standard = cap.accounts.find(a => a.accountId === `${options.provider}:a`);
      const large = cap.accounts.find(a => a.accountId === `${options.provider}:large`);
      ratios.push(large.capacityWeight);
      if (i === 1) assert.ok(large.capacityWeight > 1.9, 'first quantum gives immediate provisional headroom');
      if (i === 6) {
        assert.ok(Math.abs(large.targetShare / standard.targetShare - 4) < 0.05);
        assert.equal(large.calibrationSource, 'account-weekly');
        const slots = id => cap.perAccount.find(a => a.accountId === `${options.provider}:${id}`).slots;
        assert.ok(Math.abs(slots('large') / slots('a') - 4) < 0.05, 'Little law slot share is weighted once, not squared');
        assert.ok(Math.abs(cap.perAccount.reduce((sum, a) => sum + a.slots, 0) - slots('a') * 7) < 0.05);
      }
    }
    assert.ok(ratios.slice(1).every((w, i, xs) => i === 0 || w >= xs[i - 1] - 1e-8), `no oscillation: ${ratios}`);
    assert.equal(cap.smoothing.verifiedUpHalfLifeMin, 5);
    assert.ok(cap.smoothing.fastUntilMs > cap.atMs);
  });
}

test('legacy feed has no invented account evidence or weight and custom smoothing is effective', async () => {
  const d = drive({ usage: false, smoothing: { halfLifeMin: 12, targetDownHalfLifeMin: 4 } });
  await d.setup();
  await d.tick(0);
  const cap = await d.tick(2);
  assert.ok(cap.accounts.every(a => a.capacityWeight === 1 && a.calibrationSource === 'group-prior'));
  assert.equal(cap.smoothing.halfLifeMin, 12);
  assert.equal(cap.smoothing.targetDownHalfLifeMin, 4);
});

// Review #38 finding 4: a first individual estimate with no discovered
// capacity (weight 1) is not verified headroom -- no fast ramp fires.
test('uniform pool individualizes to weight 1 with no fast ramp', async () => {
  const d = drive({});
  d.addLarge(false);
  await d.setup();
  await d.tick(0);
  await d.tick(1);
  const cap = await d.tick(2);
  for (const id of ['meta:a', 'meta:b', 'meta:c']) {
    const view = cap.accounts.find(a => a.accountId === id);
    assert.equal(view.calibrationSource, 'account-weekly');
    assert.equal(view.capacityWeight, 1);
  }
  assert.ok(cap.smoothing.fastUntilMs <= cap.atMs, 'no verified ramp for equal accounts');
});

// Review #38 finding 6: a counter epoch change discards the retained
// individual estimate instead of bridging it.
test('epoch change drops the retained estimate back to the group prior', async () => {
  const d = drive({});
  await d.setup();
  await d.tick(0);
  const first = await d.tick(1);
  assert.equal(first.accounts.find(a => a.accountId === 'meta:large').calibrationSource, 'account-weekly');
  d.setEpoch('keeper-2');
  const cap = await d.tick(2);
  const large = cap.accounts.find(a => a.accountId === 'meta:large');
  assert.equal(large.calibrationSource, 'group-prior');
  assert.equal(large.capacityWeight, 1);
});

// Review #38 finding 6: a stale (>6h) retained estimate is discarded.
test('stale retained estimate is discarded after the horizon', async () => {
  const d = drive({});
  await d.setup();
  await d.tick(0);
  const first = await d.tick(1);
  assert.ok(first.accounts.find(a => a.accountId === 'meta:large').capacityWeight > 1.9);
  d.addTime(7 * 3600000);
  const cap = await d.tick(2);
  const large = cap.accounts.find(a => a.accountId === 'meta:large');
  assert.equal(large.calibrationSource, 'group-prior');
  assert.equal(large.capacityWeight, 1);
});

// Review #38 finding 6: the health/guard gate on the fast ramp -- a guarded
// or unhealthy account with a real weight jump still gets no ramp.
for (const [name, patch] of [
  ['guarded', { fiveHour: { used: 0.9, resetsAt: new Date(T0 + 5 * 3600000).toISOString() } }],
  ['unhealthy', { health: 'degraded' }],
]) {
  test(`no fast ramp for a ${name} account with a weight jump`, async () => {
    const d = drive({});
    d.setAccount('large', patch);
    await d.setup();
    await d.tick(0);
    const cap = await d.tick(1);
    const large = cap.accounts.find(a => a.accountId === 'meta:large');
    assert.equal(large.calibrationSource, 'account-weekly');
    assert.ok(large.capacityWeight >= 1.25, `would-ramp weight, got ${large.capacityWeight}`);
    assert.ok(cap.smoothing.fastUntilMs <= cap.atMs, `no verified ramp while ${name}`);
  });
}

// Review #38 finding 5: the retired instant bypass stays retired -- a health
// recovery serves the smoothed target (below raw) while the wake still fires.
test('recovery tick serves the smoothed target, not the raw jump', async () => {
  const d = drive({});
  d.addLarge(false);
  await d.setup();
  await d.tick(0);
  d.setAccount('a', { health: 'degraded' });
  const down = await d.tick(1);
  d.setAccount('a', { health: 'healthy' });
  const cap = await d.tick(2);
  assert.ok(cap.capacityChange.wake, 'recovery still pulses the wake');
  assert.ok(cap.targetRaw > down.target, `raw target recovers, raw ${cap.targetRaw} vs down ${down.target}`);
  assert.ok(cap.target < cap.targetRaw, `served ${cap.target} stays smoothed below raw ${cap.targetRaw}`);
  assert.ok(cap.target > down.target, 'served target still moves up');
});

// Review #38 finding 5: an uncalibrated feed addition keeps full damping.
test('new uncalibrated account joins with no fast ramp', async () => {
  const d = drive({});
  d.addLarge(false);
  await d.setup();
  await d.tick(0);
  await d.tick(1);
  await d.tick(2);
  d.addLarge(true);
  const cap = await d.tick(3);
  const large = cap.accounts.find(a => a.accountId === 'meta:large');
  assert.equal(large.calibrationSource, 'group-prior');
  assert.ok(cap.smoothing.fastUntilMs <= cap.atMs, 'joining account gets no verified ramp');
});
