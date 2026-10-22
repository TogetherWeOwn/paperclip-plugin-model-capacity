/**
 * Per-run decision function (pure and deterministic: same input always
 * yields the same output; no clock, no randomness, no network).
 *
 * Inputs are deterministic run signals only: the pacing pointer for the
 * account, the agent role band (floor/ceiling rungs), retry count on the
 * same card, failure class of the previous run, and context size. The
 * caller iterates accounts in reset order; a `defer` here means "this
 * account cannot serve the run", and only when NO account has headroom
 * does the run-level answer stay `defer`.
 */

import { canonicalModelName } from './arms.mjs';

export const MAX_CONTEXT_ENV_KEY = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';
export const AUTO_COMPACT_ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const MAX_OUTPUT_ENV_KEY = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS';

export const DEFAULT_ROLE_BANDS = Object.freeze({
  thinker: { floorRung: 2, ceilingRung: null },
  doer: { floorRung: 0, ceilingRung: null },
});

export const DEFAULT_CONTEXT_CAPS = Object.freeze({
  /**
   * GPT-6.1 Sol: no price cap, only the real server ceiling. OpenAI charges
   * no long-context fee on GPT-6.1 Sol when usage draws from a subscription
   * (2026-10-11; the 272k surcharge is API pay-as-you-go only), and our Sol
   * lanes are subscription. Measured 2026-10-22 through CLIProxy on a
   * subscription lane: 917,354 input tokens accepted, ~941k rejected with
   * context_too_large, so the input ceiling is ~922k (1.05M window minus
   * 128k max output). 890000 / 870000 sit 32k / 52k under it (the same
   * margins tiers.mjs applies), so a client compacts instead of failing on
   * tokenizer-estimate drift.
   */
  solMaxTokens: 890000,
  solAutoCompactTokens: 870000,
  /**
   * Luna, and every other capped-family id the Sol change does not cover
   * (Sol ids before 6.1), stays under the 272k price cliff. The legacy
   * solLunaMaxTokens / solLunaAutoCompactTokens config keys set these.
   */
  lunaMaxTokens: 260000,
  lunaAutoCompactTokens: 240000,
  /** Auto-compact watermark key (operator-overridable, null omits it). */
  autoCompactEnvKey: AUTO_COMPACT_ENV_KEY,
  /**
   * Tier-derived compact windows ride the chosen ARM (arm.cap, keyed by
   * model by the plugin from the live pricingTiers/modelStats feed), never
   * a family map: families group unrelated models, so a family-keyed window
   * leaks one model's cliff onto untiered siblings. The GPT-6.1 Sol window
   * above is a ceiling a tier cap can only lower; every other arm takes its
   * tier cap when it has one, else (sol/luna) the Luna caps.
   */
  /** Haiku hit the 32k output cap live; raise it to 64k on haiku arms. */
  haikuMaxOutputTokens: 64000,
  /**
   * Tier multipliers apply to quota burn and pressure accounting, not only
   * ladder order. Measured on subscription lanes, quota charges Haiku over
   * 100k at ~3-5x base, so the default is true. False restores the old
   * base-cost burn (rollback).
   */
  tierAffectsQuota: true,
});

/**
 * Resolve config `contextCaps` over the defaults. Backward compatible: the
 * pre-0.2.65 keys solLunaMaxTokens / solLunaAutoCompactTokens set the Luna
 * caps (explicit lunaMaxTokens / lunaAutoCompactTokens win) and never the
 * Sol window -- a config written for the 272k cliff must not pin GPT-6.1 Sol
 * there, nor raise it. The legacy keys do not survive into the resolved
 * shape. tierAffectsQuota: explicit false restores base-cost burn
 * (rollback); anything else keeps the tier-adjusted default.
 */
