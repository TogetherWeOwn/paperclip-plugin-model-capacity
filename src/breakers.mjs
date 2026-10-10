/**
 * Arm circuit breaker: per-(account, arm) self-protection against provider-side
 * model errors. After N (default 2) arm-fatal failures for the same
 * (accountId, armId) within a sliding window (default 30 min), the breaker
 * opens: the arm is excluded from decide/ladder picks for a cool-off (default
 * 6h, doubling per consecutive reopen, capped at 48h). When the cool-off
 * elapses the breaker goes half-open and allows exactly one probe run (an
 * enforced hook pick); success closes it, another arm-fatal failure re-opens
 * it with a doubled cool-off, any other outcome frees the probe slot and
 * stays half-open.
 *
 * Classification is a configurable pattern list with sane defaults. Entries
 * WITHOUT a '+' are specific: a case-insensitive substring hit trips the
 * breaker and is veto-proof. Entries WITH a '+' are generic conjunctions
 * (every part must match, e.g. '400+model') and trip ONLY when no transient
 * (veto) pattern matches -- so a 400 that mentions the model still trips, but
 * a 400 about context length, rate limits, overload, or disconnects never
 * does. Specific knowledge beats the generic heuristic: an error matching
 * both a specific fatal pattern and a veto pattern still trips.
 *
 * Pure and deterministic (the clock is always passed in). Pair keys join on
 * NUL, the same aliasing-proof convention as the ladder gate pairs.
 */

export const BREAKER_KEY = 'breaker-v1';
export const BREAKER_MAX_ARMS = 500;
export const BREAKER_MAX_SEEN = 1000;
export const BREAKER_ERROR_TEXT_MAX = 500;
// Servable-arm universe for the reserved-floor guard: (account, arm) pairs
// the tick last saw on a ladder, with the tick it was last seen. Bounded and
// stale-pruned by housekeep; untracked arms read closed (servable).
export const BREAKER_MAX_KNOWN_ARMS = 2000;
export const BREAKER_KNOWN_STALE_MS = 24 * 3600 * 1000;

export const DEFAULT_BREAKERS = {
  enabled: true,
  tripCount: 2,
  windowMin: 30,
  cooloffHours: 6,
  maxCooloffHours: 48,
  probeTimeoutMs: 2 * 3600 * 1000,
  fatalPatterns: [
    'unknown provider for model',
    'auth_unavailable',
    'no auth available',
    'requested entity was not found',
    'model_not_found',
    'model not found',
    'invalid model',
    'unknown model',
    '400+model',
    'model is unavailable',
    'no healthy managed',
  ],
  vetoPatterns: [
    'context length',
    'maximum context',
    'context window',
    'too many tokens',
    'max_tokens',
    'rate limit',
    'rate_limit',
    '429',
    'overload',
    'disconnect',
    'timeout',
    'temporar',
    'try again',
  ],
};

/** Resolve operator config over the defaults; never throws, never trips. */
export function sanitizeBreakers(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, d, min) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d);
  const strs = (v, d) => {
    if (v === undefined) return [...d];
    if (!Array.isArray(v)) return [...d];
    const out = [];
    for (const s of v) {
      if (typeof s !== 'string') continue;
      const t = s.trim().toLowerCase();
      if (t.length > 0 && t.length <= 200 && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 100);
  };
  const cooloffHours = num(r.cooloffHours, DEFAULT_BREAKERS.cooloffHours, 0.25);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    tripCount: Math.floor(num(r.tripCount, DEFAULT_BREAKERS.tripCount, 1)),
    windowMin: num(r.windowMin, DEFAULT_BREAKERS.windowMin, 1),
    cooloffHours,
    maxCooloffHours: Math.max(
      num(r.maxCooloffHours, DEFAULT_BREAKERS.maxCooloffHours, 0.25),
      cooloffHours,
    ),
    probeTimeoutMs: num(r.probeTimeoutMs, DEFAULT_BREAKERS.probeTimeoutMs, 60000),
    fatalPatterns: strs(r.fatalPatterns, DEFAULT_BREAKERS.fatalPatterns),
    vetoPatterns: strs(r.vetoPatterns, DEFAULT_BREAKERS.vetoPatterns),
  };
}

/**
 * 'fatal' when the error text names a provider-side model failure, else null.
 * Generic transients (stream drops, 429/overload, context exhaustion) never
 * match a specific pattern and are vetoed off the generic 400 rule.
 */
