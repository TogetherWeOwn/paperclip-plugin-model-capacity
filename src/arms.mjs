/**
 * Arm mapping: CLIProxy model ids -> AA slugs -> ladder arms.
 *
 * Two sources feed one arm table:
 *
 * 1. CLASSIC (static): DEFAULT_ARM_MAP below, operator-overridable via
 *    config `armMap`. Covers the long-standing fleet models where the
 *    AA-slug <-> CLIProxy-id relationship was verified by hand.
 *
 * 2. DYNAMIC (data-driven): every model id the lane feed reports ANY
 *    account serving (account `models`) becomes a candidate arm. The AA
 *    slug is found by normalization (provider-prefix strip, dots->dashes,
 *    `-free`/`-1m`/date-suffix strip, `-contributor` -> xhigh effort) plus
 *    the small MODEL_AA_OVERRIDES table for names normalization cannot
 *    reach. Candidates with no AA match stay UNRANKABLE: they build no arm
 *    and are reported as `unscored` (with the reason) instead of being
 *    silently dropped. A new account added to CLIProxy is picked up with
 *    zero code changes -- no provider list is hardcoded anywhere.
 *
 * Ladders are PER ACCOUNT: an arm is eligible on an account iff the
 * account serves its model id (account `models` includes it) or -- for
 * classic entries on feeds that predate `models` -- the classic provider
 * binding matches. A Codex-family arm never appears on a Claude
 * account's ladder.
 */

export const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * Families with a ceiling below ultra. Meta's responses API accepts
 * `reasoning.effort` none..max for Muse 1.3 Contributor models and rejects
 * anything else (probed 2026-10-19).
 */
export const MAX_EFFORT_BY_FAMILY = Object.freeze({ muse: 'max' });

/**
 * Families proven by months of fleet history. Arms of these families route
 * as full members; every other family is a TRIAL (doer-only,
 * adapter-gated, in-flight-capped) until measured fleet success graduates
 * it. This is a family seed, not a provider list: new providers arrive as
 * trials automatically, which is the safe default.
 */
export const PROVEN_FAMILIES = Object.freeze(['opus', 'sonnet', 'haiku', 'sol', 'luna', 'astra', 'muse']);

/**
 * CLIProxy model id -> AA slug where slug normalization cannot reach.
 * Small by design: every entry is a verified mismatch (checked against the
 * live AA leaderboard), operator-extendable via config `modelAaOverrides`.
 * Values may be a slug string (effort max) or { slug, effort }.
 */
export const MODEL_AA_OVERRIDES = Object.freeze({
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'gemini-3-1-pro': 'gemini-3-1-pro-preview',
  'gpt-oss-120b-medium': 'gpt-oss-120b',
  'kimi-k3-256k': 'kimi-k3',
  'nemotron-3-ultra': 'nemotron-3-ultra-550b-a55b',
  'grok-4-20-0309-reasoning': 'grok-4-20-0309',
  'grok-3-mini': 'grok-3-mini-reasoning',
  'muse-spark-1.2-contributor': { slug: 'muse-spark-1-2', effort: 'xhigh' },
});

/** Model ids that can never carry an agent run: media, test, and private ids. */
export const NON_CHAT_MODEL_RE = /(image|video|private|^test([_-]|$))/i;

/**
 * Strip a `provider/` alias prefix to the canonical bare model id. Also
 * strips the emission decorations the plugin (and host balancer) add for
 * 1M-context claude runs: a trailing `[1m]` context suffix and a trailing
 * `(effort)` paren suffix, so decorated actuals (`claude-haiku-5-5(max)[1m]`
 * or the CLI-stripped `claude-haiku-5-5(max)`) still map to the arm that
 * serves the bare id. No served id or AA slug carries parens or brackets,
 * so the strip only ever turns a miss into a hit.
 */
export function canonicalModelName(model) {
  if (typeof model !== 'string') return null;
  let bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  if (bare.endsWith('[1m]')) bare = bare.slice(0, -4);
  if (bare.endsWith(')') && bare.includes('(')) bare = bare.slice(0, bare.lastIndexOf('('));
  return bare.length > 0 ? bare : null;
}

/** Identity for ban checks and opt-in duplicate comparisons, never emission. */
export function aliasKey(model) {
  const canon = canonicalModelName(model);
  return canon ? canon.toLowerCase().replace(/(\d)\.(?=\d)/g, '$1-') : null;
}

