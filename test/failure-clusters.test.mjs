import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILURE_CLUSTER_ORIGIN_KIND, FAILURE_CLUSTER_ORIGIN_ID, FAILURE_CLUSTER_ERROR_CODES,
  FAILURE_CLUSTER_WINDOW_MS, FAILURE_CLUSTER_THRESHOLD,
  countBand, extractClusterSignal, emptyClusterState, normalizeClusterState,
  evaluateClusters, transitionSig, singletonContentEqual, renderSingleton,
  reconcileSingleton, updateFailureClusters,
} from '../src/failure-clusters.mjs';
import { validateConfigShape, resolveConfig, createModelCapacityPlugin } from '../src/plugin.mjs';
import { manifest, enforceManifest } from '../src/manifest.mjs';

const T0 = Date.parse('2026-10-26T21:00:00Z');
const ACCT = 'kimi:kimi-lane-1';
const REASON = 'rung 2 on kimi:kimi-lane-1';
const ALERT = { enabled: true, assigneeAgentId: 'agent-devops' };

const failedEvent = ({ runId, at = T0, code = 'adapter_failed', reason = REASON, status = 'failed', companyId = 'acme' } = {}) => ({
  type: 'agent.run.failed',
  companyId,
  entityId: runId,
  occurredAt: new Date(at).toISOString(),
  payload: {
    runId, agentId: 'agent-9', status, errorCode: code,
    modelDecision: { reason },
    finishedAt: new Date(at).toISOString(),
    startedAt: new Date(at - 60000).toISOString(),
  },
});

function fakeStore() {
  const map = new Map();
  const calls = { get: 0, set: 0 };
  return {
    calls,
    state: {
      get: async k => { calls.get += 1; return map.get(k) ?? null; },
      set: async (k, v) => { calls.set += 1; map.set(k, v); },
    },
  };
}

function fakeIssues({ seed = {}, failCreate = null, failUpdate = null, failGet = false } = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { create: [], update: [], get: [], list: [] };
  let seq = 100;
  return {
    calls,
    store,
    client: {
      get: async (id, companyId) => {
        calls.get.push({ id, companyId });
        if (failGet) throw new Error(failGet);
        return store.get(id) ?? null;
      },
      list: async (input) => {
        calls.list.push(input);
        return [...store.values()].filter(issue =>
          (!input.companyId || issue.companyId === input.companyId)
          && (!input.originKind || issue.originKind === input.originKind)
          && (!input.originId || issue.originId === input.originId));
      },
      create: async (input) => {
        calls.create.push(input);
        if (failCreate) throw new Error(failCreate);
        const id = `issue-${seq++}`;
        const issue = { id, updatedAt: new Date(T0).toISOString(), ...input };
        store.set(id, issue);
        return issue;
      },
      update: async (id, patch, companyId) => {
        calls.update.push({ id, patch, companyId });
        if (failUpdate) throw new Error(failUpdate);
        const current = store.get(id);
        if (!current) throw new Error('not-found');
        const next = { ...current, ...patch, updatedAt: new Date(T0).toISOString() };
        store.set(id, next);
        return next;
      },
    },
  };
}

const stateKey = (companyId, key) => `${companyId}:${key}`;

function driveCtx({ store, issues, alert = ALERT, now = T0 } = {}) {
  return {
    ctx: {
      state: store.state,
      issues: issues.client,
      logger: { info() {}, error() {} },
    },
    // nowMs defaults to the event's own failure time (a live stream where
    // each event is processed as it lands); pass atMs explicitly for
    // tick-only passes and backoff scenarios.
    run: (event, atMs) => {
      const eventMs = event?.payload?.finishedAt ? Date.parse(event.payload.finishedAt) : NaN;
      return updateFailureClusters({
        ctx: { state: store.state, issues: issues.client, logger: { info() {}, error() {} } },
        companyId: 'acme', alert, nowMs: atMs ?? (Number.isFinite(eventMs) ? eventMs : now), event, stateKey,
      });
    },
  };
}

// --- signal extraction ---

test('qualifying signal: explicit failed status, allowlisted code, account pattern', () => {
  const signal = extractClusterSignal(failedEvent({ runId: 'r1' }), T0);
  assert.equal(signal.qualifying, true);
  assert.equal(signal.account, ACCT);
  assert.equal(signal.errorCode, 'adapter_failed');
  assert.equal(signal.atMs, T0);
  assert.equal(signal.runId, 'r1');
});

test('every allowlisted code qualifies; anything else is ignored', () => {
  assert.deepEqual([...FAILURE_CLUSTER_ERROR_CODES].sort(),
    ['adapter_failed', 'claude_auth_required', 'claude_transient_upstream']);
  for (const code of FAILURE_CLUSTER_ERROR_CODES) {
    assert.equal(extractClusterSignal(failedEvent({ runId: `r-${code}`, code }), T0).qualifying, true, code);
  }
  for (const code of ['timeout', 'unknown_code', '', 'ADAPTER_FAILED']) {
    const signal = extractClusterSignal(failedEvent({ runId: `r-${code || 'empty'}`, code }), T0);
    assert.equal(signal.qualifying, false, code || '(empty)');
    assert.equal(signal.reason, 'error-not-allowlisted');
  }
});

test('timed_out and missing statuses never qualify', () => {
  for (const status of ['timed_out', 'cancelled', 'succeeded', 'running']) {
    const signal = extractClusterSignal(failedEvent({ runId: `r-${status}`, status }), T0);
    assert.equal(signal.qualifying, false, status);
    assert.equal(signal.reason, 'status-not-failed');
  }
  const noStatus = failedEvent({ runId: 'r-nostatus' });
  delete noStatus.payload.status;
  assert.equal(extractClusterSignal(noStatus, T0).reason, 'status-not-failed');
});

