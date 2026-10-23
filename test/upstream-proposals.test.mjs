import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { decide } from '../src/decide.mjs';

// Proposed public seam. Missing implementation is an explicit acceptance failure,
// not an import-time crash, skipped test, or replacement implementation.
const upstream = await import('../src/upstream.mjs').catch(error => ({ loadError: error.code }));
function seam(name) {
  assert.equal(typeof upstream[name], 'function',
    `src/upstream.mjs must export ${name} (${upstream.loadError ?? 'missing export'})`);
  return upstream[name];
}

const companyId = 'company-a';
const agentId = 'agent-a';
const decision = {
  kind: 'decide', model: 'gpt-6.1-sol', effort: 'high',
  env: {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '890000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '870000',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
  },
};
function agent(extra = {}) {
  return {
    id: agentId, companyId, adapterType: 'claude_local', status: 'idle',
    adapterConfig: { model: 'claude-haiku-5-5', effort: 'max', env: {} },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
    ...extra,
  };
}
function noPatch(proposal) {
  assert.ok(proposal.patch == null, 'hold/noop/kept must not carry an executable patch');
}
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

// A restored hook would make an otherwise official-compatible manifest unsafe:
// assert the runtime object, not source text or a made-up registration map.
test('official runtime has no run-model resolver, even when legacy enforce is requested', async () => {
  const plugin = createModelCapacityPlugin({ clock: () => 1000 });
  assert.equal(plugin.onResolveRunModel, undefined);
  await plugin.onConfigChanged({ enforce: true }, { companyId });
  assert.equal(plugin.onResolveRunModel, undefined);
});

test('agent proposal names the target and contains only model/context/concurrency changes', () => {
  const proposal = seam('buildAgentProposal')({ agent: agent(), decision, cap: 7 });
  assert.deepEqual(Object.keys(proposal).sort(), ['agentId', 'companyId', 'patch', 'reason', 'status']);
  assert.equal(proposal.agentId, agentId);
  assert.equal(proposal.companyId, companyId);
  assert.equal(proposal.status, 'proposed');
  assert.equal(typeof proposal.reason, 'string');
  assert.ok(proposal.reason.length > 0);
  assert.deepEqual(proposal.patch, {
    adapterConfig: {
      model: 'gpt-6.1-sol', effort: 'high', env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '890000',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '870000',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      },
    },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 7 } },
  });
});

for (const [cap, want] of [[0.25, 1], [1, 1], [50, 50], [51, 50], [10000, 50]]) {
  test(`positive allocator cap ${cap} becomes bounded concurrency ${want}`, () => {
    const proposal = seam('buildAgentProposal')({ agent: agent(), decision, cap });
    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.patch.runtimeConfig.heartbeat.maxConcurrentRuns, want);
  });
}
for (const cap of [0, -1, -100]) {
  test(`allocator cap ${cap} holds without pause, zero concurrency, or a model patch`, () => {
    const proposal = seam('buildAgentProposal')({ agent: agent(), decision, cap });
    assert.equal(proposal.status, 'hold');
    noPatch(proposal);
  });
}
for (const unavailable of [undefined, null, { kind: 'defer', reason: 'insufficient headroom' }]) {
  test(`unavailable decision ${unavailable?.kind ?? String(unavailable)} holds without patch`, () => {
    const proposal = seam('buildAgentProposal')({ agent: agent(), decision: unavailable, cap: 4 });
    assert.equal(proposal.status, 'hold');
    noPatch(proposal);
  });
}

test('already matching model, effort, context and cap is a noop', () => {
  const current = agent({
    adapterConfig: { model: decision.model, effort: decision.effort, env: { ...decision.env } },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 7 } },
  });
  const proposal = seam('buildAgentProposal')({ agent: current, decision, cap: 7 });
  assert.equal(proposal.status, 'noop');
  noPatch(proposal);
});

test('proposal construction does not mutate agent or decision snapshots', () => {
  const current = frozen(agent());
  const pick = frozen(structuredClone(decision));
  const proposal = seam('buildAgentProposal')({ agent: current, decision: pick, cap: 8 });
  assert.equal(proposal.status, 'proposed');
  assert.equal(current.adapterConfig.model, 'claude-haiku-5-5');
  assert.equal(current.runtimeConfig.heartbeat.maxConcurrentRuns, 2);
  assert.equal(pick.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '890000');
});