export function normalizeContextCaps(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const { solLunaMaxTokens, solLunaAutoCompactTokens, ...rest } = r;
  return {
    ...DEFAULT_CONTEXT_CAPS,
    ...rest,
    solMaxTokens: r.solMaxTokens ?? DEFAULT_CONTEXT_CAPS.solMaxTokens,
    solAutoCompactTokens: r.solAutoCompactTokens ?? DEFAULT_CONTEXT_CAPS.solAutoCompactTokens,
    lunaMaxTokens: r.lunaMaxTokens ?? solLunaMaxTokens ?? DEFAULT_CONTEXT_CAPS.lunaMaxTokens,
    lunaAutoCompactTokens: r.lunaAutoCompactTokens ?? solLunaAutoCompactTokens ?? DEFAULT_CONTEXT_CAPS.lunaAutoCompactTokens,
    tierAffectsQuota: r.tierAffectsQuota !== false,
  };
}

/**
 * Families that never run without a context cap: a run on one of these
 * always carries a window (the Sol window or the Luna cliff caps, see
 * contextCapsEnv), and the hook's keep paths turn a keep on one of these
 * models into a decide on the same model carrying the caps.
 */
export const CAPPED_CONTEXT_FAMILIES = Object.freeze(['sol', 'luna']);

/**
 * Model ids the Sol window (solMaxTokens) covers: GPT-6.1 Sol only, in any
 * spelling the lanes serve (`gpt-6.1-sol`, Devin's `gpt-6-1-sol`, provider
 * prefixes, `(effort)` / `[1m]` decorations). OpenAI's no-long-context-fee
 * statement names GPT-6.1 Sol alone, so older Sol-family ids (`gpt-6-sol`, `gpt-5.6-sol`,
 * legacy `model_*gpt*`) keep the 272k-cliff (Luna) caps.
 */
const SOL_WINDOW_MODEL = /^gpt-6[.-]1-sol(?:$|-)/;

/** True when `model` is a GPT-6.1 Sol id (the Sol window applies). */
export function isSolWindowModel(model) {
  const canon = canonicalModelName(model);
  return canon != null && SOL_WINDOW_MODEL.test(canon.toLowerCase());
}

/** True when a run on this family/model must never go out without caps. */
export function needsContextCap(family, model) {
  return CAPPED_CONTEXT_FAMILIES.includes(family) || isSolWindowModel(model);
}

const positiveInt = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

/**
 * Configured { maxTokens, autoCompactTokens } under a key pair; a missing or
 * non-positive value falls back to the default, so a broken config can never
 * emit an uncapped run.
 */
function configuredWindow(caps, maxKey, compactKey) {
  return {
    maxTokens: positiveInt(caps?.[maxKey]) ?? DEFAULT_CONTEXT_CAPS[maxKey],
    autoCompactTokens: positiveInt(caps?.[compactKey]) ?? DEFAULT_CONTEXT_CAPS[compactKey],
  };
}

/**
 * Context/output caps env for the arm a run executes on. The ONE builder for
 * every path that answers the host with an env (decide() -- and with it
 * burn-mode, trial and paced picks -- routed reviews, kept/pinned agents and
 * the stale-snapshot keep), so the paths cannot drift apart again.
 *
 * arm: { cap, family, model }. cap is the arm's tier-derived compact window
 *   ({ maxTokens, autoCompactTokens }, set per model by the plugin from the
 *   live price-tier feed via tiers.mjs).
 *   - GPT-6.1 Sol (isSolWindowModel): the configured Sol window
 *     (solMaxTokens / solAutoCompactTokens) is a CEILING -- a tier cap may
 *     lower it, never raise it, so no path runs Sol past solMaxTokens.
 *     (The feed's gpt-6-1-sol ~922k window tier derives exactly the
 *     default 890000 / 870000; a wider tier still lands on the ceiling.)
 *   - Any other arm with a tier cap: the tier cap (the feed is fresher than
 *     the static default), exactly as 0.2.61.
 *   - Other sol/luna ids without a tier cap: the Luna (272k-cliff) caps.
 * contextCaps: the resolved config caps; null/undefined use the defaults so a
 *   missing config can never emit an uncapped Sol run.
 * The auto-compact watermark never sits above the max window.
 */
