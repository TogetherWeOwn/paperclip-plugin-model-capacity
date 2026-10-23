/**
 * Burn mode (pure): operator-flagged provider accounts that spend their
 * quota as fast as possible instead of pacing to their weekly reset.
 *
 * Config: burnMode: { accounts: string[], horizonMinutes?: number (60),
 *   deadlines?: { [matcher]: strict ISO-8601 with explicit Z or offset } }.
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
 * Stamps must be strict ISO-8601 with an explicit Z or numeric offset
 * (e.g. '2026-10-27T00:00:00Z'): a missing zone would parse as worker-local
 * time and pace to the wrong hour. Validation fails closed on loose stamps
 * and on two keys that collide after trim + lower-casing (the earlier stamp
 * would otherwise be silently overwritten); normalization keeps the earliest
 * parseable stamp per matcher as defense for paths that normalize without
 * validating.
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
 *
 * Level floors (floors?: { [matcher]: remaining share in [0, 1) }, same
 * identity semantics as deadlines; '!' matchers are rejected): a matched
 * account whose bar reading leaves `floor` or less of its quota is not
 * allocatable (health 'exhausted', the same path as a feed-exhausted lane),
 * whether or not it burns. The reading is the regenerating bar (meterInfo,
 * see cliproxy.mjs) when the feed has one, else the weekly meter; a matched
 * account with no reading is not allocatable either (fail closed). A burn
 * account above its floor sorts before every other burn account (see
 * select.mjs): it can only spend what its bar holds above the floor, and a
 * regenerating bar that nothing spends wastes its regeneration once full.
 * So spend tracks regeneration and the bar holds at the floor, never full
 * and never lower than the runs already in flight. Empty or missing floors
 * change nothing.
 */

export const DEFAULT_BURN_MODE = Object.freeze({
  accounts: Object.freeze([]),
  horizonMinutes: 60,
  deadlines: Object.freeze({}),
  floors: Object.freeze({}),
});

/**
 * Strict deadline stamp: ISO-8601 with an explicit Z or numeric offset
 * (optional .sss), plus a calendar round-trip so impossible days V8 rolls
 * over (Feb 30) are rejected. Returns ms, or null. Shared by validation and
 * the tick matcher so an accepted config can never parse differently at
 * tick time. Same shape as the strict timestamp in src/availability.mjs.
 */
