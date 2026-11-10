import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const NOW = Date.parse('2026-10-25T15:00:00Z');
const MODEL = 'nvidia-nim/step-5-preview-nim';
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const skey = stateKey => JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
const freeConfig = { enabled: true, lowRiskAgentIds: ['triage'], providers: {
  'nvidia-nim': { requestsPerMinute: 36, requestsPerMinutePerSlot: 12 },
} };
const params = extra => ({ runId: 'r', companyId: 'acme', agentId: 'triage', issueId: 'i',
  adapterType: 'claude-code', invocationSource: 'assignment', wakeReason: 'issue_assigned',
  previous: null, issueOverrideModel: null, ...extra });

async function drive({ free = freeConfig, config: extra = {}, records = [], usage = null, accounts: customAccounts = null, state = null, initialTick = true } = {}) {
  let config = { enforce: true, cliproxy: { laneKeySecretRef: SECRET },
    roles: { minQuality: { doer: 0.4, other: 0.4, thinker: 0.4 }, thinkerAgentIds: ['thinker'] },
    modelAaOverrides: { 'step-5-preview-nim': { slug: 'step-5', effort: 'max' } },
    placement: { freeCostProviders: ['nvidia-nim'] },
    trials: { maxInFlightPerAccount: 1, maxInFlightPerFamily: 1 },
    ...(free != null ? { freeLanes: free } : {}), ...extra };
  let now = NOW;
  const store = state ?? new Map();
  const jobs = new Map(), handlers = new Map();
  const iso = new Date(NOW).toISOString();
  const lane = { observedAt: iso, servedModels: [MODEL, 'claude-haiku-5-5'], accounts: customAccounts ?? [
    { lane: 'n1', provider: 'nvidia-nim', accountKey: 'n1', plan: 'free', meter: 'reactive', health: 'healthy',
      models: [MODEL], observedAt: iso, weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null } },
    { lane: 'c1', provider: 'claude', accountKey: 'c1', health: 'healthy', models: ['claude-haiku-5-5'], observedAt: iso,
      weekly: { used: 0.1, resetsAt: new Date(NOW + 168 * 3600000).toISOString() },
      fiveHour: { used: 0.1, resetsAt: new Date(NOW + 4 * 3600000).toISOString() } },
  ] };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  const io = {
    config: { get: async () => config },
    state: { get: async k => store.get(JSON.stringify(k)) ?? null, set: async (k, v) => store.set(JSON.stringify(k), structuredClone(v)) },
    secrets: { resolve: async () => 'test-lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, now, { emitted: ['step-5-preview-nim'] }) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async ({ status }) => status === 'todo' ? [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `triage-${i}`, status, assigneeAgentId: 'triage' })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `builder-${i}`, status, assigneeAgentId: 'builder' })),
    ] : [] },
    jobs: { register: (n, fn) => jobs.set(n, fn) }, events: { on: (n, fn) => handlers.set(n, fn) }, logger: { info() {}, error() {} },
  };
  await plugin.setup(io);
  store.set(skey('aa-snapshot-v1'), { fetchedAt: iso, rows: [
    { slug: 'step-5', intelligenceIndex: 72, intelligenceIndexCostPerTask: 9, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ] });
  if (!state) store.set(skey('ledger-v1'), records);
  if (usage) store.set(skey('free-lanes-v1'), usage);
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  if (initialTick) await jobs.get('quota-refresh')({});
  return {
    store, io, lane, plugin, hook: extra => plugin.onResolveRunModel(params(extra)),
    api: async routeKey => (await plugin.onApiRequest({ companyId: 'acme', routeKey })).body,
    tick: () => jobs.get('quota-refresh')({}),
    fire: e => handlers.get(e.type)(e), setNow: v => { now = v; },
    configure: async patch => { config = { ...config, ...patch }; await plugin.onConfigChanged(config, { companyId: 'acme' }); },
    killIo: () => { for (const k of ['config', 'state', 'secrets', 'http', 'agents', 'issues']) io[k] = new Proxy({}, { get() { throw Error(`io-forbidden:${k}`); } }); },
  };
}

test('config schema, validation and defaults expose an opt-in-only free feature', () => {
  assert.equal(resolveConfig({}).freeLanes.enabled, false);
  assert.equal(manifest.instanceConfigSchema.properties.freeLanes.properties.enabled.default, false);
  assert.deepEqual(validateConfigShape({ freeLanes: freeConfig }), []);
  assert.ok(validateConfigShape({ freeLanes: { enabled: 'true' } }).length);
});

test('eligible free work gets three additive slots even when legacy trial caps are one; hook stays memory-only', async () => {
  const d = await drive();
  d.killIo();
  const out = await Promise.all(Array.from({ length: 4 }, (_, i) => d.hook({ runId: `r${i}` })));
  assert.equal(out.filter(a => a.model === MODEL).length, 3, JSON.stringify(out));
  assert.notEqual(out[3].model, MODEL);
});