test('account extraction keeps the legacy pattern; no match means no signal', () => {
  assert.equal(extractClusterSignal(failedEvent({ runId: 'r1', reason: 'plain reason, no account' }), T0).reason,
    'account-not-extracted');
  const dotted = extractClusterSignal(
    failedEvent({ runId: 'r2', reason: 'x on prov-1.invalid:lane_2' }), T0);
  assert.equal(dotted.qualifying, true);
  assert.equal(dotted.account, 'prov-1.invalid:lane_2');
  // First match wins, like the legacy non-global regex.
  const two = extractClusterSignal(
    failedEvent({ runId: 'r3', reason: 'a on one:1 then on two:2' }), T0);
  assert.equal(two.account, 'one:1');
});

test('tolerant placements: snake_case and run-scoped fields', () => {
  const event = {
    type: 'agent.run.failed', companyId: 'acme', entityId: 'r-snake',
    occurredAt: new Date(T0).toISOString(),
    payload: {
      run: { id: 'r-snake', status: 'failed', error_code: 'claude_auth_required', model_decision: { reason: REASON }, finished_at: new Date(T0).toISOString() },
    },
  };
  const signal = extractClusterSignal(event, T0);
  assert.equal(signal.qualifying, true);
  assert.equal(signal.account, ACCT);
  assert.equal(signal.errorCode, 'claude_auth_required');
  assert.equal(signal.runId, 'r-snake');
});

test('event time prefers finishedAt, then publish time, then receipt; future clamps', () => {
  const finishedFirst = failedEvent({ runId: 'r1', at: T0 });
  finishedFirst.payload.finishedAt = new Date(T0 - 5000).toISOString();
  assert.equal(extractClusterSignal(finishedFirst, T0).atMs, T0 - 5000);
  const publishFallback = failedEvent({ runId: 'r2', at: T0 - 7000 });
  delete publishFallback.payload.finishedAt;
  assert.equal(extractClusterSignal(publishFallback, T0).atMs, T0 - 7000);
  const receiptFallback = failedEvent({ runId: 'r3', at: T0 });
  delete receiptFallback.payload.finishedAt;
  delete receiptFallback.occurredAt;
  assert.equal(extractClusterSignal(receiptFallback, T0).atMs, T0);
  const garbage = failedEvent({ runId: 'r4', at: T0 });
  garbage.payload.finishedAt = 'not-a-time';
  garbage.occurredAt = 'also-not-a-time';
  assert.equal(extractClusterSignal(garbage, T0).atMs, T0);
  const future = failedEvent({ runId: 'r5', at: T0 + 3600000 });
  assert.equal(extractClusterSignal(future, T0).atMs, T0);
});

test('invalid finishedAt falls through to the first parseable event time', () => {
  const event = failedEvent({ runId: 'stale', at: T0 - 20 * 60000 });
  event.payload.finishedAt = 'not-a-time';
  assert.equal(extractClusterSignal(event, T0).atMs, T0 - 20 * 60000);
  event.payload.run = { finished_at: new Date(T0 - 1000).toISOString() };
  assert.equal(extractClusterSignal(event, T0).atMs, T0 - 1000);
  delete event.entityId;
  delete event.payload.runId;
  assert.equal(extractClusterSignal(event, T0).runId, null);
});

test('invalid finishedAt cannot turn a stale published failure into a cluster', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'fresh-1' }));
  await run(failedEvent({ runId: 'fresh-2' }));
  const stale = failedEvent({ runId: 'stale', at: T0 - 20 * 60000 });
  stale.payload.finishedAt = 'garbage';
  assert.equal((await run(stale, T0)).action, 'noop');
  assert.equal(issues.store.size, 0);
});

// --- evaluation ---

test('threshold boundary: 2 failures idle, the 3rd enters', () => {
  const state = emptyClusterState();
  state.accounts[ACCT] = { events: [
    { runId: 'a', atMs: T0, errorCode: 'adapter_failed' },
    { runId: 'b', atMs: T0 + 1000, errorCode: 'adapter_failed' },
  ] };
  const below = evaluateClusters(state, T0 + 2000);
  assert.deepEqual(below.active, []);
  assert.equal(below.writeDue, false);
  state.accounts[ACCT].events.push({ runId: 'c', atMs: T0 + 2000, errorCode: 'adapter_failed' });
  const entered = evaluateClusters(state, T0 + 2000);
  assert.deepEqual(entered.active, [ACCT]);
  assert.deepEqual(entered.entered, [ACCT]);
  assert.equal(entered.writeDue, true);
  assert.equal(entered.accounts[ACCT].count, 3);
});

