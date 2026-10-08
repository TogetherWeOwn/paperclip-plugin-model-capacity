/**
 * Artificial Analysis free-API client internals (pure + edge split).
 *
 * Owner rule: free AA API only. Endpoint and auth mirror the existing
 * model-selection free-list sync: GET
 * https://artificialanalysis.ai/api/v2/data/llms/models with `x-api-key`.
 * The key comes from a Paperclip secret ref resolved at call time; it is
 * never cached, logged, or written to state.
 *
 * The free list returns one row per model x effort. The base slug (no
 * effort suffix) is the max effort row.
 */

export const AA_FREE_LIST_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';

/** The only URL this client may fetch. */
const ALLOWED_URLS = new Set([AA_FREE_LIST_URL]);

/** Evaluation keys in free-API `evaluations` objects, mapped to our fields. */
export const FREE_EVAL_FIELD_MAP = Object.freeze({
  artificial_analysis_intelligence_index: 'intelligenceIndex',
  artificial_analysis_coding_index: 'codingIndex',
  terminalbench_hard: 'terminalbenchHard',
  terminalbench_v2_1: 'terminalbenchV21',
  terminalbench_v4_0: 'terminalbenchV40',
  tau2: 'tau2',
  tau_banking: 'tauBanking',
  scicode: 'scicode',
  lcr: 'lcr',
  gpqa: 'gpqa',
  hle: 'hle',
  ifbench: 'ifbench',
  gdpval: 'gdpvalNormalized',
});

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * Validate fetch inputs. Throws `aa-url-rejected` for anything off the
 * allowlist and `aa-access-denied` when no key is configured.
 */
export function buildAaFetchArgs({ url = AA_FREE_LIST_URL, apiKey } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('aa-url-rejected');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('aa-url-rejected');
  if (!ALLOWED_URLS.has(`${parsed.origin}${parsed.pathname}`)) throw new Error('aa-url-rejected');
  if (!apiKey) throw new Error('aa-access-denied');
  return {
    url,
    options: {
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'x-api-key': apiKey },
      redirect: 'manual',
    },
  };
}

/**
 * Fetch the free list through the host HTTP client. Same failure taxonomy
 * as the existing free-list sync so operators already know what each code
 * means: the caller keeps the prior snapshot on any failure.
 */
export async function fetchAaFreeList({ http, apiKey, url = AA_FREE_LIST_URL, timeoutMs = 60000, maxResponseBytes = 8 * 1024 * 1024 }) {
  let args;
  try {
    args = buildAaFetchArgs({ url, apiKey });
  } catch (error) {
    return { ok: false, error: error.message, retryable: false };
  }
  let response;
  let timer;
  try {
    response = await Promise.race([
      http.fetch(args.url, args.options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('aa-request-timeout')), timeoutMs);
      }),
    ]);
  } catch {
    return { ok: false, error: 'aa-request-failed', retryable: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: 'aa-access-denied', status: response.status, retryable: false };
  }
  if (response.status === 429) {
    const header = response.headers?.get?.('retry-after');
    const raw = header == null || String(header).trim() === '' ? NaN : Number(header);
    return {
      ok: false,
      error: 'aa-rate-limited',
      retryable: true,
      retryAfterSeconds: Number.isFinite(raw) && raw >= 0 ? raw : null,
    };
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return { ok: false, error: 'aa-redirect-refused', retryable: false };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: 'aa-http-failed', status: response.status, retryable: response.status >= 500 };
  }
  let text;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: 'aa-request-failed', retryable: true };
  }
  if (new TextEncoder().encode(text).length > maxResponseBytes) {
    return { ok: false, error: 'aa-response-too-large', retryable: false };
  }
  return { ok: true, text };
}

/** Normalize one free-API row (nested evaluations/pricing) to flat fields. */
function normalizeFreeRow(entry) {
  const slug = str(entry.slug);
  if (!slug) return null;
  const ev = entry.evaluations && typeof entry.evaluations === 'object' ? entry.evaluations : {};
  const pricing = entry.pricing && typeof entry.pricing === 'object' ? entry.pricing : entry;
  const row = { slug };
  for (const field of new Set([...Object.values(FREE_EVAL_FIELD_MAP), 'apexAgents', 'omniscience'])) {
    row[field] = null;
  }
  for (const [evalKey, field] of Object.entries(FREE_EVAL_FIELD_MAP)) {
    row[field] = num(ev[evalKey]);
  }
  // Some feeds already use the flat leaderboard field names.
  for (const field of ['intelligenceIndex', 'intelligenceIndexCostPerTask', 'terminalbenchHard',
    'terminalbenchV21', 'terminalbenchV40', 'tau2', 'tauBanking', 'scicode', 'apexAgents',
    'omniscience', 'lcr', 'gpqa', 'hle', 'ifbench', 'gdpvalNormalized', 'contextWindowTokens',
    'medianOutputTokensPerSecond', 'price1mInputTokens', 'price1mOutputTokens']) {
    if (row[field] == null && entry[field] !== undefined) row[field] = num(entry[field]);
  }
  row.intelligenceIndexCostPerTask = num(entry.intelligenceIndexCostPerTask ?? pricing.intelligenceIndexCostPerTask);
  row.contextWindowTokens = num(entry.contextWindowTokens);
  row.medianOutputTokensPerSecond = num(entry.medianOutputTokensPerSecond ?? entry.median_output_tokens_per_second);
  row.name = str(entry.name);
  return row;
}

/** Parse fetched text into normalized rows; null when the shape is unknown. */
export function parseAaFreeList(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : null;
  if (!list) return null;
  const rows = [];
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const row = normalizeFreeRow(entry);
    if (row) {
      rows.push(row);
      if (seen.has(row.slug)) duplicates.add(row.slug);
      seen.add(row.slug);
    }
  }
  return rows.length > 0 ? { rows, duplicateSlugs: [...duplicates] } : null;
}
