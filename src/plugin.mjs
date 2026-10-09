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
 * true for the company. Every enforced decision is recorded in the ledger
 * (flagged `enforced:true`); the next tick persists the same records.
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
import {
  computeEeeComposite, blendQ, blendAlphaForRole, eeeUsable, eeeFamilyPrior,
  eeeGateDatum,
  DEFAULT_EEE_WEIGHTS, DEFAULT_EEE_BLEND_DOER, DEFAULT_EEE_BLEND_THINKER,
  DEFAULT_EEE_MAX_AGE_DAYS, DEFAULT_EEE_FIRST_PARTY_DISCOUNT,
  DEFAULT_EEE_DECAY_HALF_LIFE_DAYS,
} from './eee.mjs';
import { fillCosts } from './cost.mjs';
import { buildLadder } from './ladder.mjs';
import {
  armTierCost, armTierCap, tierCapsByModel, tierModelKey, fleetBaselineForModels,
} from './tiers.mjs';
import {
  scheduleError, stepController, stepRateController, appendUtilReading,
  measuredRatePerHour, requiredRatePerHour, orderAccounts, DEFAULT_PACING,
} from './pacing.mjs';
import { decide, DEFAULT_ROLE_BANDS, DEFAULT_CONTEXT_CAPS, DEFAULT_TRIALS, normalizeExcludedFamilies, filterRungsByExcludedFamilies, rungsHaveEligibleArms } from './decide.mjs';
import {
  BREAKER_KEY, BREAKER_MAX_SEEN, BREAKER_ERROR_TEXT_MAX, DEFAULT_BREAKERS,
  sanitizeBreakers, classifyArmError, breakerState,
  filterBreakerRungs, breakerProbeRunId, recordArmFailure, startProbe,
  resolveProbe, breakerHousekeep, breakerReport, breakerStoreFromJSON,
  breakerStoreToJSON, createBreakerStore,
} from './breakers.mjs';
import { computeConcurrencyTarget, distributeCaps, distributeWeightedCaps, allocateDemandCaps, DEFAULT_CONCURRENCY } from './concurrency.mjs';
import { orderAccountsForRun } from './select.mjs';
import { SHADOW_CAPACITY } from './shadow.mjs';
import {
  createLedger, ledgerFromJSON, ledgerToJSON, recordStart, recordDecision,
  recordTerminal, calibrationAccount, decidedCount, isInflight, inflightByAccount,
  trialInflight, reconcileLedger, startedOnCountWhere,
  terminalRecords, shadowEntries, trimLedger, mergeLedger, migrateLegacy,
  isLedgerTerminal as isTerminalStatus, TRIAL_WINDOW_MS, LEDGER_CAP,
} from './ledger.mjs';
import { manifest, LANE_BASE_URL_ALLOWLIST } from './manifest.mjs';

const NS = 'model-capacity';
const AA_KEY = 'aa-snapshot-v1';
const TRIAL_KEY = 'trial-families-v1';
const PACING_KEY = 'pacing-v1';
const CAPACITY_KEY = 'capacity-v1';
const LADDER_KEY = 'ladder-v1';
const RATE_KEY = 'rate-history-v1';
const RUNEVT_KEY = 'run-events-v1';

/**
 * Run ledger persisted per company: one record per runId (starts, decisions,
 * terminals). No db access: run facts come from SDK surfaces, never core
 * tables. Legacy runs-v1 / shadow-ring-v1 / terminal-runs-v1 keys are read
 * once for upgrade migration, then never written again.
 */
const LEDGER_KEY = 'ledger-v1';
const LEGACY_RUNS_KEY = 'runs-v1';
const LEGACY_RING_KEY = 'shadow-ring-v1';

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
  for (const [k, v] of Object.entries(raw.eee?.weights ?? {})) {
    if (typeof v !== 'number' || !(v >= 0)) errors.push(`eee.weights.${k} must be a non-negative number`);
  }
  for (const [k, v] of Object.entries(raw.eeeWeights ?? {})) {
    if (typeof v !== 'number' || !(v >= 0)) errors.push(`eeeWeights.${k} must be a non-negative number`);
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
    for (const k of ['thinkerAgentIds', 'doerAgentIds']) {
      if (k in roles && !Array.isArray(roles[k])) errors.push(`roles.${k} must be an array`);
    }
    if ('excludeFamilies' in roles) {
      const ef = roles.excludeFamilies;
      if (ef == null || typeof ef !== 'object' || Array.isArray(ef)) {
        errors.push('roles.excludeFamilies must be an object of role to families');
      } else {
        for (const [rk, rv] of Object.entries(ef)) {
          if (!['doer', 'thinker', 'other'].includes(rk)) {
            errors.push(`roles.excludeFamilies.${rk} is not a known role`);
          } else if (!Array.isArray(rv) || rv.some(f => typeof f !== 'string')) {
            errors.push(`roles.excludeFamilies.${rk} must be an array of strings`);
          }
        }
      }
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
    if ('roles' in raw.trials && (!Array.isArray(raw.trials.roles) || raw.trials.roles.some(r => typeof r !== 'string'))) {
      errors.push('trials.roles must be an array of role names');
    }
  }
  if (raw.modelAaOverrides != null && (typeof raw.modelAaOverrides !== 'object' || Array.isArray(raw.modelAaOverrides))) {
    errors.push('modelAaOverrides must be an object of CLIProxy model id to AA slug');
  }
  if (raw.enforce != null && typeof raw.enforce !== 'boolean') errors.push('enforce must be a boolean');
  if (raw.breakers != null && (typeof raw.breakers !== 'object' || Array.isArray(raw.breakers))) {
    errors.push('breakers must be an object');
  } else if (raw.breakers) {
    const b = raw.breakers;
    if (b.enabled != null && typeof b.enabled !== 'boolean') errors.push('breakers.enabled must be a boolean');
    if (b.tripCount != null && (!Number.isInteger(b.tripCount) || b.tripCount < 1)) errors.push('breakers.tripCount must be an integer >= 1');
    if (b.windowMin != null && !(b.windowMin > 0)) errors.push('breakers.windowMin must be a positive number');
    if (b.cooloffHours != null && !(b.cooloffHours > 0)) errors.push('breakers.cooloffHours must be a positive number');
    if (b.maxCooloffHours != null && !(b.maxCooloffHours > 0)) errors.push('breakers.maxCooloffHours must be a positive number');
    if (b.maxCooloffHours != null && b.cooloffHours != null && b.maxCooloffHours < b.cooloffHours) {
      errors.push('breakers.maxCooloffHours must be >= breakers.cooloffHours');
    }
    if (b.probeTimeoutMs != null && !(b.probeTimeoutMs > 0)) errors.push('breakers.probeTimeoutMs must be a positive number');
    for (const k of ['fatalPatterns', 'vetoPatterns']) {
      if (k in b && !Array.isArray(b[k])) errors.push(`breakers.${k} must be an array of strings`);
      else if (Array.isArray(b[k]) && b[k].some(s => typeof s !== 'string')) errors.push(`breakers.${k} must be an array of strings`);
    }
  }
  return errors;
}

/**
 * Scrub merged EEE weights: a non-numeric/negative override falls back to
 * the research default for known metrics (a string weight must neither zero
 * the metric nor drop it) and is dropped for unknown keys.
 */
function sanitizeEeeWeights(weights) {
  const out = { ...weights };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      if (k in DEFAULT_EEE_WEIGHTS) out[k] = DEFAULT_EEE_WEIGHTS[k];
      else delete out[k];
    }
  }
  return out;
}

/**
 * Provider-side failure text from a run event, across every known placement
 * (payload, payload.run). Codes ride along: a bare `auth_unavailable` code
 * classifies on its own. Joined unique parts, bounded; null when absent. The
 * ledger stores it on failed records only, where the breaker reads it.
 */