test('window prunes strictly older than 15 minutes; exits detected', () => {
  assert.equal(FAILURE_CLUSTER_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(FAILURE_CLUSTER_THRESHOLD, 3);
  const state = emptyClusterState();
  state.accounts[ACCT] = { events: [
    { runId: 'old', atMs: T0 - FAILURE_CLUSTER_WINDOW_MS, errorCode: 'adapter_failed' },
    { runId: 'a', atMs: T0 - 1000, errorCode: 'adapter_failed' },
    { runId: 'b', atMs: T0, errorCode: 'adapter_failed' },
    { runId: 'c', atMs: T0 + 1000, errorCode: 'adapter_failed' },
  ] };
  state.prevActive = [ACCT];
  state.prevBands = { [ACCT]: '3-4' };
  // The exactly-15-minute-old event is excluded (strictly-greater window,
  // like the legacy created_at predicate): 3 remain, cluster holds.
  const held = evaluateClusters(state, T0 + 1000);
  assert.deepEqual(held.active, [ACCT]);
  assert.equal(held.accounts[ACCT].count, 3);
  assert.equal(held.writeDue, false);
  // Once the survivors age out, the exit is a transition.
  const exited = evaluateClusters(state, T0 + FAILURE_CLUSTER_WINDOW_MS + 2000);
  assert.deepEqual(exited.active, []);
  assert.deepEqual(exited.exited, [ACCT]);
  assert.equal(exited.writeDue, true);
});

test('account isolation: 2+2 across accounts is no cluster', () => {
  const state = emptyClusterState();
  state.accounts[ACCT] = { events: [
    { runId: 'a1', atMs: T0, errorCode: 'adapter_failed' },
    { runId: 'a2', atMs: T0 + 1000, errorCode: 'adapter_failed' },
  ] };
  state.accounts['other:lane-9'] = { events: [
    { runId: 'b1', atMs: T0, errorCode: 'claude_auth_required' },
    { runId: 'b2', atMs: T0 + 1000, errorCode: 'claude_auth_required' },
  ] };
  const result = evaluateClusters(state, T0 + 2000);
  assert.deepEqual(result.active, []);
  assert.equal(result.writeDue, false);
});

test('count bands escalate coarsely, not per run', () => {
  assert.equal(countBand(3), '3-4');
  assert.equal(countBand(4), '3-4');
  assert.equal(countBand(5), '5-9');
  assert.equal(countBand(10), '10-24');
  assert.equal(countBand(25), '25+');
  assert.equal(countBand(500), '25+');
  const state = emptyClusterState();
  state.accounts[ACCT] = { events: [1, 2, 3, 4].map(n => ({ runId: `r${n}`, atMs: T0 + n, errorCode: 'adapter_failed' })) };
  state.prevActive = [ACCT];
  state.prevBands = { [ACCT]: '3-4' };
  assert.equal(evaluateClusters(state, T0 + 100).writeDue, false);
  state.accounts[ACCT].events.push({ runId: 'r5', atMs: T0 + 200, errorCode: 'adapter_failed' });
  const escalated = evaluateClusters(state, T0 + 200);
  assert.deepEqual(escalated.escalated, [ACCT]);
  assert.deepEqual(escalated.deescalated, []);
  assert.equal(escalated.writeDue, true);
});

test('band decay records deescalate (not escalate) and still writes', () => {
  const state = emptyClusterState();
  state.accounts[ACCT] = { events: [1, 2, 3, 4].map(n => ({ runId: `r${n}`, atMs: T0 + n, errorCode: 'adapter_failed' })) };
  state.prevActive = [ACCT];
  state.prevBands = { [ACCT]: '5-9' };
  const decayed = evaluateClusters(state, T0 + 100);
  assert.deepEqual(decayed.escalated, []);
  assert.deepEqual(decayed.deescalated, [ACCT]);
  assert.equal(decayed.writeDue, true);
  // Unknown previous band fails toward escalate (the conservative label).
  const unknown = evaluateClusters(
    { ...emptyClusterState(), accounts: state.accounts, prevActive: [ACCT], prevBands: {} }, T0 + 100);
  assert.deepEqual(unknown.escalated, [ACCT]);
  assert.deepEqual(unknown.deescalated, []);
});

test('transition signatures are deterministic over set + bands', () => {
  // Callers pass the sorted active list (see evaluateClusters).
  const bands = { 'a:1': '3-4', 'b:1': '5-9' };
  assert.equal(transitionSig(['a:1', 'b:1'], bands), transitionSig(['a:1', 'b:1'], bands));
  assert.notEqual(transitionSig(['a:1'], { 'a:1': '3-4' }), transitionSig(['a:1'], { 'a:1': '5-9' }));
  assert.notEqual(transitionSig(['a:1'], { 'a:1': '3-4' }), transitionSig(['a:1', 'b:1'], bands));
});

test('corrupt persisted state normalizes to fresh without throwing', () => {
  for (const raw of [null, undefined, 42, 'x', [], { accounts: { [ACCT]: { events: [{ nope: 1 }, null, 'x'] } }, prevActive: 'nope', transitions: [{ atMs: 'bad' }] }]) {
    const state = normalizeClusterState(raw);
    assert.deepEqual(state.prevActive, []);
    assert.equal(state.singletonIssueId, null);
  }
  const events = normalizeClusterState({ accounts: { [ACCT]: { events: [{ runId: 'r', atMs: T0, errorCode: 'c' }] } } });
  assert.equal(events.accounts[ACCT].events.length, 1);
});

// --- rendering ---

test('singleton renders single, multi and cleared states', () => {
  const accounts = { [ACCT]: { count: 3, capped: false, errors: { adapter_failed: 2, claude_auth_required: 1 }, runIds: ['r3', 'r2', 'r1'], windowStartMs: T0, windowEndMs: T0 + 2000 } };
  const single = renderSingleton({ active: [ACCT], accounts, history: [], nowMs: T0 + 3000 });
  assert.match(single.title, /kimi:kimi-lane-1/);
  assert.match(single.title, /3 failures\/15m/);
  assert.equal(single.status, 'in_progress');
  assert.equal(single.priority, 'high');
  assert.match(single.description, /adapter_failedx2, claude_auth_requiredx1/);
  assert.match(single.description, /runs: r3, r2, r1/);
  const multi = renderSingleton({
    active: ['a:1', 'b:2'],
    accounts: {
      'a:1': { ...accounts[ACCT], count: 3 },
      'b:2': { ...accounts[ACCT], count: 12 },
    },
    history: [],
    nowMs: T0,
  });
  assert.match(multi.title, /2 accounts/);
  assert.match(multi.title, /worst: b:2 12\/15m/);
  const cleared = renderSingleton({ active: [], accounts: {}, history: [{ atMs: T0, type: 'exit', accounts: [{ account: ACCT, count: 0 }] }], nowMs: T0 });
  assert.equal(cleared.title, '[mc-health] failure clusters cleared');
  assert.equal(cleared.status, 'done');
  assert.equal(cleared.priority, 'medium');
  assert.match(cleared.description, /No failure cluster is active/);
});

test('rendered body carries summaries only, never secrets or full payloads', () => {
  const rendered = renderSingleton({
    active: [ACCT],
    accounts: { [ACCT]: { count: 3, capped: false, errors: { adapter_failed: 3 }, runIds: ['r1'], windowStartMs: T0, windowEndMs: T0 } },
    history: [],
    nowMs: T0,
  });
  const sentinel = 'super-secret-lane-key-value';
  assert.ok(!rendered.title.includes(sentinel) && !rendered.description.includes(sentinel));
  assert.ok(!rendered.description.includes('full-model-decision-payload'));
});

test('content equality compares exactly the updatable surface', () => {
  const desired = { title: 't', description: 'd', status: 'in_progress', priority: 'high' };
  assert.equal(singletonContentEqual({ ...desired, assigneeAgentId: 'x', originKind: 'k' }, desired), true);
  assert.equal(singletonContentEqual({ ...desired, title: 'other' }, desired), false);
  assert.equal(singletonContentEqual({ ...desired, priority: 'medium' }, desired), false);
  assert.equal(singletonContentEqual(null, desired), false);
});

// --- write path ---

test('disabled or unassigned alert performs zero issue and state I/O', async () => {
  for (const alert of [{ enabled: false, assigneeAgentId: 'agent-devops' }, { enabled: true, assigneeAgentId: '' }, null, {}]) {
    const store = fakeStore();
    const issues = fakeIssues();
    const { run } = driveCtx({ store, issues, alert });
    const result = await run(failedEvent({ runId: 'r1' }));
    assert.equal(result.action, 'disabled');
    assert.deepEqual(issues.calls.create, []);
    assert.deepEqual(issues.calls.update, []);
    assert.deepEqual(issues.calls.list, []);
    assert.deepEqual(issues.calls.get, []);
    assert.equal(store.calls.get, 0);
    assert.equal(store.calls.set, 0);
  }
});

test('third qualifying failure creates the singleton with the exact field allowlist', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  assert.equal((await run(failedEvent({ runId: 'r1' }))).action, 'noop');
  assert.equal((await run(failedEvent({ runId: 'r2', at: T0 + 1000 }))).action, 'noop');
  const created = await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(created.action, 'created');
  assert.equal(issues.calls.create.length, 1);
  const input = issues.calls.create[0];
  assert.deepEqual(Object.keys(input).sort(), ['assigneeAgentId', 'companyId', 'description', 'originId', 'originKind', 'priority', 'status', 'title']);
  assert.equal(input.companyId, 'acme');
  assert.equal(input.assigneeAgentId, 'agent-devops');
  assert.equal(input.originKind, FAILURE_CLUSTER_ORIGIN_KIND);
  assert.equal(input.originId, FAILURE_CLUSTER_ORIGIN_ID);
  assert.equal(input.status, 'in_progress');
  assert.equal(input.priority, 'high');
  // Reconciliation ran first (stored id empty, list empty).
  assert.equal(issues.calls.list.length, 1);
  assert.deepEqual(issues.calls.get, []);
});