test('a started event for self does not consume its slot, and duplicate hook calls do not reserve twice', async () => {
  const d = await drive();
  await d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: 'r', occurredAt: new Date(NOW).toISOString(),
    payload: { run: { agentId: 'triage', issueId: 'i', model: 'claude-haiku-5-5', provider: 'claude' } } });
  const first = await d.hook();
  assert.equal(first.model, MODEL);
  assert.deepEqual(await d.hook(), first);
  assert.equal((await d.hook({ runId: 'r2' })).model, MODEL);
  assert.equal((await d.hook({ runId: 'r3' })).model, MODEL);
  assert.notEqual((await d.hook({ runId: 'r4' })).model, MODEL);
});

for (const agentId of ['triage', 'unknown']) {
  test(`genuine free occupancy (${agentId}) consumes physical room without becoming paid pressure`, async () => {
    const d = await drive({ config: { concurrency: { maxTotal: 2 } }, records: [
      { runId: 'free-running', agentId, status: 'running', startedAt: NOW, enforced: true,
        decidedAccount: 'nvidia-nim:n1', freeProvider: 'nvidia-nim', unverified: false },
    ] });
    const capacity = await d.api('capacity');
    assert.equal(capacity.inFlightByAccount['nvidia-nim:n1'], 1);
    const caps = await d.api('caps');
    const namedRunning = caps.agents.reduce((n, a) => n + a.running, 0);
    assert.equal(namedRunning, agentId === 'triage' ? 1 : 0);
    assert.equal(caps.physicalOccupancy.running, 1);
    assert.equal(caps.physicalOccupancy.unassignedRunning, agentId === 'triage' ? 0 : 1);
    assert.equal(caps.agents.reduce((n, a) => n + a.allocated - a.running, 0), 1);
    assert.equal(caps.agents.find(a => a.agentId === 'builder')?.freeAllocated, 0);
    assert.ok(caps.agents.every(a => a.agentId !== 'unknown'));
    assert.equal(capacity.agentRunning.triage?.running ?? 0, 0, 'free running is not paid running');
  });
}

test('storage-outage census preserves saved free attribution and deduplicates its overlapping start', async () => {
  const first = await drive({ records: [
    { runId: 'saved-free', agentId: 'triage', status: 'running', startedAt: NOW, enforced: true,
      decidedAccount: 'nvidia-nim:n1', freeProvider: 'nvidia-nim', unverified: false },
  ] });
  const d = await drive({ state: first.store, initialTick: false });
  const get = d.io.state.get;
  d.io.state.get = async key => {
    if (key.stateKey === 'ledger-v1') throw Error('storage unavailable');
    return get(key);
  };
  for (const runId of ['saved-free', 'distinct']) {
    await d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: runId,
      occurredAt: new Date(NOW).toISOString(), payload: { agentId: 'triage' } });
  }
  for (let i = 0; i < 3; i++) {
    const body = await d.api('caps');
    const row = body.agents.find(a => a.agentId === 'triage');
    assert.equal(row.running, 2);
    assert.equal(row.freeAllocated, 1, 'only the saved decided run has proved free attribution');
    assert.equal(row.allocated, 2);
    assert.equal(row.maxConcurrentRuns, 2);
    assert.deepEqual(body.physicalOccupancy, { running: 2, unassignedRunning: 0, pending: 0 });
    assert.equal(body.agents.reduce((n, a) => n + a.allocated - a.running, 0), 0);
    assert.equal(body.capsError, 'admission-unavailable');
  }
});

test('retained census G1 free: snapshot-only free classification survives restart without charging paid trials', async () => {
  const first = await drive({ records: [{ runId: 'old', status: 'finished', terminalAt: NOW }] });
  const set = first.io.state.set;
  let inserted = false;
  let decision;
  first.io.state.set = async (key, value) => {
    await set(key, value);
    if (key.stateKey === 'ledger-v1' && !inserted) {
      inserted = true;
      decision = await first.hook({ runId: 'late-free' });
      assert.equal(decision.model, MODEL);
      await first.fire({ type: 'agent.run.started', companyId: 'acme', entityId: 'late-free',
        occurredAt: new Date(NOW).toISOString(), payload: { run: { agentId: 'triage', provider: 'nvidia-nim', model: MODEL } } });
    }
  };
  await first.tick();
  assert.ok(!first.store.get(skey('ledger-v1')).some(r => r.runId === 'late-free'));
  const snapshot = first.store.get(skey('capacity-v1')).runningCensusRecords.find(r => r.runId === 'late-free');
  assert.equal(snapshot.freeProvider, 'nvidia-nim');
  assert.deepEqual(snapshot.freeAnswer, decision);
  const d = await drive({ state: first.store });
  const row = d.store.get(skey('ledger-v1')).find(r => r.runId === 'late-free');
  assert.equal(row.freeProvider, 'nvidia-nim');
  assert.equal(row.trial, true, 'free decisions retain their ladder classification too');
  assert.deepEqual(await d.hook({ runId: 'late-free' }), decision, 'same free admission is idempotent after recovery');
  const cap = await d.api('capacity');
  assert.equal(cap.physicalOccupancy.running, 1);
  assert.equal(cap.agentRunning.triage.freeRunning, 1);
  assert.equal(cap.agentRunning.triage.running, 0);
  assert.equal(cap.trialFamilies[row.family].inFlight, 0, 'genuine free work never charges the paid family');
  const paid = await drive({ records: [{ ...row, runId: 'paid-control', freeProvider: undefined, freeAnswer: undefined }] });
  assert.equal((await paid.api('capacity')).trialFamilies[row.family].inFlight, 1,
    'without an enforced free classification the same trial does charge the paid budget');
});