export const MANDATORY_BANNED_MODELS = Object.freeze(['gpt-6-sol', 'gpt-5.6-terra']);
export function isBannedModel(model, additionalBans = []) {
  const key = aliasKey(model);
  return !!key && [...MANDATORY_BANNED_MODELS, ...(additionalBans ?? [])].some(b => aliasKey(b) === key);
}

/**
 * Providers whose lanes serve ONLY under the provider-prefixed id (never the
 * bare id). A `devin/<id>` lane 400s the bare id as unknown provider, so the
 * prefixed emission is required even when the served list is absent
 * (fail-open old feeds). Native lanes keep byte-identical bare emission.
 * synthetic / synthetic-infinite (synthetic.new, 2026-10-23): CLIProxy serves
 * them only as `synthetic/<id>` and `synthetic-infinite/<id>`; the bare id is
 * unknown to CLIProxy or, for kimi-k3 / glm-5.3, belongs to another provider.
 * nvidia-nim (NVIDIA NIM free lane, 2026-10-24): CLIProxy serves it only as
 * `nvidia-nim/<id>`; the bare id is unknown to CLIProxy or names another
 * provider's model.
 */
export const PREFIXED_ONLY_PROVIDERS = Object.freeze(['devin', 'opencode-go', 'synthetic', 'synthetic-infinite', 'nvidia-nim']);

/**
 * Exact model id to emit for an arm on one account. The account's feed
 * `models` list is authoritative, with one native-emission guard: when the
 * account lists the bare id, it is emitted unchanged (bare lanes never take
 * a prefixed alias, so a native account listing both forms stays on its own
 * route) -- except on a prefixed-only provider, whose own `provider/<id>`
 * alias always wins when listed. When the account lists ONLY a prefixed alias, the bare id is still
 * emitted whenever it is served (or the served list is unknown and the
 * provider is not prefixed-only) -- base emitted bare for every native
 * account, and credential readiness stays keyed on the bare id. The listed
 * prefixed id is emitted only when the bare id is unserved or the provider
 * is prefixed-only (`devin`, `opencode-go`: every Devin id is `devin/*`, so
 * emitting the bare id 400s as unknown provider or misbills to the native
 * lane serving the bare id). Falls back to the arm id when the account
 * publishes no list or no match.
 *
 * servedIds is the feed's global served list (Set or Array of exact ids) or
 * null when the feed publishes none (fail-open): with no list, native
 * providers emit bare and prefixed-only providers emit their listed alias.
 */
export function servedIdForArm(accountModels, armModel, provider = null, servedIds = null) {
  if (typeof armModel !== 'string' || armModel.length === 0) return armModel;
  if (!Array.isArray(accountModels)) return armModel;
  let bareHit = null;
  let prefixedHit = null;
  let providerHit = null;
  const wantProvider = typeof provider === 'string' ? provider.toLowerCase() : null;
  for (const raw of accountModels) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (canonicalModelName(raw) !== armModel) continue;
    if (!raw.includes('/')) {
      bareHit ??= raw;
      continue;
    }
    prefixedHit ??= raw;
    if (wantProvider && raw.slice(0, raw.indexOf('/')).toLowerCase() === wantProvider) {
      providerHit ??= raw;
    }
  }
  // A prefixed-only provider never emits a bare id, even one its account
  // also lists: its own `provider/<id>` alias wins (the bare id is unknown
  // to CLIProxy or names another provider's model).
  if (providerHit && wantProvider && PREFIXED_ONLY_PROVIDERS.includes(wantProvider)) return providerHit;
  if (bareHit) return bareHit;
  if (!prefixedHit && !providerHit) return armModel;
  if (wantProvider && PREFIXED_ONLY_PROVIDERS.includes(wantProvider)) {
    return providerHit ?? prefixedHit ?? armModel;
  }
  if (servedIds != null) {
    const hasBare = typeof servedIds.has === 'function'
      ? servedIds.has(armModel)
      : Array.isArray(servedIds) ? servedIds.includes(armModel) : false;
    if (hasBare) return armModel;
    return providerHit ?? prefixedHit ?? armModel;
  }
  return armModel;
}

