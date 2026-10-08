/**
 * Model-capacity plugin worker wiring (I/O at the edges; math in modules).
 *
 * v0.1.0 = SHADOW. The worker refreshes AA data daily, reads CLIProxy on
 * demand with a short in-memory cache, steps per-account pacing pointers,
 * and records what it WOULD have decided for recently started runs. It
 * never changes a run: `onResolveRunModel` is implemented for the v0.2.0
 * variant but the shadow manifest holds no `run.model.resolve`
 * capability, so the host never calls it yet. The resolve path itself is
 * cache-only by construction -- it never fetches remote data.
 */

import {
  DEFAULT_BASE_URL,
  buildAuthFilesRequest,
  buildApiCallRequest,
  assertAllowedRequest,
  parseAuthFile,
  isStale,
  parseAnthropicUsageBody,
  parseCodexWhamBody,
  CliproxyCache,
  FIVE_HOUR_SECONDS,
  WEEK_SECONDS,
} from './cliproxy.mjs';
import { fetchAaFreeList, parseAaFreeList } from './aa.mjs';
import { DEFAULT_ARM_MAP, resolveArms, armsForProvider } from './arms.mjs';
import { computeComposite, DEFAULT_WEIGHTS } from './quality.mjs';
import { buildLadder } from './ladder.mjs';
import { scheduleError, stepController, orderAccounts, DEFAULT_PACING } from './pacing.mjs';
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

const scopeKey = (companyId, stateKey) => ({ scopeKind: 'company', scopeId: companyId, namespace: NS, stateKey });

function isSecretRef(v) {
  return v != null && typeof v === 'object' && v.type === 'secret_ref' && typeof v.secretId === 'string';
}

