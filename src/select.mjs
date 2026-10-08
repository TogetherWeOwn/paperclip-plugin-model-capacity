/**
 * Deficit-based account selection (pure; used by the shadow tick and the
 * memory-only resolve hook alike, so observation and enforcement agree).
 *
 * For each run, choose among accounts that HAVE 5h headroom (known and
 * above the reserve) and carry a model in the agent's role band -- the
 * role-band check happens in the caller's decide loop; this module orders.
 * The account with the largest burn DEFICIT serves first:
 *
 *   deficit = (requiredRate - measuredRate) / requiredRate
 *
 * (positive = behind schedule and hungry; negative = ahead). Unknown
 * measured rates score deficit 0: behind hungry accounts, ahead of
 * over-served ones. Earliest reset breaks ties; accountId breaks those.
 *
 * Over-burning accounts (measured above required x (1 + deadband)) sort
 * AFTER every calm account, so they get no new marginal runs unless no
 * other account qualifies. Accounts with UNKNOWN headroom (null 5h) never
 * qualify at all: without a 5h signal the hook cannot verify headroom, and
 * guessing would push runs onto a capped account.
 */

/** Normalized burn deficit; 0 when either rate is unknown or required <= 0. */
export function deficitOf(view) {
  const measured = view?.measuredRatePerHour;
  const required = view?.requiredRatePerHour;
  if (measured == null || required == null || !(required > 0)) return 0;
  return (required - measured) / required;
}

/** True when the account burns above required x (1 + deadband). Unknown rates never count. */
export function isOverBurning(view, rateDeadbandRel = 0.15) {
  const measured = view?.measuredRatePerHour;
  const required = view?.requiredRatePerHour;
  if (measured == null || required == null || !(required > 0)) return false;
  return measured > required * (1 + rateDeadbandRel);
}

/**
 * Order account views for one run.
 * views: [{ accountId, resetAtMs, headroomPct (0-1 or null),
 *   measuredRatePerHour (nullable), requiredRatePerHour (nullable) }]
 * Unknown-headroom accounts are dropped; over-burning ones sort last.
 */
export function orderAccountsForRun(views, { reservePct = 0.05, rateDeadbandRel = 0.15 } = {}) {
  const qualified = (views ?? []).filter(
    v => v != null && v.headroomPct != null && v.headroomPct > reservePct,
  );
  const calmFirst = (a, b) => Number(isOverBurning(a, rateDeadbandRel)) - Number(isOverBurning(b, rateDeadbandRel));
  return [...qualified].sort((a, b) =>
    calmFirst(a, b) ||
    (deficitOf(b) - deficitOf(a)) ||
    ((a.resetAtMs ?? Number.MAX_SAFE_INTEGER) - (b.resetAtMs ?? Number.MAX_SAFE_INTEGER)) ||
    (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0),
  );
}
