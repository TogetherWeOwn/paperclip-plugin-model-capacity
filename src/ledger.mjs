/**
 * Run ledger: the SINGLE source of truth for run accounting.
 *
 * One record per runId. Every path (tick, resolve hook, event-time shadow)
 * reads and writes only through these functions, so a run is counted at
 * most once no matter how events interleave (started-before-hook,
 * hook-before-started, cancel, worker restart).
 *
 * Record:
 *   { runId, agentId, issueId, adapterType,
 *     decidedAccount (hook/shadow decision, null until decided),
 *     decidedAt, enforced, wouldModel, rung, trial, family, reason, eventTime,
 *     eventModel/eventModelSource (what a run event carried),
 *     actualModel/actualModelSource/actualModelError/actualPending/modelMatch,
 *     actualAccount (resolved from a model, never a guess that overrides a
 *       decision),
 *     startedAt, terminalAt, status, unverified }
 *
 * Attribution: decidedAccount if present, else actualAccount, else
 * unattributed. A decision always outranks the agent-config/issue model
 * guess, so a decided run never counts under its agent's usual account.
 *
 * In-flight: status non-terminal, not unverified, anchored at
 * startedAt ?? decidedAt, younger than the horizon. Restart reconciliation
 * only marks unverifiable records `unverified` (excluded from counting);
 * it NEVER deletes -- the shadow log is built from the same records and
 * survives restarts. Trimming (for the persist bound) drops old terminal,
 * old unverified, and stale-horizon records first, then oldest activity
 * past the cap -- live in-flight records are always newest and survive.
 */

export const LEDGER_TERMINAL_STATUSES = new Set(['finished', 'failed', 'cancelled']);
export const isLedgerTerminal = (s) => LEDGER_TERMINAL_STATUSES.has(s);

/** Trial in-flight window: trial entries count while fresh (fixed 2h). */
export const TRIAL_WINDOW_MS = 2 * 3600 * 1000;
/** Ledger persist cap; trim drops oldest terminal records first. */
export const LEDGER_CAP = 1000;
/** Terminal records older than this may be trimmed (shadow history TTL). */
export const LEDGER_TERMINAL_TTL_MS = 24 * 3600 * 1000;

export function createLedger() {
  return new Map();
}

function isRecord(v) {
  return v != null && typeof v === 'object' && typeof v.runId === 'string';
}

export function ledgerFromJSON(arr) {
  const m = new Map();
  for (const r of arr ?? []) {
    if (isRecord(r)) m.set(r.runId, { ...r });
  }
  return m;
}

export function ledgerToJSON(ledger) {
  return [...(ledger ?? new Map()).values()].map(r => ({ ...r }));
}

function ensure(ledger, runId) {
  let r = ledger.get(runId);
  if (!r) {
    r = { runId, unverified: false, enforced: false, trial: false };
    ledger.set(runId, r);
  }
  return r;
}

const fill = (r, k, v) => {
  if (r[k] == null && v != null) r[k] = v;
};

/**
 * A run started (agent.run.started). Terminal records ignore late starts;
 * a start is proof of life and clears `unverified`.
 */
export function recordStart(ledger, event, atMs) {
  const runId = String(event?.runId ?? 'unknown');
  const r = ensure(ledger, runId);
  if (isLedgerTerminal(r.status)) return r;
  r.status = 'running';
  if (r.startedAt == null) r.startedAt = atMs;
  fill(r, 'agentId', event?.agentId);
  fill(r, 'issueId', event?.issueId);
  fill(r, 'adapterType', event?.adapterType);
  if (r.provider == null && event?.provider != null) r.provider = String(event.provider).toLowerCase();
  if (event?.model != null) {
    fill(r, 'eventModel', event.model);
    fill(r, 'eventModelSource', event?.modelSource ?? 'run-event');
  }
  r.unverified = false;
  return r;
}

/**
 * A hook or shadow decision for a run. First decision wins, except an
 * enforced (hook) decision overwrites a non-enforced (event-time) one for
 * the same runId. Decisions on terminal runs are ignored.
 */
