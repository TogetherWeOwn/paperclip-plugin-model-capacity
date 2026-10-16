/**
 * Generic per-account credit pools.
 *
 * A weekly-spent account is normally excluded until its window resets. Some
 * providers grant free credit pools on top of the metered allowance (Codex
 * `X-Codex-Credits-Has-Credits` + a positive `X-Codex-Credits-Balance`); the
 * owner approved spending the free grant, so such an account stays AVAILABLE
 * and is paced to drain its credit balance. Paid credit types stay excluded
 * unless the operator explicitly allows them.
 *
 * Nothing here is provider-specific: the feed reports credit entries, the
 * config flags which types are free (spendable) and which paid types are
 * additionally allowed. Unknown types are ignored, and a missing or
 * non-positive balance is unknown/empty -- never capacity.
 *
 * Feed contract (per account, optional):
 *   credits: [{ type: 'codex-credits', hasCredits: true, balance: 12.5,
 *               fraction: 0.4, resetsAt: '2026-10-22T01:44:14Z' }]
 * `fraction` (0..1 remaining, when the feed can normalize it) paces the
 * drain; without it the account is paced as a full window over the credit
 * (else weekly) horizon and the positive-balance guard cuts it off at zero.
 */

export const WEEKLY_EXHAUSTED_PCT = 0.01;

/** Plan headroom only blocks credits when its quota is allocatable. */
export function hasUsablePlanHeadroom(view, reservePct = 0.05) {
  return view?.guardActive !== true
    && (view?.reactive === true || (view?.remainingPct != null
      && view.remainingPct > WEEKLY_EXHAUSTED_PCT && view?.headroomPct != null && view.headroomPct > reservePct));
}

/** Keep credit concurrency eligible for roles without usable plan slots. */
export function gateCreditConcurrencyRoles(roleAccess, creditAccountIds, planSlotsByRole) {
  const gated = Object.fromEntries(Object.entries(roleAccess ?? {}).map(([accountId, entry]) => [
    accountId, Object.fromEntries(Object.entries(entry).map(([role, access]) => [role, { ...access }])),
  ]));
  for (const accountId of creditAccountIds ?? []) {
    for (const role of planSlotsByRole ?? []) {
      if (gated[accountId]?.[role]?.eligible === true) {
        gated[accountId][role] = { ...gated[accountId][role], eligible: false };
      }
    }
  }
  return gated;
}

export const DEFAULT_CREDITS = Object.freeze({
  /** Credit-backed capacity is used only after subscription headroom. */
  priority: 'fallback',
  /** Free-grant types, spendable without further opt-in. */
  freeTypes: ['codex-credits'],
  /** Paid types the operator additionally allows as capacity. */
  paidTypes: [],
});

const cleanTypes = value => Array.isArray(value)
  ? [...new Set(value
    .filter(t => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim().toLowerCase()))]
  : null;

/** String lists only; malformed config cannot invent capacity. */
export function normalizeCredits(raw) {
  return {
    priority: raw?.priority === 'normal' ? 'normal' : 'fallback',
    freeTypes: cleanTypes(raw?.freeTypes) ?? [...DEFAULT_CREDITS.freeTypes],
    paidTypes: cleanTypes(raw?.paidTypes) ?? [...DEFAULT_CREDITS.paidTypes],
  };
}

/**
 * The first spendable credit entry, or null. Spendable means: the type is
 * allowed (free, or paid with operator opt-in), the feed asserts hasCredits,
 * and the balance is a positive number. A null/unknown balance is NOT
 * capacity, even with the flag set.
 */
export function usableCredit(entries, cfg) {
  const c = normalizeCredits(cfg);
  const free = new Set(c.freeTypes);
  const allowed = new Set([...c.freeTypes, ...c.paidTypes]);
  for (const e of entries ?? []) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
    const type = e.type.trim().toLowerCase();
    if (!allowed.has(type)) continue;
    if (e.hasCredits !== true) continue;
    if (!(typeof e.balance === 'number' && Number.isFinite(e.balance) && e.balance > 0)) continue;
    return { entry: e, creditFree: free.has(type) };
  }
  return null;
}