test('non-qualifying failures never reach the threshold', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', status: 'timed_out' }));
  await run(failedEvent({ runId: 'r3', code: 'other_code' }));
  await run(failedEvent({ runId: 'r4', reason: 'no account here' }));
  await run(failedEvent({ runId: 'r5', at: T0 + 1000 }));
  assert.deepEqual(issues.calls.create, []);
  const state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.equal(state.accounts[ACCT].events.length, 2);
});

test('duplicate delivery of the same run counts once and writes once', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  const event = failedEvent({ runId: 'r-dup' });
  await run(event);
  await run({ ...event });
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  await run({ ...event });
  assert.deepEqual(issues.calls.create, []);
  const created = await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(created.action, 'created');
  // Replaying every run id changes nothing further (no new transition).
  const replay = await run({ ...event });
  assert.equal(replay.action, 'noop');
  assert.equal(issues.calls.create.length, 1);
  assert.deepEqual(issues.calls.update, []);
});

test('identifier-less failures count separately across reloads; known ids still dedup', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const first = driveCtx({ store, issues });
  await first.run(failedEvent({ runId: 'known' }));
  await first.run(failedEvent({ runId: 'known' }));
  await first.run(failedEvent());
  const second = driveCtx({ store, issues });
  assert.equal((await second.run(failedEvent())).action, 'created');
  const state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.deepEqual(state.accounts[ACCT].events.map(e => e.runId), ['known', null, null]);
  assert.equal(issues.calls.create.length, 1);
  assert.match(issues.calls.create[0].description, /runs: known, unknown, unknown/);
});

