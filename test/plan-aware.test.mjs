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
  const accounts = () => ['a', 'b', 'c', ...(includeLarge ? ['large'] : [])].map(k => ({
    lane: k, provider, accountKey: k, health: 'healthy', models: [model],
    // Same remaining quota at the final tick isolates the plan multiplier
    // from required-rate differences (each account has its own reset).
    weekly: { used: (k === 'large' ? 0.28 : 0.1) + step * (k === 'large' ? 0.01 : 0.04), resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
    observedAt: new Date(now).toISOString(), quality: 'live',
    ...(usage ? { usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 } } : {}),
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
      now = T0 + i * 5 * MIN;
      step = i;
      if (i > 0) for (let n = 0; n < 10; n++) {
        await handlers.get('agent.run.started')({ companyId: 'acme', entityId: `run-${i}-${n}`,
          payload: { run: { agentId: 'eng', model } }, occurredAt: new Date(now - (n + 1) * 1000).toISOString() });
      }
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
    addLarge: flag => { includeLarge = flag; },
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
