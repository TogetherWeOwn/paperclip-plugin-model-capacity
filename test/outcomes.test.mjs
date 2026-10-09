import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSnapshot, classifyOutcome, familyOutcomes } from '../src/outcomes.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// "finished" read 98-100% for Muse and Claude alike. The
// report now says whether the run moved its issue.

test('issueSnapshot keeps only what the outcome reads', () => {
  assert.equal(issueSnapshot(null), null);
  assert.deepEqual(issueSnapshot({ status: 'in_progress' }), { status: 'in_progress', workProductRunIds: [], handoffOwedRunId: null });
  const snap = issueSnapshot({
    status: 'in_review',
    workProducts: [{ createdByRunId: 'r1' }, { createdByRunId: null }, {}],
    successfulRunHandoff: { state: 'required', required: true, sourceRunId: 'r2' },
  });
  assert.deepEqual(snap, { status: 'in_review', workProductRunIds: ['r1'], handoffOwedRunId: 'r2' });
  // A resolved handoff owes nothing.
  assert.equal(issueSnapshot({ successfulRunHandoff: { state: 'resolved', required: false, sourceRunId: 'r2' } }).handoffOwedRunId, null);
});

const after = (status, extra = {}) => issueSnapshot({ status, ...extra });

test('a move onto a disposition is progress', () => {
  for (const status of ['done', 'in_review', 'blocked', 'cancelled']) {
    assert.equal(classifyOutcome({ runId: 'r', baselineStatus: 'in_progress', after: after(status) }).outcome, 'progressed', status);
  }
});

test('checkout is not progress: a move into in_progress, or no move, reads noChange', () => {
  assert.equal(classifyOutcome({ runId: 'r', baselineStatus: 'todo', after: after('in_progress') }).outcome, 'noChange');
  assert.equal(classifyOutcome({ runId: 'r', baselineStatus: 'in_progress', after: after('in_progress') }).outcome, 'noChange');
});

test('a work product created by THIS run is progress, another run\'s is not', () => {
  const mine = after('in_progress', { workProducts: [{ createdByRunId: 'r' }] });
  const theirs = after('in_progress', { workProducts: [{ createdByRunId: 'other' }] });
  assert.equal(classifyOutcome({ runId: 'r', baselineStatus: 'in_progress', after: mine }).outcome, 'progressed');
  assert.equal(classifyOutcome({ runId: 'r', baselineStatus: 'in_progress', after: theirs }).outcome, 'noChange');
  // Without a baseline a work product still proves progress.
  assert.equal(classifyOutcome({ runId: 'r', baselineStatus: null, after: mine }).outcome, 'progressed');
});

test('no baseline and no work product is unknown, never a guessed noChange', () => {
  assert.equal(classifyOutcome({ runId: 'r', baselineStatus: null, after: after('in_progress') }).outcome, 'unknown');
  assert.equal(classifyOutcome({ runId: 'r', baselineStatus: 'in_progress', after: null }).outcome, 'unknown');
});

test('the platform handoff flag is carried as a signal for this run only', () => {
  const owed = after('in_progress', { successfulRunHandoff: { state: 'required', required: true, sourceRunId: 'r' } });
  const res = classifyOutcome({ runId: 'r', baselineStatus: 'in_progress', after: owed });
  assert.equal(res.outcome, 'noChange');
  assert.equal(res.signals.handoffOwed, true);
  assert.equal(classifyOutcome({ runId: 'someone-else', baselineStatus: 'in_progress', after: owed }).signals.handoffOwed, false);
});

const NOW = 1_750_000_000_000;
const rec = (runId, status, extra = {}) => ({ runId, status, terminalAt: NOW - 60000, ...extra });
const familyOf = (r) => r.family ?? null;