export function recordDecision(ledger, decision, atMs) {
  const runId = String(decision?.runId ?? 'unknown');
  const r = ensure(ledger, runId);
  if (isLedgerTerminal(r.status)) return r;
  const enforced = decision?.enforced === true;
  if (r.decidedAccount != null && (r.enforced || !enforced)) return r;
  r.decidedAccount = decision?.accountId ?? null;
  r.decidedAt = atMs;
  r.enforced = enforced;
  if (decision?.armId != null) r.armId = String(decision.armId);
  if (decision?.wouldModel != null) r.wouldModel = decision.wouldModel;
  if (decision?.rung != null) r.rung = decision.rung;
  if (decision?.trial === true) r.trial = true;
  if (decision?.family != null) r.family = decision.family;
  if (decision?.reason != null) r.reason = decision.reason;
  if (decision?.eventTime === true) r.eventTime = true;
  fill(r, 'agentId', decision?.agentId);
  if (r.actualModel == null || r.actualModel === 'unknown') r.actualPending = true;
  return r;
}

/**
 * A run reached a terminal status. Terminal wins over everything; a
 * run-decision model (what the run actually used) overwrites earlier
 * guesses such as the agent-config backfill. resolvedAccount is applied
 * under the same rule (authoritative source overwrites a guess).
 */
export function recordTerminal(ledger, event, status, atMs) {
  const runId = String(event?.runId ?? 'unknown');
  const r = ensure(ledger, runId);
  if (isLedgerTerminal(r.status)) {
    if (event?.modelSource === 'run-decision' && event?.model != null) {
      r.actualModel = event.model;
      r.actualModelSource = 'run-decision';
      if (event?.resolvedAccount != null) r.actualAccount = event.resolvedAccount;
    }
    return r;
  }
  r.status = status;
  if (r.terminalAt == null) r.terminalAt = atMs;
  fill(r, 'agentId', event?.agentId);
  // Provider-side failure text, failed runs only (feeds the arm circuit
  // breaker; bounded so one verbose error cannot bloat the ledger blob).
  if (status === 'failed' && event?.errorText != null) {
    r.errorText = String(event.errorText).slice(0, 500);
  }
  if (r.provider == null && event?.provider != null) r.provider = String(event.provider).toLowerCase();
  const authoritative = event?.modelSource === 'run-decision' && event?.model != null;
  if (authoritative) {
    r.actualModel = event.model;
    r.actualModelSource = 'run-decision';
    if (event?.resolvedAccount != null) r.actualAccount = event.resolvedAccount;
  } else {
    fill(r, 'actualModel', event?.model);
    if (event?.model != null) fill(r, 'actualModelSource', event?.modelSource ?? 'run-event');
    if (event?.resolvedAccount != null && r.actualAccount == null) r.actualAccount = event.resolvedAccount;
  }
  return r;
}

/** Attribution: the decision outranks any model-guess mapping. */
export function attributedAccount(r) {
  return r?.decidedAccount ?? r?.actualAccount ?? null;
}

/**
 * E-calibration mapping: what account a run's burn calibrates. The actual
 * (model-mapped) account first, provider fallback when the run named only
 * a provider -- a non-enforced shadow/event-time pick is a guess about
 * where the run SHOULD go, not where it burned, so it must not divert
 * calibration. Only an enforced (hook) decision outranks reality.
 * providerKeyOf maps lowercase provider -> account key (tick-built).
 */
export function calibrationAccount(r, providerKeyOf) {
  if (r?.enforced === true && r?.decidedAccount != null) return r.decidedAccount;
  if (r?.actualAccount != null) return r.actualAccount;
  if (r?.provider != null && providerKeyOf != null) {
    return providerKeyOf.get(String(r.provider).toLowerCase()) ?? null;
  }
  return null;
}

const anchorOf = (r) => r?.startedAt ?? r?.decidedAt ?? null;

export function isInflight(r, nowMs, horizonMs) {
  if (r == null || isLedgerTerminal(r.status)) return false;
  if (r.unverified === true) return false;
  const anchor = anchorOf(r);
  if (anchor == null || !(anchor <= nowMs)) return false;
  return nowMs - anchor < horizonMs;
}

/**
 * Single-pass in-flight census. Each record contributes at most one unit,
 * so double-counting is structurally impossible (no clamp backstop).
 * Returns { byAccount, unattributed, staleExcluded, unverifiedExcluded }.
 */
