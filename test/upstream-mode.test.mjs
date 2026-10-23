import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';
import { manifest, enforceManifest, upstreamManifest, buildManifest, FORK_ONLY_CAPABILITIES, PLUGIN_VERSION } from '../src/manifest.mjs';
import upstreamEntry from '../src/manifest.upstream.mjs';
import { PAPERCLIP_API_BASE_URLS } from '../src/api-host.mjs';
import {
  planCapChange, desiredRoutingConfig, diffRoutingConfig, buildAgentPatch, agentRoutingConfig, envEntryValue,
  createAgreement, scoreHookAnswer, summarizeAgreement, mergeAgreement, agreementFromJSON, createUpstreamApi,
  normalizeUpstream, UPSTREAM_DEFAULTS,
} from '../src/upstream.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// Upstream mode (0.2.67). All IO is in memory: no provider, host or real
// secret is used. The API origin is the public placeholder pin.
const TICK = Date.parse('2026-10-08T23:00:00Z');
const HOUR = 3600000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const API_KEY_REF = { type: 'secret_ref', secretId: '22222222-3333-4444-5555-666666666666' };
const ORIGIN = PAPERCLIP_API_BASE_URLS[0];
const key = stateKey => ({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
const aaRows = () => [
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
];
const lane = (accountKey, extra = {}) => ({
  lane: `claude-${accountKey}`, provider: 'claude', accountKey, health: 'healthy',
  weekly: { used: 0.2, resetsAt: new Date(TICK + 72 * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  ...extra,
});
const plain = value => ({ type: 'plain', value });
const agent = (id, extra = {}) => ({
  id, companyId: 'acme', name: `Agent ${id}`, status: 'idle', adapterType: 'claude_local',
  adapterConfig: {
    model: 'claude-sonnet-5-5',
    env: {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: plain('1000000'),
      CLAUDE_CODE_SUBAGENT_MODEL: plain('claude-haiku-5-5'),
      SERVICE_TOKEN: { type: 'secret_ref', secretId: '33333333-4444-5555-6666-777777777777' },
    },
  },
  runtimeConfig: { heartbeat: { maxConcurrentRuns: 2, wakeOnDemand: true, intervalSec: 300 } },
  ...extra,
});
const fleet = () => [
  agent('doer-1'),
  agent('thinker-1'),
  agent('kept-1', { adapterConfig: { model: 'gpt-6.1-sol', effort: 'high', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: plain('1000000') } } }),
  agent('reviewer-1', { adapterConfig: { model: 'claude-opus-5-5', effort: 'max', env: {} } }),
  agent('paused-1', { status: 'paused' }),
  agent('proc-1', { adapterType: 'process' }),
];

const REDACTED = '***REDACTED***';
function redact(a) {
  const copy = JSON.parse(JSON.stringify(a));
  for (const [k, v] of Object.entries(copy.adapterConfig?.env ?? {})) {
    if (v?.type === 'secret_ref') copy.adapterConfig.env[k] = { ...v, secretId: REDACTED };
  }
  return copy;
}

function drive({ mode = 'shadow', overrides = {}, upstream = {}, agents = fleet(), accounts = [lane('a1'), lane('a2')], loadSample = () => ({ load5: 4, cpus: 32 }), agentsListError = null, issueLists = {} } = {}) {
  const config = {
    enforce: mode !== 'enforce',
    credentialReadiness: { enforce: false },
    roles: {
      doerAgentIds: ['doer-1'],
      thinkerAgentIds: ['thinker-1'],
      keepAgentIds: ['kept-1', 'reviewer-1'],
      minQuality: { doer: null, thinker: null, other: null },
      outcomeGate: { enabled: false },
      thinkerFloorRung: 0,
    },
    reviewerRouting: { agentIds: ['reviewer-1'], arms: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'max' }] },
    upstreamMode: mode,
    upstream: { ...(mode === 'enforce' ? { apiKeySecretRef: API_KEY_REF } : {}), ...upstream },
    ...overrides,
  };
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const calls = { agentsList: 0, api: [], laneFetches: 0, secrets: [] };
  const byId = new Map(agents.map(a => [a.id, JSON.parse(JSON.stringify(a))]));
  let now = TICK;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(JSON.stringify(k)) ?? null,
      set: async (k, v) => { store.set(JSON.stringify(k), JSON.parse(JSON.stringify(v))); },
    },
    secrets: { resolve: async (ref) => { calls.secrets.push(ref.secretId); return ref.secretId === API_KEY_REF.secretId ? 'board-key-test' : 'lane-key'; } },
    http: {
      fetch: async (url, init = {}) => {
        if (url.startsWith(`${ORIGIN}/api/agents/`)) {
          const id = decodeURIComponent(url.slice(`${ORIGIN}/api/agents/`.length));
          calls.api.push({ method: init.method, id, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null });
          const a = byId.get(id);
          if (!a) return { status: 404, json: async () => ({}) };
          if (init.method === 'GET') return { status: 200, json: async () => redact(a) };
          if (init.method === 'PATCH') {
            const body = JSON.parse(init.body);
            if (body.adapterConfig) {
              const next = { ...a.adapterConfig, ...body.adapterConfig };
              // Server restores redacted placeholders from the stored env.
              for (const [k, v] of Object.entries(next.env ?? {})) {
                if (v?.secretId === REDACTED) next.env[k] = a.adapterConfig.env[k];
              }
              a.adapterConfig = next;
            }
            if (body.runtimeConfig) a.runtimeConfig = body.runtimeConfig;
            return { status: 200, json: async () => redact(a) };
          }
        }
        calls.laneFetches += 1;
        const at = new Date(now).toISOString();
        return { status: 200, json: async () => withSyntheticReadiness({ observedAt: at, accounts: accounts.map(a => ({ ...a, observedAt: at })) }, now) };
      },
    },
    agents: {
      get: async (id) => byId.get(id) ?? null,
      list: async () => {
        calls.agentsList += 1;
        if (agentsListError) throw new Error(agentsListError);
        return [...byId.values()].map(a => JSON.parse(JSON.stringify(a)));
      },
    },
    issues: { get: async () => null, list: async ({ status } = {}) => issueLists[status] ?? [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false, loadSample });
  return {
    config, store, calls, byId, plugin,
    setup: async () => {
      await plugin.setup(io);
      store.set(JSON.stringify(key('aa-snapshot-v1')), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    setNow: ms => { now = ms; },
    setLaneUsed: used => { for (const a of accounts) a.weekly = { ...a.weekly, used }; },
    fire: (runId, agentId, atMs) => handlers.get('agent.run.started')({
      type: 'agent.run.started', companyId: 'acme', entityId: runId,
      payload: { run: { agentId, provider: 'claude' } }, occurredAt: new Date(atMs).toISOString(),
    }),
    tick: () => jobs.get('shadow-tick')({ companyId: 'acme' }),
    hook: (agentId, extra = {}) => {
      const a = byId.get(agentId);
      return plugin.onResolveRunModel({
        runId: `run-${agentId}-${Math.random().toString(36).slice(2, 8)}`, companyId: 'acme', agentId, issueId: null,
        adapterType: a?.adapterType ?? 'claude_local', invocationSource: 'test', wakeReason: null,
        agentDefaultModel: a?.adapterConfig?.model ?? null, previous: null, issueOverrideModel: null, deadlineMs: 1500, ...extra,
      });
    },
    api: async (routeKey, query = {}) => {
      const r = await plugin.onApiRequest({ companyId: 'acme', routeKey, query });
      assert.equal(r.status, 200);
      return r.body;
    },
  };
}

async function start(opts) {
  const d = drive(opts);
  await d.setup();
  await d.tick();
  return d;
}

// ---------------------------------------------------------------- config

test('upstreamMode validation: modes, pinned origin, one actuator, key for enforce', () => {
  assert.deepEqual(validateConfigShape({ upstreamMode: 'shadow' }), []);
  assert.ok(validateConfigShape({ upstreamMode: 'on' }).some(e => /upstreamMode must be one of/.test(e)));
  assert.ok(validateConfigShape({ upstreamMode: 'shadow', upstream: { apiBaseUrl: 'https://attacker.example' } })
    .some(e => /apiBaseUrl must be one of/.test(e)));
  assert.ok(validateConfigShape({ upstreamMode: 'enforce', enforce: true, upstream: { apiKeySecretRef: API_KEY_REF } })
    .some(e => /one actuator at a time/.test(e)));
  assert.ok(validateConfigShape({ upstreamMode: 'enforce' }).some(e => /requires upstream.apiKeySecretRef/.test(e)));
  assert.deepEqual(validateConfigShape({ upstreamMode: 'enforce', upstream: { apiKeySecretRef: API_KEY_REF } }), []);
  assert.ok(validateConfigShape({ upstream: { caps: { loadHoldPerCpu: 2, loadShedPerCpu: 1 } } }).some(e => /loadShedPerCpu/.test(e)));
  assert.ok(validateConfigShape({ upstream: { maxPatchesPerTick: 0 } }).some(e => /maxPatchesPerTick/.test(e)));
  assert.ok(validateConfigShape({ upstream: { caps: { burnFloor: 0 } } }).some(e => /burnFloor/.test(e)));
});

test('upstreamMode resolves off by default and to the first pinned origin', () => {
  const r = resolveConfig({});
  assert.equal(r.upstream.mode, 'off');
  assert.equal(r.upstream.apiBaseUrl, ORIGIN);
  assert.deepEqual(r.upstream.caps, { ...UPSTREAM_DEFAULTS.caps });
  assert.equal(normalizeUpstream('bogus', null, { allowlist: [ORIGIN] }).mode, 'off');
});

// -------------------------------------------------------------- manifest

// paperclipai/paperclip v2026.1012.0 packages/shared/src/constants.ts PLUGIN_CAPABILITIES.
const STOCK_1012_CAPABILITIES = new Set([
  'ai.connections.route', 'companies.read', 'projects.read', 'project.workspaces.read', 'execution.workspaces.read',
  'issues.read', 'issue.relations.read', 'issue.subtree.read', 'issue.comments.read', 'issue.interactions.read',
  'issue.attachments.read', 'approvals.read', 'issue.documents.read', 'agents.read', 'goals.read', 'goals.create',
  'goals.update', 'activity.read', 'costs.read', 'issues.orchestration.read', 'access.members.read', 'access.invites.read',
  'authorization.grants.read', 'authorization.policies.read', 'authorization.audit.read', 'database.namespace.read',
  'issues.create', 'issues.update', 'issue.relations.write', 'issues.checkout', 'issues.wakeup', 'issue.comments.create',
  'issue.comments.create_human_attributed', 'issue.interactions.create', 'issue.interactions.respond', 'approvals.respond',
  'issue.documents.write', 'projects.managed', 'routines.managed', 'skills.managed', 'agents.pause', 'agents.resume',
  'agents.invoke', 'agents.managed', 'access.members.write', 'access.invites.write', 'authorization.grants.write',
  'authorization.policies.write', 'agent.sessions.create', 'agent.sessions.list', 'agent.sessions.send',
  'agent.sessions.close', 'activity.log.write', 'metrics.write', 'telemetry.track', 'database.namespace.migrate',
  'database.namespace.write', 'external.objects.detect', 'external.objects.read', 'external.objects.write',
  'external.objects.refresh', 'plugin.state.read', 'plugin.state.write', 'events.subscribe', 'events.emit',
  'jobs.schedule', 'webhooks.receive', 'api.routes.register', 'http.outbound', 'secrets.read-ref',
  'environment.drivers.register', 'local.folders', 'agent.tools.register', 'instance.settings.register',
  'ui.sidebar.register', 'ui.page.register', 'ui.detailTab.register', 'ui.dashboardWidget.register',
  'ui.commentAnnotation.register', 'ui.action.register',
]);

test('upstream manifest loads on a stock v2026.1012.0 host: only known capabilities, no modelRouting', () => {
  assert.equal(upstreamEntry, upstreamManifest);
  for (const c of upstreamManifest.capabilities) assert.ok(STOCK_1012_CAPABILITIES.has(c), `unknown to 1012: ${c}`);
  for (const c of FORK_ONLY_CAPABILITIES) assert.equal(upstreamManifest.capabilities.includes(c), false, c);
  assert.equal('modelRouting' in upstreamManifest, false);
  assert.equal(upstreamManifest.version, PLUGIN_VERSION);
  assert.ok(upstreamManifest.description.length <= 500);
  assert.ok(upstreamManifest.displayName.length <= 100);
  assert.match(upstreamManifest.id, /^[a-z0-9][a-z0-9._-]*$/);
  // Same worker, jobs, routes and config schema as the other variants.
  assert.deepEqual(upstreamManifest.apiRoutes, manifest.apiRoutes);
  assert.deepEqual(upstreamManifest.jobs, manifest.jobs);
  assert.deepEqual(upstreamManifest.instanceConfigSchema, manifest.instanceConfigSchema);
  assert.ok(upstreamManifest.apiRoutes.some(r => r.routeKey === 'upstream' && r.path === '/upstream'));
});

test('the enforce manifest keeps run.model.resolve and its env keys (live fork host unchanged)', () => {
  assert.ok(enforceManifest.capabilities.includes('run.model.resolve'));
  assert.deepEqual(enforceManifest.modelRouting.envKeys, ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']);
  assert.ok(enforceManifest.instanceConfigSchema.properties.upstreamMode);
  assert.throws(() => buildManifest({ modelResolve: true, upstream: true }), /exclusive/);
});

// ------------------------------------------------------------------- off

test('upstreamMode off (default): no agent read, no upstream state, hook unchanged', async () => {
  const d = await start({ mode: 'off' });
  assert.equal(d.calls.agentsList, 0);
  assert.equal(d.store.get(JSON.stringify(key('upstream-v1'))), undefined);
  const out = await d.hook('doer-1');
  assert.equal(out.kind, 'decide');
  assert.equal(d.store.get(JSON.stringify(key('upstream-agreement-v1'))), undefined);
});

// ---------------------------------------------------------------- shadow

test('shadow: proposals for active Claude-CLI agents only; nothing is written', async () => {
  const d = await start({ mode: 'shadow' });
  assert.equal(d.calls.agentsList, 1);
  assert.equal(d.calls.api.length, 0, 'shadow sends no API call');
  assert.equal(d.calls.secrets.includes(API_KEY_REF.secretId), false, 'shadow never resolves the API key');
  const r = await d.api('upstream');
  assert.equal(r.mode, 'shadow');
  assert.deepEqual(r.agents.map(a => a.agentId).sort(), ['doer-1', 'kept-1', 'reviewer-1', 'thinker-1']);
  const doer = r.agents.find(a => a.agentId === 'doer-1');
  assert.equal(doer.proposal.kind, 'decide');
  assert.equal(doer.proposal.path, 'routed');
  assert.ok(doer.proposal.model);
  // Secrets never reach the report: only routing env keys, plain values.
  assert.equal(JSON.stringify(r).includes('33333333-4444-5555-6666-777777777777'), false);
  assert.deepEqual(Object.keys(doer.current.env).sort(), ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']);
  // Kept Sol agent: the configured model with the Sol caps (keptCapsAnswer).
  const kept = r.agents.find(a => a.agentId === 'kept-1');
  assert.equal(kept.proposal.path, 'kept');
  assert.equal(kept.proposal.model, 'gpt-6.1-sol');
  assert.deepEqual(kept.changes.map(c => c.field).sort(), ['env.CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS']);
  // Reviewer routing path.
  const rev = r.agents.find(a => a.agentId === 'reviewer-1');
  assert.equal(rev.proposal.path, 'reviewer');
  assert.equal(rev.proposal.model, 'claude-opus-5-5');
  assert.equal(rev.proposal.effort, 'max');
  // Agents unchanged.
  assert.equal(d.byId.get('doer-1').adapterConfig.model, 'claude-sonnet-5-5');
});

test('shadow: every proposal equals the live hook answer for a fresh run of the same agent', async () => {
  const d = await start({ mode: 'shadow' });
  const r = await d.api('upstream');
  for (const row of r.agents) {
    const out = await d.hook(row.agentId);
    if (row.proposal.kind === 'keep') {
      assert.equal(out.kind, 'keep', row.agentId);
    } else {
      assert.equal(out.kind, 'decide', row.agentId);
      assert.equal(out.model, row.proposal.model, row.agentId);
      assert.equal(out.effort ?? null, row.proposal.effort ?? null, row.agentId);
      assert.deepEqual(out.env ?? {}, row.proposal.env ?? {}, row.agentId);
    }
  }
  await d.tick();
  const after = await d.api('upstream');
  assert.equal(after.agreement.window.scored, r.agents.length);
  assert.equal(after.agreement.window.agree, r.agents.length);
  assert.equal(after.agreement.window.agreementPct, 100);
  assert.deepEqual(after.disagreements, []);
});

test('shadow: the hook answer is identical with upstreamMode off and shadow', async () => {
  const off = await start({ mode: 'off' });
  const sh = await start({ mode: 'shadow' });
  for (const id of ['doer-1', 'thinker-1', 'kept-1', 'reviewer-1']) {
    const a = await off.hook(id, { runId: `same-${id}` });
    const b = await sh.hook(id, { runId: `same-${id}` });
    assert.deepEqual(b, a, id);
  }
});

test('shadow agreement: pinned, stale, deferred and disagreeing answers are classified', async () => {
  const d = await start({ mode: 'shadow' });
  await d.hook('doer-1', { issueOverrideModel: 'claude-haiku-5-5' });
  // A hook answer the proposal does not match: score it directly against a
  // forged proposal to exercise the disagreement ring.
  const s = createAgreement(TICK);
  const proposal = { kind: 'decide', model: 'claude-haiku-5-5', effort: null, atMs: TICK, reason: 'p' };
  assert.equal(scoreHookAnswer(s, { nowMs: TICK + 1000, params: { agentId: 'x', runId: 'r1' }, answer: { kind: 'decide', model: 'claude-sonnet-5-5' }, proposal, maxAgeMs: 150000 }), 'disagree');
  assert.equal(scoreHookAnswer(s, { nowMs: TICK + 1000, params: { agentId: 'x' }, answer: { kind: 'decide', model: 'claude-haiku-5-5' }, proposal, maxAgeMs: 150000 }), 'agree');
  assert.equal(scoreHookAnswer(s, { nowMs: TICK + 200000, params: { agentId: 'x' }, answer: { kind: 'decide', model: 'claude-haiku-5-5' }, proposal, maxAgeMs: 150000 }), 'noProposal');
  assert.equal(scoreHookAnswer(s, { nowMs: TICK + 1000, params: { agentId: 'x' }, answer: { kind: 'defer' }, proposal: { ...proposal, kind: 'hold' }, maxAgeMs: 150000 }), 'deferred');
  assert.equal(scoreHookAnswer(s, { nowMs: TICK + 1000, params: { agentId: 'x' }, answer: { kind: 'keep' }, proposal: null, maxAgeMs: 150000 }), 'noProposal');
  assert.equal(scoreHookAnswer(s, { nowMs: TICK + 1000, params: { agentId: 'x', agentDefaultModel: 'm' }, answer: { kind: 'keep' }, proposal: { kind: 'keep', atMs: TICK }, maxAgeMs: 150000 }), 'agree');
  const sum = summarizeAgreement(s, TICK + 1000);
  assert.equal(sum.window.agree, 2);
  assert.equal(sum.window.disagree, 1);
  assert.equal(sum.window.agreementPct, 66.67);
  assert.equal(sum.deferHeld, 1);
  assert.equal(s.disagreements.length, 1);
  assert.equal(s.disagreements[0].hook.model, 'claude-sonnet-5-5');
  // Persisted counts + delta merge per bucket.
  const merged = mergeAgreement(agreementFromJSON(JSON.parse(JSON.stringify(s)), TICK), s);
  assert.equal(summarizeAgreement(merged, TICK + 1000).window.agree, 4);
  assert.equal(agreementFromJSON({ version: 9 }, TICK).sinceMs, TICK);
  await d.tick();
  const r = await d.api('upstream');
  assert.equal(r.agreement.window.issuePinned, 1);
});

test('shadow: the internal /caps read does not advance the cap-hold state the host helper reads', async () => {
  const d = await start({ mode: 'shadow' });
  const before = d.store.get(JSON.stringify(key('caps-hold-v1')));
  d.setNow(TICK + 60000);
  await d.tick();
  assert.deepEqual(d.store.get(JSON.stringify(key('caps-hold-v1'))), before);
});

test('shadow: a failing agents.list never fails the tick and is reported', async () => {
  const d = drive({ mode: 'shadow', agentsListError: 'host down' });
  await d.setup();
  await d.tick(); // resolves: the upstream step never fails the tick
  const r = await d.api('upstream');
  assert.deepEqual(r.agents, []);
  assert.deepEqual(r.errors, [{ step: 'agents.list', error: 'host down' }]);
  // The hook still answers normally.
  assert.equal((await d.hook('doer-1')).kind, 'decide');
});

test('caps.holdAgentIds: model still routed, run cap never planned', async () => {
  const d = await start({ mode: 'shadow', upstream: { caps: { holdAgentIds: ['kept-1'] } } });
  const r = await d.api('upstream');
  const kept = r.agents.find(a => a.agentId === 'kept-1');
  assert.equal(kept.held, false);
  assert.ok(kept.changes.length > 0);
  assert.equal(kept.cap, null);
  assert.ok(validateConfigShape({ upstream: { caps: { holdAgentIds: 'x' } } }).some(e => /caps.holdAgentIds/.test(e)));
});

test('caps: measured /caps allocation planned per agent; operator cap holds skipped', async () => {
  const todo = [
    { id: 'i1', status: 'todo', assigneeAgentId: 'doer-1' },
    { id: 'i2', status: 'todo', assigneeAgentId: 'doer-1' },
    { id: 'i3', status: 'todo', assigneeAgentId: 'doer-1' },
    { id: 'i4', status: 'todo', assigneeAgentId: 'doer-1' },
    { id: 'i5', status: 'todo', assigneeAgentId: 'doer-1' },
    { id: 'i6', status: 'todo', assigneeAgentId: 'thinker-1' },
  ];
  const d = drive({ mode: 'shadow', accounts: [lane('a1', { weekly: { used: 0.3, resetsAt: '2026-10-15T22:59:00Z' } })], issueLists: { todo }, upstream: { caps: { holdAgentIds: ['thinker-1'] } } });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 10 * 60000);
  await d.fire('run-a', 'doer-1', TICK + 10 * 60000);
  d.setNow(TICK + 20 * 60000);
  await d.fire('run-b', 'doer-1', TICK + 20 * 60000);
  d.setNow(TICK + 30 * 60000);
  d.setLaneUsed(0.3002);
  await d.tick();
  const caps = await d.api('caps');
  assert.ok(caps.agents.length > 0, 'measured target with queued agents');
  const r = await d.api('upstream');
  const doer = r.agents.find(a => a.agentId === 'doer-1');
  const want = caps.agents.find(a => a.agentId === 'doer-1').maxConcurrentRuns;
  assert.equal(doer.cap.from, 2);
  assert.equal(doer.cap.want, want);
  assert.equal(doer.cap.to, Math.min(want, 2 + 4));
  assert.equal(r.agents.find(a => a.agentId === 'thinker-1').cap, null, 'cap held by operator');
  assert.equal(r.caps.agents, caps.agents.length);
  assert.deepEqual(r.load, { load5: 4, cpus: 32 });
});

test('holdAgentIds: proposed, never diffed', async () => {
  const d = await start({ mode: 'shadow', upstream: { holdAgentIds: ['kept-1'] } });
  const r = await d.api('upstream');
  const kept = r.agents.find(a => a.agentId === 'kept-1');
  assert.equal(kept.held, true);
  assert.deepEqual(kept.changes, []);
  assert.equal(kept.cap, null);
});

// --------------------------------------------------------------- enforce

test('enforce: PATCHes only changed fields through the pinned origin, secrets round-trip redacted', async () => {
  const d = await start({ mode: 'enforce' });
  const patches = d.calls.api.filter(c => c.method === 'PATCH');
  assert.ok(patches.length > 0);
  for (const c of d.calls.api) assert.equal(c.auth, 'Bearer board-key-test');
  const kept = patches.find(p => p.id === 'kept-1');
  assert.deepEqual(Object.keys(kept.body.adapterConfig), ['env']);
  assert.equal(kept.body.adapterConfig.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS.value, '890000');
  assert.equal(kept.body.adapterConfig.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW.value, '870000');
  // The stored secret survives (restored server-side from the redacted read).
  const doerPatch = patches.find(p => p.id === 'doer-1');
  if (doerPatch?.body.adapterConfig?.env) {
    assert.equal(doerPatch.body.adapterConfig.env.SERVICE_TOKEN.secretId, REDACTED);
  }
  assert.equal(d.byId.get('doer-1').adapterConfig.env.SERVICE_TOKEN.secretId, '33333333-4444-5555-6666-777777777777');
  // Pre-actuator config saved before the first write.
  const base = d.store.get(JSON.stringify(key('upstream-base-v1')));
  assert.equal(base['kept-1'].env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  const r = await d.api('upstream');
  assert.equal(r.mode, 'enforce');
  assert.ok(r.applied.some(a => a.agentId === 'kept-1'));
  assert.deepEqual(r.errors, []);
});

test('enforce: converged agents are not written again (PATCH only on change)', async () => {
  const d = await start({ mode: 'enforce' });
  const first = d.calls.api.filter(c => c.method === 'PATCH').length;
  d.setNow(TICK + 60000);
  await d.tick();
  const second = d.calls.api.filter(c => c.method === 'PATCH').length - first;
  assert.equal(second, 0);
  const r = await d.api('upstream');
  assert.equal(r.wouldPatch, 0);
});

test('enforce: at most maxPatchesPerTick writes per tick', async () => {
  const d = await start({ mode: 'enforce', upstream: { maxPatchesPerTick: 1 } });
  assert.equal(d.calls.api.filter(c => c.method === 'PATCH').length, 1);
});

test('enforce: a kept agent the actuator never touched is left exactly as is', async () => {
  const d = await start({
    mode: 'enforce',
    agents: [agent('kept-2', { adapterConfig: { model: 'claude-opus-5-5', env: {} } })],
    overrides: { roles: { keepAgentIds: ['kept-2'], minQuality: { doer: null, thinker: null, other: null }, outcomeGate: { enabled: false } } },
  });
  assert.equal(d.calls.api.filter(c => c.method === 'PATCH' && c.body.adapterConfig).length, 0);
});

test('enforce: API errors are reported per agent, never thrown into the tick', async () => {
  const d = drive({ mode: 'enforce' });
  await d.setup();
  // The plugin's agent list sees kept-1, but the API answers 404 for it.
  const realGet = d.byId.get.bind(d.byId);
  const listed = realGet('kept-1');
  d.byId.delete('kept-1');
  d.byId.get = (id) => (id === 'kept-1' ? undefined : realGet(id));
  d.byId.set('kept-1-shadow', listed);
  await d.tick(); // resolves: the upstream step never fails the tick
  const r = await d.api('upstream');
  assert.ok(r.errors.some(e => e.step === 'patch' && e.agentId === 'kept-1' && /upstream-api-get-404/.test(e.error)));
  assert.equal(r.applied.some(a => a.agentId === 'kept-1'), false);
});

test('upstream report preserves zero query values and defaults non-finite inputs', async () => {
  const d = await start({ mode: 'shadow' });
  const persisted = createAgreement(TICK);
  persisted.disagreements = [{ runId: 'old-mismatch' }];
  d.store.set(JSON.stringify(key('upstream-agreement-v1')), persisted);
  const zero = await d.api('upstream', { hours: '0', disagreements: '0' });
  assert.equal(zero.agreement.windowHours, 1);
  assert.deepEqual(zero.disagreements, []);
  const invalid = await d.api('upstream', { hours: 'Infinity', disagreements: 'NaN' });
  assert.equal(invalid.agreement.windowHours, 24);
  assert.equal(invalid.disagreements.length, 1);
});

test('enforce preserves bases captured after the agent list was read', async () => {
  const d = drive({ mode: 'enforce' });
  await d.setup();
  const ioKey = JSON.stringify(key('upstream-base-v1'));
  const sentinel = { model: 'original-model', effort: 'high', env: {}, maxConcurrentRuns: 4, atMs: TICK - 60000 };
  const realGet = d.byId.get.bind(d.byId);
  // A concurrent tick records an original base during the first API GET.
  let injected = false;
  d.byId.get = (id) => {
    if (!injected) {
      injected = true;
      d.store.set(ioKey, { 'kept-1': sentinel, 'outside-agent': sentinel });
    }
    return realGet(id);
  };
  await d.tick();
  const bases = d.store.get(ioKey);
  assert.deepEqual(bases['kept-1'], sentinel);
  assert.deepEqual(bases['outside-agent'], sentinel);
});

// ------------------------------------------------------------ pure parts

const CAPS = UPSTREAM_DEFAULTS.caps;
test('planCapChange mirrors the host cap helper', () => {
  const idle = { load5: 4, cpus: 32 };
  assert.deepEqual(planCapChange({ current: 2, want: 10, load: idle, cfg: CAPS }), { from: 2, to: 6, want: 10, reason: 'up' });
  assert.deepEqual(planCapChange({ current: 4, want: 3, load: idle, cfg: CAPS }), { from: 4, to: 4, want: 3, reason: 'deadband' });
  assert.deepEqual(planCapChange({ current: 6, want: 2, load: idle, cfg: CAPS }), { from: 6, to: 5, want: 2, reason: 'down' });
  assert.deepEqual(planCapChange({ current: 6, want: 2, isPinned: true, load: idle, cfg: CAPS }), { from: 6, to: 2, want: 2, reason: 'down' });
  // Load at the hold line: up moves hold; review agents still climb.
  const busy = { load5: 26, cpus: 32 };
  assert.equal(planCapChange({ current: 2, want: 6, load: busy, cfg: CAPS }).to, 2);
  assert.equal(planCapChange({ current: 2, want: 6, isReview: true, load: busy, cfg: CAPS }).to, 6);
  // Shed line: non-review agents shed one; at 1.5x CPUs a quarter.
  assert.equal(planCapChange({ current: 8, want: 8, load: { load5: 40, cpus: 32 }, cfg: CAPS }).to, 7);
  assert.equal(planCapChange({ current: 8, want: 8, load: { load5: 50, cpus: 32 }, cfg: CAPS }).to, 6);
  assert.equal(planCapChange({ current: 8, want: 8, isReview: true, load: { load5: 50, cpus: 32 }, cfg: CAPS }).to, 8);
  // Unknown load: up moves fail closed.
  assert.deepEqual(planCapChange({ current: 2, want: 6, load: null, cfg: CAPS }), { from: 2, to: 2, want: 6, reason: 'load-unknown' });
  // Burn floor for doers.
  assert.equal(planCapChange({ current: 2, want: 1, isDoer: true, load: idle, cfg: { ...CAPS, burnFloor: 8 } }).to, 6);
  assert.equal(planCapChange({ current: 1, want: 0, load: idle, cfg: CAPS }).to, 1);
  assert.equal(planCapChange({ current: 2, want: Number.NaN, load: idle, cfg: CAPS }), null);
});

test('desiredRoutingConfig mirrors the hook merge (effort kept when unset, env per key)', () => {
  const base = { model: 'm0', effort: 'high', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: null, CLAUDE_CODE_MAX_OUTPUT_TOKENS: null } };
  assert.deepEqual(desiredRoutingConfig(base, { kind: 'decide', model: 'gpt-6.1-sol', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '890000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '870000' } }),
    { model: 'gpt-6.1-sol', effort: 'high', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '890000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '870000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: null } });
  assert.deepEqual(desiredRoutingConfig(base, { kind: 'decide', model: 'muse', effort: 'max', env: {} }),
    { model: 'muse', effort: 'max', env: base.env });
  assert.deepEqual(desiredRoutingConfig(base, { kind: 'keep' }), { model: 'm0', effort: 'high', env: base.env });
  assert.equal(desiredRoutingConfig(base, { kind: 'hold' }), null);
  assert.deepEqual(diffRoutingConfig({ model: 'a', effort: null, env: {} }, null), []);
  assert.deepEqual(diffRoutingConfig({ model: 'a', effort: null, env: {} }, { model: 'b', effort: null, env: {} }).map(c => c.field), ['model']);
});

test('buildAgentPatch: only changed adapterConfig keys, whole env with routing keys edited, whole runtimeConfig', () => {
  const a = agent('x', { adapterConfig: { model: 'm0', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000', SERVICE_TOKEN: { type: 'secret_ref', secretId: REDACTED } } } });
  const cur = agentRoutingConfig(a);
  assert.equal(buildAgentPatch(a, { model: 'm0', effort: null, env: cur.env }, 2), null);
  const p = buildAgentPatch(a, { model: 'm1', effort: null, env: { ...cur.env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: null, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '870000' } }, 5);
  assert.deepEqual(Object.keys(p.adapterConfig).sort(), ['env', 'model']);
  assert.equal('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in p.adapterConfig.env, false);
  assert.deepEqual(p.adapterConfig.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, { type: 'plain', value: '870000' });
  assert.deepEqual(p.adapterConfig.env.SERVICE_TOKEN, { type: 'secret_ref', secretId: REDACTED });
  assert.deepEqual(p.runtimeConfig, { heartbeat: { maxConcurrentRuns: 5, wakeOnDemand: true, intervalSec: 300 } });
  // A plain-string entry keeps the plain-string shape.
  const s = agent('y', { adapterConfig: { model: 'm0', env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } } });
  const q = buildAgentPatch(s, { model: 'm0', effort: null, env: { ...agentRoutingConfig(s).env, CLAUDE_CODE_MAX_CONTEXT_TOKENS: '890000' } });
  assert.equal(q.adapterConfig.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '890000');
  assert.equal(envEntryValue({ type: 'secret_ref', secretId: 'abc' }), '<non-plain>');
});

test('createUpstreamApi: https origin only, bearer key, status-only errors', async () => {
  assert.throws(() => createUpstreamApi({ fetch: async () => ({}), baseUrl: 'http://plain.example', apiKey: 'k' }), /base-url/);
  assert.throws(() => createUpstreamApi({ fetch: async () => ({}), baseUrl: ORIGIN, apiKey: '' }), /key-missing/);
  const seen = [];
  const api = createUpstreamApi({ fetch: async (url, init) => { seen.push([url, init]); return { status: 403, json: async () => ({ error: 'secret text' }) }; }, baseUrl: ORIGIN, apiKey: 'k' });
  await assert.rejects(api.patchAgent('a/b', { x: 1 }), (e) => e.message === 'upstream-api-patch-403' && !/secret text/.test(e.message));
  assert.equal(seen[0][0], `${ORIGIN}/api/agents/a%2Fb`);
  assert.equal(seen[0][1].headers.Authorization, 'Bearer k');
});
