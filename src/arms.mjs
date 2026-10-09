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

/** Families with a ceiling below max (Muse contributor rows top out at xhigh). */
export const MAX_EFFORT_BY_FAMILY = Object.freeze({ muse: 'xhigh' });

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

/** Strip a `provider/` alias prefix to the canonical bare model id. */
export function canonicalModelName(model) {
  if (typeof model !== 'string') return null;
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return bare.length > 0 ? bare : null;
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
export function buildDynamicBindings(servedModels, { coveredModels = [], overrides = {} } = {}) {
  const covered = new Set(coveredModels);
  const seen = new Set();
  const bindings = [];
  const unscored = [];
  for (const raw of servedModels ?? []) {
    const model = canonicalModelName(raw);
    if (!model || seen.has(model)) continue;
    seen.add(model);
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
export function resolveDynamicArms(aaRows, bindings) {
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
      unscored.push({ model: b.model, reason: 'no-aa-match', tried });
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
export function resolveArms(aaRows, armMap = DEFAULT_ARM_MAP) {
  const bySlug = new Map();
  const counts = new Map();
  for (const row of aaRows ?? []) {
    counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1);
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
  }
  const arms = [];
  const skipped = [];
  for (const binding of armMap) {
    if ((counts.get(binding.aaSlug) ?? 0) > 1) {
      skipped.push({ aaSlug: binding.aaSlug, reason: 'slug-ambiguous' });
      continue;
    }
    const row = bySlug.get(binding.aaSlug);
    if (!row) {
      skipped.push({ aaSlug: binding.aaSlug, reason: 'slug-absent-from-snapshot' });
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