/**
 * Infer the arm family from a canonical CLIProxy model id. Ordered rules,
 * first match wins; novel generations without history (claude-4-6) get
 * their own trial family instead of inheriting a proven one. Unknown
 * models fall back to their first dash-segment so unrelated models never
 * share a trial budget or success history.
 */
export function inferFamily(canonical) {
  if (typeof canonical !== 'string' || canonical.length === 0) return null;
  const lower = canonical.toLowerCase();
  if (/^claude-(opus|sonnet)-4-6/.test(lower)) return 'claude-4-6';
  if (lower.includes('claude-opus')) return 'opus';
  if (lower.includes('claude-sonnet')) return 'sonnet';
  if (lower.includes('claude-haiku')) return 'haiku';
  if (lower.includes('claude-fable') || lower.includes('fable')) return 'fable';
  if (lower.includes('luna')) return 'luna';
  if (lower.includes('astra')) return 'astra';
  if (lower.includes('terra')) return 'terra';
  if (lower.includes('gpt-oss') || /(^|-)oss([-]|$)/.test(lower)) return 'oss';
  if (lower.includes('sol')) return 'sol';
  if (lower.includes('gemini') || lower.includes('gemma')) return 'gemini';
  if (lower.includes('grok')) return 'grok';
  if (lower.includes('kimi')) return 'kimi';
  if (lower.includes('glm')) return 'glm';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('qwen')) return 'qwen';
  if (lower.includes('muse')) return 'muse';
  if (lower.includes('nemotron')) return 'nemotron';
  if (lower.includes('minimax')) return 'minimax';
  if (lower.includes('mimo')) return 'mimo';
  if (lower.includes('longcat')) return 'longcat';
  if (lower.includes('ling')) return 'ling';
  if (lower.includes('mistral')) return 'mistral';
  if (lower.includes('hyperclova') || lower === 'hy3' || lower.startsWith('hy3-') || lower.startsWith('hy4')) return 'hy';
  if (lower.includes('step')) return 'step';
  if (lower.includes('inkling')) return 'inkling';
  if (lower.startsWith('model_')) {
    for (const hint of ['opus', 'sonnet', 'haiku', 'gemini', 'gpt']) {
      if (lower.includes(hint)) return hint === 'gpt' ? 'sol' : hint;
    }
    return 'legacy-devin';
  }
  return lower.split('-')[0] || null;
}

/**
 * Guess an arm family from a run's model string (shadow `model(effort)`
 * labels, heartbeat usage_json). Prefix-aware inference first, substring
 * hints for legacy labels; null when nothing matches. Used only to map
 * runs to accounts when the run names no served model id.
 */
const FAMILY_HINTS = Object.freeze(['opus', 'sonnet', 'haiku', 'fable', 'astra', 'luna', 'terra', 'sol', 'muse',
  'gemini', 'grok', 'kimi', 'glm', 'deepseek', 'qwen', 'oss', 'nemotron', 'minimax', 'mimo', 'mistral']);

export function familyOfModelName(model) {
  if (typeof model !== 'string') return null;
  const canon = canonicalModelName(model) ?? model;
  const inferred = inferFamily(canon);
  if (inferred) return inferred;
  const lower = canon.toLowerCase();
  for (const hint of FAMILY_HINTS) {
    if (lower.includes(hint)) return hint;
  }
  return null;
}

/**
 * AA slug candidates for a canonical model id, strongest first:
 * as-is, dots->dashes (gpt-6.1-sol -> gpt-6-1-sol), date-suffix strip,
 * `-free` lane-price strip, `-1m` context-suffix strip, `-contributor`
 * (xhigh effort). Overrides bypass this list entirely.
 */
export function slugCandidates(canonical) {
  if (typeof canonical !== 'string' || canonical.length === 0) return [];
  const out = [canonical];
  const dashed = canonical.replace(/\./g, '-');
  if (dashed !== canonical) out.push(dashed);
  const base = dashed;
  const undated = base.replace(/-\d{8}$/, '');
  if (undated !== base) out.push(undated);
  if (base.endsWith('-free')) out.push(base.slice(0, -5));
  if (base.endsWith('-1m')) out.push(base.slice(0, -3));
  if (base.endsWith('-contributor')) out.push(`${base.slice(0, -12)}-xhigh`);
  return [...new Set(out)];
}