test('unknown ordinary occupancy cannot be replaced by an additive free grant at the physical ceiling', async () => {
  const d = await drive({ config: { concurrency: { maxTotal: 1 } }, records: [
    { runId: 'unmapped-running', agentId: 'unknown', status: 'running', startedAt: NOW, unverified: false },
  ] });
  const caps = await d.api('caps');
  assert.equal(caps.physicalOccupancy.unassignedRunning, 1);
  assert.equal(caps.agents.reduce((n, a) => n + a.allocated, 0), 0);
  assert.ok(caps.agents.every(a => a.freeAllocated === 0));
});

test('high-risk, reviewer, kept, retries and unsupported adapters cannot use the free lane via ordinary routing or exhaustion', async () => {
  for (const extra of [{ agentId: 'builder' }, { agentId: 'thinker' }, { previous: { runId: 'old', model: MODEL } },
    { issueId: null }, { adapterType: 'unsupported' }]) {
    const d = await drive({ config: { exhaustion: { enabled: true, finalAnswerFromAttempt: 1 } } });
    assert.notEqual((await d.hook(extra)).model, MODEL, JSON.stringify(extra));
  }
  const kept = await drive({ config: { roles: { keepAgentIds: ['triage'] } } });
  assert.equal((await kept.hook()).kind, 'keep');
});

test('measured failures demote the exact free arm, including after worker restart', async () => {
  const baseline = await drive();
  const pick = await baseline.hook();
  assert.equal(pick.model, MODEL);
  await baseline.tick();
  const armId = baseline.store.get(skey('ledger-v1')).find(r => r.runId === 'r').armId;
  const records = Array.from({ length: 10 }, (_, i) => ({ runId: `bad${i}`, agentId: 'triage', enforced: true,
    decidedAccount: 'nvidia-nim:n1', freeProvider: 'nvidia-nim', armId, status: 'failed', terminalAt: NOW - i * 1000 }));
  const d = await drive({ records });
  assert.notEqual((await d.hook()).model, MODEL);
  const cap = await d.api('capacity');
  assert.ok(cap.freeLanes.arms.some(a => a.armId === armId && a.reason === 'outcome-demoted'));
  assert.equal(cap.freeLanes.target, 0);
});

test('paid C* is identical with and without a free provider; free target and caps are separate', async () => {
  const withFree = await drive();
  const paidOnly = await drive({ accounts: [withFree.lane.accounts[1]] });
  const a = await withFree.api('capacity'), b = await paidOnly.api('capacity');
  assert.equal(a.paidTarget, b.paidTarget);
  assert.equal(a.freeLanes.target, 3);
  assert.equal(a.target, (a.paidTarget ?? 0) + 3, 'existing fleet-target consumers must see additive throughput');
  assert.equal(a.totalTarget, a.target);
  const caps = await withFree.api('caps');
  const triage = caps.agents.find(a => a.agentId === 'triage');
  assert.equal(triage.freeAllocated, 3);
  assert.equal(caps.agents.find(a => a.agentId === 'builder').freeAllocated, 0);
});

test('flag off is bit-identical for hook, capacity, caps, shadow and persisted state', async () => {
  const legacy = await drive({ free: null });
  const off = await drive({ free: { ...freeConfig, enabled: false } });
  for (let i = 0; i < 4; i++) assert.deepEqual(await off.hook({ runId: `r${i}` }), await legacy.hook({ runId: `r${i}` }));
  await legacy.tick(); await off.tick();
  for (const api of ['capacity', 'caps', 'shadow']) assert.deepEqual(await off.api(api), await legacy.api(api), api);
  assert.deepEqual(off.store, legacy.store);
});

test('disabling free lanes takes effect immediately; enabling waits for fresh native tick', async () => {
  const d = await drive();
  await d.configure({ freeLanes: { ...freeConfig, enabled: false } });
  assert.notEqual((await d.hook()).model, MODEL);
  const off = await drive({ free: null });
  await off.configure({ freeLanes: freeConfig });
  assert.equal((await off.hook()).kind, 'defer');
  await off.tick();
  assert.equal((await off.hook()).model, MODEL);
});

