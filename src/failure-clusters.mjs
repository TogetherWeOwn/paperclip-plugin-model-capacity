/**
 * Alert-only failure-cluster detector.
 *
 * Subscribes (via the plugin's `agent.run.failed` handler) to failed-run
 * events and keeps per-account failure counters in plugin state. When at
 * least 3 qualifying failures for one account land inside a 15-minute
 * event-time window, the detector creates or updates exactly ONE managed
 * alert issue (a stable-origin singleton) and reports `error` through
 * plugin health until the cluster clears.
 *
 * Alert-only: this module never disables accounts, never changes routing,
 * never touches the `enforce` flag, and never duplicates the host's native
 * per-run / budget / agent-error attention. Writes happen only on material
 * cluster transitions (enter, exit, count-band escalation/de-escalation),
 * never per run.
 *
 * Predicate fidelity notes (documented differences from a created_at poll):
 * - Only `status === 'failed'` qualifies. The host emits `agent.run.failed`
 *   for both `failed` and `timed_out` runs, so `timed_out` is excluded here.
 * - Only the allowlisted error codes qualify (exact match, tolerant field
 *   placement): `claude_auth_required`, `claude_transient_upstream`,
 *   `adapter_failed`.
 * - The account is extracted from the terminal model-decision reason with
 *   the legacy ` on provider:account` pattern.
 * - The 15-minute window runs over EVENT time (the failure's `finishedAt`,
 *   else the event publish time, else receipt time), NOT run creation time.
 *   A long run created 20 minutes ago but failing now counts here while a
 *   created_at poll would exclude it, and vice versa. Shadow comparisons
 *   against a created_at poll are therefore normalized-cluster comparisons,
 *   never byte-identical claims.
 */

// Stable singleton identity. One managed alert issue per company; per-account
// counters live in plugin state and must never multiply issues.
export const FAILURE_CLUSTER_ORIGIN_KIND = 'plugin:togetherweown.model-capacity:failure-cluster';
export const FAILURE_CLUSTER_ORIGIN_ID = 'failure-cluster-singleton';
export const FAILURE_CLUSTER_STATE_KEY = 'failure-cluster-v1';

// Exact error-code allowlist (membership only; order is cosmetic).
export const FAILURE_CLUSTER_ERROR_CODES = [
  'claude_auth_required',
  'claude_transient_upstream',
  'adapter_failed',
];

// Legacy threshold semantics: >= 3 qualifying runs per account per window.
export const FAILURE_CLUSTER_WINDOW_MS = 15 * 60 * 1000;
export const FAILURE_CLUSTER_THRESHOLD = 3;

// Failed alert writes retry no sooner than this (events and the per-minute
// tick re-evaluate; without backoff every failure would retry per event).
export const FAILURE_CLUSTER_WRITE_RETRY_MS = 60 * 1000;

// State bounds: per-account event rings and transition history are capped so
// a failure storm cannot grow persisted state without bound. Counts past the
// cap render as `500+`; the threshold decision itself is unaffected.
export const FAILURE_CLUSTER_MAX_EVENTS_PER_ACCOUNT = 500;
export const FAILURE_CLUSTER_MAX_TRANSITIONS = 10;

// Count bands: while a cluster stays active, the singleton is rewritten only
// when the account's count crosses a band edge (enter/exit always write).
// This keeps the issue roughly fresh during a storm with at most a handful
// of updates per account per episode instead of one per failure.
export function countBand(count) {
  if (count < 5) return '3-4';
  if (count < 10) return '5-9';
  if (count < 25) return '10-24';
  return '25+';
}

// Band rank orders crossings by direction: a rise records `escalate`, a fall
// records `deescalate`. Both are threshold crossings and both rewrite the
// singleton, so a decaying storm stays fresh until its exit write.
const BAND_RANK = { '3-4': 0, '5-9': 1, '10-24': 2, '25+': 3 };
const bandRank = band => BAND_RANK[band] ?? -1;

const ACCOUNT_PATTERN = / on ([\w.-]+:[\w.-]+)/;

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function parseTimeMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Extract the cluster signal from a raw `agent.run.failed` event.
 * Pure: no I/O, no state. Returns `{ qualifying: false, reason }` for
 * anything outside the predicate, else `{ qualifying: true, account,
 * errorCode, atMs, runId }`.
 */