export function extractRunErrorText(event) {
  const FIELDS = ['error', 'errorMessage', 'error_message', 'errorText', 'error_text',
    'failureReason', 'failure_reason', 'code', 'errorCode', 'error_code'];
  const parts = [];
  const seen = new Set();
  const p = event?.payload && typeof event.payload === 'object' ? event.payload : null;
  const scopes = [p, p?.run && typeof p.run === 'object' ? p.run : null];
  for (const s of scopes) {
    if (!s) continue;
    for (const f of FIELDS) {
      const v = s[f];
      if ((typeof v !== 'string' && typeof v !== 'number') || seen.has(String(v))) continue;
      const t = String(v).trim();
      if (t.length === 0) continue;
      seen.add(String(v));
      parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join(' | ').slice(0, BREAKER_ERROR_TEXT_MAX) : null;
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
      doerAgentIds: (Array.isArray(raw.roles?.doerAgentIds) ? raw.roles.doerAgentIds : []).filter(id => typeof id === 'string'),
      excludeFamilies: {
        doer: normalizeExcludedFamilies(raw.roles?.excludeFamilies?.doer),
        thinker: normalizeExcludedFamilies(raw.roles?.excludeFamilies?.thinker),
        other: normalizeExcludedFamilies(raw.roles?.excludeFamilies?.other),
      },
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
      // rateMinDeadbandPerHour retired (v0.2.8): the rate deadband is
      // relative-only, so a legacy value here is accepted and ignored.
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
    // through adapters that opt in for roles that opt in (default doer +
    // other; thinkers never), capped in flight per account and per family,
    // until measured success graduates them.
    trials: {
      maxInFlightPerAccount: raw.trials?.maxInFlightPerAccount ?? DEFAULT_TRIALS.maxInFlightPerAccount,
      maxInFlightPerFamily: raw.trials?.maxInFlightPerFamily ?? DEFAULT_TRIALS.maxInFlightPerFamily,
      minRuns: raw.trials?.minRuns ?? DEFAULT_TRIALS.minRuns,
      minSuccessRate: raw.trials?.minSuccessRate ?? DEFAULT_TRIALS.minSuccessRate,
      adapters: raw.trials?.adapters ?? DEFAULT_TRIALS.adapters,
      roles: (Array.isArray(raw.trials?.roles) ? raw.trials.roles : [...DEFAULT_TRIALS.roles]).filter(r => typeof r === 'string'),
    },
    // Operator extensions to the AA-slug override table (CLIProxy model
    // id -> AA slug or { slug, effort }); merged over the built-in table.
    modelAaOverrides: raw.modelAaOverrides ?? {},
    // EEE benchmark prior (Phase 2): secondary quality signal blended beside
    // AA. Every default keeps today's AA-only behavior when the artifact is
    // absent or stale (> eeeMaxAgeDays): bit-for-bit identical output. Flat
    // keys merge OVER their nested versions, as the manifest documents; a
    // non-numeric weight never survives (the default holds that metric).
    eee: {
      blendDoer: raw.eeeBlendDoer ?? raw.eee?.blendDoer ?? DEFAULT_EEE_BLEND_DOER,
      blendThinker: raw.eeeBlendThinker ?? raw.eee?.blendThinker ?? DEFAULT_EEE_BLEND_THINKER,
      weights: sanitizeEeeWeights({ ...DEFAULT_EEE_WEIGHTS, ...(raw.eee?.weights ?? {}), ...(raw.eeeWeights ?? {}) }),
      maxAgeDays: raw.eeeMaxAgeDays ?? raw.eee?.maxAgeDays ?? DEFAULT_EEE_MAX_AGE_DAYS,
      firstPartyDiscount: raw.eeeFirstPartyDiscount ?? raw.eee?.firstPartyDiscount ?? DEFAULT_EEE_FIRST_PARTY_DISCOUNT,
      decayHalfLifeDays: raw.eeeDecayHalfLifeDays ?? raw.eee?.decayHalfLifeDays ?? DEFAULT_EEE_DECAY_HALF_LIFE_DAYS,
    },
    shadowMaxEntries: raw.shadow?.maxEntries ?? SHADOW_CAPACITY,
    // Anchor for per-run burn when CLIProxy deltas are not yet calibrated
    // for an account (research example value; flagged calibration: weak).
    calibration: {
      referenceArmId: raw.calibration?.referenceArmId ?? 'claude-haiku-5-5',
      referenceBurnPerRunPct: raw.calibration?.referenceBurnPerRunPct ?? 0.0005,
    },
    // Arm circuit breaker: provider-side model errors open a per-arm breaker
    // (2 arm-fatal failures in 30 min -> 6h cool-off, doubling to 48h) with a
    // half-open single-probe recovery. Nested only; sanitizeBreakers coerces.
    breakers: sanitizeBreakers(raw.breakers),
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
  const ledgers = new Map(); // companyId -> Map(runId -> ledger record), the single run-accounting truth
  const ledgerReady = new Set(); // companyIds whose memory ledger absorbed persisted state
  const breakerStores = new Map(); // companyId -> breaker store (memory truth; tick persists)
  const breakerReady = new Set(); // companyIds whose breaker store absorbed persisted state
  const breakerLoads = new Map(); // companyId -> in-flight first-load promise (single-flight)
  const lastTickAtMs = new Map(); // companyId -> ms of the last successful tick (memory-only reporting stat)
  const runEventStats = new Map(); // companyId -> { seen, lastAtMs, lastRunId } (persisted each tick)
  const caches = new Map(); // companyId -> CliproxyCache
  // Live view per company, populated by every tick for the memory-only
  // resolve hook: { atMs, enforce, thinkerAgentIds, doerAgentIds,
  //   excludeFamilies, roleBands, contextCaps,
  //   accounts: [{ accountId, pointer, headroomPct, remainingKnown,
  //   ladderRungs, burnPerRunPct }] } in reset order.
  const liveViews = new Map();
  // Hook and event-time decisions write straight into the memory ledger
  // (no queues): the next tick persists the same records it reads.
  // Last resolved config per company, for the memory-only event-time path
  // (the event handler performs zero I/O, so it reads this, not ctx.config).
  const lastConfig = new Map();
  // Reconciliation marks (never deletes): every tick, non-terminal ledger
  // records anchored outside the in-flight horizon are flagged `unverified`
  // and excluded from counting. Idempotent, so no once-flag is needed and a
  // tick that dies mid-write simply retries on the next tick.
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
      return { accounts: [], source: 'no-secret', atMs: nowMs, modelStats: null, pricingTiers: [], eeeSnapshot: null };
    }
    const body = await cliproxyLaneGet(companyId, config);
    const parsed = parseLaneBody(body, nowMs);
    if (!parsed) throw new Error('cliproxy-lane-parse-failed');
    // EEE prior rides the same lane body (`eeeScores` key, same pattern as
    // the existing `modelStats`/`pricingTiers` keys): absent or malformed
    // means AA-only.
    const eee = body?.eeeScores && typeof body.eeeScores === 'object' ? body.eeeScores : null;
    const snapshot = {
      accounts: parsed.accounts, atMs: nowMs, source: 'cliproxy-lane', observedAtMs: parsed.observedAtMs,
      modelStats: parsed.modelStats, pricingTiers: parsed.pricingTiers, eeeSnapshot: eee,
    };
    cache.set('accounts', snapshot, nowMs);
    return snapshot;
  }

  // doer/thinker/other from the agent lists: thinkers first, then the
  // engineering cohort when roles.doerAgentIds is set; everyone else is
  // 'other'. With no doerAgentIds the legacy rule holds (non-thinker = doer).
  function roleOf(config, agentId) {
    const roles = config?.roles ?? {};
    if (Array.isArray(roles.thinkerAgentIds) && roles.thinkerAgentIds.includes(agentId)) return 'thinker';
    const doers = Array.isArray(roles.doerAgentIds) ? roles.doerAgentIds : [];
    if (doers.length === 0) return 'doer';
    return doers.includes(agentId) ? 'doer' : 'other';
  }

  /** Effective family exclusions for a role (already sanitized by resolveConfig). */
  function excludedFamiliesForRole(config, role) {
    const ef = config?.roles?.excludeFamilies ?? {};
    const list = ef?.[role] ?? [];
    return Array.isArray(list) ? list : [];
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

  function buildAccountLadders({ accounts, aaSnapshot, eeeSnapshot = null, config, previousLadders, stateKeys = null, trialState = null, tierFeed = null, nowMs = null }) {
    // EEE prior: usable only when the artifact is fresh; otherwise every
    // arm keeps its AA-only score (bit-for-bit identical to today).
    const tickNow = nowMs ?? clock();
    const eeeLive = eeeUsable(eeeSnapshot, { nowMs: tickNow, maxAgeDays: config.eee.maxAgeDays })
      ? eeeSnapshot.scores : null;
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
    // Context-tier costing (see tiers.mjs): C_eff = base x E[multiplier]
    // per arm, ordered by the EFFECTIVE cost. The fleet baseline (median E
    // over tiered models with measured stats) prices tiered-but-unmeasured
    // arms -- never the cheap tier, never dropped.
    const tierModels = [];
    {
      const seen = new Set();
      for (const a of arms) {
        if (a?.model && !seen.has(a.model)) {
          seen.add(a.model);
          tierModels.push(a.model);
        }
      }
    }
    const tierBaseline = fleetBaselineForModels(
      tierModels, tierFeed?.pricingTiers, tierFeed?.modelStats);
    const tierCostOf = (arm, base) => armTierCost({
      model: arm.model, costBase: base,
      pricingTiers: tierFeed?.pricingTiers, modelStats: tierFeed?.modelStats,
      baseline: tierBaseline,
    });
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
      // EEE blend: null Q_eee (no informing rows) keeps Q_aa untouched, so
      // unmeasured arms (e.g. haiku-5-5) are neither helped nor harmed. The
      // ladder Pareto-orders on the DOER blend; the thinker blend rides
      // qThinker per arm so decide() sorts thinkers on their own alpha.
      const eeeScored = eeeLive
        ? computeEeeComposite(served, eeeLive, {
          weights: config.eee.weights, nowMs: tickNow,
          firstPartyDiscount: config.eee.firstPartyDiscount,
          decayHalfLifeDays: config.eee.decayHalfLifeDays,
        })
        : null;
      const alphaDoer = eeeLive ? blendAlphaForRole('doer', { doer: config.eee.blendDoer, thinker: config.eee.blendThinker }) : 0;
      const alphaThinker = eeeLive ? blendAlphaForRole('thinker', { doer: config.eee.blendDoer, thinker: config.eee.blendThinker }) : 0;
      const costs = fillCosts(served.map(a => ({
        armId: a.armId,
        cost: a.row.intelligenceIndexCostPerTask,
        priceIn: a.row.price1mInputTokens,
        priceOut: a.row.price1mOutputTokens,
      })));
      const eeeByArm = new Map();
      const eligible = served.map(a => {
        const base = costs.get(a.armId)?.C ?? null;
        const tier = tierCostOf(a, base);
        const qAa = scored.get(a.armId)?.Q ?? null;
        const qEee = eeeScored?.get(a.armId)?.Qeee ?? null;
        eeeByArm.set(a.armId, {
          qAa, qEee,
          qBlended: blendQ(qAa, qEee, alphaDoer),
          qThinker: blendQ(qAa, qEee, alphaThinker),
          eeePrior: eeeScored?.get(a.armId) ?? null,
        });
        return {
          armId: a.armId,
          Q: blendQ(qAa, qEee, alphaDoer),
          // Ladder order runs on EFFECTIVE cost (tier-adjusted). Quota burn
          // below stays on base cost: price cliffs change money, not tokens.
          C: tier.costEffective ?? base,
          coverage: scored.get(a.armId)?.coverage ?? 0,
          costBase: base,
          costMultiplier: tier.costMultiplier,
          costEffective: tier.costEffective,
          tierSource: tier.tierSource,
          statsRequests: tier.statsRequests,
        };
      });
      const eligibleByArm = new Map(eligible.map(e => [e.armId, e]));
      // Rung-level CI gate (§5): newcomer displacements blocked within noise
      // need the comparison-metric datum per arm. Null map (no fresh EEE
      // artifact) keeps pinning bit-for-bit identical to today.
      const gateByArm = eeeScored
        ? new Map([...eeeScored].map(([armId, e]) => [armId, eeeGateDatum(e)]))
        : null;
      // The CI rung gate holds across ticks: last tick's withinNoise pairs
      // ride back in as heldPairs, so a held challenger stays gated against
      // its incumbent until the 95% bar clears (see ladder.mjs).
      const prev = previousLadders?.[keyOf(account, i)] ?? {};
      const { rungs, dominated, dropped, withinNoise } = buildLadder(
        eligible, prev.rungs ?? [], gateByArm, prev.withinNoise ?? []);
      ladders[keyOf(account, i)] = {
        rungs: rungs.map(r => {
          const arm = byArm.get(r.armId);
          const tier = eligibleByArm.get(r.armId);
          const eq = eeeByArm.get(r.armId) ?? {};
          return {
            ...r,
            model: arm.model,
            effort: arm.effort,
            family: arm.family,
            trial: !isProvenFamily(trialState, arm.family),
            contextWindow: arm.row.contextWindowTokens ?? null,
            costEstimated: costs.get(r.armId)?.estimated ?? false,
            costBase: tier?.costBase ?? null,
            costMultiplier: tier?.costMultiplier ?? 1,
            costEffective: tier?.costEffective ?? tier?.costBase ?? null,
            tierSource: tier?.tierSource ?? 'none',
            statsRequests: tier?.statsRequests ?? 0,
            // EEE blend audit trail: null qEee / null eeePrior means the arm
            // scored AA-only (no informing rows or no fresh artifact).
            qAa: eq.qAa ?? null,
            qEee: eq.qEee ?? null,
            qBlended: eq.qBlended ?? r.Q,
            qThinker: eq.qThinker ?? null,
            eeePrior: eq.eeePrior?.Qeee ?? null,
          };
        }),
        dominated,
        dropped,
        withinNoise,
        burnPerRunPct: Object.fromEntries(eligible.map(e => [e.armId, burnFor(costs.get(e.armId)?.C ?? null)])),
      };
    }
    // Feasibility-gated compact windows per MODEL (most constraining cap
    // wins per model key). Family-keyed caps leak one model's window onto
    // untiered same-family siblings, so each rung arm carries its own cap
    // and decide() reads it off the chosen arm.
    const tierCaps = tierCapsByModel(arms.map(a => ({
      model: a.model,
      cap: armTierCap({
        model: a.model,
        pricingTiers: tierFeed?.pricingTiers, modelStats: tierFeed?.modelStats,
      }),
    })));
    for (const key of Object.keys(ladders)) {
      for (const r of ladders[key].rungs) {
        r.cap = tierCaps[tierModelKey(r.model)] ?? null;
      }
    }
    const blocked = Object.entries(ladders).flatMap(([key, l]) =>
      (l.withinNoise ?? []).map(w => ({ account: key, ...w })));
    return { ladders, skipped, arms: arms.map(a => a.armId), unscored, tierCaps, tierBaseline, withinNoise: blocked };
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
   * SDK client reads use the declared plugin-context contract, positional:
   * `PluginIssuesClient.get(issueId, companyId)` /
   * `PluginAgentsClient.get(agentId, companyId)`
   * (@paperclipai/plugin-sdk dist/types.d.ts). The wire params object form
   * (`{ issueId, companyId }`) belongs to the lower-level host-client
   * layer, NOT ctx: passed to ctx it lands in the id slot, companyId
   * arrives undefined, and the host logs "companyId is required" on EVERY
   * lookup (then the call fails). So there is deliberately no object-form
   * attempt and no retry -- one call, companyId always present.
   */
  const issueGet = (issueId, companyId) => ctx.issues.get(issueId, companyId);
  const agentGet = (agentId, companyId) => ctx.agents.get(agentId, companyId);

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
      const agent = await agentGet(agentId, companyId);
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
          const issue = await issueGet(run.issueId, companyId);
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
          const agent = await agentGet(run.agentId, companyId);
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
   * The memory ledger for a company, absorbing persisted state once:
   * the ledger key when present, else a one-time upgrade migration from
   * the legacy runs/shadow-ring keys (kept read-only for that path).
   * Pre-tick hook/event-time decisions already in memory merge over the
   * persisted base without dropping it.
   */
  // Single-flight loads: concurrent ticks (restart, overlapping runs)
  // share one load promise per company instead of each reading state and
  // last-writer-wins clobbering the other's in-memory overlay. The merge
  // reads the CURRENT map entry AFTER the awaits, so runs recorded while
  // the state read was pending (run events, event-time and hook decisions
  // below) are merged in, never overwritten. Every writer goes through
  // getOrLoadLedger -- nothing else calls ledgers.set.
  const ledgerLoads = new Map();
  // Companies whose ledger-v1 load succeeded since worker start. The tick
  // persists ledger-v1 ONLY for these: persisting after a failed load would
  // overwrite the saved ledger with the (often empty) memory overlay.
  // ledgerReady short-circuits repeat loads; loadedOk gates the persist.
  const loadedOk = new Set();
  function ensureLedger(companyId) {
    let ledger = ledgers.get(companyId);
    if (!ledger) {
      ledger = createLedger();
      ledgers.set(companyId, ledger);
    }
    return ledger;
  }
  async function loadLedger(companyId) {
    const ready = ledgers.get(companyId);
    if (ledgerReady.has(companyId)) return ready ?? ensureLedger(companyId);
    let pending = ledgerLoads.get(companyId);
    if (!pending) {
      pending = (async () => {
        const persisted = ledgerFromJSON(await ctx.state.get(scopeKey(companyId, LEDGER_KEY)));
        let ledger;
        if (persisted.size > 0) {
          ledger = mergeLedger(persisted, ledgers.get(companyId));
        } else {
          const legacy = migrateLegacy({
            runs: await ctx.state.get(scopeKey(companyId, LEGACY_RUNS_KEY)),
            ringEntries: await ctx.state.get(scopeKey(companyId, LEGACY_RING_KEY)),
          });
          ledger = mergeLedger(legacy, ledgers.get(companyId));
        }
        ledgers.set(companyId, ledger);
        ledgerReady.add(companyId);
        loadedOk.add(companyId);
        return ledger;
      })();
      ledgerLoads.set(companyId, pending);
      pending.then(
        () => { ledgerLoads.delete(companyId); },
        () => { ledgerLoads.delete(companyId); },
      );
    }
    return pending;
  }
  // The entry point for MEMORY-ONLY run recording (run events, event-time
  // and hook decisions). A state outage must never block run starts: a failed
  // load falls back to the memory ledger and logs. Deliberately NOT used by
  // the tick: the tick calls loadLedger directly so a failed load aborts
  // before any persist (see the loadedOk guard at the ledger persist).
  async function getOrLoadLedger(companyId) {
    if (ledgerReady.has(companyId)) return ledgers.get(companyId) ?? ensureLedger(companyId);
    try {
      return await loadLedger(companyId);
    } catch (error) {
      ctx.logger.error('model-capacity: ledger load failed, memory-only', { companyId, error: error?.message ?? String(error) });
      return ensureLedger(companyId);
    }
  }

  async function runShadowTick(companyId, job) {
    const nowMs = clock();
    const raw = await ctx.config.get(companyId);
    const config = resolveConfig(raw);
    // In-flight horizon: a run with no terminal event stops counting after
    // max(3 x mean run duration, 2h). The 2h floor keeps the horizon at the
    // ledger's memory even when the duration calibrates short; terminal runIds
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
    // Arm circuit breaker: memory truth loaded once per worker start (like the
    // ledger); every tick reuses it and persists it below. Finished-run
    // failed events feed it after the ledger load -- never in the event path,
    // which performs zero I/O -- via the error text recordTerminal stamps on
    // failed records. A throw here aborts the tick before any persist, same
    // as the ledger direct load.
    if (!breakerReady.has(companyId)) {
      // Single-flight first load (mirrors ledgerLoads): overlapping first
      // ticks share one read, and ready is marked ONLY after it succeeds --
      // a failed read aborts this tick with ready unset, so the next tick
      // retries the load instead of persisting an empty store over the saved
      // open/half-open breakers.
      let pending = breakerLoads.get(companyId);
      if (!pending) {
        pending = (async () => breakerStoreFromJSON(await ctx.state.get(scopeKey(companyId, BREAKER_KEY))))();
        breakerLoads.set(companyId, pending);
      }
      try {
        breakerStores.set(companyId, await pending);
        breakerReady.add(companyId);
      } finally {
        if (breakerLoads.get(companyId) === pending) breakerLoads.delete(companyId);
      }
    }
    // One state key per snapshot entry (never a merged series): see
    // uniqueAccountKeys. `keyOf` keeps ladders aligned with the same keys.
    const stateKeys = uniqueAccountKeys(snapshot.accounts);
    const { ladders, skipped, unscored, tierCaps, tierBaseline, withinNoise } = buildAccountLadders({
      accounts: snapshot.accounts, aaSnapshot, eeeSnapshot: snapshot.eeeSnapshot ?? null, config, previousLadders: prevLadders, stateKeys, trialState,
      tierFeed: { modelStats: snapshot.modelStats, pricingTiers: snapshot.pricingTiers }, nowMs,
    });
    // Breaker state rides each rung arm so ops can see why an arm is
    // unpickable; decide-time filtering (tick loop, live view) does the actual
    // excluding. Breaker account space is the ladder key (view accountId).
    {
      const breakersCfg = config.breakers ?? DEFAULT_BREAKERS;
      const breakers = breakerStores.get(companyId) ?? createBreakerStore();
      for (const [key, ladder] of Object.entries(ladders ?? {})) {
        for (const r of ladder?.rungs ?? []) {
          r.breaker = breakerState(breakers, key, r?.armId, nowMs, breakersCfg);
        }
      }
    }
    // Tier-derived compact windows ride each rung arm (arm.cap, keyed by
    // model) into the hook and event-time paths via the live view below as
    // well as this tick's own decisions. No family-keyed merge: one model's
    // window must never scope onto its siblings. tierCaps (by model) still
    // rides the /capacity body below for visibility.
    // §5 audit trail: challengers held at the incumbent's rung by the CI
    // gate are logged, never silent.
    if ((withinNoise ?? []).length > 0) {
      ctx.logger.info('model-capacity: EEE rung challenges within noise', { companyId, withinNoise });
    }

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
      let step = stepRateController(nextPacing[key] ?? { pointer: 0, lastMoveAtMs: 0, guardActive: false },
        {
          measuredRatePerHour: measured?.ratePerHour ?? null,
          requiredRatePerHour: required ?? 0,
          positionError,
          fiveHourUsedPct: fiveHourUsed,
        }, nowMs, config.pacing, ceiling);
      // Unhealthy accounts allocate nothing (the order filter drops them),
      // so the controller must not narrate them as holding a bound: freeze
      // the pointer and report excluded, resuming from the frozen pointer
      // when the account returns.
      if (account.health !== 'healthy') {
        const prev = nextPacing[key] ?? {};
        step = {
          pointer: Math.min(Math.max(prev.pointer ?? step.pointer, 0), Math.max(ceiling, 0)),
          lastMoveAtMs: prev.lastMoveAtMs ?? step.lastMoveAtMs,
          guardActive: false,
          rateBasis: prev.rateBasis ?? null,
          action: 'excluded',
          reason: `excluded: health is ${account.health ?? 'unknown'} -- only healthy accounts allocate`,
        };
      }
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
        arms: (ladders[key]?.rungs ?? []).map(r => ({
          armId: r.armId, model: r.model, effort: r.effort, family: r.family,
          rung: r.rung, trial: r.trial,
          breaker: r.breaker ?? 'closed',
          cap: r.cap ?? null,
          costBase: r.costBase ?? null,
          costMultiplier: r.costMultiplier ?? 1,
          costEffective: r.costEffective ?? r.costBase ?? null,
          tierSource: r.tierSource ?? 'none',
          statsRequests: r.statsRequests ?? 0,
        })),
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

    // Run ledger: the single source of truth (starts, decisions, terminals
    // by runId). Calibration counts runs that actually burned each
    // account's quota inside the measured span (model-mapped, never the
    // decision); in-flight pressure attributes decided-first (see below).
    const rateWindowMs = config.pacing.rateWindowMin * 60000;
    // Direct load: a throw here aborts the tick before any persist, so a
    // failed post-restart read can never wipe the saved ledger. The next
    // tick retries the load (rejected loads are not cached).
    const ledger = await loadLedger(companyId);
    // Arm circuit breaker: memory truth loaded once per worker start (like the
    // ledger); every tick reuses it and persists it below. Finished-run
    // failed events feed it here -- never in the event path, which performs
    // zero I/O -- via the error text recordTerminal stamps on failed records.
    const breakersCfg = config.breakers ?? DEFAULT_BREAKERS;
    const breakers = breakerStores.get(companyId) ?? createBreakerStore();
    breakerStores.set(companyId, breakers);
    const breakerTransitions = [...breakerHousekeep(breakers, nowMs, breakersCfg)];
    {
      const seen = new Set(breakers.seen ?? []);
      for (const rec of terminalRecords(ledger)) {
        if (rec?.runId == null || seen.has(rec.runId)) continue;
        seen.add(rec.runId);
        const acct = rec.decidedAccount ?? rec.actualAccount ?? null;
        const arm = rec.armId ?? null;
        // Only plugin-decided runs feed the breaker: without our (account,
        // arm) attribution there is nothing to exclude.
        if (acct == null || arm == null) continue;
        if (rec.status === 'finished') {
          const t = resolveProbe(breakers, acct, arm, rec.runId, 'success', null, nowMs, breakersCfg);
          if (t) breakerTransitions.push(t);
        } else if (rec.status === 'failed') {
          const fatal = classifyArmError(rec.errorText, breakersCfg) === 'fatal';
          if (breakerProbeRunId(breakers, acct, arm, nowMs, breakersCfg) === rec.runId) {
            const t = resolveProbe(breakers, acct, arm, rec.runId, fatal ? 'arm-fatal' : 'other', rec.errorText, nowMs, breakersCfg);
            if (t) breakerTransitions.push(t);
          } else if (fatal) {
            const t = recordArmFailure(breakers, acct, arm,
              { atMs: rec.terminalAt ?? nowMs, errorText: rec.errorText }, nowMs, breakersCfg);
            if (t) breakerTransitions.push(t);
          }
        } else if (rec.status === 'cancelled') {
          const t = resolveProbe(breakers, acct, arm, rec.runId, 'other', null, nowMs, breakersCfg);
          if (t) breakerTransitions.push(t);
        }
      }
      breakers.seen = [...seen].slice(-BREAKER_MAX_SEEN);
    }
    for (const t of breakerTransitions) {
      ctx.logger.info(`model-capacity: arm breaker ${t.transition}`, { companyId, ...t });
    }
    const modelCaches = { agents: new Map(), issues: new Map() };
    const accountOfModel = (model) => (model != null && model !== 'unknown'
      ? accountForRun({ model }, snapshot.accounts)
      : null);
    // Resolved-actual backfill: run events often name no model, so records
    // stay unmapped until the actual model resolves (run-event first, then
    // the issue override, then the agent config). A terminal run-decision
    // (payload.modelDecision: what the run actually used) is authoritative
    // and overwrites earlier guesses. Backfill fills the ledger's actual
    // fields only -- attribution prefers the decided account, so a decision
    // never loses to the agent-config guess. Fresh records first, 20 model
    // resolutions per tick; mapping already-known models is free.
    let backfilledActuals = 0;
    const freshFirst = [...ledger.values()].sort(
      (a, b) => Math.max(b.startedAt ?? 0, b.decidedAt ?? 0) - Math.max(a.startedAt ?? 0, a.decidedAt ?? 0));
    for (const r of freshFirst) {
      const authoritativeModel = (r.eventModelSource === 'run-decision' ? r.eventModel : null)
        ?? (r.actualModelSource === 'run-decision' ? r.actualModel : null);
      if (authoritativeModel != null && (r.actualModel !== authoritativeModel || r.actualModelSource !== 'run-decision')) {
        r.actualModel = authoritativeModel;
        r.actualModelSource = 'run-decision';
        r.actualModelError = null;
        r.actualAccount = accountOfModel(authoritativeModel);
        backfilledActuals += 1;
      } else if ((r.actualModel == null || r.actualModel === 'unknown') && backfilledActuals < 20 && (r.agentId || r.issueId)) {
        const actual = await resolveActualModel(companyId, {
          model: r.eventModel ?? null, modelSource: r.eventModelSource ?? null,
          issueId: r.issueId ?? null, agentId: r.agentId ?? null,
        }, modelCaches);
        if (actual.model != null) {
          r.actualModel = actual.model;
          r.actualModelSource = actual.source;
          r.actualModelError = null;
          r.actualPending = false;
          backfilledActuals += 1;
        } else if (actual.error) {
          r.actualModelError = actual.error;
        }
      }
      if (r.actualAccount == null) {
        const known = r.actualModel != null && r.actualModel !== 'unknown' ? r.actualModel : r.eventModel;
        const mapped = accountOfModel(known);
        if (mapped != null) r.actualAccount = mapped;
      }
      if (r.actualModel != null && r.actualModel !== 'unknown' && r.wouldModel != null && r.modelMatch == null) {
        r.modelMatch = r.actualModel === String(r.wouldModel).split('(')[0] || r.actualModel === r.wouldModel;
      }
      if (r.actualPending === true && r.actualModel != null && r.actualModel !== 'unknown') r.actualPending = false;
    }
    // Adapter gate backfill: trial arms need adapterType and run events
    // usually omit it. Resolve once per agent from the agent record
    // (10-min TTL cache) and stamp it onto the records, so this tick's
    // decisions and the live adapter map reuse it.
    // Runs whose agents do not resolve keep deferring as before.
    {
      const byAgent = new Map();
      for (const r of ledger.values()) {
        if (r.adapterType || !r.agentId || r.agentId === 'unknown') continue;
        if (isTerminalStatus(r.status)) continue;
        if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, []);
        byAgent.get(r.agentId).push(r);
      }
      for (const [agentId, list] of byAgent) {
        const t = await agentAdapterType(companyId, agentId);
        if (t) for (const r of list) r.adapterType = t;
      }
    }
    // Terminal-id memory is the ledger itself: terminal records persist
    // until the shadow TTL trims them, so finished runs never haunt
    // in-flight no matter how stale the rate window is.
    const terminalIds = new Set(terminalRecords(ledger).map(r => r.runId));
    // Allocation targets and provider pools. CLIProxy round-robins lanes
    // of the same provider onto shared credentials, so lane-level in-flight
    // spreading is theater: pressure is real only at the provider bucket.
    const keyToProvider = new Map(stateKeys.map((k, i) =>
      [k, String(snapshot.accounts[i]?.provider ?? String(k).split(':')[0]).toLowerCase()]));
    const poolOfKey = (key) => keyToProvider.get(key) ?? String(key).split(':')[0].toLowerCase();
    // Provider fallback for model-less runs: a run naming only a provider
    // still burned that provider's quota, so calibration and the
    // mapped/unmapped census count it under the first matching account.
    // In-flight attribution never uses this (decided ?? actual, else
    // unattributed) -- it is E-calibration scope only.
    const keyOfProvider = new Map();
    for (const [k, p] of keyToProvider) if (p && !keyOfProvider.has(p)) keyOfProvider.set(p, k);
    // E-calibration burns calibrate where the run ACTUALLY burned
    // (model-mapped actual, provider fallback): a non-enforced shadow pick
    // is a routing guess, not observed burn. Only the enforced hook
    // decision outranks reality.
    const calibrationAccountOf = (r) => calibrationAccount(r, keyOfProvider);
    // Model-mapping census: records with no decided/actual account and no
    // provider fallback (same mapping the calibration span uses below).
    // (In-flight attribution is separate, decided-first.)
    let unmappedRuns = 0;
    for (const r of ledger.values()) {
      if (calibrationAccountOf(r) == null) unmappedRuns += 1;
    }

    // Each account's target share is requiredRate / E (runs/hour it can
    // sustain; proportions match the per-account C* concurrency targets).
    // E prefers measured burn-per-run, then the ladder-average burn, then
    // the calibration reference anchor.
    {
      const refAnchor = config.calibration?.referenceBurnPerRunPct ?? 0.0005;
      const runsInSpan = (key, spanMs) => startedOnCountWhere(ledger, key, nowMs - spanMs, calibrationAccountOf);
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
    for (const rec of terminalRecords(ledger)) {
      if (rec.status !== 'finished' && rec.status !== 'failed') continue;
      if (seenTerminal.has(rec.runId)) continue;
      const canon = canonicalModelName(rec.actualModel);
      if (!canon) continue;
      const family = inferFamily(canon);
      if (!family) continue;
      const c = trialState.counters[family] ?? { finished: 0, failed: 0 };
      if (rec.status === 'finished') c.finished += 1; else c.failed += 1;
      trialState.counters[family] = c;
      seenTerminal.add(rec.runId);
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
    const runsInSpan = (key, spanMs) => startedOnCountWhere(ledger, key, nowMs - spanMs, calibrationAccountOf);
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
          healthy: a.health === 'healthy',
        };
      }),
      meanRunDurationHours: config.concurrency.meanRunDurationHours,
      maxTotal: config.concurrency.maxTotal,
    });

    // Ledger first: hook and event-time decisions since the last tick are
    // already in it (no queues to merge). Restart reconciliation only marks
    // unverifiable records -- it never deletes, so the shadow log survives
    // restarts with enforced flags and terminal history intact. Long runs
    // verify against proof-of-life (a fresh start clears `unverified`) or
    // the stale horizon -- never the 60-min rate window, which would drop
    // still-running runs across restarts.
    const viewById = new Map(accountViews.map(v => [v.accountId, v]));
    const reconciledUnverified = reconcileLedger(ledger, { nowMs, verifyWindowMs: staleHorizonMs });
    // Trial budgets are read fresh from the ledger per candidate and for
    // the live view below (decisions write through, so no carried copy).
    // In-flight census, single pass over the ledger: each record counts at
    // most once, attributed to its decided account first (a decision always
    // outranks the agent-config model guess, so a decided run never counts
    // under its agent's usual account), else its model-mapped account.
    // Age-excluded records report as stale; the old clamp backstop is gone
    // (single-counting is structural now) and reports 0.
    const census = inflightByAccount(ledger, { nowMs, horizonMs: staleHorizonMs });
    const staleInFlightDropped = census.staleExcluded;
    const unverifiedExcluded = census.unverifiedExcluded;
    const clampedInFlightDropped = 0;
    // Per-account in-flight the caps check. Read by the live view, the
    // tick's own cap check, and the capacity report.
    const capInFlightByAccount = { ...census.byAccount };
    const inFlightByPool = {};
    for (const [id, n] of Object.entries(census.byAccount)) {
      const p = poolOfKey(id);
      inFlightByPool[p] = (inFlightByPool[p] ?? 0) + n;
    }
    // Water-filling order, rebuilt per run: need band first, then largest
    // (targetShare - pooled in-flight). Decisions write straight into the
    // ledger, so each candidate re-reads fresh pressure and sequential
    // decisions spread across accounts instead of herding onto one static
    // argmax winner. Same order the hook and the event-time path use (via
    // the live view below).
    const freshPressure = () => {
      const cur = inflightByAccount(ledger, { nowMs, horizonMs: staleHorizonMs });
      const pools = {};
      for (const [id, n] of Object.entries(cur.byAccount)) {
        const p = poolOfKey(id);
        pools[p] = (pools[p] ?? 0) + n;
      }
      return { pools, byAccount: cur.byAccount };
    };
    const allocationOrder = () => {
      const { pools } = freshPressure();
      return orderAccountsForRun(
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
          inFlight: pools[v.pool] ?? 0,
        })),
        { reservePct: 0.05, rateDeadbandRel: config.pacing.rateDeadbandRel },
      );
    };
    // Fresh trial budgets per candidate: decisions write through to the
    // ledger, so re-reading bounds single-tick trial bursts structurally.
    const freshTrialBudget = () => {
      const inFlight = trialInflight(ledger, { nowMs });
      const out = {};
      const fams = new Set(Object.keys(inFlight));
      for (const ladder of Object.values(ladders ?? {})) {
        for (const r of ladder?.rungs ?? []) if (r?.trial && r?.family) fams.add(r.family);
      }
      for (const fam of fams) {
        out[fam] = Math.max(0, config.trials.maxInFlightPerFamily - (inFlight[fam] ?? 0));
      }
      return out;
    };

    // The live view publishes AFTER the candidate loop below, with fresh
    // ledger counts (decisions write straight through, so no fold is
    // needed). The hook and event-time path read that frozen view plus the
    // ledger decisions it does not yet reflect (see decidedRunIds above).

    // Shadow decisions for recently started runs (event feed only).
    // Undecided, started recently, alive: the ledger already holds their
    // starts (and any hook/event-time decisions, which exclude them here).
    const candidates = [...ledger.values()]
      .filter(r => r?.decidedAccount == null && !isTerminalStatus(r?.status)
        && r?.unverified !== true && r?.startedAt != null && nowMs - r.startedAt < 15 * 60 * 1000)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 100);
    const roleBands = {
      thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
      doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
    };
    let observed = 0;
    let shadowSkippedNoDecision = 0;
    for (const run of candidates) {
      const role = roleOf(config, run.agentId);
      let decision = null;
      // Fresh order, cap base, and trial budget per run: decisions write
      // straight into the ledger, so earlier decisions in this tick already
      // narrow the winner's shortfall and consume budget structurally --
      // the next run spreads elsewhere without any pending-side state.
      for (const sel of allocationOrder()) {
        const view = viewById.get(sel.accountId);
        const ladder = ladders[sel.accountId];
        if (!view || !ladder) continue;
        // Reactive accounts qualify without a remaining fraction; metered
        // accounts need one. Reactive lanes are capped in flight per account
        // (default 2): no vendor meter means no burn signal, so the count of
        // running runs is the only backpressure.
        if (!view.reactive && view.remainingPct == null) continue;
        const pressure = freshPressure().byAccount;
        if (view.reactive && (pressure[sel.accountId] ?? 0) >= config.trials.maxInFlightPerAccount) continue;
        // Role-based family exclusions: accounts with no eligible arm for
        // this role are skipped, never deferred on (decide would only find
        // empty rungs there).
        const roleRungs = filterRungsByExcludedFamilies(
          groupByRung(ladder.rungs), excludedFamiliesForRole(config, role));
        if (!rungsHaveEligibleArms(roleRungs)) continue;
        const d = decide({
          runId: run.runId,
          agentId: run.agentId,
          role,
          // Open breakers (and occupied half-open probes) are excluded on
          // top of the role filter: the ladder skips them and decide falls
          // to the next rung or account. Shadow picks never occupy the
          // probe slot -- only enforced hook runs route real traffic, so
          // only the hook calls startProbe.
          ladderRungs: filterBreakerRungs(roleRungs, breakers, sel.accountId, nowMs, breakersCfg),
          excludedFamilies: excludedFamiliesForRole(config, role),
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
          trialBudget: freshTrialBudget(),
          trialAdapters: config.trials.adapters,
          trialRoles: config.trials.roles,
        });
        if (d.kind === 'decide') {
          decision = d;
          break;
        }
      }
      if (decision) {
        // 1M claude runs render decorated so the CLI takes the 1M window;
        // the terminal modelDecision echoes the same string, keeping
        // modelMatch exact.
        const wouldModel = decoratedModelFor(decision, run.adapterType ?? null)
          ?? `${decision.model}(${decision.effort ?? 'default'})`;
        const actual = await resolveActualModel(companyId, {
          model: run.eventModel ?? (run.actualModel !== 'unknown' ? run.actualModel : null),
          modelSource: run.eventModelSource ?? run.actualModelSource ?? null,
          issueId: run.issueId ?? null, agentId: run.agentId ?? null,
        }, modelCaches);
        const actualModel = actual.model ?? run.actualModel ?? 'unknown';
        recordDecision(ledger, {
          runId: run.runId, agentId: run.agentId, accountId: decision.accountId,
          armId: decision.armId ?? null,
          enforced: false, wouldModel, rung: decision.rung,
          trial: decision.trial === true,
          family: inferFamily(canonicalModelName(decision.model)),
          reason: decision.reason, eventTime: false,
        }, nowMs);
        const rec = ledger.get(run.runId);
        if (rec) {
          rec.actualModel = actualModel;
          rec.actualModelSource = actual.model != null ? actual.source : (rec.actualModelSource ?? null);
          // Why the actual model is unknown (codes only, never upstream
          // text); null when the actual model resolved.
          rec.actualModelError = actual.error;
          // False here: the tick resolves actuals synchronously, so nothing
          // is pending. Event-time and hook entries set true until a tick
          // backfills them (see below).
          rec.actualPending = false;
          if (rec.actualAccount == null && actual.model != null) {
            rec.actualAccount = accountOfModel(actual.model);
          }
          // Did shadow agree with reality? Null while the actual model is
          // still unknown; true/false once known.
          rec.modelMatch = actual.model == null ? null : (actual.model === decision.model || actual.model === wouldModel);
        }
        observed += 1;
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

    // Publish the live view the memory-only resolve hook reads. Published
    // AFTER this tick's decisions with fresh ledger counts, so the hook and
    // event-time path water-fill against current pressure until the next
    // tick republishes. No I/O happens in the hook, so everything it needs
    // is frozen here: effective headroom, health/meter/reactive for the
    // eligibility filter, provider + target share + pooled in-flight for
    // water-filling allocation, per-account in-flight for the reactive cap,
    // and the trial budgets + adapters for trial arms.
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
    const liveCensus = inflightByAccount(ledger, { nowMs, horizonMs: staleHorizonMs });
    const livePools = {};
    for (const [id, n] of Object.entries(liveCensus.byAccount)) {
      const p = poolOfKey(id);
      livePools[p] = (livePools[p] ?? 0) + n;
    }
    const liveTrialInFlight = trialInflight(ledger, { nowMs });
    const liveTrialBudget = {};
    {
      const fams = new Set(Object.keys(liveTrialInFlight));
      for (const ladder of Object.values(ladders ?? {})) {
        for (const r of ladder?.rungs ?? []) if (r?.trial && r?.family) fams.add(r.family);
      }
      for (const fam of fams) {
        liveTrialBudget[fam] = Math.max(0, config.trials.maxInFlightPerFamily - (liveTrialInFlight[fam] ?? 0));
      }
    }
    liveViews.set(companyId, {
      atMs: nowMs,
      enforce: config.enforce === true,
      // RunIds whose decisions the frozen counts above already reflect.
      // Hook/event-time pressure is the ledger decisions NOT in this set --
      // structural, so a frozen clock can never double-count the tick's own
      // decisions the way a timestamp comparison does.
      decidedRunIds: new Set([...ledger.values()].filter(r => r?.decidedAccount != null).map(r => r.runId)),
      inFlightByPool: livePools,
      adapterByAgent,
      thinkerAgentIds: config.roles.thinkerAgentIds,
      doerAgentIds: config.roles.doerAgentIds,
      excludeFamilies: config.roles.excludeFamilies,
      roleBands: {
        thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
        doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
      },
      contextCaps: config.contextCaps,
      trialBudget: liveTrialBudget,
      trialAdapters: config.trials.adapters,
      trialRoles: config.trials.roles,
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
          inFlight: liveCensus.byAccount[a.accountId] ?? 0,
          resetAtMs: view?.resetAtMs ?? null,
          measuredRatePerHour: view?.measuredRatePerHour ?? null,
          requiredRatePerHour: view?.requiredRatePerHour ?? null,
          // Breaker-filtered like the tick loop, so the hook and the
          // event-time path never pick an arm the tick would skip.
          ladderRungs: filterBreakerRungs(groupByRung(ladder?.rungs ?? []), breakers, a.accountId, nowMs, breakersCfg),
          burnPerRunPct: ladder?.burnPerRunPct ?? {},
        };
      }),
      rateDeadbandRel: config.pacing.rateDeadbandRel,
    });
    // Event-time decisions that landed since the previous tick (memory-only
    // reporting stat; the ledger itself is the merge).
    const prevTickMs = lastTickAtMs.get(companyId) ?? 0;
    let mergedEventTime = 0;
    for (const r of ledger.values()) {
      if (r.eventTime === true && r.decidedAt != null && r.decidedAt > prevTickMs && r.decidedAt <= nowMs) {
        mergedEventTime += 1;
      }
    }
    lastTickAtMs.set(companyId, nowMs);

    // Trial family report: counters plus graduation status plus live
    // in-flight, so /api/capacity shows what would need to happen for each
    // trial family to graduate. Phase 3 (display-only): a Beta `eeePrior`
    // per trial family from the benchmark Q_eee -- shown, never acted on.
    const trialFamilies = {};
    {
      const fams = new Set([...Object.keys(trialState.counters ?? {}), ...Object.keys(liveTrialBudget)]);
      const eeeLiveForPrior = eeeUsable(snapshot.eeeSnapshot, { nowMs, maxAgeDays: config.eee.maxAgeDays })
        ? snapshot.eeeSnapshot.scores : null;
      const eeeForPrior = eeeLiveForPrior
        ? computeEeeComposite(
          Object.values(ladders).flatMap(l => l?.rungs ?? [])
            .map(r => ({ armId: `${r.family}:${r.armId}`, model: r.model, effort: r.effort })),
          eeeLiveForPrior,
          { weights: config.eee.weights, nowMs, firstPartyDiscount: config.eee.firstPartyDiscount, decayHalfLifeDays: config.eee.decayHalfLifeDays })
        : null;
      for (const fam of fams) {
        const st = trialFamilyStats(trialState, fam);
        let eeePrior = null;
        if (eeeForPrior) {
          const vals = [...eeeForPrior]
            .filter(([armId]) => armId.startsWith(`${fam}:`))
            .map(([, s]) => s.Qeee)
            .filter(v => v != null);
          eeePrior = eeeFamilyPrior(vals);
        }
        trialFamilies[fam] = {
          ...st,
          proven: isProvenFamily(trialState, fam),
          inFlight: liveTrialInFlight[fam] ?? 0,
          budget: liveTrialBudget[fam] ?? 0,
          eeePrior,
        };
      }
    }
    await ctx.state.set(scopeKey(companyId, PACING_KEY), nextPacing);
    await ctx.state.set(scopeKey(companyId, RATE_KEY), rateHistories);
    // The ledger persists AFTER every read above, so a throw anywhere
    // earlier retries the whole tick (including reconciliation, which is
    // idempotent) on the next run. Trim bounds the persisted blob at
    // maxRecords: old terminal, old unverified, and stale-horizon records
    // first, then oldest activity -- live pressure always survives.
    trimLedger(ledger, { nowMs, maxRecords: config.shadowMaxEntries, staleHorizonMs });
    if (!loadedOk.has(companyId)) {
      throw new Error('model-capacity: refusing ledger persist without a successful load');
    }
    await ctx.state.set(scopeKey(companyId, LEDGER_KEY), ledgerToJSON(ledger));
    // Gated on a successful load (see above): persisting without one would
    // wipe saved open/half-open breakers with an empty store.
    if (breakerReady.has(companyId)) {
      await ctx.state.set(scopeKey(companyId, BREAKER_KEY), breakerStoreToJSON(breakers, { nowMs, cfg: breakersCfg }));
    }
    await ctx.state.set(scopeKey(companyId, RUNEVT_KEY), mergedEvt);
    await ctx.state.set(scopeKey(companyId, TRIAL_KEY), trialState);
    // Demand-aware caps input: per-agent in-flight counts plus whether the
    // agent burns on an over-pace (guard-active) account. Running = ledger
    // records with status 'running' (started, no terminal); unverified
    // records never proved alive since startup and stay excluded. Burn side
    // (actualAccount) outranks the decision guess for the over-pace check.
    const overPaceAccounts = new Set(
      accountViews.filter(v => v?.guardActive === true).map(v => v.accountId));
    const agentRunning = {};
    for (const r of ledger.values()) {
      if (r?.status !== 'running' || r?.unverified === true) continue;
      if (typeof r.agentId !== 'string' || r.agentId.length === 0 || r.agentId === 'unknown') continue;
      const entry = agentRunning[r.agentId] ?? (agentRunning[r.agentId] = { running: 0, overPace: false });
      entry.running += 1;
      const burnAccount = r.actualAccount ?? r.decidedAccount ?? null;
      if (burnAccount != null && overPaceAccounts.has(burnAccount)) entry.overPace = true;
    }
    await ctx.state.set(scopeKey(companyId, CAPACITY_KEY), {
      atMs: nowMs,
      target: concurrency.target,
      maxTotal: config.concurrency.maxTotal,
      calibration: concurrency.calibration,
      perAccount: concurrency.perAccount,
      accounts: accountViews,
      skippedArms: skipped,
      unscored,
      contextTiers: { baselineMultiplier: tierBaseline, caps: tierCaps },
      trialFamilies,
      trialTransitions,
      // Arm circuit breakers: open/half-open arms plus closed arms with
      // recent arm-fatal fails. Bounded (500 arms) by construction.
      armBreakers: breakerReport(breakers, nowMs, breakersCfg),
      // Per-role effective family exclusions (resolved config values).
      roleExclusions: {
        doer: config.roles.excludeFamilies.doer,
        thinker: config.roles.excludeFamilies.thinker,
        other: config.roles.excludeFamilies.other,
      },
      // Per-agent running + over-pace burn flags for the demand-aware /caps
      // allocator below. Bounded by the live agent count.
      agentRunning,
      inFlightByAccount: liveCensus.byAccount,
      inFlightByPool: livePools,
      // Ledger accounting: non-terminal records excluded by age (older than
      // the in-flight horizon), by the unverified flag (carried records
      // whose runs never proved alive since startup), and newly flagged by
      // this tick's reconciliation. The clamp backstop is retired (each
      // runId counts at most once structurally) and reports 0.
      staleInFlightDropped,
      unverifiedExcluded,
      reconciledUnverified,
      clampedInFlightDropped,
      reactiveAccounts: accountViews.filter(v => v.reactive).length,
      runsObserved: ledger.size,
      runsCandidates: candidates.length,
      runsSource: 'events',
      unmappedRuns,
      runEventsSeen: mergedEvt.seen,
      lastRunEventAtMs: mergedEvt.lastAtMs,
      shadow: {
        decided: observed,
        mergedEventTime,
        backfilledActuals,
        skippedNoDecision: shadowSkippedNoDecision,
      },
    });
    await ctx.state.set(scopeKey(companyId, LADDER_KEY), { atMs: nowMs, ladders });
    ctx.logger.info('model-capacity: shadow tick', {
      companyId, accounts: accountViews.length, target: concurrency.target,
      calibration: concurrency.calibration, observed, runs: ledger.size, runsSource: 'events',
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
   * loop will cover the run. The tick backfills the actual model; its own
   * loop then skips the runId (recordDecision is first-wins per runId).
   *
   * Trial arms need an opted-in adapter type, which events often omit --
   * adapter-less events fall back to the live adapter map (agent types the
   * tick resolved from agent records, 10-min TTL), then to proven arms
   * only. Runs whose events carry adapterType get full trial eligibility
   * here AND in the tick loop.
   */
  /**
   * Ledger decisions the live view does not yet reflect (by decidedRunIds
   * membership, not timestamp): the hook and event-time pressure since the
   * last tick. One record per runId by construction -- no dedupe needed.
   * excludeRunId drops the caller's own run (the host fires
   * agent.run.started at claim before the hook resolves, so a decision for
   * THIS run must not count against it in ordering, caps, or budgets).
   */
  function decisionsSinceTick(live, companyId, excludeRunId = null) {
    if (live == null) return [];
    const included = live.decidedRunIds;
    const out = [];
    for (const r of (ledgers.get(companyId) ?? new Map()).values()) {
      if (r?.decidedAccount == null) continue;
      if (r.runId === excludeRunId) continue;
      if (included?.has(r.runId)) continue;
      out.push(r);
    }
    return out;
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
    for (const q of decisionsSinceTick(live, companyId, excludeRunId)) {
      if (!q?.decidedAccount) continue;
      const p = poolOf(q.decidedAccount);
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
    for (const q of decisionsSinceTick(live, companyId, excludeRunId)) {
      if (q?.trial !== true || !q?.family) continue;
      use.set(q.family, (use.get(q.family) ?? 0) + 1);
    }
    const out = {};
    for (const [fam, b] of Object.entries(live?.trialBudget ?? {})) {
      out[fam] = Math.max(0, b - (use.get(fam) ?? 0));
    }
    return out;
  }

  /** Decisions since the tick per accountId: the per-account side of the reactive cap. */
  function pendingByAccount(live, companyId, excludeRunId = null) {
    const out = new Map();
    for (const q of decisionsSinceTick(live, companyId, excludeRunId)) {
      if (!q?.decidedAccount) continue;
      out.set(q.decidedAccount, (out.get(q.decidedAccount) ?? 0) + 1);
    }
    return out;
  }

  async function recordEventTimeShadow(companyId, run) {
    const live = liveViews.get(companyId);
    const config = lastConfig.get(companyId);
    if (!live || !config) return null;
    if (!Number.isFinite(live.atMs) || clock() - live.atMs > 120000) return null;
    // Already covered: the hook (or an earlier event) decided this runId.
    // The decision lives in the ledger -- one record per runId, first
    // decision wins -- so recording again would double-count the run in
    // pool pressure and trial use.
    if (run?.runId != null) {
      if (ledgers.get(companyId)?.get(String(run.runId))?.decidedAccount != null) return null;
    }
    const role = roleOf(config, run.agentId);
    const roleExcluded = excludedFamiliesForRole(config, role);
    const order = allocationOrderFromLive(live, companyId);
    // Per-account cap inputs: the live view's per-account in-flight plus
    // queued decisions per account. The pooled inFlight on the ordered
    // views drives ordering only -- comparing the pool total against the
    // per-account cap starves multi-lane providers.
    const capBase = new Map((live.accounts ?? []).map(a => [a.accountId, a.inFlight ?? 0]));
    const acctPending = pendingByAccount(live, companyId);
    const maxPerAccount = live.maxTrialInFlightPerAccount ?? 2;
    const budget = effectiveTrialBudget(live, companyId);
    for (const view of order) {
      if (!view || !view.ladderRungs || view.ladderRungs.length === 0) continue;
      if (!view.reactive && !view.remainingKnown) continue;
      if (view.reactive && (capBase.get(view.accountId) ?? 0) + (acctPending.get(view.accountId) ?? 0) >= maxPerAccount) continue;
      const roleRungs = filterRungsByExcludedFamilies(view.ladderRungs, roleExcluded);
      if (!rungsHaveEligibleArms(roleRungs)) continue;
      const d = decide({
        runId: run.runId,
        agentId: run.agentId,
        role,
        ladderRungs: roleRungs,
        excludedFamilies: roleExcluded,
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
        trialRoles: live.trialRoles ?? DEFAULT_TRIALS.roles,
      });
      if (d.kind !== 'decide') continue;
      const emitAdapter = run.adapterType ?? liveAdapterFor(live, run.agentId) ?? null;
      // Straight into the ledger via the shared helper (joins the pending
      // load when one is in flight, so this decision survives it; the next
      // tick persists the same record). actualPending until a tick backfills it.
      const ledger = await getOrLoadLedger(companyId);
      recordDecision(ledger, {
        runId: String(run.runId ?? 'unknown'),
        agentId: String(run.agentId ?? 'unknown'),
        accountId: d.accountId,
        armId: d.armId ?? null,
        enforced: false,
        wouldModel: decoratedModelFor(d, emitAdapter) ?? `${d.model}(${d.effort ?? 'default'})`,
        rung: d.rung,
        trial: d.trial === true,
        family: inferFamily(canonicalModelName(d.model)),
        eventTime: true,
        reason: d.reason,
      }, clock());
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
        // tagged source run-decision, so recordTerminal treats it as
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
          // Provider-side failure text (codes included). recordTerminal
          // stores it on failed records only, where the tick's breaker scan
          // reads it. Never persisted from this path (memory-only events).
          errorText: extractRunErrorText(event),
        };
        // Every run fact lands in the ledger via the shared helper (joins
        // the pending load when one is in flight; the next tick persists
        // the same records). The terminal modelDecision -- what the run
        // actually used -- is tagged source run-decision, so
        // recordTerminal treats it as authoritative over earlier guesses.
        const evtLedger = await getOrLoadLedger(companyId);
        if (status === 'running') {
          recordStart(evtLedger, entry, entry.at);
        } else {
          recordTerminal(evtLedger, entry, status, entry.at);
        }
        const st = runEventStats.get(companyId) ?? { seen: 0, lastAtMs: null, lastRunId: null };
        st.seen += 1;
        st.lastAtMs = entry.at;
        st.lastRunId = entry.runId;
        runEventStats.set(companyId, st);
        // Event-time shadow decision (memory-only; see
        // recordEventTimeShadow): covers runs that start when the resolver
        // is absent, so the ledger has no minute-long blind spot.
        if (status === 'running') {
          try {
            await recordEventTimeShadow(companyId, entry);
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
        // The shadow log is an append-only view over the ledger records:
        // reconcile never prunes it, so a restart never empties it. The
        // requested limit reaches the ledger (default 100, max 500); size
        // is the full decided count, computed without materializing rows.
        const persisted = await ctx.state.get(scopeKey(companyId, LEDGER_KEY));
        const view = persisted != null ? ledgerFromJSON(persisted) : (ledgers.get(companyId) ?? createLedger());
        const limit = Math.min(Number(input.query?.limit ?? 100) || 100, 500);
        return { status: 200, body: { entries: shadowEntries(view, { limit }), size: decidedCount(view) } };
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
        // Demand-aware caps: C* splits across agents in proportion to
        // CURRENT demand (running + queued), never historical share. Below
        // the target every agent covers its full demand; at/above it the
        // allocator sheds over-pace burners first. No cap lands below an
        // agent's running count -- throttling existing runs while the fleet
        // idles is the failure this replaces.
        const runningByAgent = cap.agentRunning ?? {};
        const agentIds = new Set([...counts.keys(), ...Object.keys(runningByAgent)]);
        const agents = allocateDemandCaps(
          target,
          [...agentIds].map(agentId => ({
            agentId,
            running: runningByAgent[agentId]?.running ?? 0,
            queued: counts.get(agentId) ?? 0,
            overPace: runningByAgent[agentId]?.overPace === true,
          })),
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
     * `defer` (~60s retry). Every enforced decision is recorded in the
     * ledger with `enforced:true` (memory-only; the next tick persists it).
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
      const role = roleOf({ roles: {
        thinkerAgentIds: live.thinkerAgentIds,
        doerAgentIds: live.doerAgentIds,
      } }, params.agentId);
      const roleExcluded = normalizeExcludedFamilies(live.excludeFamilies?.[role] ?? []);
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
      const acctPending = pendingByAccount(live, params.companyId, selfId);
      const maxPerAccount = live.maxTrialInFlightPerAccount ?? 2;
      const budget = effectiveTrialBudget(live, params.companyId, selfId);
      // Breaker state live at call time (not the tick-frozen view): a probe
      // occupied after the tick published must exclude the arm here, or N
      // enforced runs would pile onto one half-open probe slot.
      const bstore = breakerStores.get(params.companyId) ?? createBreakerStore();
      const bcfg = lastConfig.get(params.companyId)?.breakers ?? DEFAULT_BREAKERS;
      const bnow = clock();
      for (const view of order) {
        if (!view || view.ladderRungs.length === 0) continue;
        if (!view.reactive && !view.remainingKnown) continue;
        if (view.reactive && (capBase.get(view.accountId) ?? 0) + (acctPending.get(view.accountId) ?? 0) >= maxPerAccount) continue;
        // Role-based family exclusions use the tick-frozen live view (the
        // hook performs zero I/O): ineligible accounts are skipped, never
        // deferred on.
        const roleRungs = filterRungsByExcludedFamilies(view.ladderRungs, roleExcluded);
        if (!rungsHaveEligibleArms(roleRungs)) continue;
        const d = decide({
          runId: params.runId,
          agentId: params.agentId,
          role,
          ladderRungs: filterBreakerRungs(roleRungs, bstore, view.accountId, bnow, bcfg),
          excludedFamilies: roleExcluded,
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
          trialRoles: live.trialRoles ?? DEFAULT_TRIALS.roles,
        });
        if (d.kind === 'decide') {
          // Straight into the ledger via the shared helper: the enforced
          // (hook) decision overwrites any event-time entry for this runId
          // (host order: started fires before the hook resolves), so the run
          // counts exactly once, and it survives a load in flight.
          // Memory-only here; the next tick persists it.
          // Half-open probe: only enforced runs route real traffic, so only
          // the hook occupies the probe slot (shadow picks never do). The
          // pre-filter above already excluded occupied slots, and everything
          // from the filter through this claim is synchronous, so the claim
          // cannot lose -- but if it ever does, skip to the next account
          // rather than piling a second enforced run onto one probe.
          // Slipped runs cannot occur: with the slot claimed, every later
          // hook filters the arm out until its terminal resolves.
          if (d.armId != null && params?.runId != null
            && breakerState(bstore, d.accountId, d.armId, bnow, bcfg) === 'half-open'
            && !startProbe(bstore, d.accountId, d.armId, params.runId, bnow, bcfg)) {
            continue;
          }
          const hookLedger = await getOrLoadLedger(params.companyId);
          const emitAdapter = params.adapterType ?? liveAdapterFor(live, params.agentId) ?? null;
          const decorated = decoratedModelFor(d, emitAdapter);
          recordDecision(hookLedger, {
            runId: String(params.runId ?? 'unknown'),
            agentId: String(params.agentId ?? 'unknown'),
            accountId: d.accountId,
            armId: d.armId ?? null,
            enforced: true,
            wouldModel: decorated ?? `${d.model}(${d.effort ?? 'default'})`,
            rung: d.rung,
            trial: d.trial === true,
            family: inferFamily(canonicalModelName(d.model)),
            reason: d.reason,
          }, clock());
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
