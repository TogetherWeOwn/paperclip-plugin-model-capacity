/**
 * Reviewer routing (pure): both Claude and Meta accounts may serve review
 * runs. Absent `reviewerRouting` the Reviewer keeps its configured adapter
 * model (roles.keepAgentIds -> hook answers keep), exactly as before.
 *
 * With `reviewerRouting: { agentIds?, arms: [{ provider, model, effort? }] }`
 * a run of a listed agent (default reviewReserve.agentIds) is routed to the
 * arm whose provider has a servable account, ranked:
 *   1. accounts flagged by burn mode (config `burnMode`, matched by account
 *      id, lane or label; absent key = nothing flagged)
 *   2. plan-funded headroom before credit-funded headroom
 *   3. the pool most behind its pace plan (most negative mean planAhead;
 *      unknown plan position counts as on-plan, 0)
 *   4. the pool with the most remaining quota per hour to reset
 *   5. arm order in config (operator preference)
 *   6. the lane with the fewest in-flight runs, then accountId
 * Servable = healthy, not excluded (weekly-exhausted), not floor-guarded,
 * headroom above the allocator reserve (reactive lanes on health alone),
 * serving the arm's model, the arm's family not excluded for the role and
 * its breaker not open. Same bar as computeReviewerCapacity, so reviewer
 * capacity and reviewer routing agree. No candidate -> null (caller keeps).
 */

import { hasHeadroom } from './cross-account.mjs';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const lc = (s) => String(s ?? '').trim().toLowerCase();

/** Config validation errors for raw.reviewerRouting (absent = none). */
export function validateReviewerRouting(raw) {
  const errors = [];
  if (raw == null) return errors;
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['reviewerRouting must be an object'];
  for (const k of Object.keys(raw)) {
    if (!['agentIds', 'arms', 'enabled'].includes(k)) errors.push(`reviewerRouting.${k} is not a known key`);
  }
  if ('enabled' in raw && typeof raw.enabled !== 'boolean') errors.push('reviewerRouting.enabled must be a boolean');
  if ('agentIds' in raw && raw.agentIds != null
    && (!Array.isArray(raw.agentIds) || raw.agentIds.some((s) => typeof s !== 'string' || s.length === 0))) {
    errors.push('reviewerRouting.agentIds must be an array of non-empty strings or null');
  }
  if (!Array.isArray(raw.arms) || raw.arms.length === 0) {
    errors.push('reviewerRouting.arms must be a non-empty array');
  } else {
    raw.arms.forEach((a, i) => {
      if (a == null || typeof a !== 'object' || Array.isArray(a)) {
        errors.push(`reviewerRouting.arms[${i}] must be an object`);
        return;
      }
      for (const k of Object.keys(a)) {
        if (!['provider', 'model', 'effort'].includes(k)) errors.push(`reviewerRouting.arms[${i}].${k} is not a known key`);
      }
      if (typeof a.provider !== 'string' || a.provider.trim().length === 0) {
        errors.push(`reviewerRouting.arms[${i}].provider must be a non-empty string`);
      }
      if (typeof a.model !== 'string' || a.model.trim().length === 0) {
        errors.push(`reviewerRouting.arms[${i}].model must be a non-empty string`);
      }
      if ('effort' in a && a.effort != null && (typeof a.effort !== 'string' || a.effort.trim().length === 0)) {
        errors.push(`reviewerRouting.arms[${i}].effort must be a non-empty string`);
      }
    });
  }
  return errors;
}

/**
 * Normalized routing config, or null when routing is off (absent, disabled,
 * or no usable arm): null means exact pre-routing behavior.
 */
