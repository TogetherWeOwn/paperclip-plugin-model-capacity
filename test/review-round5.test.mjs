import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger, ledgerToJSON, recordStart, recordDecision, recordTerminal,
  calibrationAccount, trimLedger,
} from '../src/ledger.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Review round 5 probes, one regression test each:
// (1) E-calibration must count actual burn, not shadow picks;
// (2) trimLedger must shed dead weight and hard-bound the persisted blob;
// (3) GET /shadow must honor the requested limit with a separately computed size;
// (4) concurrent first-ticks must share one ledger load, not race.

const providers = new Map([['kimi', 'kimi:k1']]);

test('(1) calibration: enforced pick wins, otherwise actual, otherwise provider fallback', () => {
  // Enforced hook decision outranks a conflicting actual.
  assert.equal(
    calibrationAccount({ decidedAccount: 'a', enforced: true, actualAccount: 'b', provider: 'kimi' }, providers),
    'a',
  );
  // Non-enforced shadow/event-time pick does NOT divert calibration.
  assert.equal(
    calibrationAccount({ decidedAccount: 'a', enforced: false, actualAccount: 'b', provider: 'kimi' }, providers),
    'b',
  );
  // No actual: provider fallback still attributes the burn.
  assert.equal(
    calibrationAccount({ decidedAccount: 'a', enforced: false, actualAccount: null, provider: 'kimi' }, providers),
    'kimi:k1',
  );
  // Nothing known: null (unmapped), never a guess.
  assert.equal(calibrationAccount({ enforced: false }, providers), null);
  assert.equal(calibrationAccount({ provider: 'unknown-pool' }, providers), null);
});

test('(2) trim sheds old terminal, old unverified, and stale records, and hard-bounds size', () => {
  const nowMs = 1_760_000_000_000;
  const H = 2 * 3600 * 1000;
  const ledger = createLedger();
  recordTerminal(ledger, { runId: 'term-old', agentId: 'a' }, 'finished', nowMs - 25 * 3600 * 1000);
  recordTerminal(ledger, { runId: 'term-new', agentId: 'a' }, 'finished', nowMs - 1000);
  recordStart(ledger, { runId: 'live', agentId: 'a' }, nowMs - 1000);
  recordDecision(ledger, { runId: 'live', agentId: 'a', accountId: 'kimi:k1' }, nowMs - 1000);
  // Old unverified non-terminal: reconcile excluded it long ago, trim removes it.
  recordStart(ledger, { runId: 'ghost', agentId: 'a' }, nowMs - 25 * 3600 * 1000);
  ledger.get('ghost').unverified = true;
  // Verified but stale-horizon: excluded from counting, shed from persist.
  recordStart(ledger, { runId: 'stale', agentId: 'a' }, nowMs - 3 * H);
  trimLedger(ledger, { nowMs, maxRecords: 100, staleHorizonMs: H });
  assert.ok(!ledger.has('term-old'), 'old terminal trimmed');
  assert.ok(ledger.has('term-new'), 'fresh terminal retained');
  assert.ok(!ledger.has('ghost'), 'old unverified non-terminal trimmed');
  assert.ok(!ledger.has('stale'), 'stale-horizon non-terminal trimmed');
  assert.ok(ledger.has('live'), 'live record retained');
});

test('(2) trim hard-bounds an over-cap ledger, newest activity survives', () => {
  const nowMs = 1_760_000_000_000;
  const ledger = createLedger();
  for (let i = 0; i < 8; i++) {
    recordStart(ledger, { runId: `r${i}`, agentId: 'a' }, nowMs - (8 - i) * 60_000);
  }
  trimLedger(ledger, { nowMs, maxRecords: 5, staleHorizonMs: 2 * 3600 * 1000 });
  assert.equal(ledger.size, 5);
  for (const id of ['r3', 'r4', 'r5', 'r6', 'r7']) assert.ok(ledger.has(id), `${id} (newest) retained`);
});

const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const LEDGER_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'ledger-v1' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

test('(3) /shadow honors the requested limit; size is the full decided count', async () => {
  const nowMs = 1_760_000_000_000;
  const ledger = createLedger();
  for (let i = 0; i < 150; i++) {
    recordStart(ledger, { runId: `run-${i}`, agentId: 'a' }, nowMs - (150 - i) * 1000);
    recordDecision(ledger, { runId: `run-${i}`, agentId: 'a', accountId: 'kimi:k1' }, nowMs - (150 - i) * 1000);
  }
  const store = new Map();
  const skey = k => JSON.stringify(k);
  const fake = {
    config: { get: async () => ({ cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ observedAt: new Date(nowMs).toISOString(), accounts: [] }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register() {} },
    events: { on() {} },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => nowMs, requirePinnedLaneHost: false });
  await plugin.setup(fake);
  await plugin.onConfigChanged({}, { companyId: 'acme' });
  store.set(skey(LEDGER_STATE_KEY), ledgerToJSON(ledger));
  const wide = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow', query: { limit: '500' } });
  assert.equal(wide.body.entries.length, 150);
  assert.equal(wide.body.size, 150);
  const def = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' });
  assert.equal(def.body.entries.length, 100);
  assert.equal(def.body.size, 150);
});

test('(4) concurrent first ticks share one ledger load', async () => {
  const nowMs = 1_760_000_000_000;
  const store = new Map();
  const jobs = new Map();
  const skey = k => JSON.stringify(k);
  let ledgerGets = 0;
  const fake = {
    config: { get: async () => ({ cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => {
        await new Promise(r => setTimeout(r, 20));
        if (skey(k).includes('ledger-v1')) ledgerGets += 1;
        return store.get(skey(k)) ?? null;
      },
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          observedAt: new Date(nowMs).toISOString(),
          accounts: [{
            lane: 'kimi-k1', provider: 'kimi', accountKey: 'k1', health: 'healthy',
            weekly: { used: 0.3, resetsAt: '2026-10-15T22:59:00Z' },
            fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
            observedAt: new Date(nowMs).toISOString(), quality: 'live',
          }],
        }),
      }),
    },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on() {} },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => nowMs, requirePinnedLaneHost: false });
  await plugin.setup(fake);
  store.set(skey(AA_STATE_KEY), {
    fetchedAt: new Date(nowMs).toISOString(),
    rows: [{ slug: 'kimi-k3', intelligenceIndex: 55, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 }],
    duplicateSlugs: [],
  });
  await plugin.onConfigChanged({}, { companyId: 'acme' });
  await Promise.all([jobs.get('shadow-tick')({}), jobs.get('shadow-tick')({})]);
  assert.equal(ledgerGets, 1);
});