/** Effort label for a dynamic arm: contributor rows run xhigh, else max. */
export function dynamicEffort(canonical) {
  return canonical.endsWith('-contributor') ? 'xhigh' : 'max';
}

/**
 * Build dynamic arm bindings from the model ids the lane feed reports.
 * servedModels: iterable of raw model ids (bare or provider-prefixed).
 * coveredModels: canonical ids the classic table already binds (skipped).
 * Returns { bindings, unscored }: bindings are
 * { aaSlug, model, effort, family, providers: null, dynamic: true };
 * unscored are { model, reason, tried } for the capacity report.
 */
export function buildDynamicBindings(servedModels, { coveredModels = [], overrides = {}, bannedModels = [] } = {}) {
  const covered = new Set(coveredModels);
  const seen = new Set();
  const bindings = [];
  const unscored = [];
  for (const raw of servedModels ?? []) {
    const model = canonicalModelName(raw);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    if (isBannedModel(model, bannedModels)) { unscored.push({ model, reason: 'banned-model', tried: [] }); continue; }
    if (covered.has(model)) continue;
    if (NON_CHAT_MODEL_RE.test(model)) {
      unscored.push({ model, reason: 'non-chat-model', tried: [] });
      continue;
    }
    const family = inferFamily(model);
    const override = overrides[model] ?? MODEL_AA_OVERRIDES[model];
    if (override != null) {
      const aaSlug = typeof override === 'string' ? override : override.slug;
      const effort = typeof override === 'string' ? dynamicEffort(model) : (override.effort ?? 'max');
      bindings.push({ aaSlug, model, effort, family, providers: null, dynamic: true });
      continue;
    }
    const tried = slugCandidates(model);
    bindings.push({ aaSlug: tried[0], slugCandidates: tried, model, effort: dynamicEffort(model), family, providers: null, dynamic: true });
  }
  return { bindings, unscored };
}

/**
 * Join dynamic bindings to AA snapshot rows. A binding matches when its
 * override slug or any slug candidate names a snapshot row; effort must be
 * expressible (muse cap applies to contributor rows). No match -> unscored
 * entry with reason `no-aa-match` (the model stays unrankable and is
 * listed, never silently dropped).
 */
export function resolveDynamicArms(aaRows, bindings, { unscoredAllowlist = new Map(), bannedModels = [] } = {}) {
  const bySlug = new Map();
  const counts = new Map();
  for (const row of aaRows ?? []) {
    counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
  }
  const arms = [];
  const unscored = [];
  for (const b of bindings ?? []) {
    const tried = b.slugCandidates ?? [b.aaSlug];
    let slug = null;
    let row = null;
    for (const candidate of tried) {
      if ((counts.get(candidate) ?? 0) > 1) continue;
      const hit = bySlug.get(candidate);
      if (hit) {
        slug = candidate;
        row = hit;
        break;
      }
    }
    if (!row) {
      const entries = unscoredAllowlist.get(b.model) ?? [];
      if (entries.length && !isBannedModel(b.model, bannedModels)) {
        if (PROVEN_FAMILIES.includes(inferFamily(b.model))) {
          unscored.push({ model: b.model, reason: 'unscored-proven-family', tried });
          continue;
        }
        if (effortAllowed(b.family, b.effort)) {
          arms.push({ armId: b.model, aaSlug: null, model: b.model, effort: b.effort,
            family: b.family, providers: null, dynamic: true, row: null, unscoredTrial: true,
            unscoredServedIds: entries.map(e => e.servedId),
            unscoredReasons: Object.fromEntries(entries.map(e => [e.servedId, e.reason])) });
          continue;
        }
      }
      unscored.push({ model: b.model, reason: 'no-aa-match', tried });
      continue;
    }
    // Carried history, not a served model: a lane that still lists the id must
    // not resurrect an arm the feed retired (the classic guard alone would let
    // buildAccountLadders bind it dynamically instead).
    if (row.historicalOnly) {
      unscored.push({ model: b.model, reason: 'slug-prior-only', tried });
      continue;
    }
    if (!effortAllowed(b.family, b.effort)) {
      unscored.push({ model: b.model, reason: 'effort-inexpressible', tried });
      continue;
    }
    arms.push({ armId: b.model, aaSlug: slug, model: b.model, effort: b.effort, family: b.family, providers: null, dynamic: true, row });
  }
  return { arms, unscored };
}

