/**
 * Model-capacity plugin worker wiring (I/O at the edges; math in modules).
 *
 * v0.2.2 = ALL-PROVIDERS. Arms are data-driven (the feed's `models` lists
 * are the only coverage source; AA slugs resolve via normalization plus a
 * small override table; no-AA-match models are reported `unscored`, never
 * invented). Families without fleet success route as capped trials
 * (doer-only, adapter-gated) until measured success graduates them.
 * Reactive accounts (vendor publishes no meter) are eligible while healthy
 * and rank between metered-behind-plan and metered-ahead-of-plan. Shadow
 * decisions are recorded event-time from agent.run.started when the
 * resolver is absent, and run->account mapping uses resolved actual models.
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
  LANE_ACCOUNTS_PATH_ALLOWLIST,
  LANE_KEY_HEADER,
  buildLaneRequest,
  assertLaneRequest,
  parseLaneBody,
  isReactiveAccount,
  CliproxyCache,
} from './cliproxy.mjs';
import { fetchAaFreeList, parseAaFreeList, fetchAaLeaderboard, parseAaLeaderboardHtml, mergeAaRows } from './aa.mjs';
import {
  DEFAULT_ARM_MAP, resolveArms, armsForAccount, buildDynamicBindings, resolveDynamicArms,
  canonicalModelName, inferFamily, familyOfModelName, PROVEN_FAMILIES,
} from './arms.mjs';
import { computeComposite, DEFAULT_WEIGHTS } from './quality.mjs';
import { fillCosts } from './cost.mjs';
import { buildLadder } from './ladder.mjs';
import {
  scheduleError, stepController, stepRateController, appendUtilReading,
  measuredRatePerHour, requiredRatePerHour, orderAccounts, DEFAULT_PACING,
} from './pacing.mjs';
import { decide, DEFAULT_ROLE_BANDS, DEFAULT_CONTEXT_CAPS, DEFAULT_TRIALS } from './decide.mjs';
import { computeConcurrencyTarget, distributeCaps, distributeWeightedCaps, DEFAULT_CONCURRENCY } from './concurrency.mjs';
import { orderAccountsForRun } from './select.mjs';
import { createShadowRing, SHADOW_CAPACITY } from './shadow.mjs';
import { manifest, LANE_BASE_URL_ALLOWLIST } from './manifest.mjs';

const NS = 'model-capacity';
const AA_KEY = 'aa-snapshot-v1';
const TRIAL_KEY = 'trial-families-v1';
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
// Terminal runIds retained for the full in-flight horizon (the merged runs
// above only cover the 60-min rate window, but ring entries count longer --
// without this, runs that finished 60-120 min ago count as in flight).
const TERMINAL_KEY = 'terminal-runs-v1';
const TERMINAL_CAP = 5000;

/** Run statuses that free their in-flight slot. Cancelled included: the host emits it, so we honor it. */
const TERMINAL_STATUSES = new Set(['finished', 'failed', 'cancelled']);
const isTerminalStatus = (s) => TERMINAL_STATUSES.has(s);

/** Adapters whose runs execute through the Claude Code CLI. */
const CLAUDE_CLI_ADAPTERS = new Set(['claude_local', 'claude-code']);
/** AA context window at or above which a claude run needs the 1M suffix. */
const ONE_M_CONTEXT_TOKENS = 1000000;

/**
 * Decorated model string for 1M-context claude runs, or null when the
 * decision needs no decoration. The CLI runs claude-haiku-5-5 at a 200k
 * window and IGNORES CLAUDE_CODE_MAX_CONTEXT_TOKENS for claude-* ids;
 * emitting `<model>(<effort>)[1m]` makes the CLI strip `[1m]` and run the
 * `(effort)` id at 1M. Only for claude-* ids on Claude-CLI adapters with a
 * known >= 1M arm window -- everything else renders exactly as before.
 * (MAX_CONTEXT_TOKENS is never set for claude-* ids; decide() only sets it
 * for sol/luna arms.)
 */