test('enabling free lanes preserves executing floors before a fresh tick without admitting new work', async () => {
  const d = await drive({ free: { ...freeConfig, enabled: false }, records: [
    { runId: 'already-running', agentId: 'triage', status: 'running', startedAt: NOW,
      enforced: true, decidedAccount: 'nvidia-nim:n1', unverified: false },
  ] });
  const old = await d.api('capacity');
  assert.equal(old.freeLanes, undefined);
  assert.equal(old.accounts.find(a => a.accountId === 'nvidia-nim:n1').freeCost, true);
  assert.equal(old.agentRunning.triage.running, 1);
  await d.configure({ freeLanes: freeConfig });
  const before = await d.api('caps');
  const row = before.agents.find(a => a.agentId === 'triage');
  assert.equal(before.capsError, 'admission-unavailable');
  assert.equal(before.target, null);
  assert.equal(row.running, 1);
  assert.equal(row.allocated, 1);
  assert.equal(row.maxConcurrentRuns, 1);
  assert.equal(row.freeAllocated, 1);
  assert.equal(before.agents.reduce((n, a) => n + a.allocated - a.running, 0), 0);
  await d.tick();
  const after = await d.api('caps');
  assert.equal(after.agents.find(a => a.agentId === 'triage').running, 1);
  assert.equal(after.agents.find(a => a.agentId === 'triage').freeAllocated, 3);
  assert.ok(after.agents.reduce((n, a) => n + a.allocated - a.running, 0) > 0,
    'fresh tick restores admission, not merely the old executing floor');
});

for (const weighted of [false, true]) {
  for (const freeCount of [0, 2]) {
    test(`named free occupancy ${freeCount} preserves paid ${weighted ? 'priority shares' : 'reserved floors'}`, async () => {
      const d = await drive({ config: { concurrency: { maxTotal: 4 },
        ...(weighted ? { allocation: { blockingPriority: true } }
          : { caps: { reservedFloors: { a: { base: 2, perQueued: 100, max: 2 } } } }),
      }, records: Array.from({ length: freeCount }, (_, i) => ({ runId: `free-${i}`, agentId: 'triage',
        status: 'running', startedAt: NOW, enforced: true, decidedAccount: 'nvidia-nim:n1',
        freeProvider: 'nvidia-nim', unverified: false })) });
      d.io.issues.list = async ({ status }) => status !== 'todo' ? [] : ['a', 'b'].flatMap(agentId =>
        Array.from({ length: 8 }, (_, i) => ({ id: `${agentId}-${i}`, assigneeAgentId: agentId,
          status, priority: agentId === 'a' ? 'high' : 'low', blockedBy: [] })));
      d.setNow(NOW + 20_000);
      await d.tick();
      d.store.set(skey('capacity-v1'), { ...d.store.get(skey('capacity-v1')),
        target: 20, paidTarget: 20, calibration: 'measured' });
      d.store.set(skey('caps-hold-v1'), { atMs: NOW + 20_000,
        agents: { a: { value: 4, atMs: NOW + 20_000 }, b: { value: 4, atMs: NOW + 20_000 } } });
      const caps = await d.api('caps');
      const rows = new Map(caps.agents.map(a => [a.agentId, a]));
      assert.equal(caps.capsError, undefined);
      assert.deepEqual(['a', 'b'].map(id => rows.get(id).allocated),
        freeCount ? [2, 0] : weighted ? [3, 1] : [2, 2]);
      if (!weighted) assert.equal(rows.get('a').floorBlocked ?? false, false);
      assert.equal(caps.agents.reduce((n, a) => n + a.allocated, 0), 4,
        'free running is reserved once; recombination uses the full physical ceiling');
      if (freeCount) {
        assert.equal(rows.get('triage').running, freeCount);
        assert.equal(rows.get('triage').freeAllocated, freeCount);
      }
    });
  }
}

test('free running remains outside paid C* and paid running after the next tick', async () => {
  const d = await drive();
  const before = await d.api('capacity');
  for (let i = 0; i < 3; i++) {
    assert.equal((await d.hook({ runId: `r${i}` })).model, MODEL);
    await d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: `r${i}`, occurredAt: new Date(NOW).toISOString(),
      payload: { run: { agentId: 'triage', issueId: `i${i}`, model: MODEL, modelSource: 'run-decision' } } });
  }
  await d.tick();
  const after = await d.api('capacity');
  assert.equal(after.paidTarget, before.paidTarget);
  assert.equal(after.agentRunning.triage.running, 0);
  assert.equal(after.agentRunning.triage.freeRunning, 3);
  const caps = await d.api('caps');
  assert.ok(caps.agents.find(a => a.agentId === 'triage').allocated >= 3);
  await d.configure({ freeLanes: { ...freeConfig, enabled: false } });
  const disabled = await d.api('caps');
  assert.ok(disabled.agents.find(a => a.agentId === 'triage').allocated >= 3, 'kill switch must not cut caps below running');
});

