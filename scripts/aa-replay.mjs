// Offline replay: all I/O is an in-memory fake. No network or real secret
// service is reachable. The caller supplies captured inputs and fixture text.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createModelCapacityPlugin, resolveConfig } from '../src/plugin.mjs';
import { LANE_BASE_URLS } from '../src/lane-host.mjs';

const REF = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const COMPANY = 'offline-replay';
const clone = x => structuredClone(x);

// Only the per-instance epoch is nondeterministic across otherwise identical ticks.
export function projectForParity(result) {
  const projected = clone(result);
  if (Object.hasOwn(projected.capacity, 'reviewAdmissionEpoch')) {
    projected.capacity.reviewAdmissionEpoch = '<epoch>';
  }
  return projected;
}

function fakeContext({ config, lane, states, demand, nowMs, pages, leaderboard }) {
  const raw = clone(config);
  raw.cliproxy = { ...raw.cliproxy, baseUrl: LANE_BASE_URLS[0], laneKeySecretRef: REF };
  raw.aa = { ...raw.aa, apiKeySecretRef: REF };
  const store = new Map(Object.entries(clone(states)));
  const jobs = new Map();
  const failures = [];
  const roles = raw.roles ?? {};
  const doer = roles.doerAgentIds?.[0] ?? 'offline-doer';
  const thinker = roles.thinkerAgentIds?.[0] ?? 'offline-thinker';
  // An empty doer list classifies every non-thinker as doer in the plugin.
  if (!roles.doerAgentIds?.length) raw.roles = { ...roles, doerAgentIds: [doer] };
  const issueRows = Object.entries({ doer, thinker, other: 'offline-other' }).flatMap(([role, id]) =>
    Array.from({ length: demand[role] ?? 0 }, (_, i) => ({ id: `${role}-${i}`, status: 'todo', assigneeAgentId: id })));
  const context = {
    config: { get: async () => raw },
    state: { get: async k => clone(store.get(k.stateKey) ?? null), set: async (k, v) => store.set(k.stateKey, clone(v)) },
    secrets: { resolve: async () => 'offline-placeholder' },
    http: { fetch: async url => {
      const u = new URL(url);
      if (u.hostname !== 'artificialanalysis.ai') return { status: 200, json: async () => clone(lane) };
      if (u.hostname === 'artificialanalysis.ai' && u.pathname === '/api/v2/language/models/free' && pages) {
        const n = Number(u.searchParams.get('page') || 1);
        if (!pages[n - 1]) throw new Error(`Missing offline fixture page ${n}`);
        return { status: 200, headers: { get: () => null }, text: async () => pages[n - 1] };
      }
      if (u.hostname === 'artificialanalysis.ai' && u.pathname === '/leaderboards/models' && leaderboard != null)
        return { status: 200, headers: { get: () => null }, text: async () => leaderboard };
      throw new Error('Unexpected offline replay request');
    } },
    issues: { list: async ({ status }) => status === 'todo' ? clone(issueRows) : [], get: async () => null },
    agents: { get: async () => ({ adapterType: 'claude-code' }), getQueuedRunCounts: async () => [] },
    jobs: { register: (name, fn) => jobs.set(name, fn) },
    events: { on() {} },
    logger: { info() {}, warn() {}, error(message, meta) { failures.push({ message, error: meta?.error }); } },
  };
  return { context, raw, store, jobs, failures };
}

async function start(options) {
  const fake = fakeContext(options);
  const plugin = createModelCapacityPlugin({ clock: () => options.nowMs, requirePinnedLaneHost: false });
  await plugin.setup(fake.context);
  const count = options.configNotifications ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid configNotifications');
  for (let i = 0; i < count; i++) await plugin.onConfigChanged(fake.raw, { companyId: COMPANY });
  return fake;
}

export async function replayTick({ config, lane, states, snapshot, demand, nowMs, configNotifications = 1, includeState = false }) {
  if (!Number.isFinite(nowMs) || !demand || !lane || !config) throw new Error('Missing replay inputs');
  const fake = await start({ config, lane, states, demand, nowMs, configNotifications });
  fake.store.set('aa-snapshot-v1', clone(snapshot));
  try { await fake.jobs.get('shadow-tick')({}); }
  catch (e) { throw new Error(`Offline shadow tick failed: ${JSON.stringify(fake.failures)}`, { cause: e }); }
  const capacity = fake.store.get('capacity-v1');
  const ladders = fake.store.get('ladder-v1');
  if (capacity?.atMs !== nowMs || ladders?.atMs !== nowMs) throw new Error('Offline tick did not publish');
  return { capacity, ladders, diagnostics: fake.failures,
    ...(includeState ? { state: clone(Object.fromEntries(fake.store)) } : {}) };
}