export function contextCapsEnv(arm, contextCaps = DEFAULT_CONTEXT_CAPS) {
  const caps = contextCaps ?? DEFAULT_CONTEXT_CAPS;
  const env = {};
  const family = arm?.family;
  const tierMax = positiveInt(arm?.cap?.maxTokens);
  const tier = tierMax != null ? { maxTokens: tierMax, autoCompactTokens: positiveInt(arm.cap.autoCompactTokens) } : null;
  let window = null;
  if (isSolWindowModel(arm?.model)) {
    const sol = configuredWindow(caps, 'solMaxTokens', 'solAutoCompactTokens');
    window = {
      maxTokens: Math.min(sol.maxTokens, tier?.maxTokens ?? Infinity),
      autoCompactTokens: Math.min(sol.autoCompactTokens, tier?.autoCompactTokens ?? Infinity),
    };
  } else if (tier) {
    window = tier;
  } else if (CAPPED_CONTEXT_FAMILIES.includes(family)) {
    window = configuredWindow(caps, 'lunaMaxTokens', 'lunaAutoCompactTokens');
  }
  if (window) {
    env[MAX_CONTEXT_ENV_KEY] = String(window.maxTokens);
    if (caps.autoCompactEnvKey && window.autoCompactTokens != null) {
      env[caps.autoCompactEnvKey] = String(Math.min(window.autoCompactTokens, window.maxTokens));
    }
  }
  if (family === 'haiku') {
    env[MAX_OUTPUT_ENV_KEY] = String(caps.haikuMaxOutputTokens);
  }
  return env;
}

/**
 * Trial defaults: families without fleet success history route as trials
 * (doer role only, adapter-gated, in-flight-capped) until measured fleet
 * success graduates them. Unlisted adapters get NO trial arms at all --
 * trials are opt-in per adapter type; claude adapters may use any family.
 */
export const DEFAULT_TRIALS = Object.freeze({
  maxInFlightPerAccount: 2,
  maxInFlightPerFamily: 2,
  minRuns: 10,
  minSuccessRate: 0.8,
  adapters: Object.freeze({
    claude_local: ['*'],
    'claude-code': ['*'],
  }),
  // Roles that may take trial arms. 'other' exists only when
  // roles.doerAgentIds is set (absent that config every non-thinker is a
  // doer, so the default is bit-identical to the old doer-only gate).
  // Thinkers stay excluded by default: trial traffic is unmeasured by
  // definition and never belongs on the thinker blend.
  roles: Object.freeze(['doer', 'other']),
});