export function extractClusterSignal(event, nowMs) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const run = payload.run && typeof payload.run === 'object' ? payload.run : {};
  const modelDecision = payload.modelDecision && typeof payload.modelDecision === 'object' ? payload.modelDecision : {};
  const modelDecisionSnake = payload.model_decision && typeof payload.model_decision === 'object' ? payload.model_decision : {};
  const runDecision = run.modelDecision && typeof run.modelDecision === 'object' ? run.modelDecision : {};
  const runDecisionSnake = run.model_decision && typeof run.model_decision === 'object' ? run.model_decision : {};

  // The failed event type conflates failed + timed_out: require explicit
  // failed status. Malformed events without a status are ignored (the host
  // run lifecycle always sets one).
  const status = firstString([payload.status, run.status]);
  if (status !== 'failed') return { qualifying: false, reason: 'status-not-failed' };

  const errorCode = firstString([payload.errorCode, payload.error_code, run.errorCode, run.error_code]);
  if (errorCode === null || !FAILURE_CLUSTER_ERROR_CODES.includes(errorCode)) {
    return { qualifying: false, reason: 'error-not-allowlisted' };
  }

  const reasonText = firstString([
    modelDecision.reason, modelDecisionSnake.reason, runDecision.reason, runDecisionSnake.reason,
  ]);
  const account = typeof reasonText === 'string' ? (reasonText.match(ACCOUNT_PATTERN)?.[1] ?? null) : null;
  if (account === null) return { qualifying: false, reason: 'account-not-extracted' };

  const atMs = parseTimeMs(firstString([
    payload.finishedAt, payload.finished_at, run.finishedAt, run.finished_at, event?.occurredAt,
  ])) ?? nowMs;
  const clampedAtMs = atMs > nowMs || atMs < 0 ? nowMs : atMs;
  const runId = firstString([event?.entityId, payload.runId, payload.run_id, run.id, run.runId, payload.id]) ?? 'unknown';
  return { qualifying: true, account, errorCode, atMs: clampedAtMs, runId };
}

export function emptyClusterState() {
  return {
    version: 1,
    accounts: {},
    prevActive: [],
    prevBands: {},
    singletonIssueId: null,
    lastTransitionSig: null,
    lastWriteError: null,
    lastWriteAttemptMs: 0,
    transitions: [],
  };
}

/** Tolerantly normalize persisted state (null/corrupt reads become fresh). */
export function normalizeClusterState(raw) {
  const fresh = emptyClusterState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh;
  const accounts = {};
  if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
    for (const [account, entry] of Object.entries(raw.accounts)) {
      if (typeof account !== 'string' || account.length === 0) continue;
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.events)) continue;
      const events = [];
      for (const evt of entry.events) {
        if (!evt || typeof evt !== 'object') continue;
        if (typeof evt.runId !== 'string' || typeof evt.atMs !== 'number' || !Number.isFinite(evt.atMs)) continue;
        if (typeof evt.errorCode !== 'string') continue;
        events.push({ runId: evt.runId, atMs: evt.atMs, errorCode: evt.errorCode });
      }
      accounts[account] = { events };
    }
  }
  const prevBands = {};
  if (raw.prevBands && typeof raw.prevBands === 'object' && !Array.isArray(raw.prevBands)) {
    for (const [account, band] of Object.entries(raw.prevBands)) {
      if (typeof account === 'string' && typeof band === 'string') prevBands[account] = band;
    }
  }
  const transitions = [];
  if (Array.isArray(raw.transitions)) {
    for (const entry of raw.transitions) {
      if (!entry || typeof entry !== 'object' || typeof entry.atMs !== 'number' || !Number.isFinite(entry.atMs)) continue;
      if (typeof entry.type !== 'string' || !Array.isArray(entry.accounts)) continue;
      const accountsList = entry.accounts
        .filter(a => a && typeof a === 'object' && typeof a.account === 'string' && typeof a.count === 'number')
        .map(a => ({ account: a.account, count: a.count }));
      transitions.push({ atMs: entry.atMs, type: entry.type, accounts: accountsList });
    }
  }
  return {
    version: 1,
    accounts,
    prevActive: Array.isArray(raw.prevActive) ? raw.prevActive.filter(a => typeof a === 'string') : [],
    prevBands,
    singletonIssueId: typeof raw.singletonIssueId === 'string' ? raw.singletonIssueId : null,
    lastTransitionSig: typeof raw.lastTransitionSig === 'string' ? raw.lastTransitionSig : null,
    lastWriteError: raw.lastWriteError && typeof raw.lastWriteError === 'object' && typeof raw.lastWriteError.message === 'string'
      ? { atMs: raw.lastWriteError.atMs ?? 0, message: raw.lastWriteError.message }
      : null,
    lastWriteAttemptMs: typeof raw.lastWriteAttemptMs === 'number' && Number.isFinite(raw.lastWriteAttemptMs)
      ? raw.lastWriteAttemptMs
      : 0,
    transitions,
  };
}