/**
 * Default arm table. Operator-overridable via config `armMap`; entries here
 * cover the long-standing fleet models. Dynamic discovery fills in
 * everything else the feed serves.
 */
export const DEFAULT_ARM_MAP = Object.freeze([
  { aaSlug: 'claude-opus-5-5', model: 'claude-opus-5-5', effort: 'max', family: 'opus', providers: ['claude'] },
  { aaSlug: 'claude-opus-5-5-xhigh', model: 'claude-opus-5-5', effort: 'xhigh', family: 'opus', providers: ['claude'] },
  { aaSlug: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5', effort: 'max', family: 'sonnet', providers: ['claude'] },
  { aaSlug: 'claude-sonnet-5-5-xhigh', model: 'claude-sonnet-5-5', effort: 'xhigh', family: 'sonnet', providers: ['claude'] },
  { aaSlug: 'claude-sonnet-5-5-high', model: 'claude-sonnet-5-5', effort: 'high', family: 'sonnet', providers: ['claude'] },
  { aaSlug: 'claude-haiku-5-5', model: 'claude-haiku-5-5', effort: 'max', family: 'haiku', providers: ['claude'] },
  { aaSlug: 'claude-haiku-5-5-xhigh', model: 'claude-haiku-5-5', effort: 'xhigh', family: 'haiku', providers: ['claude'] },
  { aaSlug: 'gpt-6-1-sol', model: 'gpt-6.1-sol', effort: 'max', family: 'sol', providers: ['codex'] },
  { aaSlug: 'gpt-6-1-sol-high', model: 'gpt-6.1-sol', effort: 'high', family: 'sol', providers: ['codex'] },
  { aaSlug: 'gpt-6-1-luna', model: 'gpt-6.1-luna', effort: 'max', family: 'luna', providers: ['codex'] },
  { aaSlug: 'gpt-6-1-luna-high', model: 'gpt-6.1-luna', effort: 'high', family: 'luna', providers: ['codex'] },
  { aaSlug: 'gpt-6-luna', model: 'gpt-6-luna', effort: 'max', family: 'luna', providers: ['codex'] },
  { aaSlug: 'gpt-6-luna-xhigh', model: 'gpt-6-luna', effort: 'xhigh', family: 'luna', providers: ['codex'] },
  { aaSlug: 'gpt-6-luna-high', model: 'gpt-6-luna', effort: 'high', family: 'luna', providers: ['codex'] },
  { aaSlug: 'gpt-6-luna-medium', model: 'gpt-6-luna', effort: 'medium', family: 'luna', providers: ['codex'] },
  { aaSlug: 'gpt-6-luna-low', model: 'gpt-6-luna', effort: 'low', family: 'luna', providers: ['codex'] },
  { aaSlug: 'gpt-6-astra', model: 'gpt-6-astra', effort: 'max', family: 'astra', providers: ['codex'] },
  { aaSlug: 'gpt-6-astra-xhigh', model: 'gpt-6-astra', effort: 'xhigh', family: 'astra', providers: ['codex'] },
  { aaSlug: 'gpt-6-astra-high', model: 'gpt-6-astra', effort: 'high', family: 'astra', providers: ['codex'] },
  { aaSlug: 'gpt-6-astra-medium', model: 'gpt-6-astra', effort: 'medium', family: 'astra', providers: ['codex'] },
  { aaSlug: 'gpt-6-astra-low', model: 'gpt-6-astra', effort: 'low', family: 'astra', providers: ['codex'] },
  { aaSlug: 'muse-spark-1-3', model: 'muse-spark-1.3-contributor', effort: 'max', family: 'muse', providers: ['meta'] },
  { aaSlug: 'muse-spark-1-3-xhigh', model: 'muse-spark-1.3-contributor', effort: 'xhigh', family: 'muse', providers: ['meta'] },
]);

/** Effort suffix parsing: trailing `-<effort>` else the base slug = max. */
export function parseEffortSuffix(aaSlug) {
  const m = /-((?:minimal|low|medium|high|xhigh|max|ultra))$/.exec(aaSlug);
  return m ? m[1] : 'max';
}

/** False when the effort is not expressible for the family (Muse above xhigh). */
export function effortAllowed(family, effort) {
  const cap = MAX_EFFORT_BY_FAMILY[family];
  if (!cap) return EFFORT_ORDER.includes(effort);
  return EFFORT_ORDER.includes(effort) && EFFORT_ORDER.indexOf(effort) <= EFFORT_ORDER.indexOf(cap);
}

/**
 * Join the classic arm table to AA snapshot rows. Returns matched arms
 * plus a skip list (ambiguous slug, absent slug, inexpressible effort) so
 * the shadow log can say why an arm is missing instead of silently
 * dropping it.
 */
export function resolveArms(aaRows, armMap = DEFAULT_ARM_MAP, { bannedModels = [] } = {}) {
  const bySlug = new Map();
  const counts = new Map();
  for (const row of aaRows ?? []) {
    counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
  }
  const arms = [];
  const skipped = [];
  for (const binding of armMap) {
    if (isBannedModel(binding.model, bannedModels)) { skipped.push({ aaSlug: binding.aaSlug, reason: 'banned-model' }); continue; }
    if ((counts.get(binding.aaSlug) ?? 0) > 1) {
      skipped.push({ aaSlug: binding.aaSlug, reason: 'slug-ambiguous' });
      continue;
    }
    const row = bySlug.get(binding.aaSlug);
    if (!row) {
      skipped.push({ aaSlug: binding.aaSlug, reason: 'slug-absent-from-snapshot' });
      continue;
    }
    // A slug the feed stopped serving keeps its benchmark history but must
    // never route: carried pre-migration values would hold the arm eligible
    // forever.
    if (row.historicalOnly) {
      skipped.push({ aaSlug: binding.aaSlug, reason: 'slug-prior-only' });
      continue;
    }
    if (!effortAllowed(binding.family, binding.effort)) {
      skipped.push({ aaSlug: binding.aaSlug, reason: 'effort-inexpressible' });
      continue;
    }
    arms.push({ armId: binding.aaSlug, ...binding, row });
  }
  return { arms, skipped };
}

/**
 * Arms of one account's ladder. When the account publishes a `models` list
 * (the auto-discovery feed), membership alone decides -- for classic AND
 * dynamic arms, with no provider tag involved. A model the feed stops
 * serving leaves every ladder automatically; a pool account serving a
 * classic id gets the classic arm whatever its provider tag reads. Only on
 * feeds that predate `models` do classic arms fall back to their provider
 * binding (dynamic arms need a list: never served anywhere = never
 * eligible).
 */
export function armsForAccount(arms, account) {
  const provider = account?.provider;
  const served = account?.models;
  return (arms ?? [])
    .filter(arm => {
      if (Array.isArray(served)) return served.map(canonicalModelName).includes(arm.model);
      return arm.providers != null && arm.providers.includes(provider);
    })
    .sort((a, b) => (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0));
}

/** Identity-preserving AA aliases, composed rather than mutually exclusive.
 * Never strip arbitrary/date/generation suffixes in the trusted path. */
export function taskSlugBases(model) {
  const canon = canonicalModelName(model);
  if (!canon) return [];
  let base = canon.replace(/\./g, '-');
  // Price/context/contributor decorations may be combined by a served lane.
  let prior;
  do {
    prior = base;
    base = base.replace(/(?:-free|:free|-1m|-contributor)$/, '');
  } while (base !== prior);
  return [...new Set([canon, canon.replace(/\./g, '-'), base])];
}

export const taskArmId = (model, effort) => `${taskSlugBases(model).at(-1) ?? model}@${effort}`;

/** Discover all exact model-effort observations for served models only.
 * Existing classic bindings are verified effort evidence; newly discovered
 * variants require an explicit endpoint effortSupport declaration. A family
 * ceiling proves rejection above it, never acceptance below it. Unknown and
 * borrowed observations stay in the report, not normal benchmark admission. */
export function discoverTaskArms(aaRows, servedModels, { armMap = DEFAULT_ARM_MAP, overrides = {}, effortSupport = {}, bannedModels = [] } = {}) {
  const counts = new Map();
  for (const r of aaRows ?? []) if (typeof r?.slug === 'string') counts.set(r.slug, (counts.get(r.slug) ?? 0) + 1);
  const unique = (aaRows ?? []).filter(r => r?.slug && counts.get(r.slug) === 1);
  // Historical rows are reporting evidence, never candidates: task ranking
  // would otherwise keep scoring a retired slug on its carried benchmarks.
  const historical = unique.filter(r => r.historicalOnly);
  const rows = unique.filter(r => !r.historicalOnly);
  const arms = [], unscored = [];
  for (const model of new Set([...(servedModels ?? [])].map(canonicalModelName).filter(Boolean))) {
    const bases = taskSlugBases(model);
    if (isBannedModel(model, bannedModels)) { unscored.push({ model, reason: 'banned-model', tried: [] }); continue; }
    const family = inferFamily(model);
    if (NON_CHAT_MODEL_RE.test(model)) { unscored.push({ model, reason: 'non-chat-model', tried: bases }); continue; }
    if ((family === 'muse' && !/-contributor(?:-free|:free|-1m)*$/.test(model))
      || (family === 'sol' && !bases.includes('gpt-6-1-sol'))) {
      unscored.push({ model, reason: 'identity-policy', tried: bases }); continue;
    }
    const override = overrides[model] ?? MODEL_AA_OVERRIDES[model];
    const target = typeof override === 'string' ? override : override?.slug;
    const identityOf = r => {
      const exactBase = bases.find(base => base === r.slug);
      if (exactBase) return { root: exactBase, effort: 'max' };
      for (const root of bases) {
        if (!r.slug.startsWith(`${root}-`)) continue;
        const effort = r.slug.slice(root.length + 1);
        if (EFFORT_ORDER.includes(effort)) return { root, effort };
      }
      return null;
    };
    const matches = r => (target ? r.slug === target : identityOf(r) != null);
    const matched = rows.filter(matches);
    if (matched.length === 0) {
      // The row exists but the feed stopped serving it: say so instead of
      // reporting a bare no-match, exactly like the classic resolver does.
      const retired = historical.some(matches);
      unscored.push({ model, reason: retired ? 'slug-prior-only' : 'no-aa-match', tried: target ? [target] : bases });
      continue;
    }
    const byEffort = new Map();
    for (const r of matched) {
      const identity = identityOf(r);
      const effort = target && typeof override === 'object' && override.effort ? override.effort
        : identity?.effort ?? parseEffortSuffix(r.slug);
      const root = identity?.root ?? r.slug.replace(/-(minimal|low|medium|high|xhigh|max|ultra)$/, '');
      const aaEffort = identity?.effort ?? parseEffortSuffix(r.slug);
      const matchType = bases.includes(root) && effort === aaEffort ? (root === model ? 'exact' : 'verified-alias') : 'borrowed';
      const knownBinding = armMap.some(b => b.aaSlug === r.slug && b.effort === effort
        && taskSlugBases(b.model).some(s => bases.includes(s)));
      const explicit = Object.hasOwn(effortSupport, model) && Array.isArray(effortSupport[model]) && effortSupport[model].includes(effort);
      const effortVerified = effortAllowed(family, effort) && (knownBinding || explicit);
      const candidate = { armId: taskArmId(model, effort), model, effort, family, providers: null, dynamic: !knownBinding,
        aaSlug: r.slug, aaEffort, row: r, matchType, effortVerified,
        matchReason: effort !== aaEffort ? 'aa-effort-mismatch' : matchType === 'borrowed' ? 'configured-benchmark-borrow' : null,
        evidenceReason: !effortAllowed(family, effort) ? 'effort-inexpressible' : effortVerified ? null : 'effort-unverified' };
      // A base and explicit -max row are ambiguous for the same arm. Do not
      // choose whichever happened to arrive first in the source array.
      if (byEffort.has(effort)) byEffort.set(effort, null);
      else byEffort.set(effort, candidate);
    }
    for (const [effort, a] of byEffort) {
      if (a) arms.push(a);
      else unscored.push({ model, effort, reason: 'effort-ambiguous', tried: matched.map(r => r.slug) });
    }
    const expectedEfforts = new Set([...(Object.hasOwn(effortSupport, model) ? effortSupport[model] : []),
      ...armMap.filter(b => taskSlugBases(b.model).some(base => bases.includes(base))).map(b => b.effort)]);
    for (const effort of expectedEfforts) if (!byEffort.has(effort)) unscored.push({ model, effort,
      reason: 'no-aa-effort-match', tried: bases.map(base => effort === 'max' ? base : `${base}-${effort}`) });
  }
  return { arms, unscored };
}