/** True when the adapter type may run trial arms of the family. */
export function adapterAllowsTrial(trialAdapters, adapterType, family) {
  if (adapterType == null) return false;
  const allow = trialAdapters?.[adapterType];
  if (allow == null) return false;
  if (allow === '*') return true;
  if (!Array.isArray(allow)) return false;
  return allow.includes('*') || allow.includes(family);
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Exclusion tokens. An exclusion list holds family names (`muse`) and
 * single-arm tokens (`arm:<armId>`): the quality gate removes individual
 * arms (one family spans arms of very different Q), the outcome gate and
 * the emergency override remove whole families. One list, one matcher, so
 * every path that already honors family exclusions honors arm exclusions.
 */
export const ARM_TOKEN_PREFIX = 'arm:';
export const armToken = (armId) => `${ARM_TOKEN_PREFIX}${String(armId ?? '').toLowerCase()}`;

/** True when the arm's family or the arm itself is in the (normalized) exclusion set. */
function armExcluded(arm, excludedSet) {
  if (excludedSet.size === 0) return false;
  return excludedSet.has(String(arm?.family ?? '').toLowerCase()) || excludedSet.has(armToken(arm?.armId));
}

/** Normalize a family-exclusion list: lowercase strings, deduped. */
export function normalizeExcludedFamilies(list) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    if (typeof f !== 'string') continue;
    const t = f.toLowerCase();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Drop excluded families from grouped rungs, keeping rung shells (decide
 * indexes rungs by number with topRung = length - 1, so groups stay).
 * Empty exclusions return the input untouched.
 */
export function filterRungsByExcludedFamilies(ladderRungs, excludedFamilies) {
  const excluded = new Set(normalizeExcludedFamilies(excludedFamilies));
  if (excluded.size === 0) return ladderRungs;
  return (ladderRungs ?? []).map(g => ({
    ...g,
    arms: (g?.arms ?? []).filter(a => !armExcluded(a, excluded)),
  }));
}

/** True when at least one arm survives in any rung group. */
export function rungsHaveEligibleArms(ladderRungs) {
  return (ladderRungs ?? []).some(g => (g?.arms ?? []).length > 0);
}

/**
 * The rung window a role can reach on a ladder of `groupCount` rung groups:
 * the same floor/ceiling math decide() runs, so eligibility checks and the
 * decision agree on which rungs exist for the role.
 */
export function roleRungWindow(band, groupCount) {
  const topRung = Math.max(0, (groupCount ?? 1) - 1);
  const floor = clamp(band?.floorRung ?? 0, 0, topRung);
  const ceiling = band?.ceilingRung == null ? topRung : clamp(band.ceilingRung, floor, topRung);
  return { topRung, floor, ceiling };
}

/**
 * Can this role be placed on this ladder at all? Mirrors decide()'s
 * reachability (family exclusions, the role's floor..ceiling rung window,
 * trial-role gating) without the per-run inputs (headroom, burn, adapter,
 * trial budget): the question is "does the account have an arm this role
 * can ever take", not "does it have one right now".
 *
 * Returns { eligible, trialOnly }: trialOnly means every reachable arm is a
 * trial arm, whose traffic is capped in flight, so the account cannot
 * sustain its quota-derived slot count for this role.
 */
export function roleLadderAccess(ladderRungs, {
  role = 'doer',
  roleBands = DEFAULT_ROLE_BANDS,
  excludedFamilies = [],
  trialRoles = DEFAULT_TRIALS.roles,
} = {}) {
  const groups = ladderRungs ?? [];
  const { floor, ceiling } = roleRungWindow(roleBands[role] ?? roleBands.doer, groups.length);
  const excluded = new Set(normalizeExcludedFamilies(excludedFamilies));
  const reachable = [];
  for (const g of groups) {
    if (!(g?.rung >= floor && g?.rung <= ceiling)) continue;
    for (const a of g?.arms ?? []) {
      if (!armExcluded(a, excluded)) reachable.push(a);
    }
  }
  if (reachable.length === 0) return { eligible: false, trialOnly: false };
  if (reachable.some(a => a?.trial !== true)) return { eligible: true, trialOnly: false };
  const trialOk = (Array.isArray(trialRoles) ? trialRoles : []).includes(role);
  return trialOk ? { eligible: true, trialOnly: true } : { eligible: false, trialOnly: false };
}

/**
 * The arm decide() would pick on this ladder for a role, ignoring the
 * per-run gates (headroom, burn, adapter, trial budget): walk from the
 * pointer down to the role floor, then up to the ceiling, take the first rung with a reachable arm,
 * rank by the role's account-relative Q exactly as decide() does. Returns
 * that arm's FLEET-comparable quality (qFleet / qFleetThinker, ride the
 * rungs) so placement can compare arms across accounts, or null when no arm
 * is reachable or the arm carries no fleet score.
 */
export function placementArm(ladderRungs, {
  role = 'doer',
  roleBands = DEFAULT_ROLE_BANDS,
  excludedFamilies = [],
  trialRoles = DEFAULT_TRIALS.roles,
  pointer = null,
} = {}) {
  const groups = ladderRungs ?? [];
  const { floor, ceiling } = roleRungWindow(roleBands[role] ?? roleBands.doer, groups.length);
  const excluded = new Set(normalizeExcludedFamilies(excludedFamilies));
  const trialOk = (Array.isArray(trialRoles) ? trialRoles : []).includes(role);
  const rankQ = (a) => role === 'thinker' ? (a.qThinker ?? a.Q) : a.Q;
  // Same walk as decide(): pointer down to the floor, then up to the ceiling.
  const target = clamp(pointer ?? floor, floor, ceiling);
  const order = [];
  for (let rung = target; rung >= floor; rung--) order.push(rung);
  for (let rung = target + 1; rung <= ceiling; rung++) order.push(rung);
  for (const rung of order) {
    const entry = groups.find(g => g.rung === rung);
    const arms = (entry?.arms ?? []).filter(a =>
      !armExcluded(a, excluded) && (a?.trial !== true || trialOk));
    if (arms.length === 0) continue;
    arms.sort((a, b) => (rankQ(b) - rankQ(a)) || (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0));
    const arm = arms[0];
    const q = role === 'thinker' ? (arm.qFleetThinker ?? arm.qFleet) : arm.qFleet;
    return { armId: arm.armId, family: arm.family ?? null, rung, quality: Number.isFinite(q) ? q : null };
  }
  return null;
}

function sanitizeId(part) {
  return String(part).replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 80) || 'x';
}

