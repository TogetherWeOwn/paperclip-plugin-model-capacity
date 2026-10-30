import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';
import { decide, DEFAULT_CONTEXT_CAPS, MAX_OUTPUT_ENV_KEY } from '../src/decide.mjs';
import { MODEL_ROUTING_ENV_KEYS } from '../src/manifest.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

const laneBody = (weeklyUsed, fiveHourUsed = 0.1, observedAt = '2026-10-08T22:59:00Z') => ({
  observedAt,
  accounts: [{
    lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
    weekly: { used: weeklyUsed, resetsAt: '2026-10-15T22:59:00Z' },
    fiveHour: { used: fiveHourUsed, resetsAt: '2026-10-09T03:59:00Z' },
    observedAt, quality: 'live',
  }],
});

const hookParams = (extra = {}) => ({
  runId: 'run-hook-1', companyId: 'acme', agentId: 'agent-9', issueId: null,
  adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
  agentDefaultModel: null, previous: null, issueOverrideModel: null,
  deadlineMs: 1500, ...extra,
});

const runEvent = (runId, atMs, extra = {}, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', provider: 'claude', ...extra } },
  occurredAt: new Date(atMs).toISOString(),
});

// Runs facts come from SDK surfaces only: agent.run.* events plus strict
// object-form issues/agents reads ({issueId, companyId} / {agentId,
// companyId}). Positional calls are a host-contract violation, so the fakes
// throw on them -- any regression back to positional reads fails the suite.
const strictGet = (table, fail) => async (id, companyId) => {
  if (typeof id !== 'string' || typeof companyId !== 'string') {
    throw new Error('companyId is required for this operation');
  }
  if (fail) throw new Error(fail);
  return table[id] ?? null;
};

function drive({ nowMs, config = {}, laneUsed = 0.3, fiveHourUsed = 0.1, issueGets = {}, agentGets = {}, issueLists = {}, issuesListError = null, failIssueGet = null, failAgentGet = null }) {
  // Keep resolver IO/readiness behavior testable without a weekly liveness exception.
  config = { pacing: { holdAheadPts: null }, ...config };
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
  let lane = laneBody(laneUsed, fiveHourUsed, new Date(now).toISOString());
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, now) }) },
    agents: { get: strictGet(agentGets, failAgentGet) },
    issues: {
      get: strictGet(issueGets, failIssueGet),
      list: async ({ status } = {}) => {
        if (issuesListError) throw new Error(issuesListError);
        return issueLists[status] ?? [];
      },
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    io,
    setNow: ms => { now = ms; },
    setLane: (used, five = fiveHourUsed) => { lane = laneBody(used, five, new Date(now).toISOString()); },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('quota-refresh')({}),
    fire: (e) => handlers.get(e.type)(e),
    hook: (p) => plugin.onResolveRunModel(hookParams(p)),
    api: (routeKey) => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    // Prove the hook path is memory-only: every I/O surface throws, so any
    // read past memory fails the call instead of hiding latency.
    killIo: () => {
      for (const k of ['config', 'state', 'secrets', 'http', 'agents', 'issues']) {
        io[k] = new Proxy({}, { get: () => { throw new Error(`io-forbidden:${k}`); } });
      }
    },
  };
}

test('enforce defaults false: fresh state still answers keep', async () => {
  const d = drive({ nowMs: TICK, config: {} });
  await d.setup();
  await d.tick();
  d.killIo();
  assert.deepEqual(await d.hook(), { kind: 'keep' });
});

test('enforce true with fresh state decides from memory with no I/O', async () => {
  const d = drive({ nowMs: TICK, config: { enforce: true } });
  await d.setup();
  await d.tick();
  d.killIo();
  const out = await d.hook();
  assert.equal(out.kind, 'decide');
  assert.match(out.decisionId, /^mc-/);
  assert.equal(out.source, 'model-capacity');
  assert.ok(typeof out.model === 'string' && out.model.length > 0);
  for (const k of Object.keys(out.env ?? {})) {
    assert.ok(MODEL_ROUTING_ENV_KEYS.includes(k), `undeclared env key ${k}`);
  }
});

