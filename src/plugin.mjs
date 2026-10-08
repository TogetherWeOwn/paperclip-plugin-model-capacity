/**
 * Model-capacity plugin worker wiring (I/O at the edges; math in modules).
 *
 * v0.2.1 = ENFORCE-CAPABLE. The worker refreshes AA data daily, reads
 * CLIProxy burn from the host-published lane endpoint (one GET, short
 * in-memory cache), steps per-account pacing pointers, and records what it
 * WOULD have decided for recently started runs. `onResolveRunModel` is
 * memory-only by construction -- it reads the in-memory live view the tick
 * populated and never touches config, state, network, or db (the host
 * deadline is 1.5s). It answers `keep` unless the `enforce` config flag is
 * true for the company. Every enforced decision is queued in memory and
 * merged into the shadow ring (flagged `enforced:true`) on the next tick.
 */

import {
  DEFAULT_BASE_URL,
  DEFAULT_ACCOUNTS_PATH,
  LANE_KEY_HEADER,
  buildLaneRequest,
  assertLaneRequest,
  parseLaneBody,
  CliproxyCache,
} from './cliproxy.mjs';
import { fetchAaFreeList, parseAaFreeList, fetchAaLeaderboard, parseAaLeaderboardHtml, mergeAaRows } from './aa.mjs';
import { DEFAULT_ARM_MAP, resolveArms, armsForProvider, providerForModelName } from './arms.mjs';
import { computeComposite, DEFAULT_WEIGHTS } from './quality.mjs';
import { fillCosts } from './cost.mjs';
import { buildLadder } from './ladder.mjs';
import {
  scheduleError, stepController, stepRateController, appendUtilReading,
  measuredRatePerHour, requiredRatePerHour, orderAccounts, DEFAULT_PACING,
} from './pacing.mjs';
import { decide, DEFAULT_ROLE_BANDS, DEFAULT_CONTEXT_CAPS } from './decide.mjs';
import { computeConcurrencyTarget, distributeCaps, distributeWeightedCaps, DEFAULT_CONCURRENCY } from './concurrency.mjs';
import { orderAccountsForRun } from './select.mjs';
import { createShadowRing, SHADOW_CAPACITY } from './shadow.mjs';
import { manifest, LANE_BASE_URL_ALLOWLIST } from './manifest.mjs';

const NS = 'model-capacity';
const AA_KEY = 'aa-snapshot-v1';
const PACING_KEY = 'pacing-v1';
const RING_KEY = 'shadow-ring-v1';
const CAPACITY_KEY = 'capacity-v1';
const LADDER_KEY = 'ladder-v1';
const RATE_KEY = 'rate-history-v1';
const RUNEVT_KEY = 'run-events-v1';

/**
 * Recent runs for one company, from agent.run.* events only (started,
 * finished, failed) merged with a persisted ring in plugin state. No db
 * access: run facts come from SDK surfaces, never core tables.
 */
const RUNS_KEY = 'runs-v1';
const RUNS_CAP = 500;

const scopeKey = (companyId, stateKey) => ({ scopeKind: 'company', scopeId: companyId, namespace: NS, stateKey });

function isSecretRef(v) {
  return v != null && typeof v === 'object' && v.type === 'secret_ref' && typeof v.secretId === 'string';
}

export function validateConfigShape(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['config must be an object'];
  const { cliproxy, aa, weights, pacing, concurrency, roles, armMap } = raw;
  // The lane key is sent as X-Api-Key to baseUrl: only the hard-coded
  // allowlist may name it, or config could redirect the key to any host.
  if (cliproxy?.baseUrl != null && !LANE_BASE_URL_ALLOWLIST.includes(cliproxy.baseUrl)) {
    errors.push(`cliproxy.baseUrl must be one of: ${LANE_BASE_URL_ALLOWLIST.join(', ')}`);
  }
  if (cliproxy?.laneKeySecretRef != null && !isSecretRef(cliproxy.laneKeySecretRef)) {
    errors.push('cliproxy.laneKeySecretRef must be a secret_ref object');
  }
  if (aa?.apiKeySecretRef != null && !isSecretRef(aa.apiKeySecretRef)) errors.push('aa.apiKeySecretRef must be a secret_ref object');
  for (const [k, v] of Object.entries(weights ?? {})) {
    if (typeof v !== 'number' || !(v >= 0)) errors.push(`weights.${k} must be a non-negative number`);
  }
  if (pacing && (pacing.guardHighPct <= pacing.guardRejoinPct)) errors.push('pacing.guardHighPct must exceed pacing.guardRejoinPct');
  if (concurrency && !(concurrency.maxTotal >= 1)) errors.push('concurrency.maxTotal must be >= 1');
  for (const b of armMap ?? []) {
    if (!b?.aaSlug || !b?.model || !b?.effort || !b?.family || !Array.isArray(b?.providers)) {
      errors.push('armMap entries need aaSlug, model, effort, family, providers');
      break;
    }
  }
  if (roles) {
    for (const k of ['thinkerAgentIds']) {
      if (k in roles && !Array.isArray(roles[k])) errors.push(`roles.${k} must be an array`);
    }
  }
  if (raw.enforce != null && typeof raw.enforce !== 'boolean') errors.push('enforce must be a boolean');
  return errors;
}

