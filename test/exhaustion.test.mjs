import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createModelCapacityPlugin,
  validateConfigShape,
  resolveConfig,
  EXHAUSTION_HOST_ATTEMPTS,
  EXHAUSTION_DEFAULT_FINAL_ATTEMPT,
} from '../src/plugin.mjs';
import { MODEL_ROUTING_ENV_KEYS } from '../src/manifest.mjs';
import { REVIEW_RESERVE_STATE_KEY } from '../src/reviewreserve.mjs';

// Deferral-exhaustion (Design B): the host clamps a plugin defer to 60s and
// allows RUN_MODEL_RESOLVE_MAX_ATTEMPTS=12 retries per chain (each retry is a
// NEW runId), so the per-runId deferredRuns marks can never detect the end of
// the chain. This suite drives the hook end to end: a per-issue+agent streak
// survives new runIds, attempts 1-10 still defer, and from attempt 11 the hook
// answers with the cheapest selectable free-overflow arm (NIM first) under
// the existing trial caps, else a bounded keep -- while metered-ahead pools
// are never selected.

const NOW = Date.parse('2026-10-26T04:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const NIM_BARE = 'step-5-preview-nim';
const NIM_ALIAS = 'nvidia-nim/step-5-preview-nim';
const OSS_MODEL = 'gpt-oss-120b';
const HAIKU = 'claude-haiku-5-5';
const MUSE = 'muse-spark-1.3-contributor';

const aaRows = () => ([
  { slug: 'step-5', intelligenceIndex: 72, intelligenceIndexCostPerTask: 9, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gpt-oss-120b', intelligenceIndex: 60, intelligenceIndexCostPerTask: 12, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'muse-spark-1-3', intelligenceIndex: 58, intelligenceIndexCostPerTask: 15, price1mInputTokens: 2, price1mOutputTokens: 8 },
]);

const RESET_WEEK = new Date(NOW + 7 * 24 * 3600 * 1000).toISOString();
const RESET_5H = new Date(NOW + 4 * 3600 * 1000).toISOString();
const OBS = new Date(NOW).toISOString();

const acct = (o) => ({
  observedAt: OBS,
  weekly: { used: o.weekly ?? null, resetsAt: o.weekly == null ? null : RESET_WEEK },
  fiveHour: { used: o.fiveHour ?? null, resetsAt: o.fiveHour == null ? null : RESET_5H },
  quality: 'live',
  ...o,
});

// Metered, far ahead of plan with no headroom: never selectable normally, and
// never selectable by the exhaustion path either (ahead-of-plan exclusion).
const claudeAhead = () => acct({
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  models: [HAIKU], weekly: 0.99, fiveHour: 0.99,
});
// Weekly-far-ahead (pace cap 1) but with 5h headroom: the reviewer admits
// the first run, then the pace guard holds the lane for the rest of the
// chain -- the reviewer strand shape. NOTE: object (not number) meter
// windows -- the acct() helper's number spread reads as unknown headroom;
// the reviewer admission needs real headroom here.
const claudeReviewerPaced = () => ({
  observedAt: OBS,
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  quality: 'live', models: [HAIKU],
  weekly: { used: 0.99, resetsAt: RESET_WEEK },
  fiveHour: { used: 0.1, resetsAt: RESET_5H },
});
// Object-shape metered-ahead lanes (known headroom, genuinely ahead of
// plan): the only applicable exhaustion skip for these is the ahead-of-plan
// exclusion, so selecting NIM here proves that path rather than the
// unknown-headroom rule the number-shape acct() fixtures exercise.
const claudeAheadKnown = () => ({
  observedAt: OBS,
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  quality: 'live', models: [HAIKU],
  weekly: { used: 0.99, resetsAt: RESET_WEEK },
  fiveHour: { used: 0.99, resetsAt: RESET_5H },
});
const metaAheadKnown = () => ({
  observedAt: OBS,
  lane: 'meta-1', provider: 'meta', accountKey: 'm1', health: 'healthy',
  quality: 'live', models: [MUSE],
  weekly: { used: 0.99, resetsAt: RESET_WEEK },
  fiveHour: { used: 0.99, resetsAt: RESET_5H },
});
const metaAhead = () => acct({
  lane: 'meta-1', provider: 'meta', accountKey: 'm1', health: 'healthy',
  models: [MUSE], weekly: 0.99, fiveHour: 0.99,
});
// Reactive free-overflow trial arm. Health varies per test: healthy means the
// normal path routes it at once (no deferrals); degraded drops it from the
// normal order while the exhaustion path still admits it.
const nimTrial = (over = {}) => acct({
  lane: 'nvidia-nim-lane-1', provider: 'nvidia-nim', accountKey: 'n1',
  health: 'healthy', meter: 'reactive', quality: 'reactive', plan: 'free',
  models: [NIM_ALIAS], weekly: null, fiveHour: null, ...over,
});
const agTrial = (over = {}) => acct({
  lane: 'ag-1', provider: 'antigravity', accountKey: 'g1',
  health: 'healthy', meter: 'reactive', quality: 'reactive',
  models: [OSS_MODEL], weekly: null, fiveHour: null, ...over,
});

const baseConfig = (extra = {}) => ({
  enforce: true,
  cliproxy: { laneKeySecretRef: SECRET },
  roles: { minQuality: { doer: null, other: null, thinker: null } },
  modelAaOverrides: { [NIM_BARE]: { slug: 'step-5', effort: 'max' } },
  placement: { freeCostProviders: ['nvidia-nim'] },
  trials: {
    maxInFlightPerAccount: 2, maxInFlightPerFamily: 2,
    maxInFlightPerAccountByProvider: { 'nvidia-nim': 3 },
  },
  reviewReserve: { enabled: false },
  pacing: { guard: { enabled: true } },
  exhaustion: { enabled: true },
  ...extra,
});

function drive({ accounts, config = {}, nowMs = NOW }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const key = (k) => JSON.stringify(k);
  let now = nowMs;
  let laneAccounts = accounts;
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: { get: async (k) => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          observedAt: new Date(now).toISOString(),
          servedModels: [NIM_ALIAS, OSS_MODEL, HAIKU, MUSE],
          accounts: laneAccounts,
        }),
      }),
    },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {}, warn() {} },
  };
  return {
    setup: async () => {
      await plugin.setup(io);
      store.set(
        key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
        { fetchedAt: new Date(NOW).toISOString(), rows: aaRows(), duplicateSlugs: [] },
      );
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: async (at = now) => { now = at; await jobs.get('shadow-tick')({ companyId: 'acme' }); },
    setNow: (ms) => { now = ms; },
    setAccounts: (next) => { laneAccounts = next; },
    seed: (stateKey, value) => { store.set(key(stateKey), value); },
    fire: (e) => handlers.get(e.type)(e),
    api: async (routeKey) => (await plugin.onApiRequest({ companyId: 'acme', routeKey })).body,
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
      issueId: 'iss-1', agentDefaultModel: HAIKU, deadlineMs: 1500, ...extra,
    }),
    shadow: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' })).body.entries,
    killIo: () => {
      for (const k of ['config', 'state', 'secrets', 'http', 'agents', 'issues']) {
        io[k] = new Proxy({}, { get: () => { throw new Error(`io-forbidden:${k}`); } });
      }
    },
  };
}