test('unknown company and operator override answer keep; stale ticks defer (fail-closed)', async () => {
  const d = drive({ nowMs: TICK, config: { enforce: true, credentialReadiness: { enforce: true } } });
  await d.setup();
  await d.tick();
  d.killIo();
  assert.deepEqual(await d.hook({ companyId: 'nobody' }), { kind: 'keep' });
  assert.deepEqual(await d.hook({ issueOverrideModel: 'claude-opus-5-5' }), { kind: 'keep' });
  // A stale routing snapshot also carries stale credential evidence: admission
  // is fail-closed, so the hook defers instead of keeping an unvetted model.
  d.setNow(TICK + 121000);
  const stale = await d.hook();
  assert.equal(stale.kind, 'defer');
  assert.equal(stale.retryAfterMs, 60000);
  assert.match(stale.reason, /stale/);
});

test('credential readiness off keeps on a stale routing snapshot', async () => {
  const d = drive({ nowMs: TICK, config: { enforce: true, credentialReadiness: { enforce: false } } });
  await d.setup();
  await d.tick();
  d.killIo();
  d.setNow(TICK + 121000);
  assert.deepEqual(await d.hook(), { kind: 'keep' });
});

test('no headroom anywhere defers with a ~60s retry', async () => {
  const d = drive({ nowMs: TICK, config: { enforce: true }, fiveHourUsed: 0.99 });
  await d.setup();
  await d.tick();
  d.killIo();
  const out = await d.hook();
  assert.equal(out.kind, 'defer');
  assert.equal(out.retryAfterMs, 60000);
});

test('enforced decisions merge into the ring flagged enforced:true', async () => {
  const d = drive({ nowMs: TICK, config: { enforce: true } });
  await d.setup();
  await d.tick();
  const decided = await d.hook({ runId: 'run-enforced-1' });
  assert.equal(decided.kind, 'decide');
  d.setNow(TICK + 60000);
  d.setLane(0.301);
  await d.tick();
  const shadow = await d.api('shadow');
  const entry = shadow.body.entries.find(e => e.runId === 'run-enforced-1');
  assert.ok(entry, 'enforced run lands in the ring');
  assert.equal(entry.enforced, true);
  assert.match(entry.wouldModel, new RegExp(`^${decided.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(`));
});

test('decide sets exactly the declared env keys on sol/luna arms', () => {
  const d = decide({
    runId: 'r', agentId: 'a', role: 'doer',
    ladderRungs: [{ rung: 0, arms: [{ armId: 'sol', model: 'gpt-6-sol', effort: 'high', family: 'sol', contextWindow: 272000, Q: 1, C: 1 }] }],
    pointer: 0, fiveHourHeadroomPct: null, burnPerRunPct: {},
    accountId: 'codex:1', contextCaps: DEFAULT_CONTEXT_CAPS,
  });
  assert.equal(d.kind, 'decide');
  // Sol/luna arms set the two context keys; the third declared key
  // (max output) is haiku-only. Everything set must be declared.
  assert.deepEqual(Object.keys(d.env).sort(), [
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  ]);
  for (const k of Object.keys(d.env)) {
    assert.ok(MODEL_ROUTING_ENV_KEYS.includes(k), `undeclared env key ${k}`);
  }
  assert.equal(d.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '260000');
});

test('decide sets the 64k output cap on haiku-family arms', () => {
  const d = decide({
    runId: 'r', agentId: 'a', role: 'doer',
    ladderRungs: [{ rung: 0, arms: [{ armId: 'haiku', model: 'claude-haiku-5-5', effort: 'max', family: 'haiku', contextWindow: 200000, Q: 1, C: 1 }] }],
    pointer: 0, fiveHourHeadroomPct: null, burnPerRunPct: {},
    accountId: 'claude:a1', contextCaps: DEFAULT_CONTEXT_CAPS,
  });
  assert.equal(d.kind, 'decide');
  assert.equal(d.env[MAX_OUTPUT_ENV_KEY], '64000');
  for (const k of Object.keys(d.env)) {
    assert.ok(MODEL_ROUTING_ENV_KEYS.includes(k), `undeclared env key ${k}`);
  }
});

