import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

const NOW = Date.parse('2026-10-25T00:00:00Z');
const MODEL_A = 'policy-model-a';
const MODEL_B = 'policy-model-b';
const SECRET_A = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555', version: 1 };
const SECRET_B = { type: 'secret_ref', secretId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', version: 1 };
const iso = ms => new Date(ms).toISOString();
const stateKey = (companyId, key) => JSON.stringify({
  scopeKind: 'company', scopeId: companyId, namespace: 'model-capacity', stateKey: key,
});
const sourceKey = (companyId, ref) => JSON.stringify([companyId, ref.secretId, ref.version ?? 'latest']);

function config(ref = SECRET_A) {
  return {
    enforce: true,
    credentialReadiness: { enforce: true },
    cliproxy: { laneKeySecretRef: structuredClone(ref), cacheTtlSec: 600 },
    trials: { maxInFlightPerAccount: 100 },
    pacing: { climbForSpend: true },
    armMap: [MODEL_A, MODEL_B].map(model => ({
      aaSlug: model, model, effort: 'max', family: 'sol', providers: ['partner'],
    })),
    roles: { minQuality: { doer: null, thinker: null, other: null }, outcomeGate: { enabled: false } },
  };
}

function lane(model = MODEL_A, { observedAt = NOW, expiresAt = NOW + 120000, ready = 1 } = {}) {
  return {
    observedAt: iso(observedAt), servedModels: [model],
    accounts: [{
      provider: 'partner', accountKey: 'lane-a', health: 'healthy', meter: 'reactive',
      models: [model], observedAt: iso(observedAt),
      credentialAvailability: { version: 1, models: [{
        model, provider: 'partner', accountId: 'partner:lane-a',
        servingCredentials: 1, readyCredentials: ready,
        observedAt: iso(observedAt), expiresAt: iso(expiresAt),
      }] },
    }],
  };
}

async function harness() {
  let now = NOW;
  const configs = new Map();
  const sources = new Map();
  const store = new Map();
  const jobs = new Map();
  const events = new Map();
  const requests = [];
  const writes = [];
  const agentModels = new Map();
  let agentGate = null;
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async companyId => structuredClone(configs.get(companyId)) },
    state: {
      get: async key => structuredClone(store.get(JSON.stringify(key)) ?? null),
      set: async (key, value) => {
        writes.push({ key: structuredClone(key), value: structuredClone(value) });
        store.set(JSON.stringify(key), structuredClone(value));
      },
    },
    secrets: { resolve: async (ref, context) => {
      assert.equal(context.configPath, 'cliproxy.laneKeySecretRef');
      assert.ok(configs.has(context.companyId), 'secret resolution must name a configured company');
      return sourceKey(context.companyId, ref);
    } },
    http: { fetch: async (url, options) => {
      // Only this external boundary is faked. Parsing, caching, ranking,
      // admission, publication and the resolver all execute real plugin code.
      assert.equal(options.method, 'GET');
      assert.equal(new URL(url).pathname, '/telemetry/cliproxy/live/accounts.json');
      const key = options.headers['X-Api-Key'];
      const source = sources.get(key);
      assert.ok(source, 'unexpected fixture source');
      requests.push(key);
      const body = structuredClone(source.body);
      const status = source.status;
      const gate = source.gate;
      source.gate = null;
      if (gate) {
        gate.started.resolve();
        await gate.released.promise;
      }
      return { status, json: async () => structuredClone(body) };
    } },
    agents: { get: async agentId => {
      if (agentGate && agentGate.agentId === agentId) {
        const gate = agentGate;
        agentGate = null;
        gate.started.resolve();
        await gate.released.promise;
      }
      const model = agentModels.get(agentId);
      return model ? { adapterConfig: { model } } : null;
    } },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { events.set(name, fn); } },
    logger: { info() {}, error() {}, warn() {} },
  });
  return {
    requests, writes,
    setNow: value => { now = value; },
    feed(companyId, ref, body, status = 200) {
      sources.set(sourceKey(companyId, ref), { body: structuredClone(body), status, gate: null });
    },
    gateNextFetch(companyId, ref) {
      const gate = { started: Promise.withResolvers(), released: Promise.withResolvers() };
      sources.get(sourceKey(companyId, ref)).gate = gate;
      return { started: gate.started.promise, release: gate.released.resolve };
    },
    setAgentModel: (agentId, model) => { agentModels.set(agentId, model); },
    gateNextAgentGet(agentId) {
      const gate = { agentId, started: Promise.withResolvers(), released: Promise.withResolvers() };
      agentGate = gate;
      return { started: gate.started.promise, release: gate.released.resolve };
    },
    async configure(raw, companyId = 'acme') {
      if (!configs.has(companyId)) {
        store.set(stateKey(companyId, 'aa-snapshot-v1'), {
          fetchedAt: iso(NOW), duplicateSlugs: [], rows: [MODEL_A, MODEL_B].map(slug => ({
            slug, intelligenceIndex: 70, intelligenceIndexCostPerTask: 10,
            price1mInputTokens: 1, price1mOutputTokens: 4,
          })),
        });
      }
      configs.set(companyId, structuredClone(raw));
      await plugin.onConfigChanged(structuredClone(raw), { companyId });
    },
    tick: () => jobs.get('quota-refresh')({}),
    api: async (routeKey, companyId = 'acme') => {
      const response = await plugin.onApiRequest({ companyId, routeKey });
      assert.equal(response.status, 200);
      return response.body;
    },
    hook: (runId, companyId = 'acme', agentId = 'worker-1') => plugin.onResolveRunModel({
      runId, companyId, agentId, adapterType: 'claude-code', deadlineMs: 1500,
    }),
    startRun: (runId, companyId = 'acme') => events.get('agent.run.started')({
      type: 'agent.run.started', companyId, entityId: runId,
      payload: { run: { agentId: 'worker-1', adapterType: 'claude-code' } }, occurredAt: iso(now),
    }),
  };
}