test('familyOutcomes: Muse and Claude finish alike but only one moves issues', () => {
  const records = [
    ...Array.from({ length: 10 }, (_, i) => rec(`m${i}`, 'finished', { family: 'muse', progress: i < 1 ? 'progressed' : 'noChange' })),
    ...Array.from({ length: 10 }, (_, i) => rec(`c${i}`, 'finished', { family: 'opus', progress: i < 8 ? 'progressed' : 'noChange' })),
    rec('mf', 'failed', { family: 'muse' }),
    rec('cx', 'cancelled', { family: 'opus' }),
    rec('mu', 'finished', { family: 'muse', progress: 'unknown', handoffOwed: true }),
  ];
  const out = familyOutcomes(records, { nowMs: NOW, familyOf });
  assert.equal(out.muse.finished, 11);
  assert.equal(out.muse.failed, 1);
  assert.ok(Math.abs(out.muse.finishRate - 11 / 12) < 1e-9);
  assert.ok(Math.abs(out.muse.progressRate - 0.1) < 1e-9, 'progressed over progressed + noChange; unknown excluded');
  assert.equal(out.muse.unknown, 1);
  assert.equal(out.muse.handoffOwed, 1);
  assert.equal(out.opus.finishRate, 1, 'cancelled runs say nothing about the model');
  assert.ok(Math.abs(out.opus.progressRate - 0.8) < 1e-9);
  assert.equal(out.opus.cancelled, 1);
});

test('familyOutcomes: window, running runs and unresolved families', () => {
  const out = familyOutcomes([
    rec('old', 'finished', { family: 'muse', progress: 'progressed', terminalAt: NOW - 25 * 3600 * 1000 }),
    rec('run', 'running', { family: 'muse' }),
    rec('nofam', 'finished', { progress: 'noChange' }),
  ], { nowMs: NOW, familyOf });
  assert.deepEqual(Object.keys(out), ['unknown']);
  assert.equal(out.unknown.progressRate, 0);
});

// --- plugin wiring: baseline while running, classification after finish.

const TICK = Date.parse('2026-10-09T12:00:00Z');
const MIN = 60 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const aaRows = () => ([
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 60, intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 },
]);

function drive(issueFor) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  const reads = [];
  const io = {
    config: { get: async () => ({ cliproxy: { laneKeySecretRef: SECRET } }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          observedAt: new Date(now).toISOString(),
          accounts: [{
            lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
            models: ['claude-haiku-5-5'],
            weekly: { used: 0.3, resetsAt: '2026-10-15T22:59:00Z' },
            fiveHour: { used: 0.1, resetsAt: '2026-10-09T17:00:00Z' },
            observedAt: new Date(now).toISOString(), quality: 'live',
          }],
        }),
      }),
    },
    agents: { get: async () => ({ adapterType: 'claude-code', adapterConfig: { model: 'claude-haiku-5-5' } }) },
    issues: {
      get: async (issueId) => { reads.push(issueId); return issueFor(issueId, now); },
      list: async () => [],
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    reads,
    store,
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_SKEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged({}, { companyId: 'acme' });
    },
    at: async (t, fire = []) => {
      now = t;
      for (const e of fire) await handlers.get(e.type)(e);
      await jobs.get('shadow-tick')({});
    },
    capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body,
  };
}

const evt = (type, runId, at, issueId) => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', issueId, model: 'claude-haiku-5-5' } },
  occurredAt: new Date(at).toISOString(),
});

test('the tick baselines a running issue and scores the finished run against it', async () => {
  // Issue A moves in_progress -> in_review after the run; issue B stays put.
  const status = { 'iss-a': 'in_progress', 'iss-b': 'in_progress' };
  const d = drive((id) => ({ id, status: status[id], workProducts: [] }));
  await d.setup();
  await d.at(TICK, [evt('agent.run.started', 'run-a', TICK, 'iss-a'), evt('agent.run.started', 'run-b', TICK, 'iss-b')]);
  status['iss-a'] = 'in_review';
  await d.at(TICK + 5 * MIN, [
    evt('agent.run.finished', 'run-a', TICK + 4 * MIN, 'iss-a'),
    evt('agent.run.finished', 'run-b', TICK + 4 * MIN, 'iss-b'),
  ]);
  const cap = await d.capacity();
  const fam = cap.familyOutcomes.haiku;
  assert.equal(fam.finished, 2);
  assert.equal(fam.progressed, 1);
  assert.equal(fam.noChange, 1);
  assert.equal(fam.progressRate, 0.5);
});