export function classifyArmError(text, cfg = DEFAULT_BREAKERS) {
  const t = String(text ?? '').toLowerCase();
  if (t.length === 0) return null;
  const fatals = Array.isArray(cfg?.fatalPatterns) ? cfg.fatalPatterns : DEFAULT_BREAKERS.fatalPatterns;
  const vetoes = Array.isArray(cfg?.vetoPatterns) ? cfg.vetoPatterns : DEFAULT_BREAKERS.vetoPatterns;
  const vetoed = vetoes.some(p => typeof p === 'string' && p.length > 0 && t.includes(p.toLowerCase()));
  for (const raw of fatals) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const p = raw.toLowerCase();
    if (p.includes('+')) {
      const parts = p.split('+').map(s => s.trim()).filter(s => s.length > 0);
      if (parts.length > 0 && parts.every(part => t.includes(part)) && !vetoed) return 'fatal';
    } else if (t.includes(p)) {
      return 'fatal';
    }
  }
  return null;
}

/** Alias-proof pair key: NUL cannot appear in an account or arm id. */
export const breakerKey = (accountId, armId) => `${String(accountId)}\u0000${String(armId)}`;

export function createBreakerStore() {
  return { v: 1, seen: [], arms: {}, known: {} };
}

/**
 * Once per tick: record the (account, arm) pairs the fleet can serve (every
 * rung arm on every ladder). The failure-tracking `arms` map only holds arms
 * that have failed -- healthy arms are never added -- so the floor guard
 * cannot decide from it alone. `known` is that universe: keyed like `arms`,
 * `{ accountId, armId, lastSeen }`, bounded, stale-pruned by housekeep.
 */
export function noteKnownArms(store, arms, nowMs) {
  if (!store || typeof store !== 'object') return;
  if (store.known == null || typeof store.known !== 'object') store.known = {};
  for (const a of arms ?? []) {
    const accountId = a?.accountId;
    const armId = a?.armId;
    if (typeof accountId !== 'string' || accountId.length === 0) continue;
    if (typeof armId !== 'string' || armId.length === 0) continue;
    store.known[breakerKey(accountId, armId)] = { accountId, armId, lastSeen: nowMs };
  }
  const keys = Object.keys(store.known);
  if (keys.length > BREAKER_MAX_KNOWN_ARMS) {
    keys
      .sort((x, y) => (store.known[x]?.lastSeen ?? 0) - (store.known[y]?.lastSeen ?? 0))
      .slice(0, keys.length - BREAKER_MAX_KNOWN_ARMS)
      .forEach(k => { delete store.known[k]; });
  }
}

const asNum = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function breakerStoreFromJSON(json) {
  const store = createBreakerStore();
  if (!json || typeof json !== 'object') return store;
  if (Array.isArray(json.seen)) {
    store.seen = json.seen.filter(s => typeof s === 'string').slice(-BREAKER_MAX_SEEN);
  }
  const src = json.arms && typeof json.arms === 'object' ? json.arms : {};
  for (const [k, e] of Object.entries(src).slice(0, BREAKER_MAX_ARMS)) {
    if (typeof k !== 'string' || !e || typeof e !== 'object') continue;
    if (e.state !== 'open' && e.state !== 'half-open' && e.state !== 'closed') continue;
    store.arms[k] = {
      accountId: String(e.accountId ?? ''),
      armId: String(e.armId ?? ''),
      state: e.state,
      openedAt: asNum(e.openedAt),
      cooloffHours: asNum(e.cooloffHours, DEFAULT_BREAKERS.cooloffHours),
      opens: Number.isInteger(e.opens) && e.opens >= 0 ? e.opens : 0,
      fails: (Array.isArray(e.fails) ? e.fails : []).filter(f => typeof f === 'number' && Number.isFinite(f)).slice(-10),
      probe: e.probe && typeof e.probe === 'object' && typeof e.probe.runId === 'string'
        ? { runId: e.probe.runId, startedAt: asNum(e.probe.startedAt, 0) ?? 0 }
        : null,
      lastError: typeof e.lastError === 'string' ? e.lastError.slice(0, 200) : null,
    };
  }
  const ksrc = json.known && typeof json.known === 'object' ? json.known : {};
  for (const [k, e] of Object.entries(ksrc).slice(0, BREAKER_MAX_KNOWN_ARMS)) {
    if (typeof k !== 'string' || !e || typeof e !== 'object') continue;
    if (typeof e.accountId !== 'string' || typeof e.armId !== 'string') continue;
    store.known[k] = {
      accountId: e.accountId, armId: e.armId,
      lastSeen: typeof e.lastSeen === 'number' && Number.isFinite(e.lastSeen) ? e.lastSeen : null,
    };
  }
  return store;
}

