import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Reviewer probe (round 6): loadLedger used to read the memory overlay
// BEFORE awaiting the ledger-v1 state read, then blind-set the merged
// result -- any run recorded during that await (run event, event-time or
// hook decision, all via direct ledgers.set) was lost on overwrite. Now
// every writer goes through getOrLoadLedger (joining a load in flight)
// and the load merges the CURRENT map entry after its awaits.
//
// Test: gen1 ticks (live view + enforced hook decision persisted), gen2
// restarts with the ledger-v1 read gated, a run.started fires while the
// load is pending, then everything must be present in persisted state.
// (A hook call during the pending load answers `keep` -- no live view
// exists pre-tick -- and records nothing; the hook writer path shares the
// same helper, proven by gen1's enforced decision surviving.)

const TICK = Date.parse('2026-10-08T23:00:00Z');
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
  observedAt: '2026-10-08T22:59:00Z', quality: 'reactive',
});

const started = (runId, atMs) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', adapterType: 'claude-code' } },
  occurredAt: new Date(atMs).toISOString(),
});

test('runs recorded while the ledger load is pending survive in persisted state', async () => {
  const store = new Map();
  const skey = k => JSON.stringify(k);
  let releaseLoad = null;
  let gateLoad = false;
  const io = (jobs, handlers) => ({
    config: { get: async () => ({ enforce: true, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => {
        if (gateLoad && skey(k).includes('ledger-v1')) await new Promise(r => { releaseLoad = r; });
        return store.get(skey(k)) ?? null;
      },
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ observedAt: new Date(TICK).toISOString(), accounts: [kimiLane()] }) }) },
    agents: { get: async (agentId, companyId) => (agentId === 'agent-9' ? { adapterType: 'claude-code' } : null) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  });
  const jobs1 = new Map();
  const handlers1 = new Map();
  let plugin = createModelCapacityPlugin({ clock: () => TICK, requirePinnedLaneHost: false });
  await plugin.setup(io(jobs1, handlers1));
  await plugin.onConfigChanged({ enforce: true }, { companyId: 'acme' });
  store.set(skey(AA_STATE_KEY), {
    fetchedAt: new Date(TICK).toISOString(),
    rows: [aaRow('claude-opus-5-5'), aaRow('claude-sonnet-5-5-high'), aaRow('claude-haiku-5-5'), aaRow('claude-haiku-5-5-xhigh'), aaRow('kimi-k3'), aaRow('gemini-2-5-flash')],
    duplicateSlugs: [],
  });
  // Gen1: live view + enforced hook decision, persisted.
  await jobs1.get('shadow-tick')({});
  const hookOut = await plugin.onResolveRunModel({
    runId: 'run-hook', companyId: 'acme', agentId: 'agent-9', issueId: null,
    adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
    agentDefaultModel: null, previous: null, issueOverrideModel: null,
    deadlineMs: 1500,
  });
  assert.equal(hookOut.kind, 'decide');
  await handlers1.get('agent.run.started')(started('run-hook', TICK));
  await jobs1.get('shadow-tick')({});
  const persisted1 = store.get(skey(LEDGER_STATE_KEY));
  assert.ok(persisted1.some(r => r.runId === 'run-hook' && r.enforced === true), 'gen1 hook decision persisted');

  // Gen2 (restart): gate the ledger-v1 read, fire a start while pending.
  const jobs2 = new Map();
  const handlers2 = new Map();
  plugin = createModelCapacityPlugin({ clock: () => TICK, requirePinnedLaneHost: false });
  await plugin.setup(io(jobs2, handlers2));
  await plugin.onConfigChanged({ enforce: true }, { companyId: 'acme' });
  gateLoad = true;
  const tickP = jobs2.get('shadow-tick')({});
  // Wait until the tick is genuinely parked INSIDE the ledger-v1 read
  // (past the overlay snapshot the old code took here). Only then fire,
  // so the write provably lands during the await -- the interleaving the
  // old code lost.
  for (let i = 0; i < 200 && releaseLoad === null; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(releaseLoad !== null, 'load hit the gated read');
  const fireP = handlers2.get('agent.run.started')(started('run-pending', TICK));
  const hookP = plugin.onResolveRunModel({
    runId: 'run-hook2', companyId: 'acme', agentId: 'agent-9', issueId: null,
    adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
    agentDefaultModel: null, previous: null, issueOverrideModel: null,
    deadlineMs: 1500,
  });
  await new Promise(r => setTimeout(r, 20));
  releaseLoad();
  gateLoad = false;
  await tickP;
  await fireP;
  const hookKeep = await hookP;
  assert.equal(hookKeep.kind, 'keep');
  // Both runs survive: the carried hook decision via the persisted base,
  // the pending-load start via the post-await merge.
  const persisted = store.get(skey(LEDGER_STATE_KEY));
  const byId = new Map(persisted.map(r => [r.runId, r]));
  assert.ok(byId.has('run-hook') && byId.get('run-hook').enforced === true, 'carried hook decision survives reload');
  assert.ok(byId.has('run-pending'), 'run recorded during pending load survives');
  const shadow = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' });
  assert.ok(shadow.body.entries.some(e => e.runId === 'run-hook'), 'hook decision visible in /shadow');
});