test('daily reservations survive tick and restart, including duplicate hook calls', async () => {
  const free = { ...freeConfig, providers: { 'nvidia-nim': { requestsPerMinute: 36,
    requestsPerMinutePerSlot: 12, requestsPerDay: 100, requestsPerRun: 50 } } };
  const d = await drive({ free });
  const first = await d.hook({ runId: 'daily-1' });
  assert.equal(first.model, MODEL);
  assert.deepEqual(await d.hook({ runId: 'daily-1' }), first);
  await d.tick();
  assert.equal(d.store.get(skey('free-lanes-v1')).requests['nvidia-nim'], 50);
  const restarted = await drive({ free, state: d.store });
  assert.equal((await restarted.hook({ runId: 'daily-2' })).model, MODEL);
  assert.notEqual((await restarted.hook({ runId: 'daily-3' })).model, MODEL);
});

test('real failed lifecycle events trigger arm demotion without a seeded verdict', async () => {
  const d = await drive({ config: { breakers: { enabled: false } } });
  for (let i = 0; i < 10; i++) {
    assert.equal((await d.hook({ runId: `failed-${i}` })).model, MODEL);
    await d.fire({ type: 'agent.run.failed', companyId: 'acme', entityId: `failed-${i}`, occurredAt: new Date(NOW).toISOString(),
      payload: { run: { agentId: 'triage', issueId: 'i', model: MODEL, modelSource: 'run-decision', error: 'test assertion failed' } } });
  }
  assert.notEqual((await d.hook({ runId: 'after-ten-failures' })).model, MODEL);
  await d.tick();
  assert.equal((await d.api('capacity')).freeLanes.target, 0);
});

test('manual exclusions, credential evidence and provider health still block free selection', async () => {
  const manual = await drive({ config: { roles: { excludeFamilies: { doer: ['step'] } } } });
  assert.notEqual((await manual.hook()).model, MODEL);
  const unhealthy = await drive();
  unhealthy.lane.accounts[0].health = 'degraded';
  unhealthy.setNow(NOW + 60000);
  await unhealthy.tick();
  assert.notEqual((await unhealthy.hook()).model, MODEL);
  const noReady = await drive({ config: { credentialReadiness: { enforce: true } } });
  noReady.lane.accounts[0].credentialAvailability = { version: 1, models: [] };
  noReady.setNow(NOW + 60000);
  await noReady.tick();
  assert.notEqual((await noReady.hook()).model, MODEL);
});

test('multiple free accounts share one provider budget rather than multiplying slots', async () => {
  const base = await drive();
  const d = await drive({ accounts: [{ ...base.lane.accounts[0] },
    { ...base.lane.accounts[0], lane: 'n2', accountKey: 'n2' }, base.lane.accounts[1]] });
  const answers = await Promise.all(Array.from({ length: 5 }, (_, i) => d.hook({ runId: `shared-${i}` })));
  assert.equal(answers.filter(a => a.model === MODEL).length, 3);
  assert.equal((await d.api('capacity')).freeLanes.target, 3);
});

test('free-only capacity works without paid calibration and respects the hard process ceiling', async () => {
  const base = await drive();
  const d = await drive({ free: { ...freeConfig, minQuality: 0 }, accounts: [base.lane.accounts[0]], config: { concurrency: { maxTotal: 2 } } });
  const caps = await d.api('caps');
  assert.equal(caps.agents.reduce((sum, a) => sum + a.allocated, 0), 2);
  const answers = await Promise.all(Array.from({ length: 3 }, (_, i) => d.hook({ runId: `ceiling-${i}` })));
  assert.equal(answers.filter(a => a.model === MODEL).length, 2);
});

test('free quality floor is independently configurable and never borrows missing task trust', async () => {
  const high = await drive({ free: { ...freeConfig, minQuality: 2 } });
  assert.notEqual((await high.hook()).model, MODEL);
  const task = await drive({ config: { taskRanking: { mode: 'enforce' } } });
  assert.notEqual((await task.hook()).model, MODEL, 'Intelligence Index alone cannot prove coding capability');
});

test('free target uses the same trial-role and metered-headroom admission as the hook', async () => {
  const noRole = await drive({ config: { trials: { roles: [] } } });
  assert.notEqual((await noRole.hook()).model, MODEL);
  assert.equal((await noRole.api('capacity')).freeLanes.target, 0);
  const base = await drive();
  const metered = await drive({ accounts: [{ ...base.lane.accounts[0], meter: 'live', quality: 'live' }, base.lane.accounts[1]] });
  assert.notEqual((await metered.hook()).model, MODEL);
  assert.equal((await metered.api('capacity')).freeLanes.target, 0);
});

test('exhaustion bounded keep cannot reopen a managed free provider', async () => {
  const base = await drive();
  const d = await drive({ free: { ...freeConfig, minQuality: 0 }, accounts: [base.lane.accounts[0]],
    config: { exhaustion: { enabled: true, finalAnswerFromAttempt: 1 } } });
  const out = await d.hook({ agentId: 'builder', agentDefaultModel: MODEL });
  assert.equal(out.kind, 'defer', JSON.stringify(out));
});

