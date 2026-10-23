/**
 * Upstream mode (0.2.67): the model-capacity actuator for a stock Paperclip
 * host, which has no per-run model hook (`run.model.resolve` is fork-only and
 * upstream's manifest validator rejects unknown capabilities).
 *
 * Each tick the plugin proposes, per agent, what the per-run hook would decide
 * for a fresh run of that agent right now: `{ model, effort, routing env }`,
 * plus the agent's `heartbeat.maxConcurrentRuns`. Upstream applies an agent's
 * `adapterConfig` at run start, so writing the proposal onto the agent through
 * the public API (`PATCH /api/agents/:id`) is the native way to choose a run's
 * model. Issue `assigneeAdapterOverrides` pins still win natively; the plugin
 * never writes them.
 *
 * Modes (`upstreamMode`):
 *   off      nothing new runs (default).
 *   shadow   proposals and the would-PATCH diff are computed and recorded every
 *            tick, and every live hook answer is scored against the proposal
 *            for its agent. Nothing is written to any agent.
 *   enforce  proposals are applied: GET the agent, PATCH only what changed.
 *
 * Everything here is pure (no I/O) except `createUpstreamApi`, which only
 * wraps the fetch it is given.
 */
import { MODEL_ROUTING_ENV_KEYS } from './manifest.mjs';

export const UPSTREAM_MODES = Object.freeze(['off', 'shadow', 'enforce']);
/** Env keys the actuator owns: the same keys the hook's decide answer carries. */
export const ROUTING_ENV_KEYS = Object.freeze([...MODEL_ROUTING_ENV_KEYS]);

export const UPSTREAM_DEFAULTS = Object.freeze({
  apiBaseUrl: null,
  apiKeySecretRef: null,
  maxPatchesPerTick: 12,
  holdAgentIds: Object.freeze([]),
  proposalMaxAgeMs: 150000,
  caps: Object.freeze({
    enabled: true,
    maxStepUp: 4,
    maxStepDown: 1,
    loadHoldPerCpu: 0.75,
    loadShedPerCpu: 1.15,
    burnFloor: null,
  }),
});

/** Agent statuses the actuator never touches (and never proposes for). */
const INACTIVE_STATUSES = new Set(['paused', 'terminated', 'pending_approval']);
const AGREEMENT_BUCKET_MS = 3600 * 1000;
const AGREEMENT_RETAIN_HOURS = 48;
const DISAGREEMENT_RING = 100;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isSecretRef = (v) => isObj(v) && v.type === 'secret_ref' && typeof v.secretId === 'string';