for (const [name, replacement] of [
  ['secret identity', SECRET_B],
  ['pinned secret version', { ...SECRET_A, version: 2 }],
]) {
  test(`source cache: changing ${name} at unchanged TTL replaces the routed evidence`, async () => {
    const d = await harness();
    d.feed('acme', SECRET_A, lane(MODEL_A));
    d.feed('acme', replacement, lane(MODEL_B));
    await d.configure(config());
    await d.tick();
    assert.equal((await d.hook('original-source')).model, MODEL_A);

    d.setNow(NOW + 1000);
    await d.configure(config(replacement));
    await d.tick();
    assert.equal((await d.hook('replacement-source')).model, MODEL_B,
      'a valid old cache entry cannot satisfy a different source at the same TTL');
    assert.deepEqual(d.requests, [sourceKey('acme', SECRET_A), sourceKey('acme', replacement)]);
    const ladders = (await d.api('ladder')).ladders;
    assert.deepEqual(ladders['partner:lane-a'].rungs.map(rung => rung.model), [MODEL_B]);
  });
}

test('source cache: removing the lane credential cannot reuse authorized old evidence', async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  await d.configure(config());
  await d.tick();
  assert.equal((await d.hook('authorized-source')).kind, 'decide');

  const revoked = config();
  delete revoked.cliproxy.laneKeySecretRef;
  await d.configure(revoked);
  await d.tick();
  assert.equal((await d.hook('revoked-source')).kind, 'defer');
  assert.deepEqual((await d.api('capacity')).accounts, []);
  assert.equal(d.requests.length, 1, 'no fetch is allowed without a configured secret reference');
});

for (const status of [401, 403]) {
  test(`source invalidation cannot fall back to prior authorization after HTTP ${status}`, async () => {
    const d = await harness();
    d.feed('acme', SECRET_A, lane());
    d.feed('acme', SECRET_B, lane(), status);
    await d.configure(config());
    await d.tick();
    assert.equal((await d.hook('before-access-denied')).kind, 'decide');

    await d.configure(config(SECRET_B));
    // The existing scheduled-job API may surface fetch failure as an error.
    // Regardless of reporting style, denied evidence cannot authorize a run.
    await d.tick().catch(error => assert.equal(error.message, 'quota-refresh-failed'));
    assert.equal((await d.hook('after-access-denied')).kind, 'defer');
    assert.equal(d.requests.at(-1), sourceKey('acme', SECRET_B));
  });
}

