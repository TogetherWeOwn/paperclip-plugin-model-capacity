import { withSyntheticReadiness, syntheticAvailability } from './synthetic-readiness.mjs';
import { createBreakerStore, recordArmFailure, breakerStoreToJSON, sanitizeBreakers } from '../src/breakers.mjs';

const NOW = Date.parse('2026-10-30T04:00:00Z');
const key = name => ({ scopeKind: 'company', scopeId: 'parity', namespace: 'model-capacity', stateKey: name });
const metrics = n => ({ terminalbenchV40: n, scicode: n, lcr: n, ifbench: n, omniscienceNonHallucination: n, hle: 1-n, gpqa: 1-n, critpt: 1-n, gdpvalNormalized: 1-n });
const rows = [
  { slug: 'gpt-6-1-sol', intelligenceIndex: 60, intelligenceIndexCostPerTask: 5, ...metrics(.8) },
  { slug: 'gpt-6-1-sol-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 3, ...metrics(.7) },
  { slug: 'kimi-k3', intelligenceIndex: 50, intelligenceIndexCostPerTask: 1, ...metrics(.6) },
];
const account = (provider, accountKey, models, extra = {}) => ({ provider, accountKey, models, health: 'healthy', meter: 'reactive', quality: 'reactive', weekly: { used: .1, resetsAt: new Date(NOW + 7 * 86400000).toISOString() }, fiveHour: { used: .1, resetsAt: new Date(NOW + 4 * 3600000).toISOString() }, observedAt: new Date(NOW).toISOString(), ...extra });

export async function runDevinParity(factory, extra = {}) {
  const cases = {};
  for (const name of ['twins', 'account-free-legacy', 'account-free-task', 'task-order', 'manual-outage', 'dominated-drop-shared-rung']) {
    let accounts = name === 'twins'
      ? [account('codex', 'native', ['gpt-6.1-sol'], { meter: 'live', quality: 'live' }), account('devin', 'aggregate', ['devin/gpt-6-1-sol', 'devin/swe-2'])]
      : [account('codex', 'native', ['gpt-6.1-sol'], { meter: 'live', quality: 'live', ...(name.startsWith('account-free') ? { plan: 'free' } : {}) }), account('devin', 'aggregate', ['devin/kimi-k3'])];
    if (name === 'manual-outage') accounts[0].models.push('glm-5');
    if (name === 'dominated-drop-shared-rung') {
      accounts = [account('codex', 'native', ['gpt-6.1-sol'], { meter: 'live', quality: 'live' }),
        account('devin', 'aggregate', ['devin/kimi-k3', 'devin/glm-5', 'devin/deepseek-v4-pro', 'devin/gpt-5.6-sol'])];
      const evidence = syntheticAvailability(accounts[1], NOW, { models: ['kimi-k3', 'glm-5', 'deepseek-v4-pro', 'gpt-5.6-sol'] });
      evidence.models.find(m => m.model === 'kimi-k3').readyCredentials = 0;
      accounts[1].credentialAvailability = evidence;
    }
    const caseRows = name === 'dominated-drop-shared-rung' ? [
      { slug: 'kimi-k3', intelligenceIndex: 50, intelligenceIndexCostPerTask: 1, ...metrics(.5) },
      { slug: 'glm-5', intelligenceIndex: 40, intelligenceIndexCostPerTask: 2, ...metrics(.3) },
      { slug: 'deepseek-v4-pro', intelligenceIndex: 45, intelligenceIndexCostPerTask: 3, ...metrics(.4) },
      { slug: 'gpt-5-6-sol', intelligenceIndex: 55, intelligenceIndexCostPerTask: 8, ...metrics(.7) },
      { slug: 'gpt-6-1-sol', intelligenceIndex: 60, intelligenceIndexCostPerTask: 5, ...metrics(.8) },
    ] : [...rows, { slug: 'glm-5', intelligenceIndex: 45, intelligenceIndexCostPerTask: 2, ...metrics(.5) }];
    const mode = ['account-free-task', 'task-order'].includes(name) ? 'enforce' : 'off';
    const config = { enforce: true, calibration: { referenceArmId: 'gpt-6-1-sol', referenceBurnPerRunPct: .0005 }, pacing: { guard: { enabled: false } },
      ...(name === 'dominated-drop-shared-rung' ? { credentialReadiness: { enforce: true } } : {}), cliproxy: { laneKeySecretRef: { type: 'secret_ref', secretId: 'test' } },
      roles: { doerAgentIds: ['builder'], minQuality: { doer: null, thinker: null, other: null }, ...(name === 'manual-outage' ? { excludeFamilies: { doer: ['sol'] } } : {}) },
      trials: { roles: ['doer'], adapters: { 'claude-code': ['*'] }, maxInFlightPerAccount: 8, ...extra.trials },
      placement: { ...(name.startsWith('account-free') ? { freeCostProviders: ['codex'] } : {}), ...extra.placement },
      taskRanking: { mode }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['trials', 'placement'].includes(k))) };
    const lane = { observedAt: new Date(NOW).toISOString(), servedModels: accounts.flatMap(a => a.models), accounts };
    const store = new Map(), jobs = new Map();
    const ctx = { config: { get: async () => config }, state: { get: async k => store.get(JSON.stringify(k)) ?? null, set: async (k,v) => store.set(JSON.stringify(k),v) },
      secrets: { resolve: async () => 'test' }, http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { devin: ['devin/gpt-6-1-sol', 'devin/swe-2', 'devin/kimi-k3', 'gpt-6-1-sol', 'swe-2', 'kimi-k3'] } }) }) },
      agents: { get: async () => ({ adapterType: 'claude-code' }) }, issues: { get: async () => null, list: async () => [] },
      jobs: { register: (n,f) => jobs.set(n,f) }, events: { on() {} }, logger: { info() {}, error() {}, warn() {} } };
    const plugin = factory({ clock: () => NOW, requirePinnedLaneHost: false });
    await plugin.setup(ctx);
    store.set(JSON.stringify(key('aa-snapshot-v1')), { fetchedAt: new Date(NOW).toISOString(), rows: caseRows, duplicateSlugs: [] });
    if (name === 'manual-outage') {
      const breakers = createBreakerStore(), cfg = sanitizeBreakers();
      for (const atMs of [NOW - 120000, NOW - 60000]) recordArmFailure(breakers, 'devin:aggregate', 'kimi-k3', { atMs, errorText: 'model not found' }, atMs, cfg);
      store.set(JSON.stringify(key('breaker-v1')), breakerStoreToJSON(breakers, { nowMs: NOW, cfg }));
    }
    await plugin.onConfigChanged(config, { companyId: 'parity' });
    await jobs.get('shadow-tick')({});
    const hook = await plugin.onResolveRunModel({ runId: 'hook', companyId: 'parity', agentId: 'builder', adapterType: 'claude-code', deadlineMs: 1500 });
    const capacity = (await plugin.onApiRequest({ companyId: 'parity', routeKey: 'capacity' })).body;
    const ladder = (await plugin.onApiRequest({ companyId: 'parity', routeKey: 'ladder' })).body;
    const shadow = (await plugin.onApiRequest({ companyId: 'parity', routeKey: 'shadow' })).body;
    cases[name] = {
      hook: { kind: hook?.kind ?? null, model: hook?.model ?? null, effort: hook?.effort ?? null, reason: hook?.reason ?? null },
      ladders: Object.fromEntries(Object.entries(ladder.ladders ?? {}).sort(([a],[b]) => a.localeCompare(b)).map(([id,l]) => [id, (l.rungs ?? []).map(r => ({ armId: r.armId, rung: r.rung }))])),
      shadow: (shadow.entries ?? []).map(e => ({ runId: e.runId, accountId: e.accountId ?? null, armId: e.armId ?? null, wouldModel: e.wouldModel ?? null, reason: e.reason ?? null })).sort((a,b) => a.runId.localeCompare(b.runId)),
      ...(name === 'dominated-drop-shared-rung' ? { dominated: ladder.ladders?.['devin:aggregate']?.crossAccountDominated ?? [] } : {}),
      eligibility: capacity.eligibility ? { roles: capacity.eligibility.roles ?? null, warnings: capacity.eligibility.warnings ?? null } : null,
      taskCandidates: (capacity.taskRanking?.candidates ?? []).map(c => ({ armId: c.armId, role: c.role, C: c.C ?? null, cashUsdPerAcceptedTask: c.cashUsdPerAcceptedTask ?? null, selectionReason: c.selectionReason ?? null })),
    };
  }
  return cases;
}