test('enforce flag resolves false by default and validates boolean', () => {
  assert.equal(resolveConfig({}).enforce, false);
  assert.equal(resolveConfig({ enforce: true }).enforce, true);
  assert.ok(validateConfigShape({ enforce: 'yes' }).length > 0);
  assert.deepEqual(validateConfigShape({ enforce: false }), []);
});

test('caps: weak calibration returns no agents', async () => {
  const d = drive({ nowMs: TICK, config: { enforce: true } });
  await d.setup();
  await d.tick();
  const caps = await d.api('caps');
  assert.equal(caps.status, 200);
  assert.equal(caps.body.calibration, 'weak');
  assert.equal(caps.body.target, null);
  assert.deepEqual(caps.body.agents, []);
});

test('caps: measured target spreads over queued agents weighted by count', async () => {
  const d = drive({
    nowMs: TICK, config: { enforce: true },
    issueLists: {
      todo: [
        { id: 'i1', status: 'todo', assigneeAgentId: 'agent-a' },
        { id: 'i2', status: 'todo', assigneeAgentId: 'agent-a' },
        { id: 'i3', status: 'todo', assigneeAgentId: 'agent-a' },
        { id: 'i4', status: 'todo', assigneeAgentId: 'agent-b' },
        { id: 'i5', status: 'todo', assigneeAgentId: null },
        { id: 'i6', status: 'done', assigneeAgentId: 'agent-c' },
      ],
      in_progress: [
        { id: 'i7', status: 'in_progress', assigneeAgentId: 'agent-b' },
        { id: 'i2', status: 'todo', assigneeAgentId: 'agent-a' },
      ],
    },
  });
  await d.setup();
  await d.tick();
  // Two runs in span plus a rising reading calibrate E and set a target.
  d.setNow(TICK + 10 * 60000);
  await d.fire(runEvent('run-a', TICK + 10 * 60000));
  d.setNow(TICK + 20 * 60000);
  await d.fire(runEvent('run-b', TICK + 20 * 60000));
  d.setNow(TICK + 30 * 60000);
  // Small burn delta over the two runs = efficient runs = a target (about 8)
  // comfortably above the 2 in-flight runs, so the below-target branch holds.
  d.setLane(0.3002);
  await d.tick();
  const caps = await d.api('caps');
  assert.ok(caps.body.target > 0);
  // agent-a queues 3, agent-b queues 2 (i2 deduped); unassigned and done excluded.
  // The two fired runs (agent-9, still running) join via ledger running counts.
  assert.deepEqual(caps.body.agents.map(a => a.agentId), ['agent-a', 'agent-9', 'agent-b']);
  // Demand-aware: below target every agent covers its full demand (no
  // running here), so the total is demand, not the target.
  const byId = new Map(caps.body.agents.map(x => [x.agentId, x]));
  assert.deepEqual(byId.get('agent-a'), {
    agentId: 'agent-a', demand: 3, running: 0, queued: 3,
    allocated: 3, maxConcurrentRuns: 3, reason: 'full-demand',
    demandSource: 'issues',
  });
  assert.equal(byId.get('agent-b').allocated, 2);
  assert.equal(byId.get('agent-b').reason, 'full-demand');
  assert.ok(byId.get('agent-a').allocated >= byId.get('agent-b').allocated);
  // Running-only agent: no queue, keeps running+1 headroom below target.
  assert.deepEqual(byId.get('agent-9'), {
    agentId: 'agent-9', demand: 2, running: 2, queued: 0,
    allocated: 3, maxConcurrentRuns: 3, reason: 'headroom',
    demandSource: 'issues',
  });
});