/** Bounded persist: all open/half-open arms, plus closed arms with recent fails. */
export function breakerStoreToJSON(store, { nowMs = Date.now(), cfg = DEFAULT_BREAKERS } = {}) {
  const cutoff = nowMs - (cfg?.windowMin ?? DEFAULT_BREAKERS.windowMin) * 60 * 1000;
  const arms = {};
  const closedFresh = [];
  for (const [k, e] of Object.entries(store?.arms ?? {})) {
    if (!e || typeof e !== 'object') continue;
    if (e.state === 'open' || e.state === 'half-open') {
      arms[k] = {
        accountId: e.accountId, armId: e.armId, state: e.state,
        openedAt: e.openedAt, cooloffHours: e.cooloffHours, opens: e.opens,
        fails: (e.fails ?? []).slice(-10), probe: e.probe, lastError: e.lastError,
      };
    } else if ((e.fails ?? []).some(f => f >= cutoff)) {
      closedFresh.push([k, e]);
    }
  }
  closedFresh.sort((a, b) => Math.max(...b[1].fails) - Math.max(...a[1].fails));
  for (const [k, e] of closedFresh.slice(0, Math.max(0, BREAKER_MAX_ARMS - Object.keys(arms).length))) {
    arms[k] = {
      accountId: e.accountId, armId: e.armId, state: 'closed',
      openedAt: e.openedAt, cooloffHours: e.cooloffHours, opens: e.opens,
      fails: (e.fails ?? []).slice(-10), probe: null, lastError: e.lastError,
    };
  }
  const known = {};
  for (const [k, e] of Object.entries(store?.known ?? {}).slice(0, BREAKER_MAX_KNOWN_ARMS)) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.accountId !== 'string' || typeof e.armId !== 'string') continue;
    known[k] = { accountId: e.accountId, armId: e.armId, lastSeen: e.lastSeen ?? null };
  }
  return {
    v: 1,
    seen: (store?.seen ?? []).filter(s => typeof s === 'string').slice(-BREAKER_MAX_SEEN),
    arms,
    known,
  };
}

/** Effective state without mutating: 'closed' | 'open' | 'half-open'. */
export function breakerState(store, accountId, armId, nowMs, cfg = DEFAULT_BREAKERS) {
  const e = store?.arms?.[breakerKey(accountId, armId)];
  if (!e || e.state === 'closed') return 'closed';
  if (e.state === 'open') {
    const cooloffMs = (e.cooloffHours ?? DEFAULT_BREAKERS.cooloffHours) * 3600 * 1000;
    return nowMs - (e.openedAt ?? 0) >= cooloffMs ? 'half-open' : 'open';
  }
  return 'half-open';
}

const probeLive = (e, nowMs, cfg) =>
  e?.probe != null && nowMs - (e.probe.startedAt ?? 0) <= (cfg?.probeTimeoutMs ?? DEFAULT_BREAKERS.probeTimeoutMs);

/**
 * False while open, or while a half-open probe is still out. Effective state
 * (not stored state): the open -> half-open flip is lazy, so an arm whose
 * cool-off elapsed counts as half-open before housekeep records it.
 */
export function breakerAllows(store, accountId, armId, nowMs, cfg = DEFAULT_BREAKERS) {
  if (cfg?.enabled === false) return true;
  const st = breakerState(store, accountId, armId, nowMs, cfg);
  if (st === 'open') return false;
  if (st === 'half-open') {
    const e = store?.arms?.[breakerKey(accountId, armId)];
    if (probeLive(e, nowMs, cfg)) return false;
  }
  return true;
}

/**
 * Reserved-floor guard: true only while every servable arm reads breaker-open
 * (fleet-wide cooling). Extra floor slots are safe while ANY arm can serve --
 * placement already avoids cooled arms, so they land on healthy ones -- and
 * only a fleet-wide cooling suspends floors, holding floored caps at running
 * so failed runs on cooled models cannot rise. Half-open arms serve (the
 * probe slot). Decided from the tick-noted `known` arm universe, never from
 * the failure-tracking map alone: that map only holds arms that have failed
 * (healthy arms are never added, quiet closed entries are pruned), so "every
 * tracked arm is open" goes true on a single tripped arm. An arm with no
 * entry reads closed (servable); no known arms means nothing provably
 * cooling, so floors stay on. A disabled breaker never suspends.
 */
