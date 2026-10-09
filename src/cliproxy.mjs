/**
 * CLIProxy lane client internals for the model-capacity plugin.
 *
 * The plugin worker cannot reach CLIProxy directly (`ctx.http.fetch`
 * hard-blocks private IPs) and the management key stays on the host, so
 * all burn telemetry comes from ONE host-published endpoint:
 *
 *   GET {baseUrl}{accountsPath}
 *   header: X-Api-Key: <lane key, resolved from laneKeySecretRef>
 *
 * Response JSON:
 *   { observedAt, accounts: [{ lane, provider, accountKey, health,
 *     weekly: { used, resetsAt }, fiveHour: { used, resetsAt },
 *     observedAt, quality }] }
 * where `used` is 0..1 or null, `resetsAt` ISO or null, and `quality` is
 * passive|live|cached|unknown. The host service does passive-first plus a
 * single-account live pull on stale accounts, server-side.
 *
 * Pure functions only: request building, the overstrike allowlist guard,
 * and response parsing. Actual HTTP goes through `ctx.http.fetch` at the
 * edges (see plugin.mjs). A 45s in-memory cache keeps dozens of run
 * starts per minute on one reading.
 *
 * HARD RULE: this client only ever issues that one GET. Anything else is
 * blocked in code and covered by the allowlist test.
 */

export const DEFAULT_BASE_URL = 'https://router.infextion.net';
export const DEFAULT_ACCOUNTS_PATH = '/telemetry/cliproxy/live/accounts.json';

export const LANE_KEY_HEADER = 'X-Api-Key';

/**
 * Build the lane request. Only https URLs are allowed (this is a public
 * telemetry lane, never a link-local host address).
 */
export function buildLaneRequest(baseUrl = DEFAULT_BASE_URL, accountsPath = DEFAULT_ACCOUNTS_PATH) {
  let parsed;
  try {
    parsed = new URL(`${baseUrl}${accountsPath}`);
  } catch {
    throw new Error('cliproxy-request-blocked');
  }
  if (parsed.protocol !== 'https:') throw new Error('cliproxy-request-blocked');
  return { method: 'GET', url: `${baseUrl}${accountsPath}` };
}

/**
 * Throw unless the request is exactly the configured lane GET with no
 * body. The values come from operator config, so a misconfigured base URL
 * fails closed here instead of fetching somewhere unexpected.
 */
export function assertLaneRequest({ method, url, body }, { baseUrl, accountsPath } = {}) {
  const expected = buildLaneRequest(baseUrl, accountsPath);
  if (method === 'GET' && url === expected.url && body == null) return;
  throw new Error('cliproxy-request-blocked');
}

/** Ratio guard: `used` must be 0..1 or null. */
export function usedRatio(used) {
  if (used == null) return null;
  const v = Number(used);
  if (!Number.isFinite(v) || v < 0 || v > 1) return null;
  return v;
}

/**
 * Tolerant reset-timestamp parse: ISO string, epoch millis, or epoch
 * seconds. Null when unparseable. The lane has sent resets in more than
 * one of these shapes; dropping a numeric reset silently zeroes the
 * required-rate math downstream, so every shape is accepted here.
 */
export function resetAtMsOf(value) {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return value;
    if (value >= 1e9) return value * 1000;
  }
  return null;
}

function msOrNull(iso) {
  return resetAtMsOf(iso);
}

/**
 * Normalize one lane account entry. Unhealthy or unparseable entries are
 * kept with null windows (the pacer treats unknown as hold, never as
 * headroom) rather than dropped, so the shadow log can show the gap.
 */
export function parseLaneAccount(entry, nowMs = Date.now()) {
  const window = (w) => {
    if (!w || typeof w !== 'object') return { utilization: null, resetsAt: null };
    const raw = (typeof w.resetsAt === 'string' || typeof w.resetsAt === 'number') ? w.resetsAt : null;
    return { utilization: usedRatio(w.used), resetsAt: resetAtMsOf(raw) != null ? raw : null };
  };
  const weekly = window(entry?.weekly);
  const fiveHour = window(entry?.fiveHour);
  // Served model ids (CLIProxy ids this account routes): the ONLY
  // provider->models source. A new account or model added to CLIProxy is
  // picked up with zero code changes; accounts that predate the field
  // carry models: null.
  const rawModels = Array.isArray(entry?.models)
    ? entry.models.filter(m => typeof m === 'string' && m.length > 0)
    : null;
  return {
    accountId: `${entry?.provider ?? 'unknown'}:${entry?.accountKey ?? entry?.lane ?? 'x'}`,
    lane: entry?.lane ?? null,
    provider: entry?.provider ?? null,
    pool: entry?.pool ?? null,
    health: entry?.health ?? 'unknown',
    quality: entry?.quality ?? 'unknown',
    // Vendor-meter kind: 'reactive' = the vendor publishes no meter (the
    // account is usable but unpaced); anything else with usage numbers is
    // metered. Null on feeds that predate the field (treated as metered).
    meter: entry?.meter ?? null,
    models: rawModels,
    weekly: { ...weekly, resetsAtMs: msOrNull(weekly.resetsAt) },
    fiveHour: { ...fiveHour, resetsAtMs: msOrNull(fiveHour.resetsAt) },
    signalsAtMs: msOrNull(entry?.observedAt) ?? nowMs,
    nowMs,
  };
}

/**
 * True when the account publishes no vendor meter: the vendor exposes no
 * usage numbers (quality/meter 'reactive'), so the account is usable but
 * unpaced. Distinct from a metered account with missing numbers (a broken
 * reading -- never eligible). Feeds that predate the meter field report
 * null, which counts as metered.
 */
export function isReactiveAccount(account) {
  return account?.meter === 'reactive' || account?.quality === 'reactive';
}

/** Parse the whole lane body; null when the shape is unknown. */
export function parseLaneBody(body, nowMs = Date.now()) {
  const list = body?.accounts;
  if (!Array.isArray(list)) return null;
  const observedAt = typeof body.observedAt === 'string' ? body.observedAt : null;
  return {
    observedAt,
    observedAtMs: msOrNull(observedAt),
    accounts: list.filter(a => a && typeof a === 'object').map(a => parseLaneAccount(a, nowMs)),
    atMs: nowMs,
    source: 'cliproxy-lane',
  };
}

/** Tiny TTL cache so dozens of run starts per minute share one reading. */
export class CliproxyCache {
  constructor(ttlMs = 45000) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key, nowMs = Date.now()) {
    const entry = this.store.get(key);
    if (!entry || nowMs - entry.atMs > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, nowMs = Date.now()) {
    this.store.set(key, { value, atMs: nowMs });
  }

  clear() {
    this.store.clear();
  }
}
