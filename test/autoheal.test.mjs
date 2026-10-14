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
  // Feed clock skew: real lane readings carry the feed's own observedAt, a
  // few seconds behind the tick clock. Positive skew stamps every reading
  // that far behind now.
  let skewMs = 0;
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
          accounts: currentLanes.map((a) => ({ ...a, observedAt: new Date(now - skewMs).toISOString() })),
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
    setSkew: (ms) => { skewMs = ms; },
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

test('capacityChange wake persists as lastWakeAtMs with seq across idle ticks', async () => {
  // A gate polling slower than the 60s tick (or restarting) must still see
  // the event: the current-tick wake pulses once, while seq and lastWakeAtMs
  // survive idle ticks so a consumer can compare against what it handled.
  const A = lane('claude', 'a1', { models: ['claude-haiku-5-5'] });
  const d = drive({ lanes: [A] });
  await d.setup();
  await d.tick();
  const first = (await d.api('capacity')).body.capacityChange;
  assert.equal(first.wake, false);
  assert.equal(first.seq, 0);
  assert.equal(first.lastWakeAtMs, null);

  d.setNow(TICK + 60000);
  d.setLanes([A, lane('claude', 'n1', { models: ['claude-haiku-5-5'], used: 0.05 })]);
  await d.tick();
  const second = (await d.api('capacity')).body.capacityChange;
  assert.equal(second.wake, true);
  assert.equal(second.seq, 1);
  assert.equal(second.lastWakeAtMs, TICK + 60000);

  d.setNow(TICK + 120000);
  await d.tick();
  const third = (await d.api('capacity')).body.capacityChange;
  assert.equal(third.wake, false);
  assert.equal(third.seq, 1, 'idle ticks keep the last event seq');
  assert.equal(third.lastWakeAtMs, TICK + 60000, 'slow pollers still see the wake');
});

const skewedLane = (used, resetIso, health = 'healthy') => ({
  lane: 'claude-a1', provider: 'claude', accountKey: 'a1',
  health, meter: null, pool: null, models: ['claude-haiku-5-5'],
  weekly: { used, resetsAt: resetIso },
  fiveHour: { used: 0.1, resetsAt: '2026-10-15T22:59:00Z' },
  quality: 'live',
});

test('skewed feed stamps clear warmup on history span; the rate descend executes', async () => {
  // Paperclip Review probe: the lane feed stamps readings ~3s behind the tick
  // clock, so the trailing-window span hovers 55-59min and warmup never
  // cleared -- every account stayed on position pacing and the thin-data
  // rewrite held each descend (pointer stuck at 4 under a 24%/h burn).
  // Post-fix the warmup span comes from retained history and descends run.
  const RESET = new Date(TICK + 60 * 3600000).toISOString();
  const d = drive({ lanes: [skewedLane(0, RESET)] });
  d.setSkew(3000);
  await d.setup();
  const FIVE = 5 * 60000;
  const view = async () => (await d.api('capacity')).body.accounts.find((a) => a.accountId === 'claude:a1');
  await d.tick();
  // Behind plan on thin data: position pacing climbs without throttling.
  for (let m = 1; m <= 13; m++) {
    d.setNow(TICK + m * FIVE);
    d.setLanes([skewedLane(0, RESET)]);
    await d.tick();
  }
  assert.ok((await view()).pointer > 0, 'climbs while behind plan');
  // Then a 24%/h burn against ~1.7%/h required: the rate controller descends.
  let used = 0;
  for (let m = 14; m <= 44; m++) {
    used = Math.min(0.95, used + 0.02);
    d.setNow(TICK + m * FIVE);
    d.setLanes([skewedLane(used, RESET)]);
    await d.tick();
  }
  assert.equal((await view()).warmingUp, false, 'warmup clears on retained-history span despite 3s skew');
  assert.equal((await view()).pointer, 0, 'rate descend runs to the floor instead of holding');
});

test('bypass tick with no move preserves the rung cooldown stamp', async () => {
  // Paperclip Review probe: climb at t=0, a weekly-reset event at t=2m holds
  // inside the deadband while the bypass zeroes the stamp, and the pointer
  // descends at t=4m inside the 10-minute cooldown. Post-fix a no-move bypass
  // tick writes the original stamp back, so the cooldown survives.
  const RESET = new Date(TICK + 60 * 3600000).toISOString();
  const d = drive({ lanes: [skewedLane(0, RESET, 'healthy')] });
  await d.setup();
  const view = async () => (await d.api('capacity')).body.accounts.find((a) => a.accountId === 'claude:a1');
  await d.tick();
  assert.equal((await view()).pointer, 1, 'climbs while behind plan');
  d.setNow(TICK + 2 * 60000);
  d.setLanes([skewedLane(0, RESET, 'degraded')]);
  await d.tick();
  assert.equal((await view()).pointer, 1, 'excluded tick freezes the pointer');
  d.setNow(TICK + 4 * 60000);
  d.setLanes([skewedLane(0.643, RESET, 'healthy')]);
  await d.tick();
  assert.equal((await view()).pointer, 1, 'recovery bypass tick with no move holds');
  d.setNow(TICK + 6 * 60000);
  d.setLanes([skewedLane(0.9, RESET, 'healthy')]);
  await d.tick();
  assert.equal((await view()).pointer, 1, 'cooldown survives the bypass tick');
  assert.match((await view()).action, /hold-cooldown/);
});
