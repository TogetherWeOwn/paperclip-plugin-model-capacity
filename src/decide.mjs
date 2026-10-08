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

export const MAX_CONTEXT_ENV_KEY = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';
export const AUTO_COMPACT_ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

export const DEFAULT_ROLE_BANDS = Object.freeze({
  thinker: { floorRung: 2, ceilingRung: null },
  doer: { floorRung: 0, ceilingRung: null },
});

export const DEFAULT_CONTEXT_CAPS = Object.freeze({
  /** Sol/Luna stay under the 272k price cliff. */
  solLunaMaxTokens: 260000,
  solLunaAutoCompactTokens: 240000,
  /** Auto-compact watermark key (operator-overridable, null omits it). */
  autoCompactEnvKey: AUTO_COMPACT_ENV_KEY,
});

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function sanitizeId(part) {
  return String(part).replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 80) || 'x';
}

/**
 * Decide one run on one account.
 *
 * ladderRungs: [{ rung, arms: [{ armId, model, effort, family,
 *   contextWindow, Q, C }] }] (already provider-filtered).
 * burnPerRunPct: armId -> expected weekly % consumed by one run (E_a[m]);
 *   missing entries mean uncalibrated: the arm is skipped when headroom is
 *   known, allowed (flagged weak) when headroom is unknown.
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
} = {}) {
  if (failureClass === 'rate-limit') {
    return { kind: 'defer', retryAfterMs: 20000, reason: 'previous run rate-limited: reroute to next account' };
  }
  const band = roleBands[role] ?? roleBands.doer;
  const topRung = Math.max(0, (ladderRungs?.length ?? 1) - 1);
  const floor = clamp(band.floorRung ?? 0, 0, topRung);
  const ceiling = band.ceilingRung == null ? topRung : clamp(band.ceilingRung, floor, topRung);
  const escalation = Math.max(0, retryCount) + (failureClass === 'test-fail' ? 1 : 0);
  const target = clamp((pointer ?? floor) + escalation, floor, ceiling);
  const requiredWindow = contextTokens != null ? contextTokens * 2 : 0;

  for (let rung = target; rung >= floor; rung--) {
    const entry = ladderRungs.find(r => r.rung === rung);
    const arms = (entry?.arms ?? []).filter(a => (a.contextWindow ?? Number.MAX_SAFE_INTEGER) >= requiredWindow);
    const fitting = arms.filter(a => {
      const burn = burnPerRunPct[a.armId];
      if (fiveHourHeadroomPct == null) return true;
      if (burn == null) return false;
      return burn <= fiveHourHeadroomPct - reservePct;
    });
    if (fitting.length === 0) continue;
    fitting.sort((a, b) => (b.Q - a.Q) || (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0));
    const arm = fitting[0];
    const env = {};
    if (arm.family === 'sol' || arm.family === 'luna') {
      env[MAX_CONTEXT_ENV_KEY] = String(contextCaps.solLunaMaxTokens);
      if (contextCaps.autoCompactEnvKey) env[contextCaps.autoCompactEnvKey] = String(contextCaps.solLunaAutoCompactTokens);
    }
    const weak = fiveHourHeadroomPct == null || burnPerRunPct[arm.armId] == null;
    return {
      kind: 'decide',
      decisionId: `mc-${sanitizeId(runId)}-${sanitizeId(accountId)}-r${rung}-${sanitizeId(arm.model)}`,
      model: arm.model,
      effort: arm.effort,
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