test('out-of-order late events still count inside the window', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r-new', at: T0 + 10 * 60 * 1000 }));
  await run(failedEvent({ runId: 'r-mid', at: T0 + 5 * 60 * 1000 }));
  assert.deepEqual(issues.calls.create, []);
  const created = await run(failedEvent({ runId: 'r-old', at: T0 + 60 * 1000 }));
  assert.equal(created.action, 'created');
});

test('restart persistence: reloaded state dedups and never double-creates', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const first = driveCtx({ store, issues });
  await first.run(failedEvent({ runId: 'r1' }));
  await first.run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  // A fresh instance over the same persisted store resumes mid-window.
  const second = driveCtx({ store, issues });
  await second.run(failedEvent({ runId: 'r1' }));
  await second.run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  const created = await second.run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(created.action, 'created');
  // And a third instance adopts the stored singleton instead of creating.
  const third = driveCtx({ store, issues });
  const again = await third.run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(again.action, 'noop');
  assert.equal(issues.calls.create.length, 1);
});

test('crash between write and state-save converges without a duplicate write', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(issues.calls.create.length, 1);
  // Simulate losing the post-write save: events and singleton id survive,
  // transition markers do not.
  const crashed = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  await store.state.set(stateKey('acme', 'failure-cluster-v1'),
    { ...crashed, prevActive: [], prevBands: {}, lastTransitionSig: null, transitions: [] });
  const recovered = await run(null, T0 + 2000);
  assert.equal(recovered.action, 'already-current');
  assert.equal(issues.calls.create.length, 1);
  assert.deepEqual(issues.calls.update, []);
  const converged = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.deepEqual(converged.prevActive, [ACCT]);
});

test('enter, escalate, deescalate sequence records each direction', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1', at: T0 }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  // Growth lands past the 60s write backoff so the escalation writes.
  await run(failedEvent({ runId: 'r4', at: T0 + 61000 }));
  await run(failedEvent({ runId: 'r5', at: T0 + 62000 }));
  assert.equal(issues.calls.create.length, 1);
  assert.equal(issues.calls.update.length, 1);
  // Two oldest events age out: 5-9 falls back to 3-4, still active.
  const decayed = await run(null, T0 + 901500);
  assert.equal(decayed.action, 'updated');
  assert.equal(issues.calls.update.length, 2);
  const state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.deepEqual(state.transitions.map(t => t.type), ['enter', 'escalate', 'deescalate']);
});

test('exit transition updates the singleton to cleared', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  // Tick-only pass after the window slides out: no new event, exit writes.
  const exited = await run(null, T0 + FAILURE_CLUSTER_WINDOW_MS + 5000);
  assert.equal(exited.action, 'updated');
  assert.equal(issues.calls.update.length, 1);
  const { patch } = issues.calls.update[0];
  assert.deepEqual(Object.keys(patch).sort(), ['description', 'priority', 'status', 'title']);
  assert.equal(patch.status, 'done');
  assert.equal(patch.priority, 'medium');
  assert.match(patch.title, /cleared/);
  assert.equal(issues.store.size, 1);
  const stored = [...issues.store.values()][0];
  assert.equal(stored.status, 'done');
  assert.match(stored.description, /No failure cluster is active/);
});

test('update patch allowlist holds, and assignee drift is restored', async () => {
  const seedIssue = {
    id: 'issue-1', companyId: 'acme', title: 'stale', description: 'stale',
    status: 'todo', priority: 'low', assigneeAgentId: 'someone-else',
    originKind: FAILURE_CLUSTER_ORIGIN_KIND, originId: FAILURE_CLUSTER_ORIGIN_ID,
    updatedAt: new Date(T0).toISOString(),
  };
  const store = fakeStore();
  const issues = fakeIssues({ seed: { 'issue-1': seedIssue } });
  await store.state.set(stateKey('acme', 'failure-cluster-v1'),
    { ...emptyClusterState(), singletonIssueId: 'issue-1' });
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  const updated = await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(updated.action, 'updated');
  assert.deepEqual(issues.calls.create, []);
  const { id, patch } = issues.calls.update[0];
  assert.equal(id, 'issue-1');
  assert.deepEqual(Object.keys(patch).sort(), ['assigneeAgentId', 'description', 'priority', 'status', 'title']);
  assert.equal(patch.assigneeAgentId, 'agent-devops');
  assert.ok(!('originKind' in patch) && !('originId' in patch));
});

test('ownership: foreign stored id is never updated; own singleton is adopted', async () => {
  const foreign = {
    id: 'issue-foreign', companyId: 'acme', title: 'foreign', description: 'x',
    status: 'todo', priority: 'low', assigneeAgentId: 'agent-devops',
    originKind: 'manual', originId: null, updatedAt: new Date(T0).toISOString(),
  };
  const own = {
    id: 'issue-own', companyId: 'acme', title: 'stale', description: 'stale',
    status: 'todo', priority: 'low', assigneeAgentId: 'agent-devops',
    originKind: FAILURE_CLUSTER_ORIGIN_KIND, originId: FAILURE_CLUSTER_ORIGIN_ID,
    updatedAt: new Date(T0).toISOString(),
  };
  const store = fakeStore();
  const issues = fakeIssues({ seed: { 'issue-foreign': foreign, 'issue-own': own } });
  await store.state.set(stateKey('acme', 'failure-cluster-v1'),
    { ...emptyClusterState(), singletonIssueId: 'issue-foreign' });
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  const result = await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(result.action, 'updated');
  assert.equal(issues.calls.update[0].id, 'issue-own');
  assert.deepEqual(issues.calls.create, []);
  const state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.equal(state.singletonIssueId, 'issue-own');
});

