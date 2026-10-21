/**
 * Burn mode (pure): operator-flagged provider accounts that spend their
 * quota as fast as possible instead of pacing to their weekly reset.
 *
 * Config: burnMode: { accounts: string[], horizonMinutes?: number (60),
 *   deadlines?: { [matcher]: ISO-8601 UTC timestamp } }.
 * An entry matches an account by
 *   - its id ('meta:meta-lane-3'),
 *   - its lane / accountKey ('meta-lane-3'),
 *   - its label or email when the feed provides one,
 *   - 'provider:*' (every account of that provider, e.g. 'codex:*'),
 * all case-insensitive. An entry prefixed with '!' EXCLUDES the accounts it
 * matches and wins over every positive entry, so 'meta:*' plus
 * '!rdugger@example.com' burns every Meta account but that one. The same
 * identity semantics select deadline entries (a leading '!' entry never
 * matches anything there: deadlines only shorten, never exclude).
 *
 * A burn account (see plugin.mjs, paceguard.mjs, select.mjs):
 *   - paces to min(regular reset, burn horizon, now + horizonMinutes,
 *     deadline), where deadline is the earliest FUTURE timestamp among the
 *     deadlines entries it matches (past deadlines are ignored, so a
 *     cancelled account that disappears from the feed changes nothing), so
 *     its required rate is maximal and it never reads ahead of plan;
 *   - is never capped or held by the pool pace guard;
 *   - is never held by the review reserve;
 *   - sorts first among the accounts that can serve a run (health,
 *     headroom, breakers and exclusions still apply: an exhausted burn
 *     account is never chosen).
 * Empty or missing config (including empty or missing deadlines) burns
 * nothing: today's behavior bit-for-bit.
 */

export const DEFAULT_BURN_MODE = Object.freeze({
  accounts: Object.freeze([]),
  horizonMinutes: 60,
  deadlines: Object.freeze({}),
});

/** Config shape errors (strings), empty when valid or absent. */
export function validateBurnMode(raw) {
  const errors = [];
  if (raw == null) return errors;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('burnMode must be an object');
    return errors;
  }
  if ('accounts' in raw) {
    const a = raw.accounts;
    if (!Array.isArray(a)) errors.push('burnMode.accounts must be an array of strings');
    else if (a.some(x => typeof x !== 'string' || x.trim().length === 0)) {
      errors.push('burnMode.accounts must contain only non-empty strings');
    }
  }
  if ('horizonMinutes' in raw && !(typeof raw.horizonMinutes === 'number'
    && Number.isFinite(raw.horizonMinutes) && raw.horizonMinutes >= 1)) {
    errors.push('burnMode.horizonMinutes must be a number >= 1');
  }
  if ('deadlines' in raw) {
    const d = raw.deadlines;
    if (d == null || typeof d !== 'object' || Array.isArray(d)) {
      errors.push('burnMode.deadlines must be an object mapping account matchers to ISO-8601 timestamps');
    } else for (const [k, v] of Object.entries(d)) {
      if (typeof k !== 'string' || k.trim().length === 0) {
        errors.push('burnMode.deadlines keys must be non-empty strings');
      } else if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) {
        errors.push(`burnMode.deadlines[${JSON.stringify(k)}] must be an ISO-8601 UTC timestamp`);
      }
    }
  }
  return errors;
}

/** Coerce to { accounts: lower-cased trimmed strings, horizonMinutes, deadlines }. */
export function normalizeBurnMode(raw) {
  const r = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const accounts = Array.isArray(r.accounts)
    ? [...new Set(r.accounts.filter(x => typeof x === 'string' && x.trim().length > 0).map(x => x.trim().toLowerCase()))]
    : [];
  const h = r.horizonMinutes;
  const d = r.deadlines;
  const deadlines = {};
  if (d != null && typeof d === 'object' && !Array.isArray(d)) {
    for (const [k, v] of Object.entries(d)) {
      if (typeof k === 'string' && k.trim().length > 0 && typeof v === 'string' && v.trim().length > 0) {
        deadlines[k.trim().toLowerCase()] = v.trim();
      }
    }
  }
  return {
    accounts,
    horizonMinutes: typeof h === 'number' && Number.isFinite(h) && h >= 1 ? h : DEFAULT_BURN_MODE.horizonMinutes,
    deadlines,
  };
}

/** True when burn mode names at least one account entry. */
export function burnModeActive(cfg) {
  return Array.isArray(cfg?.accounts) && cfg.accounts.some(e => !e.startsWith('!'));
}

const lc = (v) => (typeof v === 'string' && v.length > 0 ? v.toLowerCase() : null);

/** Every identity an entry can name for this account (lower-cased). */
function identitiesOf(account, key = null) {
  const ids = new Set();
  const add = (v) => { const s = lc(v); if (s) ids.add(s); };
  add(key);
  add(account?.accountId);
  for (const id of [key, account?.accountId]) {
    if (typeof id === 'string' && id.includes(':')) add(id.slice(id.indexOf(':') + 1));
  }
  add(account?.accountKey);
  add(account?.lane);
  add(account?.label);
  add(account?.email);
  add(account?.name);
  // 'provider:label' names one provider's account when the same email exists on several providers.
  const provider = providerOf(account, key);
  if (provider) for (const v of [...ids]) if (!v.includes(':')) ids.add(`${provider}:${v}`);
  return ids;
}