test('exhaustion constants mirror the host budget; config defaults off with attempt 11', () => {
  assert.equal(EXHAUSTION_HOST_ATTEMPTS, 12);
  assert.equal(EXHAUSTION_DEFAULT_FINAL_ATTEMPT, 11);
  assert.deepEqual(resolveConfig({}).exhaustion, { enabled: false, finalAnswerFromAttempt: 11 });
  assert.deepEqual(resolveConfig({ exhaustion: { enabled: true } }).exhaustion,
    { enabled: true, finalAnswerFromAttempt: 11 });
  assert.deepEqual(resolveConfig({ exhaustion: { enabled: true, finalAnswerFromAttempt: 12 } }).exhaustion,
    { enabled: true, finalAnswerFromAttempt: 12 });
  assert.deepEqual(validateConfigShape({ exhaustion: { enabled: true } }), []);
  assert.deepEqual(validateConfigShape({ exhaustion: { enabled: false, finalAnswerFromAttempt: 1 } }), []);
  assert.ok(validateConfigShape({ exhaustion: 'yes' }).some(e => e.includes('exhaustion must be an object')));
  assert.ok(validateConfigShape({ exhaustion: { enabled: 'yes' } }).some(e => e.includes('exhaustion.enabled must be a boolean')));
  assert.ok(validateConfigShape({ exhaustion: { enabled: true, finalAnswerFromAttempt: 0 } })
    .some(e => e.includes('exhaustion.finalAnswerFromAttempt must be an integer in [1, 12]')));
  assert.ok(validateConfigShape({ exhaustion: { enabled: true, finalAnswerFromAttempt: 13 } })
    .some(e => e.includes('exhaustion.finalAnswerFromAttempt must be an integer in [1, 12]')));
  assert.ok(validateConfigShape({ exhaustion: { enabled: true, finalAnswerFromAttempt: 2.5 } })
    .some(e => e.includes('exhaustion.finalAnswerFromAttempt must be an integer in [1, 12]')));
});

