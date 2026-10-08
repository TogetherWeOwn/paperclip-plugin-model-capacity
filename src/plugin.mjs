/**
 * Model-capacity plugin worker wiring (I/O at the edges; math in modules).
 *
 * v0.1.3 = SHADOW. The worker refreshes AA data daily, reads CLIProxy burn
 * from the host-published lane endpoint (one GET, short in-memory cache),
 * steps per-account pacing pointers, and records what it WOULD have
 * decided for recently started runs. It never changes a run:
 * `onResolveRunModel` is implemented for the v0.2.0 variant but the shadow
 * manifest holds no `run.model.resolve` capability, so the host never
 * calls it yet. The resolve path itself is cache-only by construction --
 * it never fetches remote data.
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
import { computeConcurrencyTarget, distributeCaps, DEFAULT_CONCURRENCY } from './concurrency.mjs';
import { createShadowRing, SHADOW_CAPACITY } from './shadow.mjs';
import { manifest } from './manifest.mjs';

const NS = 'model-capacity';
const AA_KEY = 'aa-snapshot-v1';
const PACING_KEY = 'pacing-v1';
const RING_KEY = 'shadow-ring-v1';
const CAPACITY_KEY = 'capacity-v1';
const LADDER_KEY = 'ladder-v1';
const RATE_KEY = 'rate-history-v1';
const RUNEVT_KEY = 'run-events-v1';

/** Recent heartbeat runs for one company (db backfill + event buffer). */
const RUNS_SQL = `select id, agent_id, status, started_at, finished_at,
       coalesce(usage_json->>'model','') as model,
       coalesce(usage_json->>'provider','') as provider
  from heartbeat_runs
 where company_id = $1
   and started_at > now() - ($2 || ' minutes')::interval
 order by started_at desc
 limit 500`;

const scopeKey = (companyId, stateKey) => ({ scopeKind: 'company', scopeId: companyId, namespace: NS, stateKey });

function isSecretRef(v) {
  return v != null && typeof v === 'object' && v.type === 'secret_ref' && typeof v.secretId === 'string';
}

export function validateConfigShape(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['config must be an object'];
  const { cliproxy, aa, weights, pacing, concurrency, roles, armMap } = raw;
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
  return errors;
}