test('policy cache: a same-TTL config change cannot leave the prior admission policy live', async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  await d.configure(config());
  await d.tick();
  assert.equal((await d.hook('before-policy-change')).kind, 'decide');

  const changed = config();
  changed.trials.maxInFlightPerAccount = 1;
  await d.configure(changed);
  // The first hook already occupies the only newly authorized slot.
  // Neither an old policy view nor a cache hit can admit a second run.
  const betweenTicks = await d.hook('after-policy-change');
  await d.startRun('event-after-policy-change');
  await d.tick();
  assert.deepEqual({
    betweenTicks: betweenTicks.kind,
    afterTick: (await d.hook('after-policy-tick')).kind,
    eventDecided: (await d.api('shadow')).entries.some(row => row.runId === 'event-after-policy-change'),
  }, { betweenTicks: 'defer', afterTick: 'defer', eventDecided: false });
});

test('source cache: late fetch completion cannot publish or seed a replaced source generation', { timeout: 5000 }, async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane(MODEL_A));
  d.feed('acme', SECRET_B, lane(MODEL_B));
  const original = config();
  original.cliproxy.cacheTtlSec = 5;
  await d.configure(original);
  await d.tick();
  assert.equal((await d.hook('warm-original-source')).model, MODEL_A);
  d.setNow(NOW + 6000);
  const writeStart = d.writes.length;
  const gate = d.gateNextFetch('acme', SECRET_A);
  const pending = d.tick();
  try {
    await gate.started;
    const replacement = config(SECRET_B);
    replacement.cliproxy.cacheTtlSec = 5;
    await d.configure(replacement);
  } finally {
    gate.release();
    await pending;
  }
  const afterLateFetch = await d.hook('late-old-source');
  await d.startRun('late-old-source-event');
  const staleWrites = d.writes.slice(writeStart).filter(write => {
    if (write.key.stateKey === 'capacity-v1') {
      return write.value.accounts.some(account => account.models.includes(MODEL_A));
    }
    if (write.key.stateKey === 'ladder-v1') {
      return Object.values(write.value.ladders).some(ladder => ladder.rungs.some(rung => rung.model === MODEL_A));
    }
    return false;
  });
  await d.tick();
  const current = await d.hook('current-source');
  const event = (await d.api('shadow')).entries.find(row => row.runId === 'late-old-source-event');
  assert.deepEqual({
    lateAdmissionSafe: afterLateFetch.kind === 'defer'
      || (afterLateFetch.kind === 'decide' && afterLateFetch.model === MODEL_B),
    lateEventUsedOldSource: event?.eventTime === true && event.wouldModel.startsWith(MODEL_A),
    stalePublicationCount: staleWrites.length,
    currentModel: current.model,
  }, {
    lateAdmissionSafe: true, lateEventUsedOldSource: false, stalePublicationCount: 0, currentModel: MODEL_B,
  }, 'an invalid generation must not publish to memory, reports, or the source cache');
});

test('policy cache: a config change during fetch cannot republish the old admission budget', { timeout: 5000 }, async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  const original = config();
  original.cliproxy.cacheTtlSec = 5;
  await d.configure(original);
  await d.tick();
  assert.equal((await d.hook('occupies-new-budget')).kind, 'decide');
  d.setNow(NOW + 6000);
  const gate = d.gateNextFetch('acme', SECRET_A);
  const pending = d.tick();
  try {
    await gate.started;
    const changed = structuredClone(original);
    changed.trials.maxInFlightPerAccount = 1;
    await d.configure(changed);
  } finally {
    gate.release();
    await pending;
  }
  const afterLateFetch = await d.hook('late-old-policy');
  await d.startRun('late-old-policy-event');
  await d.tick();
  assert.deepEqual({
    lateDecision: afterLateFetch.kind,
    eventDecided: (await d.api('shadow')).entries.some(row => row.runId === 'late-old-policy-event'),
    currentDecision: (await d.hook('current-policy')).kind,
  }, { lateDecision: 'defer', eventDecided: false, currentDecision: 'defer' });
});

