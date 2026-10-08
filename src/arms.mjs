/**
 * Arm mapping: AA slugs -> CLIProxy model ids plus effort suffix.
 *
 * Each arm is one model x effort row, e.g. AA slug `claude-haiku-5-5`
 * (base slug = max effort) serves CLIProxy model `claude-haiku-5-5` at
 * effort `max`, and `gpt-6-1-sol-high` serves `gpt-6.1-sol` at `high`.
 *
 * Ladders are PER ACCOUNT: an arm is only eligible on accounts whose
 * provider serves its family (see PROVIDER_FAMILIES). A Codex-family arm
 * never appears on a Claude account's ladder.
 */

export const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Families with a ceiling below max (Muse contributor rows top out at xhigh). */
export const MAX_EFFORT_BY_FAMILY = Object.freeze({ muse: 'xhigh' });

/** Which model families each CLIProxy account provider can serve. */
export const PROVIDER_FAMILIES = Object.freeze({
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['sol', 'luna', 'astra'],
  meta: ['muse'],
});

/** Inverse of PROVIDER_FAMILIES: family -> provider (first claimant wins). */
export const PROVIDER_FOR_FAMILY = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_FAMILIES).flatMap(([provider, families]) => families.map(f => [f, provider])),
  ),
);

/**
 * Guess an arm family from a run's model string (heartbeat usage_json or
 * shadow `model(effort)` labels). Substring match, most-specific first;
 * null when nothing matches. Used only to map runs to accounts when the
 * run carries no provider.
 */
const FAMILY_HINTS = Object.freeze(['opus', 'sonnet', 'haiku', 'astra', 'luna', 'sol', 'muse', 'grok']);

export function familyOfModelName(model) {
  if (typeof model !== 'string') return null;
  const lower = model.toLowerCase();
  for (const hint of FAMILY_HINTS) {
    if (lower.includes(hint)) return hint;
  }
  return null;
}

/** Provider serving a run model string, via family hints; null if unknown. */
export function providerForModelName(model) {
  const family = familyOfModelName(model);
  return family ? (PROVIDER_FOR_FAMILY[family] ?? null) : null;
}

/**
 * Default arm table. Operator-overridable via config `armMap`; entries here
 * cover the current fleet: Claude Opus/Sonnet/Haiku 5.5, Sol/Luna/Astra,
 * and the Muse contributor row (xhigh only: Contributor has no max, so the
 * base `muse-spark-1-3` slug is skipped by the family effort cap).
 * Slugs verified against the live AA leaderboard 2026-10-08. zai/xai and
 * opencode families are unmapped: AA carries candidate slugs (grok-*, kimi,
 * qwen, deepseek, glm, minimax) but the CLIProxy model ids for those
 * accounts are unconfirmed -- see README open questions.
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

/** True when the account provider can serve the arm's family. */
export function providerServes(provider, family) {
  return (PROVIDER_FAMILIES[provider] ?? []).includes(family);
}

/**
 * Join the arm table to AA snapshot rows. Returns matched arms plus a
 * skip list (ambiguous slug, absent slug, inexpressible effort) so the
 * shadow log can say why an arm is missing instead of silently dropping it.
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

/** Arms of one account's ladder: family served by the provider, stable order. */
export function armsForProvider(arms, provider) {
  return arms
    .filter(arm => providerServes(provider, arm.family) && (arm.providers ?? []).includes(provider))
    .sort((a, b) => (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0));
}