/**
 * Decide one run on one account.
 *
 * ladderRungs: [{ rung, arms: [{ armId, model, effort, family,
 *   contextWindow, Q, C, trial, cap, qThinker }] }] (already provider-filtered).
 *   cap is the arm's tier-derived compact window ({ maxTokens,
 *   autoCompactTokens }) or null; it may lower the GPT-6.1 Sol window and
 *   otherwise wins over the Luna caps (see contextCapsEnv).
 *   qThinker is the thinker-alpha EEE blend (null when AA-only); thinkers
 *   sort on it, other roles on Q.
 * excludedFamilies: families skipped for this run's role (role-based
 *   exclusion from config). Empty by default: identical decisions.
 * burnPerRunPct: armId -> expected weekly % consumed by one run (E_a[m]);
 *   missing entries mean uncalibrated: the arm is skipped when headroom is
 *   known, allowed (flagged weak) when headroom is unknown.
 * Trial arms (trial: true) are exploration traffic: only roles listed in
 * trialRoles (default doer + other; thinkers never), the adapter must
 * allow the family, and the family needs a free in-flight slot in
 * trialBudget. Trial picks bypass the burn check (their burn is
 * unmeasured by definition; the in-flight cap bounds the blast radius)
 * and always report weak calibration.
 */
export function decide({
  runId,
  agentId,
  role = 'doer',
  ladderRungs,
  pointer,
  retryCount = 0,
  failureClass = 'none',
  contextTokens = null,
  fiveHourHeadroomPct = null,
  burnPerRunPct = {},
  reservePct = 0,
  accountId,
  roleBands = DEFAULT_ROLE_BANDS,
  contextCaps = DEFAULT_CONTEXT_CAPS,
  adapterType = null,
  trialBudget = null,
  trialAdapters = null,
  trialRoles = DEFAULT_TRIALS.roles,
  excludedFamilies = [],
} = {}) {
  if (failureClass === 'rate-limit') {
    return { kind: 'defer', retryAfterMs: 20000, reason: 'previous run rate-limited: reroute to next account' };
  }
  const band = roleBands[role] ?? roleBands.doer;
  const { floor, ceiling } = roleRungWindow(band, ladderRungs?.length);
  // An unservable failure (400 unknown provider / unrecognized model: the
  // emitted id names no route on this account) must never escalate onto the
  // next rung of the SAME account -- the arm is broken, not too weak. The
  // arm breaker excludes it and routing moves to the next account instead.
  const escalation = failureClass === 'unservable'
    ? 0
    : Math.max(0, retryCount) + (failureClass === 'test-fail' ? 1 : 0);
  const target = clamp((pointer ?? floor) + escalation, floor, ceiling);
  const excludedFamilySet = new Set(normalizeExcludedFamilies(excludedFamilies));
  const requiredWindow = contextTokens != null ? contextTokens * 2 : 0;

  const trialOk = (arm) => {
    if (!arm.trial) return true;
    if (!(Array.isArray(trialRoles) ? trialRoles : []).includes(role)) return false;
    if (!adapterAllowsTrial(trialAdapters, adapterType, arm.family)) return false;
    return (trialBudget?.[arm.family] ?? 0) > 0;
  };
  // Pacing picks the target rung and walks DOWN to the role floor. When no
  // arm fits anywhere at or below it (every lower arm excluded for the role,
  // or over the 5h burn check) walk UP to the ceiling before giving up: the
  // pointer is a pacing preference, and an empty low rung must not strand
  // the role on an account that serves it higher up (a thinker on a Codex
  // lane whose low rungs are all luna, an account whose floor arm was
  // excluded). Upward picks still pass every exclusion and burn check.
  const order = [];
  for (let rung = target; rung >= floor; rung--) order.push(rung);
  for (let rung = target + 1; rung <= ceiling; rung++) order.push(rung);
  for (const rung of order) {
    const entry = ladderRungs.find(r => r.rung === rung);
    const arms = (entry?.arms ?? []).filter(a => (a.contextWindow ?? Number.MAX_SAFE_INTEGER) >= requiredWindow);
    const fitting = arms.filter(a => {
      if (armExcluded(a, excludedFamilySet)) return false;
      if (!trialOk(a)) return false;
      // Trial picks bypass the burn check: unmeasured by definition.
      if (a.trial) return true;
      const burn = burnPerRunPct[a.armId];
      if (fiveHourHeadroomPct == null) return true;
      if (burn == null) return false;
      return burn <= fiveHourHeadroomPct - reservePct;
    });
    if (fitting.length === 0) continue;
    // Thinkers rank on their own EEE blend (qThinker, alpha 0.10); every
    // other role ranks on the ladder Q (doer blend). Arms without a thinker
    // blend (AA-only, or ladders built before it existed) fall back to Q.
    const rankQ = (a) => role === 'thinker' ? (a.qThinker ?? a.Q) : a.Q;
    fitting.sort((a, b) => (rankQ(b) - rankQ(a)) || (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0));
    const arm = fitting[0];
    // Sol window (a tier cap may only lower it), else the tier cap, else the
    // Luna caps for sol/luna, plus the haiku output cap: the shared builder
    // every env-carrying path uses.
    const env = contextCapsEnv(arm, contextCaps);
    const weak = arm.trial === true || fiveHourHeadroomPct == null || burnPerRunPct[arm.armId] == null;
    return {
      kind: 'decide',
      decisionId: `mc-${sanitizeId(runId)}-${sanitizeId(accountId)}-r${rung}-${sanitizeId(arm.model)}`,
      armId: arm.armId,
      model: arm.model,
      effort: arm.effort,
      trial: arm.trial === true,
      // AA context window of the chosen arm (null when unknown): the plugin
      // renders `<model>(<effort>)[1m]` for 1M claude runs off this.
      contextWindow: arm.contextWindow ?? null,
      env,
      source: 'model-capacity',
      calibration: weak ? 'weak' : 'ok',
      reason: `rung ${rung} on ${accountId} (${role}${escalation ? `, +${escalation} retry escalation` : ''})`,
      rung,
      accountId,
      agentId,
    };
  }
  return { kind: 'defer', retryAfterMs: 20000, reason: `no arm on ${accountId} fits headroom/context at floor ${floor}` };
}
