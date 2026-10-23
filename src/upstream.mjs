import { isDeepStrictEqual } from 'node:util';
import official from './official-capabilities.json' with { type: 'json' };

export const OFFICIAL_TARGET = Object.freeze({ tag: official.tag, commit: official.commit });
export const OWNED_ENV_KEYS = Object.freeze([
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
]);
// This release cannot actuate. Enabling writes needs a separately reviewed
// identity/field/custody contract; configuration alone cannot open this gate.
export const WRITE_ACTUATOR_ENABLED = false;
const officialCapabilities = new Set(official.capabilities);
const record = value => value != null && typeof value === 'object' && !Array.isArray(value);

export function assertOfficialManifest(manifest) {
  if (!Array.isArray(manifest?.capabilities) || manifest.capabilities.length === 0) {
    throw new Error('official-manifest-capabilities-required');
  }
  const unknown = manifest.capabilities.filter(capability => !officialCapabilities.has(capability));
  if (unknown.length > 0) throw new Error(`official-manifest-unknown-capability: ${unknown.join(', ')}`);
  if ('modelRouting' in manifest) throw new Error('official-manifest-unsupported-model-routing');
  return true;
}

/** A transient PATCH candidate, never itself persisted or returned by the API. */
export function buildAgentProposal({ agent, decision, cap } = {}) {
  const result = (status, reason, patch = null) => ({
    agentId: agent?.id ?? null, companyId: agent?.companyId ?? null, status, patch, reason,
  });
  if (!agent?.id || !agent?.companyId) return result('hold', 'agent-context-required');
  if (!Number.isFinite(cap) || cap < 1) return result('hold', 'cap-below-one-is-not-off');
  if (!decision || !['decide', 'keep'].includes(decision.kind)) {
    return result('hold', decision?.kind === 'defer' ? 'selection-deferred' : 'selection-unavailable');
  }
  if (!record(agent.adapterConfig ?? {}) || !record(agent.runtimeConfig ?? {})) {
    return result('hold', 'invalid-agent-config');
  }
  const adapter = agent.adapterConfig ?? {};
  const runtime = agent.runtimeConfig ?? {};
  if (!record(adapter.env ?? {}) || !record(runtime.heartbeat ?? {})) {
    return result('hold', 'invalid-agent-config');
  }
  const patch = {};
  if (decision.kind === 'decide') {
    if (typeof decision.model !== 'string' || !decision.model.trim() || /[\r\n]/.test(decision.model)) {
      return result('hold', 'invalid-selected-model');
    }
    if (!record(decision.env ?? {}) || Object.keys(decision.env ?? {}).some(key => !OWNED_ENV_KEYS.includes(key))) {
      return result('hold', 'unowned-env-key');
    }
    if (Object.values(decision.env ?? {}).some(value => typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) <= 0)) {
      return result('hold', 'invalid-context-cap');
    }
    const next = {};
    if (adapter.model !== decision.model) next.model = decision.model;
    if (decision.effort != null) {
      if (typeof decision.effort !== 'string' || !decision.effort.trim() || /[\r\n]/.test(decision.effort)) {
        return result('hold', 'invalid-selected-effort');
      }
      if (adapter.effort !== decision.effort) next.effort = decision.effort;
    }
    // Official agent PATCH shallow-merges adapterConfig, but replaces env.
    // Preserve all unrelated bindings in memory; summaries expose owned keys only.
    const env = { ...(adapter.env ?? {}) };
    for (const key of OWNED_ENV_KEYS) delete env[key];
    Object.assign(env, decision.env ?? {});
    if (!isDeepStrictEqual(env, adapter.env ?? {})) next.env = env;
    if (Object.keys(next).length > 0) patch.adapterConfig = next;
  }
  const maxConcurrentRuns = Math.max(1, Math.min(50, Math.floor(cap)));
  if (runtime.heartbeat?.maxConcurrentRuns !== maxConcurrentRuns) {
    patch.runtimeConfig = { ...runtime, heartbeat: { ...(runtime.heartbeat ?? {}), maxConcurrentRuns } };
  }
  return Object.keys(patch).length === 0
    ? result(decision.kind === 'keep' ? 'kept' : 'noop', 'already-current')
    : result('proposed', 'patch-on-change', patch);
}

/** Safe to persist: no existing env, runtime config, credentials or secret refs. */
export function summarizeAgentProposal(proposal) {
  const adapter = proposal.patch?.adapterConfig;
  const env = adapter?.env;
  return {
    agentId: proposal.agentId, companyId: proposal.companyId,
    status: proposal.status, reason: proposal.reason,
    model: adapter?.model ?? null,
    effort: adapter?.effort ?? null,
    env: env == null ? null : Object.fromEntries(OWNED_ENV_KEYS.map(key => [key, env[key] ?? null])),
    maxConcurrentRuns: proposal.patch?.runtimeConfig?.heartbeat?.maxConcurrentRuns ?? null,
    writeEnabled: false,
  };
}

/** Existing per-card model/effort pins always outrank the proposed defaults. */
export function buildIssueModelOverrides({ model, effort } = {}, existingOverrides = {}) {
  const adapterConfig = { ...(model == null ? {} : { model }), ...(effort == null ? {} : { effort }),
    ...(existingOverrides?.adapterConfig ?? {}) };
  return { ...(existingOverrides ?? {}), adapterConfig };
}

/** No credential resolution, HTTP, managed-agent substitution or pause/unpause. */
export async function applyAgentProposal({ companyId, proposal } = {}) {
  if (!companyId || companyId !== proposal?.companyId) {
    return { status: 'hold', reason: 'company-mismatch', writeEnabled: false };
  }
  if (proposal.status !== 'proposed') {
    return { status: proposal.status, reason: proposal.reason, writeEnabled: false };
  }
  return { status: 'hold', reason: 'actuator-authority-not-qualified', writeEnabled: false };
}