test('decision cannot smuggle authority, credentials or unrelated env into a proposal', () => {
  const pick = {
    ...decision,
    env: { ...decision.env, UNOWNED_ENV: 'unrelated-decision-value', API_KEY: 'synthetic-not-a-credential' },
    status: 'paused', permissions: { canCreateAgents: true },
    runtimeConfig: { heartbeat: { enabled: false } },
  };
  const proposal = seam('buildAgentProposal')({ agent: agent(), decision: pick, cap: 7 });
  assert.equal(proposal.status, 'proposed');
  assert.deepEqual(Object.keys(proposal.patch).sort(), ['adapterConfig', 'runtimeConfig']);
  assert.deepEqual(Object.keys(proposal.patch.adapterConfig).sort(), ['effort', 'env', 'model']);
  assert.deepEqual(proposal.patch.adapterConfig.env, decision.env);
  assert.deepEqual(proposal.patch.runtimeConfig, { heartbeat: { maxConcurrentRuns: 7 } });
  assert.ok(!JSON.stringify(proposal).includes('synthetic-not-a-credential'));
  assert.ok(!JSON.stringify(proposal).includes('unrelated-decision-value'));
});

test('non-owned adapter fields are not copied into proposal evidence', () => {
  const current = agent({ adapterConfig: {
    model: 'claude-haiku-5-5', effort: 'max', env: {},
    promptTemplate: 'unrelated-private-prompt', cwd: '/unrelated-private-workspace',
  } });
  const proposal = seam('buildAgentProposal')({ agent: current, decision, cap: 7 });
  assert.equal(proposal.status, 'proposed');
  // The official PATCH shallow-merges adapterConfig when replaceAdapterConfig
  // is absent (server/src/routes/agents.ts:5623-5627 at the pinned revision).
  assert.equal(proposal.patch.replaceAdapterConfig, undefined);
  assert.equal(proposal.patch.adapterConfig.promptTemplate, undefined);
  assert.equal(proposal.patch.adapterConfig.cwd, undefined);
  const effective = { ...current.adapterConfig, ...proposal.patch.adapterConfig };
  assert.equal(effective.promptTemplate, 'unrelated-private-prompt');
  assert.equal(effective.cwd, '/unrelated-private-workspace');
  assert.ok(!JSON.stringify(proposal).includes('unrelated-private-'));
});

test('replaced env and runtime objects preserve existing non-owned configuration', () => {
  const current = agent({
    adapterConfig: { model: 'claude-haiku-5-5', effort: 'max', env: { TZ: 'UTC', KEEP_ME: 'present' } },
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 120, maxConcurrentRuns: 2 }, session: { persist: true } },
  });
  const before = structuredClone(current);
  const proposal = seam('buildAgentProposal')({ agent: current, decision, cap: 7 });
  assert.equal(proposal.status, 'proposed');
  // env and runtimeConfig are not recursively merged by the agent PATCH route.
  // These are benign fixture values, not resolved credentials or live config.
  assert.deepEqual(proposal.patch.adapterConfig.env, {
    TZ: 'UTC', KEEP_ME: 'present', ...decision.env,
  });
  assert.deepEqual(proposal.patch.runtimeConfig, {
    heartbeat: { enabled: true, intervalSec: 120, maxConcurrentRuns: 7 }, session: { persist: true },
  });
  assert.deepEqual(current, before);
});

test('a missing optional decision effort does not erase the configured effort', () => {
  const proposal = seam('buildAgentProposal')({ agent: agent(), decision: { kind: 'decide', model: 'gpt-6.1-sol' }, cap: 4 });
  assert.equal(proposal.status, 'proposed');
  assert.ok(!Object.hasOwn(proposal.patch.adapterConfig, 'effort') || proposal.patch.adapterConfig.effort === 'max');
});

test('a real cheapest-capable decision carries its context caps into the proposal', () => {
  const pick = decide({
    runId: 'run-a', agentId, role: 'doer', pointer: 0,
    ladderRungs: [{ rung: 0, arms: [
      { armId: 'sol-high', model: 'gpt-6.1-sol', effort: 'high', family: 'sol', Q: 60, C: 1, contextWindow: 890000 },
    ] }],
    fiveHourHeadroomPct: 0.8, burnPerRunPct: { 'sol-high': 0.01 }, reservePct: 0.05, accountId: 'account-a',
  });
  assert.equal(pick.kind, 'decide');
  const proposal = seam('buildAgentProposal')({ agent: agent(), decision: pick, cap: 3 });
  assert.equal(proposal.patch.adapterConfig.model, 'gpt-6.1-sol');
  assert.equal(proposal.patch.adapterConfig.effort, 'high');
  assert.equal(proposal.patch.adapterConfig.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '890000');
  assert.equal(proposal.patch.adapterConfig.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '870000');
});