test('configured reviewer routing cannot bypass the low-risk-only free provider boundary', async () => {
  const d = await drive({ config: { reviewerRouting: { agentIds: ['triage'], arms: [
    { provider: 'nvidia-nim', model: 'step-5-preview-nim', effort: 'max' },
  ] } } });
  assert.notEqual((await d.hook()).model, MODEL);
});

test('measured positive paid C* and paid agent caps are preserved when free capacity is added', async () => {
  const base = await drive();
  const both = await drive();
  const paid = await drive({ accounts: [base.lane.accounts[1]] });
  for (const d of [both, paid]) {
    for (let tick = 1; tick <= 2; tick++) {
      const at = NOW + tick * 12 * 60000;
      d.setNow(at);
      const c = d.lane.accounts.find(a => a.provider === 'claude');
      c.weekly.used = 0.1 + tick * 0.02;
      c.fiveHour.used = 0.1 + tick * 0.02;
      c.observedAt = new Date(at).toISOString();
      d.lane.observedAt = c.observedAt;
      for (let i = 0; i < 12; i++) {
        const entityId = `paid-${tick}-${i}`;
        for (const type of ['agent.run.started', 'agent.run.finished']) {
          await d.fire({ type, companyId: 'acme', entityId, occurredAt: new Date(at - (type.endsWith('started') ? 60000 : 0)).toISOString(),
            payload: { run: { agentId: 'builder', issueId: 'i', model: 'claude-haiku-5-5', provider: 'claude' } } });
        }
      }
      await d.tick();
    }
  }
  const a = await both.api('capacity'), b = await paid.api('capacity');
  assert.ok(b.paidTarget > 0, 'fixture must actually measure positive paid C*');
  assert.equal(a.paidTarget, b.paidTarget);
  assert.equal(a.target, a.paidTarget + 3);
  const ac = await both.api('caps'), bc = await paid.api('caps');
  for (const agent of bc.agents) {
    const match = ac.agents.find(a => a.agentId === agent.agentId);
    assert.equal(match.allocated - match.freeAllocated, agent.allocated - agent.freeAllocated);
  }
});

test('free trials cannot consume paid same-family trial budgets before or after a tick', async () => {
  const base = await drive();
  const accounts = [base.lane.accounts[0], { ...base.lane.accounts[0], lane: 'paid-step', accountKey: 'paid-step', plan: 'paid' }];
  const config = { roles: { minQuality: { doer: 0, other: 0, thinker: 0 } } };
  const paidOnly = await drive({ accounts: [accounts[1]], config });
  assert.equal((await paidOnly.hook({ agentId: 'builder', runId: 'paid-control' })).kind, 'decide');
  for (const tick of [false, true]) {
    const d = await drive({ accounts, config, free: { ...freeConfig, minQuality: 0 } });
    const free = await d.hook({ runId: 'free-trial' });
    assert.equal(free.model, MODEL);
    assert.match(free.reason, /additive free lane/);
    if (tick) {
      await d.tick();
      assert.equal((await d.api('capacity')).trialFamilies.step.budget, 1);
    }
    const pick = await d.hook({ agentId: 'builder', runId: 'paid-trial' });
    assert.equal(pick.kind, 'decide', `tick=${tick}: ${JSON.stringify(pick)}`);
    assert.match(pick.reason, /nvidia-nim:paid-step/);
  }
});

test('a stale snapshot cannot keep an unadmitted managed free default', async () => {
  const d = await drive();
  d.setNow(NOW + 120001);
  for (const extra of [{ agentId: 'builder' }, { previous: { runId: 'old', model: MODEL } }]) {
    const answer = await d.hook({ ...extra, agentDefaultModel: MODEL });
    assert.equal(answer.kind, 'defer', JSON.stringify(answer));
  }
  const off = await drive({ free: null });
  off.setNow(NOW + 120001);
  assert.equal((await off.hook({ agentDefaultModel: MODEL })).kind, 'keep');
});

test('free-only running floors survive a demoted target and weak paid calibration', async () => {
  const base = await drive();
  const d = await drive({ free: { ...freeConfig, minQuality: 0 }, accounts: [base.lane.accounts[0]],
    config: { breakers: { enabled: false } } });
  assert.equal((await d.hook({ runId: 'still-running' })).model, MODEL);
  await d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: 'still-running', occurredAt: new Date(NOW).toISOString(),
    payload: { run: { agentId: 'triage', issueId: 'i', model: MODEL, modelSource: 'run-decision' } } });
  for (let i = 0; i < 10; i++) {
    assert.equal((await d.hook({ runId: `bad-floor-${i}` })).model, MODEL);
    await d.fire({ type: 'agent.run.failed', companyId: 'acme', entityId: `bad-floor-${i}`, occurredAt: new Date(NOW).toISOString(),
      payload: { run: { agentId: 'triage', issueId: 'i', model: MODEL, modelSource: 'run-decision', error: 'test assertion failed' } } });
  }
  await d.tick();
  assert.equal((await d.api('capacity')).freeLanes.target, 0);
  const caps = await d.api('caps');
  assert.equal(caps.agents.find(a => a.agentId === 'triage')?.allocated, 1, JSON.stringify(caps));
  await d.configure({ freeLanes: { ...freeConfig, enabled: false } });
  assert.equal((await d.api('caps')).agents.find(a => a.agentId === 'triage')?.maxConcurrentRuns, 1);
});