export function resolveConfig(raw = {}) {
  return {
    cliproxy: {
      // Belt and braces behind the validator: a non-allowlisted baseUrl
      // falls back to the default instead of ever carrying the lane key.
      baseUrl: LANE_BASE_URL_ALLOWLIST.includes(raw.cliproxy?.baseUrl) ? raw.cliproxy.baseUrl : DEFAULT_BASE_URL,
      accountsPath: raw.cliproxy?.accountsPath || DEFAULT_ACCOUNTS_PATH,
      laneKeySecretRef: raw.cliproxy?.laneKeySecretRef ?? null,
      cacheTtlSec: raw.cliproxy?.cacheTtlSec ?? 45,
    },
    aa: {
      apiKeySecretRef: raw.aa?.apiKeySecretRef ?? null,
      maxSnapshotAgeHours: raw.aa?.maxSnapshotAgeHours ?? 30,
    },
    armMap: Array.isArray(raw.armMap) && raw.armMap.length > 0 ? raw.armMap : DEFAULT_ARM_MAP,
    roles: {
      thinkerAgentIds: raw.roles?.thinkerAgentIds ?? [],
      thinkerFloorRung: raw.roles?.thinkerFloorRung ?? 2,
      thinkerCeilingRung: raw.roles?.thinkerCeilingRung ?? null,
      doerFloorRung: raw.roles?.doerFloorRung ?? 0,
      doerCeilingRung: raw.roles?.doerCeilingRung ?? null,
    },
    weights: { ...DEFAULT_WEIGHTS, ...(raw.weights ?? {}) },
    pacing: {
      deadband: raw.pacing?.deadband ?? DEFAULT_PACING.deadband,
      cooldownMs: raw.pacing?.rungCooldownMs ?? DEFAULT_PACING.cooldownMs,
      guardHigh: raw.pacing?.guardHighPct ?? DEFAULT_PACING.guardHigh,
      guardRejoin: raw.pacing?.guardRejoinPct ?? DEFAULT_PACING.guardRejoin,
      floorRung: DEFAULT_PACING.floorRung,
      rateDeadbandRel: raw.pacing?.rateDeadbandRel ?? DEFAULT_PACING.rateDeadbandRel,
      rateMinDeadbandPerHour: raw.pacing?.rateMinDeadbandPerHour ?? DEFAULT_PACING.rateMinDeadbandPerHour,
      rateWindowMin: raw.pacing?.rateWindowMin ?? DEFAULT_PACING.rateWindowMin,
      rateMinSpanMin: raw.pacing?.rateMinSpanMin ?? DEFAULT_PACING.rateMinSpanMin,
    },
    concurrency: {
      maxTotal: raw.concurrency?.maxTotal ?? DEFAULT_CONCURRENCY.maxTotal,
      meanRunDurationHours: raw.concurrency?.meanRunDurationHours ?? DEFAULT_CONCURRENCY.meanRunDurationHours,
    },
    contextCaps: { ...DEFAULT_CONTEXT_CAPS, ...(raw.contextCaps ?? {}) },
    // Kill switch for run.model.resolve enforcement. False (default): the
    // hook answers keep and no run is ever changed.
    enforce: raw.enforce === true,
    shadowMaxEntries: raw.shadow?.maxEntries ?? SHADOW_CAPACITY,
    // Anchor for per-run burn when CLIProxy deltas are not yet calibrated
    // for an account (research example value; flagged calibration: weak).
    calibration: {
      referenceArmId: raw.calibration?.referenceArmId ?? 'claude-haiku-5-5',
      referenceBurnPerRunPct: raw.calibration?.referenceBurnPerRunPct ?? 0.0005,
    },
  };
}

// Weekly window length for schedule-error math (the lane reports `used`
// fractions plus reset timestamps; the host owns staleness/live-pull).
const WEEKLY_WINDOW_MS = 7 * 24 * 3600 * 1000;

function windowStartMs(resetsAtMs) {
  if (resetsAtMs == null) return null;
  return resetsAtMs - WEEKLY_WINDOW_MS;
}