test('source cache stays company-scoped even for the same secret reference and run identity', async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane(MODEL_A));
  d.feed('beta', SECRET_A, lane(MODEL_B));
  await d.configure(config(), 'acme');
  await d.configure(config(), 'beta');
  await d.tick();
  assert.equal((await d.hook('same-run-id', 'acme')).model, MODEL_A);
  assert.equal((await d.hook('same-run-id', 'beta')).model, MODEL_B);
  d.setNow(NOW + 1000);
  await d.tick();
  assert.equal((await d.hook('cached-acme', 'acme')).model, MODEL_A);
  assert.equal((await d.hook('cached-beta', 'beta')).model, MODEL_B);
  assert.equal(d.requests.length, 2);
  assert.deepEqual((await d.api('ladder', 'acme')).ladders['partner:lane-a'].rungs.map(row => row.model), [MODEL_A]);
  assert.deepEqual((await d.api('ladder', 'beta')).ladders['partner:lane-a'].rungs.map(row => row.model), [MODEL_B]);
});

test('invalidating one company policy cannot invalidate or change its sibling source and budget', async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane(MODEL_A));
  d.feed('beta', SECRET_A, lane(MODEL_B));
  await d.configure(config(), 'acme');
  await d.configure(config(), 'beta');
  await d.tick();
  assert.equal((await d.hook('occupies-acme-slot', 'acme')).model, MODEL_A);

  d.setNow(NOW + 1000);
  const changed = config();
  changed.trials.maxInFlightPerAccount = 1;
  await d.configure(changed, 'acme');
  assert.equal((await d.hook('unaffected-company', 'beta')).model, MODEL_B);
  await d.tick();
  assert.equal((await d.hook('changed-company', 'acme')).kind, 'defer');
  assert.equal((await d.hook('still-unaffected', 'beta')).model, MODEL_B);
  assert.equal(d.requests.filter(key => key === sourceKey('beta', SECRET_A)).length, 1,
    'another company config change must not invalidate this company source');
});

test('cache hits retain producer observation and expiry instead of renewing readiness', async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane(MODEL_A, { expiresAt: NOW + 1000 }));
  await d.configure(config());
  await d.tick();
  d.setNow(NOW + 999);
  await d.tick();
  assert.equal((await d.hook('before-producer-expiry')).kind, 'decide');
  const evidence = (await d.api('ladder')).ladders['partner:lane-a'].rungs[0].credentialEvidence;
  assert.equal(evidence.observedAtMs, NOW);
  assert.equal(evidence.expiresAtMs, NOW + 1000);

  d.setNow(NOW + 1000);
  assert.equal((await d.hook('at-producer-expiry')).kind, 'defer');
  await d.startRun('expired-between-ticks');
  await d.tick();
  assert.ok(!(await d.api('shadow')).entries.some(row => row.runId === 'expired-between-ticks'));
  assert.equal((await d.hook('after-cached-expiry-tick')).kind, 'defer');
  assert.equal((await d.api('capacity')).credentialAvailability.countsByReason.expired, 1);
  assert.equal(d.requests.length, 1, 'expiry is evaluated on cached evidence without manufacturing a fresh read');
});

test('cache hits cannot extend the maximum evidence age despite a far-future producer expiry', async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane(MODEL_A, { expiresAt: NOW + 86400000 }));
  await d.configure(config());
  await d.tick();
  d.setNow(NOW + 119999);
  await d.tick();
  assert.equal((await d.hook('before-max-evidence-age')).kind, 'decide');
  d.setNow(NOW + 120000);
  assert.equal((await d.hook('at-max-evidence-age')).kind, 'defer');
  await d.tick();
  assert.equal((await d.hook('cached-max-evidence-age')).kind, 'defer');
  assert.equal((await d.api('capacity')).credentialAvailability.countsByReason.expired, 1);
  assert.equal(d.requests.length, 1);
});