test('free enforcement waits for its first native snapshot, without overriding explicit pins', async () => {
  const d = await drive({ initialTick: false });
  assert.equal((await d.hook({ agentDefaultModel: MODEL })).kind, 'defer');
  assert.equal((await d.hook({ issueOverrideModel: MODEL })).kind, 'keep');
  const off = await drive({ free: null, initialTick: false });
  assert.equal((await off.hook()).kind, 'keep', 'flag off keeps legacy startup behavior');
});

test('the existing maxConcurrentRuns cap field includes free allocations', async () => {
  const d = await drive();
  const caps = await d.api('caps');
  const triage = caps.agents.find(a => a.agentId === 'triage');
  assert.ok(triage.freeAllocated > 0);
  assert.equal(triage.maxConcurrentRuns, triage.allocated);
});

for (const model of [MODEL, 'step-5-preview-nim']) {
  test(`a fresh kept managed-free default defers without reservations or a kept ledger entry: ${model}`, async () => {
    const free = { ...freeConfig, providers: { 'nvidia-nim': { requestsPerMinute: 36,
      requestsPerMinutePerSlot: 12, requestsPerDay: 150, requestsPerRun: 50 } } };
    const d = await drive({ free, config: { roles: { keepAgentIds: ['triage'] } } });
    const { io: hookIo } = d;
    const savedIo = { ...hookIo };
    d.killIo();
    const answer = await d.hook({ runId: 'kept-free', agentDefaultModel: model });
    assert.equal(answer.kind, 'defer', 'kept defaults must not bypass managed-free admission on a fresh tick');
    Object.assign(hookIo, savedIo);
    await d.tick();
    assert.equal(d.store.get(skey('ledger-v1')).some(r => r.runId === 'kept-free'), false,
      'a deferred kept default must not enter the ledger');
    assert.equal(d.store.get(skey('free-lanes-v1')).requests?.['nvidia-nim'] ?? 0, 0,
      'a deferred kept default must not spend the daily free budget');

    await d.configure({ roles: { keepAgentIds: [] } });
    await d.tick();
    const admitted = await Promise.all(Array.from({ length: 3 }, (_, i) => d.hook({ runId: `admitted-${i}` })));
    assert.equal(admitted.filter(a => a.model === MODEL).length, 3,
      'the deferred kept default must leave all three free slots available');
    await d.tick();
    assert.equal(d.store.get(skey('free-lanes-v1')).requests['nvidia-nim'], 150);
  });
}

for (const { name, free, extra } of [
  { name: 'paid kept defaults', free: freeConfig, extra: { agentDefaultModel: 'claude-haiku-5-5' } },
  { name: 'explicit free pins', free: freeConfig, extra: { agentDefaultModel: MODEL, issueOverrideModel: MODEL } },
  { name: 'explicit paid pins over free defaults', free: freeConfig,
    extra: { agentDefaultModel: MODEL, issueOverrideModel: 'claude-haiku-5-5' } },
  { name: 'feature-off kept free defaults', free: { ...freeConfig, enabled: false }, extra: { agentDefaultModel: MODEL } },
]) {
  test(`the fresh kept-default guard preserves ${name} without hook IO`, async () => {
    const d = await drive({ free, config: { roles: { keepAgentIds: ['triage'] } } });
    d.killIo();
    assert.equal((await d.hook(extra)).kind, 'keep');
  });
}

test('restart caps grant no new free slots from a persisted three-slot target before a live tick', async () => {
  const d = await drive();
  assert.equal((await d.api('capacity')).freeLanes.target, 3);
  assert.equal((await d.api('caps')).agents.find(a => a.agentId === 'triage').freeAllocated, 3);
  const restarted = await drive({ state: d.store, initialTick: false });
  assert.equal((await restarted.api('capacity')).freeLanes.target, 3,
    'restart must actually load the persisted positive target');
  const triage = (await restarted.api('caps')).agents.find(a => a.agentId === 'triage');
  assert.equal(triage.freeAllocated, 0, 'a persisted target without live eligibility must not grant new free slots');
  assert.equal((await restarted.hook({ agentDefaultModel: MODEL })).kind, 'defer');

  await restarted.tick();
  assert.equal((await restarted.api('caps')).agents.find(a => a.agentId === 'triage').freeAllocated, 3);
  const admitted = await Promise.all(Array.from({ length: 4 }, (_, i) => restarted.hook({ runId: `fresh-${i}` })));
  assert.equal(admitted.filter(a => a.model === MODEL).length, 3,
    'a fresh live tick must restore ordinary three-slot free admission');
  assert.notEqual(admitted[3].model, MODEL);
});