export function normalizeReviewerRouting(raw, { reviewAgentIds = [] } = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.enabled === false) return null;
  const arms = [];
  const seen = new Set();
  for (const a of Array.isArray(raw.arms) ? raw.arms : []) {
    if (a == null || typeof a !== 'object') continue;
    if (typeof a.provider !== 'string' || typeof a.model !== 'string') continue;
    const provider = lc(a.provider);
    const model = a.model.trim();
    if (!provider || !model) continue;
    const effort = typeof a.effort === 'string' && a.effort.trim() ? a.effort.trim() : null;
    const key = `${provider}|${model}|${effort ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    arms.push({ provider, model, effort });
  }
  if (arms.length === 0) return null;
  const explicit = Array.isArray(raw.agentIds)
    ? [...new Set(raw.agentIds.filter((s) => typeof s === 'string' && s.length > 0))]
    : [];
  const fallback = [...new Set((Array.isArray(reviewAgentIds) ? reviewAgentIds : []).filter((s) => typeof s === 'string' && s.length > 0))];
  return { agentIds: explicit.length > 0 ? explicit : fallback, arms };
}

/**
 * Burn-mode tokens from a tolerant read of config `burnMode` (absent ->
 * empty). Accepts: an array of tokens/entries; { enabled:false } (nothing);
 * { accounts | accountIds | ids: [...] }; or a map { token: true|{enabled} }.
 * Entries are strings or { id | accountId | lane | label, enabled? }.
 */
export function burnModeTokens(raw) {
  const out = new Set();
  const addEntry = (e) => {
    if (typeof e === 'string') { if (e.trim()) out.add(lc(e)); return; }
    if (e == null || typeof e !== 'object' || e.enabled === false || e.burn === false) return;
    for (const k of ['id', 'accountId', 'lane', 'label', 'account']) {
      if (typeof e[k] === 'string' && e[k].trim()) out.add(lc(e[k]));
    }
  };
  if (raw == null) return out;
  if (Array.isArray(raw)) { raw.forEach(addEntry); return out; }
  if (typeof raw !== 'object' || raw.enabled === false) return out;
  let listed = false;
  for (const k of ['accounts', 'accountIds', 'ids']) {
    const v = raw[k];
    if (Array.isArray(v)) { v.forEach(addEntry); listed = true; }
    else if (v != null && typeof v === 'object') { addMap(v); listed = true; }
  }
  function addMap(m) {
    for (const [k, v] of Object.entries(m)) {
      if (v === true || (v != null && typeof v === 'object' && v.enabled !== false && v.burn !== false)) {
        if (k.trim()) out.add(lc(k));
      }
    }
  }
  if (!listed) {
    const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => !['enabled', 'accounts', 'accountIds', 'ids'].includes(k)));
    addMap(rest);
  }
  return out;
}

/** True when the account matches a burn-mode token by id, lane or label. */
export function isBurnFlagged(account, tokens) {
  if (!tokens || tokens.size === 0 || account == null) return false;
  const id = lc(account.accountId);
  const sep = id.indexOf(':');
  const names = [id, sep >= 0 ? id.slice(sep + 1) : null, account.lane, account.laneKey, account.label, account.email, account.name]
    .filter((s) => s != null && String(s).trim() !== '').map(lc);
  return names.some((n) => tokens.has(n));
}

/**
 * Servable for review runs (same bar as computeReviewerCapacity, with the
 * allocator reserve on metered headroom).
 */
export function reviewerServable(a, { reservePct = 0.05 } = {}) {
  if (a == null || typeof a.accountId !== 'string') return false;
  if (a.health !== 'healthy') return false;
  if (a.action === 'excluded' || a.guardActive === true) return false;
  if (a.reactive === true && !finite(a.headroomPct)) return true;
  return hasHeadroom({ health: a.health, headroomPct: a.headroomPct }, reservePct);
}

const providerOf = (a) => lc(a?.pool ?? a?.provider ?? String(a?.accountId ?? '').split(':')[0]);

/**
 * Pick the reviewer arm and account.
 * accounts: [{ accountId, provider|pool, health, action, guardActive,
 *   headroomPct, reactive, remainingPct, hoursToReset, planAhead,
 *   creditFallback, inFlight }]
 * serves(account, arm) -> true | false | string (string = refusal reason).
 * Returns { provider, arm, armIndex, accountId, burn, poolPlanAhead,
 *   reason, considered } or { none: true, reason, considered }.
 */
export function selectReviewerRoute({ cfg, accounts, burnTokens = new Set(), serves = () => true, inFlightOf = null, reservePct = 0.05 } = {}) {
  if (cfg == null || !Array.isArray(cfg.arms) || cfg.arms.length === 0) {
    return { none: true, reason: 'reviewer routing off', considered: 0 };
  }
  const providers = new Set(cfg.arms.map((a) => a.provider));
  const servable = (accounts ?? []).filter((a) => providers.has(providerOf(a)) && reviewerServable(a, { reservePct }));
  // Pool position over the servable lanes of each provider pool.
  const pools = new Map();
  for (const a of servable) {
    const p = providerOf(a);
    let e = pools.get(p);
    if (!e) { e = { ahead: [], perHour: 0 }; pools.set(p, e); }
    if (finite(a.planAhead)) e.ahead.push(a.planAhead);
    if (finite(a.remainingPct) && finite(a.hoursToReset)) e.perHour += Math.max(0, a.remainingPct) / Math.max(a.hoursToReset, 1 / 60);
  }
  const poolAhead = (p) => {
    const xs = pools.get(p)?.ahead ?? [];
    return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  };
  const poolPerHour = (p) => pools.get(p)?.perHour ?? 0;
  const cands = [];
  let refused = 0;
  for (const a of servable) {
    const p = providerOf(a);
    cfg.arms.forEach((arm, armIndex) => {
      if (arm.provider !== p) return;
      const ok = serves(a, arm);
      if (ok !== true) { refused += 1; return; }
      cands.push({
        a, arm, armIndex, p,
        burn: isBurnFlagged(a, burnTokens),
        credit: a.creditFallback === true,
        ahead: poolAhead(p),
        perHour: poolPerHour(p),
        inFlight: finite(inFlightOf?.(a)) ? inFlightOf(a) : (finite(a.inFlight) ? a.inFlight : 0),
      });
    });
  }
  if (cands.length === 0) {
    return {
      none: true,
      considered: servable.length,
      reason: servable.length === 0
        ? `no healthy ${[...providers].join('/')} account with headroom`
        : `no servable account serves a configured reviewer arm (${refused} refused)`,
    };
  }
  cands.sort((x, y) =>
    (Number(y.burn) - Number(x.burn))
    || (Number(x.credit) - Number(y.credit))
    || (x.ahead - y.ahead)
    || (y.perHour - x.perHour)
    || (x.armIndex - y.armIndex)
    || (x.inFlight - y.inFlight)
    || (x.a.accountId < y.a.accountId ? -1 : x.a.accountId > y.a.accountId ? 1 : 0));
  const w = cands[0];
  const pct = (v) => `${Math.round(v * 1000) / 10}%`;
  const why = w.burn
    ? 'burn mode'
    : `pool ${w.p} ${w.ahead <= 0 ? `${pct(-w.ahead)} behind` : `${pct(w.ahead)} ahead of`} plan, ${Math.round(w.perHour * 1000) / 1000} remaining/h`;
  return {
    provider: w.p,
    arm: { ...w.arm },
    armIndex: w.armIndex,
    accountId: w.a.accountId,
    burn: w.burn,
    poolPlanAhead: Math.round(w.ahead * 10000) / 10000,
    considered: servable.length,
    reason: `reviewer routing: ${w.arm.model}(${w.arm.effort ?? 'default'}) on ${w.a.accountId} (${why})`,
  };
}