/** Deterministic signature over the active set + bands (idempotency key). */
export function transitionSig(activeSorted, bands) {
  return JSON.stringify({ a: activeSorted.map(account => `${account}:${bands[account] ?? '?'}`) });
}

/**
 * Prune to the window and compute the cluster transition. Pure: reads
 * `state`, returns `{ accounts, active, entered, exited, escalated,
 * deescalated, sig, writeDue }` where `accounts` holds per-account window
 * summaries.
 */
export function evaluateClusters(state, nowMs) {
  const floorMs = nowMs - FAILURE_CLUSTER_WINDOW_MS;
  const accounts = {};
  for (const [account, entry] of Object.entries(state.accounts ?? {})) {
    const events = (entry.events ?? []).filter(evt => evt.atMs > floorMs);
    if (events.length === 0) continue;
    const errors = {};
    for (const evt of events) errors[evt.errorCode] = (errors[evt.errorCode] ?? 0) + 1;
    const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
    accounts[account] = {
      count: events.length,
      capped: events.length >= FAILURE_CLUSTER_MAX_EVENTS_PER_ACCOUNT,
      errors,
      runIds: [...events].sort((a, b) => b.atMs - a.atMs).map(evt => evt.runId),
      windowStartMs: sorted[0].atMs,
      windowEndMs: sorted[sorted.length - 1].atMs,
    };
  }
  const active = Object.keys(accounts)
    .filter(account => accounts[account].count >= FAILURE_CLUSTER_THRESHOLD)
    .sort();
  const bands = {};
  for (const account of active) bands[account] = countBand(accounts[account].count);
  const prevSet = new Set(state.prevActive ?? []);
  const activeSet = new Set(active);
  const entered = active.filter(account => !prevSet.has(account));
  const exited = (state.prevActive ?? []).filter(account => !activeSet.has(account));
  const bandChanged = active.filter(account => prevSet.has(account) && (state.prevBands ?? {})[account] !== bands[account]);
  const escalated = bandChanged.filter(account => bandRank(bands[account]) > bandRank((state.prevBands ?? {})[account]));
  const deescalated = bandChanged.filter(account => bandRank(bands[account]) < bandRank((state.prevBands ?? {})[account]));
  return {
    accounts,
    active,
    entered,
    exited,
    escalated,
    deescalated,
    sig: transitionSig(active, bands),
    bands,
    writeDue: entered.length > 0 || exited.length > 0 || escalated.length > 0 || deescalated.length > 0,
  };
}

/** True when the singleton already shows exactly the desired content. */
export function singletonContentEqual(existing, desired) {
  if (!existing || !desired) return false;
  return existing.title === desired.title
    && existing.description === desired.description
    && existing.status === desired.status
    && existing.priority === desired.priority;
}

function iso(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return 'unknown-time';
  }
}

function formatCount(count, capped) {
  return capped ? `${count}+` : String(count);
}

/**
 * Render the singleton's desired content. Pure. The body carries cluster
 * summaries only (accounts, counts, window, error classes, run ids):
 * never secrets, never full run payloads.
 */