for (const [name, invalidateEvidence] of [
  ['missing', body => { delete body.accounts[0].credentialAvailability; }],
  ['all cooling', body => { body.accounts[0].credentialAvailability.models[0].readyCredentials = 0; }],
  ['expired', body => { body.accounts[0].credentialAvailability.models[0].expiresAt = iso(NOW + 500); }],
  ['future-dated', body => { body.accounts[0].credentialAvailability.models[0].observedAt = iso(NOW + 2000); }],
  ['malformed', body => { body.accounts[0].credentialAvailability.models[0].readyCredentials = '1'; }],
]) {
  test(`cache invalidation cannot restore admission from ${name} replacement evidence`, async () => {
    const d = await harness();
    d.feed('acme', SECRET_A, lane());
    const replacement = lane();
    invalidateEvidence(replacement);
    d.feed('acme', SECRET_B, replacement);
    await d.configure(config());
    await d.tick();
    assert.equal((await d.hook('original-fresh-evidence')).kind, 'decide');

    d.setNow(NOW + 1000);
    await d.configure(config(SECRET_B));
    await d.tick();
    const result = await d.hook('no-fresh-replacement-evidence');
    await d.startRun('no-fresh-replacement-event');
    await d.tick();
    assert.deepEqual({
      hook: result.kind,
      eventDecided: (await d.api('shadow')).entries.some(row => row.runId === 'no-fresh-replacement-event'),
      alarm: (await d.api('capacity')).credentialAvailability.alarm,
    }, { hook: 'defer', eventDecided: false, alarm: true });
  });
}

// Fence pins: each test below parks or yields at one specific invalidation
// guard so that deleting that guard alone turns the test red, even though
// the neighbouring guards return the same outward answer.
const INVALIDATED = {
  kind: 'defer', retryAfterMs: 60000,
  reason: 'routing snapshot invalidated by configuration change',
};
const decidedRunIds = async d => (await d.api('shadow')).entries.map(row => row.runId);

test('policy cache: an equivalent re-save with reordered passthrough keys does not invalidate the live view', async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  await d.configure(config());
  await d.tick();
  assert.equal((await d.hook('before-resave')).kind, 'decide');

  // Same values, different key order in the objects config resolution
  // passes through untouched (the secret reference and the arm entries).
  const reordered = config();
  reordered.cliproxy.laneKeySecretRef = {
    version: SECRET_A.version, secretId: SECRET_A.secretId, type: SECRET_A.type,
  };
  reordered.armMap = reordered.armMap.map(entry => ({
    providers: entry.providers, family: entry.family, effort: entry.effort,
    model: entry.model, aaSlug: entry.aaSlug,
  }));
  await d.configure(reordered);
  assert.equal((await d.hook('after-resave')).kind, 'decide',
    'key order alone must not retire the published view');
  await d.tick();
  assert.equal((await d.hook('after-resave-tick')).kind, 'decide');
  assert.equal(d.requests.length, 1,
    'key order alone must not drop the cached source evidence');
});

test('policy cache: a policy-only change while the resolver joins the ledger defers without recording', { timeout: 5000 }, async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  await d.configure(config());
  await d.tick();
  assert.equal((await d.hook('warm-resolver')).kind, 'decide');

  // Policy-only change (enforce stays on, the live budget would still
  // admit): only the post-ledger currency fence can stop this run.
  const changed = config();
  changed.trials.maxInFlightPerAccount = 99;
  let configuring;
  const pending = d.hook('resolver-policy-race');
  // Land the change after the hook passed its early fences and is parked
  // on the ledger join: the hook's first continuation runs before this
  // microtask, the ledger continuation runs after it.
  queueMicrotask(() => { configuring = d.configure(changed); });
  const result = await pending;
  await configuring;
  assert.deepEqual(result, INVALIDATED);
  await d.tick();
  assert.ok(!(await decidedRunIds(d)).includes('resolver-policy-race'),
    'a resolve invalidated at the ledger join records no decision');
});