export function validateUpstream(mode, raw, { allowlist = [], enforceHook = false } = {}) {
  const errors = [];
  if (mode != null && !UPSTREAM_MODES.includes(mode)) errors.push(`upstreamMode must be one of: ${UPSTREAM_MODES.join(', ')}`);
  if (raw != null && !isObj(raw)) return [...errors, 'upstream must be an object'];
  const u = raw ?? {};
  if (u.apiBaseUrl != null && !allowlist.includes(u.apiBaseUrl)) {
    errors.push(`upstream.apiBaseUrl must be one of: ${allowlist.join(', ')}`);
  }
  if (u.apiKeySecretRef != null && !isSecretRef(u.apiKeySecretRef)) errors.push('upstream.apiKeySecretRef must be a secret_ref object');
  if (u.maxPatchesPerTick != null && !(Number.isInteger(u.maxPatchesPerTick) && u.maxPatchesPerTick >= 1 && u.maxPatchesPerTick <= 50)) {
    errors.push('upstream.maxPatchesPerTick must be an integer in [1, 50]');
  }
  if (u.holdAgentIds != null && !(Array.isArray(u.holdAgentIds) && u.holdAgentIds.every(x => typeof x === 'string' && x.length > 0))) {
    errors.push('upstream.holdAgentIds must be an array of agent ids');
  }
  if (u.proposalMaxAgeMs != null && !(Number.isInteger(u.proposalMaxAgeMs) && u.proposalMaxAgeMs >= 60000)) {
    errors.push('upstream.proposalMaxAgeMs must be an integer >= 60000');
  }
  if (u.caps != null) {
    if (!isObj(u.caps)) {
      errors.push('upstream.caps must be an object');
    } else {
      const c = u.caps;
      if ('enabled' in c && typeof c.enabled !== 'boolean') errors.push('upstream.caps.enabled must be a boolean');
      for (const k of ['maxStepUp', 'maxStepDown']) {
        if (k in c && !(Number.isInteger(c[k]) && c[k] >= 1 && c[k] <= 50)) errors.push(`upstream.caps.${k} must be an integer in [1, 50]`);
      }
      for (const k of ['loadHoldPerCpu', 'loadShedPerCpu']) {
        if (k in c && !(typeof c[k] === 'number' && c[k] > 0)) errors.push(`upstream.caps.${k} must be a positive number`);
      }
      if ('loadHoldPerCpu' in c && 'loadShedPerCpu' in c && c.loadShedPerCpu < c.loadHoldPerCpu) {
        errors.push('upstream.caps.loadShedPerCpu must be >= upstream.caps.loadHoldPerCpu');
      }
      if ('burnFloor' in c && c.burnFloor !== null && !(Number.isInteger(c.burnFloor) && c.burnFloor >= 1 && c.burnFloor <= 50)) {
        errors.push('upstream.caps.burnFloor must be null or an integer in [1, 50]');
      }
    }
  }
  // One actuator at a time: the per-run hook and the agent writer must never
  // both steer a company. On a stock host the hook does not exist, so the
  // cutover sets enforce false and upstreamMode enforce in one config write.
  if (mode === 'enforce' && enforceHook === true) errors.push('upstreamMode enforce requires enforce false (one actuator at a time)');
  if (mode === 'enforce' && !isSecretRef(u.apiKeySecretRef)) errors.push('upstreamMode enforce requires upstream.apiKeySecretRef');
  return errors;
}

export function normalizeUpstream(mode, raw, { allowlist = [] } = {}) {
  const u = isObj(raw) ? raw : {};
  const c = isObj(u.caps) ? u.caps : {};
  const d = UPSTREAM_DEFAULTS;
  return {
    mode: UPSTREAM_MODES.includes(mode) ? mode : 'off',
    apiBaseUrl: allowlist.includes(u.apiBaseUrl) ? u.apiBaseUrl : (allowlist[0] ?? null),
    apiKeySecretRef: isSecretRef(u.apiKeySecretRef) ? u.apiKeySecretRef : null,
    maxPatchesPerTick: Number.isInteger(u.maxPatchesPerTick) ? u.maxPatchesPerTick : d.maxPatchesPerTick,
    holdAgentIds: Array.isArray(u.holdAgentIds) ? u.holdAgentIds.filter(x => typeof x === 'string') : [],
    proposalMaxAgeMs: Number.isInteger(u.proposalMaxAgeMs) ? u.proposalMaxAgeMs : d.proposalMaxAgeMs,
    caps: {
      enabled: typeof c.enabled === 'boolean' ? c.enabled : d.caps.enabled,
      maxStepUp: Number.isInteger(c.maxStepUp) ? c.maxStepUp : d.caps.maxStepUp,
      maxStepDown: Number.isInteger(c.maxStepDown) ? c.maxStepDown : d.caps.maxStepDown,
      loadHoldPerCpu: typeof c.loadHoldPerCpu === 'number' ? c.loadHoldPerCpu : d.caps.loadHoldPerCpu,
      loadShedPerCpu: typeof c.loadShedPerCpu === 'number' ? c.loadShedPerCpu : d.caps.loadShedPerCpu,
      burnFloor: Number.isInteger(c.burnFloor) ? c.burnFloor : null,
    },
  };
}

/** True for an agent the actuator may propose for: active and on the Claude CLI. */
export function actuatableAgent(agent, claudeAdapters) {
  if (!isObj(agent) || typeof agent.id !== 'string') return false;
  if (INACTIVE_STATUSES.has(agent.status)) return false;
  return claudeAdapters.has(agent.adapterType ?? agent.adapter_type);
}