test('deleted singleton is recreated exactly once', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  await store.state.set(stateKey('acme', 'failure-cluster-v1'),
    { ...emptyClusterState(), singletonIssueId: 'issue-gone' });
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  const result = await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(result.action, 'created');
  assert.equal(issues.calls.get.length, 1);
  assert.equal(issues.calls.list.length, 1);
});

test('reconcile adopts the newest matching singleton when several exist', async () => {
  const mk = (id, updatedAt) => ({
    id, companyId: 'acme', title: id, originKind: FAILURE_CLUSTER_ORIGIN_KIND,
    originId: FAILURE_CLUSTER_ORIGIN_ID, updatedAt,
  });
  const issues = fakeIssues({ seed: {
    'issue-old': mk('issue-old', new Date(T0 - 1000).toISOString()),
    'issue-new': mk('issue-new', new Date(T0).toISOString()),
  } });
  const adopted = await reconcileSingleton({ issues: issues.client, companyId: 'acme', storedIssueId: null });
  assert.equal(adopted.id, 'issue-new');
});

test('write failure records, backs off, retries, and clears on success', async () => {
  const store = fakeStore();
  const issues = fakeIssues({ failCreate: 'boom-create' });
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  const failed = await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.equal(failed.action, 'write-failed');
  let state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.match(state.lastWriteError.message, /boom-create/);
  assert.deepEqual(state.prevActive, []);
  // Immediate retry is deferred by backoff; a later pass retries.
  const deferred = await run(failedEvent({ runId: 'r4', at: T0 + 3000 }), T0 + 3000);
  assert.equal(deferred.action, 'backoff-deferred');
  assert.equal(issues.calls.create.length, 1);
  const retried = await run(failedEvent({ runId: 'r5', at: T0 + 90000 }), T0 + 90000);
  assert.equal(retried.action, 'write-failed');
  assert.equal(issues.calls.create.length, 2);
});

test('failed enter survives window expiry and restart as a catch-up record', async () => {
  const store = fakeStore();
  const issues = fakeIssues({ failCreate: 'boom' });
  const { run } = driveCtx({ store, issues });
  await run(failedEvent({ runId: 'r1' }));
  await run(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  await run(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  const later = T0 + FAILURE_CLUSTER_WINDOW_MS + 5000;
  assert.equal((await run(null, later)).action, 'write-failed');
  let state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.ok(state.lastWriteError !== null);
  assert.deepEqual(state.pendingWrite.transitions.map(t => t.type), ['enter', 'exit']);
  assert.equal(state.pendingWrite.transitions[0].accounts[0].count, 3);
  assert.equal(state.pendingWrite.desired.status, 'done');
  assert.equal(issues.store.size, 0);
  // A new client over serialized persisted state retries even with no live cluster.
  await store.state.set(stateKey('acme', 'failure-cluster-v1'), JSON.parse(JSON.stringify(state)));
  const recovered = fakeIssues();
  const restarted = driveCtx({ store, issues: recovered });
  assert.equal((await restarted.run(null, later + 60000)).action, 'created');
  const issue = [...recovered.store.values()][0];
  assert.equal(issue.status, 'done');
  assert.match(issue.description, /enter kimi:kimi-lane-1 \(3\)/);
  assert.match(issue.description, /exit kimi:kimi-lane-1 \(0\)/);
  state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.equal(state.lastWriteError, null);
  assert.equal(state.pendingWrite, null);
  assert.deepEqual(state.transitions.map(t => t.type), ['enter', 'exit']);
  assert.equal((await restarted.run(null, later + 120000)).action, 'noop');
  assert.equal(recovered.calls.create.length, 1);
});

test('failed exit is retained if the same account re-enters before recovery', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const { run } = driveCtx({ store, issues });
  for (const id of ['a', 'b', 'c']) await run(failedEvent({ runId: id }));
  const update = issues.client.update;
  issues.client.update = async () => { throw new Error('outage'); };
  const later = T0 + FAILURE_CLUSTER_WINDOW_MS + 5000;
  assert.equal((await run(null, later)).action, 'write-failed');
  for (const id of ['d', 'e', 'f']) await run(failedEvent({ runId: id, at: later + 1000 }));
  issues.client.update = update;
  assert.equal((await run(null, later + 60000)).action, 'updated');
  const state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.deepEqual(state.transitions.map(t => t.type), ['enter', 'exit', 'enter']);
  assert.equal(state.lastWriteError, null);
  assert.equal([...issues.store.values()][0].status, 'in_progress');
});

test('ambiguous create response reconciles the persisted snapshot without rewriting', async () => {
  const store = fakeStore();
  const issues = fakeIssues();
  const create = issues.client.create;
  issues.client.create = async input => { await create(input); throw new Error('response-lost'); };
  const { run } = driveCtx({ store, issues });
  for (const id of ['a', 'b', 'c']) await run(failedEvent({ runId: id }));
  const state = await store.state.get(stateKey('acme', 'failure-cluster-v1'));
  assert.ok(state.pendingWrite !== null);
  await store.state.set(stateKey('acme', 'failure-cluster-v1'), JSON.parse(JSON.stringify(state)));
  const restarted = driveCtx({ store, issues });
  assert.equal((await restarted.run(null, T0 + 60000)).action, 'already-current');
  assert.equal(issues.calls.create.length, 1);
  assert.equal(issues.calls.update.length, 0);
  assert.equal((await store.state.get(stateKey('acme', 'failure-cluster-v1'))).lastWriteError, null);
});

// --- manifest, schema, config ---

test('manifest adds exactly the issue-write pair, in both variants', () => {
  for (const variant of [manifest, enforceManifest]) {
    assert.ok(variant.capabilities.includes('issues.create'));
    assert.ok(variant.capabilities.includes('issues.update'));
    for (const refused of ['issue.comments.create', 'issues.checkout', 'issues.wakeup', 'issue.documents.write', 'issue.relations.write']) {
      assert.ok(!variant.capabilities.includes(refused), refused);
    }
  }
  assert.deepEqual(enforceManifest.capabilities.filter(c => !manifest.capabilities.includes(c)), ['run.model.resolve']);
  const schema = manifest.instanceConfigSchema.properties.failureClusterAlert;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.enabled.default, false);
  assert.equal(schema.properties.assigneeAgentId.default, '');
});