export function resolveConfig(raw = {}) {
  return {
    cliproxy: {
      baseUrl: raw.cliproxy?.baseUrl || DEFAULT_BASE_URL,
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
  const snapshots = new Map(); // companyId -> { atMs, accounts }
  const recentRuns = new Map(); // companyId -> [{ runId, agentId, model, at }]
  const runEventStats = new Map(); // companyId -> { seen, lastAtMs, lastRunId } (persisted each tick)
  const caches = new Map(); // companyId -> CliproxyCache

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
    const snapshot = { accounts: parsed.accounts, atMs: nowMs, source: 'cliproxy-lane' };
    cache.set('accounts', snapshot, nowMs);
    snapshots.set(companyId, snapshot);
    return snapshot;
  }

  function roleOf(config, agentId) {
    return config.roles.thinkerAgentIds.includes(agentId) ? 'thinker' : 'doer';
  }

  function buildAccountLadders({ accounts, aaSnapshot, config, previousLadders }) {
    const { arms, skipped } = resolveArms(aaSnapshot?.rows ?? [], config.armMap);
    const byArm = new Map(arms.map(a => [a.armId, a]));
    const refRow = byArm.get(config.calibration.referenceArmId)?.row;
    const refCost = typeof refRow?.intelligenceIndexCostPerTask === 'number' ? refRow.intelligenceIndexCostPerTask : null;
    const burnFor = cost => {
      if (cost == null || !(refCost > 0)) return null;
      return config.calibration.referenceBurnPerRunPct * (cost / refCost);
    };
    const ladders = {};
    for (const account of accounts) {
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
      const { rungs, dominated, dropped } = buildLadder(eligible, previousLadders?.[accountKey(account)]?.rungs ?? []);
      ladders[accountKey(account)] = {
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

  function normalizeRunRow(row) {
    const atMs = Date.parse(row?.started_at ?? '');
    if (!Number.isFinite(atMs)) return null;
    return {
      runId: String(row?.id ?? 'unknown'),
      agentId: row?.agent_id ? String(row.agent_id) : 'unknown',
      model: row?.model || null,
      provider: row?.provider ? String(row.provider).toLowerCase() : null,
      status: row?.status ?? null,
      at: atMs,
    };
  }

  /**
   * Heartbeat-run backfill: runs started in the trailing window, newest
   * first. Returns { runs, dbError }. Restricted SELECT on a whitelisted
   * core table; any denial degrades to the event buffer instead of
   * failing the tick.
   */
  async function readRecentRuns(companyId, windowMin, nowMs) {
    try {
      const rows = await ctx.db.query(RUNS_SQL, [companyId, String(windowMin)]);
      const runs = (rows ?? []).map(normalizeRunRow).filter(Boolean).filter(r => r.at <= nowMs + 60000);
      return { runs, dbError: null };
    } catch (error) {
      return { runs: [], dbError: error?.message ?? String(error) };
    }
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
   * Merge event-buffered and db runs, newest first, deduped by run id.
   * The event buffer usually wins the race but carries no model; the db
   * row does. So on a duplicate id the FIRST record keeps its place while
   * null fields (model, provider, agentId) are backfilled from the later
   * duplicate instead of dropping it -- otherwise actualModel stays
   * 'unknown' forever on runs the event feed saw first.
   */
  function mergeRuns(buffered, dbRuns, nowMs, windowMs) {
    const byId = new Map();
    for (const r of [...(buffered ?? []), ...(dbRuns ?? [])]) {
      if (!r || r.runId == null || nowMs - r.at > windowMs) continue;
      const prev = byId.get(r.runId);
      if (!prev) {
        byId.set(r.runId, { ...r });
        continue;
      }
      for (const k of ['model', 'provider', 'agentId']) {
        if ((prev[k] == null || prev[k] === 'unknown') && r[k] != null && r[k] !== 'unknown') prev[k] = r[k];
      }
      if ((prev.status == null) && r.status != null) prev.status = r.status;
      if (r.at > prev.at) prev.at = r.at;
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
    const { ladders, skipped } = buildAccountLadders({ accounts: snapshot.accounts, aaSnapshot, config, previousLadders: prevLadders });

    const nextPacing = { ...pacingState };
    const rateHistories = (await ctx.state.get(scopeKey(companyId, RATE_KEY))) ?? {};
    const accountViews = [];
    for (const account of snapshot.accounts) {
      const key = accountKey(account);
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
      // Rate inputs: append this reading, then measure over the trailing window.
      let history = rateHistories[key] ?? [];
      if (weeklyUsed != null) history = appendUtilReading(history, { atMs: nowMs, usedPct: weeklyUsed }, nowMs);
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
      nextPacing[key] = { pointer: step.pointer, lastMoveAtMs: step.lastMoveAtMs, guardActive: step.guardActive };
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
        requiredRatePerHour: required,
      });
    }
    const ordered = orderAccounts(accountViews.map(a => ({ ...a, remainingPct: a.remainingPct ?? 0 })));

    // Runs feed: heartbeat backfill (primary) merged with the event buffer.
    // The event subscription alone left the ring empty live, so the tick no
    // longer depends on delivery: db rows are authoritative, events top up.
    const rateWindowMs = config.pacing.rateWindowMin * 60000;
    const { runs: dbRuns, dbError } = await readRecentRuns(companyId, config.pacing.rateWindowMin, nowMs);
    const buffered = recentRuns.get(companyId) ?? [];
    const runs = mergeRuns(buffered, dbRuns, nowMs, rateWindowMs);
    recentRuns.set(companyId, buffered.filter(r => nowMs - r.at < 15 * 60 * 1000).slice(-200));
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

    // Shadow decisions for recently started runs (db + event feed).
    const ring = createShadowRing(config.shadowMaxEntries);
    ring.load(await ctx.state.get(scopeKey(companyId, RING_KEY)));
    const recorded = new Set(ring.list(500).map(e => e.runId));
    const candidates = runs.filter(r => nowMs - r.at < 15 * 60 * 1000 && !recorded.has(r.runId)).slice(0, 100);
    const roleBands = {
      thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
      doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
    };
    let observed = 0;
    for (const run of candidates) {
      const role = roleOf(config, run.agentId);
      let decision = null;
      for (const view of ordered) {
        const ladder = ladders[view.accountId];
        if (!ladder || view.remainingPct == null) continue;
        const headroom = view.fiveHourUsedPct != null ? Math.max(0, 1 - view.fiveHourUsedPct) : null;
        const d = decide({
          runId: run.runId,
          agentId: run.agentId,
          role,
          ladderRungs: groupByRung(ladder.rungs),
          pointer: view.pointer,
          retryCount: 0,
          failureClass: 'none',
          contextTokens: null,
          fiveHourHeadroomPct: headroom,
          burnPerRunPct: ladder.burnPerRunPct,
          reservePct: 0.05,
          accountId: view.accountId,
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
        const actualModel = run.model ?? 'unknown';
        ring.push({
          runId: run.runId,
          agentId: run.agentId,
          actualModel,
          wouldModel,
          // Did shadow agree with reality? Null while the actual model is
          // still unknown (events-only feed); true/false once known.
          modelMatch: actualModel === 'unknown' ? null : (actualModel === decision.model || actualModel === wouldModel),
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
      calibration: concurrency.calibration,
      perAccount: concurrency.perAccount,
      accounts: accountViews,
      skippedArms: skipped,
      runsObserved: runs.length,
      runsCandidates: candidates.length,
      runsSource: dbError ? 'events-only' : (buffered.length > 0 ? 'db+events' : 'db-only'),
      runsDbError: dbError,
      unmappedRuns,
      runEventsSeen: mergedEvt.seen,
      lastRunEventAtMs: mergedEvt.lastAtMs,
    });
    await ctx.state.set(scopeKey(companyId, LADDER_KEY), { atMs: nowMs, ladders });
    ctx.logger.info('model-capacity: shadow tick', {
      companyId, accounts: accountViews.length, target: concurrency.target,
      calibration: concurrency.calibration, observed, runs: runs.length, runsSource: dbError ? 'events-only' : 'db',
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
      ctx.events.on('agent.run.started', async event => {
        // Tolerant extraction: the live ring stayed empty on the strict
        // shape, so accept every known placement and never drop an event
        // for a missing id. The heartbeat backfill covers delivery gaps;
        // events are the fast path.
        const p = event?.payload && typeof event.payload === 'object' ? event.payload : {};
        const run = p.run && typeof p.run === 'object' ? p.run : {};
        const entry = {
          runId: String(event?.entityId ?? p.runId ?? run.id ?? p.id ?? 'unknown'),
          agentId: String(p.agentId ?? run.agentId ?? event?.actorId ?? 'unknown'),
          model: p.model ?? run.model ?? null,
          provider: typeof (p.provider ?? run.provider) === 'string' ? String(p.provider ?? run.provider).toLowerCase() : null,
          at: Date.parse(event?.occurredAt ?? '') || clock(),
        };
        const targets = event?.companyId
          ? [event.companyId]
          : [...configured].sort();
        for (const companyId of targets) {
          if (!configured.has(companyId)) continue;
          const list = recentRuns.get(companyId) ?? [];
          list.push(entry);
          recentRuns.set(companyId, list.slice(-200));
          const st = runEventStats.get(companyId) ?? { seen: 0, lastAtMs: null, lastRunId: null };
          st.seen += 1;
          st.lastAtMs = entry.at;
          st.lastRunId = entry.runId;
          runEventStats.set(companyId, st);
        }
      });
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
    },

    async onValidateConfig(raw) {
      const errors = validateConfigShape(raw);
      return errors.length === 0 ? { ok: true } : { ok: false, errors };
    },

    async onHealth() {
      return {
        status: configured.size === 0 ? 'degraded' : 'ok',
        message: 'Shadow only; no runs are changed.',
        details: { configuredCompanies: configured.size, manifest: manifest.id },
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
      return { status: 404, body: { error: 'unknown-route' } };
    },

    /**
     * Implemented for the v0.2.0 enforcement variant. Cache-only: it reads
     * the in-memory CLIProxy snapshot refreshed by shadow-tick and the
     * stored AA snapshot, and never fetches remote data on this path
     * (past the host deadline the run defers). Fail-safe: with no fresh
     * data it answers `keep` so the agent default runs.
     */
    async onResolveRunModel(params) {
      const companyId = params.companyId;
      const snapshot = snapshots.get(companyId);
      if (!snapshot || clock() - snapshot.atMs > 120000) return { kind: 'keep' };
      const raw = await ctx.config.get(companyId).catch(() => null);
      const config = resolveConfig(raw ?? {});
      const aaSnapshot = await ctx.state.get(scopeKey(companyId, AA_KEY)).catch(() => null);
      if (!aaSnapshot?.rows?.length) return { kind: 'keep' };
      const pacingState = (await ctx.state.get(scopeKey(companyId, PACING_KEY)).catch(() => null)) ?? {};
      const prevLadders = (await ctx.state.get(scopeKey(companyId, LADDER_KEY)).catch(() => null))?.ladders ?? {};
      const { ladders } = buildAccountLadders({ accounts: snapshot.accounts, aaSnapshot, config, previousLadders: prevLadders });
      const views = snapshot.accounts.map(a => {
        const key = accountKey(a);
        const st = pacingState[key] ?? { pointer: 0 };
        return {
          accountId: key,
          resetAtMs: a.weekly?.resetsAtMs ?? null,
          remainingPct: a.weekly?.utilization != null ? Math.max(0, 1 - a.weekly.utilization) : 0,
          fiveHourUsedPct: a.fiveHour?.utilization ?? null,
          pointer: st.guardActive ? 0 : st.pointer ?? 0,
        };
      });
      const role = roleOf(config, params.agentId);
      const roleBands = {
        thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
        doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
      };
      for (const view of orderAccounts(views)) {
        const ladder = ladders[view.accountId];
        if (!ladder) continue;
        const headroom = view.fiveHourUsedPct != null ? Math.max(0, 1 - view.fiveHourUsedPct) : null;
        const d = decide({
          runId: params.runId,
          agentId: params.agentId,
          role,
          ladderRungs: groupByRung(ladder.rungs),
          pointer: view.pointer,
          retryCount: 0,
          failureClass: 'none',
          contextTokens: null,
          fiveHourHeadroomPct: headroom,
          burnPerRunPct: ladder.burnPerRunPct,
          reservePct: 0.05,
          accountId: view.accountId,
          roleBands,
          contextCaps: config.contextCaps,
        });
        if (d.kind === 'decide') return d;
      }
      return { kind: 'defer', retryAfterMs: 20000, reason: 'no account has headroom right now' };
    },
  };
}