function decoratedModelFor(decision, adapterType) {
  const model = decision?.model;
  if (typeof model !== 'string' || !model.startsWith('claude-')) return null;
  if (!CLAUDE_CLI_ADAPTERS.has(adapterType)) return null;
  const window = decision?.contextWindow;
  if (!Number.isFinite(window) || window < ONE_M_CONTEXT_TOKENS) return null;
  return `${model}(${decision?.effort ?? 'default'})[1m]`;
}

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
  // Same pin for the feed path: the lane key is sent on this request, so
  // config must not redirect it to another endpoint on the host.
  if (cliproxy?.accountsPath != null && !LANE_ACCOUNTS_PATH_ALLOWLIST.includes(cliproxy.accountsPath)) {
    errors.push(`cliproxy.accountsPath must be one of: ${LANE_ACCOUNTS_PATH_ALLOWLIST.join(', ')}`);
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
  if (raw.trials) {
    for (const k of ['maxInFlightPerAccount', 'maxInFlightPerFamily', 'minRuns']) {
      if (k in raw.trials && !(raw.trials[k] >= 1)) errors.push(`trials.${k} must be >= 1`);
    }
    if ('minSuccessRate' in raw.trials && (typeof raw.trials.minSuccessRate !== 'number' || raw.trials.minSuccessRate < 0 || raw.trials.minSuccessRate > 1)) {
      errors.push('trials.minSuccessRate must be a number in [0, 1]');
    }
    if ('adapters' in raw.trials && (raw.trials.adapters == null || typeof raw.trials.adapters !== 'object' || Array.isArray(raw.trials.adapters))) {
      errors.push('trials.adapters must be an object of adapter type to families');
    }
  }
  if (raw.modelAaOverrides != null && (typeof raw.modelAaOverrides !== 'object' || Array.isArray(raw.modelAaOverrides))) {
    errors.push('modelAaOverrides must be an object of CLIProxy model id to AA slug');
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
      accountsPath: LANE_ACCOUNTS_PATH_ALLOWLIST.includes(raw.cliproxy?.accountsPath) ? raw.cliproxy.accountsPath : DEFAULT_ACCOUNTS_PATH,
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
    // Trial lanes and arms: families without fleet success history route
    // doer-only through adapters that opt in, capped in flight per account
    // and per family, until measured success graduates them.
    trials: {
      maxInFlightPerAccount: raw.trials?.maxInFlightPerAccount ?? DEFAULT_TRIALS.maxInFlightPerAccount,
      maxInFlightPerFamily: raw.trials?.maxInFlightPerFamily ?? DEFAULT_TRIALS.maxInFlightPerFamily,
      minRuns: raw.trials?.minRuns ?? DEFAULT_TRIALS.minRuns,
      minSuccessRate: raw.trials?.minSuccessRate ?? DEFAULT_TRIALS.minSuccessRate,
      adapters: raw.trials?.adapters ?? DEFAULT_TRIALS.adapters,
    },
    // Operator extensions to the AA-slug override table (CLIProxy model
    // id -> AA slug or { slug, effort }); merged over the built-in table.
    modelAaOverrides: raw.modelAaOverrides ?? {},
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
  // Event-time shadow decisions, recorded memory-only from agent.run.started
  // when the resolver is absent (hook not registered or enforce off): the
  // tick merges them into the ring, backfills actuals, and never re-decides
  // the same run. companyId -> [records].
  const pendingShadow = new Map();
  // Last resolved config per company, for the memory-only event-time path
  // (the event handler performs zero I/O, so it reads this, not ctx.config).
  const lastConfig = new Map();
  // Agent adapter types, resolved from the agent record when run events
  // omit adapterType (trial arms are adapter-gated). companyId:agentId ->
  // { adapterType, atMs }, 10-min TTL, 500-entry cap. Failures and empty
  // reads are never cached: the next tick retries, and the trial gate
  // keeps deferring with its stable reason meanwhile.
  const agentAdapterCache = new Map();
  const ADAPTER_TTL_MS = 10 * 60 * 1000;
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

  /**
   * Trial state: per-family fleet success counters plus the graduated set.
   * { counters: { family: { finished, failed } }, graduated: [family],
   *   seenTerminal: [runId] }. A family graduates when finished+failed
   * reaches trials.minRuns with finished/total >= trials.minSuccessRate.
   * Families in PROVEN_FAMILIES start proven (months of fleet history);
   * every other family earns it through these counters.
   */
  function emptyTrialState() {
    return { counters: {}, graduated: [], seenTerminal: [] };
  }

  function trialFamilyStats(trialState, family) {
    const c = trialState?.counters?.[family] ?? { finished: 0, failed: 0 };
    const finished = Number(c.finished) || 0;
    const failed = Number(c.failed) || 0;
    const total = finished + failed;
    return { finished, failed, total, successRate: total > 0 ? finished / total : null };
  }

  function isProvenFamily(trialState, family) {
    if (PROVEN_FAMILIES.includes(family)) return true;
    return (trialState?.graduated ?? []).includes(family);
  }

  function buildAccountLadders({ accounts, aaSnapshot, config, previousLadders, stateKeys = null, trialState = null }) {
    const keyOf = (account, i) => stateKeys?.[i] ?? accountKey(account);
    const classic = resolveArms(aaSnapshot?.rows ?? [], config.armMap);
    // Dynamic arms from the models the feed reports served, minus ids the
    // classic table already binds. No provider list involved: the feed is
    // the only coverage source.
    const servedModels = new Set();
    for (const account of accounts ?? []) {
      for (const m of account?.models ?? []) {
        const canon = canonicalModelName(m);
        if (canon) servedModels.add(canon);
      }
    }
    const classicModels = new Set(classic.arms.map(a => a.model));
    const { bindings } = buildDynamicBindings([...servedModels], { coveredModels: [...classicModels], overrides: config.modelAaOverrides });
    const dynamic = resolveDynamicArms(aaSnapshot?.rows ?? [], bindings);
    const arms = [...classic.arms, ...dynamic.arms];
    const skipped = [...classic.skipped, ...dynamic.unscored.map(u => ({ model: u.model, reason: u.reason }))];
    const byArm = new Map(arms.map(a => [a.armId, a]));
    // Unscored models (no AA match, non-chat ids): unrankable, listed for
    // the capacity report with the accounts that serve them.
    const unscored = [...dynamic.unscored];
    for (const u of unscored) {
      u.servedBy = (accounts ?? [])
        .filter(a => (a?.models ?? []).map(canonicalModelName).includes(u.model))
        .map(a => accountKey(a));
    }
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
      const served = armsForAccount(arms, account);
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
            trial: !isProvenFamily(trialState, arm.family),
            contextWindow: arm.row.contextWindowTokens ?? null,
            costEstimated: costs.get(r.armId)?.estimated ?? false,
          };
        }),
        dominated,
        dropped,
        burnPerRunPct: Object.fromEntries(eligible.map(e => [e.armId, burnFor(costs.get(e.armId)?.C ?? null)])),
      };
    }
    return { ladders, skipped, arms: arms.map(a => a.armId), unscored };
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
   * Adapter type for a run whose event did not carry one. Reads the agent
   * record (agents.read, already declared) with a 10-min per-agent cache.
   * Null when the agent is unknown or the read fails: trial arms stay
   * gated and decide keeps deferring with its stable reason -- the lookup
   * failing must never invent eligibility.
   */
  async function agentAdapterType(companyId, agentId) {
    if (!agentId || agentId === 'unknown') return null;
    const key = `${companyId}:${agentId}`;
    const hit = agentAdapterCache.get(key);
    if (hit && hit.adapterType && clock() - hit.atMs < ADAPTER_TTL_MS) return hit.adapterType;
    try {
      const agent = await compatAgentGet(agentId, companyId);
      const t = agent?.adapterType ?? agent?.adapter_type ?? null;
      if (typeof t === 'string' && t.length > 0) {
        agentAdapterCache.set(key, { adapterType: t, atMs: clock() });
        if (agentAdapterCache.size > 500) agentAdapterCache.delete(agentAdapterCache.keys().next().value);
        return t;
      }
    } catch (error) {
      ctx.logger.error('model-capacity: agent adapter read failed', { companyId, error: error?.message ?? String(error) });
    }
    return null;
  }

  /** Fresh cached adapter type from a frozen live view (memory-only paths). */
  function liveAdapterFor(live, agentId) {
    const entry = live?.adapterByAgent?.[agentId];
    if (!entry || typeof entry.adapterType !== 'string') return null;
    if (clock() - entry.atMs > ADAPTER_TTL_MS) return null;
    return entry.adapterType;
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
    // Backfilled runs carry modelSource from the tick's resolved-actual
    // backfill; only a model the event itself carried counts as run-event.
    if (run.model) return { model: run.model, source: run.modelSource ?? 'run-event', error: null };
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
   * Map a run to an account key. Most specific first: an exact served-model
   * match (disambiguates pools sharing one provider, e.g. an Antigravity
   * partner model vs a Gemini one), then a direct provider match, then a
   * model-family hint to the first account serving that family. Null when
   * nothing resolves (counted, never misattributed). Runs name no model or
   * provider until the actual-model trail resolves, so callers backfill
   * resolved actuals onto run records before mapping -- see the tick.
   */
  function accountForRun(run, accounts) {
    const canon = canonicalModelName(run?.model);
    if (canon) {
      for (const a of accounts ?? []) {
        if ((a?.models ?? []).map(canonicalModelName).includes(canon)) return accountKey(a);
      }
    }
    const byProvider = new Map();
    for (const a of accounts ?? []) {
      const p = (a.provider ?? '').toLowerCase();
      if (p && !byProvider.has(p)) byProvider.set(p, accountKey(a));
    }
    if (run?.provider && byProvider.has(run.provider)) return byProvider.get(run.provider);
    const family = familyOfModelName(run?.model);
    if (family) {
      for (const a of accounts ?? []) {
        if ((a?.models ?? []).some(m => inferFamily(canonicalModelName(m)) === family)) return accountKey(a);
      }
    }
    return null;
  }

  /**
   * Merge in-memory buffered and persisted state-ring runs, newest first,
   * deduped by run id. On a duplicate id the FIRST record keeps its place
   * while null fields (model, provider, agentId, issueId, status) are
   * backfilled from the later duplicate instead of dropping it.
   *
   * Two overrides break the first-wins rule, both terminal-driven: any
   * terminal status (finished/failed/cancelled) wins over non-terminal,
   * and a terminal `run-decision` model (payload.modelDecision: what the
   * run actually used) overwrites earlier guesses such as the agent-config
   * backfill. Without the model override, enforced runs are credited to
   * the agent's configured model and trial families can never graduate.
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
      for (const k of ['model', 'modelSource', 'provider', 'agentId', 'issueId', 'adapterType']) {
        if ((prev[k] == null || prev[k] === 'unknown') && r[k] != null && r[k] !== 'unknown') prev[k] = r[k];
      }
      if (r.model != null && r.model !== 'unknown' && r.modelSource === 'run-decision' && prev.modelSource !== 'run-decision') {
        prev.model = r.model;
        prev.modelSource = r.modelSource;
      }
      // Terminal status wins (a finished event after a started one), but
      // `at` stays the START time: calibration counts runs started in span.
      if ((prev.status == null) && r.status != null) prev.status = r.status;
      if (isTerminalStatus(r.status) && !isTerminalStatus(prev.status)) prev.status = r.status;
    }
    return [...byId.values()].sort((a, b) => b.at - a.at);
  }

  async function runShadowTick(companyId, job) {
    const nowMs = clock();
    const raw = await ctx.config.get(companyId);
    const config = resolveConfig(raw);
    // In-flight horizon: a run with no terminal event stops counting after
    // max(3 x mean run duration, 2h). The 2h floor keeps the horizon at the
    // ring's memory even when the duration calibrates short; terminal runIds
    // below are retained for the same horizon so finished runs the 60-min
    // rate window already evicted stay recognized.
    const meanHours = Number(config.concurrency?.meanRunDurationHours);
    const staleHorizonMs = Math.max(
      3 * (Number.isFinite(meanHours) && meanHours > 0 ? meanHours : 0.186) * 3600 * 1000,
      2 * 3600 * 1000,
    );
    const snapshot = await readAccounts(companyId, config, nowMs);
    const aaSnapshot = await ctx.state.get(scopeKey(companyId, AA_KEY));
    const pacingState = (await ctx.state.get(scopeKey(companyId, PACING_KEY))) ?? {};
    const prevLadders = (await ctx.state.get(scopeKey(companyId, LADDER_KEY)))?.ladders ?? {};
    // Trial family counters drive which families route as trials; the fresh
    // resolved config feeds the memory-only event-time path (see setup).
    const trialState = (await ctx.state.get(scopeKey(companyId, TRIAL_KEY))) ?? emptyTrialState();
    lastConfig.set(companyId, config);
    // One state key per snapshot entry (never a merged series): see
    // uniqueAccountKeys. `keyOf` keeps ladders aligned with the same keys.
    const stateKeys = uniqueAccountKeys(snapshot.accounts);
    const { ladders, skipped, unscored } = buildAccountLadders({ accounts: snapshot.accounts, aaSnapshot, config, previousLadders: prevLadders, stateKeys, trialState });

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
      // Effective headroom: the 5h meter when present, else the weekly
      // remaining as a fallback pool guard -- but ONLY for accounts whose
      // feed entry carries a `models` list (the auto-discovery feed). A
      // feed that predates `models` keeps headroom null (CISO
      // unknown-headroom rule: a meter that should exist but doesn't means
      // the reading is broken, never "plenty of quota"). Reactive accounts
      // (vendor publishes no meter at all) carry no headroom signal; their
      // eligibility comes from health alone (see select.mjs).
      const reactive = isReactiveAccount(account);
      const headroomPct = fiveHourUsed != null
        ? Math.max(0, 1 - fiveHourUsed)
        : (weeklyUsed != null && Array.isArray(account.models) ? Math.max(0, 1 - weeklyUsed) : null);
      const headroomSource = fiveHourUsed != null ? 'five-hour' : (headroomPct != null ? 'weekly-fallback' : null);
      accountViews.push({
        accountId: key,
        provider: account.provider,
        health: account.health,
        meter: account.meter ?? null,
        quality: account.quality,
        reactive,
        weeklyUsedPct: weeklyUsed,
        fiveHourUsedPct: fiveHourUsed,
        headroomPct,
        headroomSource,
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
    const modelCaches = { agents: new Map(), issues: new Map() };
    // Resolved-actual backfill: live run.started events name no model or
    // provider, so unmapped runs stay unmapped until the actual model
    // resolves (issue override, then agent config). Backfill up to 20
    // unresolved runs per tick, newest first; the mapping below then sees
    // the resolved models. Persisted AFTER the backfill so progress sticks.
    let backfilledActuals = 0;
    for (const run of runs) {
      if (backfilledActuals >= 20) break;
      if (run.model != null && run.model !== 'unknown') continue;
      if (!run.agentId && !run.issueId) continue;
      const actual = await resolveActualModel(companyId, run, modelCaches);
      if (actual.model != null) {
        run.model = actual.model;
        run.modelSource = actual.source;
        backfilledActuals += 1;
      }
    }
    // Adapter gate backfill: trial arms need adapterType and run events
    // usually omit it. Resolve once per agent from the agent record
    // (10-min TTL cache) and stamp it onto the runs, so this tick's
    // decisions, the ring entries, and the live adapter map reuse it.
    // Runs whose agents do not resolve keep deferring as before.
    {
      const byAgent = new Map();
      for (const run of runs) {
        if (run.adapterType || !run.agentId || run.agentId === 'unknown') continue;
        if (!byAgent.has(run.agentId)) byAgent.set(run.agentId, []);
        byAgent.get(run.agentId).push(run);
      }
      for (const [agentId, list] of byAgent) {
        const t = await agentAdapterType(companyId, agentId);
        if (t) for (const r of list) r.adapterType = t;
      }
    }
    await ctx.state.set(scopeKey(companyId, RUNS_KEY), runs.slice(0, RUNS_CAP));
    const runById = new Map(runs.map(r => [r.runId, r]));
    const runsByAccount = new Map();
    const inFlightByAccount = {};
    let unmappedRuns = 0;
    for (const run of runs) {
      const key = accountForRun(run, snapshot.accounts);
      if (!key) {
        unmappedRuns += 1;
        continue;
      }
      if (!runsByAccount.has(key)) runsByAccount.set(key, []);
      runsByAccount.get(key).push(run);
      if (run.status === 'running') inFlightByAccount[key] = (inFlightByAccount[key] ?? 0) + 1;
    }
    // Terminal runIds outlive the 60-min rate window: without this memory,
    // a run that finished 60+ min ago drops out of `runs`, its ring entry
    // (kept up to the in-flight horizon) counts as in flight, and pools
    // inflate with ghosts. Retained for the in-flight horizon, capped.
    let terminalSeen = (await ctx.state.get(scopeKey(companyId, TERMINAL_KEY))) ?? {};
    if (terminalSeen == null || typeof terminalSeen !== 'object' || Array.isArray(terminalSeen)) terminalSeen = {};
    for (const r of runs) {
      if (isTerminalStatus(r.status) && terminalSeen[r.runId] == null) terminalSeen[r.runId] = nowMs;
    }
    for (const [id, at] of Object.entries(terminalSeen)) {
      if (!Number.isFinite(at) || nowMs - at > staleHorizonMs) delete terminalSeen[id];
    }
    {
      const ids = Object.keys(terminalSeen).sort((a, b) => terminalSeen[a] - terminalSeen[b]);
      if (ids.length > TERMINAL_CAP) for (const id of ids.slice(0, ids.length - TERMINAL_CAP)) delete terminalSeen[id];
    }
    await ctx.state.set(scopeKey(companyId, TERMINAL_KEY), terminalSeen);
    const terminalIds = new Set(Object.keys(terminalSeen));

    // Allocation targets and provider pools. CLIProxy round-robins lanes
    // of the same provider onto shared credentials, so lane-level in-flight
    // spreading is theater: pressure is real only at the provider bucket.
    // Each account's target share is requiredRate / E (runs/hour it can
    // sustain; proportions match the per-account C* concurrency targets).
    // E prefers measured burn-per-run, then the ladder-average burn, then
    // the calibration reference anchor.
    const keyToProvider = new Map(stateKeys.map((k, i) =>
      [k, String(snapshot.accounts[i]?.provider ?? String(k).split(':')[0]).toLowerCase()]));
    const poolOfKey = (key) => keyToProvider.get(key) ?? String(key).split(':')[0].toLowerCase();
    {
      const refAnchor = config.calibration?.referenceBurnPerRunPct ?? 0.0005;
      const runsInSpan = (key, spanMs) => (runsByAccount.get(key) ?? []).filter(r => nowMs - r.at <= spanMs).length;
      for (let i = 0; i < snapshot.accounts.length; i++) {
        const key = stateKeys[i];
        const view = accountViews[i];
        if (!view) continue;
        view.pool = poolOfKey(key);
        let E = null;
        const spanMs = view.rateSpanMs ?? null;
        if (spanMs != null && spanMs > 0 && view.weeklyUsedPct != null) {
          const hist = rateHistories[key] ?? [];
          const inSpan = hist.filter(p => nowMs - p.atMs <= spanMs);
          if (inSpan.length >= 2) {
            const delta = inSpan[inSpan.length - 1].usedPct - inSpan[0].usedPct;
            const n = runsInSpan(key, spanMs);
            if (delta > 0 && n > 0) E = delta / n;
          }
        }
        if (E == null) {
          const vals = Object.values(ladders[key]?.burnPerRunPct ?? {}).filter(v => v != null);
          if (vals.length > 0) E = vals.reduce((s, v) => s + v, 0) / vals.length;
        }
        if (E == null || !(E > 0)) E = refAnchor;
        view.effectiveBurnPerRunPct = E;
        view.targetShare = view.requiredRatePerHour != null && view.requiredRatePerHour > 0
          ? view.requiredRatePerHour / E
          : null;
      }
    }

    // Trial promotion: terminal runs with a resolved model feed per-family
    // finished/failed counters (each run counted once, via seenTerminal).
    // A non-proven family graduates at trials.minRuns runs with
    // trials.minSuccessRate success; its arms stop routing as trials on the
    // NEXT tick (ladders above were built with the pre-tick set).
    // Caveat: the 'agent-config' source is the agent's pinned model, not an
    // observed execution -- a noisy promotion signal, hence the 10-run /
    // 80% bar before a family sheds its in-flight cap.
    const seenTerminal = new Set(trialState.seenTerminal ?? []);
    let trialTransitions = 0;
    for (const run of runs) {
      if (run.status !== 'finished' && run.status !== 'failed') continue;
      if (seenTerminal.has(run.runId)) continue;
      const canon = canonicalModelName(run.model);
      if (!canon) continue;
      const family = inferFamily(canon);
      if (!family) continue;
      const c = trialState.counters[family] ?? { finished: 0, failed: 0 };
      if (run.status === 'finished') c.finished += 1; else c.failed += 1;
      trialState.counters[family] = c;
      seenTerminal.add(run.runId);
      trialTransitions += 1;
    }
    trialState.seenTerminal = [...seenTerminal].slice(-2000);
    const graduated = new Set(trialState.graduated ?? []);
    for (const [family, c] of Object.entries(trialState.counters)) {
      const total = (c.finished ?? 0) + (c.failed ?? 0);
      if (total >= config.trials.minRuns && (c.finished ?? 0) / total >= config.trials.minSuccessRate) {
        graduated.add(family);
      }
    }
    trialState.graduated = [...graduated];

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

    // Shadow ring first: trial in-flight budgets are measured from trial
    // entries whose runs are still running, and the live view publishes the
    // resulting budgets for the memory-only hook.
    const viewById = new Map(accountViews.map(v => [v.accountId, v]));
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
    // Event-time shadow decisions (recorded from agent.run.started when the
    // resolver was absent) merge next; the loop below skips their runIds.
    let mergedEventTime = 0;
    for (const pending of pendingShadow.get(companyId) ?? []) {
      if (!recorded.has(pending.runId)) {
        ring.push(pending);
        recorded.add(pending.runId);
        mergedEventTime += 1;
      }
    }
    pendingShadow.set(companyId, []);
    // Per-family trial in-flight: trial ring entries (fresh, <= 2h) whose
    // runs have no terminal status yet. Budgets go to decide, the hook, and
    // the capacity report.
    const runningIds = new Set(runs.filter(r => r.status === 'running').map(r => r.runId));
    const trialInFlight = {};
    for (const e of ring.list(500)) {
      if (e?.trial !== true || !e?.family) continue;
      if (!runningIds.has(e.runId)) continue;
      if (nowMs - e.at > 2 * 3600 * 1000) continue;
      trialInFlight[e.family] = (trialInFlight[e.family] ?? 0) + 1;
    }
    const trialBudget = {};
    {
      const fams = new Set(Object.keys(trialInFlight));
      for (const ladder of Object.values(ladders ?? {})) {
        for (const r of ladder?.rungs ?? []) if (r?.trial && r?.family) fams.add(r.family);
      }
      for (const fam of fams) {
        trialBudget[fam] = Math.max(0, config.trials.maxInFlightPerFamily - (trialInFlight[fam] ?? 0));
      }
    }
    // Pooled in-flight: mapped running runs UNION fresh ring
    // would-decisions for unfinished runs, deduped by runId. Either source
    // alone undercounts (ring-only runs older than the rate window; runs
    // the tick loop has not decided yet are added per-run below).
    // Pooled in-flight: mapped running runs UNION fresh ring
    // would-decisions for unfinished runs, deduped by runId. Terminal ids
    // come from the runs window PLUS the retained terminal memory (runs
    // the 60-min window already evicted still veto their ring entries).
    // Ring entries older than the in-flight horizon with no terminal event
    // are stale: dropped and counted, never pressure.
    const inFlightByPool = {};
    const ringCarry = [];
    let staleInFlightDropped = 0;
    const countedRunning = new Set();
    // Where each counted running run sits: runId -> { pool, accountId }.
    // The candidate loop moves (not duplicates) this pressure when it
    // decides the run onto a different pool/account (see below).
    const runMapped = new Map();
    {
      const finishedIds = new Set(runs.filter(r => isTerminalStatus(r.status)).map(r => r.runId));
      for (const id of terminalIds) finishedIds.add(id);
      for (const [key, list] of runsByAccount) {
        for (const r of list) {
          if (r.status !== 'running') continue;
          const p = poolOfKey(key);
          inFlightByPool[p] = (inFlightByPool[p] ?? 0) + 1;
          countedRunning.add(r.runId);
          if (!runMapped.has(r.runId)) runMapped.set(r.runId, { pool: p, accountId: key });
        }
      }
      for (const e of ring.list(500)) {
        if (!e?.runId || !e?.accountId) continue;
        if (countedRunning.has(e.runId) || finishedIds.has(e.runId)) continue;
        if (nowMs - e.at > staleHorizonMs) {
          staleInFlightDropped += 1;
          continue;
        }
        const p = poolOfKey(e.accountId);
        inFlightByPool[p] = (inFlightByPool[p] ?? 0) + 1;
        countedRunning.add(e.runId);
        ringCarry.push({ pool: p, accountId: e.accountId, at: e.at, runId: e.runId });
      }
    }
    // Defensive invariant: every pool-pressure unit traces to a mapped
    // running run or to fresh non-terminal ring carry inside the in-flight
    // horizon. The clamp bound covers both, so it only ever fires on a
    // counting bug: runs older than the 60-min rate window keep their
    // pressure through their carry (long runs steer allocation for the full
    // documented horizon), and only excess above observed-running PLUS
    // carry drops, oldest carry first.
    let clampedInFlightDropped = 0;
    const ringCarryKept = (() => {
      const windowActive = runs.filter(r => r.status === 'running').length;
      const bound = windowActive + ringCarry.length;
      let total = Object.values(inFlightByPool).reduce((s, n) => s + n, 0);
      if (total <= bound || ringCarry.length === 0) return ringCarry;
      const ordered = [...ringCarry].sort((a, b) => a.at - b.at);
      const drop = new Set();
      for (const c of ordered) {
        if (total <= bound) break;
        inFlightByPool[c.pool] = (inFlightByPool[c.pool] ?? 1) - 1;
        total -= 1;
        clampedInFlightDropped += 1;
        drop.add(c);
      }
      return ringCarry.filter(c => !drop.has(c));
    })();
    // Decided-account pressure: fresh unfinished ring entries per accountId,
    // with the same runId dedupe as the pool loop above. A hook-enforced run
    // carries no model while it runs (modelDecision lands on terminal
    // events), so the mapped counts miss it -- without this its only trace
    // is the queue the tick clears each merge, and the per-account cap
    // resets every tick. Only surviving (non-clamped) carry counts.
    const ringDecidedByAccount = {};
    for (const c of ringCarryKept) {
      ringDecidedByAccount[c.accountId] = (ringDecidedByAccount[c.accountId] ?? 0) + 1;
    }
    // Per-account in-flight the caps check: mapped running runs plus decided
    // (ring-carry) pressure on the same accountId. Read by the live view,
    // the tick's own cap check, and the capacity report.
    const capInFlightByAccount = { ...inFlightByAccount };
    for (const [id, n] of Object.entries(ringDecidedByAccount)) {
      capInFlightByAccount[id] = (capInFlightByAccount[id] ?? 0) + n;
    }
    // Water-filling order, rebuilt per run: need band first, then largest
    // (targetShare - pooled in-flight). Decisions made earlier in THIS tick
    // count as in-flight, so sequential decisions spread across accounts
    // instead of herding onto one static argmax winner. Same order the hook
    // and the event-time path use (via the live view below).
    const tickPoolPending = {};
    const tickAcctPending = {};
    const allocationOrder = () => orderAccountsForRun(
      accountViews.map(v => ({
        accountId: v.accountId,
        resetAtMs: v.resetAtMs,
        headroomPct: v.headroomPct,
        measuredRatePerHour: v.measuredRatePerHour,
        requiredRatePerHour: v.requiredRatePerHour,
        targetShare: v.targetShare ?? null,
        health: v.health,
        meter: v.meter,
        quality: v.quality,
        inFlight: (inFlightByPool[v.pool] ?? 0) + (tickPoolPending[v.pool] ?? 0),
      })),
      { reservePct: 0.05, rateDeadbandRel: config.pacing.rateDeadbandRel },
    );

    // Publish the live view the memory-only resolve hook reads. No I/O
    // happens in the hook, so everything it needs is frozen here: effective
    // headroom (5h, else the weekly fallback for feed-model accounts),
    // health/meter/reactive for the eligibility filter, provider + target
    // share + pooled in-flight for water-filling allocation, per-account
    // in-flight for the reactive cap, and the trial budgets + adapters for
    // trial arms.
    // Adapter map for the memory-only paths: fresh cached agent adapter
    // types, so the hook and event-time shadow decide trial arms for
    // agents the tick has already seen without performing I/O.
    const adapterByAgent = {};
    for (const [k, v] of agentAdapterCache) {
      const sep = k.indexOf(':');
      if (sep < 0 || k.slice(0, sep) !== companyId) continue;
      if (!v?.adapterType || nowMs - v.atMs > ADAPTER_TTL_MS) continue;
      adapterByAgent[k.slice(sep + 1)] = { adapterType: v.adapterType, atMs: v.atMs };
    }
    liveViews.set(companyId, {
      atMs: nowMs,
      enforce: config.enforce === true,
      inFlightByPool,
      adapterByAgent,
      thinkerAgentIds: config.roles.thinkerAgentIds,
      roleBands: {
        thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
        doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
      },
      contextCaps: config.contextCaps,
      trialBudget,
      trialAdapters: config.trials.adapters,
      maxTrialInFlightPerAccount: config.trials.maxInFlightPerAccount,
      accounts: ordered.map(a => {
        const view = viewById.get(a.accountId);
        const ladder = ladders[a.accountId];
        return {
          accountId: a.accountId,
          provider: view?.pool ?? poolOfKey(a.accountId),
          pool: view?.pool ?? poolOfKey(a.accountId),
          pointer: view?.guardActive ? 0 : (view?.pointer ?? 0),
          headroomPct: view?.headroomPct ?? null,
          headroomSource: view?.headroomSource ?? null,
          remainingKnown: view?.remainingPct != null,
          targetShare: view?.targetShare ?? null,
          reactive: view?.reactive === true,
          health: view?.health ?? 'unknown',
          meter: view?.meter ?? null,
          quality: view?.quality ?? 'unknown',
          inFlight: capInFlightByAccount[a.accountId] ?? 0,
          resetAtMs: view?.resetAtMs ?? null,
          measuredRatePerHour: view?.measuredRatePerHour ?? null,
          requiredRatePerHour: view?.requiredRatePerHour ?? null,
          ladderRungs: groupByRung(ladder?.rungs ?? []),
          burnPerRunPct: ladder?.burnPerRunPct ?? {},
        };
      }),
      rateDeadbandRel: config.pacing.rateDeadbandRel,
    });

    // Shadow decisions for recently started runs (event feed only).
    const candidates = runs.filter(r => nowMs - r.at < 15 * 60 * 1000 && !recorded.has(r.runId)).slice(0, 100);
    const roleBands = {
      thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
      doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
    };
    let observed = 0;
    let shadowSkippedNoDecision = 0;
    // Trial budget consumed within the tick: the pre-loop ring scan cannot
    // see decisions made below, so a mutable copy gates each candidate --
    // otherwise one tick mints unbounded trial arms against a budget of 2.
    // decidedTrials still feeds the reported (not gating) in-flight, and
    // the next tick recomputes budgets from the ring it just persisted.
    const tickBudget = { ...trialBudget };
    const decidedTrials = [];
    for (const run of candidates) {
      const role = roleOf(config, run.agentId);
      let decision = null;
      // Fresh order per run: earlier decisions in this tick already narrow
      // the winner's shortfall, so the next run spreads elsewhere.
      for (const sel of allocationOrder()) {
        const view = viewById.get(sel.accountId);
        const ladder = ladders[sel.accountId];
        if (!view || !ladder) continue;
        // Reactive accounts qualify without a remaining fraction; metered
        // accounts need one. Reactive lanes are capped in flight per account
        // (default 2): no vendor meter means no burn signal, so the count of
        // running runs is the only backpressure. Decisions already made
        // this tick count toward the cap: it bounds single-tick bursts, not
        // just previously observed executions.
        if (!view.reactive && view.remainingPct == null) continue;
        if (view.reactive && (capInFlightByAccount[sel.accountId] ?? 0) + (tickAcctPending[sel.accountId] ?? 0) >= config.trials.maxInFlightPerAccount) continue;
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
          adapterType: run.adapterType ?? null,
          trialBudget: tickBudget,
          trialAdapters: config.trials.adapters,
        });
        if (d.kind === 'decide') {
          decision = d;
          // Water-filling state: the next candidate run sees this decision
          // as in-flight (pool pressure) and toward the account cap (burst
          // bound), even though nothing has executed yet. A run already
          // observed running is in the base pressure under its MAPPED
          // bucket: when the decision sends it elsewhere, MOVE that unit
          // (decrement mapped, increment decided, per dimension) instead of
          // adding a second one. Skipping the increment outright would eat
          // the decided bucket's pressure -- no spread, no burst bound --
          // for every candidate whose model already maps to an account.
          if (run.status === 'running') {
            const mapped = runMapped.get(run.runId);
            const decidedPool = poolOfKey(d.accountId);
            if (!mapped) {
              tickAcctPending[d.accountId] = (tickAcctPending[d.accountId] ?? 0) + 1;
              tickPoolPending[decidedPool] = (tickPoolPending[decidedPool] ?? 0) + 1;
              countedRunning.add(run.runId);
            } else {
              if (mapped.pool !== decidedPool) {
                tickPoolPending[mapped.pool] = (tickPoolPending[mapped.pool] ?? 0) - 1;
                tickPoolPending[decidedPool] = (tickPoolPending[decidedPool] ?? 0) + 1;
              }
              if (mapped.accountId !== d.accountId) {
                tickAcctPending[mapped.accountId] = (tickAcctPending[mapped.accountId] ?? 0) - 1;
                tickAcctPending[d.accountId] = (tickAcctPending[d.accountId] ?? 0) + 1;
              }
            }
          }
          if (d.trial === true) {
            const fam = inferFamily(canonicalModelName(d.model));
            if (fam) tickBudget[fam] = Math.max(0, (tickBudget[fam] ?? 0) - 1);
          }
          break;
        }
      }
      if (decision) {
        // 1M claude runs render decorated so the CLI takes the 1M window;
        // the terminal modelDecision echoes the same string, keeping
        // modelMatch exact.
        const wouldModel = decoratedModelFor(decision, run.adapterType ?? null)
          ?? `${decision.model}(${decision.effort ?? 'default'})`;
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
          // False here: the tick resolves actuals synchronously, so nothing
          // is pending. Event-time and hook entries set true until a tick
          // backfills them (see below).
          actualPending: false,
          wouldModel,
          // Did shadow agree with reality? Null while the actual model is
          // still unknown; true/false once known.
          modelMatch: actual.model == null ? null : (actual.model === decision.model || actual.model === wouldModel),
          account: decision.accountId,
          accountId: decision.accountId,
          rung: decision.rung,
          trial: decision.trial === true,
          family: inferFamily(canonicalModelName(decision.model)),
          reason: decision.reason,
          at: nowMs,
        });
        observed += 1;
        if (decision.trial === true) {
          decidedTrials.push({ family: inferFamily(canonicalModelName(decision.model)), runId: run.runId });
        }
      } else {
        shadowSkippedNoDecision += 1;
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

    // Ring actual backfill: event-time and hook entries record with
    // actualPending:true (no I/O on those paths). Resolve from the merged
    // runs (which carry issueId/agentId) -- fresh entries only, 20 per tick.
    // A terminal run-decision (payload.modelDecision) also corrects entries
    // that already resolved to a guess (e.g. agent-config): the decision is
    // authoritative, so attribution, match stats, and graduation follow it.
    let ringBackfilled = 0;
    {
      const entries = ring.toJSON();
      for (const e of entries) {
        if (ringBackfilled >= 20) break;
        if (e?.actualPending === true && nowMs - e.at > 2 * 3600 * 1000) {
          e.actualPending = false;
          continue;
        }
        const run = runById.get(e.runId);
        const runDecision = run?.model != null && run.model !== 'unknown' && run?.modelSource === 'run-decision';
        if (e?.actualPending !== true && !(runDecision && e.actualModelSource !== 'run-decision')) continue;
        if (!run) continue;
        const actual = await resolveActualModel(companyId, run, modelCaches);
        if (actual.model != null) {
          e.actualModel = actual.model;
          e.actualModelSource = actual.source;
          e.actualModelError = null;
          e.actualPending = false;
          e.modelMatch = actual.model === String(e.wouldModel).split('(')[0] || actual.model === e.wouldModel;
          ringBackfilled += 1;
        }
      }
      ring.load(entries);
    }

    // Trial family report: counters plus graduation status plus live
    // in-flight, so /api/capacity shows what would need to happen for each
    // trial family to graduate. This tick's own trial decisions count as
    // in-flight (their runs are fresh); gating budgets were consumed
    // per decision in the loop above (tickBudget).
    for (const t of decidedTrials) {
      if (!t.family || !runningIds.has(t.runId)) continue;
      trialInFlight[t.family] = (trialInFlight[t.family] ?? 0) + 1;
    }
    // The live view published above predates this tick's decisions; fold
    // the tick's pool pressure AND consumed trial budgets into it so the
    // hook and event-time path water-fill against fresh counts until the
    // next tick republishes. (Per-tick state: the next tick recomputes
    // from scratch. tickPoolPending holds fresh decisions plus pressure
    // moved off mapped buckets onto decided ones (negative entries), so
    // each observed run still counts exactly once in the merged total.)
    {
      const live = liveViews.get(companyId);
      if (live) {
        const merged = { ...(live.inFlightByPool ?? {}) };
        for (const [pool, n] of Object.entries(tickPoolPending)) merged[pool] = (merged[pool] ?? 0) + n;
        live.inFlightByPool = merged;
        const budgets = { ...(live.trialBudget ?? {}) };
        for (const t of decidedTrials) {
          if (!t.family) continue;
          budgets[t.family] = Math.max(0, (budgets[t.family] ?? 0) - 1);
        }
        live.trialBudget = budgets;
      }
    }
    const trialFamilies = {};
    {
      const fams = new Set([...Object.keys(trialState.counters ?? {}), ...Object.keys(trialBudget)]);
      for (const fam of fams) {
        const st = trialFamilyStats(trialState, fam);
        trialFamilies[fam] = {
          ...st,
          proven: isProvenFamily(trialState, fam),
          inFlight: trialInFlight[fam] ?? 0,
          budget: trialBudget[fam] ?? 0,
        };
      }
    }
    await ctx.state.set(scopeKey(companyId, PACING_KEY), nextPacing);
    await ctx.state.set(scopeKey(companyId, RATE_KEY), rateHistories);
    await ctx.state.set(scopeKey(companyId, RING_KEY), ring.toJSON());
    await ctx.state.set(scopeKey(companyId, RUNEVT_KEY), mergedEvt);
    await ctx.state.set(scopeKey(companyId, TRIAL_KEY), trialState);
    await ctx.state.set(scopeKey(companyId, CAPACITY_KEY), {
      atMs: nowMs,
      target: concurrency.target,
      maxTotal: config.concurrency.maxTotal,
      calibration: concurrency.calibration,
      perAccount: concurrency.perAccount,
      accounts: accountViews,
      skippedArms: skipped,
      unscored,
      trialFamilies,
      trialTransitions,
      inFlightByAccount: capInFlightByAccount,
      inFlightByPool,
      // Ring-carry accounting: entries dropped as stale (older than the
      // in-flight horizon with no terminal event) and by the defensive
      // clamp backstop (bound = observed running runs in the window PLUS
      // non-terminal carry inside the horizon; oldest carry drops first).
      staleInFlightDropped,
      clampedInFlightDropped,
      reactiveAccounts: accountViews.filter(v => v.reactive).length,
      runsObserved: runs.length,
      runsCandidates: candidates.length,
      runsSource: 'events',
      unmappedRuns,
      runEventsSeen: mergedEvt.seen,
      lastRunEventAtMs: mergedEvt.lastAtMs,
      shadow: {
        decided: observed,
        mergedEventTime,
        backfilledActuals: backfilledActuals + ringBackfilled,
        skippedNoDecision: shadowSkippedNoDecision,
      },
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

  /**
   * Memory-only shadow decision from a run.started event. Inputs are the
   * live view frozen by the last tick plus the cached resolved config --
   * zero I/O, so this never blocks the event loop. Stale views (>120s, the
   * same bound as the hook) record nothing: a tick is overdue and its own
   * loop will cover the run. The tick merges the record into the ring and
   * backfills the actual model; its own loop then skips the runId.
   *
   * Trial arms need an opted-in adapter type, which events often omit --
   * adapter-less events fall back to the live adapter map (agent types the
   * tick resolved from agent records, 10-min TTL), then to proven arms
   * only. Runs whose events carry adapterType get full trial eligibility
   * here AND in the tick loop.
   */
  /**
   * Queued hook/event decisions not yet merged into the ring, deduped by
   * runId (a hook-decided run that started gets BOTH a pendingEnforced and
   * a pendingShadow entry -- counting both double-counts the run).
   * Entries older than the 2h queue horizon are ignored; the tick clears
   * both queues after every merge, so anything older means the tick died
   * (and the memory paths self-disable on stale views anyway).
   * `excludeRunId` drops one run's own entries: the host publishes
   * agent.run.started at claim BEFORE the model hook resolves, so the hook
   * must not count the run's own event-time shadow entry against itself in
   * caps, budgets, or ordering.
   */
  function queuedDecisions(companyId, excludeRunId = null) {
    const byId = new Map();
    for (const q of [...(pendingEnforced.get(companyId) ?? []), ...(pendingShadow.get(companyId) ?? [])]) {
      if (!q?.runId || byId.has(q.runId)) continue;
      if (excludeRunId != null && q.runId === excludeRunId) continue;
      if (q.at != null && clock() - q.at > 2 * 3600 * 1000) continue;
      byId.set(q.runId, q);
    }
    return [...byId.values()];
  }

  /**
   * Water-filling order over the frozen live view (hook + event-time path).
   * In-flight is the pooled pressure the last tick published plus every
   * queued hook/event decision since, deduped by runId (same-provider
   * lanes share one bucket). Spreads objects so per-call counts never
   * mutate the view. The pooled value drives ORDERING only; the reactive
   * per-account cap is checked separately against per-account counts
   * (see the hook and event-time loops).
   */
  function allocationOrderFromLive(live, companyId, excludeRunId = null) {
    const providerOf = new Map((live.accounts ?? []).map(a =>
      [a.accountId, String(a.pool ?? a.provider ?? String(a.accountId).split(':')[0]).toLowerCase()]));
    const poolOf = (id) => providerOf.get(id) ?? String(id).split(':')[0].toLowerCase();
    const poolPending = {};
    for (const q of queuedDecisions(companyId, excludeRunId)) {
      if (!q?.accountId) continue;
      const p = poolOf(q.accountId);
      poolPending[p] = (poolPending[p] ?? 0) + 1;
    }
    return orderAccountsForRun(
      (live.accounts ?? []).map(a => {
        const p = poolOf(a.accountId);
        return {
          ...a,
          targetShare: a.targetShare ?? null,
          inFlight: (live.inFlightByPool?.[p] ?? 0) + (poolPending[p] ?? 0),
        };
      }),
      { reservePct: 0.05, rateDeadbandRel: live.rateDeadbandRel ?? 0.15 },
    );
  }

  /**
   * Trial budget minus queued trial decisions per family, deduped by runId.
   * The tick publishes budgets from the ring; decisions made since (hook
   * or event-time, not yet merged) consume from a per-call copy, so a
   * burst within one tick cannot mint unbounded trial arms.
   */
  function effectiveTrialBudget(live, companyId, excludeRunId = null) {
    const use = new Map();
    for (const q of queuedDecisions(companyId, excludeRunId)) {
      if (q?.trial !== true || !q?.family) continue;
      use.set(q.family, (use.get(q.family) ?? 0) + 1);
    }
    const out = {};
    for (const [fam, b] of Object.entries(live?.trialBudget ?? {})) {
      out[fam] = Math.max(0, b - (use.get(fam) ?? 0));
    }
    return out;
  }

  /** Queued decisions per accountId, deduped by runId: the per-account side of the reactive cap. */
  function pendingByAccount(companyId, excludeRunId = null) {
    const out = new Map();
    for (const q of queuedDecisions(companyId, excludeRunId)) {
      if (!q?.accountId) continue;
      out.set(q.accountId, (out.get(q.accountId) ?? 0) + 1);
    }
    return out;
  }

  function recordEventTimeShadow(companyId, run) {
    const live = liveViews.get(companyId);
    const config = lastConfig.get(companyId);
    if (!live || !config) return null;
    if (!Number.isFinite(live.atMs) || clock() - live.atMs > 120000) return null;
    // Already covered: the hook (or an earlier event) queued a decision
    // for this runId, and the tick merges the queue into the ring. Recording
    // again would double-count the run in pool pressure and trial use.
    if (run?.runId != null) {
      for (const q of queuedDecisions(companyId)) {
        if (q.runId === String(run.runId)) return null;
      }
    }
    const role = Array.isArray(live.thinkerAgentIds) && live.thinkerAgentIds.includes(run.agentId) ? 'thinker' : 'doer';
    const order = allocationOrderFromLive(live, companyId);
    // Per-account cap inputs: the live view's per-account in-flight plus
    // queued decisions per account. The pooled inFlight on the ordered
    // views drives ordering only -- comparing the pool total against the
    // per-account cap starves multi-lane providers.
    const capBase = new Map((live.accounts ?? []).map(a => [a.accountId, a.inFlight ?? 0]));
    const acctPending = pendingByAccount(companyId);
    const maxPerAccount = live.maxTrialInFlightPerAccount ?? 2;
    const budget = effectiveTrialBudget(live, companyId);
    for (const view of order) {
      if (!view || !view.ladderRungs || view.ladderRungs.length === 0) continue;
      if (!view.reactive && !view.remainingKnown) continue;
      if (view.reactive && (capBase.get(view.accountId) ?? 0) + (acctPending.get(view.accountId) ?? 0) >= maxPerAccount) continue;
      const d = decide({
        runId: run.runId,
        agentId: run.agentId,
        role,
        ladderRungs: view.ladderRungs,
        pointer: view.pointer ?? 0,
        retryCount: 0,
        failureClass: 'none',
        contextTokens: null,
        fiveHourHeadroomPct: view.headroomPct ?? null,
        burnPerRunPct: view.burnPerRunPct ?? {},
        reservePct: 0.05,
        accountId: view.accountId,
        roleBands: live.roleBands,
        contextCaps: live.contextCaps,
        adapterType: run.adapterType ?? liveAdapterFor(live, run.agentId) ?? null,
        trialBudget: budget,
        trialAdapters: live.trialAdapters ?? {},
      });
      if (d.kind !== 'decide') continue;
      const queue = pendingShadow.get(companyId) ?? [];
      const emitAdapter = run.adapterType ?? liveAdapterFor(live, run.agentId) ?? null;
      queue.push({
        runId: String(run.runId ?? 'unknown'),
        agentId: String(run.agentId ?? 'unknown'),
        actualModel: 'unknown',
        actualModelSource: null,
        actualModelError: null,
        actualPending: true,
        wouldModel: decoratedModelFor(d, emitAdapter) ?? `${d.model}(${d.effort ?? 'default'})`,
        modelMatch: null,
        account: d.accountId,
        accountId: d.accountId,
        rung: d.rung,
        trial: d.trial === true,
        family: inferFamily(canonicalModelName(d.model)),
        eventTime: true,
        reason: d.reason,
        at: clock(),
      });
      pendingShadow.set(companyId, queue.slice(-200));
      return d;
    }
    return null;
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
      // failed, cancelled): the sole run feed since the db grant was
      // removed. Events WITHOUT a companyId are ignored outright --
      // fanning a company-less event out to every configured company would
      // misattribute runs.
      const onRunEvent = (status) => async event => {
        const companyId = event?.companyId;
        if (typeof companyId !== 'string' || companyId.length === 0) return;
        if (!configured.has(companyId)) return;
        // Tolerant extraction: accept every known placement and never drop
        // an event for a missing id. The terminal modelDecision (what the
        // run actually used) outranks every other model placement and is
        // tagged source run-decision, so mergeRuns treats it as
        // authoritative over earlier guesses.
        const p = event?.payload && typeof event.payload === 'object' ? event.payload : {};
        const run = p.run && typeof p.run === 'object' ? p.run : {};
        const md = p.modelDecision && typeof p.modelDecision === 'object' ? p.modelDecision : {};
        const mdSnake = p.model_decision && typeof p.model_decision === 'object' ? p.model_decision : {};
        const decidedModel = md.model ?? mdSnake.model ?? null;
        const hasDecision = typeof decidedModel === 'string' && decidedModel.length > 0;
        const entry = {
          runId: String(event?.entityId ?? p.runId ?? run.id ?? p.id ?? 'unknown'),
          agentId: String(p.agentId ?? run.agentId ?? event?.actorId ?? 'unknown'),
          model: hasDecision ? decidedModel : (p.model ?? run.model ?? null),
          modelSource: hasDecision ? 'run-decision' : null,
          provider: typeof (p.provider ?? run.provider) === 'string' ? String(p.provider ?? run.provider).toLowerCase() : null,
          issueId: p.issueId ?? run.issueId ?? p.issue_id ?? null,
          adapterType: p.adapterType ?? run.adapterType ?? null,
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
        // Event-time shadow decision (memory-only; see
        // recordEventTimeShadow): covers runs that start when the resolver
        // is absent, so the ring has no minute-long blind spot.
        if (status === 'running') {
          try {
            recordEventTimeShadow(companyId, entry);
          } catch (error) {
            ctx.logger.error('model-capacity: event-time shadow failed', { companyId, error: error?.message ?? String(error) });
          }
        }
      };
      ctx.events.on('agent.run.started', onRunEvent('running'));
      ctx.events.on('agent.run.finished', onRunEvent('finished'));
      ctx.events.on('agent.run.cancelled', onRunEvent('cancelled'));
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
      // Cache the resolved config immediately so the event-time shadow path
      // works before the first tick lands (the tick refreshes it every run).
      lastConfig.set(companyId, resolveConfig(raw));
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
      // Same water-filling order as the shadow tick: need band first, then
      // largest (targetShare - pooled in-flight). Metered accounts without
      // headroom never qualify; healthy reactive accounts qualify without
      // headroom (no vendor meter exists). The reactive cap compares
      // PER-ACCOUNT in-flight (live per-account counts plus queued
      // decisions per account, both deduped) -- the pooled value on the
      // ordered views drives ordering only. Trial budgets are consumed
      // from a per-call copy, so bursts within one tick stay bounded.
      // Own-run exclusion: the host fires agent.run.started at claim before
      // this hook resolves, so a queued shadow entry for THIS runId must not
      // count against it in ordering, caps, or budgets.
      const selfId = params?.runId != null ? String(params.runId) : null;
      const order = allocationOrderFromLive(live, params.companyId, selfId);
      const capBase = new Map((live.accounts ?? []).map(a => [a.accountId, a.inFlight ?? 0]));
      const acctPending = pendingByAccount(params.companyId, selfId);
      const maxPerAccount = live.maxTrialInFlightPerAccount ?? 2;
      const budget = effectiveTrialBudget(live, params.companyId, selfId);
      for (const view of order) {
        if (!view || view.ladderRungs.length === 0) continue;
        if (!view.reactive && !view.remainingKnown) continue;
        if (view.reactive && (capBase.get(view.accountId) ?? 0) + (acctPending.get(view.accountId) ?? 0) >= maxPerAccount) continue;
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
          adapterType: params.adapterType ?? liveAdapterFor(live, params.agentId) ?? null,
          trialBudget: budget,
          trialAdapters: live.trialAdapters ?? {},
        });
        if (d.kind === 'decide') {
          // The enforced entry REPLACES any event-time shadow entry for this
          // runId (host order: started queued one before the hook ran), so
          // the run counts exactly once until the tick merges the queues.
          const shadowQueue = pendingShadow.get(params.companyId) ?? [];
          const keptShadow = shadowQueue.filter(q => q.runId !== selfId);
          if (keptShadow.length !== shadowQueue.length) pendingShadow.set(params.companyId, keptShadow);
          const emitAdapter = params.adapterType ?? liveAdapterFor(live, params.agentId) ?? null;
          const decorated = decoratedModelFor(d, emitAdapter);
          const queue = pendingEnforced.get(params.companyId) ?? [];
          queue.push({
            runId: String(params.runId ?? 'unknown'),
            agentId: String(params.agentId ?? 'unknown'),
            actualModel: 'unknown',
            actualModelSource: null,
            actualModelError: null,
            actualPending: true,
            wouldModel: decorated ?? `${d.model}(${d.effort ?? 'default'})`,
            modelMatch: null,
            account: d.accountId,
            accountId: d.accountId,
            rung: d.rung,
            trial: d.trial === true,
            family: inferFamily(canonicalModelName(d.model)),
            reason: d.reason,
            at: clock(),
            enforced: true,
          });
          pendingEnforced.set(params.companyId, queue.slice(-200));
          return {
            kind: 'decide',
            decisionId: d.decisionId,
            model: decorated ?? d.model,
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