const BURN_DEADLINE_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})$/;
export function parseBurnDeadlineStamp(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const m = BURN_DEADLINE_STAMP.exec(v);
  if (!m) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  // Round-trip the wall clock the stamp names: UTC ms shifted back into the
  // stamp's own zone must reproduce the stamp, else the calendar day is
  // impossible (Feb 30) or the fields overflow.
  const zone = m[7];
  const offMin = zone === 'Z' ? 0 : (() => {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  })();
  if (!Number.isFinite(offMin) || Math.abs(offMin) >= 24 * 60) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const wall = new Date(ms + offMin * 60000);
  const wallStr = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`
    + `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`;
  return wallStr === v.slice(0, 19) ? ms : null;
}

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
      errors.push('burnMode.deadlines must be an object mapping account matchers to ISO-8601 timestamps with an explicit Z or numeric offset');
    } else {
      const seen = new Set();
      for (const [k, v] of Object.entries(d)) {
        if (typeof k !== 'string' || k.trim().length === 0) {
          errors.push('burnMode.deadlines keys must be non-empty strings');
          continue;
        }
        const nk = k.trim().toLowerCase();
        if (seen.has(nk)) {
          errors.push(`burnMode.deadlines has a duplicate matcher for ${JSON.stringify(nk)} (matchers are case-insensitive and trimmed)`);
        } else seen.add(nk);
        if (parseBurnDeadlineStamp(v) == null) {
          errors.push(`burnMode.deadlines[${JSON.stringify(k)}] must be an ISO-8601 timestamp with an explicit Z or numeric offset (e.g. 2026-10-27T00:00:00Z)`);
        }
      }
    }
  }
  if ('floors' in raw) {
    const f = raw.floors;
    if (f == null || typeof f !== 'object' || Array.isArray(f)) {
      errors.push('burnMode.floors must be an object mapping account matchers to the remaining share (0 to under 1) at or below which the account takes no runs');
    } else {
      const seen = new Set();
      for (const [k, v] of Object.entries(f)) {
        if (k.trim().length === 0) {
          errors.push('burnMode.floors keys must be non-empty strings');
          continue;
        }
        const nk = k.trim().toLowerCase();
        if (nk.startsWith('!')) errors.push(`burnMode.floors[${JSON.stringify(k)}]: a floor matcher cannot exclude (drop the leading !)`);
        if (seen.has(nk)) {
          errors.push(`burnMode.floors has a duplicate matcher for ${JSON.stringify(nk)} (matchers are case-insensitive and trimmed)`);
        } else seen.add(nk);
        if (!isFloorValue(v)) {
          errors.push(`burnMode.floors[${JSON.stringify(k)}] must be a number from 0 to under 1 (the remaining share the account keeps, e.g. 0.8)`);
        }
      }
    }
  }
  return errors;
}

const isFloorValue = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1;

/**
 * Coerce to { accounts: lower-cased trimmed strings, horizonMinutes,
 * deadlines, floors? }. A floor value that is not a number in [0, 1) reads
 * as 1 (never allocatable): validation rejects it, this is the tick-path
 * defense, and a broken floor must fail closed. Colliding matchers keep the
 * higher floor.
 */
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
        // Colliding keys (same matcher after trim + lower-case) keep the
        // earliest parseable stamp; validation fails closed on the
        // collision, this is only the tick-path defense.
        const nk = k.trim().toLowerCase();
        const nv = v.trim();
        const prevMs = Object.hasOwn(deadlines, nk) ? parseBurnDeadlineStamp(deadlines[nk]) : null;
        const nextMs = parseBurnDeadlineStamp(nv);
        if (!Object.hasOwn(deadlines, nk) || (nextMs != null && (prevMs == null || nextMs < prevMs))) {
          // defineProperty, not assignment: a '__proto__' matcher would
          // otherwise silently not stick as an own property and never bind.
          Object.defineProperty(deadlines, nk, { value: nv, writable: true, enumerable: true, configurable: true });
        }
      }
    }
  }
  const floors = {};
  const fl = r.floors;
  if (fl != null && typeof fl === 'object' && !Array.isArray(fl)) {
    for (const [k, v] of Object.entries(fl)) {
      const nk = k.trim().toLowerCase();
      if (nk.length === 0 || nk.startsWith('!')) continue;
      const nv = isFloorValue(v) ? v : 1;
      if (!Object.hasOwn(floors, nk) || nv > floors[nk]) {
        Object.defineProperty(floors, nk, { value: nv, writable: true, enumerable: true, configurable: true });
      }
    }
  }
  return {
    accounts,
    horizonMinutes: typeof h === 'number' && Number.isFinite(h) && h >= 1 ? h : DEFAULT_BURN_MODE.horizonMinutes,
    deadlines,
    // Present only when set, so configs without floors resolve exactly as before.
    ...(Object.keys(floors).length > 0 ? { floors } : {}),
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
    // Same strict grammar as validation: a loose stamp can never bind.
    const atMs = parseBurnDeadlineStamp(stamp);
    if (atMs == null || atMs <= nowMs) continue;
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

/**
 * The level floor (remaining share in [0, 1]) for this account: the highest
 * among the cfg.floors entries it matches, or null when none matches. A
 * non-numeric value reads as 1 (fail closed).
 */
export function burnFloorFor(cfg, account, key = null) {
  const floors = cfg?.floors;
  if (floors == null || typeof floors !== 'object' || Array.isArray(floors)) return null;
  const entries = Object.entries(floors);
  if (entries.length === 0) return null;
  const ids = identitiesOf(account, key);
  const provider = providerOf(account, key);
  let best = null;
  for (const [matcher, value] of entries) {
    const m = matcher.trim().toLowerCase();
    if (m.length === 0 || m.startsWith('!') || !entryMatches(m, ids, provider)) continue;
    const f = typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1;
    if (best == null || f > best) best = f;
  }
  return best;
}

/** Used share (0..1) of the bar a floor reads: the regenerating bar, else the weekly meter; null when unknown. */
export function floorBarUsed(account) {
  if (Number.isFinite(account?.regenUsed)) return account.regenUsed;
  const weekly = account?.weekly?.utilization;
  return Number.isFinite(weekly) ? weekly : null;
}

const pct = (v) => `${Math.round(v * 1000) / 10}%`;
const FLOOR_EPSILON = 1e-9;

/**
 * Apply burnMode.floors to the feed accounts (a copy, never a mutation).
 * A healthy matched account gets `burnFloor: { floor, remaining }`; at or
 * below its floor, or with no reading, it also leaves allocation: health
 * 'exhausted' (or 'unavailable' without a reading) with the feed's verdict
 * kept as feedHealth and the cause in burnFloor.reason. Accounts the feed
 * already marked unhealthy keep the feed's verdict. Returns the same array
 * when no floor matches.
 */
export function applyBurnFloors(cfg, accounts, keys = null) {
  if (!Array.isArray(accounts) || cfg?.floors == null || Object.keys(cfg.floors).length === 0) return accounts;
  let changed = false;
  const out = accounts.map((a, i) => {
    if (a?.health !== 'healthy') return a;
    const floor = burnFloorFor(cfg, a, keys?.[i] ?? null);
    if (floor == null) return a;
    changed = true;
    const used = floorBarUsed(a);
    const feedHealth = a.feedHealth ?? a.health;
    if (used == null) {
      return { ...a, health: 'unavailable', feedHealth,
        burnFloor: { floor, remaining: null, reason: `burn floor ${pct(floor)} set but the bar has no reading (fail closed)` } };
    }
    const remaining = Math.max(0, 1 - used);
    // Tolerance: 1 - 0.7 is 0.30000000000000004, which must still read as
    // AT a 0.3 floor.
    if (remaining <= floor + FLOOR_EPSILON) {
      return { ...a, health: 'exhausted', feedHealth,
        burnFloor: { floor, remaining, reason: `burn floor ${pct(floor)} reached (${pct(remaining)} left)` } };
    }
    return { ...a, burnFloor: { floor, remaining } };
  });
  return changed ? out : accounts;
}