/**
 * Plain string value of one env entry, or null when absent. Entries are plain
 * strings or `{ type: 'plain', value }`; anything else (a secret binding) is
 * reported as an opaque marker and never as its content.
 */
export function envEntryValue(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (isObj(entry) && entry.type === 'plain' && entry.value != null) return String(entry.value);
  return '<non-plain>';
}

function adapterConfigOf(agent) {
  return isObj(agent?.adapterConfig) ? agent.adapterConfig : (isObj(agent?.adapter_config) ? agent.adapter_config : {});
}

function runtimeConfigOf(agent) {
  return isObj(agent?.runtimeConfig) ? agent.runtimeConfig : (isObj(agent?.runtime_config) ? agent.runtime_config : {});
}

/** The slice of an agent's config the actuator owns: model, effort, routing env, run cap. */
export function agentRoutingConfig(agent) {
  const ac = adapterConfigOf(agent);
  const env = isObj(ac.env) ? ac.env : {};
  const hb = isObj(runtimeConfigOf(agent).heartbeat) ? runtimeConfigOf(agent).heartbeat : {};
  const cap = Number(hb.maxConcurrentRuns);
  return {
    model: typeof ac.model === 'string' && ac.model.length > 0 ? ac.model : null,
    effort: typeof ac.effort === 'string' && ac.effort.length > 0 ? ac.effort : null,
    env: Object.fromEntries(ROUTING_ENV_KEYS.map(k => [k, envEntryValue(env[k])])),
    maxConcurrentRuns: Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1,
    wakeOnDemand: hb.wakeOnDemand !== false,
  };
}

/**
 * What the agent config should be under a proposal, given the agent's base
 * (its own config before the actuator touched it). Mirrors the hook's merge
 * exactly: a decide sets model, sets effort only when the answer has one, and
 * overlays its env per key on the base env; a keep runs the base config.
 * A hold (the hook would defer) changes nothing: returns null.
 */
export function desiredRoutingConfig(base, proposal) {
  if (!proposal || proposal.kind === 'hold') return null;
  if (proposal.kind === 'keep') return { model: base.model, effort: base.effort, env: { ...base.env } };
  const env = { ...base.env };
  for (const k of ROUTING_ENV_KEYS) {
    const v = proposal.env?.[k];
    if (v != null) env[k] = String(v);
  }
  return {
    model: proposal.model,
    effort: proposal.effort != null ? proposal.effort : base.effort,
    env,
  };
}

/** Field-level diff of the routing slice (model, effort, each routing env key). */
export function diffRoutingConfig(current, desired) {
  if (!desired) return [];
  const out = [];
  if ((current.model ?? null) !== (desired.model ?? null)) out.push({ field: 'model', from: current.model ?? null, to: desired.model ?? null });
  if ((current.effort ?? null) !== (desired.effort ?? null)) out.push({ field: 'effort', from: current.effort ?? null, to: desired.effort ?? null });
  for (const k of ROUTING_ENV_KEYS) {
    const a = current.env?.[k] ?? null;
    const b = desired.env?.[k] ?? null;
    if (a !== b) out.push({ field: `env.${k}`, from: a, to: b });
  }
  return out;
}

/**
 * Next `maxConcurrentRuns` for one agent: the interim host cap helper's
 * algorithm (step-limited, deadbanded, load-guarded), moved into the plugin so
 * the plugin stays the only pacer. Returns { from, to, want, reason } or null
 * when the agent is not cap-managed.
 *   - up moves are at most maxStepUp per tick and hold while the 5-min load
 *     average is at/above loadHoldPerCpu x CPUs (review agents climb until the
 *     shed line); an unknown load holds every up move (fail closed);
 *   - at/above loadShedPerCpu x CPUs non-review agents shed one run (a quarter
 *     of the cap at 1.5 x CPUs);
 *   - down moves are at most maxStepDown per tick, except pinned (kept) agents,
 *     which follow the plugin's want straight down (never below 1; the want
 *     never drops below the agent's running count, so nothing is cancelled);
 *   - a one-run dip below the current cap is queue noise (deadband).
 */
