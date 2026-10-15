import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCredits, usableCredit, DEFAULT_CREDITS } from '../src/credits.mjs';
import { parseLaneAccount, parseCredits } from '../src/cliproxy.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { orderAccountsForRun } from '../src/select.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const T0 = Date.parse('2026-10-15T00:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const skey = stateKey => JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });

test('credits config defaults to the free Codex grant and rejects unknown keys', () => {
  assert.deepEqual(normalizeCredits(null).freeTypes, ['codex-credits']);
  assert.deepEqual(normalizeCredits({}).paidTypes, []);
  assert.deepEqual(normalizeCredits({ freeTypes: ['  X  ', 'x'] }).freeTypes, ['x']);
  assert.deepEqual(DEFAULT_CREDITS.freeTypes, ['codex-credits']);
});

test('usage parser keeps credits provenance: unknown or empty is never capacity', () => {
  const base = { provider: 'codex', lane: 'a', observedAt: new Date(T0).toISOString() };
  assert.equal(parseLaneAccount(base, T0).credits, null);
  assert.equal(parseLaneAccount({ ...base, credits: 'yes' }, T0).credits, null);
  const parsed = parseLaneAccount({ ...base, credits: [
    { type: 'Codex-Credits', hasCredits: true, balance: 12.5, fraction: 0.4, resetsAt: '2026-10-22T01:44:14Z' },
    { type: '', hasCredits: true, balance: 5 },
    { type: 'other', hasCredits: true, balance: -1 },
  ] }, T0).credits;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, 'codex-credits');
  assert.equal(parsed[0].balance, 12.5);
  assert.equal(parsed[0].fraction, 0.4);
  assert.equal(parsed[0].resetsAtMs, Date.parse('2026-10-22T01:44:14Z'));
  assert.equal(parsed[1].balance, null);
  assert.deepEqual(parseCredits(null), null);
});

test('only allowed types with a positive balance are spendable; paid needs opt-in', () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 3, fraction: null, resetsAtMs: null }];
  assert.equal(usableCredit(free, null).creditFree, true);
  assert.equal(usableCredit(free, { freeTypes: [], paidTypes: [] }), null);
  assert.equal(usableCredit([{ type: 'codex-credits', hasCredits: true, balance: 0 }], null), null);
  assert.equal(usableCredit([{ type: 'codex-credits', hasCredits: true, balance: null }], null), null);
  assert.equal(usableCredit([{ type: 'codex-credits', hasCredits: false, balance: 3 }], null), null);
  const paid = [{ type: 'acme-paid', hasCredits: true, balance: 3, fraction: null, resetsAtMs: null }];
  assert.equal(usableCredit(paid, null), null);
  assert.equal(usableCredit(paid, { paidTypes: ['acme-paid'] }).creditFree, false);
  assert.equal(usableCredit([{ type: 'unknown', hasCredits: true, balance: 3 }], { paidTypes: ['unknown'] }).creditFree, false);
});

