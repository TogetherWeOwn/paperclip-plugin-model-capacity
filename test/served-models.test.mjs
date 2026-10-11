import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { canonicalModelName } from '../src/arms.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const NOW = Date.parse('2026-10-10T20:25:00Z');
const SERVED = JSON.parse(readFileSync(new URL('./served-models-20261010.json', import.meta.url), 'utf8'));
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const negatives = [
  ['devin/glm-5-3-flash', 'devin'],
  ['devin/gpt-5-4-mini', 'devin'],
  ['devin/gpt-5-6-sol', 'devin'],
  ['opencode-go/hy3-preview', 'opencode-go'],
  ['opencode-go/mimo-v2.5-pro', 'opencode-go'],
  ['kimi-k2-thinking', 'kimi'],
  ['kimi-k2.7-code', 'kimi'],
  ['kimi-k3', 'kimi'],
  ['mimo-v2.6-flash-free', 'zen-free'],
  ['ling-3.1-flash-free', 'zen-free'],
];
const positives = [
  ['gpt-6-luna', 'codex'],
  ['openai/gpt-6.1-sol', 'codex'],
  ['claude/claude-sonnet-5-5', 'claude'],
  ['claude-opus-5-5', 'claude'],
  ['meta/muse-spark-1.3-contributor', 'meta'],
];

// Exact bare emitted ids behind the prefixed discovery names above. Prefixed
// names are never treated as readiness aliases: the synthetic feed states the
// bare proxy id explicitly.
const emittedByProvider = {
  codex: ['gpt-6.1-sol'], claude: ['claude-sonnet-5-5'], meta: ['muse-spark-1.3-contributor'],
};

function account(raw, provider, i) {
  return {
    lane: `lane-${i}`, provider, accountKey: `lane-${i}`, health: 'healthy', meter: 'reactive',
    models: [raw], weekly: { used: null, resetsAt: null },
    fiveHour: { used: null, resetsAt: null },
    observedAt: new Date(NOW).toISOString(), quality: 'reactive',
  };
}

function aaRow(raw, i) {
  const model = canonicalModelName(raw);
  const slug = model === 'gpt-6.1-sol' ? 'gpt-6-1-sol'
    : model === 'muse-spark-1.3-contributor' ? 'muse-spark-1-3-xhigh' : model;
  return {
    slug, intelligenceIndex: 62 + i, intelligenceIndexCostPerTask: 10 + i,
    price1mInputTokens: 1, price1mOutputTokens: 4,
  };
}

async function start(lane, rows) {
  const config = { enforce: true, cliproxy: { laneKeySecretRef: SECRET } };
  const store = new Map();
  const jobs = new Map();
  const events = new Map();
  const warnings = [];
  const key = k => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: {
      get: async k => store.get(key(k)) ?? null,
      set: async (k, v) => { store.set(key(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: emittedByProvider }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { events.set(name, fn); } },
    logger: { info() {}, error() {}, warn(message, details) { warnings.push({ message, details }); } },
  });
  store.set(key(AA_KEY), { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  return {
    tick: () => jobs.get('shadow-tick')({}),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    hook: runId => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
      issueId: null, deadlineMs: 1500,
    }),
    startRun: runId => events.get('agent.run.started')({
      type: 'agent.run.started', companyId: 'acme', entityId: runId,
      payload: { run: { agentId: 'agent-9', adapterType: 'claude-code' } },
      occurredAt: new Date(NOW).toISOString(),
    }),
    warnings,
  };
}