export function breakerSuspendsFloors(store, nowMs, cfg = DEFAULT_BREAKERS) {
  if (cfg?.enabled === false) return false;
  const known = store?.known ?? {};
  const keys = Object.keys(known);
  if (keys.length === 0) return false;
  return keys.every(k => {
    const e = known[k];
    return breakerState(store, e?.accountId, e?.armId, nowMs, cfg) === 'open';
  });
}

/** RunId currently occupying the half-open probe slot, if any. */
export function breakerProbeRunId(store, accountId, armId, nowMs, cfg = DEFAULT_BREAKERS) {
  if (breakerState(store, accountId, armId, nowMs, cfg) !== 'half-open') return null;
  const e = store?.arms?.[breakerKey(accountId, armId)];
  return probeLive(e, nowMs, cfg) ? e.probe.runId : null;
}

const nextCooloffHours = (e, cfg) =>
  Math.min(
    (cfg?.cooloffHours ?? DEFAULT_BREAKERS.cooloffHours) * (2 ** (e.opens ?? 0)),
    cfg?.maxCooloffHours ?? DEFAULT_BREAKERS.maxCooloffHours,
  );

const truncError = (t) => (typeof t === 'string' && t.length > 0 ? t.slice(0, 200) : String(t ?? '').slice(0, 200) || null);

/**
 * A finished-run arm-fatal failure for a CLOSED arm. Returns a transition
 * ({ transition: 'opened', ... }) when the trip count is reached, else null.
 * Failures for arms that are already open or half-open only refresh lastError
 * (only the half-open probe resolves those states).
 */
export function recordArmFailure(store, accountId, armId, { atMs, errorText } = {}, nowMs, cfg = DEFAULT_BREAKERS) {
  const key = breakerKey(accountId, armId);
  let e = store.arms[key];
  if (!e) {
    e = {
      accountId: String(accountId), armId: String(armId), state: 'closed',
      openedAt: null, cooloffHours: cfg?.cooloffHours ?? DEFAULT_BREAKERS.cooloffHours,
      opens: 0, fails: [], probe: null, lastError: null,
    };
    store.arms[key] = e;
  }
  e.lastError = truncError(errorText);
  if (e.state !== 'closed') return null;
  // Failures count in the window ending at the later of the failure and now,
  // so a re-processed stale failure can never wipe newer ones or trip.
  const ref = Math.max(Number.isFinite(nowMs) ? nowMs : atMs, atMs);
  const cutoff = ref - (cfg?.windowMin ?? DEFAULT_BREAKERS.windowMin) * 60 * 1000;
  // Filter AFTER appending: a stale failure is dropped, never counted, so the
  // trip is order-independent (recent-then-ancient and ancient-then-recent
  // agree). The ref uses the later of now and the failure, so a re-processed
  // stale failure can neither trip nor wipe newer ones.
  e.fails = [...e.fails, atMs].filter(f => f >= cutoff).slice(-10);
  const trip = cfg?.tripCount ?? DEFAULT_BREAKERS.tripCount;
  if (e.fails.length >= trip) {
    e.state = 'open';
    e.openedAt = Number.isFinite(nowMs) ? nowMs : atMs;
    e.cooloffHours = nextCooloffHours(e, cfg);
    e.opens += 1;
    e.probe = null;
    return { transition: 'opened', accountId: e.accountId, armId: e.armId, cooloffHours: e.cooloffHours, fails: e.fails.length };
  }
  return null;
}

/**
 * Occupy the half-open probe slot with an enforced run. Only the first caller
 * wins; later callers get false and must route elsewhere (the hook live-filters
 * occupied slots and skips to the next account when the claim loses, so two
 * enforced runs never pile onto one probe). Returns true when this runId
 * holds the slot.
 */
export function startProbe(store, accountId, armId, runId, nowMs, cfg = DEFAULT_BREAKERS) {
  if (runId == null) return false;
  const e = store?.arms?.[breakerKey(accountId, armId)];
  if (!e || breakerState(store, accountId, armId, nowMs, cfg) !== 'half-open') return false;
  if (probeLive(e, nowMs, cfg)) return false;
  e.probe = { runId: String(runId), startedAt: nowMs };
  return true;
}

/**
 * Resolve the half-open probe from the probe run's terminal. Success closes
 * (backoff reset); another arm-fatal failure re-opens with a doubled
 * cool-off; anything else frees the slot and stays half-open. Unknown or
 * already-resolved runIds return null.
 */