export function planCapChange({ current, want, isReview = false, isPinned = false, isDoer = false, load = null, cfg }) {
  if (!Number.isFinite(want)) return null;
  const cur = Math.max(1, Math.floor(current));
  let w = Math.max(1, Math.floor(want));
  if (cfg.burnFloor != null && isDoer && !isReview) w = Math.max(w, cfg.burnFloor);
  const known = load != null && Number.isFinite(load.load5) && Number.isFinite(load.cpus) && load.cpus > 0;
  const hold = known ? cfg.loadHoldPerCpu * load.cpus : null;
  const shed = known ? cfg.loadShedPerCpu * load.cpus : null;
  let up = known && load.load5 < hold ? cfg.maxStepUp : 0;
  if (isReview && known && load.load5 < shed) up = cfg.maxStepUp;
  let shedding = false;
  if (known && load.load5 >= shed && !isReview && cur > 1) {
    const step = load.load5 >= 1.5 * load.cpus ? Math.max(1, Math.floor(cur / 4)) : 1;
    w = Math.min(w, cur - step);
    shedding = w < cur;
  }
  if (cur - 1 <= w && w < cur && !shedding) return { from: cur, to: cur, want: w, reason: 'deadband' };
  const down = isPinned ? cur : (shedding ? Math.max(cfg.maxStepDown, cur - w) : cfg.maxStepDown);
  const to = Math.max(1, cur + Math.max(-down, Math.min(up, w - cur)));
  const reason = to === cur
    ? (w > cur ? (known ? 'load-hold' : 'load-unknown') : 'at-want')
    : (shedding ? 'load-shed' : (to > cur ? 'up' : 'down'));
  return { from: cur, to, want: w, reason };
}

/**
 * PATCH body for one agent from its API read (env secrets arrive redacted and
 * the server restores redacted placeholders on write). adapterConfig merges
 * shallowly on the server, so only changed top-level keys are sent; env is a
 * single top-level key, so it is sent whole with only the routing keys edited
 * (each in the shape its existing entry uses). runtimeConfig replaces on the
 * server, so it is sent whole with only heartbeat.maxConcurrentRuns edited.
 * Returns null when nothing would change.
 */
export function buildAgentPatch(apiAgent, desired, nextCap = null) {
  const ac = adapterConfigOf(apiAgent);
  const cur = agentRoutingConfig(apiAgent);
  const body = {};
  if (desired) {
    const adapterConfig = {};
    if ((cur.model ?? null) !== (desired.model ?? null) && desired.model != null) adapterConfig.model = desired.model;
    if ((cur.effort ?? null) !== (desired.effort ?? null)) adapterConfig.effort = desired.effort ?? null;
    const envChanged = ROUTING_ENV_KEYS.some(k => (cur.env[k] ?? null) !== (desired.env?.[k] ?? null));
    if (envChanged) {
      const env = { ...(isObj(ac.env) ? ac.env : {}) };
      for (const k of ROUTING_ENV_KEYS) {
        const next = desired.env?.[k] ?? null;
        if ((cur.env[k] ?? null) === next) continue;
        if (next == null) {
          delete env[k];
        } else {
          const prev = env[k];
          env[k] = isObj(prev) && prev.type === 'plain' ? { ...prev, value: next } : (isObj(prev) || prev == null ? { type: 'plain', value: next } : next);
        }
      }
      adapterConfig.env = env;
    }
    if (Object.keys(adapterConfig).length > 0) body.adapterConfig = adapterConfig;
  }
  if (nextCap != null && nextCap !== cur.maxConcurrentRuns) {
    const rc = runtimeConfigOf(apiAgent);
    body.runtimeConfig = { ...rc, heartbeat: { ...(isObj(rc.heartbeat) ? rc.heartbeat : {}), maxConcurrentRuns: nextCap } };
  }
  return Object.keys(body).length > 0 ? body : null;
}