test('served-id snapshot excludes unservable arms before tick, event, and hook decisions', async () => {
  assert.equal(SERVED.length, 181);
  const missing = negatives.map(([raw]) => canonicalModelName(raw));
  const kept = positives.map(([raw]) => canonicalModelName(raw));
  for (const model of missing) assert.ok(!SERVED.includes(model), `${model} unexpectedly served`);
  for (const model of kept) assert.ok(SERVED.includes(model), `${model} unexpectedly absent`);

  const candidates = [...negatives, ...positives];
  const lane = {
    observedAt: new Date(NOW).toISOString(), servedModels: SERVED,
    accounts: candidates.map(([raw, provider], i) => account(raw, provider, i)),
  };
  const d = await start(lane, candidates.map(([raw], i) => aaRow(raw, i)));
  await d.startRun('before-tick');
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  const refused = capacity.unservable;
  assert.equal(refused.length, missing.length);
  for (let i = 0; i < negatives.length; i++) {
    const [raw, provider] = negatives[i];
    assert.deepEqual(refused[i], {
      model: raw, accountId: `${provider}:lane-${i}`, emitted: canonicalModelName(raw),
    });
  }
  const ladder = (await d.api('ladder')).body.ladders;
  const rungs = Object.values(ladder).flatMap(l => l.rungs);
  for (const model of missing) assert.ok(!rungs.some(r => r.model === model), `${model} reached a ladder`);
  for (const model of kept) assert.ok(rungs.some(r => r.model === model), `${model} lost from ladders`);
  for (const entry of (await d.api('shadow')).body.entries) {
    assert.ok(kept.includes(canonicalModelName(entry.wouldModel)), entry.wouldModel);
  }
  await d.startRun('between-ticks');
  await d.tick(); // /shadow reads persisted state; the tick flushes event-time memory decisions.
  const event = (await d.api('shadow')).body.entries.find(e => e.runId === 'between-ticks');
  assert.ok(event);
  assert.equal(event.eventTime, true);
  assert.ok(kept.includes(canonicalModelName(event.wouldModel)), event.wouldModel);
  const hook = await d.hook('hook-run');
  assert.equal(hook.kind, 'decide');
  assert.ok(kept.includes(canonicalModelName(hook.model)), hook.model);
  assert.equal(d.warnings.filter(w => w.details.code === 'served-models-missing').length, 0);
});

test('old feed keeps the legacy decision and warns once across ticks', async () => {
  const lane = {
    observedAt: new Date(NOW).toISOString(),
    accounts: [account('gpt-6-luna', 'codex', 0)],
  };
  const d = await start(lane, [aaRow('gpt-6-luna', 0)]);
  await d.tick();
  const decision = await d.hook('legacy-run');
  // Captured from the previous release with this fixed clock and feed.
  assert.equal(JSON.stringify(decision), JSON.stringify({
    kind: 'decide', decisionId: 'mc-legacy-run-codex-lane-0-r0-gpt-6-luna',
    model: 'gpt-6-luna', effort: 'max',
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '260000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '240000' },
    source: 'model-capacity', reason: 'rung 0 on codex:lane-0 (doer)',
  }));
  await d.tick();
  const missingWarnings = d.warnings.filter(w => w.details.code === 'served-models-missing');
  assert.equal(missingWarnings.length, 1);
  assert.match(missingWarnings[0].message, /servedModels/);

  const malformed = await start({ ...lane, servedModels: [null, 7] }, [aaRow('gpt-6-luna', 0)]);
  await malformed.tick();
  assert.equal(JSON.stringify(await malformed.hook('legacy-run')), JSON.stringify(decision));

  const empty = await start({ ...lane, servedModels: [] }, [
    aaRow('gpt-6-luna', 0), { ...aaRow('gpt-6-luna', 0), slug: 'gpt-6-luna-high' },
  ]);
  await empty.tick();
  assert.deepEqual((await empty.api('capacity')).body.unservable, [
    { model: 'gpt-6-luna', accountId: 'codex:lane-0', emitted: 'gpt-6-luna' },
  ]);
  assert.deepEqual((await empty.api('ladder')).body.ladders['codex:lane-0'].rungs, []);
  assert.equal((await empty.hook('empty-feed')).kind, 'defer');

  const padded = await start({ ...lane, servedModels: ['gpt-6-luna '] }, [aaRow('gpt-6-luna', 0)]);
  await padded.tick();
  assert.equal((await padded.api('ladder')).body.ladders['codex:lane-0'].rungs.length, 0);
  assert.equal((await padded.hook('padded-id')).kind, 'defer');
});