test('config validation and resolution fail closed on the alert block', () => {
  assert.deepEqual(validateConfigShape({}), []);
  assert.deepEqual(validateConfigShape({ failureClusterAlert: { enabled: false, assigneeAgentId: '' } }), []);
  assert.deepEqual(validateConfigShape({ failureClusterAlert: { enabled: true, assigneeAgentId: 'agent-devops' } }), []);
  assert.ok(validateConfigShape({ failureClusterAlert: { enabled: true } }).some(e => e.includes('assigneeAgentId')));
  assert.ok(validateConfigShape({ failureClusterAlert: { enabled: true, assigneeAgentId: '' } }).some(e => e.includes('assigneeAgentId')));
  assert.ok(validateConfigShape({ failureClusterAlert: { enabled: 'yes' } }).some(e => e.includes('must be a boolean')));
  assert.ok(validateConfigShape({ failureClusterAlert: { enabled: false, extra: 1 } }).some(e => e.includes('not a known key')));
  assert.ok(validateConfigShape({ failureClusterAlert: 42 }).length > 0);
  assert.equal(resolveConfig({}).failureClusterAlert.enabled, false);
  assert.equal(resolveConfig({ failureClusterAlert: { enabled: true } }).failureClusterAlert.enabled, false);
  assert.equal(resolveConfig({ failureClusterAlert: { enabled: true, assigneeAgentId: 'agent-devops' } }).failureClusterAlert.enabled, true);
});

// --- plugin wiring ---