export function renderSingleton({ active, accounts, history, nowMs }) {
  const lines = [];
  if (active.length === 0) {
    const last = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
    lines.push('No failure cluster is active.');
    lines.push('');
    if (last) lines.push(`Last transition: ${iso(last.atMs)} ${last.type} ${(last.accounts ?? []).map(a => a.account).join(', ')}.`);
    else lines.push('No cluster transition has been recorded yet.');
  } else {
    const total = active.reduce((sum, account) => sum + accounts[account].count, 0);
    lines.push(`${active.length === 1 ? 'One failure cluster is' : `${active.length} failure clusters are`} active (${total} qualifying failures in the window).`);
    lines.push('');
    lines.push('## Active clusters');
    for (const account of active) {
      const summary = accounts[account];
      const errors = Object.entries(summary.errors)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([code, n]) => `${code}x${n}`)
        .join(', ');
      const runs = summary.runIds.slice(0, 8).join(', ');
      lines.push(`- ${account}: ${formatCount(summary.count, summary.capped)} qualifying failures in the last 15m `
        + `(window ${iso(summary.windowStartMs)}-${iso(summary.windowEndMs)}); errors: ${errors}; runs: ${runs}`);
    }
  }
  if (Array.isArray(history) && history.length > 0) {
    lines.push('');
    lines.push(`## Recent transitions (last ${history.length})`);
    for (const entry of [...history].reverse()) {
      const who = (entry.accounts ?? []).map(a => `${a.account} (${a.count})`).join(', ');
      lines.push(`- ${iso(entry.atMs)} ${entry.type} ${who}`);
    }
  }
  lines.push('');
  lines.push('## Detector semantics');
  lines.push('- Event-time 15-minute window (failure finishedAt, else event publish time); not run creation time, so shadow comparisons against a created_at poll are normalized, not identical.');
  lines.push('- Counts only status=failed (timed_out excluded) with error codes: claude_auth_required, claude_transient_upstream, adapter_failed.');
  lines.push('- Account from the model-decision reason ` on provider:account`; threshold >= 3 qualifying failures per account; alert writes on enter/exit/band change only.');
  lines.push(`- Managed singleton ${FAILURE_CLUSTER_ORIGIN_KIND}/${FAILURE_CLUSTER_ORIGIN_ID}; parking and plugin-health checks stay outside this detector.`);
  lines.push(`Rendered ${iso(nowMs)}.`);

  const description = lines.join('\n');
  if (active.length === 0) {
    return {
      title: '[mc-health] failure clusters cleared',
      description,
      status: 'done',
      priority: 'medium',
    };
  }
  if (active.length === 1) {
    const summary = accounts[active[0]];
    return {
      title: `[mc-health] failure cluster: ${active[0]} - ${formatCount(summary.count, summary.capped)} failures/15m`,
      description,
      status: 'in_progress',
      priority: 'high',
    };
  }
  const worst = [...active].sort((a, b) => accounts[b].count - accounts[a].count)[0];
  return {
    title: `[mc-health] failure clusters active: ${active.length} accounts (worst: ${worst} ${formatCount(accounts[worst].count, accounts[worst].capped)}/15m)`,
    description,
    status: 'in_progress',
    priority: 'high',
  };
}

function issueTimestampMs(issue) {
  for (const key of ['updatedAt', 'updated_at', 'createdAt', 'created_at']) {
    const ms = typeof issue?.[key] === 'string' ? Date.parse(issue[key]) : null;
    if (ms !== null && Number.isFinite(ms)) return ms;
  }
  return 0;
}

function isSingleton(issue) {
  return issue?.originKind === FAILURE_CLUSTER_ORIGIN_KIND && issue?.originId === FAILURE_CLUSTER_ORIGIN_ID;
}

/**
 * Reconcile the singleton: verify the stored id still points at our origin,
 * else adopt the newest matching issue, else null (caller creates).
 * Every write path goes through here first; foreign-origin issues are never
 * returned for update.
 */
export async function reconcileSingleton({ issues, companyId, storedIssueId }) {
  if (typeof storedIssueId === 'string' && storedIssueId.length > 0) {
    const current = await issues.get(storedIssueId, companyId);
    if (isSingleton(current)) return current;
  }
  const found = await issues.list({ companyId, originKind: FAILURE_CLUSTER_ORIGIN_KIND, originId: FAILURE_CLUSTER_ORIGIN_ID });
  const owned = (Array.isArray(found) ? found : []).filter(isSingleton);
  if (owned.length === 0) return null;
  owned.sort((a, b) => issueTimestampMs(b) - issueTimestampMs(a));
  return owned[0];
}

/**
 * Ingest one failed event (or null for a tick-only pass), evaluate cluster
 * transitions, and create/update the singleton when a transition is due.
 * Must run inside the caller's per-company serialization chain.
 *
 * `alert` is the resolved `{ enabled, assigneeAgentId }` block; anything
 * else means zero issue writes (no state I/O either).
 */