export function inflightByAccount(ledger, { nowMs, horizonMs }) {
  const byAccount = {};
  let unattributed = 0;
  let staleExcluded = 0;
  let unverifiedExcluded = 0;
  for (const r of (ledger ?? new Map()).values()) {
    if (isLedgerTerminal(r?.status)) continue;
    const anchor = anchorOf(r);
    if (anchor == null || !(anchor <= nowMs) || nowMs - anchor >= horizonMs) {
      staleExcluded += 1;
      continue;
    }
    if (r.unverified === true) {
      unverifiedExcluded += 1;
      continue;
    }
    const a = attributedAccount(r);
    if (a == null) unattributed += 1;
    else byAccount[a] = (byAccount[a] ?? 0) + 1;
  }
  return { byAccount, unattributed, staleExcluded, unverifiedExcluded };
}

/** Per-family trial in-flight: fresh trial decisions on non-terminal runs. */
export function trialInflight(ledger, { nowMs, windowMs = TRIAL_WINDOW_MS }) {
  // Map accumulator: family strings key this count and '__proto__' would
  // read Object.prototype (an object, so `?? 0` never fires and `+ 1`
  // string-concatenates). fromEntries keeps the plain-object return shape.
  const counts = new Map();
  for (const r of (ledger ?? new Map()).values()) {
    if (r?.trial !== true || !r?.family) continue;
    if (isLedgerTerminal(r?.status) || r?.unverified === true) continue;
    const anchor = anchorOf(r);
    if (anchor == null || !(anchor <= nowMs) || nowMs - anchor >= windowMs) continue;
    counts.set(r.family, (counts.get(r.family) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

/**
 * Restart/startup reconciliation. Non-terminal records anchored inside the
 * verify window stay verifiable; older ones (and anchor-less ones) are
 * marked `unverified` and excluded from counting. NEVER deletes: the
 * shadow log is built from the same records and must survive restarts.
 * Returns the number newly marked this call.
 */
export function reconcileLedger(ledger, { nowMs, verifyWindowMs }) {
  let marked = 0;
  for (const r of (ledger ?? new Map()).values()) {
    if (isLedgerTerminal(r?.status)) continue;
    const anchor = anchorOf(r);
    if (anchor != null && anchor <= nowMs && nowMs - anchor < verifyWindowMs) {
      r.unverified = false;
      continue;
    }
    if (r.unverified !== true) {
      r.unverified = true;
      marked += 1;
    }
  }
  return marked;
}

/**
 * Decisions since a timestamp (hook/event-time pressure after the tick).
 * Inclusive (`>=`): decisions can share the tick's own millisecond under a
 * frozen clock (and the same ms means decided after the view published).
 * Double counting is impossible -- one record per runId, and the tick loop
 * never re-decides an already-decided run.
 */
export function decidedSince(ledger, sinceMs, excludeRunId = null) {
  const out = [];
  for (const r of (ledger ?? new Map()).values()) {
    if (r?.decidedAccount == null || r?.decidedAt == null) continue;
    if (!(r.decidedAt >= sinceMs)) continue;
    if (excludeRunId != null && r.runId === excludeRunId) continue;
    out.push(r);
  }
  return out;
}

/**
 * Runs started on one account since a timestamp, with a caller-supplied
 * attribution (E calibration: decided/actual attribution with a provider
 * fallback -- a run naming only a provider still burned its quota).
 */
export function startedOnCountWhere(ledger, accountId, sinceMs, accountOf) {
  let n = 0;
  for (const r of (ledger ?? new Map()).values()) {
    if (r?.startedAt == null || !(r.startedAt >= sinceMs)) continue;
    if (accountOf(r) === accountId) n += 1;
  }
  return n;
}

/** Runs started on one account since a timestamp (E calibration). */
export function startedOnCount(ledger, accountId, sinceMs) {
  return startedOnCountWhere(ledger, accountId, sinceMs, attributedAccount);
}

/**
 * Runs actually observed on one account since a timestamp (E calibration):
 * model-mapped only, never the decision. A run decided onto B that burned
 * A's quota calibrates A.
 */
export function startedOnActualCount(ledger, accountId, sinceMs) {
  let n = 0;
  for (const r of (ledger ?? new Map()).values()) {
    if (r?.startedAt == null || !(r.startedAt >= sinceMs)) continue;
    if (r?.actualAccount === accountId) n += 1;
  }
  return n;
}

export function terminalRecords(ledger) {
  return [...(ledger ?? new Map()).values()].filter(r => isLedgerTerminal(r?.status));
}

/** Number of decided records (the /shadow size without materializing entries). */
export function decidedCount(ledger) {
  let n = 0;
  for (const r of (ledger ?? new Map()).values()) {
    if (r?.decidedAccount != null) n += 1;
  }
  return n;
}

/**
 * The shadow log: every decided record, newest first. Built from the same
 * records as accounting, never pruned by reconciliation; trimLedger bounds
 * it by size/age (terminal, unverified, and stale records first).
 */
export function shadowEntries(ledger, { limit = 100 } = {}) {
  const all = [...(ledger ?? new Map()).values()].filter(r => r?.decidedAccount != null);
  all.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  return all.slice(0, Math.max(0, limit)).map(r => ({
    runId: r.runId,
    agentId: r.agentId ?? 'unknown',
    actualModel: r.actualModel ?? 'unknown',
    actualModelSource: r.actualModelSource ?? null,
    actualModelError: r.actualModelError ?? null,
    actualPending: r.actualPending === true,
    wouldModel: r.wouldModel ?? null,
    modelMatch: r.modelMatch ?? null,
    account: r.decidedAccount,
    accountId: r.decidedAccount,
    rung: r.rung ?? null,
    trial: r.trial === true,
    family: r.family ?? null,
    reason: r.reason ?? null,
    enforced: r.enforced === true,
    eventTime: r.eventTime === true,
    unverified: r.unverified === true,
    at: r.decidedAt ?? null,
  }));
}

/**
 * Trim for persist: drop terminal records older than the TTL, then
 * unverified and stale-horizon non-terminal records (reconcile already
 * excludes both from counting, and a late start/terminal event re-creates
 * the record if the run proves alive again). Past the cap, evict
 * oldest-activity-first. The persisted blob is therefore HARD-bounded at
 * maxRecords: in practice only dead weight reaches the cap pass, because
 * live in-flight records are always the newest activity; if live pressure
 * alone ever exceeds the cap the oldest of it is shed first (fail-safe
 * against unbounded persist growth, at the cost of the stalest pressure).
 */
export function trimLedger(ledger, { nowMs, maxRecords = LEDGER_CAP, terminalTtlMs = LEDGER_TERMINAL_TTL_MS, staleHorizonMs = null } = {}) {
  const all = [...(ledger ?? new Map()).entries()];
  for (const [id, r] of all) {
    if (isLedgerTerminal(r?.status) && r?.terminalAt != null && nowMs - r.terminalAt > terminalTtlMs) {
      ledger.delete(id);
    }
  }
  for (const [id, r] of [...ledger.entries()]) {
    if (isLedgerTerminal(r?.status)) continue;
    const anchor = anchorOf(r);
    const age = anchor != null ? nowMs - anchor : Infinity;
    if (r?.unverified === true && age > terminalTtlMs) ledger.delete(id);
    else if (staleHorizonMs != null && (anchor == null || age >= staleHorizonMs)) ledger.delete(id);
  }
  if (ledger.size > maxRecords) {
    const activityOf = (r) => Math.max(r?.startedAt ?? 0, r?.decidedAt ?? 0, r?.terminalAt ?? 0);
    const ordered = [...ledger.values()].sort((a, b) => activityOf(a) - activityOf(b));
    for (const r of ordered) {
      if (ledger.size <= maxRecords) break;
      ledger.delete(r.runId);
    }
  }
  return ledger;
}

/**
 * Merge an overlay ledger into a base (worker startup: persisted state is
 * the base, in-memory pre-tick decisions the overlay). Overlay fields win
 * only where set; base records are never dropped.
 */
export function mergeLedger(base, overlay) {
  for (const [id, o] of (overlay ?? new Map()).entries()) {
    const b = base.get(id);
    if (!b) {
      base.set(id, { ...o });
      continue;
    }
    for (const [k, v] of Object.entries(o)) {
      if (v != null && (b[k] == null || k === 'status' || k === 'unverified')) b[k] = v;
    }
    // The recordDecision precedence (first wins, enforced overwrites
    // event-time) applies at merge too: a persisted event-time decision
    // must not shadow the hook decision taken after the last persist.
    if (o.decidedAccount != null
      && (b.decidedAccount == null || (o.enforced === true && b.enforced !== true))) {
      b.decidedAccount = o.decidedAccount;
      if (o.decidedAt != null) b.decidedAt = o.decidedAt;
      b.enforced = o.enforced === true;
      for (const k of ['wouldModel', 'rung', 'family', 'reason', 'eventTime']) {
        if (o[k] != null) b[k] = o[k];
      }
      if (o.trial === true) b.trial = true;
    }
  }
  return base;
}

/**
 * Upgrade migration: legacy persisted runs feed + shadow-ring entries into
 * one ledger. Ring entries become decisions (decidedAt = entry at);
 * runs-feed entries become starts/terminals; both merge by runId.
 *
 * Ring entries for runs already terminal in the feed are excluded by
 * default: decisions never land on terminal records (the finding-2
 * precedence), so a legacy ring full of dead runs does not resurface as
 * live history. Pass includeTerminalDecisions:true to import those as
 * history-only records instead -- status stays terminal (never counted,
 * never fresh pressure since decidedAt stays historical), visible in
 * /shadow only. Entries without a historical `at` are never imported
 * that way (an undated decision must not look fresh to decidedSince).
 */
export function migrateLegacy({ runs, ringEntries, includeTerminalDecisions = false }) {
  const ledger = new Map();
  for (const run of runs ?? []) {
    if (run == null || run.runId == null) continue;
    const at = run.at ?? Date.now();
    if (isLedgerTerminal(run.status)) {
      recordTerminal(ledger, { runId: run.runId, agentId: run.agentId, model: run.model, modelSource: run.modelSource, provider: run.provider }, run.status, at);
      const r = ledger.get(String(run.runId));
      if (r && run.issueId != null) r.issueId = run.issueId;
      if (r && run.adapterType != null) r.adapterType = run.adapterType;
    } else if (run.status == null || run.status === 'running') {
      recordStart(ledger, {
        runId: run.runId, agentId: run.agentId, issueId: run.issueId,
        adapterType: run.adapterType, model: run.model, modelSource: run.modelSource,
        provider: run.provider,
      }, at);
    }
  }
  for (const e of ringEntries ?? []) {
    if (e == null || e.runId == null) continue;
    recordDecision(ledger, {
      runId: e.runId, agentId: e.agentId, accountId: e.accountId ?? e.account ?? null,
      enforced: e.enforced === true, wouldModel: e.wouldModel ?? null,
      rung: e.rung ?? null, trial: e.trial === true, family: e.family ?? null,
      reason: e.reason ?? null, eventTime: e.eventTime === true,
    }, e.at ?? Date.now());
    const r = ledger.get(String(e.runId));
    if (r) {
      if (includeTerminalDecisions === true
        && isLedgerTerminal(r.status)
        && r.decidedAccount == null
        && e.at != null) {
        r.decidedAccount = e.accountId ?? e.account ?? null;
        r.decidedAt = e.at;
        r.enforced = e.enforced === true;
        if (e.wouldModel != null) r.wouldModel = e.wouldModel;
        if (e.rung != null) r.rung = e.rung;
        if (e.trial === true) r.trial = true;
        if (e.family != null) r.family = e.family;
        if (e.reason != null) r.reason = e.reason;
        if (e.eventTime === true) r.eventTime = true;
        fill(r, 'agentId', e.agentId);
      }
      if (e.actualModel != null) {
        r.actualModel = e.actualModel;
        r.actualModelSource = e.actualModelSource ?? null;
        r.actualModelError = e.actualModelError ?? null;
        r.actualPending = e.actualPending === true;
        if (e.modelMatch != null) r.modelMatch = e.modelMatch;
      }
      if (r.startedAt == null && r.decidedAt == null && e.at != null) r.decidedAt = e.at;
    }
  }
  return ledger;
}