export function createModelCapacityPlugin({ clock = Date.now } = {}) {
  let ctx;
  const configured = new Set();
  const recentRuns = new Map(); // companyId -> [{ runId, agentId, model, at }]
  const runEventStats = new Map(); // companyId -> { seen, lastAtMs, lastRunId } (persisted each tick)
  const caches = new Map(); // companyId -> CliproxyCache
  // Live view per company, populated by every tick for the memory-only
  // resolve hook: { atMs, enforce, thinkerAgentIds, roleBands, contextCaps,
  //   accounts: [{ accountId, pointer, headroomPct, remainingKnown,
  //   ladderRungs, burnPerRunPct }] } in reset order.
  const liveViews = new Map();
  // Enforced hook decisions queued in memory, merged into the shadow ring
  // (flagged enforced:true) on the next tick. companyId -> [records].
  const pendingEnforced = new Map();
  const enforceCompanies = new Set(); // companyIds with enforce: true

  const cacheFor = (companyId, ttlSec) => {
    let c = caches.get(companyId);
    if (!c || c.ttlMs !== ttlSec * 1000) {
      c = new CliproxyCache(ttlSec * 1000);
      caches.set(companyId, c);
    }
    return c;
  };

  /**
   * The ONE outbound CLIProxy read: GET {baseUrl}{accountsPath} with the
   * lane key in X-Api-Key. The key is resolved at call time, never stored.
   * Last line of defense: the request re-passes the lane allowlist, so no
   * code path can fetch anywhere else.
   */
  async function cliproxyLaneGet(companyId, config) {
    const laneKey = await ctx.secrets.resolve(config.cliproxy.laneKeySecretRef, { companyId, configPath: 'cliproxy.laneKeySecretRef' });
    const req = buildLaneRequest(config.cliproxy.baseUrl, config.cliproxy.accountsPath);
    assertLaneRequest({ method: req.method, url: req.url, body: null },
      { baseUrl: config.cliproxy.baseUrl, accountsPath: config.cliproxy.accountsPath });
    const res = await ctx.http.fetch(req.url, { method: 'GET', headers: { [LANE_KEY_HEADER]: laneKey } });
    if (res.status === 401 || res.status === 403) throw new Error('cliproxy-access-denied');
    if (res.status < 200 || res.status >= 300) throw new Error(`cliproxy-http-${res.status}`);
    return res.json();
  }

  async function readAccounts(companyId, config, nowMs) {
    const cache = cacheFor(companyId, config.cliproxy.cacheTtlSec);
    const cached = cache.get('accounts', nowMs);
    if (cached) return cached;
    if (!isSecretRef(config.cliproxy.laneKeySecretRef)) {
      return { accounts: [], source: 'no-secret', atMs: nowMs };
    }
    const body = await cliproxyLaneGet(companyId, config);
    const parsed = parseLaneBody(body, nowMs);
    if (!parsed) throw new Error('cliproxy-lane-parse-failed');
    const snapshot = { accounts: parsed.accounts, atMs: nowMs, source: 'cliproxy-lane', observedAtMs: parsed.observedAtMs };
    cache.set('accounts', snapshot, nowMs);
    return snapshot;
  }

  function roleOf(config, agentId) {
    return config.roles.thinkerAgentIds.includes(agentId) ? 'thinker' : 'doer';
  }

  function buildAccountLadders({ accounts, aaSnapshot, config, previousLadders, stateKeys = null }) {
    const keyOf = (account, i) => stateKeys?.[i] ?? accountKey(account);
    const { arms, skipped } = resolveArms(aaSnapshot?.rows ?? [], config.armMap);
    const byArm = new Map(arms.map(a => [a.armId, a]));
    const refRow = byArm.get(config.calibration.referenceArmId)?.row;
    const refCost = typeof refRow?.intelligenceIndexCostPerTask === 'number' ? refRow.intelligenceIndexCostPerTask : null;
    const burnFor = cost => {
      if (cost == null || !(refCost > 0)) return null;
      return config.calibration.referenceBurnPerRunPct * (cost / refCost);
    };
    const ladders = {};
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      // Per-account scoring: quality support and cost profile are the
      // account's own arm set, so one provider's gaps never punish another.
      const served = armsForProvider(arms, account.provider);
      const scored = new Map(computeComposite(served, config.weights).map(s => [s.armId, s]));
      const costs = fillCosts(served.map(a => ({
        armId: a.armId,
        cost: a.row.intelligenceIndexCostPerTask,
        priceIn: a.row.price1mInputTokens,
        priceOut: a.row.price1mOutputTokens,
      })));
      const eligible = served.map(a => ({
        armId: a.armId,
        Q: scored.get(a.armId)?.Q ?? null,
        C: costs.get(a.armId)?.C ?? null,
        coverage: scored.get(a.armId)?.coverage ?? 0,
      }));
      const { rungs, dominated, dropped } = buildLadder(eligible, previousLadders?.[keyOf(account, i)]?.rungs ?? []);
      ladders[keyOf(account, i)] = {
        rungs: rungs.map(r => {
          const arm = byArm.get(r.armId);
          return {
            ...r,
            model: arm.model,
            effort: arm.effort,
            family: arm.family,
            contextWindow: arm.row.contextWindowTokens ?? null,
            costEstimated: costs.get(r.armId)?.estimated ?? false,
          };
        }),
        dominated,
        dropped,
        burnPerRunPct: Object.fromEntries(eligible.map(e => [e.armId, burnFor(costs.get(e.armId)?.C ?? null)])),
      };
    }
    return { ladders, skipped, arms: arms.map(a => a.armId) };
  }

  function accountKey(account) {
    return account.accountId ?? `${account.provider ?? 'unknown'}:x`;
  }

  /**
   * One state key per snapshot entry. Degenerate payloads can repeat an
   * account id across entries (e.g. a shared key fingerprint in
   * `accountKey` while `lane` differs); keying by the raw id would merge
   * their utilization series into ONE history and every account would
   * report the same measured rate. Suffix repeats with the lane name so
   * each entry keeps its OWN weekly.used series. Well-formed payloads
   * (distinct ids) are untouched: keys equal the plain account ids.
   */
  function uniqueAccountKeys(accounts) {
    const counts = new Map();
    return (accounts ?? []).map((account) => {
      const base = accountKey(account);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      return n === 0 ? base : `${base}#${account.lane ?? `dup${n}`}`;
    });
  }

  /**
   * SDK client reads with positional fallback. The SDK contract is object
   * params (`{ issueId, companyId }` / `{ agentId, companyId }`); a host
   * that only honors the older positional form still works via the
   * fallback. Either way the caller gets the entity or a throw -- never a
   * silent null from a shape mismatch.
   */
  async function compatIssueGet(issueId, companyId) {
    try {
      return await ctx.issues.get({ issueId, companyId });
    } catch (first) {
      try {
        return await ctx.issues.get(issueId, companyId);
      } catch {
        throw first;
      }
    }
  }

  async function compatAgentGet(agentId, companyId) {
    try {
      return await ctx.agents.get({ agentId, companyId });
    } catch (first) {
      try {
        return await ctx.agents.get(agentId, companyId);
      } catch {
        throw first;
      }
    }
  }

  /**
   * The actual model a run used. The run.started event carries one when the
   * emitter knew it; otherwise the issue's assignee adapter override
   * (preferred -- it is what the run was told to use), then the agent's
   * adapter config. Reads use the already-declared agents.read /
   * issues.read capabilities. Per-tick caches keep this to one fetch per
   * agent/issue no matter how many runs share them.
   *
   * Returns { model, source, error }: error is null on success, else a
   * stable code naming the failed step ('no-issue-id',
   * 'issue-read-unavailable', 'no-override-on-issue', 'no-agent-id',
   * 'agent-read-unavailable', 'no-model-on-agent'). Raw upstream text is
   * NEVER returned -- it is logged server-side only -- so API responses
   * carry codes, not exception strings.
   */
  async function resolveActualModel(companyId, run, caches) {
    if (run.model) return { model: run.model, source: 'run-event', error: null };
    const notes = [];
    if (run.issueId) {
      try {
        let entry = caches.issues.get(run.issueId);
        if (entry === undefined) {
          const issue = await compatIssueGet(run.issueId, companyId);
          const o = issue?.assigneeAdapterOverrides ?? issue?.assignee_adapter_overrides;
          const m = o?.adapterConfig?.model ?? o?.adapter_config?.model;
          entry = {
            model: typeof m === 'string' && m.length > 0 ? m : null,
            note: issue == null ? 'issue-not-found' : 'no-override-on-issue',
          };
          caches.issues.set(run.issueId, entry);
        }
        if (entry.model) return { model: entry.model, source: 'issue-override', error: null };
        notes.push(entry.note);
      } catch (error) {
        ctx.logger.error('model-capacity: issue read failed', { companyId, error: error?.message ?? String(error) });
        notes.push('issue-read-unavailable');
      }
    } else {
      notes.push('no-issue-id');
    }
    if (run.agentId && run.agentId !== 'unknown') {
      try {
        let entry = caches.agents.get(run.agentId);
        if (entry === undefined) {
          const agent = await compatAgentGet(run.agentId, companyId);
          const found = agent?.adapterConfig?.model ?? agent?.adapter_config?.model;
          entry = {
            model: typeof found === 'string' && found.length > 0 ? found : null,
            note: agent == null ? 'agent-not-found' : 'no-model-on-agent',
          };
          caches.agents.set(run.agentId, entry);
        }
        if (entry.model) return { model: entry.model, source: 'agent-config', error: null };
        notes.push(entry.note);
      } catch (error) {
        ctx.logger.error('model-capacity: agent read failed', { companyId, error: error?.message ?? String(error) });
        notes.push('agent-read-unavailable');
      }
    } else {
      notes.push('no-agent-id');
    }
    return { model: null, source: null, error: notes.join('; ') };
  }

  /**
   * Map a run to an account key: direct provider match first, model-family
   * hint second. Null when neither resolves (counted, never misattributed).
   */
  function accountForRun(run, accounts) {
    const byProvider = new Map();
    for (const a of accounts) {
      const p = (a.provider ?? '').toLowerCase();
      if (p && !byProvider.has(p)) byProvider.set(p, accountKey(a));
    }
    if (run.provider && byProvider.has(run.provider)) return byProvider.get(run.provider);
    const hinted = providerForModelName(run.model);
    if (hinted && byProvider.has(hinted)) return byProvider.get(hinted);
    return null;
  }

  /**
   * Merge in-memory buffered and persisted state-ring runs, newest first,
   * deduped by run id. On a duplicate id the FIRST record keeps its place
   * while null fields (model, provider, agentId, issueId, status) are
   * backfilled from the later duplicate instead of dropping it.
   */
  function mergeRuns(buffered, stored, nowMs, windowMs) {
    const byId = new Map();
    for (const r of [...(buffered ?? []), ...(stored ?? [])]) {
      if (!r || r.runId == null || nowMs - r.at > windowMs) continue;
      const prev = byId.get(r.runId);
      if (!prev) {
        byId.set(r.runId, { ...r });
        continue;
      }
      for (const k of ['model', 'provider', 'agentId', 'issueId']) {
        if ((prev[k] == null || prev[k] === 'unknown') && r[k] != null && r[k] !== 'unknown') prev[k] = r[k];
      }
      // Terminal status wins (a finished event after a started one), but
      // `at` stays the START time: calibration counts runs started in span.
      if ((prev.status == null) && r.status != null) prev.status = r.status;
      if ((r.status === 'finished' || r.status === 'failed') &&
        prev.status !== 'finished' && prev.status !== 'failed') prev.status = r.status;
    }
    return [...byId.values()].sort((a, b) => b.at - a.at);
  }

  async function runShadowTick(companyId, job) {
    const nowMs = clock();
    const raw = await ctx.config.get(companyId);
    const config = resolveConfig(raw);
    const snapshot = await readAccounts(companyId, config, nowMs);
    const aaSnapshot = await ctx.state.get(scopeKey(companyId, AA_KEY));
    const pacingState = (await ctx.state.get(scopeKey(companyId, PACING_KEY))) ?? {};
    const prevLadders = (await ctx.state.get(scopeKey(companyId, LADDER_KEY)))?.ladders ?? {};
    // One state key per snapshot entry (never a merged series): see
    // uniqueAccountKeys. `keyOf` keeps ladders aligned with the same keys.
    const stateKeys = uniqueAccountKeys(snapshot.accounts);
    const { ladders, skipped } = buildAccountLadders({ accounts: snapshot.accounts, aaSnapshot, config, previousLadders: prevLadders, stateKeys });

    const nextPacing = { ...pacingState };
    const rateHistories = (await ctx.state.get(scopeKey(companyId, RATE_KEY))) ?? {};
    const accountViews = [];
    for (let i = 0; i < snapshot.accounts.length; i++) {
      const account = snapshot.accounts[i];
      const key = stateKeys[i];
      const weeklyUsed = account.weekly?.utilization;
      const fiveHourUsed = account.fiveHour?.utilization;
      // resetsAtMs is parsed once in the lane client (ISO, epoch ms, or
      // epoch s); never re-parse the raw shape here.
      const resetAtMs = account.weekly?.resetsAtMs ?? null;
      const remaining = weeklyUsed != null ? Math.max(0, 1 - weeklyUsed) : null;
      // Unknown reset means unknown horizon: null, never a silent 168h.
      // Internal math that needs a finite horizon falls back to 168h
      // separately; the reported required rate stays honest.
      const hoursToReset = resetAtMs != null
        ? Math.max((resetAtMs - nowMs) / 3600000, 0.25)
        : null;
      // Rate inputs: append this reading, then measure over the trailing
      // window. The reading is stamped with the ACCOUNT's own observedAt
      // (each account's series carries its own time, then the body stamp,
      // then the tick time) so a cached payload does not fake movement; an
      // identical (timestamp, value) pair is an exact duplicate and is
      // skipped, everything else accumulates -- so history grows on every
      // tick that carries genuinely new data.
      let history = rateHistories[key] ?? [];
      if (weeklyUsed != null) {
        const readingAtMs = account.signalsAtMs ?? snapshot.observedAtMs ?? nowMs;
        const dup = history.some(p => p.atMs === readingAtMs && p.usedPct === weeklyUsed);
        if (!dup) history = appendUtilReading(history, { atMs: readingAtMs, usedPct: weeklyUsed }, nowMs);
      }
      rateHistories[key] = history;
      const measured = weeklyUsed != null
        ? measuredRatePerHour(history, nowMs, config.pacing.rateWindowMin, config.pacing.rateMinSpanMin)
        : null;
      // Required rate needs no history and no calibration: whenever the
      // remaining fraction and the reset are both known it is a number.
      // Null (unknown) only when an input is missing -- never a 0 that
      // would read as "burn nothing".
      const required = remaining != null && hoursToReset != null
        ? requiredRatePerHour({ remainingPct: remaining, hoursToReset })
        : null;
      const startMs = resetAtMs != null && !Number.isNaN(resetAtMs) ? windowStartMs(resetAtMs) : null;
      const positionError = weeklyUsed != null && startMs != null && resetAtMs != null
        ? scheduleError({ usedPct: weeklyUsed, nowMs, periodStartMs: startMs, periodEndMs: resetAtMs })
        : 0;
      const ceiling = (ladders[key]?.rungs.length ?? 1) - 1;
      const step = stepRateController(nextPacing[key] ?? { pointer: 0, lastMoveAtMs: 0, guardActive: false },
        {
          measuredRatePerHour: measured?.ratePerHour ?? null,
          requiredRatePerHour: required ?? 0,
          positionError,
          fiveHourUsedPct: fiveHourUsed,
        }, nowMs, config.pacing, ceiling);
      nextPacing[key] = { pointer: step.pointer, lastMoveAtMs: step.lastMoveAtMs, guardActive: step.guardActive, rateBasis: step.rateBasis ?? null };
      accountViews.push({
        accountId: key,
        provider: account.provider,
        weeklyUsedPct: weeklyUsed,
        fiveHourUsedPct: fiveHourUsed,
        resetAtMs,
        remainingPct: remaining,
        hoursToReset,
        pointer: step.pointer,
        guardActive: step.guardActive,
        action: step.action,
        reason: step.reason,
        rateBasis: measured ? 'measured' : 'position',
        measuredRatePerHour: measured?.ratePerHour ?? null,
        rateSpanMs: measured?.spanMs ?? null,
        ratePoints: measured?.points ?? 0,
        rateHistoryPoints: history.length,
        requiredRatePerHour: required,
      });
    }
    const ordered = orderAccounts(accountViews.map(a => ({ ...a, remainingPct: a.remainingPct ?? 0 })));

    // Runs feed: agent.run.started events buffered in memory, merged with
    // the persisted run ring in plugin state (no db). Calibration counts
    // runs that started on each account inside the measured span.
    const rateWindowMs = config.pacing.rateWindowMin * 60000;
    const buffered = recentRuns.get(companyId) ?? [];
    const persisted = (await ctx.state.get(scopeKey(companyId, RUNS_KEY))) ?? [];
    const runs = mergeRuns(buffered, persisted, nowMs, rateWindowMs);
    recentRuns.set(companyId, buffered.filter(r => nowMs - r.at < 15 * 60 * 1000).slice(-200));
    await ctx.state.set(scopeKey(companyId, RUNS_KEY), runs.slice(0, RUNS_CAP));
    const runsByAccount = new Map();
    let unmappedRuns = 0;
    for (const run of runs) {
      const key = accountForRun(run, snapshot.accounts);
      if (!key) {
        unmappedRuns += 1;
        continue;
      }
      if (!runsByAccount.has(key)) runsByAccount.set(key, []);
      runsByAccount.get(key).push(run);
    }

    // E_a calibration: weekly-used delta over the measured span divided by
    // runs that started on the account inside that span.
    const runsInSpan = (key, spanMs) => (runsByAccount.get(key) ?? []).filter(r => nowMs - r.at <= spanMs).length;
    const burnOf = key => {
      const b = ladders[key]?.burnPerRunPct ?? {};
      const vals = Object.values(b).filter(v => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const concurrency = computeConcurrencyTarget({
      accounts: ordered.map(a => {
        const view = accountViews.find(v => v.accountId === a.accountId);
        const spanMs = view?.rateSpanMs ?? null;
        let measuredE = null;
        if (spanMs != null && spanMs > 0 && view?.weeklyUsedPct != null) {
          const hist = rateHistories[a.accountId] ?? [];
          const inSpan = hist.filter(p => nowMs - p.atMs <= spanMs);
          if (inSpan.length >= 2) {
            const delta = inSpan[inSpan.length - 1].usedPct - inSpan[0].usedPct;
            const n = runsInSpan(a.accountId, spanMs);
            if (delta > 0 && n > 0) measuredE = delta / n;
          }
        }
        return {
          accountId: a.accountId,
          remainingPct: a.remainingPct ?? 0,
          hoursToReset: a.resetAtMs != null ? Math.max((a.resetAtMs - nowMs) / 3600000, 0.25) : 168,
          burnPerRunPct: burnOf(a.accountId),
          measuredBurnPerRunPct: measuredE,
          runsInWindow: runsInSpan(a.accountId, rateWindowMs),
          guardActive: a.guardActive,
        };
      }),
      meanRunDurationHours: config.concurrency.meanRunDurationHours,
      maxTotal: config.concurrency.maxTotal,
    });

    // Publish the live view the memory-only resolve hook reads. No I/O
    // happens in the hook, so everything it needs is frozen here.
    const viewById = new Map(accountViews.map(v => [v.accountId, v]));
    liveViews.set(companyId, {
      atMs: nowMs,
      enforce: config.enforce === true,
      thinkerAgentIds: config.roles.thinkerAgentIds,
      roleBands: {
        thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
        doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
      },
      contextCaps: config.contextCaps,
      accounts: ordered.map(a => {
        const view = viewById.get(a.accountId);
        const ladder = ladders[a.accountId];
        return {
          accountId: a.accountId,
          pointer: view?.guardActive ? 0 : (view?.pointer ?? 0),
          headroomPct: view?.fiveHourUsedPct != null ? Math.max(0, 1 - view.fiveHourUsedPct) : null,
          remainingKnown: view?.remainingPct != null,
          resetAtMs: view?.resetAtMs ?? null,
          measuredRatePerHour: view?.measuredRatePerHour ?? null,
          requiredRatePerHour: view?.requiredRatePerHour ?? null,
          ladderRungs: groupByRung(ladder?.rungs ?? []),
          burnPerRunPct: ladder?.burnPerRunPct ?? {},
        };
      }),
      rateDeadbandRel: config.pacing.rateDeadbandRel,
    });

    // Shadow decisions for recently started runs (db + event feed).
    const ring = createShadowRing(config.shadowMaxEntries);
    ring.load(await ctx.state.get(scopeKey(companyId, RING_KEY)));
    const recorded = new Set(ring.list(500).map(e => e.runId));
    // Enforced hook decisions since the last tick merge first (flagged
    // enforced:true), so the shadow feed never re-decides the same run.
    for (const pending of pendingEnforced.get(companyId) ?? []) {
      if (!recorded.has(pending.runId)) {
        ring.push(pending);
        recorded.add(pending.runId);
      }
    }
    pendingEnforced.set(companyId, []);
    const candidates = runs.filter(r => nowMs - r.at < 15 * 60 * 1000 && !recorded.has(r.runId)).slice(0, 100);
    const roleBands = {
      thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
      doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
    };
    // Deficit order: hungriest qualified account first, over-burning
    // last, unknown headroom never. Same order the hook uses.
    const selectionOrder = orderAccountsForRun(
      accountViews.map(v => ({
        accountId: v.accountId,
        resetAtMs: v.resetAtMs,
        headroomPct: v.fiveHourUsedPct != null ? Math.max(0, 1 - v.fiveHourUsedPct) : null,
        measuredRatePerHour: v.measuredRatePerHour,
        requiredRatePerHour: v.requiredRatePerHour,
      })),
      { reservePct: 0.05, rateDeadbandRel: config.pacing.rateDeadbandRel },
    );
    let observed = 0;
    const modelCaches = { agents: new Map(), issues: new Map() };
    for (const run of candidates) {
      const role = roleOf(config, run.agentId);
      let decision = null;
      for (const sel of selectionOrder) {
        const view = viewById.get(sel.accountId);
        const ladder = ladders[sel.accountId];
        if (!view || !ladder || view.remainingPct == null) continue;
        const d = decide({
          runId: run.runId,
          agentId: run.agentId,
          role,
          ladderRungs: groupByRung(ladder.rungs),
          pointer: view.pointer,
          retryCount: 0,
          failureClass: 'none',
          contextTokens: null,
          fiveHourHeadroomPct: sel.headroomPct,
          burnPerRunPct: ladder.burnPerRunPct,
          reservePct: 0.05,
          accountId: sel.accountId,
          roleBands,
          contextCaps: config.contextCaps,
        });
        if (d.kind === 'decide') {
          decision = d;
          break;
        }
      }
      if (decision) {
        const wouldModel = `${decision.model}(${decision.effort ?? 'default'})`;
        const actual = await resolveActualModel(companyId, run, modelCaches);
        const actualModel = actual.model ?? 'unknown';
        ring.push({
          runId: run.runId,
          agentId: run.agentId,
          actualModel,
          actualModelSource: actual.source,
          // Why the actual model is unknown (codes only, never upstream
          // text); null when the actual model resolved.
          actualModelError: actual.error,
          wouldModel,
          // Did shadow agree with reality? Null while the actual model is
          // still unknown; true/false once known.
          modelMatch: actual.model == null ? null : (actual.model === decision.model || actual.model === wouldModel),
          account: decision.accountId,
          accountId: decision.accountId,
          rung: decision.rung,
          reason: decision.reason,
          at: nowMs,
        });
        observed += 1;
      }
    }

    const evtStats = runEventStats.get(companyId) ?? { seen: 0, lastAtMs: null, lastRunId: null };
    const persistedEvt = (await ctx.state.get(scopeKey(companyId, RUNEVT_KEY))) ?? { seen: 0, lastAtMs: null, lastRunId: null };
    const mergedEvt = {
      seen: (persistedEvt.seen ?? 0) + (evtStats.seen ?? 0),
      lastAtMs: evtStats.lastAtMs ?? persistedEvt.lastAtMs ?? null,
      lastRunId: evtStats.lastRunId ?? persistedEvt.lastRunId ?? null,
    };
    runEventStats.set(companyId, { seen: 0, lastAtMs: mergedEvt.lastAtMs, lastRunId: mergedEvt.lastRunId });

    await ctx.state.set(scopeKey(companyId, PACING_KEY), nextPacing);
    await ctx.state.set(scopeKey(companyId, RATE_KEY), rateHistories);
    await ctx.state.set(scopeKey(companyId, RING_KEY), ring.toJSON());
    await ctx.state.set(scopeKey(companyId, RUNEVT_KEY), mergedEvt);
    await ctx.state.set(scopeKey(companyId, CAPACITY_KEY), {
      atMs: nowMs,
      target: concurrency.target,
      maxTotal: config.concurrency.maxTotal,
      calibration: concurrency.calibration,
      perAccount: concurrency.perAccount,
      accounts: accountViews,
      skippedArms: skipped,
      runsObserved: runs.length,
      runsCandidates: candidates.length,
      runsSource: 'events',
      unmappedRuns,
      runEventsSeen: mergedEvt.seen,
      lastRunEventAtMs: mergedEvt.lastAtMs,
    });
    await ctx.state.set(scopeKey(companyId, LADDER_KEY), { atMs: nowMs, ladders });
    ctx.logger.info('model-capacity: shadow tick', {
      companyId, accounts: accountViews.length, target: concurrency.target,
      calibration: concurrency.calibration, observed, runs: runs.length, runsSource: 'events',
    });
    return { status: 'shadow', observed };
  }

  function groupByRung(rungs) {
    const byRung = new Map();
    for (const r of rungs) {
      if (!byRung.has(r.rung)) byRung.set(r.rung, { rung: r.rung, arms: [] });
      byRung.get(r.rung).arms.push(r);
    }
    return [...byRung.values()].sort((a, b) => a.rung - b.rung);
  }

  async function runAaRefresh(companyId) {
    const nowIso = new Date(clock()).toISOString();
    const raw = await ctx.config.get(companyId);
    const config = resolveConfig(raw);
    const previous = (await ctx.state.get(scopeKey(companyId, AA_KEY))) ?? { fetchedAt: null, rows: [], duplicateSlugs: [] };
    if (!isSecretRef(config.aa.apiKeySecretRef)) {
      ctx.logger.info('model-capacity: AA refresh skipped (no key configured)', { companyId });
      return { status: 'skipped', reason: 'no-aa-key' };
    }
    const apiKey = await ctx.secrets.resolve(config.aa.apiKeySecretRef, { companyId, configPath: 'aa.apiKeySecretRef' });
    const [fetched, board] = await Promise.all([
      fetchAaFreeList({ http: ctx.http, apiKey }),
      fetchAaLeaderboard({ http: ctx.http }),
    ]);
    if (!fetched.ok || !fetched.text) {
      await ctx.state.set(scopeKey(companyId, AA_KEY), { ...previous, lastAttemptAt: nowIso, lastError: fetched.error ?? 'aa-fetch-failed' });
      ctx.logger.error('model-capacity: AA refresh failed; keeping prior snapshot', { companyId, error: fetched.error });
      return { status: 'error', error: fetched.error };
    }
    const parsed = parseAaFreeList(fetched.text);
    if (!parsed) {
      await ctx.state.set(scopeKey(companyId, AA_KEY), { ...previous, lastAttemptAt: nowIso, lastError: 'aa-parse-failed' });
      ctx.logger.error('model-capacity: AA parse failed; keeping prior snapshot', { companyId });
      return { status: 'error', error: 'aa-parse-failed' };
    }
    // Second source is best-effort: a leaderboard failure degrades to
    // API-only rows, never to dropping the fresh API snapshot.
    let leaderboardRows = [];
    let leaderboardError = null;
    if (!board.ok || !board.html) {
      leaderboardError = board.error ?? 'aa-leaderboard-fetch-failed';
    } else {
      const boardParsed = parseAaLeaderboardHtml(board.html);
      if (!boardParsed) {
        leaderboardError = 'aa-leaderboard-parse-failed';
      } else {
        leaderboardRows = boardParsed;
      }
    }
    const merged = mergeAaRows(parsed.rows, leaderboardRows);
    await ctx.state.set(scopeKey(companyId, AA_KEY), {
      fetchedAt: nowIso,
      rows: merged.rows,
      duplicateSlugs: merged.duplicateSlugs,
      leaderboardSlugs: merged.leaderboardSlugs,
      leaderboardAt: leaderboardRows.length > 0 ? nowIso : (previous.leaderboardAt ?? null),
      lastAttemptAt: nowIso,
      lastError: null,
      lastLeaderboardError: leaderboardError,
    });
    ctx.logger.info('model-capacity: AA snapshot refreshed', {
      companyId, rows: merged.rows.length, leaderboardRows: leaderboardRows.length, leaderboardError,
    });
    return { status: 'ok', rows: merged.rows.length, leaderboardRows: leaderboardRows.length, leaderboardError };
  }

  return {
    multiCompanyConfig: true,

    async setup(context) {
      ctx = context;
      ctx.jobs.register('aa-refresh', async job => {
        const results = await Promise.allSettled([...configured].sort().map(companyId => runAaRefresh(companyId)));
        if (results.some(r => r.status === 'rejected')) throw new Error('aa-refresh-failed');
      });
      ctx.jobs.register('shadow-tick', async job => {
        const results = await Promise.allSettled([...configured].sort().map(companyId =>
          runShadowTick(companyId, job).catch(error => {
            ctx.logger.error('model-capacity: shadow tick failed', { companyId, error: error?.message ?? String(error) });
            throw error;
          })));
        if (results.some(r => r.status === 'rejected')) throw new Error('shadow-tick-failed');
      });
      // Run facts come from agent.run.* events only (started, finished,
      // failed): the sole run feed since the db grant was removed. Events
      // WITHOUT a companyId are ignored outright -- fanning a company-less
      // event out to every configured company would misattribute runs.
      const onRunEvent = (status) => async event => {
        const companyId = event?.companyId;
        if (typeof companyId !== 'string' || companyId.length === 0) return;
        if (!configured.has(companyId)) return;
        // Tolerant extraction: accept every known placement and never drop
        // an event for a missing id.
        const p = event?.payload && typeof event.payload === 'object' ? event.payload : {};
        const run = p.run && typeof p.run === 'object' ? p.run : {};
        const entry = {
          runId: String(event?.entityId ?? p.runId ?? run.id ?? p.id ?? 'unknown'),
          agentId: String(p.agentId ?? run.agentId ?? event?.actorId ?? 'unknown'),
          model: p.model ?? run.model ?? null,
          provider: typeof (p.provider ?? run.provider) === 'string' ? String(p.provider ?? run.provider).toLowerCase() : null,
          issueId: p.issueId ?? run.issueId ?? p.issue_id ?? null,
          status,
          at: Date.parse(event?.occurredAt ?? '') || clock(),
        };
        const list = recentRuns.get(companyId) ?? [];
        list.push(entry);
        recentRuns.set(companyId, list.slice(-200));
        const st = runEventStats.get(companyId) ?? { seen: 0, lastAtMs: null, lastRunId: null };
        st.seen += 1;
        st.lastAtMs = entry.at;
        st.lastRunId = entry.runId;
        runEventStats.set(companyId, st);
      };
      ctx.events.on('agent.run.started', onRunEvent('running'));
      ctx.events.on('agent.run.finished', onRunEvent('finished'));
      ctx.events.on('agent.run.failed', onRunEvent('failed'));
    },

    async onConfigChanged(raw, context) {
      const companyId = context?.companyId;
      if (typeof companyId !== 'string' || companyId.length === 0) throw new Error('company-context-required');
      const errors = validateConfigShape(raw);
      if (errors.length > 0) {
        ctx.logger.error('model-capacity: config rejected', { companyId, errors });
        throw new Error('invalid-config');
      }
      configured.add(companyId);
      if (raw?.enforce === true) enforceCompanies.add(companyId);
      else enforceCompanies.delete(companyId);
    },

    async onValidateConfig(raw) {
      const errors = validateConfigShape(raw);
      return errors.length === 0 ? { ok: true } : { ok: false, errors };
    },

    async onHealth() {
      const enforcing = [...enforceCompanies].filter(c => configured.has(c)).length;
      return {
        status: configured.size === 0 ? 'degraded' : 'ok',
        message: enforcing > 0
          ? `Enforcing run models for ${enforcing} of ${configured.size} companies; the rest stay shadow.`
          : 'Shadow only; no runs are changed.',
        details: { configuredCompanies: configured.size, enforcingCompanies: enforcing, manifest: manifest.id },
      };
    },

    async onApiRequest(input) {
      const companyId = input.companyId;
      if (!configured.has(companyId)) return { status: 404, body: { error: 'company-not-configured' } };
      if (input.routeKey === 'capacity') {
        return { status: 200, body: (await ctx.state.get(scopeKey(companyId, CAPACITY_KEY))) ?? { target: null } };
      }
      if (input.routeKey === 'shadow') {
        const ring = createShadowRing();
        ring.load(await ctx.state.get(scopeKey(companyId, RING_KEY)));
        const limit = Math.min(Number(input.query?.limit ?? 100) || 100, 500);
        return { status: 200, body: { entries: ring.list(limit), size: ring.size() } };
      }
      if (input.routeKey === 'ladder') {
        return { status: 200, body: (await ctx.state.get(scopeKey(companyId, LADDER_KEY))) ?? { ladders: {} } };
      }
      if (input.routeKey === 'caps') {
        const cap = (await ctx.state.get(scopeKey(companyId, CAPACITY_KEY))) ?? {};
        const atMs = cap.atMs ?? null;
        const calibration = cap.calibration ?? 'weak';
        const target = cap.target ?? null;
        // Weak calibration means no target at all: no caps, never zeros
        // masquerading as a recommendation.
        if (target == null || calibration === 'weak') {
          return { status: 200, body: { atMs, calibration, target: null, agents: [] } };
        }
        // Agents with queued/ready work: assigned non-terminal issues
        // (todo + in_progress), grouped by assignee and weighted by count.
        // issues.read is already declared; any denial degrades to no
        // recommendation instead of failing the request.
        let counts;
        try {
          const lists = await Promise.all([
            ctx.issues.list({ companyId, status: 'todo' }),
            ctx.issues.list({ companyId, status: 'in_progress' }),
          ]);
          counts = new Map();
          const seen = new Set();
          for (const issue of lists.flat()) {
            if (!issue || typeof issue !== 'object') continue;
            const id = issue.id ?? issue.issueId;
            if (id != null) {
              if (seen.has(id)) continue;
              seen.add(id);
            }
            const status = String(issue.status ?? '').toLowerCase();
            if (status === 'done' || status === 'blocked' || status === 'cancelled') continue;
            const agentId = issue.assigneeAgentId ?? issue.assignee_agent_id ?? null;
            if (typeof agentId === 'string' && agentId.length > 0) {
              counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
            }
          }
        } catch (error) {
          // Sanitized: callers get a stable code, never upstream text.
          // Details go server-side only.
          ctx.logger.error('model-capacity: caps issues read failed', { companyId, error: error?.message ?? String(error) });
          return { status: 200, body: { atMs, calibration, target, agents: [], capsError: 'issues-unavailable' } };
        }
        const agents = distributeWeightedCaps(
          target,
          [...counts].map(([agentId, queued]) => ({ agentId, queued })),
          cap.maxTotal ?? 75,
        );
        return { status: 200, body: { atMs, calibration, target, agents } };
      }
      return { status: 404, body: { error: 'unknown-route' } };
    },

    /**
     * v0.2.1 enforcement hook. MEMORY-ONLY: it reads the in-memory live view
     * the last tick published and performs zero I/O -- no config, state,
     * network, or db reads -- so it always answers inside the host's 1.5s
     * RPC deadline. Fail-safe order: unknown company, enforce off, human
     * operator override, and stale/freshness gaps all answer `keep` (the
     * agent default runs). Only when no account has headroom does it
     * `defer` (~60s retry). Every enforced decision is queued in memory and
     * merged into the shadow ring with `enforced:true` on the next tick.
     *
     * Note: ResolveRunModelParams carries no retry/context signals, so each
     * call is decided fresh (retryCount 0, failureClass none, contextTokens
     * null) -- determinism comes from the cached tick state, which is
     * identical for identical params until the next tick moves it.
     */
    async onResolveRunModel(params) {
      const live = params?.companyId ? liveViews.get(params.companyId) : null;
      if (!live || live.enforce !== true) return { kind: 'keep' };
      if (typeof params?.issueOverrideModel === 'string' && params.issueOverrideModel.length > 0) {
        return { kind: 'keep' };
      }
      if (!Number.isFinite(live.atMs) || clock() - live.atMs > 120000) return { kind: 'keep' };
      const role = Array.isArray(live.thinkerAgentIds) && live.thinkerAgentIds.includes(params.agentId) ? 'thinker' : 'doer';
      // Same deficit order as the shadow tick: hungriest qualified first,
      // over-burning last. Unknown headroom (null weekly or 5h) never
      // qualifies -- without a 5h signal the hook cannot verify headroom.
      const order = orderAccountsForRun(live.accounts, { reservePct: 0.05, rateDeadbandRel: live.rateDeadbandRel ?? 0.15 });
      for (const view of order) {
        if (!view.remainingKnown || view.ladderRungs.length === 0) continue;
        const d = decide({
          runId: params.runId,
          agentId: params.agentId,
          role,
          ladderRungs: view.ladderRungs,
          pointer: view.pointer,
          retryCount: 0,
          failureClass: 'none',
          contextTokens: null,
          fiveHourHeadroomPct: view.headroomPct,
          burnPerRunPct: view.burnPerRunPct,
          reservePct: 0.05,
          accountId: view.accountId,
          roleBands: live.roleBands,
          contextCaps: live.contextCaps,
        });
        if (d.kind === 'decide') {
          const queue = pendingEnforced.get(params.companyId) ?? [];
          queue.push({
            runId: String(params.runId ?? 'unknown'),
            agentId: String(params.agentId ?? 'unknown'),
            actualModel: 'unknown',
            actualModelSource: null,
            wouldModel: `${d.model}(${d.effort ?? 'default'})`,
            modelMatch: null,
            account: d.accountId,
            accountId: d.accountId,
            rung: d.rung,
            reason: d.reason,
            at: clock(),
            enforced: true,
          });
          pendingEnforced.set(params.companyId, queue.slice(-200));
          return {
            kind: 'decide',
            decisionId: d.decisionId,
            model: d.model,
            effort: d.effort,
            env: d.env,
            source: d.source,
            reason: d.reason,
          };
        }
      }
      return { kind: 'defer', retryAfterMs: 60000, reason: 'no account has headroom right now' };
    },
  };
}