function pluginHarness({ config = {}, now = T0, issuesClient = null } = {}) {
  const store = new Map();
  const handlers = new Map();
  const jobs = new Map();
  const skey = k => JSON.stringify(k);
  let currentNow = now;
  const fake = {
    config: { get: async () => ({ ...config }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => { throw new Error('no-egress-in-cluster-tests'); } },
    agents: { get: async () => null },
    issues: issuesClient ?? { get: async () => null, list: async () => [], create: async () => { throw new Error('unexpected-create'); }, update: async () => { throw new Error('unexpected-update'); } },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { handlers.set(name, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => currentNow, requirePinnedLaneHost: false });
  return {
    plugin,
    handlers,
    jobs,
    context: fake,
    setNow: (ms) => { currentNow = ms; },
    breakConfig: () => { fake.config.get = async () => { throw new Error('config-unavailable'); }; },
    boot: async () => {
      await plugin.setup(fake);
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
  };
}

test('plugin wiring: failed events create the singleton only when opted in', async () => {
  const issues = fakeIssues();
  const { plugin, handlers, boot } = pluginHarness({
    config: { failureClusterAlert: { enabled: true, assigneeAgentId: 'agent-devops' } },
    issuesClient: issues.client,
  });
  await boot();
  const onFailed = handlers.get('agent.run.failed');
  assert.equal(typeof onFailed, 'function');
  await onFailed(failedEvent({ runId: 'r1', at: T0 - 2000 }));
  await onFailed(failedEvent({ runId: 'r2', at: T0 - 1000 }));
  assert.deepEqual(issues.calls.create, []);
  await onFailed(failedEvent({ runId: 'r3', at: T0 }));
  assert.equal(issues.calls.create.length, 1);
  assert.equal(issues.calls.create[0].originId, FAILURE_CLUSTER_ORIGIN_ID);
  await plugin.onHealth();
});

test('plugin wiring: disabled config ingests nothing and writes nothing', async () => {
  const issues = fakeIssues();
  const spyState = { gets: 0, sets: 0 };
  const store = new Map();
  const skey = k => JSON.stringify(k);
  const handlers = new Map();
  const fake = {
    config: { get: async () => ({}) },
    state: {
      get: async k => { spyState.gets += 1; return store.get(skey(k)) ?? null; },
      set: async (k, v) => { spyState.sets += 1; store.set(skey(k), v); },
    },
    agents: { get: async () => null },
    issues: issues.client,
    jobs: { register() {} },
    events: { on: (name, fn) => { handlers.set(name, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => T0, requirePinnedLaneHost: false });
  await plugin.setup(fake);
  await plugin.onConfigChanged({}, { companyId: 'acme' });
  // Only the ledger path touches state; the cluster key is never read.
  const clusterReadsBefore = [...store.keys()].filter(k => k.includes('failure-cluster')).length;
  await handlers.get('agent.run.failed')(failedEvent({ runId: 'r1' }));
  await handlers.get('agent.run.failed')(failedEvent({ runId: 'r2', at: T0 + 1000 }));
  await handlers.get('agent.run.failed')(failedEvent({ runId: 'r3', at: T0 + 2000 }));
  assert.deepEqual(issues.calls.create, []);
  assert.deepEqual(issues.calls.list, []);
  assert.deepEqual(issues.calls.get, []);
  const clusterKeys = [...store.keys()].filter(k => k.includes('failure-cluster'));
  assert.equal(clusterKeys.length, clusterReadsBefore);
});

test('tick maintenance runs even when the shadow tick itself fails', async () => {
  const issues = fakeIssues();
  const harness = pluginHarness({
    config: { failureClusterAlert: { enabled: true, assigneeAgentId: 'agent-devops' } },
    issuesClient: issues.client,
  });
  await harness.boot();
  const onFailed = harness.handlers.get('agent.run.failed');
  await onFailed(failedEvent({ runId: 'r1', at: T0 - 2000 }));
  await onFailed(failedEvent({ runId: 'r2', at: T0 - 1000 }));
  await onFailed(failedEvent({ runId: 'r3', at: T0 }));
  assert.equal(issues.calls.create.length, 1);
  // The window expires, then the tick feed breaks: the job must still fail
  // loudly while maintenance lands the exit write.
  harness.setNow(T0 + FAILURE_CLUSTER_WINDOW_MS + 5000);
  harness.breakConfig();
  await assert.rejects(harness.jobs.get('quota-refresh')({}), /quota-refresh-failed/);
  assert.equal(issues.calls.update.length, 1);
  assert.equal(issues.calls.update[0].patch.status, 'done');
});

test('queued maintenance re-reads alert config after disable', async () => {
  const issues = fakeIssues();
  const harness = pluginHarness({
    config: { failureClusterAlert: ALERT }, issuesClient: issues.client,
  });
  await harness.boot();
  const onFailed = harness.handlers.get('agent.run.failed');
  for (const id of ['a', 'b', 'c']) await onFailed(failedEvent({ runId: id }));
  let release, entered, queued;
  const hold = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { entered = resolve; });
  const tickFailed = new Promise(resolve => { queued = resolve; });
  const get = harness.context.state.get;
  let pause = true;
  harness.context.state.get = async key => {
    if (pause && JSON.stringify(key).includes('failure-cluster-v1')) {
      pause = false;
      entered();
      await hold;
    }
    return get(key);
  };
  // A duplicate event holds the company chain without needing an issue write.
  const ingest = onFailed(failedEvent({ runId: 'c' }));
  await blocked;
  harness.setNow(T0 + FAILURE_CLUSTER_WINDOW_MS + 5000);
  harness.breakConfig();
  harness.context.logger.error = message => {
    if (message.includes('shadow tick failed')) queued();
  };
  const tick = assert.rejects(harness.jobs.get('quota-refresh')({}), /quota-refresh-failed/);
  await tickFailed;
  await harness.plugin.onConfigChanged({ failureClusterAlert: { enabled: false } }, { companyId: 'acme' });
  release();
  await Promise.all([ingest, tick]);
  assert.equal(issues.calls.create.length, 1);
  assert.equal(issues.calls.update.length, 0);
});

test('health reports error while a cluster is active, base status once clear', async () => {
  const issues = fakeIssues();
  const harness = pluginHarness({
    config: { failureClusterAlert: { enabled: true, assigneeAgentId: 'agent-devops' } },
    issuesClient: issues.client,
  });
  await harness.boot();
  const onFailed = harness.handlers.get('agent.run.failed');
  await onFailed(failedEvent({ runId: 'r1', at: T0 - 2000 }));
  await onFailed(failedEvent({ runId: 'r2', at: T0 - 1000 }));
  await onFailed(failedEvent({ runId: 'r3', at: T0 }));
  const alerting = await harness.plugin.onHealth();
  assert.equal(alerting.status, 'error');
  assert.match(alerting.message, /1 failure cluster active/);
  assert.equal(alerting.details.failureClusters.activeClusters, 1);
  // Health re-evaluates the live window: once the events age out, the
  // cluster reads inactive again (the exit write itself lands on the next
  // event or per-minute tick, covered in the exit test above).
  harness.setNow(T0 + FAILURE_CLUSTER_WINDOW_MS + 5000);
  const cleared = await harness.plugin.onHealth();
  assert.equal(cleared.details.failureClusters.activeClusters, 0);
  assert.notEqual(cleared.status, 'error');
});

test('health reports error while alert writes fail', async () => {
  const issues = fakeIssues({ failCreate: 'nope' });
  const harness = pluginHarness({
    config: { failureClusterAlert: { enabled: true, assigneeAgentId: 'agent-devops' } },
    issuesClient: issues.client,
  });
  await harness.boot();
  const onFailed = harness.handlers.get('agent.run.failed');
  await onFailed(failedEvent({ runId: 'r1', at: T0 - 2000 }));
  await onFailed(failedEvent({ runId: 'r2', at: T0 - 1000 }));
  await onFailed(failedEvent({ runId: 'r3', at: T0 }));
  const health = await harness.plugin.onHealth();
  assert.equal(health.status, 'error');
  assert.match(health.message, /1 alert write failing/);
  assert.equal(health.details.failureClusters.writeErrors, 1);
  harness.setNow(T0 + FAILURE_CLUSTER_WINDOW_MS + 5000);
  harness.breakConfig();
  await assert.rejects(harness.jobs.get('quota-refresh')({}), /quota-refresh-failed/);
  const expired = await harness.plugin.onHealth();
  assert.equal(expired.details.failureClusters.activeClusters, 0);
  assert.equal(expired.details.failureClusters.writeErrors, 1);
  assert.equal(expired.status, 'error');
});