test('policy cache: a policy change while reviewer routing joins the ledger defers without recording', { timeout: 5000 }, async () => {
  const reviewerConfig = () => {
    const raw = config();
    raw.roles.keepAgentIds = ['reviewer-1'];
    raw.reviewerRouting = {
      agentIds: ['reviewer-1'],
      arms: [{ provider: 'partner', model: MODEL_A, effort: 'max' }],
    };
    return raw;
  };
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  await d.configure(reviewerConfig());
  await d.tick();
  assert.equal((await d.hook('warm-reviewer', 'acme', 'reviewer-1')).kind, 'decide',
    'the reviewer arm must route before the race, or the pin proves nothing');
  await d.tick();
  assert.ok((await decidedRunIds(d)).includes('warm-reviewer'));

  // The reviewer path yields on its ledger join before it records. The
  // configure call below applies synchronously (before that continuation
  // runs), so only the reviewer-route currency fence can stop the record;
  // the outer hook fence would return the same defer either way.
  const changed = reviewerConfig();
  changed.trials.maxInFlightPerAccount = 99;
  const pending = d.hook('reviewer-policy-race', 'acme', 'reviewer-1');
  await d.configure(changed);
  const result = await pending;
  assert.deepEqual(result, INVALIDATED);
  await d.tick();
  assert.ok(!(await decidedRunIds(d)).includes('reviewer-policy-race'),
    'a reviewer route invalidated at its ledger join records no decision');
});

test('policy cache: a policy change while a kept decision joins the ledger records nothing', { timeout: 5000 }, async () => {
  const keptConfig = keepAgentIds => {
    const raw = config();
    raw.roles.keepAgentIds = keepAgentIds;
    return raw;
  };
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  d.setAgentModel('kept-1', MODEL_A);
  await d.configure(keptConfig(['kept-1']));
  await d.tick();
  assert.equal((await d.hook('warm-kept', 'acme', 'kept-1')).kind, 'keep');
  await d.tick();
  assert.ok((await decidedRunIds(d)).includes('warm-kept'),
    'a kept run must record before the race, or the pin proves nothing');

  // Land the change after the hook passed its early fences and entered
  // the kept branch, while the kept recording is parked on its ledger
  // join: the hook's first continuation runs before this microtask, the
  // kept-recording continuation runs after it. The outer hook fence
  // returns the same defer either way; only the kept fence stops the
  // ledger record.
  let configuring;
  const pending = d.hook('kept-policy-race', 'acme', 'kept-1');
  queueMicrotask(() => { configuring = d.configure(keptConfig([])); });
  const result = await pending;
  await configuring;
  assert.deepEqual(result, INVALIDATED);
  await d.tick();
  assert.ok(!(await decidedRunIds(d)).includes('kept-policy-race'),
    'a kept decision invalidated at its ledger join records nothing');
});

test('policy cache: a policy change parked in kept-agent resolution cannot publish the old live view', { timeout: 5000 }, async () => {
  const d = await harness();
  d.feed('acme', SECRET_A, lane());
  const original = config();
  original.roles.keepAgentIds = ['kept-1'];
  await d.configure(original);
  await d.tick();
  assert.equal((await d.hook('occupies-new-budget')).kind, 'decide');

  // Park the tick in the kept-agent model resolution that runs after
  // every earlier superseded check and before the live view publishes.
  // Changing policy in that window leaves only the pre-publish fence
  // between the old-policy view and the hook.
  const gate = d.gateNextAgentGet('kept-1');
  const pending = d.tick();
  try {
    await gate.started;
    const changed = structuredClone(original);
    changed.trials.maxInFlightPerAccount = 1;
    await d.configure(changed);
  } finally {
    gate.release();
    await pending;
  }
  assert.equal((await d.hook('after-parked-tick')).kind, 'defer',
    'no live view built from the old policy may decide after the change');
  await d.startRun('after-parked-tick-event');
  await d.tick();
  assert.ok(!(await decidedRunIds(d)).includes('after-parked-tick-event'),
    'the event path must not decide from the unpublished old view either');
});