export function validateConfigShape(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['config must be an object'];
  const { cliproxy, aa, weights, pacing, concurrency, roles, armMap } = raw;
  if (cliproxy?.managementKeySecretRef != null && !isSecretRef(cliproxy.managementKeySecretRef)) {
    errors.push('cliproxy.managementKeySecretRef must be a secret_ref object');
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
      managementKeySecretRef: raw.cliproxy?.managementKeySecretRef ?? null,
      staleAfterSec: raw.cliproxy?.staleAfterSec ?? 300,
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

const WINDOW_SECONDS = { fiveHour: FIVE_HOUR_SECONDS, weekly: WEEK_SECONDS };

function windowStartMs(resetsAtMs, windowName) {
  if (resetsAtMs == null) return null;
  return resetsAtMs - (WINDOW_SECONDS[windowName] ?? WEEK_SECONDS) * 1000;
}

export function createModelCapacityPlugin({ clock = Date.now } = {}) {
  let ctx;
  const configured = new Set();
  const snapshots = new Map(); // companyId -> { atMs, accounts }
  const recentRuns = new Map(); // companyId -> [{ runId, agentId, model, at }]
  const caches = new Map(); // companyId -> CliproxyCache

  const cacheFor = (companyId, ttlSec) => {
    let c = caches.get(companyId);
    if (!c || c.ttlMs !== ttlSec * 1000) {
      c = new CliproxyCache(ttlSec * 1000);
      caches.set(companyId, c);
    }
    return c;
  };

  async function cliproxyGet(companyId, config, path, body) {
    const key = await ctx.secrets.resolve(config.cliproxy.managementKeySecretRef, { companyId, configPath: 'cliproxy.managementKeySecretRef' });
    const url = `${config.cliproxy.baseUrl}${path}`;
    const method = body == null ? 'GET' : 'POST';
    // Last line of defense: every outbound CLIProxy call re-passes the
    // allowlist, so no code path can reach a reset-consuming endpoint.
    assertAllowedRequest({ method, url, body });
    const init = body == null
      ? { method, headers: { Authorization: `Bearer ${key}` } }
      : { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await ctx.http.fetch(url, init);
    if (res.status === 401 || res.status === 403) throw new Error('cliproxy-access-denied');
    if (res.status < 200 || res.status >= 300) throw new Error(`cliproxy-http-${res.status}`);
    return res.json();
  }

  async function readAccounts(companyId, config, nowMs) {
    const cache = cacheFor(companyId, config.cliproxy.cacheTtlSec);
    const cached = cache.get('accounts', nowMs);
    if (cached) return cached;
    if (!isSecretRef(config.cliproxy.managementKeySecretRef)) {
      return { accounts: [], source: 'no-secret', atMs: nowMs };
    }
    const { method, url } = buildAuthFilesRequest(config.cliproxy.baseUrl);
    void method;
    void url;
    const data = await cliproxyGet(companyId, config, '/v0/management/auth-files', null);
    const files = data?.files ?? [];
    const accounts = [];
    for (const auth of files) {
      const account = parseAuthFile(auth, nowMs);
      if (!account.enabled) continue;
      if (isStale(account, config.cliproxy.staleAfterSec, nowMs)) {
        try {
          const pull = buildApiCallRequest(config.cliproxy.baseUrl, { authIndex: account.authIndex, provider: account.provider });
          const live = await cliproxyGet(companyId, config, '/v0/management/api-call', pull.body);
          const parsed = account.provider === 'claude' ? parseAnthropicUsageBody(live?.body) : parseCodexWhamBody(live?.body);
          if (parsed) {
            if (parsed.fiveHour) account.fiveHour = parsed.fiveHour;
            if (parsed.weekly) account.weekly = parsed.weekly;
            if (parsed.monthly) account.monthly = parsed.monthly;
            account.signalsAtMs = nowMs;
            account.livePulled = true;
          }
        } catch {
          account.livePullFailed = true;
        }
      }
      accounts.push(account);
    }
    const snapshot = { accounts, atMs: nowMs, source: 'cliproxy' };
    cache.set('accounts', snapshot, nowMs);
    snapshots.set(companyId, snapshot);
    return snapshot;
  }

  function roleOf(config, agentId) {
    return config.roles.thinkerAgentIds.includes(agentId) ? 'thinker' : 'doer';
  }

  function buildAccountLadders({ accounts, aaSnapshot, config, previousLadders }) {
    const { arms, skipped } = resolveArms(aaSnapshot?.rows ?? [], config.armMap);
    const scored = new Map(computeComposite(arms, config.weights).map(s => [s.armId, s]));
    const byCost = new Map(arms.map(a => [a.armId, a.row.intelligenceIndexCostPerTask]));
    const refCost = byCost.get(config.calibration.referenceArmId);
    const burnFor = armId => {
      const c = byCost.get(armId);
      if (c == null || !(refCost > 0)) return null;
      return config.calibration.referenceBurnPerRunPct * (c / refCost);
    };
    const ladders = {};
    for (const account of accounts) {
      const eligible = armsForProvider(arms, account.provider).map(a => ({
        armId: a.armId,
        Q: scored.get(a.armId)?.Q ?? null,
        C: byCost.get(a.armId) ?? null,
        coverage: scored.get(a.armId)?.coverage ?? 0,
      }));
      const { rungs, dominated, dropped } = buildLadder(eligible, previousLadders?.[accountKey(account)]?.rungs ?? []);
      ladders[accountKey(account)] = {
        rungs: rungs.map(r => {
          const arm = arms.find(x => x.armId === r.armId);
          return { ...r, model: arm.model, effort: arm.effort, family: arm.family, contextWindow: arm.row.contextWindowTokens ?? null };
        }),
        dominated,
        dropped,
        burnPerRunPct: Object.fromEntries(eligible.map(e => [e.armId, burnFor(e.armId)])),
      };
    }
    return { ladders, skipped, arms: arms.map(a => a.armId) };
  }

  function accountKey(account) {
    return `${account.provider}:${account.authIndex ?? 'x'}`;
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
    const accountViews = [];
    for (const account of snapshot.accounts) {
      const key = accountKey(account);
      const weeklyUsed = account.weekly?.utilization;
      const fiveHourUsed = account.fiveHour?.utilization;
      const resetAtMs = account.weekly?.resetsAt ? Date.parse(account.weekly.resetsAt) : null;
      const startMs = resetAtMs != null && !Number.isNaN(resetAtMs) ? windowStartMs(resetAtMs, 'weekly') : null;
      const error = weeklyUsed != null && startMs != null && resetAtMs != null
        ? scheduleError({ usedPct: weeklyUsed, nowMs, periodStartMs: startMs, periodEndMs: resetAtMs })
        : 0;
      const ceiling = (ladders[key]?.rungs.length ?? 1) - 1;
      const step = stepController(nextPacing[key] ?? { pointer: 0, lastMoveAtMs: 0, guardActive: false },
        { weeklyUsedPct: weeklyUsed, fiveHourUsedPct: fiveHourUsed, error }, nowMs, config.pacing, ceiling);
      nextPacing[key] = { pointer: step.pointer, lastMoveAtMs: step.lastMoveAtMs, guardActive: step.guardActive };
      accountViews.push({
        accountId: key,
        provider: account.provider,
        weeklyUsedPct: weeklyUsed,
        fiveHourUsedPct: fiveHourUsed,
        resetAtMs,
        remainingPct: weeklyUsed != null ? Math.max(0, 1 - weeklyUsed) : null,
        pointer: step.pointer,
        guardActive: step.guardActive,
        action: step.action,
      });
    }
    const ordered = orderAccounts(accountViews.map(a => ({ ...a, remainingPct: a.remainingPct ?? 0 })));

    const burnOf = key => {
      const b = ladders[key]?.burnPerRunPct ?? {};
      const vals = Object.values(b).filter(v => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const concurrency = computeConcurrencyTarget({
      accounts: ordered.map(a => ({
        accountId: a.accountId,
        remainingPct: a.remainingPct ?? 0,
        hoursToReset: a.resetAtMs != null ? Math.max((a.resetAtMs - nowMs) / 3600000, 0.25) : 168,
        burnPerRunPct: burnOf(a.accountId),
        guardActive: a.guardActive,
      })),
      meanRunDurationHours: config.concurrency.meanRunDurationHours,
      maxTotal: config.concurrency.maxTotal,
    });

    // Shadow decisions for recently started runs.
    const ring = createShadowRing(config.shadowMaxEntries);
    ring.load(await ctx.state.get(scopeKey(companyId, RING_KEY)));
    const runs = (recentRuns.get(companyId) ?? []).filter(r => nowMs - r.at < 15 * 60 * 1000);
    const roleBands = {
      thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
      doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
    };
    let observed = 0;
    for (const run of runs.slice(-50)) {
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
        ring.push({
          runId: run.runId,
          agentId: run.agentId,
          actualModel: run.model ?? 'unknown',
          wouldModel: `${decision.model}(${decision.effort ?? 'default'})`,
          account: decision.accountId,
          accountId: decision.accountId,
          rung: decision.rung,
          reason: decision.reason,
          at: nowMs,
        });
        observed += 1;
      }
    }
    recentRuns.set(companyId, []);

    await ctx.state.set(scopeKey(companyId, PACING_KEY), nextPacing);
    await ctx.state.set(scopeKey(companyId, RING_KEY), ring.toJSON());
    await ctx.state.set(scopeKey(companyId, CAPACITY_KEY), { atMs: nowMs, target: concurrency.target, perAccount: concurrency.perAccount, accounts: accountViews, skippedArms: skipped });
    await ctx.state.set(scopeKey(companyId, LADDER_KEY), { atMs: nowMs, ladders });
    ctx.logger.info('model-capacity: shadow tick', { companyId, accounts: accountViews.length, target: concurrency.target, observed });
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
    const fetched = await fetchAaFreeList({ http: ctx.http, apiKey });
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
    await ctx.state.set(scopeKey(companyId, AA_KEY), { fetchedAt: nowIso, rows: parsed.rows, duplicateSlugs: parsed.duplicateSlugs, lastAttemptAt: nowIso, lastError: null });
    ctx.logger.info('model-capacity: AA snapshot refreshed', { companyId, rows: parsed.rows.length });
    return { status: 'ok', rows: parsed.rows.length };
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
        const companyId = event.companyId;
        if (!configured.has(companyId)) return;
        const list = recentRuns.get(companyId) ?? [];
        list.push({
          runId: event.entityId ?? event.payload?.runId ?? 'unknown',
          agentId: event.payload?.agentId ?? event.actorId ?? 'unknown',
          model: event.payload?.model ?? null,
          at: clock(),
        });
        recentRuns.set(companyId, list.slice(-200));
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
          resetAtMs: a.weekly?.resetsAt ? Date.parse(a.weekly.resetsAt) : null,
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
