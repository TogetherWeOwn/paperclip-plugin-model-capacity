import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLaneBody } from '../src/cliproxy.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { parseCredentialAvailability, credentialEvidenceFor, credentialReadiness, filterCredentialRungs } from '../src/availability.mjs';

const NOW = Date.parse('2026-10-11T14:49:00Z');
const ISO = new Date(NOW).toISOString();
const MODEL = 'gemini-3.1-pro-low';
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };

function account(model = MODEL, provider = 'antigravity', key = 'synthetic', ready = 0) {
  return {
    provider, accountKey: key, health: 'healthy', meter: 'reactive', models: [model],
    observedAt: ISO,
    credentialAvailability: { version: 1, models: [{
      model, provider, accountId: `${provider}:${key}`,
      servingCredentials: 2, readyCredentials: ready,
      observedAt: ISO, expiresAt: new Date(NOW + 120000).toISOString(),
    }] },
  };
}

async function start(accounts, rows = null, configure = () => {}) {
  let now = NOW;
  let fetchStatus = 200;
  const lane = { observedAt: ISO, servedModels: accounts.flatMap(a => a.models), accounts };
  const store = new Map();
  const jobs = new Map();
  const events = new Map();
  const warnings = [];
  const key = k => JSON.stringify(k);
  const config = {
    enforce: true, credentialReadiness: { enforce: true }, cliproxy: { laneKeySecretRef: SECRET },
    trials: { maxInFlightPerAccount: 10 },
    armMap: accounts.flatMap(a => a.models.map(model => ({
      aaSlug: model, model, effort: 'max', family: 'sol', providers: [a.provider],
    }))),
    roles: { minQuality: { doer: null, thinker: null, other: null }, outcomeGate: { enabled: false } },
  };
  configure(config);
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'synthetic-lane-key' },
    http: { fetch: async () => ({ status: fetchStatus, json: async () => lane }) },
    agents: { get: async () => null }, issues: { get: async () => null, list: async () => [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { events.set(name, fn); } },
    logger: { info() {}, error() {}, warn(message, details) { warnings.push({ message, details }); } },
  });
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }), {
    fetchedAt: ISO, duplicateSlugs: [], rows: rows ?? [...new Set(accounts.flatMap(a => a.models))].map((slug, i) => ({
      slug, intelligenceIndex: 70 + i, intelligenceIndexCostPerTask: 10 + i,
      price1mInputTokens: 1, price1mOutputTokens: 4,
    })),
  });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  return {
    lane, warnings,
    seedState: (stateKey, value) => store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey }), value),
    setNow: value => { now = value; },
    setFetchStatus: value => { fetchStatus = value; },
    setEnforce: value => {
      config.enforce = value;
      return plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    setCredentialEnforce: value => {
      config.credentialReadiness.enforce = value;
      return plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    hook: runId => plugin.onResolveRunModel({ runId, companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code', deadlineMs: 1500 }),
    startRun: runId => events.get('agent.run.started')({
      type: 'agent.run.started', companyId: 'acme', entityId: runId,
      payload: { run: { agentId: 'agent-9', adapterType: 'claude-code' } }, occurredAt: new Date(now).toISOString(),
    }),
  };
}

test('all serving credentials cooling excludes the exact arm before enforced resolve', async () => {
  const d = await start([account()]);
  await d.tick();
  assert.equal((await d.hook('all-cooling')).kind, 'defer');
  assert.deepEqual((await d.api('ladder')).body.ladders['antigravity:synthetic'].rungs, []);
});

test('one ready credential is preserved by the parser and stays eligible', async () => {
  const raw = account(MODEL, 'antigravity', 'synthetic', 1);
  const parsed = parseLaneBody({ accounts: [raw] }, NOW).accounts[0];
  assert.equal(parsed.credentialAvailability.models[0].readyCredentials, 1);
  const d = await start([raw]);
  await d.tick();
  assert.equal((await d.hook('one-ready')).kind, 'decide');
});

function readiness(raw, model = MODEL, nowMs = NOW) {
  const parsed = parseLaneBody({ accounts: [raw] }, nowMs).accounts[0];
  return credentialReadiness(credentialEvidenceFor(parsed, model), nowMs);
}

for (const [name, change, reason] of [
  ['missing', a => { delete a.credentialAvailability; }, 'missing'],
  ['malformed envelope', a => { a.credentialAvailability = 'ready'; }, 'malformed'],
  ['unsupported version', a => { a.credentialAvailability.version = 2; }, 'malformed'],
  ['empty model list', a => { a.credentialAvailability.models = []; }, 'missing-model'],
  ['malformed row', a => { a.credentialAvailability.models = [null]; }, 'malformed'],
  ['string count', a => { a.credentialAvailability.models[0].readyCredentials = '1'; }, 'malformed'],
  ['negative count', a => { a.credentialAvailability.models[0].servingCredentials = -1; }, 'malformed'],
  ['fractional count', a => { a.credentialAvailability.models[0].servingCredentials = 1.5; }, 'malformed'],
  ['unsafe integer count', a => { a.credentialAvailability.models[0].servingCredentials = Number.MAX_SAFE_INTEGER + 1; }, 'malformed'],
  ['contradictory counts', a => { a.credentialAvailability.models[0].readyCredentials = 3; }, 'malformed'],
  ['wrong provider', a => { a.credentialAvailability.models[0].provider = 'partner'; }, 'malformed'],
  ['wrong account', a => { a.credentialAvailability.models[0].accountId = 'antigravity:other'; }, 'malformed'],
  ['no observation', a => { delete a.credentialAvailability.models[0].observedAt; }, 'malformed'],
  ['numeric observation', a => { a.credentialAvailability.models[0].observedAt = NOW; }, 'malformed'],
  ['no expiry', a => { delete a.credentialAvailability.models[0].expiresAt; }, 'malformed'],
  ['expiry before observation', a => { a.credentialAvailability.models[0].expiresAt = ISO; }, 'malformed'],
  ['future observation', a => { a.credentialAvailability.models[0].observedAt = new Date(NOW + 1).toISOString(); }, 'future'],
  ['stale observation', a => { a.credentialAvailability.models[0].observedAt = new Date(NOW - 120000).toISOString(); }, 'expired'],
  ['zero serving credentials', a => { Object.assign(a.credentialAvailability.models[0], { servingCredentials: 0, readyCredentials: 0 }); }, 'zero-serving'],
  ['all credentials cooling', a => { a.credentialAvailability.models[0].readyCredentials = 0; }, 'all-cooling'],
  ['duplicate identity', a => { a.credentialAvailability.models.push({ ...a.credentialAvailability.models[0], readyCredentials: 0 }); }, 'malformed'],
]) {
  test(`${name} never becomes fresh healthy evidence`, async () => {
    const raw = account(MODEL, 'antigravity', 'synthetic', 1);
    change(raw);
    assert.deepEqual(readiness(raw), { eligible: false, reason });
    const d = await start([raw]);
    await d.tick();
    assert.equal((await d.hook(name)).kind, 'defer');
    assert.equal((await d.api('capacity')).body.credentialAvailability.alarm, true);
    assert.ok(d.warnings.some(w => w.details.code === 'credential-availability-all-unavailable'));
  });
}

test('expiry closes both ready and cooling observations; it never declares recovery', () => {
  const ready = account(MODEL, 'antigravity', 'synthetic', 1);
  ready.credentialAvailability.models[0].expiresAt = new Date(NOW + 1000).toISOString();
  assert.equal(readiness(ready, MODEL, NOW + 999).eligible, true);
  assert.deepEqual(readiness(ready, MODEL, NOW + 1000), { eligible: false, reason: 'expired' });
  ready.credentialAvailability.models[0].readyCredentials = 0;
  assert.equal(readiness(ready, MODEL, NOW + 1000).eligible, false);
  ready.credentialAvailability.models[0].expiresAt = new Date(NOW + 86400000).toISOString();
  ready.credentialAvailability.models[0].readyCredentials = 1;
  assert.equal(readiness(ready, MODEL, NOW + 120000).eligible, false, 'producer cannot extend the 120s bound');
});

test('identity matching never strips provider prefixes, aliases, dates, or effort suffixes', () => {
  const raw = account(`partner/${MODEL}`, 'partner', 'bucket', 1);
  for (const model of [MODEL, `other/${MODEL}`, `${MODEL}-alias`, `${MODEL}(max)`, `${MODEL}[1m]`]) {
    assert.equal(readiness(raw, model).eligible, false, model);
  }
  assert.equal(readiness(raw, `partner/${MODEL}`).eligible, true);
});

test('a bad model row cannot poison a different valid model or retain unknown fields', () => {
  const raw = account(MODEL, 'antigravity', 'synthetic', 1);
  raw.credentialAvailability.models[0].untrustedExtra = 'do-not-retain';
  raw.credentialAvailability.models.push({ model: 'other-model', servingCredentials: 'bad' });
  const parsed = parseLaneBody({ accounts: [raw] }, NOW).accounts[0];
  assert.equal(credentialReadiness(credentialEvidenceFor(parsed, MODEL), NOW).eligible, true);
  assert.equal(credentialReadiness(credentialEvidenceFor(parsed, 'other-model'), NOW).eligible, false);
  assert.ok(!JSON.stringify(parsed.credentialAvailability).includes('do-not-retain'));
  const groups = [{ rung: 2, arms: [
    { armId: MODEL, credentialEvidence: credentialEvidenceFor(parsed, MODEL) },
    { armId: 'other-model', credentialEvidence: credentialEvidenceFor(parsed, 'other-model') },
  ] }];
  assert.equal(filterCredentialRungs(groups, NOW)[0].arms.length, 1);
  assert.equal(groups[0].arms.length, 2, 'runtime filtering cannot mutate the frozen view');
});

test('same-account alternate arm and unrelated-account fallback agree in tick, event and hook', async () => {
  const cooled = account('gpt-6-luna', 'codex', 'a', 0);
  const available = account('gpt-6.1-sol', 'codex', 'a', 1);
  cooled.models.push(...available.models);
  cooled.credentialAvailability.models.push(...available.credentialAvailability.models);
  const unavailableSibling = account('gpt-6.1-sol', 'partner', 'b', 0);
  const d = await start([cooled, unavailableSibling]);
  await d.startRun('tick-run');
  await d.tick();
  const tick = (await d.api('shadow')).body.entries.find(e => e.runId === 'tick-run');
  assert.match(tick.wouldModel, /^gpt-6\.1-sol/);
  assert.equal(tick.accountId, 'codex:a');
  await d.startRun('event-run');
  await d.tick();
  const event = (await d.api('shadow')).body.entries.find(e => e.runId === 'event-run');
  assert.equal(event.eventTime, true);
  assert.match(event.wouldModel, /^gpt-6\.1-sol/);
  const hook = await d.hook('hook-run');
  assert.equal(hook.model, 'gpt-6.1-sol');
  assert.match(hook.reason, /codex:a/);
  const report = (await d.api('capacity')).body.credentialAvailability;
  assert.equal(report.alarm, false);
  assert.equal(report.models.filter(r => !r.eligible).length, 2);
});

test('another ready account wins when the same emitted model is cooling on the first', async () => {
  const d = await start([account(MODEL, 'antigravity', 'a', 0), account(MODEL, 'partner', 'b', 1)]);
  await d.tick();
  const hook = await d.hook('fallback');
  assert.equal(hook.kind, 'decide');
  assert.match(hook.reason, /partner:b/);
});

test('prefixed discovery cannot admit a bare emitted id using only prefixed readiness', async () => {
  const raw = account(MODEL, 'partner', 'a', 1);
  raw.models = [`partner/${MODEL}`];
  raw.credentialAvailability.models[0].model = `partner/${MODEL}`;
  const d = await start([raw], [{ slug: MODEL, intelligenceIndex: 80, intelligenceIndexCostPerTask: 5 }]);
  d.lane.servedModels = [MODEL];
  await d.tick();
  assert.equal((await d.hook('prefixed-only')).kind, 'defer');
});

test('readiness expiry is checked between ticks in hook and event shadow', async () => {
  const raw = account(MODEL, 'antigravity', 'a', 1);
  raw.credentialAvailability.models[0].expiresAt = new Date(NOW + 1000).toISOString();
  const d = await start([raw]);
  await d.tick();
  assert.equal((await d.hook('before-expiry')).kind, 'decide');
  d.setNow(NOW + 1000);
  assert.equal((await d.hook('at-expiry')).kind, 'defer');
  await d.startRun('expired-event');
  await d.tick();
  const entries = (await d.api('shadow')).body.entries;
  assert.ok(!entries.some(e => e.runId === 'expired-event'));
  assert.equal((await d.api('capacity')).body.credentialAvailability.alarm, true);
});

test('stale enforced live view defers rather than running an unchecked default model', async () => {
  const d = await start([account(MODEL, 'antigravity', 'a', 1)]);
  await d.tick();
  d.setNow(NOW + 120001);
  const hook = await d.hook('stale-live');
  assert.equal(hook.kind, 'defer');
  assert.match(hook.reason, /stale/);
});

test('expiry while resolve yields still selects a ready alternative on the same account', async () => {
  const raw = account('gpt-6-luna', 'codex', 'a', 1);
  const longer = account('gpt-6.1-sol', 'codex', 'a', 1);
  raw.models.push(...longer.models);
  raw.credentialAvailability.models[0].expiresAt = new Date(NOW + 1000).toISOString();
  raw.credentialAvailability.models.push(...longer.credentialAvailability.models);
  const d = await start([raw], [
    { slug: 'gpt-6.1-sol', intelligenceIndex: 90, intelligenceIndexCostPerTask: 2 },
    { slug: 'gpt-6-luna', intelligenceIndex: 70, intelligenceIndexCostPerTask: 1 },
  ]);
  await d.tick();
  const pending = d.hook('expiry-during-resolve');
  d.setNow(NOW + 1000);
  const result = await pending;
  assert.equal(result.kind, 'decide');
  assert.equal(result.model, 'gpt-6.1-sol');
});

test('expiry exposes a previously dominated but still ready model before ranking', async () => {
  const best = account('gpt-6.1-sol', 'codex', 'a', 1);
  best.credentialAvailability.models[0].expiresAt = new Date(NOW + 1000).toISOString();
  const backup = account('gpt-6-luna', 'codex', 'a', 1);
  best.models.push(...backup.models);
  best.credentialAvailability.models.push(...backup.credentialAvailability.models);
  const d = await start([best], [
    { slug: 'gpt-6.1-sol', intelligenceIndex: 90, intelligenceIndexCostPerTask: 1 },
    { slug: 'gpt-6-luna', intelligenceIndex: 70, intelligenceIndexCostPerTask: 2 },
  ]);
  await d.tick();
  assert.equal((await d.hook('dominant-ready')).model, 'gpt-6.1-sol');
  d.setNow(NOW + 1000);
  assert.equal((await d.hook('dominant-expired')).model, 'gpt-6-luna');
  await d.startRun('backup-event');
  await d.tick();
  const event = (await d.api('shadow')).body.entries.find(e => e.runId === 'backup-event');
  assert.equal(event.eventTime, true);
  assert.match(event.wouldModel, /^gpt-6-luna/);
});

test('a feed observed during fetch is evaluated after fetch, not against tick start', async () => {
  const raw = account(MODEL, 'antigravity', 'a', 1);
  raw.credentialAvailability.models[0].observedAt = new Date(NOW + 1000).toISOString();
  const d = await start([raw]);
  const pending = d.tick();
  d.setNow(NOW + 1000);
  await pending;
  assert.equal((await d.hook('fresh-during-fetch')).kind, 'decide');
});

test('all-unavailable leaves no tick or event decisions and emits an admission alarm', async () => {
  const d = await start([account(MODEL, 'antigravity', 'a', 0), account(MODEL, 'partner', 'b', 0)]);
  await d.startRun('all-unavailable-tick');
  await d.tick();
  await d.startRun('all-unavailable-event');
  assert.equal((await d.hook('all-unavailable-hook')).kind, 'defer');
  await d.tick();
  assert.deepEqual((await d.api('shadow')).body.entries, []);
  assert.equal((await d.api('capacity')).body.credentialAvailability.alarm, true);
  assert.ok(d.warnings.some(w => w.details.code === 'credential-availability-all-unavailable'));
});

test('a new ready observation reopens a cooling arm, never expiry alone', async () => {
  const raw = account(MODEL, 'antigravity', 'a', 0);
  const d = await start([raw]);
  await d.tick();
  assert.equal((await d.hook('before-refresh')).kind, 'defer');
  d.setNow(NOW + 50000);
  Object.assign(raw.credentialAvailability.models[0], {
    readyCredentials: 1,
    observedAt: new Date(NOW + 50000).toISOString(),
    expiresAt: new Date(NOW + 60000).toISOString(),
  });
  await d.tick();
  assert.equal((await d.hook('after-refresh')).kind, 'decide');
});

test('credential outages cannot change fleet quality calibration or scored fleet size', async () => {
  const accounts = Array.from({ length: 8 }, (_, i) => account(`synthetic-model-${i}`, 'partner', `a-${i}`, 1));
  const ready = await start(structuredClone(accounts));
  await ready.tick();
  const expected = (await ready.api('capacity')).body.eligibility.arms.map(a => [a.armId, a.qFleet]);
  for (const a of accounts.slice(1)) a.credentialAvailability.models[0].readyCredentials = 0;
  const outage = await start(accounts);
  await outage.tick();
  assert.deepEqual((await outage.api('capacity')).body.eligibility.arms.map(a => [a.armId, a.qFleet]), expected);
  assert.equal(expected.length, 8);
  assert.equal((await outage.hook('calibration-stable')).model, 'synthetic-model-0');
});

test('an all-closed tick preserves benchmark incumbency for recovery', async () => {
  const raw = account(MODEL, 'antigravity', 'a', 1);
  const d = await start([raw]);
  await d.tick();
  const before = (await d.api('ladder')).body.ladders['antigravity:a'];
  raw.credentialAvailability.models[0].readyCredentials = 0;
  d.setNow(NOW + 50000);
  await d.tick();
  const closed = (await d.api('ladder')).body.ladders['antigravity:a'];
  assert.deepEqual(closed.rungs, []);
  assert.deepEqual(closed.rankingRungs, before.rankingRungs);
  raw.credentialAvailability.models[0].readyCredentials = 1;
  d.setNow(NOW + 100000);
  await d.tick();
  assert.deepEqual((await d.api('ladder')).body.ladders['antigravity:a'].rungs, before.rungs);
});

test('an all-closed readiness tick cannot reset the paced pointer', async () => {
  const raw = account('gpt-6-luna', 'codex', 'a', 1);
  const higher = account('gpt-6.1-sol', 'codex', 'a', 1);
  raw.models.push(...higher.models);
  raw.credentialAvailability.models.push(...higher.credentialAvailability.models);
  const d = await start([raw], [
    { slug: 'gpt-6-luna', intelligenceIndex: 70, intelligenceIndexCostPerTask: 1 },
    { slug: 'gpt-6.1-sol', intelligenceIndex: 90, intelligenceIndexCostPerTask: 2 },
  ]);
  d.seedState('pacing-v1', { 'codex:a': { pointer: 1, lastMoveAtMs: NOW, guardActive: false } });
  await d.tick();
  for (const row of raw.credentialAvailability.models) row.readyCredentials = 0;
  d.setNow(NOW + 50000);
  await d.tick();
  assert.deepEqual((await d.api('ladder')).body.ladders['codex:a'].rungs, []);
  const closed = (await d.api('capacity')).body.accounts.find(a => a.accountId === 'codex:a');
  assert.equal(closed.pointer, 1);
  for (const row of raw.credentialAvailability.models) row.readyCredentials = 1;
  d.setNow(NOW + 100000);
  await d.tick();
  assert.equal((await d.api('capacity')).body.accounts.find(a => a.accountId === 'codex:a').pointer, 1);
});

test('expiry exposes a dominated trial family with a bounded budget before the next tick', async () => {
  const best = account('gpt-6.1-sol', 'codex', 'a', 1);
  best.credentialAvailability.models[0].expiresAt = new Date(NOW + 1000).toISOString();
  const backup = account('synthetic-trial-model', 'codex', 'a', 1);
  best.models.push(...backup.models);
  best.credentialAvailability.models.push(...backup.credentialAvailability.models);
  const d = await start([best], [
    { slug: 'gpt-6.1-sol', intelligenceIndex: 90, intelligenceIndexCostPerTask: 1 },
    { slug: 'synthetic-trial-model', intelligenceIndex: 70, intelligenceIndexCostPerTask: 2 },
  ], config => {
    config.armMap.find(a => a.model === 'synthetic-trial-model').family = 'synthetic';
    config.trials.maxInFlightPerFamily = 1;
  });
  await d.tick();
  d.setNow(NOW + 1000);
  const first = await d.hook('trial-backup');
  assert.equal(first.kind, 'decide');
  assert.equal(first.model, 'synthetic-trial-model');
  assert.equal((await d.hook('trial-family-budget-spent')).kind, 'defer');
});

test('duplicate account identity closes only the ambiguous buckets', async () => {
  const a = account(MODEL, 'antigravity', 'duplicate', 1);
  const b = { ...account(MODEL, 'antigravity', 'duplicate', 1), lane: 'another-lane' };
  const other = account(MODEL, 'partner', 'b', 1);
  const parsed = parseLaneBody({ accounts: [a, b, other] }, NOW);
  for (const row of parsed.accounts.slice(0, 2)) {
    assert.equal(credentialReadiness(credentialEvidenceFor(row, MODEL), NOW).eligible, false);
  }
  assert.equal(credentialReadiness(credentialEvidenceFor(parsed.accounts[2], MODEL), NOW).eligible, true);
  const d = await start([a, b, other]);
  await d.tick();
  assert.match((await d.hook('ambiguous-account')).reason, /partner:b/);
});

test('a rejected future observation cannot open inside the frozen parsed view', () => {
  const raw = account(MODEL, 'antigravity', 'a', 1);
  raw.credentialAvailability.models[0].observedAt = new Date(NOW + 1000).toISOString();
  const parsed = parseLaneBody({ accounts: [raw] }, NOW).accounts[0];
  assert.equal(credentialReadiness(credentialEvidenceFor(parsed, MODEL), NOW + 1000).eligible, false);
});

test('impossible calendar dates cannot be normalized into fresh evidence', () => {
  const raw = account(MODEL, 'antigravity', 'a', 1);
  Object.assign(raw.credentialAvailability.models[0], {
    observedAt: '2026-02-30T00:00:00Z', expiresAt: '2026-03-02T00:02:00Z',
  });
  assert.equal(readiness(raw, MODEL, Date.parse('2026-03-02T00:00:00Z')).reason, 'malformed');
});

test('enforce off stops stale-snapshot deferral during a failing tick', async () => {
  const d = await start([account(MODEL, 'antigravity', 'a', 1)]);
  await d.tick();
  d.setFetchStatus(503);
  d.setNow(NOW + 180000);
  await assert.rejects(d.tick(), /shadow-tick-failed/);
  assert.equal((await d.hook('outage-enforced')).kind, 'defer');
  await d.setEnforce(false);
  assert.deepEqual(await d.hook('outage-disabled'), { kind: 'keep' });
  await d.setEnforce(true);
  assert.equal((await d.hook('outage-reenabled')).kind, 'defer', 'enabling cannot bypass stale evidence');
});

test('enforce off while resolve yields stops a fresh-view decision', async () => {
  const d = await start([account(MODEL, 'antigravity', 'a', 1)]);
  await d.tick();
  const pending = d.hook('disabled-during-ledger-load');
  await d.setEnforce(false);
  assert.deepEqual(await pending, { kind: 'keep' });
});

function threeRungAccount() {
  const raw = account('model-a', 'partner', 'a', 1);
  for (const model of ['model-b', 'model-c']) {
    const next = account(model, 'partner', 'a', 1);
    raw.models.push(model);
    raw.credentialAvailability.models.push(...next.credentialAvailability.models);
  }
  return raw;
}

for (const ceiling of [null, 1]) {
  test(`cooling rung zero preserves pointer one and doer ceiling ${ceiling} in all paths`, async () => {
    const raw = threeRungAccount();
    raw.credentialAvailability.models[0].readyCredentials = 0;
    const d = await start([raw], null, config => {
      config.roles.doerAgentIds = ['agent-9'];
      config.roles.doerCeilingRung = ceiling;
    });
    d.seedState('pacing-v1', { 'partner:a': { pointer: 1, lastMoveAtMs: NOW, guardActive: false } });
    await d.startRun('cooled-low-tick');
    await d.tick();
    const tick = (await d.api('shadow')).body.entries.find(e => e.runId === 'cooled-low-tick');
    assert.equal(tick.rung, 1);
    assert.match(tick.wouldModel, /^model-b/);
    const rungs = (await d.api('ladder')).body.ladders['partner:a'].rungs;
    assert.deepEqual(rungs.map(r => r.rung), [1, 2]);
    assert.equal((await d.hook('cooled-low-hook')).model, 'model-b');
    await d.startRun('cooled-low-event');
    await d.tick();
    const event = (await d.api('shadow')).body.entries.find(e => e.runId === 'cooled-low-event');
    assert.equal(event.eventTime, true);
    assert.equal(event.rung, 1);
    assert.match(event.wouldModel, /^model-b/);
  });
}

test('expiry of the low rung between ticks cannot promote pointer one to rung two', async () => {
  const raw = threeRungAccount();
  raw.credentialAvailability.models[0].expiresAt = new Date(NOW + 1000).toISOString();
  const d = await start([raw]);
  d.seedState('pacing-v1', { 'partner:a': { pointer: 1, lastMoveAtMs: NOW, guardActive: false } });
  await d.tick();
  assert.equal((await d.hook('low-rung-fresh')).model, 'model-b');
  d.setNow(NOW + 1000);
  assert.equal((await d.hook('low-rung-expired')).model, 'model-b');
});

test('cooling middle rung keeps the higher rung out of a doer ceiling one', async () => {
  const raw = threeRungAccount();
  raw.credentialAvailability.models[1].readyCredentials = 0;
  const d = await start([raw], null, config => {
    config.roles.doerAgentIds = ['agent-9'];
    config.roles.doerCeilingRung = 1;
  });
  d.seedState('pacing-v1', { 'partner:a': { pointer: 1, lastMoveAtMs: NOW, guardActive: false } });
  await d.tick();
  assert.equal((await d.hook('middle-cooled-ceiling')).model, 'model-a');
});

test('cooling the low and middle rungs still allows a full-coverage top-rung model', async () => {
  const raw = threeRungAccount();
  raw.credentialAvailability.models[0].readyCredentials = 0;
  raw.credentialAvailability.models[1].readyCredentials = 0;
  const d = await start([raw]);
  d.seedState('pacing-v1', { 'partner:a': { pointer: 2, lastMoveAtMs: NOW, guardActive: false } });
  await d.tick();
  const rungs = (await d.api('ladder')).body.ladders['partner:a'].rungs;
  assert.equal(rungs[0].rung, 2);
  assert.equal(rungs[0].maxRung, 2);
  const hook = await d.hook('only-top-ready');
  assert.equal(hook.model, 'model-c');
  assert.match(hook.reason, /rung 2/);
});

test('cooling top rung cannot lower a thinker floor, and recovery restores it', async () => {
  const raw = threeRungAccount();
  raw.credentialAvailability.models[2].readyCredentials = 0;
  const d = await start([raw], null, config => {
    config.roles.thinkerAgentIds = ['agent-9'];
    config.roles.thinkerFloorRung = 2;
  });
  d.seedState('pacing-v1', { 'partner:a': { pointer: 2, lastMoveAtMs: NOW, guardActive: false } });
  await d.tick();
  assert.equal((await d.hook('top-cooled-thinker')).kind, 'defer');
  raw.credentialAvailability.models[2].readyCredentials = 1;
  d.setNow(NOW + 50000);
  await d.tick();
  const hook = await d.hook('top-recovered-thinker');
  assert.equal(hook.model, 'model-c');
  assert.match(hook.reason, /rung 2/);
});

test('a dominated backup inherits its unavailable incumbent rung, not a cheaper role band', async () => {
  const raw = threeRungAccount();
  const backup = account('model-backup', 'partner', 'a', 1);
  raw.models.push(...backup.models);
  raw.credentialAvailability.models.push(...backup.credentialAvailability.models);
  raw.credentialAvailability.models[1].readyCredentials = 0;
  raw.credentialAvailability.models[2].readyCredentials = 0;
  const d = await start([raw], [
    { slug: 'model-a', intelligenceIndex: 60, intelligenceIndexCostPerTask: 1 },
    { slug: 'model-b', intelligenceIndex: 80, intelligenceIndexCostPerTask: 2 },
    { slug: 'model-c', intelligenceIndex: 90, intelligenceIndexCostPerTask: 3 },
    { slug: 'model-backup', intelligenceIndex: 70, intelligenceIndexCostPerTask: 4 },
  ], config => {
    config.roles.doerAgentIds = ['agent-9'];
    config.roles.doerCeilingRung = 0;
  });
  d.seedState('pacing-v1', { 'partner:a': { pointer: 1, lastMoveAtMs: NOW, guardActive: false } });
  await d.tick();
  const rungs = (await d.api('ladder')).body.ladders['partner:a'].rungs;
  assert.equal(rungs.find(r => r.model === 'model-backup').rung, 1);
  assert.equal((await d.hook('revived-backup-role-ceiling')).model, 'model-a');
  raw.credentialAvailability.models[0].readyCredentials = 0;
  d.setNow(NOW + 50000);
  await d.tick();
  const backupOnly = (await d.api('ladder')).body.ladders['partner:a'].rungs;
  assert.equal(backupOnly[0].model, 'model-backup');
  assert.equal(backupOnly[0].rung, 1);
  assert.equal((await d.hook('backup-cannot-enter-rung-zero')).kind, 'defer');
});

test('readiness off preserves legacy routing and target while reporting all-cooling evidence', async () => {
  const d = await start([account(MODEL, 'antigravity', 'synthetic', 0)], null, config => {
    config.credentialReadiness.enforce = false;
  });
  await d.tick();
  const hook = await d.hook('off-mode-all-cooling');
  assert.equal(hook.kind, 'decide');
  const capacity = (await d.api('capacity')).body;
  assert.equal(capacity.targetRaw, null);
  assert.equal(capacity.credentialAvailability.mode, 'off');
  assert.equal(capacity.credentialAvailability.validEnvelopeAccounts, 1);
  assert.equal(capacity.credentialAvailability.countsByReason['all-cooling'], 1);
  assert.equal(capacity.credentialAvailability.totalAccounts, 1);
  assert.ok(!d.warnings.some(w => String(w.details.code).startsWith('credential-availability-')));
});

test('credential readiness config flips change hook and event admission immediately', async () => {
  const d = await start([account()]);
  await d.tick();
  assert.equal((await d.hook('flip-on')).kind, 'defer');
  await d.startRun('event-on');
  assert.equal((await d.api('shadow')).body.entries.some(row => row.runId === 'event-on'), false);

  await d.setCredentialEnforce(false);
  await d.startRun('event-off');
  await d.tick();
  assert.equal((await d.api('shadow')).body.entries.some(row => row.runId === 'event-off'), true);

  await d.setCredentialEnforce(true);
  assert.equal((await d.hook('flip-on-pending-tick')).kind, 'decide');
  await d.tick();
  assert.equal((await d.hook('flip-on-again')).kind, 'defer');
});

test('legacy frozen cooldown text and timestamps cannot manufacture fresh readiness', () => {
  const raw = account();
  delete raw.credentialAvailability;
  raw.model_cooldowns = [{ model: MODEL, scope: 'model', reason: 'all_credentials_cooling', retry_at: new Date(NOW + 1000).toISOString() }];
  raw.last_error = '429 Resets in 156h6m46s';
  assert.deepEqual(readiness(raw, MODEL, NOW + 2000), { eligible: false, reason: 'missing' });
  const parsed = parseCredentialAvailability(undefined);
  assert.deepEqual(parsed, { status: 'missing', models: [] });
});

test('disabling enforcement during a lane fetch holds after the tick lands', async () => {
  // The tick reads its config BEFORE the lane fetch and publishes AFTER it,
  // so a shared mutated config object cannot show the race: every config
  // read here returns a per-call snapshot, and the second tick waits on a
  // gated fetch while the flip lands mid-flight.
  const current = {
    enforce: true, credentialReadiness: { enforce: true }, cliproxy: { laneKeySecretRef: SECRET },
    trials: { maxInFlightPerAccount: 10 },
    armMap: [MODEL].map(model => ({
      aaSlug: model, model, effort: 'max', family: 'sol', providers: ['antigravity'],
    })),
    roles: { minQuality: { doer: null, thinker: null, other: null }, outcomeGate: { enabled: false } },
  };
  const lane = { observedAt: ISO, servedModels: [MODEL], accounts: [account()] };
  let now = NOW;
  const store = new Map();
  const jobs = new Map();
  const key = k => JSON.stringify(k);
  let fetchCalls = 0;
  let releaseFetch = null;
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => structuredClone(current) },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'synthetic-lane-key' },
    http: { fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 2) await new Promise(resolve => { releaseFetch = resolve; });
      return { status: 200, json: async () => lane };
    } },
    agents: { get: async () => null }, issues: { get: async () => null, list: async () => [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: () => {} },
    logger: { info() {}, error() {}, warn() {} },
  });
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }), {
    fetchedAt: ISO, duplicateSlugs: [], rows: [{ slug: MODEL, intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 }],
  });
  await plugin.onConfigChanged(structuredClone(current), { companyId: 'acme' });
  const tick = () => jobs.get('shadow-tick')({});
  const hook = runId => plugin.onResolveRunModel({ runId, companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code', deadlineMs: 1500 });
  await tick();
  assert.equal((await hook('race-on')).kind, 'defer');
  // Past the 45s lane cache so the next tick really fetches, inside the 120s
  // evidence and live-view bounds so the feed and the view stay fresh.
  now = NOW + 46000;
  const inFlight = tick();
  while (fetchCalls < 2) await new Promise(resolve => setImmediate(resolve));
  current.credentialReadiness.enforce = false;
  await plugin.onConfigChanged(structuredClone(current), { companyId: 'acme' });
  assert.equal((await hook('race-flipped')).kind, 'decide');
  releaseFetch();
  await inFlight;
  assert.equal((await hook('race-after-tick')).kind, 'decide', 'a stale in-flight tick cannot re-enable enforcement');
  await tick();
  assert.equal((await hook('race-next-tick')).kind, 'decide');
});

test('readiness off keeps the all-cooling arm in the served ladder rungs', async () => {
  const d = await start([account()], null, config => {
    config.credentialReadiness.enforce = false;
  });
  await d.tick();
  const rungs = (await d.api('ladder')).body.ladders['antigravity:synthetic'].rungs;
  assert.ok(rungs.length > 0, 'off mode serves the arm on-mode refuses');
  assert.equal((await d.hook('off-mode-ladder-hook')).kind, 'decide');
});
