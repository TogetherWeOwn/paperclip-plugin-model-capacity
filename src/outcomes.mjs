/**
 * Run outcomes: did a finished run do its job, not only
 * finish? "Finished" read 98-100% for Muse and Claude alike while Muse runs
 * ended in 2-3 minutes with no tool calls and no source work.
 *
 * What the plugin can see with the capabilities it already holds
 * (`issues.read`): the issue's status when the run was first observed, the
 * issue after the run ended, and the work products the issue lists (each
 * carries `createdByRunId`). A run PROGRESSED when its issue moved to a
 * disposition (done / in_review / blocked / cancelled) or the run created a
 * work product (a PR, a document). A comment-only
 * disposition is invisible without `issue.comments.read`, which this plugin
 * does not hold, so such a run reads `noChange` -- the metric undercounts
 * absolute progress but compares families on equal terms. When the platform
 * itself flags the run as a successful run that still owes a handoff
 * (`successfulRunHandoff` naming this run), that is counted separately as
 * `handoffOwed`.
 *
 * Outcomes: 'progressed' | 'noChange' | 'unknown' (issue unreadable or no
 * baseline to compare). Pure functions; the tick owns the issue reads.
 */

/** How long after a run ends the tick still evaluates it (later reads see other actors' changes). */
export const OUTCOME_EVAL_WINDOW_MS = 30 * 60 * 1000;
/** Issue reads per tick per phase (baseline, evaluation). */
export const OUTCOME_READS_PER_TICK = 10;
/** Failed reads before a run is closed as unknown (counted per phase). */
export const OUTCOME_MAX_TRIES = 3;
/**
 * A baseline is only trusted when read soon after the run began: a late read
 * (worker restart, a long tick gap) may already include the run's own status
 * move, which would score a finished job as noChange.
 */
export const OUTCOME_BASELINE_MAX_AGE_MS = 3 * 60 * 1000;

const asString = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * A status move counts as progress only when it lands on a disposition. A
 * move INTO in_progress is checkout, which an agent does at the start of its
 * own run: counting it would score every run that merely claimed its issue.
 */
export const DISPOSITION_STATUSES = new Set(['done', 'in_review', 'blocked', 'cancelled']);

/** Snapshot of the issue fields the outcome needs; null when unreadable. */
export function issueSnapshot(issue) {
  if (issue == null || typeof issue !== 'object') return null;
  const handoff = issue.successfulRunHandoff;
  return {
    status: asString(issue.status),
    workProductRunIds: (Array.isArray(issue.workProducts) ? issue.workProducts : [])
      .map(w => asString(w?.createdByRunId)).filter(Boolean),
    handoffOwedRunId: handoff != null && (handoff.required === true || handoff.state === 'required')
      ? asString(handoff.sourceRunId)
      : null,
  };
}

/**
 * Classify one finished run. baselineStatus: the issue status recorded while
 * the run was in flight (null when never observed).
 * Returns { outcome, signals: { statusChanged, workProduct, handoffOwed } }.
 */
export function classifyOutcome({ runId, baselineStatus = null, after }) {
  if (after == null) return { outcome: 'unknown', signals: { statusChanged: false, workProduct: false, handoffOwed: false } };
  const workProduct = after.workProductRunIds.includes(runId);
  const statusChanged = baselineStatus != null && after.status != null
    && after.status !== baselineStatus && DISPOSITION_STATUSES.has(after.status);
  const handoffOwed = after.handoffOwedRunId === runId;
  const signals = { statusChanged, workProduct, handoffOwed };
  if (workProduct || statusChanged) return { outcome: 'progressed', signals };
  // No baseline and no work product: nothing to compare against.
  if (baselineStatus == null) return { outcome: 'unknown', signals };
  return { outcome: 'noChange', signals };
}

/**
 * Per-family outcome report over terminal ledger records inside the window.
 * family: the resolved actual model's family, else the decision's family.
 * finishRate counts finished vs failed (cancelled runs say nothing about the
 * model); progressRate is progressed over (progressed + noChange).
 * `inferFamily` and `canonicalModelName` are injected to keep this pure.
 */
export function familyOutcomes(records, { nowMs, windowMs = 24 * 3600 * 1000, familyOf }) {
  const out = new Map();
  for (const r of records ?? []) {
    if (r?.status !== 'finished' && r?.status !== 'failed' && r?.status !== 'cancelled') continue;
    if (r.terminalAt != null && nowMs - r.terminalAt > windowMs) continue;
    const fam = familyOf(r) ?? 'unknown';
    let e = out.get(fam);
    if (!e) {
      e = {
        runs: 0, finished: 0, failed: 0, cancelled: 0,
        progressed: 0, noChange: 0, unknown: 0, handoffOwed: 0,
        finishRate: null, progressRate: null,
      };
      out.set(fam, e);
    }
    e.runs += 1;
    if (r.status === 'finished') {
      e.finished += 1;
      if (r.progress === 'progressed') e.progressed += 1;
      else if (r.progress === 'noChange') e.noChange += 1;
      else e.unknown += 1;
      if (r.handoffOwed === true) e.handoffOwed += 1;
    } else if (r.status === 'failed') e.failed += 1;
    else e.cancelled += 1;
  }
  for (const e of out.values()) {
    const ended = e.finished + e.failed;
    e.finishRate = ended > 0 ? e.finished / ended : null;
    const judged = e.progressed + e.noChange;
    e.progressRate = judged > 0 ? e.progressed / judged : null;
  }
  return Object.fromEntries(out);
}
