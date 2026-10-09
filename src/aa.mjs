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

/**
 * Second source: the public leaderboard page embeds the FULL flat field
 * set (intelligenceIndexCostPerTask, gdpvalNormalized, terminalbench*,
 * tau2, apexAgents, omniscience*, prices, speeds, contextWindowTokens, …)
 * that the free API omits. No key needed. Same parsing logic as the
 * model-selection free-list sync: find the models-array anchor, extract
 * the balanced array, unescape one layer, JSON-parse.
 */
export const AA_LEADERBOARD_URL = 'https://artificialanalysis.ai/leaderboards/models';

/** The only URLs this client may fetch. */
const ALLOWED_URLS = new Set([AA_FREE_LIST_URL, AA_LEADERBOARD_URL]);

/** Flat numeric fields carried from leaderboard records (model-selection parity). */
export const LEADERBOARD_NUMERIC_FIELDS = Object.freeze([
  'intelligenceIndex',
  'intelligenceIndexCostPerTask',
  'price1mInputTokens',
  'price1mOutputTokens',
  'cacheHitPrice',
  'cacheWritePrice',
  'medianOutputTokensPerSecond',
  'outputTokensPerSecondP5',
  'outputTokensPerSecondP25',
  'outputTokensPerSecondP75',
  'outputTokensPerSecondP95',
  'medianTimeToFirstTokenSeconds',
  'medianTimeToFirstAnswerTokenSeconds',
  'medianEndToEndResponseTimeSeconds',
  'medianReasoningTimeSeconds',
  'contextWindowTokens',
  'gpqa',
  'hle',
  'critpt',
  'lcr',
  'ifbench',
  'tau2',
  'terminalbenchHard',
  'mmmuPro',
  'gdpvalNormalized',
  'terminalbenchV21',
  'tauBanking',
  'scicode',
  'terminalbenchV40',
  'itbenchSre',
  'analystAgent',
  'apexAgents',
  'omniscience',
  'omniscienceAccuracy',
  'omniscienceNonHallucination',
]);

const LEADERBOARD_STRING_FIELDS = Object.freeze(['name', 'shortName', 'modelCreatorName', 'paramClass', 'priceClass']);
const LEADERBOARD_BOOLEAN_FIELDS = Object.freeze(['deprecated', 'isReasoning', 'isOpenWeights', 'intelligenceIndexIsEstimated']);

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

/** Fetch args for the public leaderboard page (no key; same URL guard). */
export function buildAaLeaderboardFetchArgs({ url = AA_LEADERBOARD_URL } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('aa-url-rejected');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('aa-url-rejected');
  if (`${parsed.origin}${parsed.pathname}` !== AA_LEADERBOARD_URL) throw new Error('aa-url-rejected');
  return {
    url,
    options: {
      method: 'GET',
      headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' },
      redirect: 'manual',
    },
  };
}

/**
 * Fetch the leaderboard page through the host HTTP client. Same failure
 * taxonomy as the free-list fetch (minus key/rate-limit codes, which do
 * not apply to a public page): the caller keeps the prior snapshot on any
 * failure. Defaults mirror the model-selection sync: 10s, ~8MB.
 */
export async function fetchAaLeaderboard({ http, url = AA_LEADERBOARD_URL, timeoutMs = 10000, maxResponseBytes = 8000000 }) {
  let args;
  try {
    args = buildAaLeaderboardFetchArgs({ url });
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
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return { ok: false, error: 'aa-redirect-refused', retryable: false };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: 'aa-http-failed', status: response.status, retryable: response.status >= 500 };
  }
  let html;
  try {
    html = await response.text();
  } catch {
    return { ok: false, error: 'aa-request-failed', retryable: true };
  }
  if (new TextEncoder().encode(html).length > maxResponseBytes) {
    return { ok: false, error: 'aa-response-too-large', retryable: false };
  }
  return { ok: true, html };
}

// Anchor of the embedded models array on the leaderboard page. The page
// embeds the JSON inside a JS string, so the quotes carry literal
// backslashes: {\"models\":[{\"slug\":\"glm-4-5v\"...
const LEADERBOARD_ANCHOR = '{\\"models\\":[{\\"slug\\":\\"glm-4-5v\\"';
const LEADERBOARD_BRACKET_OFFSET = LEADERBOARD_ANCHOR.indexOf('[');

function extractBalancedArray(html, arrayStart) {
  let depth = 0;
  let inString = false;
  let i = arrayStart;
  for (; i < html.length;) {
    const ch = html[i];
    const next = html[i + 1];
    if (ch === '\\' && next === '"') {
      inString = !inString;
      i += 2;
      continue;
    }
    if (ch === '\\' && next === '\\') {
      i += 2;
      continue;
    }
    if (inString) {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return html.slice(arrayStart, i + 1);
    }
    i += 1;
  }
  return null;
}

function buildLeaderboardRow(rec) {
  const slug = rec?.slug;
  if (typeof slug !== 'string' || slug.length === 0) return null;
  const row = { slug };
  for (const key of LEADERBOARD_STRING_FIELDS) row[key] = typeof rec[key] === 'string' ? rec[key] : null;
  for (const key of LEADERBOARD_BOOLEAN_FIELDS) row[key] = typeof rec[key] === 'boolean' ? rec[key] : null;
  for (const key of LEADERBOARD_NUMERIC_FIELDS) row[key] = num(rec[key]);
  return row;
}

/** Parse leaderboard HTML into flat rows; null when the shape is unknown. */
export function parseAaLeaderboardHtml(html) {
  if (typeof html !== 'string') return null;
  const anchorIndex = html.indexOf(LEADERBOARD_ANCHOR);
  if (anchorIndex < 0) return null;
  const balanced = extractBalancedArray(html, anchorIndex + LEADERBOARD_BRACKET_OFFSET);
  if (balanced === null) return null;
  const unescaped = balanced.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  let parsed;
  try {
    parsed = JSON.parse(unescaped);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const row = buildLeaderboardRow(entry);
    if (row) rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

/**
 * Merge free-API rows with leaderboard rows per slug. The leaderboard wins
 * for fields it has (non-null); the API fills the gaps; slugs present in
 * only one source still appear. Returns { rows, duplicateSlugs,
 * leaderboardSlugs }.
 */
export function mergeAaRows(apiRows = [], leaderboardRows = []) {
  const bySlug = new Map();
  const counts = new Map();
  for (const row of apiRows ?? []) {
    if (!row || typeof row.slug !== 'string') continue;
    counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, { ...row });
  }
  const leaderboardSlugs = new Set();
  for (const row of leaderboardRows ?? []) {
    if (!row || typeof row.slug !== 'string') continue;
    counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
    leaderboardSlugs.add(row.slug);
    const base = bySlug.get(row.slug);
    if (!base) {
      bySlug.set(row.slug, { ...row });
      continue;
    }
    for (const [k, v] of Object.entries(row)) {
      if (k === 'slug') continue;
      if (v != null) base[k] = v;
    }
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  return { rows: [...bySlug.values()], duplicateSlugs: duplicates, leaderboardSlugs: [...leaderboardSlugs] };
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