test('exhaustion is documented in the manifest schema and the example validates', async () => {
  const { manifest } = await import('../src/manifest.mjs');
  const schema = manifest.instanceConfigSchema.properties.exhaustion;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.enabled.type, 'boolean');
  assert.equal(schema.properties.enabled.default, false);
  assert.equal(schema.properties.finalAnswerFromAttempt.default, 11);
  const { readFile } = await import('node:fs/promises');
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url)));
  for (const k of Object.keys(example.exhaustion ?? {})) {
    assert.ok(k in schema.properties, `config.example.json exhaustion key ${k} rejected by the schema`);
  }
  assert.deepEqual(validateConfigShape({ exhaustion: example.exhaustion ?? {} }), []);
});

test('flag off reproduces today byte-for-byte across the whole chain', async () => {
  const accounts = [claudeAhead(), metaAhead(), nimTrial({ health: 'degraded' }), agTrial({ health: 'degraded' })];
  const runAll = async (config) => {
    const d = drive({ accounts, config });
    await d.setup();
    await d.tick();
    d.killIo();
    const outs = [];
    for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-off-${i}`));
    return outs;
  };
  const implicit = await runAll(baseConfig({ exhaustion: undefined }));
  const explicit = await runAll(baseConfig({ exhaustion: { enabled: false } }));
  assert.equal(implicit.length, 12);
  for (const out of [...implicit, ...explicit]) {
    assert.equal(out.kind, 'defer');
    assert.equal(out.retryAfterMs, 60000);
    assert.equal(out.reason, 'no account has headroom right now');
  }
  assert.deepEqual(explicit, implicit);
});

test('streak survives new runIds: attempts 1-10 defer, 11-12 decide NIM', async () => {
  const d = drive({ accounts: [claudeAhead(), metaAhead(), nimTrial({ health: 'degraded' }), agTrial({ health: 'degraded' })], config: baseConfig() });
  await d.setup();
  await d.tick();
  d.killIo();
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-x-${i}`));
  for (let i = 0; i < 10; i++) {
    assert.equal(outs[i].kind, 'defer', `attempt ${i + 1} defers`);
    assert.equal(outs[i].reason, 'no account has headroom right now');
  }
  for (const i of [10, 11]) {
    const out = outs[i];
    assert.equal(out.kind, 'decide', `attempt ${i + 1} answers`);
    assert.match(out.decisionId, /^mc-run-x-(11|12)-nvidia-nim-n1-/);
    assert.ok(String(out.model).startsWith(NIM_ALIAS), `NIM alias, got ${out.model}`);
    assert.match(out.reason, /^deferral-exhausted: no account has headroom right now -> /);
    assert.equal(out.source, 'model-capacity');
    for (const k of Object.keys(out.env ?? {})) {
      assert.ok(MODEL_ROUTING_ENV_KEYS.includes(k), `undeclared env key ${k}`);
    }
  }
  // No decision in the whole chain ever names a metered-ahead pool.
  for (const out of outs) {
    if (out.kind !== 'decide') continue;
    assert.ok(!String(out.decisionId).includes('claude-a1'), `claude selected: ${out.decisionId}`);
    assert.ok(!String(out.decisionId).includes('meta-m1'), `meta selected: ${out.decisionId}`);
  }
});

