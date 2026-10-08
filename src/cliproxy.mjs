/**
 * CLIProxy client internals for the model-capacity plugin.
 *
 * Pure functions only: request building, the overstrike allowlist guard, and
 * response parsing. Actual HTTP goes through `ctx.http.fetch` at the edges
 * (see plugin.mjs), so these units test without any network.
 *
 * Telemetry model (mirrors the host usage collector):
 * - Passive first: per-account provider rate-limit headers stored by CLIProxy
 *   on each auth file (`quota.signals` + `quota.observed_at`). No provider
 *   call is needed while the reading is fresh.
 * - Single-account live pull only when an account's reading is older than
 *   `staleAfterSec`: `POST /v0/management/api-call` with an allowlisted
 *   usage URL. CLIProxy substitutes `$TOKEN$` server-side.
 *
 * HARD RULE: this client only ever issues GET auth-files and POST api-call
 * with an allowlisted usage URL. Anything that consumes a quota reset is
 * blocked in code and covered by the allowlist test.
 */

export const DEFAULT_BASE_URL = 'http://cliproxy:8317';
export const AUTH_FILES_PATH = '/v0/management/auth-files';
export const API_CALL_PATH = '/v0/management/api-call';

export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Provider -> the one usage URL a live pull may use. Nothing else is allowed. */
export const USAGE_URL_BY_PROVIDER = Object.freeze({
  claude: ANTHROPIC_USAGE_URL,
  codex: CODEX_USAGE_URL,
});

const ALLOWED_URLS = new Set(Object.values(USAGE_URL_BY_PROVIDER));

export const ANTHROPIC_HEADERS = Object.freeze({
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'anthropic-beta': 'oauth-2025-04-20',
});

export const CODEX_HEADERS = Object.freeze({
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
});

const HEADERS_BY_PROVIDER = Object.freeze({ claude: ANTHROPIC_HEADERS, codex: CODEX_HEADERS });

/** Window seconds that decide which Codex window a reading belongs to. */
export const FIVE_HOUR_SECONDS = 18000;
export const WEEK_SECONDS = 604800;

/**
 * Throw unless the request is one this client is ever allowed to make:
 * - GET <base>/v0/management/auth-files, or
 * - POST <base>/v0/management/api-call whose body is a GET of an
 *   allowlisted usage URL.
 */
export function assertAllowedRequest({ method, url, body }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('cliproxy-request-blocked');
  }
  const path = parsed.pathname;
  if (method === 'GET' && path === AUTH_FILES_PATH && body == null) return;
  if (method === 'POST' && path === API_CALL_PATH && body && typeof body === 'object') {
    const target = body.url;
    if (body.method === 'GET' && typeof target === 'string' && ALLOWED_URLS.has(target)) return;
  }
  throw new Error('cliproxy-request-blocked');
}

/** Build a GET auth-files request (validated against the allowlist). */
export function buildAuthFilesRequest(baseUrl = DEFAULT_BASE_URL) {
  const url = `${baseUrl}${AUTH_FILES_PATH}`;
  assertAllowedRequest({ method: 'GET', url });
  return { method: 'GET', url };
}

/**
 * Build a single-account live-pull request for one provider account.
 * Only `claude` and `codex` have usage URLs; anything else throws
 * (no live pull exists for it, so it stays on passive/cached data).
 */
export function buildApiCallRequest(baseUrl = DEFAULT_BASE_URL, { authIndex, provider }) {
  const usageUrl = USAGE_URL_BY_PROVIDER[provider];
  if (!usageUrl || authIndex == null) throw new Error('cliproxy-live-pull-unsupported');
  const url = `${baseUrl}${API_CALL_PATH}`;
  const body = { auth_index: authIndex, method: 'GET', url: usageUrl, header: HEADERS_BY_PROVIDER[provider] };
  assertAllowedRequest({ method: 'POST', url, body });
  return { method: 'POST', url, body };
}

/** Clamp a 0-100 percent into a 0-1 ratio; null/invalid stays null. */
export function frac(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.min(v / 100, 1);
}

/** Epoch seconds (or ISO string) -> ISO Z string, else null. */
export function iso(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return new Date(ts * 1000).toISOString();
  }
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function epochOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function signalsOf(auth) {
  const q = auth?.quota;
  const sig = q?.signals;
  const obs = q?.observed_at;
  if (!sig || typeof sig !== 'object' || typeof obs !== 'string') return null;
  const atMs = Date.parse(obs);
  if (Number.isNaN(atMs)) return null;
  return { sig, atMs };
}