function providerOf(account, key) {
  const p = lc(account?.provider);
  if (p) return p;
  const id = key ?? account?.accountId;
  return typeof id === 'string' && id.includes(':') ? id.slice(0, id.indexOf(':')).toLowerCase() : null;
}

function entryMatches(entry, ids, provider) {
  if (entry.endsWith(':*')) return provider != null && entry.slice(0, -2) === provider;
  return ids.has(entry);
}

/**
 * True when burn mode covers this account. account: a feed account (or a
 * view) with accountId/lane/accountKey/label/email/provider; key: the
 * tick's state key for it (may carry a '#lane' suffix on duplicates).
 */
export function isBurnAccount(cfg, account, key = null) {
  if (!burnModeActive(cfg)) return false;
  const ids = identitiesOf(account, key);
  const provider = providerOf(account, key);
  let on = false;
  for (const e of cfg.accounts) {
    if (e.startsWith('!')) {
      if (entryMatches(e.slice(1), ids, provider)) return false;
    } else if (!on && entryMatches(e, ids, provider)) {
      on = true;
    }
  }
  return on;
}

/** Weekly share at or above which a burn account is spent (matches the feed's exhausted line). */
export const BURN_SPENT_WEEKLY = 0.995;
/** Five-hour share at or above which the fast bucket refuses (matches the feed's floor). */
export const BURN_SPENT_FIVE_HOUR = 0.99;

/**
 * Burn mode spends an account to exhaustion, so a lane the feed marked
 * `degraded` ONLY by its utilization floor (healthReason 'peak utilization
 * ...') stays allocatable until the weekly meter reaches BURN_SPENT_WEEKLY
 * or the five-hour bucket fills. Any other degraded cause (recent failures,
 * vendor cooldown) and every exhausted/unavailable account stay out.
 * Returns the same array when nothing changes.
 */
export function burnEligibleAccounts(cfg, accounts, keys = null) {
  if (!burnModeActive(cfg) || !Array.isArray(accounts)) return accounts;
  let changed = false;
  const out = accounts.map((a, i) => {
    if (a?.health !== 'degraded' || !String(a.healthReason ?? '').startsWith('peak utilization')) return a;
    const weekly = a.weekly?.utilization;
    const five = a.fiveHour?.utilization;
    if (!Number.isFinite(weekly) || weekly >= BURN_SPENT_WEEKLY) return a;
    if (Number.isFinite(five) && five >= BURN_SPENT_FIVE_HOUR) return a;
    if (!isBurnAccount(cfg, a, keys?.[i] ?? null)) return a;
    changed = true;
    return { ...a, health: 'healthy', feedHealth: 'degraded' };
  });
  return changed ? out : accounts;
}

/**
 * Earliest FUTURE deadline (ms) among the cfg.deadlines entries this account
 * matches (same identity semantics as the accounts list), or null when none
 * matches. Past deadlines are ignored: a cancelled account disappears from
 * the feed anyway. Pure matching: the caller gates on isBurnAccount.
 */
export function burnDeadlineAtMs(cfg, account, key = null, nowMs = Date.now()) {
  const deadlines = cfg?.deadlines;
  if (deadlines == null || typeof deadlines !== 'object' || Array.isArray(deadlines)) return null;
  const entries = Object.entries(deadlines);
  if (entries.length === 0) return null;
  const ids = identitiesOf(account, key);
  const provider = providerOf(account, key);
  let best = null;
  for (const [matcher, stamp] of entries) {
    if (typeof matcher !== 'string' || typeof stamp !== 'string') continue;
    if (!entryMatches(matcher, ids, provider)) continue;
    const atMs = Date.parse(stamp);
    if (!Number.isFinite(atMs) || atMs <= nowMs) continue;
    if (best == null || atMs < best) best = atMs;
  }
  return best;
}

/**
 * Pace end for a burn account plus which bound set it:
 * min(regular reset, burn horizon, now + H, deadline). An unknown regular
 * reset still burns (now + H); a past (or absent) deadline never binds.
 * source is 'reset' | 'horizon' | 'deadline'; ties prefer the operator-set
 * deadline, then the reset, then a horizon.
 */
export function burnPaceTarget({ nowMs, resetAtMs = null, horizonMs = null, deadlineAtMs = null, cfg }) {
  const h = (cfg?.horizonMinutes ?? DEFAULT_BURN_MODE.horizonMinutes) * 60000;
  const cands = [{ atMs: nowMs + h, source: 'horizon' }];
  if (Number.isFinite(resetAtMs)) cands.push({ atMs: resetAtMs, source: 'reset' });
  if (Number.isFinite(horizonMs)) cands.push({ atMs: horizonMs, source: 'horizon' });
  if (Number.isFinite(deadlineAtMs) && deadlineAtMs > nowMs) cands.push({ atMs: deadlineAtMs, source: 'deadline' });
  const rank = { deadline: 0, reset: 1, horizon: 2 };
  let best = cands[0];
  for (const c of cands.slice(1)) {
    if (c.atMs < best.atMs || (c.atMs === best.atMs && rank[c.source] < rank[best.source])) best = c;
  }
  return best;
}

/**
 * Pace end for a burn account: min(regular reset, burn horizon, now + H,
 * deadline). An unknown regular reset still burns (now + H).
 */
export function burnPaceResetAtMs({ nowMs, resetAtMs = null, horizonMs = null, deadlineAtMs = null, cfg }) {
  return burnPaceTarget({ nowMs, resetAtMs, horizonMs, deadlineAtMs, cfg }).atMs;
}
