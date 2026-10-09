import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { createLedger, ledgerToJSON, ledgerFromJSON, recordStart } from '../src/ledger.mjs';

// Reviewer probe (round 7): getOrLoadLedger's load-failure fallback used to
// serve the TICK too, so one failed ledger-v1 read after a restart let the
// tick persist the (often empty) memory overlay OVER the saved ledger --
// permanently wiping it. Now the tick loads directly (a throw aborts before
// any persist) plus a loadedOk persist guard; only the memory-only
// event/event-time/hook paths keep the fallback.
//
// Test: the first ledger-v1 read throws once. Tick 1 aborts with the saved
// ledger byte-identical; a run.started fired in the failed window records
// memory-only and triggers no persist; tick 2 loads and persists BOTH runs.

const TICK = Date.parse('2026-10-09T15:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const LEDGER_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'ledger-v1' };

const aaRow = (slug) => ({
  slug, intelligenceIndex: 55, intelligenceIndexCostPerTask: 10,
  price1mInputTokens: 1, price1mOutputTokens: 4,
});

const kimiLane = () => ({
  lane: 'kimi-k1', provider: 'kimi', accountKey: 'k1',
  health: 'healthy', meter: 'reactive', pool: null,
  models: ['kimi-k3-256k'],
  weekly: { used: null, resetsAt: null },
  fiveHour: { used: null, resetsAt: null },
  observedAt: '2026-10-09T14:59:00Z', quality: 'reactive',
});

const started = (runId, atMs) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', adapterType: 'claude-code' } },
  occurredAt: new Date(atMs).toISOString(),
});

test('a failed ledger load aborts the tick and never wipes the saved ledger', async () => {
  const store = new Map();
  const skey = k => JSON.stringify(k);
  // Saved ledger: one in-flight run from before the restart.
  const saved = createLedger();
  recordStart(saved, { runId: 'run-saved', agentId: 'agent-9' }, TICK - 60000);
  const savedJSON = ledgerToJSON(saved);
  store.set(skey(LEDGER_STATE_KEY), savedJSON);

  // The outage covers tick 1 AND the run event (one failed read each);
  // tick 2 recovers. This proves the event path degrades memory-only while
  // the tick path aborts.
  let failLoads = 2;
  const errors = [];
  const io = {
    config: { get: async () => ({ enforce: true, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => {
        if (skey(k).includes('ledger-v1') && failLoads > 0) {
          failLoads -= 1;
          throw new Error('state-outage');
        }
        return store.get(skey(k)) ?? null;
      },
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ observedAt: new Date(TICK).toISOString(), accounts: [kimiLane()] }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error: (...a) => { errors.push(a); } },
  };
  const jobs = new Map();
  const handlers = new Map();
  const plugin = createModelCapacityPlugin({ clock: () => TICK });
  await plugin.setup(io);
  await plugin.onConfigChanged({ enforce: true }, { companyId: 'acme' });
  store.set(skey(AA_STATE_KEY), {
    fetchedAt: new Date(TICK).toISOString(),
    rows: [aaRow('kimi-k3')],
    duplicateSlugs: [],
  });

  // Tick 1: the ledger read throws -> the tick aborts (the job wrapper
  // reports shadow-tick-failed; the outage itself is logged), saved ledger
  // untouched.
  await assert.rejects(jobs.get('shadow-tick')({}), /shadow-tick-failed/);
  assert.ok(errors.some(a => String(a[1]?.error ?? a).includes('state-outage')), 'outage logged');
  assert.deepEqual(store.get(skey(LEDGER_STATE_KEY)), savedJSON);

  // A run starts in the failed window: recorded memory-only (fallback logs),
  // and the event path performs no persist of its own.
  await handlers.get('agent.run.started')(started('run-live', TICK));
  assert.ok(errors.some(a => String(a[0]).includes('memory-only')), 'fallback logged');
  assert.deepEqual(store.get(skey(LEDGER_STATE_KEY)), savedJSON);

  // Tick 2: the read recovers, the load merges the memory run, both persist.
  await jobs.get('shadow-tick')({});
  const persisted = ledgerFromJSON(store.get(skey(LEDGER_STATE_KEY)));
  assert.ok(persisted.has('run-saved'), 'saved run survives the failed load');
  assert.ok(persisted.has('run-live'), 'run recorded during the outage survives');
});
