import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// Auto-heal tick wiring: the first tick seeds without waking the fleet; a
// brand-new account on the next tick bypasses the rung cooldown and raises
// a capacityChange wake. Reviewer/hold signals ride the same capacity body.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const aaRow = (slug, extra = {}) => ({
  slug, intelligenceIndex: 55, intelligenceIndexCostPerTask: 10,
  price1mInputTokens: 1, price1mOutputTokens: 4, ...extra,
});
const baseAa = () => ([
  aaRow('claude-opus-5-5'),
  aaRow('claude-sonnet-5-5-high'),
  aaRow('claude-haiku-5-5-xhigh'),
  aaRow('claude-haiku-5-5'),
  aaRow('kimi-k3'),
  aaRow('gemini-2-5-flash'),
]);

const lane = (provider, key, { models, used = 0.3, health = 'healthy' } = {}) => ({
  lane: `${provider}-${key}`, provider, accountKey: key,
  health, meter: null, pool: null, models,
  weekly: { used, resetsAt: '2026-10-15T22:59:00Z' },
  fiveHour: { used: 0.1, resetsAt: '2026-10-15T22:59:00Z' },
  quality: 'live',
});

function drive({ lanes = [] }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = (k) => JSON.stringify(k);
  let now = TICK;
  let currentLanes = lanes;
  const io = {
    config: { get: async () => ({ cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async (k) => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => withSyntheticReadiness({
          observedAt: new Date(now).toISOString(),
          accounts: currentLanes.map((a) => ({ ...a, observedAt: new Date(now).toISOString() })),
        }, now),
      }),
    },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setNow: (ms) => { now = ms; },
    setLanes: (next) => { currentLanes = next; },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: baseAa(), duplicateSlugs: [] });
      await plugin.onConfigChanged({}, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    api: (routeKey) => plugin.onApiRequest({ companyId: 'acme', routeKey }),
  };
}

test('first tick seeds quietly; a new account then bypasses cooldown with a wake', async () => {
  const A = lane('claude', 'a1', { models: ['claude-haiku-5-5'] });
  const d = drive({ lanes: [A] });
  await d.setup();
  await d.tick();
  const first = await d.api('capacity');
  assert.equal(first.body.capacityChange.wake, false);
  assert.ok(!first.body.accounts.find((a) => a.accountId === 'claude:a1').bypassedCooldown);
  assert.ok(first.body.reviewer);
  assert.equal(typeof first.body.reviewer.hold, 'boolean');
  assert.equal(typeof first.body.reviewer.resume, 'boolean');
  assert.ok(first.body.supplySignal);

  d.setNow(TICK + 60000);
  d.setLanes([A, lane('claude', 'n1', { models: ['claude-haiku-5-5'], used: 0.05 })]);
  await d.tick();
  const second = await d.api('capacity');
  assert.ok(second.body.capacityChange.upwardAccountIds.includes('claude:n1'));
  assert.equal(second.body.capacityChange.wake, true);
  assert.equal(second.body.accounts.find((a) => a.accountId === 'claude:n1').bypassedCooldown, true);
  assert.equal(second.body.accounts.find((a) => a.accountId === 'claude:a1').bypassedCooldown, false);

  d.setNow(TICK + 120000);
  await d.tick();
  const third = await d.api('capacity');
  assert.equal(third.body.capacityChange.wake, false);
});