for (const [existing, want] of [
  [{}, { model: 'gpt-6.1-sol', effort: 'high' }],
  [{ model: 'explicit-model' }, { model: 'explicit-model', effort: 'high' }],
  [{ effort: 'max' }, { model: 'gpt-6.1-sol', effort: 'max' }],
  [{ model: 'explicit-model', effort: 'max' }, { model: 'explicit-model', effort: 'max' }],
]) {
  test(`issue precedence preserves explicit keys ${Object.keys(existing).join(',') || '(none)'}`, () => {
    const overrides = frozen({ ...existing, unrelated: { keep: true } });
    const result = seam('buildIssueModelOverrides')({ model: 'gpt-6.1-sol', effort: 'high' }, overrides);
    assert.deepEqual(result, { ...want, unrelated: { keep: true } });
    assert.deepEqual(overrides, { ...existing, unrelated: { keep: true } });
  });
}

test('issue override builder never forwards decision env or extra authority', () => {
  const result = seam('buildIssueModelOverrides')({ ...decision, permissions: { canCreateAgents: true } }, {});
  assert.deepEqual(result, { model: 'gpt-6.1-sol', effort: 'high' });
});

// All transports here are traps. No credentials are read, no URL is contacted,
// and these tests do not enable or qualify a future write implementation.
function isolatedContext(t) {
  const accessed = [];
  const ctx = {};
  for (const key of ['http', 'secrets', 'agents']) {
    Object.defineProperty(ctx, key, { get() {
      accessed.push(key);
      throw new Error(`propose-only accessed ctx.${key}`);
    } });
  }
  t.mock.method(globalThis, 'fetch', () => {
    accessed.push('fetch');
    throw new Error('propose-only attempted a network request');
  });
  return { ctx, accessed };
}

const proposal = {
  agentId, companyId, status: 'proposed', reason: 'capacity proposal',
  patch: { adapterConfig: { model: 'gpt-6.1-sol', effort: 'high' }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } },
};
for (const config of [undefined, {}, { enforce: true }, { mode: 'apply', enforce: true, upstream: { mode: 'apply', enforce: true } }]) {
  test(`release gate blocks writes for config ${JSON.stringify(config)}`, async t => {
    const { ctx, accessed } = isolatedContext(t);
    await seam('applyAgentProposal')({ ctx, companyId, proposal: structuredClone(proposal), config });
    assert.deepEqual(accessed, [], 'the release gate runs before transports and secrets');
  });
}
for (const [label, candidate] of [
  ['foreign company', { ...proposal, companyId: 'company-b' }],
  ['foreign config fields', { ...proposal, patch: { status: 'paused', permissions: { canCreateAgents: true } } }],
  ['secret env value', { ...proposal, patch: { adapterConfig: { env: { API_KEY: 'synthetic-secret-marker' } } } }],
  ['URL-shaped agent id', { ...proposal, agentId: 'https://example.invalid/api/agents/other' }],
  ['traversal-shaped agent id', { ...proposal, agentId: '../other/pause?token=synthetic-secret-marker' }],
]) {
  test(`propose-only cannot transport ${label}`, async t => {
    const { ctx, accessed } = isolatedContext(t);
    let evidence;
    try {
      evidence = await seam('applyAgentProposal')({ ctx, companyId, proposal: candidate, config: { enforce: true } });
    } catch (error) {
      // Rejecting malformed proposals is allowed, but not leaking their values.
      if (error.code === 'ERR_ASSERTION') throw error;
      evidence = { message: error.message };
    }
    assert.deepEqual(accessed, []);
    assert.ok(!JSON.stringify(evidence ?? null).includes('synthetic-secret-marker'));
  });
}
for (const baseUrl of ['http://localhost:3100', 'http://[::1]:3100', 'https://example.invalid']) {
  test(`release gate cannot be bypassed with baseUrl ${baseUrl}`, async t => {
    const { ctx, accessed } = isolatedContext(t);
    await seam('applyAgentProposal')({ ctx, companyId, proposal, config: { enforce: true, baseUrl, upstream: { baseUrl, mode: 'apply' } } });
    assert.deepEqual(accessed, []);
  });
}