function drive(extraAccounts, configCredits) {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const now = T0;
  const accounts = () => [
    { lane: 'ok', provider: 'codex', accountKey: 'ok', health: 'healthy', models: ['gpt-6.1-sol'],
      weekly: { used: 0.2, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live' },
    ...extraAccounts,
  ];
  const config = { cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false },
    ...(configCredits === undefined ? {} : { credits: configCredits }) };
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
    run: async () => {
      await plugin.setup(io);
      state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug: 'gpt-6-1-sol', intelligenceIndex: 60,
        intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
  };
}

const spent = (key, credits) => ({ lane: key, provider: 'codex', accountKey: key, health: 'healthy', models: ['gpt-6.1-sol'],
  weekly: { used: 1.0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
  observedAt: new Date(T0).toISOString(), quality: 'live', ...(credits === undefined ? {} : { credits }) });

test('weekly-spent Codex lane with free credits stays available and paced; without stays excluded', async () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 12.5, fraction: 0.4, resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const cap = await drive([spent('with-free', free), spent('without')]).run();
  const withFree = cap.accounts.find(a => a.accountId === 'codex:with-free');
  assert.notEqual(withFree.action, 'excluded');
  assert.equal(withFree.headroomSource, 'credits');
  assert.equal(withFree.creditType, 'codex-credits');
  assert.equal(withFree.creditFree, true);
  assert.equal(withFree.creditBalance, 12.5);
  assert.ok(withFree.requiredRatePerHour > 0, 'drain-paced required rate');
  assert.ok(withFree.targetShare > 0, 'earns sustainable share');
  const without = cap.accounts.find(a => a.accountId === 'codex:without');
  assert.equal(without.action, 'excluded');
  assert.ok(/weekly window exhausted/.test(without.reason));
});

test('paid credits stay excluded unless the operator allows the type', async () => {
  const paid = [{ type: 'acme-paid', hasCredits: true, balance: 9, fraction: 0.9, resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const denied = await drive([spent('paid', paid)]).run();
  assert.equal(denied.accounts.find(a => a.accountId === 'codex:paid').action, 'excluded');
  const allowed = await drive([spent('paid', paid)], { paidTypes: ['acme-paid'] }).run();
  const view = allowed.accounts.find(a => a.accountId === 'codex:paid');
  assert.notEqual(view.action, 'excluded');
  assert.equal(view.headroomSource, 'credits');
  assert.equal(view.creditFree, false);
});

test('zero-balance free grant is excluded: empty is never capacity', async () => {
  const empty = [{ type: 'codex-credits', hasCredits: true, balance: 0, fraction: 0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const cap = await drive([spent('empty', empty)]).run();
  assert.equal(cap.accounts.find(a => a.accountId === 'codex:empty').action, 'excluded');
});

// Review #38 finding 1: a credit entry without a fraction (the Has-Credits
// plus Balance feed shape) must stay routable at full-window headroom, not
// report 0 and drop out of the allocation order.
test('credit lane without a fraction routes at full-window headroom', async () => {
  const noFraction = [{ type: 'codex-credits', hasCredits: true, balance: 5 }];
  const cap = await drive([spent('nofrac', noFraction)]).run();
  const view = cap.accounts.find(a => a.accountId === 'codex:nofrac');
  assert.notEqual(view.action, 'excluded');
  assert.equal(view.headroomSource, 'credits');
  assert.equal(view.headroomPct, 1);
  assert.ok(view.targetShare > 0, 'earns sustainable share');
  assert.ok(orderAccountsForRun(cap.accounts).some(v => v.accountId === 'codex:nofrac'), 'in the allocation order');
});

// A quantified fraction at or below the routing reserve honestly reports
// itself: only the unquantified (null) case reads as a full window.
test('credit lane with a depleted quantified fraction stays out of the order', async () => {
  const low = [{ type: 'codex-credits', hasCredits: true, balance: 1, fraction: 0.03,
    resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const cap = await drive([spent('low', low)]).run();
  const view = cap.accounts.find(a => a.accountId === 'codex:low');
  assert.equal(view.headroomPct, 0.03);
  assert.ok(!orderAccountsForRun(cap.accounts).some(v => v.accountId === 'codex:low'));
});

// Review #38 finding 2: the fleet concurrency target counts the credit pool
// over the credit reset horizon, not the spent weekly window. The credit
// lane carries a 5h burn sample (its weekly meter is flat at 100%) so C*
// has a measured burn; pre-fix its need was 0/96h and it earned 0 slots.
function driveCreditGroup() {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  const accounts = () => [
    { lane: 'ok', provider: 'codex', accountKey: 'ok', health: 'healthy', models: ['gpt-6.1-sol'],
      weekly: { used: 0.2 + step * 0.01, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live',
      usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 } },
    { lane: 'cr', provider: 'codex', accountKey: 'cr', health: 'healthy', models: ['gpt-6.1-sol'],
      weekly: { used: 1.0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1 + step * 0.04, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live',
      usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 },
      credits: [{ type: 'codex-credits', hasCredits: true, balance: 9, fraction: 0.5,
        resetsAt: new Date(T0 + 48 * 3600000).toISOString() }] },
  ];
  const config = { cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false } };
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
      state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug: 'gpt-6-1-sol', intelligenceIndex: 60,
        intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: async i => {
      now = T0 + i * 5 * MIN;
      step = i;
      if (i > 0) for (let n = 0; n < 10; n++) {
        await handlers.get('agent.run.started')({ companyId: 'acme', entityId: `cr-run-${i}-${n}`,
          payload: { run: { agentId: 'eng', model: 'gpt-6.1-sol' } }, occurredAt: new Date(now - (n + 1) * 1000).toISOString() });
      }
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
  };
}

test('credit capacity counts in C* slots over the credit horizon', async () => {
  const d = driveCreditGroup();
  await d.setup();
  let cap;
  for (let i = 0; i <= 6; i++) cap = await d.tick(i);
  const view = cap.accounts.find(a => a.accountId === 'codex:cr');
  assert.equal(view.calibrationSource, 'account-five-hour');
  const row = cap.perAccount.find(a => a.accountId === 'codex:cr');
  assert.ok(row.slots > 0, `credit lane earns concurrency slots, got ${row.slots}`);
  assert.ok(row.runsPerHour > 0, `credit lane earns runs/hour, got ${row.runsPerHour}`);
});

const MIN = 60000;

function driveDrain(fractions) {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  const accounts = () => [{
    lane: 'cr', provider: 'codex', accountKey: 'cr', health: 'healthy', models: ['gpt-6.1-sol'],
    weekly: { used: 1.0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
    observedAt: new Date(now).toISOString(), quality: 'live',
    credits: [{ type: 'codex-credits', hasCredits: true, balance: 10, fraction: fractions[step],
      resetsAt: new Date(T0 + 96 * 3600000).toISOString() }],
  }];
  const config = { cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false } };
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
      state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug: 'gpt-6-1-sol', intelligenceIndex: 60,
        intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: async i => {
      now = T0 + i * 5 * MIN;
      step = i;
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
  };
}

// Review #38 finding 3: the controller paces the measured credit drain, so a
// lane draining ~20x above pace holds the floor instead of climbing to the
// ceiling on the flat weekly meter.
test('falling credit fraction paces the drain without climbing', async () => {
  const fractions = Array.from({ length: 14 }, (_, i) => 0.6 - i * 0.01);
  const d = driveDrain(fractions);
  await d.setup();
  let cap;
  for (let i = 0; i < fractions.length; i++) {
    cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.equal(view.pointer, 0, `tick ${i}: pointer holds the floor while credits drain above pace`);
  }
  const view = cap.accounts.find(a => a.accountId === 'codex:cr');
  assert.equal(view.rateBasis, 'measured');
  assert.ok(view.measuredRatePerHour > view.requiredRatePerHour,
    `measured ${view.measuredRatePerHour} tracks the credit drain above required ${view.requiredRatePerHour}`);
});