export function resolveProbe(store, accountId, armId, runId, outcome, errorText, nowMs, cfg = DEFAULT_BREAKERS) {
  const key = breakerKey(accountId, armId);
  const e = store?.arms?.[key];
  if (!e || e.probe?.runId !== String(runId)) return null;
  e.probe = null;
  if (outcome === 'success') {
    e.state = 'closed';
    e.openedAt = null;
    e.cooloffHours = cfg?.cooloffHours ?? DEFAULT_BREAKERS.cooloffHours;
    e.opens = 0;
    e.fails = [];
    e.lastError = null;
    return { transition: 'closed', accountId: e.accountId, armId: e.armId };
  }
  if (outcome === 'arm-fatal') {
    e.fails = [Number.isFinite(nowMs) ? nowMs : Date.now()];
    e.lastError = truncError(errorText);
    e.state = 'open';
    e.openedAt = Number.isFinite(nowMs) ? nowMs : Date.now();
    e.cooloffHours = nextCooloffHours(e, cfg);
    e.opens += 1;
    return { transition: 'reopened', accountId: e.accountId, armId: e.armId, cooloffHours: e.cooloffHours };
  }
  return null;
}

/**
 * Once per tick: open breakers whose cool-off elapsed go half-open; stale
 * probes (no terminal within probeTimeoutMs) free their slot. Returns the
 * transitions for logging. Also drops quiet closed entries and prunes old
 * fails so the memory store stays bounded between persists.
 */
export function breakerHousekeep(store, nowMs, cfg = DEFAULT_BREAKERS) {
  const transitions = [];
  const windowMs = (cfg?.windowMin ?? DEFAULT_BREAKERS.windowMin) * 60 * 1000;
  for (const key of Object.keys(store?.arms ?? {})) {
    const e = store.arms[key];
    if (e.state === 'open') {
      const cooloffMs = (e.cooloffHours ?? DEFAULT_BREAKERS.cooloffHours) * 3600 * 1000;
      if (nowMs - (e.openedAt ?? 0) >= cooloffMs) {
        e.state = 'half-open';
        e.fails = [];
        e.probe = null;
        transitions.push({ transition: 'half-open', accountId: e.accountId, armId: e.armId, cooloffHours: e.cooloffHours });
      }
    } else if (e.state === 'half-open') {
      if (e.probe && !probeLive(e, nowMs, cfg)) {
        e.probe = null;
        transitions.push({ transition: 'probe-expired', accountId: e.accountId, armId: e.armId });
      }
    } else {
      e.fails = (e.fails ?? []).filter(f => nowMs - f <= windowMs);
      if (e.fails.length === 0) delete store.arms[key];
    }
  }
  // The servable-arm universe follows the ladders: drop arms the tick has
  // not seen lately so a removed account cannot pin floors off, and keep it
  // bounded between persists.
  for (const key of Object.keys(store?.known ?? {})) {
    const lastSeen = store.known[key]?.lastSeen;
    if (typeof lastSeen !== 'number' || nowMs - lastSeen > BREAKER_KNOWN_STALE_MS) delete store.known[key];
  }
  return transitions;
}

/**
 * Drop open arms (and probe-occupied half-open arms) from rungs. Rung shells
 * stay even when emptied: decide() indexes rungs positionally, so removing
 * entries would shift every rung below the gap.
 */
export function filterBreakerRungs(rungs, store, accountId, nowMs, cfg = DEFAULT_BREAKERS) {
  if (cfg?.enabled === false) return rungs;
  return (rungs ?? []).map(g => ({
    ...g,
    arms: (g?.arms ?? []).filter(a => breakerAllows(store, accountId, a?.armId, nowMs, cfg)),
  }));
}

/** /capacity `armBreakers`: every tracked arm with its effective state. */
export function breakerReport(store, nowMs, cfg = DEFAULT_BREAKERS) {
  const out = [];
  for (const key of Object.keys(store?.arms ?? {})) {
    const e = store.arms[key];
    out.push({
      accountId: e.accountId,
      armId: e.armId,
      status: breakerState(store, e.accountId, e.armId, nowMs, cfg),
      openedAt: e.openedAt,
      cooloffHours: e.cooloffHours,
      consecutiveOpens: e.opens,
      recentFails: (e.fails ?? []).length,
      probeRunId: probeLive(e, nowMs, cfg) ? e.probe.runId : null,
      lastError: e.lastError,
    });
  }
  return out;
}
