import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCredits, usableCredit, DEFAULT_CREDITS } from '../src/credits.mjs';
import { parseLaneAccount, parseCredits } from '../src/cliproxy.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
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