test('NIM at cap falls through to the next selectable free/trial arm', async () => {
  const d = drive({ accounts: [claudeAhead(), metaAhead(), nimTrial(), agTrial({ health: 'degraded' })], config: baseConfig() });
  await d.setup();
  await d.tick();
  d.killIo();
  // Two healthy NIM trial decisions consume the whole step-family budget
  // (family cap 2 < per-account cap 3), so the chain below cannot take NIM.
  const seed1 = await d.hook('run-seed-1', { agentId: 'agent-A', issueId: 'iss-A' });
  const seed2 = await d.hook('run-seed-2', { agentId: 'agent-B', issueId: 'iss-B' });
  for (const s of [seed1, seed2]) {
    assert.equal(s.kind, 'decide');
    assert.match(s.decisionId, /-nvidia-nim-n1-/);
  }
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-y-${i}`));
  for (let i = 0; i < 10; i++) assert.equal(outs[i].kind, 'defer', `attempt ${i + 1} defers`);
  for (const i of [10, 11]) {
    const out = outs[i];
    assert.equal(out.kind, 'decide', `attempt ${i + 1} answers`);
    assert.match(out.decisionId, /-antigravity-g1-/, `falls through to antigravity, got ${out.decisionId}`);
    assert.match(out.reason, /^deferral-exhausted: no account has headroom right now -> /);
  }
});

test('thinker without a trial role cannot take trial arms: bounded keep with a ledger entry', async () => {
  const d = drive({
    accounts: [claudeAhead(), nimTrial(), agTrial({ health: 'degraded' })],
    config: baseConfig({ roles: { thinkerAgentIds: ['agent-9'], minQuality: { doer: null, other: null, thinker: null } } }),
  });
  await d.setup();
  await d.tick();
  // No killIo here: the keeps below are asserted in the persisted ring, so
  // the closing tick needs I/O. (Memory-only hook input is proven by the
  // killIo'd tests above.)
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-t-${i}`));
  for (let i = 0; i < 10; i++) assert.equal(outs[i].kind, 'defer', `attempt ${i + 1} defers`);
  for (const i of [10, 11]) {
    assert.deepEqual(outs[i], { kind: 'keep' }, `attempt ${i + 1} keeps (bounded, default pool not exhausted)`);
  }
  await d.tick();
  const entries = await d.shadow();
  const kept = entries.find(e => e.runId === 'run-t-11');
  assert.ok(kept, 'exhaustion keep lands in the ledger so pace counts it in flight');
  assert.equal(kept.enforced, false);
  assert.equal(kept.accountId, 'claude:a1');
  assert.match(kept.reason, /^deferral-exhausted: /);
});