test('an issue that cannot be read is retried then closed as unknown, never stuck', async () => {
  const d = drive(() => { throw new Error('issues down'); });
  await d.setup();
  await d.at(TICK, [evt('agent.run.started', 'run-x', TICK, 'iss-x')]);
  await d.at(TICK + 1 * MIN, [evt('agent.run.finished', 'run-x', TICK + 1 * MIN, 'iss-x')]);
  for (let i = 2; i <= 6; i++) await d.at(TICK + i * MIN);
  const cap = await d.capacity();
  assert.equal(cap.familyOutcomes.haiku.unknown, 1);
  const readsAfter = d.reads.length;
  await d.at(TICK + 7 * MIN);
  assert.equal(d.reads.length, readsAfter, 'closed runs are not re-read');
});

test('runs past the evaluation window are closed unknown without a read', async () => {
  const d = drive((id) => ({ id, status: 'in_review', workProducts: [] }));
  await d.setup();
  await d.at(TICK, [evt('agent.run.finished', 'run-late', TICK, 'iss-late')]);
  const before = d.reads.length;
  await d.at(TICK + 40 * MIN);
  const cap = await d.capacity();
  assert.equal(cap.familyOutcomes.haiku.unknown, 1);
  assert.equal(d.reads.length, before, 'no issue read for a run past the window');
});

test('a baseline first read late is not trusted: the run scores unknown, not noChange', async () => {
  // The first tick sees the run 10 minutes in; by then the agent may already
  // have moved the issue, so the status read would not be a baseline.
  const d = drive((id) => ({ id, status: 'in_review', workProducts: [] }));
  await d.setup();
  await d.at(TICK + 10 * MIN, [evt('agent.run.started', 'run-late', TICK, 'iss-late')]);
  await d.at(TICK + 11 * MIN, [evt('agent.run.finished', 'run-late', TICK + 11 * MIN, 'iss-late')]);
  await d.at(TICK + 12 * MIN);
  const cap = await d.capacity();
  assert.equal(cap.familyOutcomes.haiku.unknown, 1);
  assert.equal(cap.familyOutcomes.haiku.noChange, 0);
});

test('baseline read failures do not spend the evaluation attempts', async () => {
  let failing = true;
  const status = { 'iss-t': 'in_progress' };
  const d = drive((id) => {
    if (failing) throw new Error('transient');
    return { id, status: status[id], workProducts: [] };
  });
  await d.setup();
  await d.at(TICK, [evt('agent.run.started', 'run-t', TICK, 'iss-t')]);
  await d.at(TICK + 1 * MIN);
  await d.at(TICK + 2 * MIN);
  failing = false;
  status['iss-t'] = 'done';
  // Baseline attempts were spent (3 failed reads). The evaluation read must
  // still run and classify the run -- not be closed by the shared counter.
  const readsBefore = d.reads.length;
  await d.at(TICK + 3 * MIN, [evt('agent.run.finished', 'run-t', TICK + 3 * MIN, 'iss-t')]);
  assert.ok(d.reads.length > readsBefore, 'the finished run was evaluated');
  const ledger = d.store.get(JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'ledger-v1' }));
  const rec = ledger.find(r => r.runId === 'run-t');
  assert.equal(rec.baselineTries, 3);
  assert.equal(rec.evalTries ?? 0, 0);
  assert.equal(rec.progress, 'unknown', 'no baseline and no work product: unknown, but classified');
});