export async function updateFailureClusters({ ctx, companyId, alert, nowMs, event = null, stateKey }) {
  if (!alert || alert.enabled !== true || typeof alert.assigneeAgentId !== 'string' || alert.assigneeAgentId.length === 0) {
    return { action: 'disabled' };
  }
  const key = stateKey(companyId, FAILURE_CLUSTER_STATE_KEY);
  const state = normalizeClusterState(await ctx.state.get(key));

  if (event !== null) {
    const signal = extractClusterSignal(event, nowMs);
    if (signal.qualifying) {
      const entry = state.accounts[signal.account] ?? { events: [] };
      if (!entry.events.some(evt => evt.runId === signal.runId)) {
        entry.events.push({ runId: signal.runId, atMs: signal.atMs, errorCode: signal.errorCode });
        if (entry.events.length > FAILURE_CLUSTER_MAX_EVENTS_PER_ACCOUNT) {
          entry.events.sort((a, b) => a.atMs - b.atMs);
          entry.events = entry.events.slice(entry.events.length - FAILURE_CLUSTER_MAX_EVENTS_PER_ACCOUNT);
        }
        state.accounts[signal.account] = entry;
      }
    }
  }

  const evalResult = evaluateClusters(state, nowMs);
  // Drop accounts whose window emptied so state cannot accumulate dead keys.
  state.accounts = Object.fromEntries(
    Object.entries(state.accounts).filter(([account]) => evalResult.accounts[account] !== undefined),
  );

  if (!evalResult.writeDue) {
    // State matches the last successful write: a recorded write error can
    // only refer to a superseded transition, so clear it instead of
    // reporting stale failure forever.
    if (state.lastWriteError !== null) {
      state.lastWriteError = null;
      await ctx.state.set(key, state);
      return { action: 'error-cleared', active: evalResult.active };
    }
    await ctx.state.set(key, state);
    return { action: 'noop', active: evalResult.active };
  }

  const desired = renderSingleton({
    active: evalResult.active,
    accounts: evalResult.accounts,
    history: state.transitions,
    nowMs,
  });

  try {
    const existing = await reconcileSingleton({ issues: ctx.issues, companyId, storedIssueId: state.singletonIssueId });
    if (existing !== null && existing.id !== state.singletonIssueId) state.singletonIssueId = existing.id;
    if (existing !== null
      && singletonContentEqual(existing, desired)
      && existing.assigneeAgentId === alert.assigneeAgentId) {
      state.prevActive = evalResult.active;
      state.prevBands = evalResult.bands;
      state.lastTransitionSig = evalResult.sig;
      state.lastWriteError = null;
      await ctx.state.set(key, state);
      return { action: 'already-current', active: evalResult.active, issueId: existing.id };
    }
    if (nowMs - state.lastWriteAttemptMs < FAILURE_CLUSTER_WRITE_RETRY_MS) {
      await ctx.state.set(key, state);
      return { action: 'backoff-deferred', active: evalResult.active };
    }
    let issueId;
    if (existing === null) {
      // Create allowlist: companyId, title, description, status, priority,
      // assigneeAgentId (config value), originKind, originId. Nothing else.
      const created = await ctx.issues.create({
        companyId,
        title: desired.title,
        description: desired.description,
        status: desired.status,
        priority: desired.priority,
        assigneeAgentId: alert.assigneeAgentId,
        originKind: FAILURE_CLUSTER_ORIGIN_KIND,
        originId: FAILURE_CLUSTER_ORIGIN_ID,
      });
      issueId = created.id;
      state.singletonIssueId = created.id;
    } else {
      // Update allowlist: title, description, status, priority, plus
      // assigneeAgentId only to restore config drift. Origin fields are
      // never rewritten; foreign issues never reach here (reconciled above).
      const patch = {
        title: desired.title,
        description: desired.description,
        status: desired.status,
        priority: desired.priority,
      };
      if (existing.assigneeAgentId !== alert.assigneeAgentId) patch.assigneeAgentId = alert.assigneeAgentId;
      await ctx.issues.update(existing.id, patch, companyId);
      issueId = existing.id;
    }
    state.lastWriteAttemptMs = nowMs;
    state.lastWriteError = null;
    state.prevActive = evalResult.active;
    state.prevBands = evalResult.bands;
    state.lastTransitionSig = evalResult.sig;
    const historyEntry = (type, accounts) => ({
      atMs: nowMs,
      type,
      accounts: accounts.map(account => ({
        account,
        count: evalResult.accounts[account]?.count ?? 0,
      })),
    });
    if (evalResult.entered.length > 0) state.transitions.push(historyEntry('enter', evalResult.entered));
    if (evalResult.exited.length > 0) state.transitions.push(historyEntry('exit', evalResult.exited));
    if (evalResult.escalated.length > 0) state.transitions.push(historyEntry('escalate', evalResult.escalated));
    if (evalResult.deescalated.length > 0) state.transitions.push(historyEntry('deescalate', evalResult.deescalated));
    if (state.transitions.length > FAILURE_CLUSTER_MAX_TRANSITIONS) {
      state.transitions = state.transitions.slice(state.transitions.length - FAILURE_CLUSTER_MAX_TRANSITIONS);
    }
    await ctx.state.set(key, state);
    return { action: existing === null ? 'created' : 'updated', active: evalResult.active, issueId };
  } catch (error) {
    state.lastWriteError = { atMs: nowMs, message: String(error?.message ?? error).slice(0, 300) };
    state.lastWriteAttemptMs = nowMs;
    await ctx.state.set(key, state);
    return { action: 'write-failed', active: evalResult.active, error: state.lastWriteError.message };
  }
}