function passiveClaude(auth) {
  const s = signalsOf(auth);
  if (!s || s.sig['Anthropic-Ratelimit-Unified-7d-Utilization'] == null) return null;
  const out = {};
  for (const [hdr, name] of [['5h', 'fiveHour'], ['7d', 'weekly']]) {
    const raw = Number(s.sig[`Anthropic-Ratelimit-Unified-${hdr}-Utilization`]);
    if (!Number.isFinite(raw)) continue;
    // Header may be 0-1 or 0-100; normalize the same way the host collector does.
    out[name] = { utilization: frac(raw <= 1 ? raw * 100 : raw), resetsAt: iso(epochOf(s.sig[`Anthropic-Ratelimit-Unified-${hdr}-Reset`])) };
  }
  if (!out.fiveHour || out.fiveHour.utilization == null) return null;
  return { ...out, atMs: s.atMs };
}

function passiveCodex(auth) {
  const s = signalsOf(auth);
  if (!s || s.sig['X-Codex-Primary-Used-Percent'] == null) return null;
  const out = { plan: typeof s.sig['X-Codex-Plan-Type'] === 'string' ? s.sig['X-Codex-Plan-Type'] : null };
  for (const side of ['Primary', 'Secondary']) {
    const mins = epochOf(s.sig[`X-Codex-${side}-Window-Minutes`]) || 0;
    if (!mins) continue;
    const secs = mins * 60;
    const name = secs <= FIVE_HOUR_SECONDS ? 'fiveHour' : secs <= WEEK_SECONDS ? 'weekly' : 'monthly';
    out[name] = {
      utilization: frac(s.sig[`X-Codex-${side}-Used-Percent`]),
      resetsAt: iso(epochOf(s.sig[`X-Codex-${side}-Reset-At`])),
      windowSeconds: secs,
    };
  }
  if (!Object.keys(out).some(k => k !== 'plan' && out[k]?.utilization != null)) return null;
  return { ...out, atMs: s.atMs };
}

/**
 * Normalize one auth-files entry into an account record. Mirrors the host
 * collector's health and passive-signal extraction (disabled accounts are
 * excluded from the serving pool; sticky error strings alone are not
 * trusted without cooldown/unavailable flags).
 */
export function parseAuthFile(auth, nowMs = Date.now()) {
  const provider = auth?.provider ?? null;
  const authIndex = auth?.auth_index ?? null;
  const disabled = Boolean(auth?.disabled) || auth?.status === 'disabled';
  const unavailable = Boolean(auth?.unavailable);
  const cooldowns = Array.isArray(auth?.cooldowns) ? auth.cooldowns : [];
  let health = 'healthy';
  if (disabled) health = 'disabled';
  else if (unavailable) health = 'degraded';
  const passive = provider === 'claude' ? passiveClaude(auth) : provider === 'codex' ? passiveCodex(auth) : null;
  return {
    authIndex,
    provider,
    enabled: !disabled,
    health,
    unavailable,
    cooldownCount: cooldowns.length,
    fiveHour: passive?.fiveHour ?? null,
    weekly: passive?.weekly ?? null,
    monthly: passive?.monthly ?? null,
    plan: passive?.plan ?? null,
    signalsAtMs: passive?.atMs ?? null,
    nowMs,
  };
}

/** True when the account has no passive reading fresher than staleAfterSec. */
export function isStale(account, staleAfterSec = 300, nowMs = Date.now()) {
  if (!account?.enabled) return false;
  if (account.provider !== 'claude' && account.provider !== 'codex') return false;
  if (account.signalsAtMs == null) return true;
  return nowMs - account.signalsAtMs > staleAfterSec * 1000;
}

/** Parse a live Anthropic oauth/usage body into window readings. */
export function parseAnthropicUsageBody(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const [src, name] of [['five_hour', 'fiveHour'], ['seven_day', 'weekly']]) {
    const w = body[src];
    if (w && typeof w === 'object' && w.utilization != null) {
      out[name] = { utilization: frac(w.utilization), resetsAt: iso(w.resets_at) };
    }
  }
  return out.fiveHour || out.weekly ? out : null;
}

/** Parse a live Codex wham/usage body into window readings. */
export function parseCodexWhamBody(body) {
  if (!body || typeof body !== 'object') return null;
  const rl = body.rate_limit;
  if (!rl || typeof rl !== 'object') return null;
  const out = { plan: typeof body.plan_type === 'string' ? body.plan_type : null, exhausted: Boolean(rl.limit_reached) };
  for (const key of ['primary_window', 'secondary_window']) {
    const w = rl[key];
    if (w && typeof w === 'object' && w.used_percent != null) {
      const secs = Number(w.limit_window_seconds) || 0;
      const name = secs <= FIVE_HOUR_SECONDS ? 'fiveHour' : secs <= WEEK_SECONDS ? 'weekly' : 'monthly';
      out[name] = { utilization: frac(w.used_percent), resetsAt: iso(w.reset_at), windowSeconds: secs || null };
    }
  }
  return out.fiveHour || out.weekly || out.monthly ? out : null;
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