// Historical fidelity is admissible only for the recorded producer and flags.
export function assertReplayProvenance(provenance, { replayRevision, replayFeatureState } = {}) {
  const fields = ['newestVersionOnlyEnabled', 'accountFallbackEnabled'];
  if (!provenance || typeof provenance.implementationRevision !== 'string' || !provenance.implementationRevision.trim()
      || typeof provenance.capturedAt !== 'string' || !Number.isFinite(Date.parse(provenance.capturedAt))
      || typeof replayRevision !== 'string' || replayRevision !== provenance.implementationRevision
      || !replayFeatureState || fields.some(field => typeof provenance[field] !== 'boolean'
        || typeof replayFeatureState[field] !== 'boolean' || provenance[field] !== replayFeatureState[field])) {
    throw new Error('Replay provenance mismatch or missing provenance');
  }
}

// Fail closed: a successor comparison is meaningful only when the captured
// baseline reproduces every routing and capacity dimension we claim to test.
export function assertFidelity(stored, replayed) {
  const checks = {
    eligibility: [stored.capacity.eligibility, replayed.capacity.eligibility],
    ladders: [stored.ladders.ladders, replayed.ladders.ladders],
    reviewerArms: [stored.capacity.reviewer?.routing?.arms, replayed.capacity.reviewer?.routing?.arms],
    target: [stored.capacity.target, replayed.capacity.target],
    targetRaw: [stored.capacity.targetRaw, replayed.capacity.targetRaw],
    roles: [stored.capacity.roles, replayed.capacity.roles],
    perAccount: [stored.capacity.perAccount, replayed.capacity.perAccount],
  };
  const failed = Object.entries(checks).filter(([, [a, b]]) => a === undefined || b === undefined || !isDeepStrictEqual(a, b)).map(([name]) => name);
  if (failed.length) throw new Error(`Replay fidelity failed: ${failed.join(', ')}`);
}

export async function buildSuccessor({ config, states, snapshot, nowMs, pages, leaderboard }) {
  const fake = await start({ config, states, lane: {}, demand: {}, nowMs, pages, leaderboard });
  fake.store.set('aa-snapshot-v1', clone(snapshot));
  const results = await fake.jobs.get('aa-refresh')({});
  if (results[0]?.status !== 'ok') throw new Error('Offline AA refresh failed');
  return fake.store.get('aa-snapshot-v1');
}

async function main() {
  const [inputDir, fixtureDir, replayRevision] = process.argv.slice(2);
  if (!inputDir || !fixtureDir || !replayRevision) throw new Error('Usage: node scripts/aa-replay.mjs INPUT_DIR FIXTURE_DIR REPLAY_REVISION');
  const parse = async path => JSON.parse(await readFile(path, 'utf8'));
  const capture = await parse(`${inputDir}/fresh-state.json`);
  if (capture.configs?.length !== 1) throw new Error('Expected exactly one captured config');
  const states = Object.fromEntries(capture.states.map(s => [s.stateKey, s.value]));
  const lane = await parse(`${inputDir}/lane-body.json`);
  const config = capture.configs[0].config_json;
  const roles = resolveConfig(config).roles;
  assertReplayProvenance(capture.provenance, { replayRevision, replayFeatureState: {
    newestVersionOnlyEnabled: roles.newestVersionOnly.enabled,
    accountFallbackEnabled: roles.accountFallback.enabled,
  } });
  const saved = states['capacity-v1'];
  const nowMs = saved.atMs;
  if (states['ladder-v1']?.atMs !== nowMs) throw new Error('Captured capacity and ladder ticks differ');
  const demand = Object.fromEntries(['doer', 'thinker', 'other'].map(role => [role, saved.roles[role].demand]));
  const snapshot = states['aa-snapshot-v1'];
  const pages = await Promise.all([1,2,3,4].map(n => readFile(`${fixtureDir}/aa-free-20261029-page-${n}.json`, 'utf8')));
  const leaderboard = await readFile(`${fixtureDir}/aa-leaderboard-20261029.html`, 'utf8');
  const old = await replayTick({ config, lane, states, snapshot, demand, nowMs });
  assertFidelity({ capacity: saved, ladders: states['ladder-v1'] }, old);
  const successor = await buildSuccessor({ config, states, snapshot, nowMs, pages, leaderboard });
  const next = await replayTick({ config, lane, states, snapshot: successor, demand, nowMs });
  console.log(JSON.stringify({ provenance: capture.provenance, captureTime: capture.capturedAt, laneObservedAt: lane.observedAt, nowMs, demand, old, next, successorSummary: successor.refreshSummary }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