test('caps: issues denial degrades to a sanitized code, never upstream text', async () => {
  const d = drive({
    nowMs: TICK, config: { enforce: true },
    issuesListError: 'db-query-denied: connection refused (raw upstream text)',
  });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 10 * 60000);
  await d.fire(runEvent('run-a', TICK + 10 * 60000));
  d.setNow(TICK + 20 * 60000);
  await d.fire(runEvent('run-b', TICK + 20 * 60000));
  d.setNow(TICK + 30 * 60000);
  d.setLane(0.328);
  await d.tick();
  const caps = await d.api('caps');
  assert.deepEqual(caps.body.agents, []);
  assert.equal(caps.body.capsError, 'issues-unavailable');
});

test('reviewReserve: rMin above rMax fails validation and normalizes to defaults', async () => {
  const { normalizeReviewReserve } = await import('../src/reviewreserve.mjs');
  assert.ok(validateConfigShape({ reviewReserve: { rMin: 0.9, rMax: 0.5 } })
    .some(e => e.includes('reviewReserve.rMin must be <=')));
  assert.deepEqual(validateConfigShape({ reviewReserve: { rMin: 0.2, rMax: 0.8 } }), []);
  const cfg = normalizeReviewReserve({ rMin: 0.9, rMax: 0.5 }, { keepAgentIds: [] });
  assert.ok(cfg.rMin <= cfg.rMax, 'normalize never leaves a pinning inversion');
});

test('reviewReserve: a one-sided rMin/rMax inversion against the other default fails validation', async () => {
  // {rMax: 0.05} reads against the 0.10 default floor; {rMin: 0.97} against
  // the 0.95 default cap. Both used to validate clean and then silently
  // reset both bounds to 0.10/0.95, so an operator capping the reserve at
  // 5% got up to 95%.
  assert.ok(validateConfigShape({ reviewReserve: { rMax: 0.05 } })
    .some(e => e.includes('reviewReserve.rMin must be <=')));
  assert.ok(validateConfigShape({ reviewReserve: { rMin: 0.97 } })
    .some(e => e.includes('reviewReserve.rMin must be <=')));
  assert.deepEqual(validateConfigShape({ reviewReserve: { rMax: 0.5 } }), []);
  assert.deepEqual(validateConfigShape({ reviewReserve: { rMin: 0.05 } }), []);
});

test('reviewer: a non-object block and mistyped knobs fail validation', async () => {
  // Mirrors the reviewReserve fail-closed tests: a typo in the reviewer
  // block must fail at config load, never as a silent dead reviewer.
  assert.ok(validateConfigShape({ reviewer: 'claude' })
    .some(e => e.includes('reviewer must be an object')));
  assert.ok(validateConfigShape({ reviewer: { providers: 'claude' } })
    .some(e => e.includes('reviewer.providers must be an array of strings')));
  assert.ok(validateConfigShape({ reviewer: { providers: ['claude', 7] } })
    .some(e => e.includes('reviewer.providers must be an array of strings')));
  assert.ok(validateConfigShape({ reviewer: { supplyHeadroomPct: 0 } })
    .some(e => e.includes('reviewer.supplyHeadroomPct must be a number in (0, 1]')));
  assert.ok(validateConfigShape({ reviewer: { supplyHeadroomPct: 1.5 } })
    .some(e => e.includes('reviewer.supplyHeadroomPct must be a number in (0, 1]')));
  assert.ok(validateConfigShape({ reviewer: { supplyHoursToReset: -1 } })
    .some(e => e.includes('reviewer.supplyHoursToReset must be a number > 0')));
  assert.deepEqual(validateConfigShape({
    reviewer: { providers: ['claude'], supplyHeadroomPct: 0.3, supplyHoursToReset: 120 },
  }), []);
  assert.ok(validateConfigShape({ reviewer: { doerStarvationMarginRuns: 0 } })
    .some(e => e.includes('reviewer.doerStarvationMarginRuns must be a number > 0')));
  assert.ok(validateConfigShape({ reviewer: { doerStarvationSustainMs: -5 } })
    .some(e => e.includes('reviewer.doerStarvationSustainMs must be a number > 0')));
  assert.deepEqual(validateConfigShape({
    reviewer: { providers: ['claude'], doerStarvationMarginRuns: 4, doerStarvationSustainMs: 600000 },
  }), []);
});