test('keep denied when the default pool is exhausted: keep deferring with skip reasons', async () => {
  const spent = claudeAhead();
  spent.health = 'exhausted';
  const d = drive({ accounts: [spent], config: baseConfig() });
  await d.setup();
  await d.tick();
  d.killIo();
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-z-${i}`));
  for (let i = 0; i < 10; i++) {
    assert.equal(outs[i].kind, 'defer', `attempt ${i + 1} defers`);
    assert.equal(outs[i].reason, 'no account has headroom right now');
  }
  for (const i of [10, 11]) {
    const out = outs[i];
    assert.equal(out.kind, 'defer', `attempt ${i + 1} still defers (strand rather than burn an exhausted pool)`);
    assert.ok(out.reason.startsWith('no account has headroom right now; exhaustion scan: '), `skip reasons appended, got ${out.reason}`);
    assert.match(out.reason, /exhausted/);
  }
});

test('streak is keyed by issue+agent: parallel chains count separately', async () => {
  const d = drive({ accounts: [claudeAhead(), nimTrial({ health: 'degraded' }), agTrial({ health: 'degraded' })], config: baseConfig() });
  await d.setup();
  await d.tick();
  d.killIo();
  const outsA = [];
  const outsB = [];
  for (let i = 1; i <= 10; i++) {
    outsA.push(await d.hook(`run-a-${i}`, { issueId: 'iss-A' }));
    outsB.push(await d.hook(`run-b-${i}`, { issueId: 'iss-B' }));
  }
  assert.ok(outsA.every(o => o.kind === 'defer') && outsB.every(o => o.kind === 'defer'));
  // Ten more interleaved deferrals would answer a shared streak; keyed
  // streaks need one more per chain.
  const a11 = await d.hook('run-a-11', { issueId: 'iss-A' });
  assert.equal(a11.kind, 'decide', 'chain A answers on its own 11th attempt');
  const b11 = await d.hook('run-b-11', { issueId: 'iss-B' });
  assert.equal(b11.kind, 'decide', 'chain B answers on its own 11th attempt');
});

test('a normal decide clears the streak: post-recovery deferrals count from one', async () => {
  const healthy = [claudeAhead(), nimTrial(), agTrial({ health: 'degraded' })];
  const degraded = [claudeAhead(), nimTrial({ health: 'degraded' }), agTrial({ health: 'degraded' })];
  const T0 = NOW;
  const d = drive({ accounts: degraded, config: baseConfig(), nowMs: T0 });
  await d.setup();
  await d.tick(T0);
  for (let i = 1; i <= 5; i++) assert.equal((await d.hook(`run-c-${i}`)).kind, 'defer');
  // Recovery: NIM healthy again, so the hook routes normally (and clears).
  // Clock advances past the lane cache TTL so the tick re-reads the feed.
  d.setAccounts(healthy);
  await d.tick(T0 + 60000);
  const routed = await d.hook('run-c-6');
  assert.equal(routed.kind, 'decide');
  assert.match(routed.decisionId, /-nvidia-nim-n1-/);
  // Stranded again: five deferrals must NOT answer (without the clear the
  // 11th deferral overall would).
  d.setAccounts(degraded);
  await d.tick(T0 + 120000);
  for (let i = 7; i <= 12; i++) assert.equal((await d.hook(`run-c-${i}`)).kind, 'defer', `post-recovery deferral ${i - 6} of 6 defers`);
});

test('reviewer pace-hold defers then answers from the final attempt (reviewer parity)', async () => {
  // The reviewer pace-hold defer is a fourth strand shape: without the
  // exhaustion scan it bumps the streak forever and never answers. Claude
  // 99% spent has a pace cap of 1, so the first review routes (filling the
  // cap through the ledger) and the rest of the chain waits.
  const config = baseConfig({
    reviewerRouting: { agentIds: ['agent-R'], arms: [{ provider: 'claude', model: HAIKU }] },
  });
  const d = drive({ accounts: [claudeReviewerPaced(), nimTrial({ health: 'degraded' })], config });
  await d.setup();
  await d.tick();
  d.killIo();
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-r-${i}`, { agentId: 'agent-R', issueId: 'iss-R' }));
  assert.equal(outs[0].kind, 'decide', 'first review routes and fills the pace cap');
  assert.match(outs[0].reason, /on claude:a1/);
  for (let i = 1; i <= 10; i++) {
    assert.equal(outs[i].kind, 'defer', `reviewer attempt ${i + 1} defers`);
    assert.match(outs[i].reason, /pace guard: reviewer lanes held/, 'reviewer pace-hold reason');
  }
  const last = outs[11];
  assert.equal(last.kind, 'decide', 'reviewer attempt 12 answers instead of stranding');
  assert.match(last.decisionId, /-nvidia-nim-n1-/, 'falls through to the NIM free-overflow arm');
  assert.match(last.reason, /^deferral-exhausted: pace guard: reviewer lanes held .* -> /);
  for (const k of Object.keys(last.env ?? {})) {
    assert.ok(MODEL_ROUTING_ENV_KEYS.includes(k), `undeclared env key ${k}`);
  }
  // No exhaustion answer ever names the ahead-of-plan Claude pool (outs[0]
  // is the cap-filling first review, which legitimately routes Claude).
  for (const out of outs.slice(1)) {
    if (out.kind !== 'decide') continue;
    assert.ok(!String(out.decisionId).includes('claude-a1'), `claude selected: ${out.decisionId}`);
  }
});