/**
 * Public-API client for the actuator. `fetch` is the plugin's ctx.http.fetch
 * (it refuses loopback, hence the public origin). The key travels only to the
 * pinned origin; errors carry status codes, never response bodies.
 */
export function createUpstreamApi({ fetch, baseUrl, apiKey, reason = 'model-capacity upstream actuator' }) {
  if (typeof baseUrl !== 'string' || !/^https:\/\//.test(baseUrl)) throw new Error('upstream-api-base-url-invalid');
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('upstream-api-key-missing');
  const url = (path) => `${baseUrl.replace(/\/+$/, '')}/api${path}`;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Paperclip-Change-Reason': reason };
  const call = async (method, path, body) => {
    const res = await fetch(url(path), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const status = Number(res?.status);
    if (!(status >= 200 && status < 300)) {
      const err = new Error(`upstream-api-${method.toLowerCase()}-${Number.isFinite(status) ? status : 'error'}`);
      err.status = status;
      throw err;
    }
    return typeof res.json === 'function' ? res.json() : null;
  };
  return {
    getAgent: (agentId) => call('GET', `/agents/${encodeURIComponent(agentId)}`),
    patchAgent: (agentId, body) => call('PATCH', `/agents/${encodeURIComponent(agentId)}`, body),
  };
}

// ---------------------------------------------------------------------------
// Shadow agreement: every live hook answer scored against the proposal the
// last tick made for the same agent. Hourly buckets (48 h retained) give a
// rolling window; a bounded ring keeps the latest disagreements for review.
// ---------------------------------------------------------------------------

export const AGREEMENT_OUTCOMES = Object.freeze(['agree', 'disagree', 'deferred', 'issuePinned', 'noProposal']);

export function createAgreement(nowMs) {
  return { version: 1, sinceMs: nowMs, hours: {}, disagreements: [], deferHeld: 0 };
}

/**
 * Score one hook answer. `proposal` is the agent's latest proposal or null.
 *   issue-pinned run                 -> issuePinned (native precedence, not scored)
 *   no fresh proposal for the agent  -> noProposal
 *   hook defer                       -> deferred (a defer is a cap/quota hold upstream)
 *   hook decide/keep                 -> agree when the emitted model (and effort,
 *                                       when the hook set one) equals the proposal's
 * Returns the outcome; mutates `state`.
 */
export function scoreHookAnswer(state, { nowMs, params, answer, proposal, maxAgeMs }) {
  let outcome;
  let detail = null;
  const fresh = proposal && Number.isFinite(proposal.atMs) && nowMs - proposal.atMs <= maxAgeMs && nowMs >= proposal.atMs;
  if (typeof params?.issueOverrideModel === 'string' && params.issueOverrideModel.length > 0) {
    outcome = 'issuePinned';
  } else if (!fresh) {
    outcome = 'noProposal';
  } else if (answer?.kind === 'defer') {
    outcome = 'deferred';
    if (proposal.kind === 'hold') state.deferHeld = (state.deferHeld ?? 0) + 1;
  } else {
    const hookModel = answer?.kind === 'decide' ? answer.model ?? null : (params?.agentDefaultModel ?? null);
    const hookEffort = answer?.kind === 'decide' ? answer.effort ?? null : null;
    const propModel = proposal.kind === 'decide' ? proposal.model ?? null
      : proposal.kind === 'keep' ? (params?.agentDefaultModel ?? proposal.model ?? null) : null;
    const propEffort = proposal.kind === 'decide' ? proposal.effort ?? null : null;
    const same = hookModel != null && hookModel === propModel && (hookEffort == null || hookEffort === propEffort);
    outcome = same ? 'agree' : 'disagree';
    if (!same) {
      detail = {
        atMs: nowMs,
        runId: params?.runId != null ? String(params.runId) : null,
        agentId: params?.agentId ?? null,
        hook: { kind: answer?.kind ?? null, model: hookModel, effort: hookEffort, reason: String(answer?.reason ?? '').slice(0, 160) },
        proposal: { kind: proposal.kind, model: propModel, effort: propEffort, ageMs: nowMs - proposal.atMs, reason: String(proposal.reason ?? '').slice(0, 160) },
      };
    }
  }
  const hour = String(Math.floor(nowMs / AGREEMENT_BUCKET_MS) * AGREEMENT_BUCKET_MS);
  const b = state.hours[hour] ?? (state.hours[hour] = { agree: 0, disagree: 0, deferred: 0, issuePinned: 0, noProposal: 0 });
  b[outcome] += 1;
  if (detail) {
    state.disagreements.push(detail);
    if (state.disagreements.length > DISAGREEMENT_RING) state.disagreements.splice(0, state.disagreements.length - DISAGREEMENT_RING);
  }
  const cutoff = nowMs - AGREEMENT_RETAIN_HOURS * AGREEMENT_BUCKET_MS;
  for (const k of Object.keys(state.hours)) if (Number(k) < cutoff - AGREEMENT_BUCKET_MS) delete state.hours[k];
  return outcome;
}

/** Totals over the last `windowHours` (whole hourly buckets) and since the start. */
export function summarizeAgreement(state, nowMs, windowHours = 24) {
  const zero = () => ({ agree: 0, disagree: 0, deferred: 0, issuePinned: 0, noProposal: 0 });
  const win = zero();
  const all = zero();
  const from = Math.floor(nowMs / AGREEMENT_BUCKET_MS) * AGREEMENT_BUCKET_MS - (windowHours - 1) * AGREEMENT_BUCKET_MS;
  for (const [k, b] of Object.entries(state?.hours ?? {})) {
    for (const o of AGREEMENT_OUTCOMES) {
      all[o] += b[o] ?? 0;
      if (Number(k) >= from) win[o] += b[o] ?? 0;
    }
  }
  const pct = (t) => (t.agree + t.disagree > 0 ? Math.round((t.agree / (t.agree + t.disagree)) * 10000) / 100 : null);
  return {
    sinceMs: state?.sinceMs ?? null,
    windowHours,
    window: { ...win, scored: win.agree + win.disagree, agreementPct: pct(win) },
    retained: { ...all, scored: all.agree + all.disagree, agreementPct: pct(all) },
    deferHeld: state?.deferHeld ?? 0,
  };
}

/** Agreement state from persisted JSON (tolerant: anything malformed restarts it). */
export function agreementFromJSON(raw, nowMs) {
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.hours)) return createAgreement(nowMs);
  return {
    version: 1,
    sinceMs: Number.isFinite(raw.sinceMs) ? raw.sinceMs : nowMs,
    hours: Object.fromEntries(Object.entries(raw.hours).filter(([k, b]) => Number.isFinite(Number(k)) && isObj(b))
      .map(([k, b]) => [k, Object.fromEntries(AGREEMENT_OUTCOMES.map(o => [o, Number.isFinite(b[o]) ? b[o] : 0]))])),
    disagreements: Array.isArray(raw.disagreements) ? raw.disagreements.slice(-DISAGREEMENT_RING) : [],
    deferHeld: Number.isFinite(raw.deferHeld) ? raw.deferHeld : 0,
  };
}

/** Merge memory counts into persisted ones (both hourly; sums per bucket). */
export function mergeAgreement(persisted, delta) {
  const out = { ...persisted, hours: { ...persisted.hours } };
  for (const [k, b] of Object.entries(delta.hours)) {
    const p = out.hours[k] ?? {};
    out.hours[k] = Object.fromEntries(AGREEMENT_OUTCOMES.map(o => [o, (p[o] ?? 0) + (b[o] ?? 0)]));
  }
  out.disagreements = [...(persisted.disagreements ?? []), ...delta.disagreements].slice(-DISAGREEMENT_RING);
  out.deferHeld = (persisted.deferHeld ?? 0) + (delta.deferHeld ?? 0);
  out.sinceMs = Math.min(persisted.sinceMs ?? delta.sinceMs, delta.sinceMs ?? persisted.sinceMs);
  return out;
}