test('restart caps retain exactly one persisted running-free floor, not the three-slot target', async () => {
  const d = await drive();
  assert.equal((await d.hook({ runId: 'running-free' })).model, MODEL);
  await d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: 'running-free', occurredAt: new Date(NOW).toISOString(),
    payload: { run: { agentId: 'triage', issueId: 'i', model: MODEL, modelSource: 'run-decision' } } });
  await d.tick();
  const capacity = await d.api('capacity');
  assert.equal(capacity.freeLanes.target, 3);
  assert.equal(capacity.agentRunning.triage.freeRunning, 1);
  const restarted = await drive({ state: d.store, initialTick: false });
  assert.equal((await restarted.api('capacity')).freeLanes.target, 3);
  const triage = (await restarted.api('caps')).agents.find(a => a.agentId === 'triage');
  assert.equal(triage.freeAllocated, 1, 'without live eligibility, only the existing running-free slot may survive');
  assert.equal(triage.allocated, 1);
  assert.equal(triage.maxConcurrentRuns, 1, 'the host cap must preserve the running floor without admitting more work');
});

test('N-T12: superseded free arm is never routed and rejected legacy evidence is reported once', async () => {
  for (const mode of ['shadow', 'enforce']) {
    const d = await drive({ config: { roles: { newestVersionOnly: { enabled: true }, minQuality: { doer: null, other: null, thinker: null } }, taskRanking: { mode } } });
    d.lane.accounts[0].models.push('nvidia-nim/step-6-preview-nim');
    d.lane.servedModels.push('nvidia-nim/step-6-preview-nim');
    d.setNow(NOW + 61000);
    d.lane.observedAt = new Date(NOW + 61000).toISOString();
    await d.tick();
    const cap = await d.api('capacity');
    const view = cap.newestVersion.accounts['nvidia-nim:n1'];
    const rejected = view.rejectedCandidates.find(c => c.armId === 'step-5-preview-nim');
    assert.ok(rejected, JSON.stringify(view));
    const rows = cap.freeLanes.arms.filter(a => a.accountId === 'nvidia-nim:n1' && a.armId === rejected.armId);
    assert.equal(rows.length, 1, mode);
    assert.equal(rows[0].eligible, false);
    assert.equal(rows[0].reason, 'superseded-version');
    assert.notEqual((await d.hook()).model, MODEL, mode);
  }
});

test('N-T12: free report deduplicates duplicate task bindings by account and arm', async () => {
  const alias = 'nvidia-nim/step-5-preview-nim-free';
  const newer = 'nvidia-nim/step-6-preview-nim';
  const d = await drive({ config: {
    roles: { newestVersionOnly: { enabled: true } }, taskRanking: { mode: 'enforce' },
    modelAaOverrides: {
      'step-5-preview-nim': { slug: 'step-5', effort: 'max' },
      'step-5-preview-nim-free': { slug: 'step-5', effort: 'max' },
    },
  } });
  d.lane.accounts[0].models.push(alias, newer);
  d.lane.servedModels.push(alias, newer);
  d.setNow(NOW + 61000);
  d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();

  const armId = 'step-5-preview-nim@max';
  const ladder = d.store.get(skey('ladder-v1')).ladders['nvidia-nim:n1'];
  const bindings = ladder.taskRoles.doer.candidates.filter(c => c.armId === armId);
  assert.equal(bindings.length, 2, 'fixture must produce two task candidates for the same arm');
  assert.ok(bindings.every(c => c.selectionReason === 'superseded-version'));
  const rows = (await d.api('capacity')).freeLanes.arms.filter(a => a.accountId === 'nvidia-nim:n1' && a.armId === armId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eligible, false);
  assert.equal(rows[0].reason, 'superseded-version');
});

test('N-T12: task-dialect rejection is reported independently of a kept legacy arm', async () => {
  const d = await drive({ config: { roles: { newestVersionOnly: { enabled: true,
    overrides: { keep: ['arm:step-5-preview-nim'] } } }, taskRanking: { mode: 'enforce' } } });
  d.lane.accounts[0].models.push('nvidia-nim/step-6-preview-nim');
  d.lane.servedModels.push('nvidia-nim/step-6-preview-nim');
  d.setNow(NOW + 61000);
  d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  const cap = await d.api('capacity');
  const view = cap.newestVersion.accounts['nvidia-nim:n1'];
  assert.ok(!view.rejectedCandidates.some(c => c.armId === 'step-5-preview-nim'));
  assert.ok(view.supersededTaskArmIds.includes('step-5-preview-nim@max'));
  const rows = cap.freeLanes.arms.filter(a => a.accountId === 'nvidia-nim:n1' && a.armId === 'step-5-preview-nim@max');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'superseded-version');
  assert.equal(rows[0].eligible, false);
  assert.notEqual((await d.hook()).model, MODEL);
});