test('reviewer pace-hold with flag off defers through attempt 12 (no exhaustion answer)', async () => {
  const config = baseConfig({
    exhaustion: { enabled: false },
    reviewerRouting: { agentIds: ['agent-R'], arms: [{ provider: 'claude', model: HAIKU }] },
  });
  const d = drive({ accounts: [claudeReviewerPaced(), nimTrial({ health: 'degraded' })], config });
  await d.setup();
  await d.tick();
  d.killIo();
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-roff-${i}`, { agentId: 'agent-R', issueId: 'iss-R' }));
  assert.equal(outs[0].kind, 'decide');
  for (let i = 1; i <= 11; i++) {
    assert.equal(outs[i].kind, 'defer', `reviewer attempt ${i + 1} still defers with the flag off`);
    assert.match(outs[i].reason, /pace guard: reviewer lanes held/);
    assert.doesNotMatch(outs[i].reason, /exhaustion scan/);
  }
});

test('exhaustion keep never spends the review reserve: held-only default defers with skips', async () => {
  // The review reserve holds claude:a1 for review runs; agent-9 is not a
  // review agent and its default (HAIKU) serves only from the held account.
  // The keep fallback must strand rather than spend held quota.
  const HOUR = 3600 * 1000;
  const T0 = NOW;
  const hourStart = (ms) => Math.floor(ms / HOUR) * HOUR;
  const lane = () => ({
    lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
    weekly: { used: 0.5, resetsAt: new Date(T0 + 40 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(T0 + 4 * HOUR).toISOString() },
    observedAt: new Date(T0).toISOString(), quality: 'live',
    models: [HAIKU],
  });
  const d = drive({
    accounts: [lane()],
    config: baseConfig({
      roles: { keepAgentIds: ['reviewer-1'], minQuality: { doer: null, other: null, thinker: null } },
      reviewReserve: { agentIds: ['reviewer-2'] },
    }),
    nowMs: T0,
  });
  await d.setup();
  d.seed(
    { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: REVIEW_RESERVE_STATE_KEY },
    {
      buckets: [
        { atMs: hourStart(T0) - 2 * HOUR, burn: { 'claude:a1': 2.0 }, runs: { 'claude:a1': 10 } },
        { atMs: hourStart(T0) - HOUR, burn: { 'claude:a1': 2.0 }, runs: { 'claude:a1': 10 } },
      ],
      envelope: null, runsRate: null, lastFoldMs: hourStart(T0) - 2 * HOUR,
    },
  );
  await d.fire({
    type: 'agent.run.started', companyId: 'acme', entityId: 'rev-waiting',
    payload: { run: { agentId: 'reviewer-2', provider: 'claude' } },
    occurredAt: new Date(T0 - 60000).toISOString(),
  });
  await d.tick(T0);
  assert.deepEqual((await d.api('capacity')).reviewReserve.heldAccountIds, ['claude:a1']);
  d.killIo();
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await d.hook(`run-h-${i}`));
  for (let i = 0; i < 10; i++) {
    assert.equal(outs[i].kind, 'defer', `attempt ${i + 1} defers`);
    assert.match(outs[i].reason, /review reserve: claude:a1 held for review runs/);
  }
  for (const i of [10, 11]) {
    const out = outs[i];
    assert.equal(out.kind, 'defer', `attempt ${i + 1} still defers (strand rather than spend held quota)`);
    assert.match(out.reason, /review reserve: claude:a1 held for review runs; exhaustion scan: /);
    assert.match(out.reason, /review-reserve held/);
  }
});

test('metered-ahead pools with known headroom are never selected (ahead path)', async () => {
  // Object-shape lanes: remainingKnown is true, so the unknown-headroom
  // rule cannot explain the outcome -- only the ahead-of-plan exclusion can.
  // With a free arm present the scan picks NIM; without one the enriched
  // defer names the ahead exclusion per account.
  const picked = drive({ accounts: [claudeAheadKnown(), metaAheadKnown(), nimTrial({ health: 'degraded' })], config: baseConfig() });
  await picked.setup();
  await picked.tick();
  picked.killIo();
  const outs = [];
  for (let i = 1; i <= 12; i++) outs.push(await picked.hook(`run-k-${i}`));
  for (let i = 0; i < 10; i++) assert.equal(outs[i].kind, 'defer', `attempt ${i + 1} defers`);
  for (const i of [10, 11]) {
    const out = outs[i];
    assert.equal(out.kind, 'decide', `attempt ${i + 1} answers`);
    assert.match(out.decisionId, /-nvidia-nim-n1-/, 'ahead pools skipped, NIM free-overflow arm selected');
    assert.match(out.reason, /^deferral-exhausted: /);
    assert.ok(!String(out.decisionId).includes('claude-a1'), `claude selected: ${out.decisionId}`);
    assert.ok(!String(out.decisionId).includes('meta-m1'), `meta selected: ${out.decisionId}`);
  }
  // No selectable arm and an unmapped default: the scan fails and the per
  // account skip reasons must name the ahead exclusion (not unknown
  // headroom, not a breaker).
  const skipped = drive({ accounts: [claudeAheadKnown(), metaAheadKnown()], config: baseConfig() });
  await skipped.setup();
  await skipped.tick();
  skipped.killIo();
  const defers = [];
  for (let i = 1; i <= 12; i++) defers.push(await skipped.hook(`run-q-${i}`, { agentDefaultModel: 'unmapped-model-9' }));
  for (let i = 0; i < 10; i++) assert.equal(defers[i].kind, 'defer', `attempt ${i + 1} defers`);
  for (const i of [10, 11]) {
    const out = defers[i];
    assert.equal(out.kind, 'defer', `attempt ${i + 1} still defers (nothing selectable, default unmapped)`);
    assert.match(out.reason, /; exhaustion scan: /);
    assert.match(out.reason, /claude:a1 ahead of plan/);
    assert.match(out.reason, /meta:m1 ahead of plan/);
    assert.doesNotMatch(out.reason, /headroom unknown/);
  }
});

test('a stale-snapshot keep resets the streak: post-recovery defers count from one', async () => {
  // Five deferrals, then the snapshot goes stale (clock advances with no
  // tick) so the hook keeps on the default instead of deferring. The keep
  // executes the run, ending the chain, so the streak must reset: after
  // recovery six more deferrals must all defer (without the clear the 11th
  // deferral overall would answer).
  const d = drive({ accounts: [claudeAhead(), nimTrial({ health: 'degraded' })], config: baseConfig(), nowMs: NOW });
  await d.setup();
  await d.tick(NOW);
  for (let i = 1; i <= 5; i++) assert.equal((await d.hook(`run-s-${i}`)).kind, 'defer');
  d.setNow(NOW + 200000);
  assert.deepEqual(await d.hook('run-s-stale'), { kind: 'keep' });
  await d.tick(NOW + 200000);
  for (let i = 1; i <= 6; i++) {
    assert.equal((await d.hook(`run-s-${i + 5}`)).kind, 'defer', `post-recovery deferral ${i} of 6 defers`);
  }
});
