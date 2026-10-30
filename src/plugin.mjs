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

import { randomUUID } from 'node:crypto';
import { validateRouterConfig, normalizeRegistry } from './registry.mjs';
import { createQuotaRefresh, withQuotaTimeout } from './quota-refresh.mjs';
import { createRouterAdapter } from './router.mjs';
import { createRunOverlay } from './overlay.mjs';
import {
  DEFAULT_BASE_URL,
  DEFAULT_ACCOUNTS_PATH,
  LANE_ACCOUNTS_PATH_ALLOWLIST,
  LANE_KEY_HEADER,
  isPlaceholderLaneHost,
  assertLaneHostPinned,
  buildLaneRequest,
  assertLaneRequest,
  parseLaneBody,
  isReactiveAccount,
  CliproxyCache,
} from './cliproxy.mjs';
import { fetchAaFreeList, parseAaFreeList, fetchAaLeaderboard, parseAaLeaderboardHtml, mergeAaRows, mergeAaRowsGapFill, carryForwardCosts, carryForwardBenchmarks, markStaleBenchmarks, BENCHMARK_FIELDS, stampAaObservations } from './aa.mjs';
import {
  DEFAULT_ARM_MAP, resolveArms, armsForAccount, buildDynamicBindings, resolveDynamicArms,
  canonicalModelName, servedIdForArm, inferFamily, familyOfModelName, PROVEN_FAMILIES, discoverTaskArms, taskArmId,
} from './arms.mjs';
import { computeComposite, DEFAULT_WEIGHTS, METRIC_SOURCES } from './quality.mjs';
import {
  computeEeeComposite, blendQ, blendAlphaForRole, eeeUsable, eeeFamilyPrior,
  eeeGateDatum,
  DEFAULT_EEE_WEIGHTS, DEFAULT_EEE_BLEND_DOER, DEFAULT_EEE_BLEND_THINKER,
  DEFAULT_EEE_MAX_AGE_DAYS, DEFAULT_EEE_FIRST_PARTY_DISCOUNT,
  DEFAULT_EEE_DECAY_HALF_LIFE_DAYS,
} from './eee.mjs';
import { fillCosts } from './cost.mjs';
import { normalizeTaskRanking, validateTaskRanking, buildTaskRanking, taskPlacement, compareTaskCosts, translateTaskExclusions } from './task-ranking.mjs';
import { buildLadder, ladderDominates, LOW_COVERAGE_THRESHOLD, LOW_COVERAGE_MAX_RUNG } from './ladder.mjs';
import {
  armTierCost, armTierCap, tierCapsByModel, tierModelKey, fleetBaselineForModels,
} from './tiers.mjs';
import {
  scheduleError, stepController, stepRateController, appendUtilReading, appendTickLog, robustRatePerHour,
  measuredRatePerHour, requiredRatePerHour, orderAccounts, DEFAULT_PACING,
} from './pacing.mjs';
import { decide, contextCapsEnv, normalizeContextCaps, validateServedIdCaps, needsContextCap, DEFAULT_ROLE_BANDS, DEFAULT_TRIALS, roleTakesTrial, adapterAllowsTrial, normalizeExcludedFamilies, filterRungsByExcludedFamilies, rungsHaveEligibleArms, roleLadderAccess, placementArm, armToken } from './decide.mjs';
import { burnHorizon, normalizeBurnHorizon } from './burnhorizon.mjs';
import { normalizeBurnMode, validateBurnMode, isBurnAccount, burnDeadlineAtMs, burnPaceTarget, burnEligibleAccounts, applyBurnFloors } from './burnmode.mjs';
import {
  normalizeCredits, usableCredit, WEEKLY_EXHAUSTED_PCT, hasUsablePlanHeadroom, planConcurrencyRoles, gateCreditConcurrencyRoles,
} from './credits.mjs';
import {
  BREAKER_KEY, BREAKER_MAX_SEEN, BREAKER_ERROR_TEXT_MAX, DEFAULT_BREAKERS,
  sanitizeBreakers, classifyArmError, breakerState,
  filterBreakerRungs, breakerProbeRunId, recordArmFailure, startProbe,
  resolveProbe, breakerHousekeep, breakerReport, breakerStoreFromJSON,
  breakerStoreToJSON, breakerSuspendsFloors, createBreakerStore, noteKnownArms,
  recordAccountBalanceExhaustion, isBalanceExhaustion,
} from './breakers.mjs';
import { computeConcurrencyTarget, distributeCaps, distributeWeightedCaps, allocateKeptAndRoutedCaps, computeReservedFloor, applyReservedFloors, DEFAULT_CONCURRENCY, ROLES, medianPositive, fleetStallAlarms } from './concurrency.mjs';
import { buildBlockingPriorities } from './blocking-priority.mjs';
import { buildCalibrationGroups, pooledBurnPerRun } from './pools.mjs';
import { SMOOTHING_DEFAULTS, normalizeSmoothing, smoothValue, smoothTarget, holdCaps } from './smoothing.mjs';
import { appendAccountUsage, calibrateAccounts } from './calibration.mjs';
import { armKeyOfRecord, countRunsByArm, attributeArmBurn, effectiveBurnForMix, dominantArm, rebaseSampleToMix, UNATTRIBUTED_ARM } from './arm-calibration.mjs';
import {
  issueSnapshot, classifyOutcome, familyOutcomes,
  OUTCOME_EVAL_WINDOW_MS, OUTCOME_READS_PER_TICK, OUTCOME_MAX_TRIES, OUTCOME_BASELINE_MAX_AGE_MS,
} from './outcomes.mjs';
import { normalizeMinQuality, normalizeOutcomeGate, buildEligibility, MAX_WINDOW_HOURS } from './eligibility.mjs';
import { orderAccountsWithPacing, DEFAULT_PLACEMENT, deficitOf, isOverBurning } from './select.mjs';
import {
  isAggregatorAccount, isFallbackOnlyView, nativeQualifiedModels,
  hasHeadroom, crossAccountDominated, canonicalKey,
} from './cross-account.mjs';
import { normalizePaceGuard } from './paceguard.mjs';
import {
  REVIEW_RESERVE_STATE_KEY, REVIEW_FOLDED_CAP, DEFAULT_REVIEW_RESERVE, normalizeReviewReserve,
  priceReviewBurn, priorProviderReserveState,
  reviewEventsFromLedger, queuedReviewsByAccount,
  computeProviderReserve,
} from './reviewreserve.mjs';
import { SHADOW_CAPACITY } from './shadow.mjs';
import {
  accountKeyForModel, createLedger, ledgerFromJSON, ledgerToJSON, recordStart, recordDecision,
  recordTerminal, calibrationAccount, decidedCount, isInflight, inflightByAccount, attributedAccount,
  trialInflight, reconcileLedger, startedOnCountWhere,
  terminalRecords, shadowEntries, trimLedger, mergeLedger, migrateLegacy,
  isLedgerTerminal as isTerminalStatus, TRIAL_WINDOW_MS, LEDGER_CAP,
} from './ledger.mjs';
import { manifest, LANE_BASE_URL_ALLOWLIST } from './manifest.mjs';
import { credentialEvidenceFor, credentialReadiness, filterCredentialRungs } from './availability.mjs';
import { diffCapacityFeed, WARMUP_MIN_SPAN_MS, isWarmupSpan, predictGuard } from './capacitychange.mjs';
import { buildModelInventory } from './inventory.mjs';
import { DEFAULT_REVIEWER, normalizeReviewer, computeReviewerCapacity, computeSupplySignal, computeDoerStarvation } from './reviewer.mjs';
import { validateReviewerRouting, normalizeReviewerRouting, burnModeTokens, selectReviewerRoute } from './reviewerrouting.mjs';
import { validateReviewDemand, normalizeReviewDemand, createReviewDemandReader } from './review-demand.mjs';
import { normalizeFreeLanes, validateFreeLanes, freeProvider, lowRiskRun, freeArmVerdict, freeLaneBudget, reserveFreeRun, freeLaneCaps, paidTrialLedger } from './free-lanes.mjs';
import {
  FAILURE_CLUSTER_STATE_KEY, evaluateClusters, normalizeClusterState, updateFailureClusters,
} from './failure-clusters.mjs';

const NS = 'model-capacity';
const AA_KEY = 'aa-snapshot-v1';
const TRIAL_KEY = 'trial-families-v1';
const PACING_KEY = 'pacing-v1';
const CAPACITY_KEY = 'capacity-v1';
const LADDER_KEY = 'ladder-v1';
const RATE_KEY = 'rate-history-v1';
const RUNEVT_KEY = 'run-events-v1';
/** Previous-tick account summary for capacity-change diffing (auto-heal). */
const CAPACITY_CHANGE_KEY = 'capacity-change-v1';
/** EWMA state for the pooled burn per run and the fleet target (tick-owned). */
const SMOOTH_KEY = 'smoothing-v1';
/** Per-agent cap hysteresis state (written by GET /caps). */
const CAPS_HOLD_KEY = 'caps-hold-v1';

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
 * Deferral-exhaustion mirror of the host budget: the host clamps a plugin
 * defer to [1s, 60s] (retryAfterMs) and allows RUN_MODEL_RESOLVE_MAX_ATTEMPTS
 * = 12 retries per chain, each retry a NEW runId. The per-runId deferredRuns
 * marks can therefore never detect the end of the chain; the per-issue+agent
 * streak below counts it instead. Keep in step with the host constant.
 */
export const EXHAUSTION_HOST_ATTEMPTS = 12;
/** First chain attempt that answers instead of deferring (attempts are 1-based). */
export const EXHAUSTION_DEFAULT_FINAL_ATTEMPT = 11;

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
  if (typeof model !== 'string') return null;
  // Provider-prefixed emissions (devin/claude-...) decorate on the canonical
  // id but keep the prefix, so the route stays on the deciding account.
  if (canonicalModelName(model)?.startsWith('claude-') !== true) return null;
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
  errors.push(...validateTaskRanking(raw.taskRanking), ...validateFreeLanes(raw.freeLanes), ...validateRouterConfig(raw.router));
  if (raw.allocation != null) {
    const allocation = raw.allocation;
    if (typeof allocation !== 'object' || Array.isArray(allocation)) errors.push('allocation must be an object');
    else {
      if ('blockingPriority' in allocation && typeof allocation.blockingPriority !== 'boolean') {
        errors.push('allocation.blockingPriority must be a boolean');
      }
      for (const key of Object.keys(allocation)) {
        if (key !== 'blockingPriority') errors.push(`allocation.${key} is not a known key`);
      }
    }
  }
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
    if (!Number.isFinite(v) || v < 0) errors.push(`weights.${k} must be a finite non-negative number`);
    if (v > 0 && !Object.hasOwn(METRIC_SOURCES, k)) errors.push(`weights.${k} is not a supported legacy metric; use taskRanking.roleMetricWeights for role metrics`);
  }
  for (const [k, v] of Object.entries(raw.eee?.weights ?? {})) {
    if (typeof v !== 'number' || !(v >= 0)) errors.push(`eee.weights.${k} must be a non-negative number`);
  }
  for (const [k, v] of Object.entries(raw.eeeWeights ?? {})) {
    if (typeof v !== 'number' || !(v >= 0)) errors.push(`eeeWeights.${k} must be a non-negative number`);
  }
  if (pacing && (pacing.guardHighPct <= pacing.guardRejoinPct)) errors.push('pacing.guardHighPct must exceed pacing.guardRejoinPct');
  if (pacing != null && typeof pacing === 'object' && !Array.isArray(pacing) && 'guard' in pacing) {
    const g = pacing.guard;
    if (g == null || typeof g !== 'object' || Array.isArray(g)) {
      errors.push('pacing.guard must be an object');
    } else {
      if ('enabled' in g && typeof g.enabled !== 'boolean') errors.push('pacing.guard.enabled must be a boolean');
      if ('marginPct' in g && !(typeof g.marginPct === 'number' && g.marginPct >= 0 && g.marginPct <= 1)) {
        errors.push('pacing.guard.marginPct must be a number in [0, 1]');
      }
      if ('retryAfterMs' in g && !(Number.isInteger(g.retryAfterMs) && g.retryAfterMs >= 1000)) {
        errors.push('pacing.guard.retryAfterMs must be an integer >= 1000');
      }
    }
  }
  // Burn horizon: every knob validated so a typo fails closed at config load,
  // never as a silent full-burn or a dead horizon in the tick.
  const bh = raw.burnHorizon;
  if (bh != null && (typeof bh !== 'object' || Array.isArray(bh))) {
    errors.push('burnHorizon must be an object');
  } else if (bh) {
    if ('enabled' in bh && typeof bh.enabled !== 'boolean') errors.push('burnHorizon.enabled must be a boolean');
    if ('quantile' in bh && !(typeof bh.quantile === 'number' && bh.quantile > 0 && bh.quantile < 1)) {
      errors.push('burnHorizon.quantile must be a number in (0, 1)');
    }
    if ('maxBurnFactor' in bh && !(typeof bh.maxBurnFactor === 'number' && bh.maxBurnFactor >= 1)) {
      errors.push('burnHorizon.maxBurnFactor must be a number >= 1');
    }
    if ('minHistory' in bh && !(Number.isInteger(bh.minHistory) && bh.minHistory >= 1)) {
      errors.push('burnHorizon.minHistory must be an integer >= 1');
    }
    if ('providerQuantiles' in bh) {
      const pq = bh.providerQuantiles;
      if (pq == null || typeof pq !== 'object' || Array.isArray(pq) ||
        Object.entries(pq).some(([k, v]) => typeof k !== 'string' || !k ||
          !(typeof v === 'number' && v > 0 && v < 1))) {
        errors.push('burnHorizon.providerQuantiles must map provider names to numbers in (0, 1)');
      }
    }
  }
  // Burn mode: operator-flagged accounts spend ASAP (see burnmode.mjs).
  errors.push(...validateBurnMode(raw.burnMode));
  // Per-emitted-id context ceilings (see decide.mjs servedIdKey).
  errors.push(...validateServedIdCaps(raw.contextCaps?.servedIds));
  if (concurrency && !(concurrency.maxTotal >= 1)) errors.push('concurrency.maxTotal must be >= 1');
  // Review reserve: every knob is validated so a typo fails closed at config
  // load, never as a silent full-hold or a dead reserve in the tick.
  const rr = raw.reviewReserve;
  if (rr != null && (typeof rr !== 'object' || Array.isArray(rr))) {
    errors.push('reviewReserve must be an object');
  } else if (rr) {
    if ('enabled' in rr && typeof rr.enabled !== 'boolean') errors.push('reviewReserve.enabled must be a boolean');
    if ('providers' in rr && (!Array.isArray(rr.providers) || rr.providers.some(p => typeof p !== 'string'))) {
      errors.push('reviewReserve.providers must be an array of strings');
    }
    if ('agentIds' in rr && rr.agentIds != null && (!Array.isArray(rr.agentIds) || rr.agentIds.some(a => typeof a !== 'string'))) {
      errors.push('reviewReserve.agentIds must be an array of strings or null');
    }
    for (const k of ['windowH', 'envWindowH']) {
      if (k in rr && !(Number.isInteger(rr[k]) && rr[k] >= 1)) errors.push(`reviewReserve.${k} must be an integer >= 1`);
    }
    for (const k of ['envHalfLifeH', 'drainH', 'releaseWeeklyH', 'release5hMin', 'minRunsPerH', 'runsHalfLifeH']) {
      if (k in rr && !(typeof rr[k] === 'number' && rr[k] > 0)) errors.push(`reviewReserve.${k} must be a number > 0`);
    }
    for (const k of ['rMin', 'rMax', 'marginW', 'margin5h']) {
      if (k in rr && !(typeof rr[k] === 'number' && rr[k] >= 0 && rr[k] <= 1)) {
        errors.push(`reviewReserve.${k} must be a number in [0, 1]`);
      }
    }
    // An inverted band pins the reserve (clamp with lo > hi reads constant).
    // Compare the effective band: an unset bound reads as its default, so a
    // one-sided inversion against the other bound's default ({rMax: 0.05},
    // {rMin: 0.97}) fails closed instead of silently resetting both bounds.
    const effRMin = typeof rr.rMin === 'number' ? rr.rMin : DEFAULT_REVIEW_RESERVE.rMin;
    const effRMax = typeof rr.rMax === 'number' ? rr.rMax : DEFAULT_REVIEW_RESERVE.rMax;
    if (effRMin > effRMax) {
      errors.push('reviewReserve.rMin must be <= reviewReserve.rMax');
    }
    if ('exhaustedPct' in rr && !(typeof rr.exhaustedPct === 'number' && rr.exhaustedPct > 0 && rr.exhaustedPct <= 1)) {
      errors.push('reviewReserve.exhaustedPct must be a number in (0, 1]');
    }
  }
  if (raw.smoothing != null) {
    if (typeof raw.smoothing !== 'object' || Array.isArray(raw.smoothing)) errors.push('smoothing must be an object');
    else for (const [key, value] of Object.entries(raw.smoothing)) {
      if (!Object.hasOwn(SMOOTHING_DEFAULTS, key)) errors.push(`smoothing.${key} is unknown`);
      else if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) errors.push(`smoothing.${key} must be a finite number > 0`);
    }
  }
  if (raw.credits != null) {
    if (typeof raw.credits !== 'object' || Array.isArray(raw.credits)) errors.push('credits must be an object');
    else for (const [key, value] of Object.entries(raw.credits)) {
      if (!['priority', 'freeTypes', 'paidTypes'].includes(key)) errors.push(`credits.${key} is unknown`);
      else if (key === 'priority' && !['fallback', 'normal'].includes(value)) {
        errors.push('credits.priority must be "fallback" or "normal"');
      } else if (key !== 'priority' && (!Array.isArray(value) || value.some(t => typeof t !== 'string' || t.trim().length === 0))) {
        errors.push(`credits.${key} must be an array of non-empty strings`);
      }
    }
  }
  const rv = raw.reviewer;
  if (rv != null && (typeof rv !== 'object' || Array.isArray(rv))) {
    errors.push('reviewer must be an object');
  } else if (rv) {
    if ('providers' in rv && (!Array.isArray(rv.providers) || rv.providers.some((p) => typeof p !== 'string'))) {
      errors.push('reviewer.providers must be an array of strings');
    }
    for (const k of ['supplyHeadroomPct']) {
      if (k in rv && !(typeof rv[k] === 'number' && rv[k] > 0 && rv[k] <= 1)) {
        errors.push(`reviewer.${k} must be a number in (0, 1]`);
      }
    }
    if ('supplyHoursToReset' in rv && !(typeof rv.supplyHoursToReset === 'number' && rv.supplyHoursToReset > 0)) {
      errors.push('reviewer.supplyHoursToReset must be a number > 0');
    }
    if ('doerStarvationMarginRuns' in rv && !(typeof rv.doerStarvationMarginRuns === 'number' && rv.doerStarvationMarginRuns > 0)) {
      errors.push('reviewer.doerStarvationMarginRuns must be a number > 0');
    }
    if ('doerStarvationSustainMs' in rv && !(typeof rv.doerStarvationSustainMs === 'number' && rv.doerStarvationSustainMs > 0)) {
      errors.push('reviewer.doerStarvationSustainMs must be a number > 0');
    }
  }
  errors.push(...validateReviewerRouting(raw.reviewerRouting));
  errors.push(...validateReviewDemand(raw.reviewDemand));
  for (const b of armMap ?? []) {
    if (!b?.aaSlug || !b?.model || !b?.effort || !b?.family || !Array.isArray(b?.providers)) {
      errors.push('armMap entries need aaSlug, model, effort, family, providers');
      break;
    }
  }
  if (roles) {
    for (const k of ['thinkerAgentIds', 'doerAgentIds', 'keepAgentIds']) {
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
    if ('minQuality' in roles) {
      const mq = roles.minQuality;
      if (mq == null || typeof mq !== 'object' || Array.isArray(mq)) {
        errors.push('roles.minQuality must be an object of role to number or null');
      } else {
        for (const [rk, rv] of Object.entries(mq)) {
          if (!['doer', 'thinker', 'other'].includes(rk)) {
            errors.push(`roles.minQuality.${rk} is not a known role`);
          } else if (rv !== null && !(typeof rv === 'number' && Number.isFinite(rv))) {
            errors.push(`roles.minQuality.${rk} must be a finite number or null`);
          }
        }
      }
    }
    if ('outcomeGate' in roles) {
      const og = roles.outcomeGate;
      if (og == null || typeof og !== 'object' || Array.isArray(og)) {
        errors.push('roles.outcomeGate must be an object');
      } else {
        if ('enabled' in og && typeof og.enabled !== 'boolean') errors.push('roles.outcomeGate.enabled must be a boolean');
        for (const k of ['minRuns', 'lastRuns']) {
          if (k in og && !(Number.isInteger(og[k]) && og[k] >= 1)) errors.push(`roles.outcomeGate.${k} must be an integer >= 1`);
        }
        for (const k of ['minProgressRate', 'relativeToBest']) {
          if (k in og && !(typeof og[k] === 'number' && og[k] >= 0 && og[k] <= 1)) errors.push(`roles.outcomeGate.${k} must be a number in [0, 1]`);
        }
        if ('windowHours' in og && !(typeof og.windowHours === 'number' && og.windowHours > 0 && og.windowHours <= MAX_WINDOW_HOURS)) {
          errors.push(`roles.outcomeGate.windowHours must be a number in (0, ${MAX_WINDOW_HOURS}] (the ledger keeps terminal runs that long)`);
        }
        if (Number.isInteger(og.minRuns) && Number.isInteger(og.lastRuns) && og.lastRuns < og.minRuns) {
          errors.push('roles.outcomeGate.lastRuns must be >= roles.outcomeGate.minRuns (a shorter slice can never gate)');
        }
      }
    }
  }
  if (raw.trials) {
    for (const k of ['maxInFlightPerAccount', 'maxInFlightPerFamily', 'minRuns']) {
      if (k in raw.trials && !(raw.trials[k] >= 1)) errors.push(`trials.${k} must be >= 1`);
    }
    if ('maxInFlightPerAccountByProvider' in raw.trials) {
      const byProvider = raw.trials.maxInFlightPerAccountByProvider;
      if (byProvider == null || typeof byProvider !== 'object' || Array.isArray(byProvider)) {
        errors.push('trials.maxInFlightPerAccountByProvider must be an object of provider to integer >= 1');
      } else {
        for (const [provider, cap] of Object.entries(byProvider)) {
          if (typeof provider !== 'string' || provider.trim().length === 0 || !Number.isInteger(cap) || cap < 1) {
            errors.push('trials.maxInFlightPerAccountByProvider must be an object of provider to integer >= 1');
            break;
          }
        }
      }
    }
    if ('minSuccessRate' in raw.trials && (typeof raw.trials.minSuccessRate !== 'number' || raw.trials.minSuccessRate < 0 || raw.trials.minSuccessRate > 1)) {
      errors.push('trials.minSuccessRate must be a number in [0, 1]');
    }
    if ('adapters' in raw.trials && (raw.trials.adapters == null || typeof raw.trials.adapters !== 'object' || Array.isArray(raw.trials.adapters))) {
      errors.push('trials.adapters must be an object of adapter type to families');
    }
    if ('roles' in raw.trials && (!Array.isArray(raw.trials.roles) || raw.trials.roles.some(r => typeof r !== 'string'))) {
      errors.push('trials.roles must be an array of role names (or role:family entries)');
    }
  }
  if (raw.modelAaOverrides != null && (typeof raw.modelAaOverrides !== 'object' || Array.isArray(raw.modelAaOverrides))) {
    errors.push('modelAaOverrides must be an object of CLIProxy model id to AA slug');
  }
  if (raw.placement != null) {
    if (typeof raw.placement !== 'object' || Array.isArray(raw.placement)) {
      errors.push('placement must be an object');
    } else {
      for (const k of ['qualityWeight', 'allowanceWeight']) {
        if (k in raw.placement && !(typeof raw.placement[k] === 'number' && raw.placement[k] >= 0)) {
          errors.push(`placement.${k} must be a non-negative number`);
        }
      }
      if ('freeCostProviders' in raw.placement) {
        const list = raw.placement.freeCostProviders;
        if (!Array.isArray(list) || list.some(p => typeof p !== 'string' || p.trim().length === 0)) {
          errors.push('placement.freeCostProviders must be an array of non-empty provider names');
        }
      }
    }
  }
  if (raw.enforce != null && typeof raw.enforce !== 'boolean') errors.push('enforce must be a boolean');
  // Deferral-exhaustion (Design B): answering instead of deferring on the last
  // attempts of the host's bounded retry chain. Off by default.
  if (raw.exhaustion != null) {
    const exh = raw.exhaustion;
    if (typeof exh !== 'object' || Array.isArray(exh)) {
      errors.push('exhaustion must be an object');
    } else {
      if ('enabled' in exh && typeof exh.enabled !== 'boolean') {
        errors.push('exhaustion.enabled must be a boolean');
      }
      if ('finalAnswerFromAttempt' in exh && (!Number.isInteger(exh.finalAnswerFromAttempt)
        || exh.finalAnswerFromAttempt < 1 || exh.finalAnswerFromAttempt > EXHAUSTION_HOST_ATTEMPTS)) {
        errors.push(`exhaustion.finalAnswerFromAttempt must be an integer in [1, ${EXHAUSTION_HOST_ATTEMPTS}]`);
      }
    }
  }
  if (raw.credentialReadiness != null) {
    const readiness = raw.credentialReadiness;
    if (typeof readiness !== 'object' || Array.isArray(readiness)) {
      errors.push('credentialReadiness must be an object');
    } else {
      if (!Object.hasOwn(readiness, 'enforce')) errors.push('credentialReadiness.enforce is required');
      if ('enforce' in readiness && typeof readiness.enforce !== 'boolean') {
        errors.push('credentialReadiness.enforce must be a boolean');
      }
      for (const key of Object.keys(readiness)) {
        if (key !== 'enforce') errors.push(`credentialReadiness.${key} is not a known key`);
      }
    }
  }
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
  if (raw.caps != null) {
    if (typeof raw.caps !== 'object' || Array.isArray(raw.caps)) {
      errors.push('caps must be an object');
    } else if ('reservedFloors' in raw.caps) {
      const rf = raw.caps.reservedFloors;
      if (rf == null || typeof rf !== 'object' || Array.isArray(rf)) {
        errors.push('caps.reservedFloors must be an object of agent id to floor');
      } else {
        for (const [agentId, spec] of Object.entries(rf)) {
          if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
            errors.push(`caps.reservedFloors.${agentId} must be an object of base, perQueued and max`);
          } else {
            if (!Number.isInteger(spec.base) || spec.base < 0) errors.push(`caps.reservedFloors.${agentId}.base must be an integer >= 0`);
            if (!Number.isInteger(spec.perQueued) || spec.perQueued < 1) errors.push(`caps.reservedFloors.${agentId}.perQueued must be an integer >= 1`);
            if (!Number.isInteger(spec.max) || spec.max < 0) errors.push(`caps.reservedFloors.${agentId}.max must be an integer >= 0`);
            else if (Number.isInteger(spec.base) && spec.max < spec.base) errors.push(`caps.reservedFloors.${agentId}.max must be >= base`);
          }
        }
      }
    }
  }
  // Failure-cluster alerts are a strict opt-in: enabled requires an explicit
  // assignee agent id, otherwise the block is inert (zero issue writes).
  const fc = raw.failureClusterAlert;
  if (fc != null) {
    if (typeof fc !== 'object' || Array.isArray(fc)) {
      errors.push('failureClusterAlert must be an object');
    } else {
      if ('enabled' in fc && typeof fc.enabled !== 'boolean') errors.push('failureClusterAlert.enabled must be a boolean');
      if ('assigneeAgentId' in fc && typeof fc.assigneeAgentId !== 'string') {
        errors.push('failureClusterAlert.assigneeAgentId must be a string');
      }
      for (const key of Object.keys(fc)) {
        if (key !== 'enabled' && key !== 'assigneeAgentId') errors.push(`failureClusterAlert.${key} is not a known key`);
      }
      if (fc.enabled === true && !(typeof fc.assigneeAgentId === 'string' && fc.assigneeAgentId.length > 0)) {
        errors.push('failureClusterAlert.assigneeAgentId is required when enabled');
      }
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
  const keepAgentIds = (Array.isArray(raw.roles?.keepAgentIds) ? raw.roles.keepAgentIds : []).filter(id => typeof id === 'string');
  return {
    ...(raw.router ? {router:{enabled:false,...structuredClone(raw.router)}} : {}),
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
      keepAgentIds,
      excludeFamilies: {
        doer: normalizeExcludedFamilies(raw.roles?.excludeFamilies?.doer),
        thinker: normalizeExcludedFamilies(raw.roles?.excludeFamilies?.thinker),
        other: normalizeExcludedFamilies(raw.roles?.excludeFamilies?.other),
      },
      // Eligibility from data (see eligibility.mjs): a per-role Q minimum
      // and a measured-outcome gate decide which arms serve a role. The
      // excludeFamilies list above is the emergency override.
      minQuality: normalizeMinQuality(raw.roles?.minQuality),
      outcomeGate: normalizeOutcomeGate(raw.roles?.outcomeGate),
      thinkerFloorRung: raw.roles?.thinkerFloorRung ?? 2,
      thinkerCeilingRung: raw.roles?.thinkerCeilingRung ?? null,
      doerFloorRung: raw.roles?.doerFloorRung ?? 0,
      doerCeilingRung: raw.roles?.doerCeilingRung ?? null,
    },
    weights: { ...DEFAULT_WEIGHTS, ...(raw.weights ?? {}) },
    taskRanking: normalizeTaskRanking(raw.taskRanking),
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
      climbForSpend: raw.pacing?.climbForSpend === true,
      // Hard in-flight cap for a pool that is ahead of its linear weekly plan
      // (see paceguard.mjs); the same knobs feed the hook, the event-time
      // path and the shadow tick.
      guard: normalizePaceGuard(raw.pacing?.guard),
    },
    // Demand-driven review reserve (see reviewreserve.mjs): the share of a
    // reserved provider's pace held back for review runs. Enabled by
    // default; enabled:false restores pre-reserve admission bit-for-bit.
    // agentIds null/empty resolves to roles.keepAgentIds.
    reviewReserve: normalizeReviewReserve(raw.reviewReserve, { keepAgentIds }),
    // Reviewer as a first-class role (see reviewer.mjs): runnable review
    // capacity from qualified providers (Claude today; others only when the
    // operator opts in) plus the hold/resume signal the review gate reads.
    // reviewer.providers unset falls back to reviewReserve.providers when
    // the operator set it (both Claude and Meta reserved = both size slots).
    reviewer: normalizeReviewer(raw.reviewer, {
      defaultProviders: Array.isArray(raw.reviewReserve?.providers) ? raw.reviewReserve.providers : null,
    }),
    // Reviewer routing (see reviewerrouting.mjs): route listed review agents
    // to the best configured arm instead of keep. Null = routing off (exact
    // pre-routing behavior). agentIds default to reviewReserve.agentIds.
    reviewerRouting: normalizeReviewerRouting(raw.reviewerRouting, {
      reviewAgentIds: normalizeReviewReserve(raw.reviewReserve, { keepAgentIds }).agentIds,
    }),
    reviewDemand: normalizeReviewDemand(raw.reviewDemand),
    // Burn mode tokens (tolerant read; absent = nothing flagged): reviewer
    // routing prefers accounts flagged here.
    burnModeTokens: [...burnModeTokens(raw.burnMode)],
    // Burn horizon (see burnhorizon.mjs): pace to min(regular reset, expected
    // free reset) so quota is spent when a provider restore lands. Enabled by
    // default; enabled:false restores linear-to-regular-reset pacing bit-for-bit.
    burnHorizon: normalizeBurnHorizon(raw.burnHorizon),
    // Burn mode (see burnmode.mjs): named accounts pace to an immediate
    // horizon, skip the pace guard and the review reserve, and sort first.
    // Empty/missing burns nothing (today's behavior bit-for-bit).
    burnMode: normalizeBurnMode(raw.burnMode),
    smoothing: normalizeSmoothing(raw.smoothing),
    // Generic credit pools (see credits.mjs): free-grant types stay available
    // past weekly exhaustion, paced to drain; paid types only when allowed.
    credits: normalizeCredits(raw.credits),
    concurrency: {
      maxTotal: raw.concurrency?.maxTotal ?? DEFAULT_CONCURRENCY.maxTotal,
      meanRunDurationHours: raw.concurrency?.meanRunDurationHours ?? DEFAULT_CONCURRENCY.meanRunDurationHours,
    },
    allocation: { blockingPriority: raw.allocation?.blockingPriority === true },
    // Sol window / Luna cliff caps over the defaults (legacy solLuna* keys
    // set Luna only); tierAffectsQuota false restores base-cost burn.
    contextCaps: normalizeContextCaps(raw.contextCaps),
    // Kill switch for run.model.resolve enforcement. False (default): the
    // hook answers keep and no run is ever changed.
    enforce: raw.enforce === true,
    credentialReadiness: {
      enforce: raw.credentialReadiness?.enforce === true,
    },
    // Failure-cluster alerts: fail closed. Enabled only when the operator
    // explicitly sets enabled:true with a non-empty assignee agent id;
    // anything else performs zero issue writes (no state I/O either).
    failureClusterAlert: {
      enabled: raw.failureClusterAlert?.enabled === true
        && typeof raw.failureClusterAlert?.assigneeAgentId === 'string'
        && raw.failureClusterAlert.assigneeAgentId.length > 0,
      assigneeAgentId: typeof raw.failureClusterAlert?.assigneeAgentId === 'string'
        ? raw.failureClusterAlert.assigneeAgentId
        : '',
    },
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
      // Provider-scoped in-flight cap: { provider -> integer >= 1 } (keys
      // lower-cased). Overrides maxInFlightPerAccount only for that
      // provider's accounts; every other provider keeps the global value.
      // Empty (default) keeps every provider on the global cap, exactly as
      // before. Malformed entries are dropped, never promoted.
      maxInFlightPerAccountByProvider: normalizeTrialCapByProvider(raw.trials?.maxInFlightPerAccountByProvider),
    },
    // Deferral-exhaustion (Design B): on the last attempts of the host's
    // bounded retry chain (default from attempt 11 of 12), stop deferring
    // and answer with the cheapest selectable free-overflow arm under the
    // existing trial caps, else a bounded keep. Disabled by default: absent
    // reads exactly as before (every terminal still defers).
    exhaustion: {
      enabled: raw.exhaustion?.enabled === true,
      finalAnswerFromAttempt: Number.isInteger(raw.exhaustion?.finalAnswerFromAttempt)
        && raw.exhaustion.finalAnswerFromAttempt >= 1
        && raw.exhaustion.finalAnswerFromAttempt <= EXHAUSTION_HOST_ATTEMPTS
        ? raw.exhaustion.finalAnswerFromAttempt
        : EXHAUSTION_DEFAULT_FINAL_ATTEMPT,
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
    // Placement blend (#2): qualityWeight 0 restores pure water-filling.
    placement: {
      qualityWeight: raw.placement?.qualityWeight ?? DEFAULT_PLACEMENT.qualityWeight,
      allowanceWeight: raw.placement?.allowanceWeight ?? DEFAULT_PLACEMENT.allowanceWeight,
      // Free-cost providers: a 'free'-plan account whose provider is listed
      // here places at zero monetary cost (costEffective 0, ladder cost 0).
      // Quota/burn accounting, quality bars and climbForSpend are unchanged;
      // the feed's usage numbers (if any) are not rewritten. Empty
      // (default) prices every account from AA, exactly as before.
      freeCostProviders: normalizeFreeCostProviders(raw.placement?.freeCostProviders),
    },
    freeLanes: normalizeFreeLanes(raw.freeLanes),
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
    // Reserved per-agent floors: `{ [agentId]: { base, perQueued, max } }`,
    // empty by default (no behaviour change until set). Invalid entries are
    // dropped here (the validator reports them); fromEntries defines own
    // data properties, so a '__proto__' agent id stays a key, never the
    // prototype.
    caps: {
      reservedFloors: sanitizeReservedFloors(raw.caps?.reservedFloors),
    },
  };
}

/**
 * Keep only well-formed floor specs: base integer >= 0, perQueued integer
 * >= 1, max integer >= base. Anything else reads as unconfigured.
 */
function sanitizeReservedFloors(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const kept = [];
  for (const [agentId, spec] of Object.entries(raw)) {
    if (typeof agentId !== 'string' || agentId.length === 0) continue;
    if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) continue;
    if (!Number.isInteger(spec.base) || spec.base < 0) continue;
    if (!Number.isInteger(spec.perQueued) || spec.perQueued < 1) continue;
    if (!Number.isInteger(spec.max) || spec.max < spec.base) continue;
    kept.push([agentId, { base: spec.base, perQueued: spec.perQueued, max: spec.max }]);
  }
  return Object.fromEntries(kept);
}

/**
 * Normalize the provider-scoped in-flight cap map: { provider -> int >= 1 }
 * with lower-cased provider keys. Malformed entries are dropped (the
 * validator reports them); an absent or malformed map reads as {} so every
 * provider keeps the global trials.maxInFlightPerAccount.
 */
export function normalizeTrialCapByProvider(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [provider, cap] of Object.entries(raw)) {
    if (typeof provider !== 'string' || provider.trim().length === 0) continue;
    if (!Number.isInteger(cap) || cap < 1) continue;
    const key = provider.trim().toLowerCase();
    if (!Object.hasOwn(out, key)) out[key] = cap;
  }
  return out;
}

/**
 * Effective per-account reactive in-flight cap for a provider: the scoped
 * override when the (case-insensitive) provider is listed, else the global
 * trials.maxInFlightPerAccount. A resolved trials object without the map
 * behaves exactly as before.
 */
export function trialInflightCapFor(trials, provider) {
  const global = trials?.maxInFlightPerAccount ?? DEFAULT_TRIALS.maxInFlightPerAccount;
  const key = typeof provider === 'string' && provider ? provider.toLowerCase() : null;
  if (key == null) return global;
  const scoped = trials?.maxInFlightPerAccountByProvider?.[key];
  return Number.isInteger(scoped) && scoped >= 1 ? scoped : global;
}

/**
 * Normalize the free-cost provider list: lower-cased provider names.
 * Malformed entries are dropped (the validator reports them); absent reads
 * as [] so every account prices from AA, exactly as before.
 */
export function normalizeFreeCostProviders(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (typeof p !== 'string' || p.trim().length === 0) continue;
    const key = p.trim().toLowerCase();
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * True when the account rides free: its feed plan is 'free'
 * (case-insensitive) and its provider is operator-listed in
 * placement.freeCostProviders. Only the monetary placement cost reads zero;
 * quality bars, quota/burn accounting and climbForSpend are untouched.
 */
export function isFreeCostAccount(account, freeCostProviders) {
  if (!Array.isArray(freeCostProviders) || freeCostProviders.length === 0) return false;
  const plan = typeof account?.plan === 'string' ? account.plan.trim().toLowerCase() : null;
  if (plan !== 'free') return false;
  const provider = typeof account?.provider === 'string' ? account.provider.toLowerCase() : null;
  return provider != null && freeCostProviders.includes(provider);
}

/**
 * Effective per-account reactive in-flight cap for one frozen live-view
 * account: the scoped trials.maxInFlightPerAccountByProvider override when
 * any of the view's provider identities (lane provider, pool, account-id
 * prefix) matches a listed provider (case-insensitive), else the published
 * scalar maxTrialInFlightPerAccount. A live view without the map behaves
 * exactly as before.
 */
export function liveTrialInflightCapFor(live, view) {
  const fallback = live?.maxTrialInFlightPerAccount ?? DEFAULT_TRIALS.maxInFlightPerAccount;
  const byProvider = live?.maxTrialInFlightPerAccountByProvider;
  if (byProvider == null || typeof byProvider !== 'object' || Array.isArray(byProvider)) return fallback;
  const candidates = [
    view?.laneProvider,
    view?.provider,
    view?.pool,
    typeof view?.accountId === 'string' ? view.accountId.split(':')[0] : null,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string' || c.length === 0) continue;
    const hit = byProvider[c.toLowerCase()];
    if (Number.isInteger(hit) && hit >= 1) return hit;
  }
  return fallback;
}

// Weekly window length for schedule-error math (the lane reports `used`
// fractions plus reset timestamps; the host owns staleness/live-pull).
const WEEKLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
// Rolling 5h meter window for the review reserve's five-hour allowance.
const FIVE_HOUR_WINDOW_MS = 5 * 3600 * 1000;
// A reset reported this far past one window still reads as a window that has
// just rolled over (feed and host clocks differ by minutes, not hours).
const PLAN_WINDOW_SLACK_MS = 3600 * 1000;

function windowStartMs(resetsAtMs) {
  if (resetsAtMs == null) return null;
  return resetsAtMs - WEEKLY_WINDOW_MS;
}

// `requirePinnedLaneHost` is a test seam: the unit suite drives the lane
// read against the public placeholder pin with a fake http client. The
// worker entry never passes it, so every deployed plugin refuses to read
// the lane key unless the build pinned a real host.
export function createModelCapacityPlugin({ clock = Date.now, requirePinnedLaneHost = true, inspectPools = null, variant = 'transitional' } = {}) {
  if (!['transitional','clean'].includes(variant)) throw new Error('invalid plugin variant');
  let ctx, quotaRefresh, routeConnection;
  const quotaJobs = new Map();
  const nativeOverlay = createRunOverlay();
  const configured = new Set();
  const ledgers = new Map(); // companyId -> Map(runId -> ledger record), the single run-accounting truth
  const ledgerReady = new Set(); // companyIds whose memory ledger absorbed persisted state
  const breakerStores = new Map(); // companyId -> breaker store (memory truth; tick persists)
  const breakerReady = new Set(); // companyIds whose breaker store absorbed persisted state
  const breakerLoads = new Map(); // companyId -> in-flight first-load promise (single-flight)
  const lastTickAtMs = new Map(); // companyId -> ms of the last successful tick (memory-only reporting stat)
  // Runs the enforcing hook deferred, per company: runId -> { atMs, ttlMs }.
  // The host claims a run (agent.run.started) before the hook answers, so a
  // deferred run sits in the ledger as running and the tick attributes it
  // to the pool its model serves; it is waiting, not executing, so the pace
  // guard leaves it out of its in-flight count. Memory-only (a restart
  // re-adds a run the next time the hook defers it); cleared when the hook
  // decides the run or it reaches a terminal state.
  //
  // A mark is a claim about the present ("this run is waiting on a retry"),
  // not a fact: the host abandons a run after a bounded number of deferred
  // attempts (12, hard-coded host-side), so a mark older than that lifespan
  // no longer means waiting. Past it the run counts as in flight again --
  // fail closed, exactly like a lost terminal event whose record stays
  // running until the in-flight horizon. The host cancels a deferred run at
  // once and retries it as a new run under a new id, so a mark is never
  // refreshed: the lifespan bound only matters when the run's terminal
  // event is lost, and then the stale mark expires instead of hiding an
  // executing run behind a waiting claim.
  const DEFERRED_MARK_ATTEMPTS = 12;
  const DEFERRED_MARK_SLACK_MS = 60 * 1000;
  const deferredRuns = new Map();
  const deferredMarkTtlMs = (retryAfterMs, horizonMs) => {
    if (!Number.isInteger(retryAfterMs) || retryAfterMs <= 0) return horizonMs;
    return Math.min(horizonMs, DEFERRED_MARK_ATTEMPTS * retryAfterMs + DEFERRED_MARK_SLACK_MS);
  };
  const markDeferred = (companyId, runId, atMs, horizonMs, retryAfterMs) => {
    if (runId == null) return;
    let m = deferredRuns.get(companyId);
    if (!m) { m = new Map(); deferredRuns.set(companyId, m); }
    m.delete(String(runId));
    m.set(String(runId), { atMs, ttlMs: deferredMarkTtlMs(retryAfterMs, horizonMs) });
    // Bounded: entries older than the in-flight horizon no longer count
    // anywhere, and the oldest go first past the ledger's own cap.
    for (const [id, mark] of m) {
      const at = typeof mark === 'object' ? mark.atMs : mark;
      if (atMs - at < horizonMs && m.size <= LEDGER_CAP) break;
      m.delete(id);
    }
  };
  const clearDeferred = (companyId, runId) => {
    if (runId != null) deferredRuns.get(companyId)?.delete(String(runId));
  };
  // Deferral-exhaustion streaks (Design B), per company: key -> { count,
  // firstAtMs, lastAtMs }. The host retries a deferred run as a NEW runId,
  // so the per-runId deferredRuns marks reset every retry and can never
  // detect exhaustion. A streak needs BOTH stable card and agent identifiers;
  // absent identifiers never share a synthetic fallback key. Memory-only (a
  // restart starts every streak at zero, i.e. defers first, exactly like today).
  //
  // Every non-defer answer, including an exhaustion answer, ends that retry
  // chain and clears its streak. A later chain for the same card must earn its
  // own grace period instead of inheriting a terminal count. Streaks expire
  // after a day and the map is bounded, so a forgotten card cannot grow memory
  // without bound.
  const EXHAUSTION_STREAK_TTL_MS = 24 * 3600 * 1000;
  const EXHAUSTION_STREAK_CAP = 1000;
  const exhaustionStreaks = new Map();
  const exhaustionKeyOf = (params) => {
    const issueId = params?.issueId;
    const agentId = params?.agentId;
    if (issueId == null || agentId == null) return null;
    const issueKey = String(issueId).trim();
    const agentKey = String(agentId).trim();
    return issueKey.length > 0 && agentKey.length > 0 ? `${issueKey}|${agentKey}` : null;
  };
  const exhaustionStreaksFor = (companyId) => {
    let m = exhaustionStreaks.get(companyId);
    if (!m) { m = new Map(); exhaustionStreaks.set(companyId, m); }
    return m;
  };
  const pruneExhaustionStreaks = (m, nowMs) => {
    for (const [k, s] of m) {
      if (nowMs - (s?.lastAtMs ?? 0) >= EXHAUSTION_STREAK_TTL_MS) m.delete(k);
      else break;
    }
    while (m.size > EXHAUSTION_STREAK_CAP) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  };
  const exhaustionStreakCount = (companyId, params, nowMs) => {
    const key = exhaustionKeyOf(params);
    if (key == null) return 0;
    const m = exhaustionStreaks.get(companyId);
    if (!m) return 0;
    const s = m.get(key);
    if (!s || nowMs - (s.lastAtMs ?? 0) >= EXHAUSTION_STREAK_TTL_MS) return 0;
    return s.count ?? 0;
  };
  const bumpExhaustionStreak = (companyId, params, nowMs) => {
    const key = exhaustionKeyOf(params);
    if (key == null) return 0;
    const m = exhaustionStreaksFor(companyId);
    pruneExhaustionStreaks(m, nowMs);
    const prev = m.get(key);
    const next = {
      count: (prev?.count ?? 0) + 1,
      firstAtMs: prev?.firstAtMs ?? nowMs,
      lastAtMs: nowMs,
    };
    m.delete(key);
    m.set(key, next);
    return next.count;
  };
  const clearExhaustionStreak = (companyId, params) => {
    const key = exhaustionKeyOf(params);
    if (key != null) exhaustionStreaks.get(companyId)?.delete(key);
  };
  /** Resolved exhaustion knob for the hook (memory-only, from onConfigChanged). */
  const exhaustionFor = (companyId) => lastConfig.get(companyId)?.exhaustion ?? null;
  const exhaustionEnabledFor = (companyId) => exhaustionFor(companyId)?.enabled === true;
  const exhaustionFinalAttemptFor = (companyId) => {
    const n = exhaustionFor(companyId)?.finalAnswerFromAttempt;
    return Number.isInteger(n) && n >= 1 && n <= EXHAUSTION_HOST_ATTEMPTS
      ? n
      : EXHAUSTION_DEFAULT_FINAL_ATTEMPT;
  };
  /**
   * Pooled in-flight for the pace guard: records that are actually
   * executing, i.e. non-terminal, verified and inside the horizon, minus
   * runs the hook deferred (waiting, not running) and minus the run being
   * decided (it must not hold its own pool at the cap).
   *
   * Deferred marks older than their retry lifespan, or whose ledger record
   * is gone, terminal, unverified or stale, are dropped on read: pruning
   * only on the next defer would let one stale mark hide an executing run
   * until another run happens to defer. Fresh starts with no decided or
   * actual account yet are reported as `unattributed` but deliberately NOT
   * counted toward any pool's cap: each may belong to any pool, or to none
   * (an undecided run may never execute), so counting them lets one burst of
   * fresh starts hold every pool for all the others and nothing is ever
   * decided. The unaccounted amount is published on the /capacity report
   * instead (see paceGuard.unattributedInFlight), so the fail-open is
   * explicit and visible.
   */
  const paceInFlightByPool = (companyId, ledger, { nowMs, horizonMs, selfRunId = null, poolOf }) => {
    const waiting = deferredRuns.get(companyId);
    if (waiting?.size > 0) {
      for (const [id, mark] of waiting) {
        const atMs = typeof mark === 'object' ? mark.atMs : mark;
        const ttlMs = typeof mark === 'object' ? mark.ttlMs : horizonMs;
        if (nowMs - atMs < ttlMs && isInflight(ledger?.get(id), nowMs, horizonMs)) continue;
        waiting.delete(id);
      }
    }
    const self = selfRunId != null ? String(selfRunId) : null;
    const census = inflightByAccount(ledger, {
      nowMs, horizonMs,
      skip: r => r?.runId === self || waiting?.has(r?.runId) === true,
    });
    const pools = {};
    for (const [id, n] of Object.entries(census.byAccount)) {
      const p = poolOf(id);
      pools[p] = (pools[p] ?? 0) + n;
    }
    return { pools, unattributed: census.unattributed };
  };
  const runEventStats = new Map(); // companyId -> { seen, lastAtMs, lastRunId } (persisted each tick)
  // Failure-cluster single-flight: event ingestion and the per-minute tick
  // share one chain per company so persisted counters, transition
  // signatures and singleton writes serialize (duplicate/out-of-order
  // delivery stays safe, restarts resume from ctx.state).
  const clusterChains = new Map(); // companyId -> Promise
  const chainCluster = (companyId, fn) => {
    const prev = clusterChains.get(companyId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    clusterChains.set(companyId, next.catch(() => {}));
    return next;
  };
  // Per-minute cluster maintenance (exits, write retries). Fully contained:
  // it never throws, and the job callback runs it even when the shadow tick
  // itself fails, so a troubled feed cannot stall alert exits.
  const runClusterMaintenance = async (companyId) => {
    const alert = lastConfig.get(companyId)?.failureClusterAlert;
    if (!alert || alert.enabled !== true) return;
    try {
      await chainCluster(companyId, () => updateFailureClusters({
        ctx,
        companyId,
        alert: lastConfig.get(companyId)?.failureClusterAlert,
        nowMs: clock(),
        event: null,
        stateKey: scopeKey,
      }));
    } catch (error) {
      ctx.logger.error('model-capacity: failure-cluster maintenance failed', { companyId, error: error?.message ?? String(error) });
    }
  };
  // Aggregate cluster status for health: per enabled company, the active
  // accounts with counts plus any unresolved alert-write error. Counts and
  // account keys only; never run payloads or secrets.
  const summarizeFailureClusters = async () => {
    const nowMs = clock();
    const companies = [];
    let activeTotal = 0;
    let writeErrors = 0;
    for (const companyId of [...configured].sort()) {
      const alert = lastConfig.get(companyId)?.failureClusterAlert;
      if (!alert || alert.enabled !== true) continue;
      let state;
      try {
        state = normalizeClusterState(await ctx.state.get(scopeKey(companyId, FAILURE_CLUSTER_STATE_KEY)));
      } catch {
        continue;
      }
      const evalResult = evaluateClusters(state, nowMs);
      const counts = {};
      for (const account of evalResult.active) counts[account] = evalResult.accounts[account].count;
      const writeError = state.lastWriteError !== null;
      if (evalResult.active.length > 0) activeTotal += evalResult.active.length;
      if (writeError) writeErrors += 1;
      companies.push({ companyId, active: evalResult.active, counts, writeError });
    }
    return { activeTotal, writeErrors, summary: { activeClusters: activeTotal, writeErrors, companies } };
  };
  const caches = new Map(); // companyId -> { identity, cache }
  const configRevisions = new Map(); // companyId -> { generation, identity, policyIdentity, policyGeneration }
  // Config contains secret references, never resolved secret values. Canonical
  // object keys keep equivalent saves from invalidating a healthy view.
  const configIdentity = value => JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const policyIdentity = ({ enforce, credentialReadiness, router, ...policy }) => configIdentity(policy);
  const generationOf = companyId => configRevisions.get(companyId)?.generation ?? 0;
  const rememberConfig = (companyId, config) => {
    const identity = configIdentity(config);
    const previous = configRevisions.get(companyId);
    if (previous?.identity !== identity) {
      const policy = policyIdentity(config);
      configRevisions.set(companyId, {
        generation: (previous?.generation ?? 0) + 1,
        identity, policyIdentity: policy,
        policyGeneration: (previous?.policyGeneration ?? 0) + (previous?.policyIdentity !== policy ? 1 : 0),
      });
      const source = caches.get(companyId);
      if (source && source.identity !== configIdentity(config.cliproxy)) caches.delete(companyId);
    }
    return generationOf(companyId);
  };
  const liveIsCurrent = (companyId, live) =>
    live?.policyGeneration === configRevisions.get(companyId)?.policyGeneration;
  const invalidatedDefer = (params, live) => {
    const retryAfterMs = 60000;
    markDeferred(params.companyId, params.runId, clock(), live?.staleHorizonMs ?? 2 * 3600 * 1000, retryAfterMs);
    return { kind: 'defer', retryAfterMs, reason: 'routing snapshot invalidated by configuration change' };
  };
  // Live view per company, populated by every tick for the memory-only
  // resolve hook: { atMs, enforce, thinkerAgentIds, doerAgentIds,
  //   excludeFamilies, roleBands, contextCaps,
  //   accounts: [{ accountId, pointer, headroomPct, remainingKnown,
  //   ladderRungs, burnPerRunPct }] } in reset order.
  const liveViews = new Map();
  // Config lifecycle owns this fence; a stale tick cannot re-enable a mode
  // after an operator changed it while the tick was awaiting telemetry.
  const taskRankingModes = new Map();
  // Only onConfigChanged writes this fence. Ticks read unvalidated persisted
  // config and may update lastConfig, but can never attest/reopen native pools.
  const noAttestedPools = Object.freeze([]);
  const attestedPools = new Map();
  const freeLaneConfigs = new Map(); // lifecycle fence; a stale tick cannot re-enable free routing
  const freeLaneUsage = new Map(); // company -> UTC-day request reservations, tick-persisted
  const taskModeCompatible = (live, companyId) => !taskRankingModes.has(companyId)
    || live?.taskRanking?.mode === taskRankingModes.get(companyId);
  // Hook and event-time decisions write straight into the memory ledger
  // (no queues): the next tick persists the same records it reads.
  // Last resolved config per company, for the memory-only event-time path
  // (the event handler performs zero I/O, so it reads this, not ctx.config).
  const lastConfig = new Map();
  const routerConfigFor = companyId => {
    const config = lastConfig.get(companyId) ?? {};
    return {...config,router:{...config.router,pools:attestedPools.get(companyId) ?? noAttestedPools}};
  };
  const readReviewDemand = createReviewDemandReader({ clock });
  // Persisted admission must not compare equal after a worker restart, even
  // when its wall clock and first per-company configuration counter match.
  const reviewAdmissionEpoch = randomUUID();
  const configGenerations = new Map();
  const configGenerationOf = companyId => configGenerations.get(companyId) ?? 0;
  const reviewAgentIdsFor = config => new Set([
    ...(config?.reviewReserve?.agentIds ?? []), ...(config?.reviewerRouting?.agentIds ?? []),
  ]);
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
  // Last reviewer-routing outcome per company (hook, memory-only), reported
  // on /capacity reviewer.routing.last by the next tick.
  const reviewerRouteLast = new Map();
  // companyIds with credentialReadiness.enforce: true. Written ONLY by
  // onConfigChanged (like enforceCompanies): the tick reads its config
  // before the lane fetch and publishes after it, so a stale in-flight tick
  // must never move this set back -- otherwise disabling enforcement
  // mid-tick would re-enable itself when the tick lands.
  const credentialEnforceCompanies = new Set();

  const cacheFor = (companyId, config) => {
    const identity = configIdentity(config.cliproxy);
    let entry = caches.get(companyId);
    if (!entry || entry.identity !== identity) {
      entry = { identity, cache: new CliproxyCache(config.cliproxy.cacheTtlSec * 1000) };
      caches.set(companyId, entry);
    }
    return entry;
  };

  /**
   * The ONE outbound CLIProxy read: GET {baseUrl}{accountsPath} with the
   * lane key in X-Api-Key. The key is resolved at call time, never stored.
   * Last line of defense: the request re-passes the lane allowlist, so no
   * code path can fetch anywhere else.
   */
  async function cliproxyLaneGet(companyId, config, generation) {
    if (requirePinnedLaneHost) assertLaneHostPinned(config.cliproxy.baseUrl);
    const laneKey = await ctx.secrets.resolve(config.cliproxy.laneKeySecretRef, { companyId, configPath: 'cliproxy.laneKeySecretRef' });
    if (generationOf(companyId) !== generation) return null;
    const req = buildLaneRequest(config.cliproxy.baseUrl, config.cliproxy.accountsPath);
    assertLaneRequest({ method: req.method, url: req.url, body: null },
      { baseUrl: config.cliproxy.baseUrl, accountsPath: config.cliproxy.accountsPath });
    return withQuotaTimeout(async signal => {
      const res = await ctx.http.fetch(req.url, { method: 'GET', headers: { [LANE_KEY_HEADER]: laneKey }, signal });
      if (res.status === 401 || res.status === 403) throw new Error('cliproxy-access-denied');
      if (res.status < 200 || res.status >= 300) throw new Error(`cliproxy-http-${res.status}`);
      return res.json();
    });
  }

  async function readAccounts(companyId, config, nowMs, generation) {
    const entry = cacheFor(companyId, config);
    const cache = entry.cache;
    const cached = cache.get('accounts', nowMs);
    // Native quota maintenance owns a fresh read each tick; a legacy demand
    // cache TTL must not turn healthy feed observations stale.
    if (cached && !config.router) return cached;
    if (!isSecretRef(config.cliproxy.laneKeySecretRef)) {
      return { accounts: [], source: 'no-secret', atMs: nowMs, modelStats: null, pricingTiers: [], eeeSnapshot: null, servedModels: null, freeResets: null };
    }
    const body = await cliproxyLaneGet(companyId, config, generation);
    // Clearing the cache alone cannot retire an outstanding source read.
    if (generationOf(companyId) !== generation || caches.get(companyId) !== entry) return null;
    // Validate observation time after the fetch, never against tick start.
    const parsed = parseLaneBody(body, clock());
    if (!parsed) throw new Error('cliproxy-lane-parse-failed');
    // EEE prior rides the same lane body (`eeeScores` key, same pattern as
    // the existing `modelStats`/`pricingTiers` keys): absent or malformed
    // means AA-only.
    const eee = body?.eeeScores && typeof body.eeeScores === 'object' ? body.eeeScores : null;
    const snapshot = {
      accounts: parsed.accounts, atMs: nowMs, source: 'cliproxy-lane', observedAtMs: parsed.observedAtMs,
      quotaFeed: body, // Job-only input; never persisted by the legacy hook path.
      modelStats: parsed.modelStats, pricingTiers: parsed.pricingTiers, eeeSnapshot: eee,
      servedModels: parsed.servedModels,
      freeResets: parsed.freeResets ?? null,
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

  /**
   * Family a finished run is judged under: the resolved actual model's
   * family, else the family the decision recorded. 'unknown' (an unresolved
   * model id) never stands in for a family.
   */
  function outcomeFamilyOf(r) {
    const inferred = inferFamily(canonicalModelName(r?.actualModel));
    return inferred && inferred !== 'unknown' ? inferred : (r?.family ?? null);
  }

  // Eligibility warnings (operator list non-empty; a role's data gates
  // suspended), logged at most once an hour per company and kind so a
  // standing override is visible in the log without a line per tick.
  const eligibilityWarnedAt = new Map();
  const missingServedModelsWarned = new Set();
  const ELIGIBILITY_WARN_EVERY_MS = 60 * 60 * 1000;
  // Fleet-stall alarms, logged at error level at most once an hour per
  // company and code (shadow-tick runs every minute; a standing stall must
  // stay visible without a line per tick). Same limiter shape as
  // warnEligibility below.
  const fleetAlarmedAt = new Map();
  const FLEET_ALARM_EVERY_MS = 60 * 60 * 1000;
  function errorFleetAlarm(companyId, code, message, fields, nowMs) {
    const key = `${companyId}:${code}`;
    const last = fleetAlarmedAt.get(key);
    if (last != null && nowMs - last >= 0 && nowMs - last < FLEET_ALARM_EVERY_MS) return;
    fleetAlarmedAt.set(key, nowMs);
    ctx.logger.error(message, { companyId, code, ...fields });
  }

  function warnEligibility(companyId, warnings, nowMs) {
    for (const w of warnings ?? []) {
      const key = `${companyId}:${w.code}:${w.role ?? ''}`;
      const last = eligibilityWarnedAt.get(key);
      if (last != null && nowMs - last >= 0 && nowMs - last < ELIGIBILITY_WARN_EVERY_MS) continue;
      eligibilityWarnedAt.set(key, nowMs);
      const log = typeof ctx.logger?.warn === 'function' ? ctx.logger.warn : ctx.logger?.info;
      log?.call(ctx.logger, `model-capacity: ${w.message}`, {
        companyId, code: w.code, ...(w.role ? { role: w.role } : {}), ...(w.roles ? { roles: w.roles } : {}),
      });
    }
  }

  // One issue read for run-outcome tracking (issues.read, positional args
  // like every other SDK read here). Null when unreadable; callers retry
  // on a later tick up to a bound.
  async function readIssueSnapshot(companyId, issueId, caches = null) {
    if (caches?.snapshots?.has(issueId)) return caches.snapshots.get(issueId);
    try {
      const snap = issueSnapshot(await ctx.issues.get(issueId, companyId));
      caches?.snapshots?.set(issueId, snap);
      return snap;
    } catch (error) {
      ctx.logger.error('model-capacity: outcome issue read failed', { companyId, error: error?.message ?? String(error) });
      return null;
    }
  }

  // Queued work per agent: assigned open issues (todo + in_progress, grouped
  // by assignee). Shared by the tick (role-weighted target) and GET /caps,
  // behind a short memo so the two read one snapshot instead of doubling
  // issue reads. Priority mode instead keys that snapshot to the capacity tick.
  // Throws when issues.read is unavailable; callers degrade.
  const queuedCache = new Map(); // companyId -> ordinary TTL snapshot
  const priorityReadyCache = new Map(); // companyId -> { tickAtMs, atMs, counts, issues }
  const QUEUED_TTL_MS = 20000;
  async function queuedSnapshot(companyId, nowMs, tickAtMs) {
    const hit = queuedCache.get(companyId);
    const fresh = hit && nowMs - hit.atMs >= 0 && nowMs - hit.atMs < QUEUED_TTL_MS;
    if (tickAtMs === undefined && fresh) return hit;
    if (tickAtMs !== undefined) {
      const priorityHit = priorityReadyCache.get(companyId);
      if (priorityHit?.tickAtMs === tickAtMs) return priorityHit;
      if (fresh && hit.atMs >= tickAtMs && Array.isArray(hit.issues)) {
        const snapshot = { ...hit, tickAtMs };
        priorityReadyCache.set(companyId, snapshot);
        return snapshot;
      }
    }
    const lists = await Promise.all([
      ctx.issues.list({ companyId, status: 'todo' }),
      ctx.issues.list({ companyId, status: 'in_progress' }),
    ]);
    const counts = new Map();
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
    const snapshot = { atMs: nowMs, counts,
      ...(tickAtMs !== undefined ? { tickAtMs, issues: lists.flat() } : {}),
    };
    if (tickAtMs !== undefined) priorityReadyCache.set(companyId, snapshot);
    // A forced priority refresh must not replace a still-fresh legacy memo:
    // unavailable relation data must retain that memo's exact TTL semantics.
    if (tickAtMs === undefined || !fresh) queuedCache.set(companyId, snapshot);
    return snapshot;
  }

  async function queuedByAgent(companyId, nowMs, tickAtMs) {
    return (await queuedSnapshot(companyId, nowMs, tickAtMs)).counts;
  }

  // Retain the two newest ticks per company, including pending/failed reads:
  // /caps can still serve the published tick while the next tick awaits state
  // writes. Older API requests must not evict either newer snapshot. No new
  // reads when disabled. Missing optional SDK relation fields still fall back.
  const blockingPriorityCache = new Map();
  async function blockingSnapshot(companyId, tickAtMs) {
    let ticks = blockingPriorityCache.get(companyId);
    if (!ticks) {
      ticks = new Map();
      blockingPriorityCache.set(companyId, ticks);
    }
    if (ticks.has(tickAtMs)) return ticks.get(tickAtMs);
    const pending = (async () => {
      // Demand and metadata must use the SAME ready-card snapshot. A new tick
      // refreshes it even inside the legacy TTL; same-tick calls retain both.
      // A failed ready read still rejects to the existing capsError path.
      const ready = await queuedSnapshot(companyId, clock(), tickAtMs);
      try {
        const other = await Promise.all(['backlog', 'in_review', 'blocked'].map(status =>
          ctx.issues.list({ companyId, status })));
        return { counts: ready.counts, priorities: buildBlockingPriorities([...ready.issues, ...other.flat()]) };
      } catch (error) {
        ctx.logger.error('model-capacity: blocking priority unavailable', { companyId, code: 'priority-unavailable' });
        return { counts: ready.counts, priorities: null };
      }
    })();
    ticks.set(tickAtMs, pending);
    if (ticks.size > 2) ticks.delete([...ticks.keys()].sort((a, b) => a - b)[0]);
    return pending;
  }

  // Runnable queued demand for kept/review agents: ACTUAL queued heartbeat
  // runs from the host aggregate `agents.getQueuedRunCounts` (capability
  // `agents.queued_counts.read`), grouped host-side by agent and scoped to
  // this company. Assigned open cards are not runnable work for a review
  // agent -- a Reviewer holding hundreds of idle chat-review cards with one
  // run in flight has demand ~1, not hundreds; counting cards let stale
  // backlog claim the whole fleet target and strand every routed agent at
  // its running floor. Routed (non-review) agents keep issue demand: their
  // queues ARE assigned cards. Behind the same short memo as the issue
  // snapshot. A denied, missing, failed or malformed read degrades to
  // unknown (ok: false); callers grant no new kept slots and say so via
  // demandSource, never falling back to assigned cards. A malformed
  // response is never cached: only a valid array census (including an
  // empty one, a genuine zero-demand result) is memoized.
  const queuedHeartbeatCache = new Map(); // companyId -> { atMs, counts: Map(agentId -> n) }
  async function queuedHeartbeatsByAgent(companyId, nowMs) {
    const hit = queuedHeartbeatCache.get(companyId);
    if (hit && nowMs - hit.atMs >= 0 && nowMs - hit.atMs < QUEUED_TTL_MS) {
      return { ok: true, counts: hit.counts };
    }
    const read = ctx.agents?.getQueuedRunCounts;
    if (typeof read !== 'function') return { ok: false, counts: new Map() };
    let rows;
    try {
      rows = await ctx.agents.getQueuedRunCounts({ companyId });
    } catch (error) {
      ctx.logger.error('model-capacity: queued-run read failed', { companyId, error: error?.message ?? String(error) });
      return { ok: false, counts: new Map() };
    }
    if (!Array.isArray(rows)) {
      ctx.logger.error('model-capacity: queued-run read returned a non-array', { companyId });
      return { ok: false, counts: new Map() };
    }
    const counts = new Map();
    for (const row of rows) {
      const agentId = row?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) continue;
      const queued = Number(row?.queued);
      if (!Number.isFinite(queued) || queued <= 0) continue;
      counts.set(agentId, (counts.get(agentId) ?? 0) + Math.floor(queued));
    }
    queuedHeartbeatCache.set(companyId, { atMs: nowMs, counts });
    return { ok: true, counts };
  }

  // Queued demand per role, for the target's demand bound. With no queued
  // work (or issues unreadable) every role reads zero and the bound is not
  // applied: the target then counts any capacity some role can use, instead
  // of collapsing to 0 on an empty queue or hollowing out on a read failure.
  async function roleDemandFor(companyId, config, nowMs) {
    const zero = { doer: 0, thinker: 0, other: 0 };
    try {
      const snapshot = config.allocation.blockingPriority ? await blockingSnapshot(companyId, nowMs) : null;
      // Keep cached priority demand immutable when overlaying review heads.
      // Invalid graphs retain the ordinary demand memo's TTL semantics.
      const counts = new Map(snapshot?.priorities != null ? snapshot.counts : await queuedByAgent(companyId, nowMs));
      const reviewIds = reviewAgentIdsFor(config);
      let reviewDemand = { eligibleHeads: 0 };
      if (config.reviewDemand && reviewIds.size > 0 && lastConfig.get(companyId) === config) {
        const heartbeat = await queuedHeartbeatsByAgent(companyId, nowMs);
        for (const id of reviewIds) counts.set(id, heartbeat.ok ? (heartbeat.counts.get(id) ?? 0) : 0);
        // The fleet demand bound must see pre-admission heads too, not only
        // the later /caps allocator. The reader shares its bounded cache.
        if (lastConfig.get(companyId) === config) reviewDemand = await readReviewDemand(ctx, companyId, config.reviewDemand);
        const ids = [...reviewIds].sort();
        for (const [i, id] of ids.entries()) {
          const heads = Math.floor(reviewDemand.eligibleHeads / ids.length)
            + (i < reviewDemand.eligibleHeads % ids.length ? 1 : 0);
          counts.set(id, (counts.get(id) ?? 0) + heads);
        }
      }
      const byRole = { ...zero };
      for (const [agentId, n] of counts) byRole[roleOf(config, agentId)] += n;
      const total = byRole.doer + byRole.thinker + byRole.other;
      return total > 0 ? { byRole, source: reviewDemand.eligibleHeads > 0 ? 'issues+review-heads' : 'issues' }
        : { byRole: zero, source: 'idle' };
    } catch (error) {
      ctx.logger.error('model-capacity: role demand read failed', { companyId, error: error?.message ?? String(error) });
      return { byRole: zero, source: 'unavailable' };
    }
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

  function buildAccountLadders({ accounts, servedModels = null, aaSnapshot, eeeSnapshot = null, config, previousLadders, stateKeys = null, trialState = null, tierFeed = null, nowMs = null }) {
    // EEE prior: usable only when the artifact is fresh; otherwise every
    // arm keeps its AA-only score (bit-for-bit identical to today).
    const tickNow = nowMs ?? clock();
    const credentialNow = clock();
    const eeeLive = eeeUsable(eeeSnapshot, { nowMs: tickNow, maxAgeDays: config.eee.maxAgeDays })
      ? eeeSnapshot.scores : null;
    const keyOf = (account, i) => stateKeys?.[i] ?? accountKey(account);
    const classic = resolveArms(aaSnapshot?.rows ?? [], config.armMap);
    // Dynamic arms from the models the feed reports served, minus ids the
    // classic table already binds. No provider list involved: the feed is
    // the only coverage source.
    const accountModels = new Set();
    for (const account of accounts ?? []) {
      for (const m of account?.models ?? []) {
        const canon = canonicalModelName(m);
        if (canon) accountModels.add(canon);
      }
    }
    const classicModels = new Set(classic.arms.map(a => a.model));
    const { bindings } = buildDynamicBindings([...accountModels], { coveredModels: [...classicModels], overrides: config.modelAaOverrides });
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
    // Account models establish coverage, but only the exact id the decision
    // will emit proves CLIProxy can route an arm. Lanes serve some models
    // ONLY under a provider-prefixed id (every Devin id is `devin/*`), so the
    // guard checks the account's exact served id (see servedIdForArm): an arm
    // is servable only when that emitted id occurs in the served list. A bare
    // id no route serves stays unservable even when another lane serves the
    // same model prefixed. Keep old feeds unchanged (no list = fail open).
    const servedIds = Array.isArray(servedModels) ? new Set(servedModels) : null;
    const unservable = [];
    const credentialAdmission = [];
    const accountArms = (accounts ?? []).map((account, i) => {
      const eligible = [];
      const refused = new Set();
      for (const arm of armsForAccount(arms, account)) {
        const emittedId = servedIdForArm(account?.models, arm.model, account?.provider, servedIds);
        if (!servedIds || servedIds.has(emittedId)) {
          const evidence = credentialEvidenceFor(account, arm.model);
          const readiness = credentialReadiness(evidence, credentialNow);
          if (!refused.has(arm.model)) {
            refused.add(arm.model);
            credentialAdmission.push({ accountId: keyOf(account, i), provider: account.provider,
              model: arm.model, evaluatedAtMs: credentialNow, ...readiness, evidence });
          }
          // Keep calibration fixed across credential flaps; admission is
          // applied to scored candidates before Pareto/placement ranking.
          eligible.push(arm);
        } else if (!refused.has(arm.model)) {
          refused.add(arm.model);
          unservable.push({
            model: account?.models?.find(m => canonicalModelName(m) === arm.model) ?? arm.model,
            accountId: keyOf(account, i),
            emitted: emittedId,
          });
        }
      }
      return eligible;
    });
    // Context-tier costing (see tiers.mjs): C_eff = base x E[multiplier]
    // per arm, ordered by the EFFECTIVE cost. The fleet baseline (median E
    // over tiered models with measured stats) prices tiered-but-unmeasured
    // arms -- never the cheap tier, never dropped. An unservable arm must
    // not change the prices of arms that can run; old feeds keep their baseline.
    const pricedArms = servedIds ? accountArms.flat() : arms;
    const tierModels = [];
    {
      const seen = new Set();
      for (const a of pricedArms) {
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
    // Fleet-comparable quality for PLACEMENT. The per-account Q below is
    // z-scored against that account's own arm set (a one-arm lane scores 0,
    // a lane of strong models scores its strongest arm near +1), so Q cannot
    // rank arms ACROSS accounts. qFleet scores every served arm against the
    // whole served fleet once, with the same weights and EEE blend, and
    // rides each rung for the placement score. Ladders and decide() stay on
    // the per-account Q: this adds a field, it changes no rung.
    const fleetArms = [];
    {
      const seenArm = new Set();
      for (const eligible of accountArms) {
        for (const a of eligible) {
          if (!seenArm.has(a.armId)) {
            seenArm.add(a.armId);
            fleetArms.push(a);
          }
        }
      }
    }
    const fleetAa = new Map(computeComposite(fleetArms, config.weights).map(sc => [sc.armId, sc.Q]));
    const fleetEee = eeeLive
      ? computeEeeComposite(fleetArms, eeeLive, {
        weights: config.eee.weights, nowMs: tickNow,
        firstPartyDiscount: config.eee.firstPartyDiscount,
        decayHalfLifeDays: config.eee.decayHalfLifeDays,
      })
      : null;
    const fleetAlphaDoer = eeeLive ? blendAlphaForRole('doer', { doer: config.eee.blendDoer, thinker: config.eee.blendThinker }) : 0;
    const fleetAlphaThinker = eeeLive ? blendAlphaForRole('thinker', { doer: config.eee.blendDoer, thinker: config.eee.blendThinker }) : 0;
    const fleetQ = (armId, alpha) => blendQ(fleetAa.get(armId) ?? null, fleetEee?.get(armId)?.Qeee ?? null, alpha);
    // Fleet-wide median pool for the cost backstop (2026-10-22): the
    // per-account profile stays local, but a lane serving only a costless
    // family still prices its arms from the fleet's measured costs instead of
    // dropping them from the ladder. fillCosts dedupes by armId, so served
    // arms are not double-counted.
    const fleetCostPool = fleetArms.map(a => ({
      armId: a.armId,
      family: a.family ?? null,
      cost: a.row.intelligenceIndexCostPerTask,
    }));
    const ladders = {};
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      // Per-account scoring: quality support and cost profile are the
      // account's own arm set, so one provider's gaps never punish another.
      const served = accountArms[i];
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
        family: a.family ?? null,
        cost: a.row.intelligenceIndexCostPerTask,
        priceIn: a.row.price1mInputTokens,
        priceOut: a.row.price1mOutputTokens,
      })), { medianPool: fleetCostPool });
      const eeeByArm = new Map();
      // Free-cost lane: a 'free'-plan account on an operator-listed provider
      // (placement.freeCostProviders) places at zero monetary cost. Quality,
      // quota/burn accounting and climbForSpend are unchanged; only C and
      // costEffective read 0 (costBase keeps the measured AA cost for audit).
      const freeCost = isFreeCostAccount(account, config.placement.freeCostProviders);
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
          // Family + model ride along for same-family newer-version dominance
          // (see ladder.mjs): entries without them keep strict-only behavior.
          family: a.family ?? null,
          model: a.model ?? null,
          Q: blendQ(qAa, qEee, alphaDoer),
          // Ladder order runs on EFFECTIVE cost (tier-adjusted). Quota burn
          // below uses the same effective cost while
          // contextCaps.tierAffectsQuota holds (default true): on
          // subscription lanes quota charges the tier price, not base.
          C: freeCost ? 0 : (tier.costEffective ?? base),
          coverage: scored.get(a.armId)?.coverage ?? 0,
          // Carried-cost provenance rides to candidates, rungs and the
          // capacity view; absent when the row measured its own costs.
          ...(a.row.costCarriedFrom != null ? { costCarriedFrom: a.row.costCarriedFrom } : {}),
          costBase: base,
          costMultiplier: tier.costMultiplier,
          costEffective: freeCost ? 0 : tier.costEffective,
          ...(freeCost ? { costFree: true } : {}),
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
      // Preserve benchmark incumbency independently of transient readiness.
      // Retain all scored candidates so expiry can expose a formerly dominated
      // but ready alternative without waiting for another telemetry tick.
      const previousRungs = prev.rankingRungs ?? prev.rungs ?? [];
      const heldPairs = prev.rankingWithinNoise ?? prev.withinNoise ?? [];
      const ranking = buildLadder(eligible, previousRungs, gateByArm, heldPairs);
      const candidates = eligible.map(r => {
          const arm = byArm.get(r.armId);
          const tier = eligibleByArm.get(r.armId);
          const eq = eeeByArm.get(r.armId) ?? {};
          return {
            ...r,
            // Emit the account's exact served id (provider-prefixed only when
            // the bare id is unserved or the provider is prefixed-only;
            // native alias-only accounts keep the bare emission). Readiness
            // below still keys on the canonical bare id: credential rows
            // name the bare proxy id, never the prefixed alias.
            model: servedIdForArm(account?.models, arm.model, account?.provider, servedIds),
            credentialEvidence: credentialEvidenceFor(account, arm.model),
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
            qFleet: fleetQ(r.armId, fleetAlphaDoer),
            qFleetThinker: fleetQ(r.armId, fleetAlphaThinker),
            eeePrior: eq.eeePrior?.Qeee ?? null,
          };
      });
      const credentialRanking = {
        candidates, rankingRungs: ranking.rungs, previousRungs,
        gateByArm: gateByArm ? Object.fromEntries(gateByArm) : null, heldPairs,
      };
      const admitted = credentialLadderFor(credentialRanking, credentialNow, config.credentialReadiness.enforce);
      // Quota burn prices the tier multiplier while tierAffectsQuota holds:
      // subscription quota charges Haiku over 100k at ~5x base, so pacing,
      // headroom (decide burn check), concurrency and target shares all see
      // the effective cost. False restores base-cost burn.
      const quotaAffects = config.contextCaps?.tierAffectsQuota !== false;
      const burnCostOf = (e) => {
        if (!quotaAffects) return costs.get(e.armId)?.C ?? null;
        // Free-cost lanes place at zero but still consume quota/rate while
        // metered: pace their burn at the measured tier cost, never at the
        // zero placement cost, so pacing never treats their runs as free.
        if (e.costFree) {
          const m = e.costMultiplier ?? 1;
          return e.costBase != null ? e.costBase * m : (costs.get(e.armId)?.C ?? null);
        }
        return e.costEffective ?? e.costBase ?? costs.get(e.armId)?.C ?? null;
      };
      ladders[keyOf(account, i)] = {
        ...admitted,
        rankingRungs: ranking.rungs,
        rankingWithinNoise: ranking.withinNoise,
        credentialRanking,
        burnPerRunPct: Object.fromEntries(eligible.map(e => [e.armId, burnFor(burnCostOf(e))])),
      };
    }
    // Feasibility-gated compact windows per MODEL (most constraining cap
    // wins per model key). Family-keyed caps leak one model's window onto
    // untiered same-family siblings, so each rung arm carries its own cap
    // and decide() reads it off the chosen arm.
    const tierCaps = tierCapsByModel(pricedArms.map(a => ({
      model: a.model,
      cap: armTierCap({
        model: a.model,
        pricingTiers: tierFeed?.pricingTiers, modelStats: tierFeed?.modelStats,
      }),
    })));
    for (const key of Object.keys(ladders)) {
      for (const r of [...ladders[key].rungs, ...ladders[key].credentialRanking.candidates]) {
        r.cap = tierCaps[tierModelKey(r.model)] ?? null;
      }
    }
    // New scores never replace legacy cost/burn inputs. Retain both views so
    // off restores the legacy view on the next native tick; shadow never changes routes.
    let taskRanking = { mode: config.taskRanking.mode, profileVersion: config.taskRanking.profileVersion,
      candidates: [], routeComparisons: [], calibration: { ready: false, reason: 'awaiting-native-attributed-outcomes' } };
    let taskFleet = null;
    if (config.taskRanking.mode !== 'off') {
      const models = new Set(accountModels);
      for (const list of accountArms) for (const a of list) models.add(a.model);
      const discovered = discoverTaskArms(aaSnapshot?.rows ?? [], models, {
        armMap: config.armMap, overrides: config.modelAaOverrides,
      });
      const pool = discovered.arms.map(a => ({ armId: a.armId, family: a.family,
        cost: a.row.intelligenceIndexCostPerTask }));
      const candidatesByAccount = Object.fromEntries(accounts.map((account, i) => {
        const legacyModels = new Set(accountArms[i].map(a => a.model));
        const relevant = discovered.arms.filter(a => Array.isArray(account.models)
          ? account.models.map(canonicalModelName).includes(a.model) : legacyModels.has(a.model));
        const filled = fillCosts(relevant.map(a => ({ armId: a.armId, family: a.family,
          cost: a.row.intelligenceIndexCostPerTask, priceIn: a.row.price1mInputTokens,
          priceOut: a.row.price1mOutputTokens })), { medianPool: pool });
        return [keyOf(account, i), relevant.map(a => {
          const model = servedIdForArm(account.models, a.model, account.provider, servedIds);
          const evidence = credentialEvidenceFor(account, a.model);
          const readiness = credentialReadiness(evidence, credentialNow);
          const base = filled.get(a.armId)?.C ?? null;
          const tier = tierCostOf(a, base);
          const effortVerified = a.evidenceReason !== 'effort-inexpressible' && (a.effortVerified
            || (Object.hasOwn(config.taskRanking.effortSupport, model) && config.taskRanking.effortSupport[model].includes(a.effort)));
          const operationalReasons = [
            ...(servedIds && !servedIds.has(model) ? ['unservable-emitted-id'] : []),
            ...(config.credentialReadiness.enforce && !readiness.eligible ? [readiness.reason] : []),
          ];
          const quotaCost = config.contextCaps?.tierAffectsQuota === false ? base : tier.costEffective ?? base;
          return { ...a, model, canonicalModel: a.model, effortVerified,
            evidenceReason: effortVerified ? null : a.evidenceReason,
            credentialEvidence: evidence, operationalReasons,
            costBase: base, costMultiplier: tier.costMultiplier, costEffective: tier.costEffective,
            tierSource: tier.tierSource, statsRequests: tier.statsRequests,
            costFree: isFreeCostAccount(account, config.placement.freeCostProviders),
            trial: !isProvenFamily(trialState, a.family), contextWindow: a.row.contextWindowTokens ?? null,
            cap: tierCaps[tierModelKey(a.model)] ?? null,
            quotaBurnPerRunPct: burnFor(quotaCost),
            evidenceObservedAt: aaSnapshot?.fetchedAt ?? null,
            fieldObservedAt: a.row.fieldObservedAt ?? null,
          };
        })];
      }));
      taskRanking = buildTaskRanking({ candidatesByAccount, config: config.taskRanking,
        minQuality: config.roles.minQuality, snapshotAt: aaSnapshot?.fetchedAt ?? null,
        previous: Object.fromEntries(Object.entries(previousLadders ?? {}).map(([key, l]) => [key, { roles: l.taskRoles ?? {} }])),
        eee: eeeLive ? { scores: eeeLive, blendDoer: config.eee.blendDoer, blendThinker: config.eee.blendThinker,
          options: { weights: config.eee.weights, nowMs: tickNow, firstPartyDiscount: config.eee.firstPartyDiscount,
            decayHalfLifeDays: config.eee.decayHalfLifeDays } } : null,
      });
      taskRanking.unmatched = discovered.unscored;
      taskRanking.candidates = Object.entries(taskRanking.accounts).flatMap(([accountId, a]) =>
        Object.values(a.roles).flatMap(r => r.candidates.map(c => ({ ...c, accountId,
          exclusionReasons: [...(c.operationalReasons ?? []), ...(c.selectionReason === 'eligible' ? [] : [c.selectionReason])],
        }))));
      // Unknown models are explicit records, not invisible missing arms.
      for (const u of discovered.unscored) for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        if (!(account.models ?? []).map(canonicalModelName).includes(u.model)) continue;
        for (const role of ['doer', 'thinker', 'other', 'reviewer']) taskRanking.candidates.push({
          accountId: keyOf(account, i), model: servedIdForArm(account.models, u.model, account.provider, servedIds),
          effort: u.effort ?? null, role, aaSlug: null, matchType: 'missing', benchmarkTrusted: false,
          Q: null, qFleet: null, aaCostPerTask: null, taskCostProxy: null,
          estimatedApiEquivalentPerAcceptedTask: null, cashUsdPerAcceptedTask: null,
          exclusionReasons: [u.reason], calibration: taskRanking.calibration,
        });
      }
      taskRanking.routeComparisons = [];
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i], key = keyOf(account, i);
        const policyArms = (config.reviewerRouting?.arms ?? []).flatMap(approved => {
          if (approved.provider !== String(account.pool ?? account.provider ?? '').toLowerCase()) return [];
          const canon = canonicalModelName(approved.model);
          const allowed = discoverTaskArms([], [canon]).unscored.every(u => u.reason !== 'identity-policy' && u.reason !== 'non-chat-model');
          if (!allowed || !(account.models ?? []).map(canonicalModelName).includes(canon)) return [];
          const model = servedIdForArm(account.models, canon, account.provider, servedIds);
          if (servedIds && !servedIds.has(model)) return [];
          const measured = taskRanking.accounts[key]?.roles.reviewer.candidates.find(c => c.model === model && c.effort === approved.effort);
          // Keep configured legacy exclusion identities even when the exact
          // AA observation is absent. These aliases confer no benchmark trust
          // and must not exclude a sibling effort of the approved model.
          const legacyArmIds = config.armMap.filter(b => canonicalModelName(b.model) === canon
            && b.effort === approved.effort).map(b => b.aaSlug);
          return [{ armId: taskArmId(canon, approved.effort ?? 'default'), model, effort: approved.effort, legacyArmIds,
            family: inferFamily(canon), aaSlug: measured?.aaSlug ?? null, credentialEvidence: credentialEvidenceFor(account, canon),
            contextWindow: measured?.contextWindow ?? null, cap: measured?.cap ?? tierCaps[tierModelKey(canon)] ?? null,
            evidenceTrust: 'policy-trusted-incumbent', benchmarkTrusted: measured?.benchmarkTrusted === true,
          }];
        });
        ladders[key].policyReviewerArms = policyArms;
        for (const incumbent of policyArms) {
          let report = taskRanking.candidates.find(c => c.accountId === key && c.model === incumbent.model && c.role === 'reviewer' && (c.effort == null || c.effort === incumbent.effort));
          if (!report) {
            report = { accountId: key, model: incumbent.model, role: 'reviewer', Q: null, qFleet: null,
              aaCostPerTask: null, taskCostProxy: null, estimatedApiEquivalentPerAcceptedTask: null, cashUsdPerAcceptedTask: null,
              matchType: 'missing', benchmarkTrusted: false, calibration: taskRanking.calibration, exclusionReasons: [] };
            taskRanking.candidates.push(report);
          }
          report.evidenceTrust = 'policy-trusted-incumbent';
          report.policyTrusted = true;
          report.effort = incumbent.effort;
          report.exclusionReasons = [];
          report.selectionReason = 'configured-reviewer-policy';
        }
      }
      for (const [key, a] of Object.entries(taskRanking.accounts)) {
        ladders[key].taskRoles = a.roles;
        ladders[key].taskRankingMode = config.taskRanking.mode;
        ladders[key].taskTrialRoles = config.trials.roles;
        ladders[key].taskBurnPerRunPct = Object.fromEntries(a.roles.doer.candidates.map(c => [c.armId, c.quotaBurnPerRunPct]));
      }
      taskFleet = [...new Set(taskRanking.candidates.filter(c => c.armId).map(c => c.armId))].map(armId => {
        const cs = taskRanking.candidates.filter(c => c.armId === armId);
        const c = cs[0];
        return { armId, family: c.family, model: c.model, effort: c.effort,
          qFleetByRole: Object.fromEntries(cs.map(a => [a.role, a.qFleet])),
          roleTrusted: Object.fromEntries(cs.map(a => [a.role, a.benchmarkTrusted && a.minQuality?.ok === true])),
        };
      });
    }
    const blocked = Object.entries(ladders).flatMap(([key, l]) =>
      (l.withinNoise ?? []).map(w => ({ account: key, ...w })));
    // Every served arm with its fleet Q (not only the ladder survivors):
    // the eligibility gates and their audit view judge the whole fleet.
    const fleet = fleetArms.map(a => ({
      armId: a.armId, family: a.family, model: a.model, effort: a.effort,
      qFleet: fleetQ(a.armId, fleetAlphaDoer), qFleetThinker: fleetQ(a.armId, fleetAlphaThinker),
    }));
    // Read-only inventory projection for /capacity: raw/canonical/emitted ids
    // plus served present/absent/unknown. Pure reporting; routing reads
    // nothing from it.
    const modelInventory = buildModelInventory({
      accounts, servedModels, arms, unscored, unservable, credentialAdmission,
      accountKeys: (accounts ?? []).map((account, i) => keyOf(account, i)),
      nowMs: tickNow,
    });
    return { ladders, fleet, taskFleet, taskRanking, skipped, arms: arms.map(a => a.armId), unscored, unservable, credentialAdmission, modelInventory, tierCaps, tierBaseline, withinNoise: blocked };
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
          caches.snapshots?.set(run.issueId, issueSnapshot(issue));
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

  // ONE quota consumer. Both the native snapshot and the retained hook tick
  // use this same fetched feed. Concurrent jobs in one config generation join;
  // config changes may admit a new request but the old generation cannot publish.
  function runQuotaTick(companyId, job) {
    const admission = configGenerationOf(companyId);
    const existing = quotaJobs.get(companyId);
    if (existing?.generation === admission) return existing.pending;
    const pending = (async () => {
      const raw = await ctx.config.get(companyId);
      if (configGenerationOf(companyId) !== admission) return {status:'superseded'};
      const config = resolveConfig(raw);
      const generation = rememberConfig(companyId, config);
      const current = () => configGenerationOf(companyId) === admission && generationOf(companyId) === generation;
      let feed;
      try {
        feed = await readAccounts(companyId, config, clock(), generation);
      } catch (error) {
        const code = /^(cliproxy-http-[0-9]{3}|cliproxy-access-denied|cliproxy-lane-host-unpinned|cliproxy-lane-parse-failed|cliproxy-timeout)$/.test(error?.message ?? '')
          ? error.message : 'quota-fetch-failed';
        quotaRefresh.failure(companyId, code);
        throw new Error(code);
      }
      if (!feed || !current()) return {status:'superseded'};
      let native;
      if (config.router) native = await quotaRefresh.refresh(companyId, config, {
        feed:feed.quotaFeed, ledger:await loadLedger(companyId), isCurrent:current,
      });
      if (!current()) return {status:'superseded'};
      await runShadowTick(companyId, job, feed);
      if (native?.status === 'error') throw new Error('native-quota-failed');
      return native ?? {status:'ok'};
    })();
    quotaJobs.set(companyId, {generation:admission,pending});
    const clear = () => {if (quotaJobs.get(companyId)?.pending === pending) quotaJobs.delete(companyId);};
    pending.then(clear,clear);
    return pending;
  }

  async function runShadowTick(companyId, job, rawSnapshot) {
    const admissionGeneration = configGenerationOf(companyId);
    const nowMs = clock();
    let generation = generationOf(companyId);
    const superseded = () => generationOf(companyId) !== generation;
    const raw = await ctx.config.get(companyId);
    if (superseded()) return { status: 'superseded' };
    const config = resolveConfig(raw);
    generation = rememberConfig(companyId, config);
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
    if (!rawSnapshot || superseded()) return { status: 'superseded' };
    // Burn accounts degraded only by the feed's utilization floor stay
    // allocatable until spent (see burnEligibleAccounts); level floors
    // (burnMode.floors) then take accounts at or below their floor out of
    // allocation (see applyBurnFloors). A copy, never a mutation: the lane
    // cache keeps the feed's own verdict.
    const snapshot = Array.isArray(rawSnapshot?.accounts)
      ? (() => {
        const keys = uniqueAccountKeys(rawSnapshot.accounts);
        return { ...rawSnapshot, accounts: applyBurnFloors(config.burnMode, burnEligibleAccounts(config.burnMode, rawSnapshot.accounts, keys), keys) };
      })()
      : rawSnapshot;
    if (snapshot.source === 'cliproxy-lane' && snapshot.servedModels == null) {
      if (!missingServedModelsWarned.has(companyId)) {
        missingServedModelsWarned.add(companyId);
        warnEligibility(companyId, [{
          code: 'served-models-missing',
          message: 'lane feed has no valid servedModels list; routing remains fail-open',
        }], nowMs);
      }
    } else {
      missingServedModelsWarned.delete(companyId);
    }
    const aaSnapshot = await ctx.state.get(scopeKey(companyId, AA_KEY));
    const pacingState = (await ctx.state.get(scopeKey(companyId, PACING_KEY))) ?? {};
    const prevLadders = (await ctx.state.get(scopeKey(companyId, LADDER_KEY)))?.ladders ?? {};
    // Trial family counters drive which families route as trials; the fresh
    // resolved config feeds the memory-only event-time path (see setup).
    const trialState = (await ctx.state.get(scopeKey(companyId, TRIAL_KEY))) ?? emptyTrialState();
    if (superseded()) return { status: 'superseded' };
    if (admissionGeneration !== configGenerationOf(companyId)) return { status: 'configuration-changed' };
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
    const { ladders, fleet: fleetArmScores, taskFleet, taskRanking, skipped, unscored, unservable, credentialAdmission, modelInventory, tierCaps, tierBaseline, withinNoise } = buildAccountLadders({
      accounts: snapshot.accounts, servedModels: snapshot.servedModels, aaSnapshot, eeeSnapshot: snapshot.eeeSnapshot ?? null, config, previousLadders: prevLadders, stateKeys, trialState,
      tierFeed: { modelStats: snapshot.modelStats, pricingTiers: snapshot.pricingTiers }, nowMs,
    });
    const credentialReadinessEnforced = config.credentialReadiness.enforce;
    const credentialAlarm = credentialAdmission.length > 0 && !credentialAdmission.some(row => row.eligible);
    if (credentialReadinessEnforced && credentialAdmission.some(row => !row.eligible)) warnEligibility(companyId, [{
      code: credentialAlarm ? 'credential-availability-all-unavailable' : 'credential-availability-excluded',
      message: credentialAlarm ? 'no arm has fresh ready credential evidence; admission closed'
        : 'arms without fresh ready credential evidence excluded before ranking',
    }], nowMs);
    const credentialCounts = new Map();
    for (const row of credentialAdmission) {
      credentialCounts.set(row.reason, (credentialCounts.get(row.reason) ?? 0) + 1);
    }
    const credentialAvailabilityReport = {
      version: 1,
      mode: credentialReadinessEnforced ? 'on' : 'off',
      alarm: credentialAlarm,
      models: credentialAdmission,
      countsByReason: Object.fromEntries(credentialCounts),
      validEnvelopeAccounts: snapshot.accounts.filter(a => a?.credentialAvailability?.status === 'valid').length,
      totalAccounts: snapshot.accounts.length,
    };
    // Breaker state rides each rung arm so ops can see why an arm is
    // unpickable; decide-time filtering (tick loop, live view) does the actual
    // excluding. Breaker account space is the ladder key (view accountId).
    {
      const breakersCfg = config.breakers ?? DEFAULT_BREAKERS;
      const breakers = breakerStores.get(companyId) ?? createBreakerStore();
      const servable = [];
      for (const [key, ladder] of Object.entries(ladders ?? {})) {
        for (const r of ladder?.rungs ?? []) {
          r.breaker = breakerState(breakers, key, r?.armId, nowMs, breakersCfg);
          if (typeof r?.armId === 'string' && r.armId.length > 0) servable.push({ accountId: key, armId: r.armId });
        }
      }
      // Servable-arm universe for the reserved-floor guard (/caps reads it):
      // decided from arms that can actually serve, never from the
      // failure-tracking map alone.
      noteKnownArms(breakers, servable, nowMs);
      breakerStores.set(companyId, breakers);
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
    // Capacity-change diff (auto-heal): compare this feed against
    // the previous tick's summary so UPWARD transitions (new account, reset,
    // guard end, recovery) bypass the rung cooldown below. Downward
    // transitions keep today's debounce (no bypass).
    const prevChange = (await ctx.state.get(scopeKey(companyId, CAPACITY_CHANGE_KEY))) ?? null;
    const prevSummaries = Array.isArray(prevChange?.accounts) ? prevChange.accounts : [];
    // Pre-step guard prediction (see predictGuard): the post-step guard flag
    // cannot be diffed before the step that sets it, so predict from this
    // tick's 5h reading against the previous guard state.
    const guardHigh = config.pacing.guardHigh;
    const guardRejoin = config.pacing.guardRejoin;
    const currSummaries = snapshot.accounts.map((a, idx) => {
      const prevGuard = (pacingState?.[stateKeys[idx]]?.guardActive) === true;
      const predictedGuard = predictGuard(prevGuard, a.fiveHour?.utilization, { guardHigh, guardRejoin });
      const resetAt = a.weekly?.resetsAtMs ?? null;
      const burnPre = burnHorizon({
        nowMs,
        resetAtMs: resetAt,
        feed: snapshot.freeResets?.[a.provider] ?? null,
        cfg: config.burnHorizon,
      });
      return {
        accountId: stateKeys[idx],
        weeklyUsed: a.weekly?.utilization ?? null,
        resetAtMs: resetAt,
        guardActive: predictedGuard,
        health: a.health ?? null,
        burnHorizonMs: burnPre?.horizonMs ?? null,
      };
    });
    // First tick with the new key only seeds (no fleet-wide wake on deploy).
    const capacityDiff = diffCapacityFeed(prevSummaries, currSummaries, { nowMs, firstTick: prevChange == null });
    // In-flight runs per account for the rate estimate (a flat whole-percent
    // meter with runs in flight is never "idle"). Same load the tick does
    // below; a failed load aborts here, still before any persist.
    const rateInFlight = inflightByAccount(await loadLedger(companyId), { nowMs, horizonMs: staleHorizonMs }).byAccount;
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
      // Free-grant credit pools (see credits.mjs): a weekly-spent account
      // with a spendable credit balance stays available, paced to drain the
      // credits over the credit (else weekly) horizon. Detection is here so
      // the required rate and plan position below already pace the credits;
      // the headroom source and the exclusion gate follow suit below.
      const credit = weeklyUsed != null && Math.max(0, 1 - weeklyUsed) <= WEEKLY_EXHAUSTED_PCT
        ? usableCredit(account.credits, config.credits)
        : null;
      // Burn horizon (see burnhorizon.mjs): pace to min(regular reset, H) so
      // the account is allowed to run ahead of linear pace when a provider
      // free reset is expected. Null reads as the regular reset (fail open).
      // hoursToReset above stays truthful; only the pace math uses the burn end.
      const burn = burnHorizon({
        nowMs, resetAtMs,
        feed: snapshot.freeResets?.[account.provider] ?? null,
        cfg: config.burnHorizon,
      });
      // Burn mode (see burnmode.mjs): an operator-flagged account paces to
      // min(regular reset, burn horizon, now + horizonMinutes, deadline),
      // so its required rate is maximal and it never reads ahead of plan.
      const burnOn = isBurnAccount(config.burnMode, account, key);
      const burnDeadlineMs = burnOn
        ? burnDeadlineAtMs(config.burnMode, account, key, nowMs)
        : null;
      const burnTarget = burnOn
        ? burnPaceTarget({ nowMs, resetAtMs, horizonMs: burn?.horizonMs ?? null, deadlineAtMs: burnDeadlineMs, cfg: config.burnMode })
        : null;
      const paceResetAtMs = burnOn
        ? burnTarget.atMs
        : (burn?.horizonMs ?? resetAtMs);
      const hoursToPaceReset = paceResetAtMs != null
        ? Math.max((paceResetAtMs - nowMs) / 3600000, 0.25)
        : null;
      // Rate inputs: append this reading, then measure over the trailing
      // window. The reading is stamped with the ACCOUNT's own observedAt
      // (each account's series carries its own time, then the body stamp,
      // then the tick time) so a cached payload does not fake movement; an
      // identical (timestamp, value) pair is an exact duplicate and is
      // skipped, everything else accumulates -- so history grows on every
      // tick that carries genuinely new data.
      let history = rateHistories[key] ?? [];
      // Tick log (see appendTickLog): the readings where the whole-percent
      // meter changed, kept 6h, so a flat 60-min window can extend back to
      // the last tick instead of reading 0%/h.
      let tickLog = rateHistories[`tick:${key}`] ?? [];
      if (weeklyUsed != null) {
        const readingAtMs = account.signalsAtMs ?? snapshot.observedAtMs ?? nowMs;
        const dup = history.some(p => p.atMs === readingAtMs && p.usedPct === weeklyUsed);
        if (!dup) {
          const lastSeenAtMs = history.length > 0 ? history[history.length - 1].atMs : null;
          history = appendUtilReading(history, { atMs: readingAtMs, usedPct: weeklyUsed }, nowMs);
          tickLog = appendTickLog(tickLog, { atMs: readingAtMs, usedPct: weeklyUsed }, nowMs, lastSeenAtMs);
        }
      }
      rateHistories[key] = history;
      if (tickLog.length > 0) rateHistories[`tick:${key}`] = tickLog;
      // Credit lanes pace the CREDIT drain, not the flat weekly meter (which
      // sits at 100% while credits are spent and would read as rate 0
      // forever): track the credit fraction as its own utilization series
      // (1 - fraction) so the controller measures the real drain rate. An
      // unquantified fraction has no measurable rate and gets no position
      // signal either (positionError 0 below), so the pointer holds instead
      // of climbing to the ceiling on fiction.
      let creditHistory = null;
      if (credit != null) {
        const cFractionNow = credit.entry.fraction;
        creditHistory = rateHistories[`credit:${key}`] ?? [];
        if (cFractionNow != null) {
          const cReadingAtMs = account.signalsAtMs ?? snapshot.observedAtMs ?? nowMs;
          const cUsed = 1 - cFractionNow;
          const cDup = creditHistory.some(p => p.atMs === cReadingAtMs && p.usedPct === cUsed);
          if (!cDup) creditHistory = appendUtilReading(creditHistory, { atMs: cReadingAtMs, usedPct: cUsed }, nowMs);
        }
        rateHistories[`credit:${key}`] = creditHistory;
      }
      // Whole-percent meters: a flat window extends to the last tick and
      // never reads exactly 0 while runs are in flight (robustRatePerHour).
      let measured = weeklyUsed != null
        ? robustRatePerHour(history, nowMs, config.pacing.rateWindowMin, config.pacing.rateMinSpanMin, {
          tickLog, inFlight: rateInFlight[key] ?? 0,
        })
        : null;
      // New-account warmup : the CONTROLLER does not act on rate
      // estimates from < 60 min of data (live: a brand-new Claude account
      // measured 4.65%/h from minutes of data and throttled). Reporting keeps
      // the measured value; control falls back to burnHorizon/linear position
      // pacing until the history spans the warmup floor. Never a hold on thin
      // data: warmup only ever replaces a descend with position logic, and a
      // bypass (upward transition) still climbs at once.
      // Warmup span comes from the full retained history (90 min), never the
      // trailing rate window: windowed points are capped at rateWindowMin and
      // real feed stamps sit seconds behind the tick clock, so the windowed
      // span hovers just under the 60-min floor forever and rate control
      // would stay dead for every account.
      let warmingUp = false;
      if (weeklyUsed != null) {
        const historySpanMs = history.length >= 2 ? history[history.length - 1].atMs - history[0].atMs : 0;
        warmingUp = isWarmupSpan(historySpanMs);
      }
      if (credit != null) {
        // The weekly series is flat at 100% on a credit lane, so its rate
        // (0) and span (old) are both lies: measure the credit drain, and
        // hold position pacing until the credit series spans the floor.
        if ((creditHistory?.length ?? 0) >= 2) {
          measured = measuredRatePerHour(creditHistory, nowMs, config.pacing.rateWindowMin, config.pacing.rateMinSpanMin);
          warmingUp = isWarmupSpan(creditHistory[creditHistory.length - 1].atMs - creditHistory[0].atMs);
        } else {
          measured = null;
          warmingUp = true;
        }
      }
      const controlMeasured = warmingUp ? null : measured;
      // Required rate needs no history and no calibration: whenever the
      // remaining fraction and the reset are both known it is a number.
      // Null (unknown) only when an input is missing -- never a 0 that
      // would read as "burn nothing".
      let required = remaining != null && hoursToPaceReset != null
        ? requiredRatePerHour({ remainingPct: remaining, hoursToReset: hoursToPaceReset })
        : null;
      const startMs = resetAtMs != null && !Number.isNaN(resetAtMs) ? windowStartMs(resetAtMs) : null;
      let positionError = weeklyUsed != null && startMs != null && paceResetAtMs != null
        ? scheduleError({ usedPct: weeklyUsed, nowMs, periodStartMs: startMs, periodEndMs: paceResetAtMs })
        : 0;
      // A burn account is never ahead: its plan is "spent by the horizon".
      if (burnOn && positionError > 0) positionError = 0;
      if (credit != null) {
        // Drain pace: the fraction (else a full window) paces the required
        // rate over the credit (else weekly) horizon. There is deliberately
        // NO position signal: windowStartMs assumes a 7-day weekly window,
        // but the credit window's start is unknowable from a reset timestamp
        // alone, so any scheduleError is fiction (a 48h credit reset reads
        // ~43% behind and climbs to the ceiling on tick 0). Rate-only pacing
        // holds through warmup and follows the measured credit drain after;
        // the positive-balance guard above cuts the account off at zero on
        // the next feed poll.
        const cFraction = credit.entry.fraction ?? 1;
        const cResetMs = credit.entry.resetsAtMs ?? resetAtMs;
        const cHours = cResetMs != null ? Math.max((cResetMs - nowMs) / 3600000, 0.25) : null;
        if (cHours != null) required = requiredRatePerHour({ remainingPct: cFraction, hoursToReset: cHours });
        positionError = 0;
      }
      // Plan position for the pace guard: the same error, but only while the
      // reading sits on a weekly window (reset ahead of now and no further
      // than one window plus clock slack). scheduleError clamps outside it,
      // which would read a lane 30% used with a reset 10 days out as 30
      // points ahead; the guard treats that as unknown and stays out of the way.
      const onWindow = resetAtMs != null && resetAtMs >= nowMs && startMs - nowMs <= PLAN_WINDOW_SLACK_MS;
      const planAhead = weeklyUsed != null && onWindow ? positionError : null;
      // Window elapsed fractions for the review reserve (per-window allowance
      // (elapsed + margin) x (1 - R); unknown position never holds -- fail
      // open, the unknown-headroom rule already excludes unreadable meters).
      const weeklyElapsed = onWindow && startMs != null && resetAtMs > startMs
        ? Math.min(1, Math.max(0, (nowMs - startMs) / (resetAtMs - startMs)))
        : null;
      const reset5Ms = account.fiveHour?.resetsAtMs ?? null;
      const start5Ms = reset5Ms != null && !Number.isNaN(reset5Ms) ? reset5Ms - FIVE_HOUR_WINDOW_MS : null;
      const onWindow5 = reset5Ms != null && reset5Ms >= nowMs && start5Ms - nowMs <= PLAN_WINDOW_SLACK_MS;
      const fiveHourElapsed = onWindow5 && start5Ms != null && reset5Ms > start5Ms
        ? Math.min(1, Math.max(0, (nowMs - start5Ms) / (reset5Ms - start5Ms)))
        : null;
      const hoursTo5hReset = reset5Ms != null ? Math.max((reset5Ms - nowMs) / 3600000, 0) : null;
      // Availability narrows selections, never the durable pacing range.
      const ceiling = (ladders[key]?.rankingRungs.length ?? ladders[key]?.rungs.length ?? 1) - 1;
      // Auto-heal fast path: upward capacity transitions recompute at once
      // (no cooldown rung delay) so a new account ramps instead of holding.
      const bypassCooldown = capacityDiff.shouldBypassCooldown(key);
      const pacingInput = nextPacing[key] ?? { pointer: 0, lastMoveAtMs: 0, guardActive: false };
      const pacingForStep = bypassCooldown ? { ...pacingInput, lastMoveAtMs: 0 } : pacingInput;
      let step = stepRateController(pacingForStep,
        {
          measuredRatePerHour: controlMeasured?.ratePerHour ?? null,
          requiredRatePerHour: required ?? 0,
          positionError,
          fiveHourUsedPct: fiveHourUsed,
        }, nowMs, config.pacing, ceiling);
      // No warmup relabel: controlMeasured=null already falls back to
      // position pacing, so a thin-data descend is a real position move and
      // must execute (and read as one). Relabeling it 'hold' kept the moved
      // pointer and the new move stamp under a hold label.
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
          reason: account.burnFloor?.reason
            ? `excluded: ${account.burnFloor.reason} -- takes runs again once the bar is above the floor`
            : `excluded: health is ${account.health ?? 'unknown'} -- only healthy accounts allocate`,
        };
      }
      // The bypass zeroes the stamp for the step only: when the step moves
      // nothing, the account's real last-move time survives. Otherwise every
      // upward event erases the cooldown until the account's next move (the
      // zeroed stamp echoes back through keepStamp and persists as 0).
      const moved = step.pointer !== pacingInput.pointer;
      nextPacing[key] = {
        pointer: step.pointer,
        lastMoveAtMs: moved ? step.lastMoveAtMs : (pacingInput.lastMoveAtMs ?? step.lastMoveAtMs),
        guardActive: step.guardActive,
        rateBasis: step.rateBasis ?? null,
      };
      // Effective headroom: the 5h meter when present, else the weekly
      // remaining as a fallback pool guard -- but ONLY for accounts whose
      // feed entry carries a `models` list (the auto-discovery feed). A
      // feed that predates `models` keeps headroom null (CISO
      // unknown-headroom rule: a meter that should exist but doesn't means
      // the reading is broken, never "plenty of quota"). Reactive accounts
      // (vendor publishes no meter at all) carry no headroom signal; their
      // eligibility comes from health alone (see select.mjs).
      const reactive = isReactiveAccount(account);
      // A spent weekly window overrides an idle 5h meter: a weekly-exhausted
      // account whose 5h meter read 0% used showed headroom 1 and drew a
      // third of all decisions. Above the exhaustion floor the 5h meter
      // stays the burst guard and weekly pacing stays the controller's job.
      const fiveHourRemaining = fiveHourUsed != null ? Math.max(0, 1 - fiveHourUsed) : null;
      const weeklyRemaining = weeklyUsed != null ? Math.max(0, 1 - weeklyUsed) : null;
      const weeklySpent = weeklyRemaining != null && weeklyRemaining <= WEEKLY_EXHAUSTED_PCT;
      let headroomPct = null;
      let headroomSource = null;
      if (credit != null) {
        // Backup capacity: the quantified fraction is the headroom. An
        // unquantified fraction (balance asserted positive) reads as a full
        // window so the lane stays routable; the balance guard cuts it off
        // at zero on the next feed poll.
        headroomPct = credit.entry.fraction ?? 1;
        headroomSource = 'credits';
      } else if (weeklySpent) {
        headroomPct = weeklyRemaining;
        headroomSource = 'weekly';
      } else if (fiveHourRemaining != null) {
        headroomPct = fiveHourRemaining;
        headroomSource = 'five-hour';
      } else if (weeklyRemaining != null && Array.isArray(account.models)) {
        headroomPct = weeklyRemaining;
        headroomSource = 'weekly-fallback';
      }
      // A healthy feed entry whose weekly window is spent cannot serve runs
      // until it resets -- unless a spendable credit pool covers it (see
      // above): report it excluded instead of narrating a hold.
      if (account.health === 'healthy' && weeklySpent && credit == null) {
        step = {
          ...step,
          guardActive: false,
          action: 'excluded',
          reason: `excluded: weekly window exhausted (${Math.round(weeklyRemaining * 1000) / 10}% left) -- resets ${hoursToReset != null ? `in ${Math.round(hoursToReset)}h` : 'at an unknown time'}`,
        };
      }
      accountViews.push({
        accountId: key,
        arms: (ladders[key]?.rungs ?? []).map(r => ({
          armId: r.armId, model: r.model, effort: r.effort, family: r.family,
          rung: r.rung, trial: r.trial,
          breaker: r.breaker ?? 'closed',
          cap: r.cap ?? null,
          // Cost provenance marks ride only priced arms, so views without
          // them stay byte-identical to the pre-carry shape.
          ...(r.costEstimated ? { costEstimated: true } : {}),
          ...(r.costCarriedFrom != null ? { costCarriedFrom: r.costCarriedFrom } : {}),
          costBase: r.costBase ?? null,
          costMultiplier: r.costMultiplier ?? 1,
          costEffective: r.costEffective ?? r.costBase ?? null,
          tierSource: r.tierSource ?? 'none',
          statsRequests: r.statsRequests ?? 0,
          qFleet: r.qFleet ?? null,
        })),
        provider: account.provider,
        health: account.health,
        meter: account.meter ?? null,
        quality: account.quality,
        reactive,
        // Free-overflow marker for the deferral-exhaustion path: a 'free'-plan
        // account on an operator-listed provider places at zero monetary cost.
        freeCost: isFreeCostAccount(account, config.placement.freeCostProviders),
        weeklyUsedPct: weeklyUsed,
        fiveHourUsedPct: fiveHourUsed,
        headroomPct,
        headroomSource,
        creditFallback: config.credits.priority === 'fallback' && credit != null,
        creditType: credit?.entry.type ?? null,
        creditFree: credit?.creditFree ?? null,
        creditBalance: credit?.entry.balance ?? null,
        creditFraction: credit?.entry.fraction ?? null,
        creditResetAtMs: credit?.entry.resetsAtMs ?? null,
        resetAtMs,
        remainingPct: remaining,
        hoursToReset,
        burnHorizonMs: burn?.horizonMs ?? null,
        burnHorizonSource: burn ? 'free-reset' : null,
        // Burn mode rides only burn accounts, so views without it stay
        // byte-identical to the pre-burn shape. paceTargetAt is the
        // effective pace end (what paceResetAtMs holds) and paceTargetSource
        // names the bound that set it: reset | horizon | deadline.
        ...(burnOn ? { burnMode: true, paceResetAtMs, paceTargetAt: burnTarget.atMs, paceTargetSource: burnTarget.source } : {}),
        ...(account.feedHealth ? { feedHealth: account.feedHealth } : {}),
        // Level floor (burnMode.floors) on matched accounts only, so other
        // views stay byte-identical: { floor, remaining, reason? }.
        ...(account.burnFloor ? { burnFloor: account.burnFloor } : {}),
        pointer: step.pointer,
        guardActive: step.guardActive,
        action: step.action,
        reason: step.reason,
        rateBasis: measured ? 'measured' : 'position',
        measuredRatePerHour: measured?.ratePerHour ?? null,
        rateSpanMs: measured?.spanMs ?? null,
        ...(measured?.basis != null && measured.basis !== 'window' ? { rateEstimate: measured.basis } : {}),
        ratePoints: measured?.points ?? 0,
        rateHistoryPoints: history.length,
        warmingUp,
        bypassedCooldown: bypassCooldown,
        requiredRatePerHour: required,
        planAhead,
        weeklyElapsed,
        fiveHourElapsed,
        hoursTo5hReset,
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
    if (config.freeLanes.enabled && !freeLaneUsage.has(companyId)) {
      const saved = await ctx.state.get(scopeKey(companyId, 'free-lanes-v1'));
      if (!freeLaneUsage.has(companyId)) freeLaneUsage.set(companyId, saved ?? {});
    }
    // Allocation targets and provider pools. CLIProxy round-robins lanes
    // of the same provider onto shared credentials, so lane-level in-flight
    // spreading is theater: pressure is real only at the provider bucket.
    // Built here (not with the calibration block below) because the breaker
    // scan attributes balance exhaustion through the same provider fallback.
    const keyToProvider = new Map(stateKeys.map((k, i) =>
      [k, String(snapshot.accounts[i]?.provider ?? String(k).split(':')[0]).toLowerCase()]));
    const poolOfKey = (key) => keyToProvider.get(key) ?? String(key).split(':')[0].toLowerCase();
    // Provider fallback for model-less runs: a run naming only a provider
    // still burned that provider's quota, so calibration and the
    // mapped/unmapped census count it under the first matching account.
    // In-flight attribution never uses this (decided ?? actual, else
    // unattributed) -- it is E-calibration scope only, plus the balance
    // fan-out below (a 402 names the serving lane, not the routing guess).
    const keyOfProvider = new Map();
    for (const [k, p] of keyToProvider) if (p && !keyOfProvider.has(p)) keyOfProvider.set(p, k);
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
      const keepAgents = new Set(config.roles?.keepAgentIds ?? []);
      for (const rec of terminalRecords(ledger)) {
        if (rec?.runId == null || seen.has(rec.runId)) continue;
        seen.add(rec.runId);
        const acct = rec.decidedAccount ?? rec.actualAccount ?? null;
        const arm = rec.armId ?? null;
        // Balance exhaustion belongs to the serving lane, not just the arm
        // that happened to be attributed (kept runs can have no armId).
        if (acct == null) continue;
        if (rec.status === 'failed') {
          // A 402 names where the run BURNED, not where shadow guessed: a
          // non-enforced routed pick is a guess, so the fan-out attributes
          // actual-first (the calibration mapping). Enforced and kept
          // decisions are authoritative -- a pinned run burns its serving
          // account by construction -- and keep decided-first. Balance text
          // never falls through to the per-arm path below: on an already-open
          // account the fan-out returns no new transitions, and falling
          // through would trip the decided arm on the wrong account.
          if (isBalanceExhaustion(rec.errorText)) {
            const decidedAuthoritative = rec.enforced === true || keepAgents.has(rec.agentId);
            const balanceAcct = decidedAuthoritative
              ? (rec.decidedAccount ?? calibrationAccount(rec, keyOfProvider) ?? acct)
              : (calibrationAccount(rec, keyOfProvider) ?? acct);
            const balanceTrips = recordAccountBalanceExhaustion(breakers, balanceAcct, {
              atMs: rec.terminalAt ?? nowMs, errorText: rec.errorText,
              // The attributed arm belongs to the decided account; when the
              // serving account differs it must not seed breaker state there.
              armId: balanceAcct === acct ? arm : null,
            }, nowMs, breakersCfg);
            breakerTransitions.push(...balanceTrips);
            continue;
          }
          if (arm == null) continue;
          const fatal = classifyArmError(rec.errorText, breakersCfg) === 'fatal';
          if (breakerProbeRunId(breakers, acct, arm, nowMs, breakersCfg) === rec.runId) {
            const t = resolveProbe(breakers, acct, arm, rec.runId, fatal ? 'arm-fatal' : 'other', rec.errorText, nowMs, breakersCfg);
            if (t) breakerTransitions.push(t);
          } else if (fatal) {
            const t = recordArmFailure(breakers, acct, arm,
              { atMs: rec.terminalAt ?? nowMs, errorText: rec.errorText }, nowMs, breakersCfg);
            if (t) breakerTransitions.push(t);
          }
        } else if (arm == null) {
          continue;
        } else if (rec.status === 'finished') {
          const t = resolveProbe(breakers, acct, arm, rec.runId, 'success', null, nowMs, breakersCfg);
          if (t) breakerTransitions.push(t);
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
    // snapshots: per-tick issue snapshots (outcome tracking) filled by the
    // same issue read the model resolution makes, so one tick never reads an
    // issue twice.
    const modelCaches = { agents: new Map(), issues: new Map(), snapshots: new Map() };
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
        // Canonical compare: a prefixed emission (`devin/<id>`) matches a
        // bare actual of the same id (account attribution stays exact).
        r.modelMatch = canonicalModelName(r.actualModel) === canonicalModelName(r.wouldModel);
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
    // Run outcomes (#2): did a finished run do its job? Baseline the issue
    // status while the run is in flight, then classify the finished run by
    // what changed on its issue (see outcomes.mjs). Bounded issue reads per
    // tick; a run the window passes is closed as unknown, never re-read.
    {
      let reads = 0;
      const inFlightNeedingBaseline = [...ledger.values()]
        .filter(r => r?.status === 'running' && r?.unverified !== true && typeof r.issueId === 'string'
          && r.issueStatus0 == null && r.baselineSkipped !== true && (r.baselineTries ?? 0) < OUTCOME_MAX_TRIES)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      for (const r of inFlightNeedingBaseline) {
        if (reads >= OUTCOME_READS_PER_TICK) break;
        // First seen late (restart, tick gap): the issue may already carry
        // the run's own status move. Leave the baseline unset -- the run
        // scores unknown.
        if (r.startedAt == null || nowMs - r.startedAt > OUTCOME_BASELINE_MAX_AGE_MS) {
          r.baselineSkipped = true;
          continue;
        }
        reads += 1;
        const snap = await readIssueSnapshot(companyId, r.issueId, modelCaches);
        if (snap?.status != null) r.issueStatus0 = snap.status;
        else r.baselineTries = (r.baselineTries ?? 0) + 1;
      }
      reads = 0;
      for (const r of ledger.values()) {
        if (r?.status !== 'finished' || r.progress != null) continue;
        if (typeof r.issueId !== 'string' || nowMs - (r.terminalAt ?? 0) > OUTCOME_EVAL_WINDOW_MS) {
          r.progress = 'unknown';
          continue;
        }
        if (reads >= OUTCOME_READS_PER_TICK) continue;
        reads += 1;
        const snap = await readIssueSnapshot(companyId, r.issueId, modelCaches);
        if (snap == null) {
          r.evalTries = (r.evalTries ?? 0) + 1;
          if (r.evalTries >= OUTCOME_MAX_TRIES) r.progress = 'unknown';
          continue;
        }
        const res = classifyOutcome({ baselineStatus: r.issueStatus0 ?? null, after: snap });
        r.progress = res.outcome;
        r.progressAt = nowMs;
      }
    }
    // Terminal-id memory is the ledger itself: terminal records persist
    // until the shadow TTL trims them, so finished runs never haunt
    // in-flight no matter how stale the rate window is.
    const terminalIds = new Set(terminalRecords(ledger).map(r => r.runId));
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

    // Pooled burn remains the cold-start prior. Real credential usage counters
    // below individualize E; model-mapped lane identities alone never do so.
    const { groupOf: calibGroupOf, members: calibMembers } = buildCalibrationGroups(snapshot.accounts, stateKeys);
    const groupOfRun = (r) => calibGroupOf.get(calibrationAccountOf(r)) ?? null;
    const runsInGroupSpan = (gid, spanMs) => startedOnCountWhere(ledger, gid, nowMs - spanMs, groupOfRun);
    const viewByKey = new Map(accountViews.map(v => [v.accountId, v]));
    const smoothState = (await ctx.state.get(scopeKey(companyId, SMOOTH_KEY))) ?? {};
    const smoothOpts = {
      halfLifeMs: config.smoothing.halfLifeMin * 60000,
      staleMs: config.smoothing.staleHours * 3600000,
    };
    const accountUsage = new Map(snapshot.accounts.map((a, i) => [stateKeys[i],
      appendAccountUsage(smoothState.accountUsage?.[stateKeys[i]], a, nowMs),
    ]));
    const prevSmoothE = smoothState.E != null && typeof smoothState.E === 'object' ? smoothState.E : {};
    const prevArmE = smoothState.armE != null && typeof smoothState.armE === 'object' ? smoothState.armE : {};
    const prevArmEpoch = smoothState.armEpoch != null && typeof smoothState.armEpoch === 'object' ? smoothState.armEpoch : {};
    const prevArmEpochAt = smoothState.armEpochAt != null && typeof smoothState.armEpochAt === 'object' ? smoothState.armEpochAt : {};
    const nextSmoothE = new Map();
    const nextArmE = {};
    const nextArmEpoch = {};
    const nextArmEpochAt = {};
    const groupE = new Map(); // gid -> mix-weighted effective burn per run
    const groupPoolE = new Map(); // gid -> pooled EWMA base the mix price rescales (for counter rebase)
    const armEpochReset = new Set(); // gids whose old-mix estimates were segmented
    // Keeper counter spans cover KEEP_MS (see calibration.mjs): after a mix
    // switch the fresh account-weekly sample still spans old-mix runs until
    // the window rolls past the segmentation tick.
    const COUNTER_WINDOW_MS = 90 * 60000;
    const calibrationGroups = {};
    for (const [gid, memberKeys] of calibMembers) {
      const pooled = pooledBurnPerRun({
        memberKeys,
        historyOf: k => rateHistories[k] ?? [],
        spanMsOf: k => viewByKey.get(k)?.rateSpanMs ?? null,
        runsInSpan: spanMs => runsInGroupSpan(gid, spanMs),
        // Per-member run counts: a member with no measurable delta voids the
        // sample unless it served nothing in the span (see pools.mjs).
        runsInSpanFor: (k, spanMs) => startedOnCountWhere(ledger, k, nowMs - spanMs, calibrationAccountOf),
        nowMs,
      });
      // Anchor (cost-model relative) burn per arm key for this pool, from the
      // member ladders' per-arm burn maps: indexed under both the routed arm
      // id and the bare model+effort form that model-only runs key by, so a
      // never-measured arm still prices relative to the pool it joins.
      const anchorByArm = {};
      for (const k of memberKeys) {
        const taskArms = config.taskRanking.mode === 'enforce' ? ladders[k]?.taskRoles?.doer?.candidates ?? [] : [];
        // New ranking estimates never enter this prior; only the original
        // tiered AA/quota input is added for newly enumerable efforts.
        const burns = { ...ladders[k]?.burnPerRunPct, ...(config.taskRanking.mode === 'enforce' ? ladders[k]?.taskBurnPerRunPct : {}) };
        const rungArms = [...(ladders[k]?.rungs ?? []), ...(ladders[k]?.credentialRanking?.candidates ?? []), ...taskArms];
        const seen = new Set();
        for (const a of rungArms) {
          if (a?.armId == null || seen.has(a.armId)) continue;
          seen.add(a.armId);
          const anchor = burns[a.armId];
          if (!(anchor > 0)) continue;
          for (const key of [
            // Routed arm ids resolve only for enforced decisions (see
            // armKeyOfRecord), so index the ladder's own arms as enforced --
            // with the served model as context so a dynamic arm whose served
            // id ends in an effort word keys verbatim, like its ledger runs.
            armKeyOfRecord({ armId: a.armId, effort: a.effort ?? null, wouldModel: a.model ?? null, enforced: true }),
            armKeyOfRecord({ armId: null, actualModel: a.model ?? null, effort: a.effort ?? null }),
            a.armId,
          ]) {
            if (key == null) continue;
            anchorByArm[key] = anchorByArm[key] != null ? Math.max(anchorByArm[key], anchor) : anchor;
          }
        }
      }
      // Per-arm run counts over the pooled sample's span: the ledger knows
      // each run's arm, so the meter delta splits by responsibility.
      let runsByArm = {};
      if (pooled && pooled.spanMs > 0) {
        const since = nowMs - pooled.spanMs;
        runsByArm = countRunsByArm([...ledger.values()].filter(r =>
          r?.startedAt != null && r.startedAt >= since && groupOfRun(r) === gid),
        { unattributed: UNATTRIBUTED_ARM });
      }
      const prevGroupArms = prevArmE[gid] != null && typeof prevArmE[gid] === 'object' ? prevArmE[gid] : {};
      const priorByArm = {};
      for (const [arm, e] of Object.entries(prevGroupArms)) {
        if (Number.isFinite(e?.value) && e.value > 0
          && Number.isFinite(e?.atMs) && nowMs - e.atMs <= smoothOpts.staleMs) priorByArm[arm] = e.value;
      }
      const rawArms = pooled
        ? attributeArmBurn({ deltaPct: pooled.deltaPct, runsByArm, priorByArm, anchorByArm })
        : {};
      const smoothedArms = {};
      for (const [arm, raw] of Object.entries(rawArms)) {
        const armEntry = smoothValue(Object.hasOwn(prevGroupArms, arm) ? prevGroupArms[arm] : null,
          raw, nowMs, smoothOpts);
        if (!armEntry) continue;
        // Remember the anchor the measurement priced against: lanes may stop
        // serving the old arm after a switch, and the rescale needs the
        // measurement-era anchor, not the current ladder (which no longer
        // names it). Prefer the previously recorded anchor when present.
        const anchor = prevGroupArms[arm]?.anchor ?? anchorByArm[arm] ?? null;
        smoothedArms[arm] = anchor != null && anchor > 0 ? { ...armEntry, anchor } : armEntry;
      }
      // Arms with no fresh sample keep their measurement while it is not
      // stale, so the current mix can still price them.
      for (const [arm, e] of Object.entries(prevGroupArms)) {
        if (!(arm in smoothedArms) && Number.isFinite(e?.value)
          && Number.isFinite(e?.atMs) && nowMs - e.atMs <= smoothOpts.staleMs) smoothedArms[arm] = e;
      }
      // Rescale anchors: recorded measurement-era anchors win for measured
      // arms (current ladders may no longer serve them); current anchors
      // price unmeasured arms joining the mix.
      const scaleAnchorByArm = { ...anchorByArm };
      for (const [arm, e] of Object.entries(smoothedArms)) {
        if (e?.anchor != null && e.anchor > 0) scaleAnchorByArm[arm] = e.anchor;
      }
      // The CURRENT run mix over the pacing window: pricing follows what
      // runs now, not the mix that produced the last meter quantum.
      const mixSince = nowMs - rateWindowMs;
      const mixCounts = countRunsByArm([...ledger.values()].filter(r =>
        r?.startedAt != null && r.startedAt >= mixSince && groupOfRun(r) === gid),
      { unattributed: UNATTRIBUTED_ARM });
      const mixTotal = Object.values(mixCounts).reduce((s, n) => s + n, 0);
      const mixShares = {};
      if (mixTotal > 0) for (const [arm, n] of Object.entries(mixCounts)) mixShares[arm] = n / mixTotal;
      const dom = dominantArm(mixShares);
      const prevDom = typeof prevArmEpoch[gid] === 'string' ? prevArmEpoch[gid] : null;
      const carried = Object.hasOwn(prevSmoothE, gid) ? prevSmoothE[gid] : null;
      const carriedVal = carried?.value ?? null;
      const armEValues = {};
      for (const [arm, e] of Object.entries(smoothedArms)) armEValues[arm] = e.value;
      // Provisional price from the CARRIED pooled value first: a flip with no
      // fresh meter sample (flat quantized meter) must not destroy the
      // persisted estimate before effectiveBurnForMix can use it.
      const provisional = effectiveBurnForMix({
        armE: armEValues, mixShares,
        pooledBurn: carriedVal, anchorByArm: scaleAnchorByArm,
      });
      const repriceVsCarried = provisional != null && carriedVal != null && carriedVal > 0
        ? Math.abs(provisional - carriedVal) / carriedVal : null;
      // Hysteresis: a dominant-arm flip segments only when the new arm holds
      // a clear share (>=60%) AND reprices the pool by >25% against the
      // carried value. A near-even mix sliding across 50/50 is run-count
      // noise, not an arm switch, and must not reset smoothing.
      const domShare = dom != null ? (mixShares[dom] ?? 0) : 0;
      const flipped = dom != null && prevDom != null && dom !== prevDom;
      const segmentedFlip = flipped && domShare >= 0.6
        && repriceVsCarried != null && repriceVsCarried > 0.25;
      // Arm-mix segmentation: a segmented flip restarts the pooled EWMA --
      // but only when a fresh sample exists. With no fresh sample the
      // carried entry is kept, so the pool stays calibrated. A first-seen
      // mix that reprices the pool by >25% segments too, so an upgrade onto
      // a switched fleet recovers now.
      let entry = smoothValue(segmentedFlip && pooled?.burnPerRunPct == null ? carried : (segmentedFlip ? null : carried),
        pooled?.burnPerRunPct ?? null, nowMs, smoothOpts);
      const poolBase = entry?.value ?? carriedVal ?? null;
      const effective = effectiveBurnForMix({
        armE: armEValues, mixShares,
        pooledBurn: poolBase, anchorByArm: scaleAnchorByArm,
      });
      const priced = effective ?? poolBase ?? null;
      if (dom != null && prevDom == null && priced != null && poolBase != null && poolBase > 0
        && Math.abs(priced - poolBase) / poolBase > 0.25) {
        if (pooled?.burnPerRunPct != null) entry = smoothValue(null, pooled?.burnPerRunPct ?? null, nowMs, smoothOpts);
        armEpochReset.add(gid);
      }
      if (segmentedFlip) armEpochReset.add(gid);
      // The epoch advances only on segmentation; otherwise the previous epoch
      // arm persists so near-even mixes do not flap the epoch every tick.
      nextArmEpoch[gid] = armEpochReset.has(gid) && dom != null ? dom : (prevDom ?? dom ?? null);
      // Segmentation time persists so fresh counter-backed samples keep
      // re-basing onto the mix price until the 90-minute counter window rolls
      // past the switch (otherwise the rebase lasts one tick and snaps back).
      if (armEpochReset.has(gid)) nextArmEpochAt[gid] = nowMs;
      else if (Number.isFinite(prevArmEpochAt[gid])) nextArmEpochAt[gid] = prevArmEpochAt[gid];
      if (entry) {
        nextSmoothE.set(gid, entry);
      }
      if (priced != null) groupE.set(gid, priced);
      if (poolBase != null) groupPoolE.set(gid, poolBase);
      if (Object.keys(smoothedArms).length > 0) nextArmE[gid] = smoothedArms;
      if (memberKeys.length > 1 || pooled) {
        calibrationGroups[gid] = {
          members: memberKeys.length,
          contributing: pooled?.contributing ?? 0,
          runs: pooled?.runs ?? 0,
          rawBurnPerRunPct: pooled?.burnPerRunPct ?? null,
          burnPerRunPct: priced,
          armBurnPerRunPct: Object.fromEntries(Object.entries(smoothedArms).map(([a, e]) => [a, e.value])),
          dominantArm: dom,
          armMixReset: armEpochReset.has(gid),
        };
      }
    }
    const medianMeasuredE = medianPositive([...groupE.values()]);
    const accountE = new Map();
    const nextAccountE = new Map();
    const currentCalibration = new Map();
    let verifiedPlanHeadroom = false;
    for (const [gid, memberKeys] of calibMembers) {
      const measured = calibrateAccounts({
        memberKeys, historyOf: k => accountUsage.get(k),
        groupBurnPerRunPct: groupE.get(gid) ?? null,
        runsBetween: (from, to) => [...ledger.values()].filter(r => {
          const at = r.startedAt ?? r.decidedAt;
          return at > from && at <= to && groupOfRun(r) === gid;
        }).length,
        nowMs,
      });
      // Group-level request diagnostics ride the first member's sample (every
      // member of the group shares the same run scale).
      const firstSample = measured.get(memberKeys[0]);
      if (calibrationGroups[gid] && firstSample) {
        calibrationGroups[gid].requestsPerRun = firstSample.requestsPerRun ?? null;
        calibrationGroups[gid].calibrationRuns = firstSample.calibrationRuns ?? null;
        calibrationGroups[gid].calibrationRequests = firstSample.calibrationRequests ?? null;
        calibrationGroups[gid].unattributedRequestShare = firstSample.unattributedRequestShare ?? null;
      }
      for (const [key, sample] of measured) {
        const history = accountUsage.get(key);
        const last = history?.at(-1);
        currentCalibration.set(key, sample);
        // A segmented mix epoch discards the member's old-mix individual
        // estimate: it reprices off the mix-weighted group prior until fresh
        // per-account evidence re-accumulates.
        const previous = armEpochReset.has(gid) ? null
          : Object.hasOwn(smoothState.accountE ?? {}, key) ? smoothState.accountE[key] : null;
        const fresh = sample.source !== 'group-prior';
        // A segmented mix epoch re-bases fresh counter-backed estimates onto
        // the mix-priced group baseline (see rebaseSampleToMix): the
        // 90-minute counter window still spans the OLD mix, so without this
        // counter-backed lanes wait out the meter window while group-prior
        // lanes already reprice. The rebase persists until the counter window
        // rolls past the segmentation tick -- otherwise it lasts one tick and
        // the next tick snaps back to the old-mix window value.
        const epochAt = armEpochReset.has(gid) ? nowMs : prevArmEpochAt[gid] ?? null;
        const inWindow = Number.isFinite(epochAt) && nowMs - epochAt < COUNTER_WINDOW_MS;
        const rebased = inWindow
          ? rebaseSampleToMix(sample, { priced: groupE.get(gid) ?? null, pooled: groupPoolE.get(gid) ?? null })
          : sample;
        // Missing/no-motion readings carry knowledge, not fake new evidence.
        // Epoch changes and stale knowledge discard the individual estimate.
        // A weekly sample the guards reject (too few attributed runs or a
        // baseline that disagrees with the prior) carries no knowledge: its
        // evidence is present but untrustworthy, so the lane reprices off the
        // current prior instead of the stale individual estimate.
        const guardRejected = sample.rejectionReason === 'low-attributed-runs'
          || sample.rejectionReason === 'baseline-out-of-bounds';
        const entry = fresh ? { ...rebased, atMs: last.atMs, epoch: last.epoch }
          : !guardRejected && previous && previous.epoch === last?.epoch && nowMs - previous.atMs <= smoothOpts.staleMs ? previous : sample;
        accountE.set(key, entry);
        if (entry.source !== 'group-prior') nextAccountE.set(key, entry);
        const view = viewByKey.get(key);
        if (fresh && view?.health === 'healthy' && view.action !== 'excluded' && !view.guardActive
          && entry.capacityWeight >= (previous?.capacityWeight ?? 1) * 1.25) verifiedPlanHeadroom = true;
      }
    }

    // Each account's target share is requiredRate / E (runs/hour it can
    // sustain; proportions match the per-account C* concurrency targets).
    // E prefers the group's measured burn-per-run, then the ladder-average
    // burn, then the calibration reference anchor; the guessed fallbacks are
    // floored at the median measured burn so an uncalibrated anchor cannot
    // claim a bigger share than a measured peer (#1).
    {
      const refAnchor = config.calibration?.referenceBurnPerRunPct ?? 0.0005;
      for (let i = 0; i < snapshot.accounts.length; i++) {
        const key = stateKeys[i];
        const view = accountViews[i];
        if (!view) continue;
        view.pool = poolOfKey(key);
        view.calibrationGroup = calibGroupOf.get(key) ?? key;
        const individual = accountE.get(key);
        // The current tick's sample names its own rejection even when the
        // priced estimate carries a previous tick's knowledge.
        const currentSample = currentCalibration.get(key);
        let E = individual?.burnPerRunPct ?? groupE.get(view.calibrationGroup) ?? null;
        view.capacityWeight = individual?.capacityWeight ?? 1;
        view.calibrationConfidence = individual?.confidence ?? 0;
        view.calibrationSource = individual?.source ?? 'group-prior';
        view.attributedRuns = individual?.attributedRuns ?? null;
        view.calibrationRejectionReason = currentSample?.rejectionReason ?? individual?.rejectionReason ?? null;
        view.attemptedAttributedRuns = currentSample?.attemptedAttributedRuns ?? individual?.attemptedAttributedRuns ?? null;
        view.unattributedRequestShare = currentSample?.unattributedRequestShare ?? individual?.unattributedRequestShare ?? null;
        view.groupMedianBurnPerRunPct = individual?.groupMedianBurnPerRunPct ?? groupE.get(view.calibrationGroup) ?? null;
        view.fiveHourBurnPerRunPct = individual?.fiveHourBurnPerRunPct ?? null;
        view.burnCalibrated = E != null;
        if (E == null) {
          const vals = Object.values(ladders[key]?.burnPerRunPct ?? {}).filter(v => v != null);
          if (vals.length > 0) E = vals.reduce((s, v) => s + v, 0) / vals.length;
          if (E == null || !(E > 0)) E = refAnchor;
          if (medianMeasuredE != null && E < medianMeasuredE) E = medianMeasuredE;
        }
        view.effectiveBurnPerRunPct = E;
        view.targetShare = view.requiredRatePerHour != null && view.requiredRatePerHour > 0
          ? view.requiredRatePerHour / E
          : null;
      }
    }

    // Review reserve: the demand-driven share of each reserved provider's
    // pace held back for review runs (see reviewreserve.mjs; native port of
    // the host stopgap). Computed once per tick, AFTER E-calibration so
    // review burn prices burnPerRunPct -- tier-adjusted while
    // contextCaps.tierAffectsQuota holds, so Haiku 5.5 long sessions burn at
    // their tier price here too. The tick's allocation order, the live view
    // (hook and event-time path) and /capacity all read this one verdict.
    // Disabled (enabled:false) computes nothing and holds nobody.
    const rrCfg = config.reviewReserve ?? normalizeReviewReserve(null, {});
    const burnAccountIds = new Set(accountViews.filter(v => v.burnMode === true).map(v => v.accountId));
    const reviewAgentIdSet = new Set(rrCfg.agentIds ?? []);
    const isReviewAgent = (agentId) => typeof agentId === 'string' && reviewAgentIdSet.has(agentId);
    let reviewReserveView = {
      enabled: rrCfg.enabled === true,
      agentIds: [...reviewAgentIdSet],
      providers: [...(rrCfg.providers ?? [])],
      perProvider: {},
      heldAccountIds: [],
    };
    if (rrCfg.enabled === true) {
      const rrStored = (await ctx.state.get(scopeKey(companyId, REVIEW_RESERVE_STATE_KEY))) ?? null;
      // Pinned/keep review runs record armId null; price them from the
      // pinned model on the kept record (wouldModel), so a Haiku-pinned
      // reviewer burns at Haiku price. Unmatched models fall back to the
      // account's hottest arm so review demand is never invisible.
      const burnOf = (armId, accountId, model = null) => {
        const ladder = ladders[accountId];
        const armModels = {};
        for (const r of [...(ladder?.rungs ?? []), ...(ladder?.credentialRanking?.candidates ?? [])]) {
          if (r?.armId != null && typeof r?.model === 'string') armModels[r.armId] = r.model;
        }
        return priceReviewBurn(ladder?.burnPerRunPct, armId, { model, armModels });
      };
      const rrQueued = queuedReviewsByAccount(ledger, {
        agentIds: [...reviewAgentIdSet], nowMs, staleHorizonMs,
      });
      const planProvidersWithHeadroom = new Set(accountViews
        .filter(v => v.creditFallback !== true && v.health === 'healthy' && v.action !== 'excluded'
          && hasUsablePlanHeadroom(v))
        .map(v => String(v.provider ?? '').toLowerCase()));
      const rrAccounts = accountViews
        .filter(v => config.credits.priority !== 'fallback' || v.creditFallback !== true
          || !planProvidersWithHeadroom.has(String(v.provider ?? '').toLowerCase()))
        .map(v => ({
          accountId: v.accountId,
          provider: v.provider,
          weeklyUsed: v.weeklyUsedPct,
          weeklyElapsed: v.weeklyElapsed ?? null,
          hoursToWeeklyReset: v.hoursToReset,
          fiveHourUsed: v.fiveHourUsedPct,
          fiveHourElapsed: v.fiveHourElapsed ?? null,
          hoursTo5hReset: v.hoursTo5hReset ?? null,
        }));
      const perProvider = {};
      const heldAccountIds = [];
      const rrNext = { byProvider: {} };
      for (const provider of rrCfg.providers ?? []) {
        const ownIds = rrAccounts
          .filter(a => String(a.provider ?? '').toLowerCase() === String(provider).toLowerCase())
          .map(a => a.accountId);
        const prev = priorProviderReserveState(rrStored, provider, { accountIds: ownIds });
        const ownIdSet = new Set(ownIds);
        // Dedupe by folded runId, not by watermark: a run that starts
        // before a tick but is attributed after it still folds exactly once.
        const seen = new Set(prev?.folded ?? []);
        const { events: provEvents, runIds: foldedNow } = reviewEventsFromLedger(ledger, {
          agentIds: [...reviewAgentIdSet], burnOf, seenRunIds: seen,
        });
        const verdict = computeProviderReserve({
          provider, accounts: rrAccounts, state: prev, nowMs, cfg: rrCfg,
          events: provEvents.filter(e => ownIdSet.has(e.accountId)),
          queuedByAccount: rrQueued,
        });
        // The bucket/envelope/runs-rate state persists; the published
        // verdict carries the numbers, not the carried state.
        const { state: verdictState, ...pub } = verdict;
        perProvider[provider] = pub;
        // Burn-mode accounts are never held for reviews (see burnmode.mjs).
        heldAccountIds.push(...verdict.heldAccountIds.filter(id => !burnAccountIds.has(id)));
        for (const id of foldedNow) { seen.delete(id); seen.add(id); }
        rrNext.byProvider[provider] = {
          ...verdictState,
          folded: [...seen].slice(-REVIEW_FOLDED_CAP),
        };
      }
      await ctx.state.set(scopeKey(companyId, REVIEW_RESERVE_STATE_KEY), rrNext);
      reviewReserveView = {
        enabled: true,
        agentIds: [...reviewAgentIdSet],
        providers: [...(rrCfg.providers ?? [])],
        perProvider,
        heldAccountIds,
      };
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

    // Concurrency target from the pooled burn above. Role-aware (#1): each
    // account's slots count only for roles with a reachable arm there
    // (family exclusions, the role's floor..ceiling window, trial gating),
    // weighted by each role's queued demand, so capacity the roles cannot
    // use never inflates the target. Smoothed (#3) so a one-tick burn or
    // queue swing does not flap the caps.
    const burnOf = key => {
      const b = ladders[key]?.burnPerRunPct ?? {};
      const vals = Object.values(b).filter(v => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((sum, v) => sum + v, 0) / vals.length;
    };
    const roleBands = {
      thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
      doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
    };
    // Eligibility from data: per-role Q minimum + measured-outcome gate,
    // folded with the operator's emergency list into one exclusion-token
    // list per role. Everything below (target, placement, picks) and the
    // published live view read this list, so the gates act on every path.
    const taskManual = translateTaskExclusions(config.roles.excludeFamilies, taskRanking.candidates);
    const eligibilityForMode = (mode, arms, manual) => buildEligibility({
      arms, records: terminalRecords(ledger), nowMs, minQuality: config.roles.minQuality,
      outcomeGate: config.roles.outcomeGate, manual,
      roleOf: agentId => roleOf(config, agentId), familyOf: outcomeFamilyOf,
      // All roles use their own frontier in the new mode. A transient
      // credential/breaker/health loss cannot lift an operator override.
      accountGroups: Object.fromEntries(ROLES.map(role => [role, ordered
        .filter(a => a?.health === 'healthy' && a?.action !== 'excluded')
        .map(a => filterBreakerRungs(credentialGroupsFor(ladders[a.accountId], nowMs,
          config.credentialReadiness.enforce, role, mode), breakers, a.accountId, nowMs, breakersCfg))])),
      structuralGroups: Object.fromEntries(ROLES.map(role => [role, ordered.map(a => {
        const l = ladders[a.accountId];
        const rank = mode === 'enforce' ? l?.taskRoles?.[role] : l?.credentialRanking;
        const rungs = rank?.rankingRungs ?? l?.rankingRungs ?? [];
        const byArm = new Map(rungs.map(r => [r.armId, r.rung]));
        return groupByRung((rank?.candidates ?? l?.rungs ?? []).filter(c => byArm.has(c.armId))
          .map(c => ({ ...c, rung: byArm.get(c.armId) })));
      })])),
      roleBands, trialRoles: config.trials.roles,
    });
    const legacyEligibility = eligibilityForMode('off', fleetArmScores, config.roles.excludeFamilies);
    const taskEligibility = config.taskRanking.mode !== 'off'
      ? eligibilityForMode('enforce', taskFleet ?? [], taskManual) : null;
    const eligibility = config.taskRanking.mode === 'enforce' ? taskEligibility : legacyEligibility;
    const roleExclusions = eligibility.exclusions;
    const exclusionsForMode = (role, mode = config.taskRanking.mode) =>
      (mode === 'enforce' ? taskEligibility : legacyEligibility)?.exclusions?.[role] ?? [];
    if (taskEligibility) {
      taskRanking.gateSuspensions = taskEligibility.report.warnings;
      taskRanking.translatedExclusions = taskManual;
    }
    warnEligibility(companyId, eligibility.report.warnings, nowMs);
    const viewById = new Map(accountViews.map(v => [v.accountId, v]));
    const roleAccess = Object.create(null);
    for (const a of ordered) {
      const entry = {};
      for (const role of ROLES) {
        const groups = filterBreakerRungs(credentialGroupsFor(ladders[a.accountId], nowMs, config.credentialReadiness.enforce, role), breakers, a.accountId, nowMs, breakersCfg);
        entry[role] = roleLadderAccess(groups, {
          role, roleBands, excludedFamilies: roleExclusions[role], trialRoles: config.trials.roles,
        });
      }
      roleAccess[a.accountId] = entry;
    }
    let concurrencyRoleAccess = roleAccess;
    const demand = await roleDemandFor(companyId, config, nowMs);
    if (superseded()) return { status: 'superseded' };
    if (admissionGeneration !== configGenerationOf(companyId)) return { status: 'configuration-changed' };
    // In-flight runs per role join the demand bound (see concurrency.mjs):
    // the queued-issue count cannot see runs on in_review issues, chat or
    // heartbeat runs, and a queued-only bound can otherwise drop the served
    // target below what is already running. Same running definition as the
    // census below (verified live runs only).
    const roleRunning = { doer: 0, thinker: 0, other: 0 };
    for (const r of ledger.values()) {
      if (r?.status !== 'running' || r?.unverified === true) continue;
      const agentId = r?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0 || agentId === 'unknown') continue;
      const role = roleOf(config, agentId);
      if (freeProvider(viewById.get(r.enforced ? r.decidedAccount : r.actualAccount), config.freeLanes) == null
        && Object.hasOwn(roleRunning, role)) roleRunning[role] += 1;
    }
    // Free providers never enter paid C*, including calibration/fallback sums.
    const concurrencyAccounts = ordered.filter(a => freeProvider(a, config.freeLanes) == null).map(a => {
      const gid = calibGroupOf.get(a.accountId) ?? a.accountId;
      return {
        accountId: a.accountId,
        calibrationGroup: gid,
        // Credit lanes pace the credit pool, not the spent weekly window:
        // the C* need uses the credit fraction (else a full window) over
        // the credit reset horizon, so the fleet target counts the credits.
        remainingPct: a.creditType != null ? (a.creditFraction ?? 1) : (a.remainingPct ?? 0),
        // The C* need is the same term as targetShare (requiredRate / E):
        // both pace to the burn end, so the fleet target moves with the
        // allowance the horizon grants. burnHorizonMs is set only when a
        // finite regular reset binds after it, so the fallback is exact.
        hoursToReset: (() => {
          if (a.creditType != null && a.creditResetAtMs != null) {
            return Math.max((a.creditResetAtMs - nowMs) / 3600000, 0.25);
          }
          // A burn-mode account paces to its burn end (now + horizon), so its need -- and the fleet C* -- grow
          // with it; pacing it alone while C* stays at plan would leave the burn starved of slots.
          const paceEndMs = a.burnMode === true && a.paceResetAtMs != null
            ? a.paceResetAtMs
            : (a.burnHorizonMs ?? a.resetAtMs);
          return paceEndMs != null ? Math.max((paceEndMs - nowMs) / 3600000, 0.25) : 168;
        })(),
        burnPerRunPct: burnOf(a.accountId),
        measuredBurnPerRunPct: accountE.get(a.accountId)?.burnPerRunPct ?? groupE.get(gid) ?? null,
        groupMedianBurnPerRunPct: viewByKey.get(a.accountId)?.groupMedianBurnPerRunPct ?? null,
        runsInWindow: accountE.get(a.accountId)?.attributedRuns ?? runsInGroupSpan(gid, rateWindowMs),
        guardActive: a.guardActive,
        healthy: a.health === 'healthy' && a.action !== 'excluded',
      };
    });
    const concurrencyOptions = {
      accounts: concurrencyAccounts,
      meanRunDurationHours: config.concurrency.meanRunDurationHours,
      maxTotal: config.concurrency.maxTotal,
      roleDemand: demand.byRole,
      roleRunning,
      trialSlotCap: config.trials.maxInFlightPerAccount,
      // Provider-scoped trial caps reach the concurrency target too, so a
      // trial-only account on a capped provider never publishes more slots
      // than its cap permits. Absent overrides read as the global cap.
      trialSlotCapFor: (accountId) => trialInflightCapFor(config.trials, viewById.get(accountId)?.provider),
    };
    let concurrency = computeConcurrencyTarget({ ...concurrencyOptions, roleAccess: concurrencyRoleAccess });
    if (config.credits.priority === 'fallback') {
      const planSlotsByRole = planConcurrencyRoles(
        concurrency.perAccount, viewById, reviewReserveView.heldAccountIds,
      );
      const creditAccountIds = ordered.filter(a => viewById.get(a.accountId)?.creditFallback === true).map(a => a.accountId);
      concurrencyRoleAccess = gateCreditConcurrencyRoles(roleAccess, creditAccountIds, planSlotsByRole);
      concurrency = computeConcurrencyTarget({ ...concurrencyOptions, roleAccess: concurrencyRoleAccess });
    }
    for (const row of concurrency.perAccount) {
      row.calibrationGroup = calibGroupOf.get(row.accountId) ?? row.accountId;
      row.capacityWeight = accountE.get(row.accountId)?.capacityWeight ?? 1;
    }
    // EWMA the served target. A zero (everything guarded: shed now) and a
    // null (weak: nothing measured) pass through unsmoothed and reset the
    // series, so safety sheds are never lagged.
    const rawTarget = concurrency.target;
    // New accounts need their own evidence before an accelerated ramp. A
    // previously known healthy account's reset/recovery can use its existing
    // calibration. An uncalibrated feed addition never removes damping.
    const verifiedFeedHeadroom = [...capacityDiff.upwardIds].some(key => {
      const v = viewByKey.get(key);
      return v?.health === 'healthy' && v.action !== 'excluded' && !v.guardActive && v.burnCalibrated
        && (!capacityDiff.added.includes(key) || v.calibrationSource !== 'group-prior');
    });
    const targetStep = smoothTarget(smoothState, rawTarget, nowMs, {
      verifiedHeadroom: verifiedPlanHeadroom || verifiedFeedHeadroom, config: config.smoothing,
    });
    const nextSmoothTarget = targetStep.target;
    if (rawTarget != null && rawTarget > 0) {
      concurrency.target = Math.min(nextSmoothTarget.value, config.concurrency.maxTotal);
      // Demand bound (current queues, applied after smoothing so a surge is
      // not lagged): never serve more concurrency than the queued work can
      // fill. Zero means no account serves the queued roles; that is left to
      // the decision path, not shed here.
      if (concurrency.demandBound != null && concurrency.demandBound > 0) {
        concurrency.target = Math.min(concurrency.target, concurrency.demandBound);
      }
    }
    concurrency.targetRaw = rawTarget;

    // Fleet-stall alarm (2026-10-17): an empty ladder on EVERY account, or a
    // zero served target while accounts with headroom remain, pages at
    // error level (rate-limited to hourly per company+code). Guarded and
    // zero-headroom accounts are excluded from the target-0 set: an
    // all-guarded fleet reading target 0 is the designed shed, not a stall.
    for (const alarm of fleetStallAlarms({
      ladders, accountCount: (snapshot.accounts ?? []).length,
      accounts: concurrencyAccounts, target: concurrency.target,
    })) {
      if (alarm.code === 'all-ladders-empty') {
        errorFleetAlarm(companyId, alarm.code, 'model-capacity: all account ladders empty', {
          accounts: (snapshot.accounts ?? []).length,
          aaRows: aaSnapshot?.rows?.length ?? 0,
          leaderboardSlugs: aaSnapshot?.leaderboardSlugs?.length ?? 0,
          lastLeaderboardError: aaSnapshot?.lastLeaderboardError ?? null,
        }, nowMs);
      } else if (alarm.code === 'target-zero-with-headroom') {
        errorFleetAlarm(companyId, alarm.code, 'model-capacity: capacity target is 0 with healthy accounts', {
          healthyAccounts: alarm.accountIds,
          targetRaw: rawTarget,
          aaRows: aaSnapshot?.rows?.length ?? 0,
          leaderboardSlugs: aaSnapshot?.leaderboardSlugs?.length ?? 0,
          lastLeaderboardError: aaSnapshot?.lastLeaderboardError ?? null,
        }, nowMs);
      }
    }

    // Ledger first: hook and event-time decisions since the last tick are
    // already in it (no queues to merge). Restart reconciliation only marks
    // unverifiable records -- it never deletes, so the shadow log survives
    // restarts with enforced flags and terminal history intact. Long runs
    // verify against proof-of-life (a fresh start clears `unverified`) or
    // the stale horizon -- never the 60-min rate window, which would drop
    // still-running runs across restarts.
    // Cross-account dominance + aggregator fallback-only.
    // Served models come from the lane feed (authoritative); ladders may
    // already exclude unserved ids. Views without a feed models list fail
    // open (never fallback-only). Dominance uses fleet Q + effective cost;
    // only qualified-with-headroom accounts dominate.
    {
      const feedModelsByKey = new Map();
      for (let i = 0; i < snapshot.accounts.length; i++) {
        const raw = snapshot.accounts[i]?.models;
        const set = new Set();
        if (Array.isArray(raw)) {
          for (const m of raw) {
            const k = canonicalKey(m);
            if (k) set.add(k);
          }
        }
        feedModelsByKey.set(stateKeys[i], set);
      }
      const orderingViews = accountViews.map(v => ({
        accountId: v.accountId,
        provider: v.provider,
        health: v.health,
        meter: v.meter,
        quality: v.quality,
        headroomPct: v.headroomPct,
        remainingPct: v.remainingPct ?? null,
        models: [...(feedModelsByKey.get(v.accountId) ?? [])],
      }));
      const nativeModels = nativeQualifiedModels(orderingViews, 0.05);
      // Dominators must be routable this tick: qualified with headroom AND
      // a known weekly remaining (the candidate loop skips metered accounts
      // with remainingPct == null, so a 5h-only reading must not dominate).
      const qualifiedHeadroom = new Set(
        orderingViews.filter(v => hasHeadroom(v, 0.05) && v.remainingPct != null).map(v => v.accountId),
      );
      const fleetArms = [];
      const allowedDominatorKeys = new Set();
      for (const [key, ladder] of Object.entries(ladders ?? {})) {
        for (const r of ladder?.rungs ?? []) {
          const breaker = r.breaker ?? 'closed';
          fleetArms.push({
            accountId: key,
            armId: r.armId,
            family: r.family,
            model: r.model,
            Q: r.qFleet ?? null,
            C: r.costEffective ?? r.C ?? null,
            breaker,
          });
          if (breaker === 'closed') allowedDominatorKeys.add(`${key}\u0000${r.armId}`);
        }
      }
      const dominated = crossAccountDominated(fleetArms, qualifiedHeadroom, { allowedKeys: allowedDominatorKeys });
      const dominatedKeys = new Set(dominated.map(d => `${d.accountId}\u0000${d.armId}`));
      const dupKeys = new Set();
      for (const [key, ladder] of Object.entries(ladders ?? {})) {
        const probe = orderingViews.find(v => v.accountId === key);
        if (!probe || !isAggregatorAccount(probe)) continue;
        const duplicateArmIds = [];
        // Candidates, not survivors: a duplicate shadowed on the Pareto front
        // today is revived by admission once its unique sibling loses readiness.
        for (const r of ladder?.credentialRanking?.candidates ?? ladder?.rungs ?? []) {
          const k = canonicalKey(r.model);
          if (k && nativeModels.has(k)) {
            dupKeys.add(`${key}\u0000${r.armId}`);
            duplicateArmIds.push(r.armId);
          }
        }
        if (ladder?.credentialRanking) ladder.credentialRanking.duplicateArmIds = duplicateArmIds;
      }
      // Duplicate aggregator rungs are NOT dropped: deleting them strands
      // runs when no native can route this tick (reactive cap, open
      // breaker). Routing holds them back in its first pass instead (see
      // withDuplicatePass); dupKeys stays as the informational log set.
      const dropKeys = dominatedKeys;
      if (dropKeys.size > 0) {
        for (const [key, ladder] of Object.entries(ladders ?? {})) {
          // Routing rebuilds the admitted ladder from credentialRanking, so
          // the dominated ids are excluded there after buildLadder. Removing
          // the candidates instead would let the per-account Pareto revive
          // arms that only the dominated arm had pushed off the ladder.
          const ranking = ladder?.credentialRanking;
          if (ranking) {
            ranking.excludedArmIds = [...dropKeys]
              .filter(k => k.startsWith(`${key}\u0000`))
              .map(k => k.split('\u0000')[1]);
          }
          const before = (ladder?.rungs ?? []).length;
          if (before === 0) continue;
          const kept = (ladder.rungs ?? []).filter(r => !dropKeys.has(`${key}\u0000${r.armId}`));
          if (kept.length !== before) {
            ladder.rungs = kept.map((r, rung) => ({ ...r, rung }));
            ladder.crossAccountDominated = [
              ...(ladder.crossAccountDominated ?? []),
              ...[...dropKeys].filter(k => k.startsWith(`${key}\u0000`)).map(k => k.split('\u0000')[1]),
            ];
          }
        }
        for (const v of accountViews) {
          if (!Array.isArray(v.arms)) continue;
          const key = v.accountId;
          v.arms = v.arms.filter(a => !dropKeys.has(`${key}\u0000${a.armId}`));
        }
      }
      for (const v of accountViews) {
        const probe = orderingViews.find(o => o.accountId === v.accountId);
        v.models = probe ? probe.models : [];
        v.fallbackOnly = probe ? isFallbackOnlyView(probe, nativeModels) : false;
      }
      if (dominated.length > 0 || dupKeys.size > 0) {
        ctx.logger.info('model-capacity: cross-account filter', {
          companyId,
          dominated: dominated.map(d => `${d.accountId}:${d.armId} by ${d.dominatedBy}`),
          aggregatorDuplicates: [...dupKeys].map(k => k.replace('\u0000', ':')),
          nativeModels: [...nativeModels],
        });
      }
    }
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
    // The pace guard's knobs, shared by the tick, the live view (hook and
    // event-time path) and the /capacity report.
    const paceOpts = { ...config.pacing.guard, meanRunDurationHours: config.concurrency.meanRunDurationHours };
    // Fleet quality of the arm each account would run for this role (see
    // placementArm): the placement blend ranks accounts by it, so unspent
    // allowance breaks ties between similar arms instead of picking the
    // account with the most room regardless of what runs there.
    // Readiness can expire between candidate awaits: never memoize the
    // quality of an arm that is no longer admitted.
    const tickTaskPreview = (view, role, duplicates, opts) => {
      const mode = opts.taskMode ?? config.taskRanking.mode;
      if (mode !== 'enforce') return {};
      const ladder = ladders[view.accountId];
      const run = opts.run ?? {};
      const inputs = { runId: run.runId ?? 'preview', agentId: run.agentId ?? 'preview', role,
        excludedFamilies: exclusionsForMode(role, mode), pointer: view.pointer,
        retryCount: 0, failureClass: 'none', contextTokens: null,
        fiveHourHeadroomPct: view.headroomPct, burnPerRunPct: ladder?.taskBurnPerRunPct ?? {},
        reservePct: .05, accountId: view.accountId, roleBands, contextCaps: config.contextCaps,
        adapterType: run.adapterType ?? null, trialBudget: freshTrialBudget(),
        trialAdapters: config.trials.adapters, trialRoles: config.trials.roles, taskRanking: { mode },
      };
      const groups = filterBreakerRungs(routableGroupsFor(ladder, duplicates, nowMs,
        config.credentialReadiness.enforce, role, mode, taskRunAdmission(inputs, breakers, nowMs, breakersCfg)),
      breakers, view.accountId, nowMs, breakersCfg);
      const d = decide({ ...inputs, ladderRungs: groups });
      const pressure = freshPressure().byAccount;
      if ((!view.reactive && view.remainingPct == null)
        || (view.reactive && (pressure[view.accountId] ?? 0) >= trialInflightCapFor(config.trials, view.provider))) {
        return { taskFeasible: false, taskCostProxy: null, placementQ: null };
      }
      return { ...taskPlacement(d, groups), taskLadderRungs: groups, roleEligible: d.kind === 'decide' };
    };
    const placementQualityFor = (accountId, pointer, role, duplicates = true, taskMode = null) => {
      const groups = filterBreakerRungs(routableGroupsFor(
        ladders[accountId], duplicates, nowMs, config.credentialReadiness.enforce, role, taskMode,
      ), breakers, accountId, nowMs, breakersCfg);
      return placementArm(groups, {
        role, roleBands, excludedFamilies: exclusionsForMode(role, taskMode ?? config.taskRanking.mode),
        trialRoles: config.trials.roles, pointer,
      })?.quality ?? null;
    };
    // opts.forReview: review runs see the unheld order (the reserve holds
    // quota FOR them). opts.applyReserve false keeps the pace-guard pools
    // report complete (held pools are not candidates, but they are still
    // pools the report narrates).
    const allocationOrder = (role, selfRunId = null, duplicates = true, opts = {}) => {
      const { pools, byAccount } = freshPressure();
      const pacePools = paceInFlightByPool(companyId, ledger, { nowMs, horizonMs: staleHorizonMs, selfRunId, poolOf: poolOfKey }).pools;
      const applyReserve = opts.applyReserve !== false && reviewReserveView.enabled === true;
      const routesRun = (v, dups) => rungsHaveEligibleArms(filterBreakerRungs(
        routableGroupsFor(ladders[v.accountId], dups, nowMs, config.credentialReadiness.enforce, role, opts.taskMode), breakers, v.accountId, nowMs, breakersCfg));
      return orderAccountsWithPacing(
        accountViews.filter(v => freeProvider(v, config.freeLanes) == null && (routesRun(v, true)
          || (opts.forReview === true && config.taskRanking.mode === 'enforce' && (ladders[v.accountId]?.policyReviewerArms?.length ?? 0) > 0))).map(v => ({
          accountId: v.accountId,
          resetAtMs: v.resetAtMs,
          headroomPct: v.headroomPct,
          remainingPct: v.remainingPct,
          reactive: v.reactive === true,
          guardActive: v.guardActive === true,
          measuredRatePerHour: v.measuredRatePerHour,
          requiredRatePerHour: v.requiredRatePerHour,
          targetShare: v.targetShare ?? null,
          health: v.health,
          meter: v.meter,
          quality: v.quality,
          provider: v.provider,
          models: v.models,
          fallbackOnly: v.fallbackOnly,
          creditFallback: v.creditFallback,
          roleEligible: opts.taskMode == null ? roleAccess[v.accountId]?.[role]?.eligible === true
            : roleLadderAccess(credentialGroupsFor(ladders[v.accountId], nowMs, config.credentialReadiness.enforce, role, opts.taskMode),
              { role, roleBands, excludedFamilies: exclusionsForMode(role, opts.taskMode), trialRoles: config.trials.roles }).eligible,
          inFlight: pools[v.pool] ?? 0,
          paceInFlight: pacePools[v.pool] ?? 0,
          pool: v.pool,
          laneInFlight: byAccount[v.accountId] ?? 0,
          duplicates,
          held: !duplicates && !routesRun(v, false),
          placementQ: placementQualityFor(v.accountId, v.pointer, role, duplicates, opts.taskMode),
          freeCost: v.freeCost === true,
          ...tickTaskPreview(v, role, duplicates, opts),
          planAhead: v.planAhead,
          ...(v.burnMode === true ? { burn: true } : {}),
          ...(v.burnMode === true && v.burnFloor != null ? { burnFirst: true } : {}),
        })),
        {
          reservePct: 0.05, rateDeadbandRel: config.pacing.rateDeadbandRel, placement: config.placement, pacing: paceOpts,
          reviewReserve: applyReserve
            ? { heldAccountIds: reviewReserveView.heldAccountIds, forReview: opts.forReview === true }
            : null,
          creditPriority: config.credits.priority,
          taskRanking: { mode: opts.taskMode ?? config.taskRanking.mode },
        },
      );
    };
    // Fresh trial budgets per candidate: decisions write through to the
    // ledger, so re-reading bounds single-tick trial bursts structurally.
    const freshTrialBudget = () => {
      const inFlight = trialInflight(paidTrialLedger(ledger, config.freeLanes), { nowMs });
      const out = {};
      const fams = new Set(Object.keys(inFlight));
      for (const ladder of Object.values(ladders ?? {})) {
        // A dominated trial can become selectable when its incumbent expires.
        for (const r of [...(ladder?.credentialRanking?.candidates ?? ladder?.rungs ?? []), ...(ladder?.taskRoles?.doer?.candidates ?? [])]) if (r?.trial && r?.family) fams.add(r.family);
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
    let observed = 0;
    let shadowSkippedNoDecision = 0;
    let shadowSkippedPaced = 0;
    const keepAgents = new Set(config.roles.keepAgentIds);
    // Pinned agents' configured model and the account serving it, published
    // in the live view so the hook and event-time path can count a pinned
    // run against that account the moment it starts.
    const keptByAgent = {};
    for (const agentId of keepAgents) {
      const kept = await resolveActualModel(companyId, { model: null, modelSource: null, issueId: null, agentId }, modelCaches);
      // Feed model lists first; else the account whose ladder serves it.
      const canon = canonicalModelName(kept.model);
      const accountId = accountOfModel(kept.model)
        ?? (canon ? ordered.find(a => (ladders[a.accountId]?.credentialRanking?.candidates ?? ladders[a.accountId]?.rungs ?? []).some(r => canonicalModelName(r.model) === canon))?.accountId : null)
        ?? null;
      if (kept.model != null && accountId != null) keptByAgent[agentId] = { model: kept.model, accountId };
    }
    for (const run of candidates) {
      if (config.taskRanking.mode === 'enforce' && config.reviewerRouting?.agentIds.includes(run.agentId)) {
        const pressure = freshPressure();
        const reviewLive = { atMs: nowMs, taskRanking: config.taskRanking,
          reviewerRouting: config.reviewerRouting, burnModeTokens: config.burnModeTokens,
          thinkerAgentIds: config.roles.thinkerAgentIds, doerAgentIds: config.roles.doerAgentIds,
          reviewerPolicyExclusions: config.roles.excludeFamilies, excludeFamilies: roleExclusions,
          roleBands, contextCaps: config.contextCaps, decidedRunIds: new Set([...ledger.values()].filter(r => r.decidedAccount).map(r => r.runId)),
          accounts: accountViews.map(v => ({ ...v, laneProvider: v.provider, provider: v.pool ?? v.provider,
            burn: v.burnMode === true, inFlight: pressure.byAccount[v.accountId] ?? 0,
            credentialRanking: ladders[v.accountId]?.credentialRanking,
            policyReviewerArms: ladders[v.accountId]?.policyReviewerArms,
            taskRankingMode: config.taskRanking.mode,
          })),
        };
        const paced = allocationOrder(roleOf(config, run.agentId), run.runId, true, { forReview: true, run }).paced;
        const held = new Set(paced.flatMap(p => p.pacedAccountIds ?? []));
        const d = recordReviewerShadow(ledger, reviewLive, companyId, run,
          pickReviewerRoute(reviewLive, companyId, run.agentId, run.runId, nowMs, held), false);
        if (d) observed++; else shadowSkippedNoDecision++;
        continue;
      }
      if (keepAgents.has(run.agentId)) {
        // Pinned agent: the hook keeps its configured model, so shadow
        // reports that model on the account that serves it (the run still
        // burns that account) instead of a routed pick.
        const kept = await resolveActualModel(companyId, {
          model: run.eventModel ?? (run.actualModel !== 'unknown' ? run.actualModel : null),
          modelSource: run.eventModelSource ?? run.actualModelSource ?? null,
          issueId: run.issueId ?? null, agentId: run.agentId ?? null,
        }, modelCaches);
        const keptAccount = accountOfModel(kept.model);
        if (kept.model != null && keptAccount != null) {
          recordDecision(ledger, {
            runId: run.runId, agentId: run.agentId, accountId: keptAccount,
            armId: null, enforced: false, wouldModel: kept.model,
            family: inferFamily(canonicalModelName(kept.model)),
            reason: 'kept: agent pinned to its configured model (roles.keepAgentIds)', eventTime: false,
          }, nowMs);
          const rec = ledger.get(run.runId);
          if (rec) {
            rec.actualModel = kept.model;
            rec.actualModelSource = kept.source;
            rec.actualModelError = kept.error;
            rec.actualPending = false;
            rec.modelMatch = true;
          }
          observed += 1;
        } else {
          shadowSkippedNoDecision += 1;
        }
        continue;
      }
      // Resolve attribution before admission: this await may outlive a
      // credential observation. Selection through ledger recording is sync.
      const actual = await resolveActualModel(companyId, {
        model: run.eventModel ?? (run.actualModel !== 'unknown' ? run.actualModel : null),
        modelSource: run.eventModelSource ?? run.actualModelSource ?? null,
        issueId: run.issueId ?? null, agentId: run.agentId ?? null,
      }, modelCaches);
      const role = roleOf(config, run.agentId);
      let decision = null;
      // Fresh order, cap base, and trial budget per run: decisions write
      // straight into the ledger, so earlier decisions in this tick already
      // narrow the winner's shortfall and consume budget structurally --
      // the next run spreads elsewhere without any pending-side state.
      const allocation = withDuplicatePass(duplicates => allocationOrder(
        role, run.runId, duplicates, { forReview: isReviewAgent(run.agentId), run },
      ));
      for (const sel of allocation.order) {
        const view = viewById.get(sel.accountId);
        const ladder = ladders[sel.accountId];
        if (!view || !ladder) continue;
        // Reactive accounts qualify without a remaining fraction; metered
        // accounts need one. Reactive lanes are capped in flight per account
        // (default 2, operator-overridable per provider via
        // trials.maxInFlightPerAccountByProvider): no vendor meter means no
        // burn signal, so the count of running runs is the only backpressure.
        if (!view.reactive && view.remainingPct == null) continue;
        const pressure = freshPressure().byAccount;
        if (view.reactive && (pressure[sel.accountId] ?? 0) >= trialInflightCapFor(config.trials, view.provider ?? sel.provider)) continue;
        // Role-based family exclusions: accounts with no eligible arm for
        // this role are skipped, never deferred on (decide would only find
        // empty rungs there).
        const roleRungs = filterRungsByExcludedFamilies(
          sel.taskLadderRungs ?? routableGroupsFor(ladder, sel.duplicates, nowMs, config.credentialReadiness.enforce, role), roleExclusions[role]);
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
          excludedFamilies: roleExclusions[role],
          pointer: view.pointer,
          retryCount: 0,
          failureClass: 'none',
          contextTokens: null,
          fiveHourHeadroomPct: sel.headroomPct,
          burnPerRunPct: routingBurn(ladder),
          reservePct: 0.05,
          accountId: sel.accountId,
          roleBands,
          contextCaps: config.contextCaps,
          adapterType: run.adapterType ?? null,
          trialBudget: freshTrialBudget(),
          trialAdapters: config.trials.adapters,
          trialRoles: config.trials.roles,
          taskRanking: config.taskRanking,
        });
        if (d.kind === 'decide') {
          decision = d;
          break;
        }
      }
      if (decision) {
        // 1M claude runs render decorated so the CLI takes the 1M window;
        // the terminal modelDecision echoes the same string, keeping
        // modelMatch canonical.
        const wouldModel = decoratedModelFor(decision, run.adapterType ?? null)
          ?? `${decision.model}(${decision.effort ?? 'default'})`;
        const actualModel = actual.model ?? run.actualModel ?? 'unknown';
        recordDecision(ledger, {
          runId: run.runId, agentId: run.agentId, accountId: decision.accountId,
          armId: decision.armId ?? null,
          effort: decision.effort ?? null,
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
          // still unknown; true/false once known. Canonical: a prefixed
          // emission matches a bare actual of the same id.
          rec.modelMatch = actual.model == null ? null
            : canonicalModelName(actual.model) === canonicalModelName(wouldModel);
        }
        observed += 1;
      } else {
        shadowSkippedNoDecision += 1;
        if (allocation.paced.length > 0) shadowSkippedPaced += 1;
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
    // Same '__proto__' discipline as agentRunning below: agentIds key this
    // map, so accumulate in a Map and snapshot with fromEntries (own data
    // properties; a direct assignment would hit the prototype setter).
    if (config.freeLanes.enabled) {
      await Promise.all(config.freeLanes.lowRiskAgentIds.map(id => agentAdapterType(companyId, id)));
    }
    const adapterByAgentEntries = new Map();
    for (const [k, v] of agentAdapterCache) {
      const sep = k.indexOf(':');
      if (sep < 0 || k.slice(0, sep) !== companyId) continue;
      if (!v?.adapterType || nowMs - v.atMs > ADAPTER_TTL_MS) continue;
      adapterByAgentEntries.set(k.slice(sep + 1), { adapterType: v.adapterType, atMs: v.atMs });
    }
    const adapterByAgent = Object.fromEntries(adapterByAgentEntries);
    const liveCensus = inflightByAccount(ledger, { nowMs, horizonMs: staleHorizonMs });
    const livePools = {};
    for (const [id, n] of Object.entries(liveCensus.byAccount)) {
      const p = poolOfKey(id);
      livePools[p] = (livePools[p] ?? 0) + n;
    }
    const liveTrialInFlight = trialInflight(paidTrialLedger(ledger, config.freeLanes), { nowMs });
    const liveTrialBudget = {};
    {
      const fams = new Set(Object.keys(liveTrialInFlight));
      for (const ladder of Object.values(ladders ?? {})) {
        // A dominated trial can become selectable when its incumbent expires.
        for (const r of [...(ladder?.credentialRanking?.candidates ?? ladder?.rungs ?? []), ...(ladder?.taskRoles?.doer?.candidates ?? [])]) if (r?.trial && r?.family) fams.add(r.family);
      }
      for (const fam of fams) {
        liveTrialBudget[fam] = Math.max(0, config.trials.maxInFlightPerFamily - (liveTrialInFlight[fam] ?? 0));
      }
    }
    if (superseded()) return { status: 'superseded' };
    liveViews.set(companyId, {
      ...(config.router ? {routerPolicy:{atMs:nowMs,arms:fleetArmScores,
        records:terminalRecords(ledger).map(r=>({runId:r.runId,agentId:r.agentId,status:r.status,terminalAt:r.terminalAt,progress:r.progress,family:outcomeFamilyOf(r)})),
        roleOf:id=>roleOf(lastConfig.get(companyId) ?? config,id),familyOf:r=>r.family,
      }} : {}),
      policyGeneration: configRevisions.get(companyId)?.policyGeneration,
      atMs: nowMs,
      enforce: config.enforce === true,
      ...(config.freeLanes.enabled ? { freeLanes: config.freeLanes,
        freeLanesMaxTotal: config.concurrency.maxTotal,
        freeManualExclusions: config.taskRanking.mode === 'enforce' ? taskManual : config.roles.excludeFamilies } : {}),
      credentialReadinessEnforced: config.credentialReadiness.enforce,
      // RunIds whose decisions the frozen counts above already reflect.
      // Hook/event-time pressure is the ledger decisions NOT in this set --
      // structural, so a frozen clock can never double-count the tick's own
      // decisions the way a timestamp comparison does.
      decidedRunIds: new Set([...ledger.values()].filter(r => r?.decidedAccount != null).map(r => r.runId)),
      inFlightByPool: livePools,
      adapterByAgent,
      thinkerAgentIds: config.roles.thinkerAgentIds,
      doerAgentIds: config.roles.doerAgentIds,
      keepAgentIds: config.roles.keepAgentIds,
      keptByAgent,
      // Reviewer routing (null = off: listed agents keep, as before) and the
      // burn-mode tokens it prefers.
      reviewerRouting: config.reviewerRouting ?? null,
      burnModeTokens: config.burnModeTokens ?? [],
      // Effective exclusion tokens per role (operator list + quality and
      // outcome gates): the hook and the event-time path read these.
      excludeFamilies: roleExclusions,
      roleBands: {
        thinker: { floorRung: config.roles.thinkerFloorRung, ceilingRung: config.roles.thinkerCeilingRung },
        doer: { floorRung: config.roles.doerFloorRung, ceilingRung: config.roles.doerCeilingRung },
      },
      contextCaps: config.contextCaps,
      trialBudget: liveTrialBudget,
      trialAdapters: config.trials.adapters,
      trialRoles: config.trials.roles,
      maxTrialInFlightPerAccount: config.trials.maxInFlightPerAccount,
      // Provider-scoped overrides (lower-cased provider keys); the hook and
      // event-time paths resolve per viewed account, falling back to the
      // scalar above. Empty (default) keeps every provider on the scalar.
      maxTrialInFlightPerAccountByProvider: config.trials.maxInFlightPerAccountByProvider ?? {},
      accounts: ordered.map(a => {
        const view = viewById.get(a.accountId);
        const ladder = ladders[a.accountId];
        return {
          accountId: a.accountId,
          provider: view?.pool ?? poolOfKey(a.accountId),
          pool: view?.pool ?? poolOfKey(a.accountId),
          laneProvider: view?.provider ?? null,
          models: view?.models ?? [],
          fallbackOnly: view?.fallbackOnly === true,
          pointer: view?.guardActive ? 0 : (view?.pointer ?? 0),
          headroomPct: view?.headroomPct ?? null,
          headroomSource: view?.headroomSource ?? null,
          creditFallback: view?.creditFallback === true,
          remainingKnown: view?.remainingPct != null,
          remainingPct: view?.remainingPct ?? null,
          targetShare: view?.targetShare ?? null,
          reactive: view?.reactive === true,
          // Free-overflow tier for the deferral-exhaustion path (additive:
          // nothing else reads it).
          freeCost: view?.freeCost === true,
          guardActive: view?.guardActive === true,
          health: view?.health ?? 'unknown',
          meter: view?.meter ?? null,
          quality: view?.quality ?? 'unknown',
          inFlight: liveCensus.byAccount[a.accountId] ?? 0,
          resetAtMs: view?.resetAtMs ?? null,
          hoursToReset: view?.hoursToReset ?? null,
          action: view?.action ?? null,
          measuredRatePerHour: view?.measuredRatePerHour ?? null,
          requiredRatePerHour: view?.requiredRatePerHour ?? null,
          planAhead: view?.planAhead ?? null,
          burn: view?.burnMode === true,
          ...(view?.burnMode === true && view?.burnFloor != null ? { burnFirst: true } : {}),
          // Breaker-filtered like the tick loop, so the hook and the
          // event-time path never pick an arm the tick would skip.
          ladderRungs: filterBreakerRungs(credentialGroupsFor(ladder, nowMs, config.credentialReadiness.enforce), breakers, a.accountId, nowMs, breakersCfg),
          credentialRanking: ladder?.credentialRanking,
          taskRoles: ladder?.taskRoles,
          policyReviewerArms: ladder?.policyReviewerArms,
          taskRankingMode: config.taskRanking.mode,
          taskTrialRoles: config.trials.roles,
          taskBurnPerRunPct: ladder?.taskBurnPerRunPct,
          burnPerRunPct: routingBurn(ladder),
        };
      }),
      rateDeadbandRel: config.pacing.rateDeadbandRel,
      placement: config.placement,
      taskRanking: config.taskRanking,
      reviewerPolicyExclusions: config.roles.excludeFamilies,
      paceGuard: paceOpts,
      creditPriority: config.credits.priority,
      // Tick's review-reserve verdict: held accounts plus the agent ids
      // that run past the hold. The hook and event-time path read this.
      reviewReserve: reviewReserveView,
      staleHorizonMs,
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
    await ctx.state.set(scopeKey(companyId, SMOOTH_KEY), {
      atMs: nowMs, E: Object.fromEntries(nextSmoothE), target: nextSmoothTarget,
      fastUntilMs: targetStep.fastUntilMs,
      accountUsage: Object.fromEntries(accountUsage), accountE: Object.fromEntries(nextAccountE),
      armE: nextArmE, armEpoch: nextArmEpoch, armEpochAt: nextArmEpochAt,
    });
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
    if (config.freeLanes.enabled) {
      await ctx.state.set(scopeKey(companyId, 'free-lanes-v1'), freeLaneUsage.get(companyId) ?? {});
    }
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
    // Map accumulator: agentIds are ledger/issue strings, and indexing a
    // plain object with '__proto__' would write Object.prototype worker-wide
    // (and read it back as NaN counts). fromEntries below defines own data
    // properties even for '__proto__', so the snapshot reads back safely.
    const agentRunningById = new Map();
    for (const r of ledger.values()) {
      if (r?.status !== 'running' || r?.unverified === true) continue;
      if (typeof r.agentId !== 'string' || r.agentId.length === 0 || r.agentId === 'unknown') continue;
      let entry = agentRunningById.get(r.agentId);
      if (!entry) { entry = { running: 0, overPace: false }; agentRunningById.set(r.agentId, entry); }
      const free = freeProvider(viewById.get(r.enforced ? r.decidedAccount : r.actualAccount), config.freeLanes) != null;
      if (free) entry.freeRunning = (entry.freeRunning ?? 0) + 1;
      else entry.running += 1;
      const burnAccount = r.actualAccount ?? r.decidedAccount ?? null;
      if (burnAccount != null && overPaceAccounts.has(burnAccount)) entry.overPace = true;
    }
    const agentRunning = Object.fromEntries(agentRunningById);
    // With routing enabled, capacity must pass the same admission as a
    // configured reviewer. Otherwise retain the legacy non-trial role access.
    const reviewerLive = liveViews.get(companyId);
    const reviewerAccounts = new Map((reviewerLive?.accounts ?? []).map(a => [a.accountId, a]));
    const reviewerAdmissions = (config.reviewerRouting?.agentIds ?? [])
      .map(agentId => reviewerArmAdmission(reviewerLive, companyId, agentId, nowMs));
    // Use the real routing admission, not the configured default model's pool.
    // An empty list is meaningful: no helper may grant new review slots.
    const reviewerAccountIdsByAgent = Object.fromEntries((config.reviewerRouting?.agentIds ?? []).map(agentId => {
      const { admissionOf } = pickReviewerRoute(reviewerLive, companyId, agentId, null, nowMs);
      return [agentId, (reviewerLive.accounts ?? []).filter(a => config.reviewerRouting.arms.some(arm =>
        admissionOf.has(`${a.accountId}|${arm.provider}|${arm.model}|${arm.effort ?? ''}`))).map(a => a.accountId)];
    }));
    const reviewerView = computeReviewerCapacity({
      accounts: accountViews.map((v) => {
        const access = roleAccess?.[v.accountId];
        const thinker = access?.thinker;
        const doer = access?.doer;
        const pool = String(v.pool ?? v.provider ?? '').toLowerCase();
        const account = reviewerAccounts.get(v.accountId);
        const servesRoutingArm = account != null && (config.reviewerRouting?.arms ?? []).some((arm) => arm.provider === pool
          && reviewerAdmissions.some(admit => admit(account, arm).ok === true));
        const eligible = reviewerAdmissions.length > 0
          ? servesRoutingArm
          : (thinker?.eligible === true && thinker?.trialOnly !== true)
            || (doer?.eligible === true && doer?.trialOnly !== true);
        return {
          accountId: v.accountId,
          provider: v.provider,
          health: v.health,
          headroomPct: v.headroomPct,
          remainingPct: v.remainingPct,
          hoursToReset: v.hoursToReset,
          reactive: v.reactive === true,
          reviewerEligible: eligible,
          // Allocator parity: the reviewer must not resume on accounts the
          // allocator refuses (weekly-exhausted 'excluded', floor-guard).
          action: v.action ?? null,
          guardActive: v.guardActive === true,
        };
      }),
      cfg: config.reviewer,
      nowMs,
    });
    // Reviewer routing decision: what a review run would get right now
    // (preview over the live view this tick published) plus the hook's last
    // outcome. Absent config reports enabled:false and nothing else changes.
    {
      const rcfg = config.reviewerRouting ?? null;
      const liveNow = liveViews.get(companyId);
      let preview = null;
      if (rcfg && liveNow && rcfg.agentIds.length > 0) {
        const reviewRole = roleOf(config, rcfg.agentIds[0]);
        const paced = allocationOrderFromLive(liveNow, companyId, null, reviewRole,
          normalizeExcludedFamilies(liveNow.excludeFamilies?.[reviewRole] ?? []), true, true).paced;
        const pacedIds = config.taskRanking.mode === 'enforce' ? new Set(paced.flatMap(p => p.pacedAccountIds ?? [])) : null;
        const { pick, admissionOf } = pickReviewerRoute(liveNow, companyId, rcfg.agentIds[0], null, nowMs, pacedIds);
        preview = pick.none
          ? { routed: false, fallback: config.taskRanking.mode === 'enforce' ? 'defer' : config.roles.keepAgentIds.includes(rcfg.agentIds[0]) ? 'keep' : 'route', reason: pick.reason }
          : {
            routed: true, provider: pick.provider, arm: pick.arm, accountId: pick.accountId, burn: pick.burn, poolPlanAhead: pick.poolPlanAhead, reason: pick.reason,
            env: reviewerPickEmission(liveNow, pick, admissionOf).env,
            ...(config.taskRanking.mode === 'enforce' ? { primary: pick.primary, fallbackReason: pick.fallbackReason, evidenceTrust: pick.evidenceTrust } : {}),
          };
      }
      reviewerView.routing = rcfg
        ? {
          enabled: true,
          agentIds: rcfg.agentIds,
          arms: rcfg.arms,
          burnModeTokens: config.burnModeTokens ?? [],
          provider: preview?.provider ?? null,
          arm: preview?.arm ?? null,
          accountId: preview?.accountId ?? null,
          reason: preview?.reason ?? null,
          preview,
          last: reviewerRouteLast.get(companyId) ?? null,
        }
        : { enabled: false, reason: 'reviewerRouting not configured: review agents keep their configured model' };
    }
    // Demand-aware supply signal: large unused headroom near reset while doers
    // idle means supply should scale up instead of idling. Per-provider live
    // runs keep one provider's reviewer traffic from masking another
    // provider's doer starvation (host 2026-10-14: Meta sat on large headroom
    // with almost no runs while fleet runs/h looked healthy).
    const doerIdle = (demand?.byRole?.doer ?? 0) <= 0 && (roleRunning?.doer ?? 0) <= 0;
    const supplyBase = computeSupplySignal({
      accounts: accountViews.map((v) => ({
        provider: v.provider,
        health: v.health,
        action: v.action ?? null,
        guardActive: v.guardActive === true,
        remainingPct: v.remainingPct,
        hoursToReset: v.hoursToReset,
        inFlight: liveCensus.byAccount[v.accountId] ?? 0,
      })),
      doerIdle,
      cfg: config.reviewer,
    });
    // Doer-starvation wake: the served target C* exceeds live doer runs by a
    // margin sustained across ticks, so idle in_progress/todo cards on
    // healthy-provider agents get woken. The since-timestamp persists in the
    // capacity-change state key below so a slow poller sees the sustained
    // wake, not a one-tick pulse.
    const doerStarvation = computeDoerStarvation({
      target: concurrency.target,
      liveDoerRuns: roleRunning.doer,
      doerDemand: demand?.byRole?.doer ?? 0,
      sinceMs: prevChange?.doerStarvationSinceMs ?? null,
      cfg: config.reviewer,
      nowMs,
    });
    const supplySignal = {
      ...supplyBase,
      doerStarvation,
      wake: supplyBase.wake || doerStarvation.wake,
    };
    // Capacity-change event : upward transitions wake held/idle
    // work via the capacity view + persisted state key; downward debounces.
    // wake pulses on the transition tick only, but seq and lastWakeAtMs
    // survive idle ticks (and restarts): a consumer polling slower than the
    // 60s tick compares them against what it last handled instead of racing
    // the pulse. lastChange keeps the last non-empty diff for the same
    // reason -- it is the last change, not the current tick's diff.
    const prevLastChange = (prevChange != null && typeof prevChange.lastChange === 'object' && prevChange.lastChange !== null)
      ? prevChange.lastChange
      : null;
    const prevSeq = Number.isFinite(prevLastChange?.seq) ? prevLastChange.seq : 0;
    const prevWakeAtMs = Number.isFinite(prevChange?.lastWakeAtMs)
      ? prevChange.lastWakeAtMs
      : (prevLastChange?.wake === true && Number.isFinite(prevLastChange?.atMs) ? prevLastChange.atMs : null);
    const tickChange = {
      version: 1,
      atMs: nowMs,
      added: capacityDiff.added,
      removed: capacityDiff.removed,
      upwardAccountIds: [...capacityDiff.upwardIds].sort(),
      downwardAccountIds: [...capacityDiff.downwardIds].sort(),
      wake: capacityDiff.upwardIds.size > 0,
    };
    const lastChange = capacityDiff.changed
      ? { ...tickChange, seq: prevSeq + 1, eventAtMs: nowMs }
      : (prevLastChange ?? { ...tickChange, seq: 0, eventAtMs: null });
    const lastWakeAtMs = tickChange.wake ? nowMs : prevWakeAtMs;
    const capacityChange = {
      ...tickChange,
      seq: lastChange.seq,
      lastWakeAtMs,
    };
    // A fully breaker-open account has no servable arms; it contributes no
    // kept-agent pool slots until an arm recovers or its breaker cools off.
    // Only current ladder arms count: known retains removed arms for 24h.
    const breakerUnavailableAccountIds = [];
    const breakerStore = breakerStores.get(companyId) ?? createBreakerStore();
    if (config.breakers?.enabled !== false) {
      for (const account of accountViews) {
        const arms = (account.arms ?? []).map(arm => arm.armId);
        if (arms.length > 0 && arms.every(armId => breakerState(breakerStore, account.accountId, armId, nowMs, config.breakers) === 'open')) {
          breakerUnavailableAccountIds.push(account.accountId);
        }
      }
    }
    // Pace guard verdict per pool with the tick's final in-flight counts
    // (the role only affects placement quality, never the guard).
    const paceReport = allocationOrder('doer', null, true, { applyReserve: false }).pools;
    if (config.taskRanking.mode !== 'off') {
      const policyBucket = view => ({ funding: view?.creditFallback ? 'credit-fallback' : 'plan',
        burn: view?.burnMode === true, burnFirst: view?.burnMode === true && view?.burnFloor != null,
        fallbackOnly: view?.fallbackOnly === true,
        need: view?.fallbackOnly === true ? 'fallback-only' : view?.reactive === true ? 'reactive'
          : isOverBurning(view, config.pacing.rateDeadbandRel) || deficitOf(view) < 0 ? 'metered-ahead-or-over-burning' : 'metered-behind-or-unknown',
        freeCash: view?.freeCost === true });
      const describe = (c, role) => {
        const view = viewById.get(c.accountId), reasons = new Set((c.exclusionReasons ?? []).filter(r => r !== 'pareto-dominated'));
        if (view?.health !== 'healthy') reasons.add(`health:${view?.health ?? 'unknown'}`);
        if (!view?.reactive && !(view?.headroomPct > .05)) reasons.add('insufficient-or-unknown-headroom');
        if (roleExclusions[role]?.includes(c.family) || roleExclusions[role]?.includes(armToken(c.armId))) reasons.add('role-excluded');
        if (c.armId && breakerState(breakers, c.accountId, c.armId, nowMs, breakersCfg) !== 'closed') reasons.add('breaker-not-closed');
        if (c.credentialEvidence && config.credentialReadiness.enforce
          && !credentialReadiness(c.credentialEvidence, nowMs).eligible) reasons.add('credential-not-ready');
        return { ...c, benchmarkDisposition: c.selectionReason ?? null, policyBucket: policyBucket(view), exclusionReasons: [...reasons],
          snapshotAgeMs: aaSnapshot?.fetchedAt ? Math.max(0, nowMs - Date.parse(aaSnapshot.fetchedAt)) : null };
      };
      taskRanking.candidates = taskRanking.candidates.map(c => describe(c, c.role));
      const previewRoute = (mode, role, adapterType) => {
        const run = { runId: 'capacity-preview', agentId: 'capacity-preview', adapterType };
        const allocation = withDuplicatePass(duplicates => allocationOrder(role, null, duplicates,
          { taskMode: mode, run, applyReserve: true }));
        for (const sel of allocation.order) {
          const v = viewById.get(sel.accountId), l = ladders[sel.accountId];
          if (!v?.reactive && v?.remainingPct == null) continue;
          if (v?.reactive && (freshPressure().byAccount[sel.accountId] ?? 0) >= trialInflightCapFor(config.trials, v.provider)) continue;
          const groups = sel.taskLadderRungs ?? filterBreakerRungs(routableGroupsFor(l, sel.duplicates, nowMs,
            config.credentialReadiness.enforce, role, mode), breakers, sel.accountId, nowMs, breakersCfg);
          const d = decide({ runId: run.runId, agentId: run.agentId, role, ladderRungs: groups,
            excludedFamilies: exclusionsForMode(role, mode), pointer: v.pointer, retryCount: 0, failureClass: 'none', contextTokens: null,
            fiveHourHeadroomPct: v.headroomPct, burnPerRunPct: mode === 'enforce' ? l.taskBurnPerRunPct : l.burnPerRunPct,
            reservePct: .05, accountId: sel.accountId, roleBands, contextCaps: config.contextCaps, adapterType,
            trialBudget: freshTrialBudget(), trialAdapters: config.trials.adapters, trialRoles: config.trials.roles,
            taskRanking: { mode } });
          if (d.kind === 'decide') return { accountId: sel.accountId, model: d.model, effort: d.effort,
            armId: d.armId, policyBucket: policyBucket(v), reason: d.reason };
        }
        return null;
      };
      const rejectedReason = (candidate, role, adapterType, proposed) => {
        if (candidate.exclusionReasons.length) return candidate.exclusionReasons.join('; ');
        if (candidate.trial) {
          if (!roleTakesTrial(config.trials.roles, role, candidate.family)) return `trial family ${candidate.family} not permitted for role ${role}`;
          if (!adapterAllowsTrial(config.trials.adapters, adapterType, candidate.family)) return `trial family ${candidate.family}: adapter ${adapterType ?? 'unknown'} not allowed`;
          if (!(freshTrialBudget()[candidate.family] > 0)) return `trial family ${candidate.family} in-flight budget exhausted`;
        }
        const view = viewById.get(candidate.accountId);
        if (view?.reactive && (freshPressure().byAccount[candidate.accountId] ?? 0) >= trialInflightCapFor(config.trials, view.provider)) return 'reactive account in-flight cap reached';
        if (reviewReserveView.heldAccountIds?.includes(candidate.accountId)) return 'review-reserve held';
        if (JSON.stringify(candidate.policyBucket) !== JSON.stringify(proposed?.policyBucket)) return 'different-operational-policy-bucket';
        return 'role rung window or native pace guard excludes the cheaper candidate';
      };
      taskRanking.routeComparisons = [];
      for (const role of ROLES) for (const adapterType of [null, ...Object.keys(config.trials.adapters)]) {
        const legacy = previewRoute('off', role, adapterType), proposed = previewRoute('enforce', role, adapterType);
        const winner = proposed && taskRanking.candidates.find(c => c.accountId === proposed.accountId && c.armId === proposed.armId && c.role === role);
        const alternative = taskRanking.candidates.filter(c => c.role === role && Number.isFinite(c.taskCostProxy)
          && (!winner || c.taskCostProxy < winner.taskCostProxy))
          .sort(compareTaskCosts)[0] ?? null;
        taskRanking.routeComparisons.push({ previewInputs: { role, adapterType, contextTokens: null, retryCount: 0 },
          legacy, proposed, current: config.taskRanking.mode === 'enforce' ? proposed : legacy,
          changed: legacy?.model !== proposed?.model || legacy?.effort !== proposed?.effort || legacy?.accountId !== proposed?.accountId,
          cheapestRejectedAlternative: alternative ? { model: alternative.model, effort: alternative.effort,
            accountId: alternative.accountId, taskCostProxy: alternative.taskCostProxy,
            reason: rejectedReason(alternative, role, adapterType, proposed) } : null,
        });
      }
      // Do not expose credential observations or duplicate raw source rows in
      // /capacity. Identity/metric provenance and all score components remain.
      taskRanking.candidates = taskRanking.candidates.map(({ credentialEvidence, row, ...c }) => c);
      delete taskRanking.accounts;
    }
    if (superseded()) return { status: 'superseded' };
    if (admissionGeneration !== configGenerationOf(companyId)) return { status: 'configuration-changed' };
    const freeCapacity = config.freeLanes.enabled ? freeCapacityReport(liveViews.get(companyId), companyId, nowMs) : null;
    const publishedTarget = freeCapacity?.target > 0
      ? Math.min(config.concurrency.maxTotal, (concurrency.target ?? 0) + freeCapacity.target) : concurrency.target;
    await ctx.state.set(scopeKey(companyId, CAPACITY_KEY), {
      reviewAdmissionGeneration: admissionGeneration,
      ...(reviewAgentIdsFor(config).size > 0 ? { reviewAdmissionEpoch } : {}),
      atMs: nowMs,
      taskRanking,
      ...(freeCapacity ? { freeLanes: freeCapacity, paidTarget: concurrency.target,
        paidCalibration: concurrency.calibration, totalTarget: publishedTarget } : {}),
      // Existing fleet-target consumers see additive throughput. The paid
      // allocator below still uses paidTarget, never this combined budget.
      target: publishedTarget,
      demandFactor: concurrency.demandFactor ?? 1,
      // Unsmoothed usable target, and the quota-only sum with no role
      // filtering (what the target used to read), so the gap stays visible.
      targetRaw: concurrency.targetRaw ?? concurrency.target,
      // Most runs the queued work could fill at once (null when idle).
      demandBound: concurrency.demandBound ?? null,
      targetUnweighted: concurrency.slotsTotal ?? null,
      maxTotal: config.concurrency.maxTotal,
      calibration: freeCapacity?.target > 0 && concurrency.calibration === 'weak' ? 'partial' : concurrency.calibration,
      // Did finished runs do their job (issue moved to a disposition), per
      // resolved model family, last 24h.
      familyOutcomes: familyOutcomes(terminalRecords(ledger), {
        nowMs,
        familyOf: outcomeFamilyOf,
      }),
      // Per-role usable capacity and the queued demand that bounds it.
      roles: concurrency.roles ?? null,
      demandSource: demand.source,
      medianMeasuredBurnPct: concurrency.medianMeasuredBurnPct ?? null,
      // Calibration groups: pooled providers measured as one (members > 1).
      calibrationGroups,
      smoothing: { ...config.smoothing, fastUntilMs: targetStep.fastUntilMs },
      perAccount: concurrency.perAccount,
      breakerUnavailableAccountIds,
      accounts: accountViews,
      skippedArms: skipped,
      unscored,
      unservable,
      // Read-only model inventory: raw/canonical/emitted ids per account with
      // served present/absent/unknown. Reporting only; routing ignores it.
      modelInventory,
      credentialAvailability: credentialAvailabilityReport,
      contextTiers: { baselineMultiplier: tierBaseline, caps: tierCaps },
      trialFamilies,
      trialTransitions,
      // Arm circuit breakers: open/half-open arms plus closed arms with
      // recent arm-fatal fails. Bounded (500 arms) by construction.
      armBreakers: breakerReport(breakers, nowMs, breakersCfg),
      // Per-role operator exclusions (the emergency override, resolved
      // config values) and the effective tokens the picks actually honor.
      roleExclusions: {
        doer: config.roles.excludeFamilies.doer,
        thinker: config.roles.excludeFamilies.thinker,
        other: config.roles.excludeFamilies.other,
      },
      roleExclusionsEffective: roleExclusions,
      // Eligibility from data, auditable: every arm's fleet Q and its
      // verdict per role (with reasons), the outcome gate's per-family
      // evidence, warnings (manual list non-empty, a role's gates suspended).
      eligibility: eligibility.report,
      // Per-agent running + over-pace burn flags for the demand-aware /caps
      // allocator below. Bounded by the live agent count.
      agentRunning,
      keepAgentIds: config.roles.keepAgentIds,
      keptByAgent,
      reviewerAccountIdsByAgent,
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
      paceGuard: {
        enabled: paceOpts.enabled,
        marginPct: paceOpts.marginPct,
        retryAfterMs: paceOpts.retryAfterMs,
        pools: paceReport,
        // Burn-mode accounts (see burnmode.mjs): never capped or held.
        burnAccounts: [...burnAccountIds],
        // Fresh starts with no decided or actual account yet are
        // deliberately outside every pool's cap (see paceInFlightByPool):
        // the count is published here so the fail-open stays visible.
        unattributedInFlight: paceInFlightByPool(companyId, ledger, { nowMs, horizonMs: staleHorizonMs, poolOf: poolOfKey }).unattributed,
      },
      // Review reserve: R, need, capacity, lent and inputs per reserved
      // provider, plus the accounts held for non-review runs.
      reviewReserve: reviewReserveView,
      // Reviewer as a first-class role : runnable capacity from
      // qualified providers plus the hold/resume signal the review gate
      // reads (supersedes the host reviewer_failover/review-hold scripts).
      reviewer: reviewerView,
      // Capacity-change event: upward transitions (new account, reset, guard
      // end, recovery) set wake:true so host + Paperclip wake held/idle work.
      capacityChange,
      // Demand-aware supply signal: large unused headroom near reset while
      // doers idle. Wake supply (work generator / PR-finishing cards).
      supplySignal,
      unmappedRuns,
      runEventsSeen: mergedEvt.seen,
      lastRunEventAtMs: mergedEvt.lastAtMs,
      shadow: {
        decided: observed,
        mergedEventTime,
        backfilledActuals,
        skippedNoDecision: shadowSkippedNoDecision,
        skippedPaced: shadowSkippedPaced,
      },
    });
    await ctx.state.set(scopeKey(companyId, LADDER_KEY), { atMs: nowMs, ladders });
    await ctx.state.set(scopeKey(companyId, CAPACITY_CHANGE_KEY), {
      atMs: nowMs,
      accounts: accountViews.map((v) => ({
        accountId: v.accountId,
        weeklyUsed: v.weeklyUsedPct ?? null,
        resetAtMs: v.resetAtMs ?? null,
        guardActive: v.guardActive === true,
        health: v.health ?? null,
        burnHorizonMs: v.burnHorizonMs ?? null,
      })),
      lastChange,
      lastWakeAtMs,
      // Durable doer-starvation start so the sustain window survives slow
      // pollers and restarts (a gap that closes resets to null).
      doerStarvationSinceMs: doerStarvation.sinceMs,
    });
    ctx.logger.info('model-capacity: shadow tick', {
      companyId, accounts: accountViews.length, target: concurrency.target,
      calibration: concurrency.calibration, observed, runs: ledger.size, runsSource: 'events',
    });
    return { status: 'shadow', observed };
  }

  function managedFreeAccount(live, companyId, account) {
    // Keep the old managed accounts out of ordinary routing until a disabling
    // tick lands too; otherwise turning off would open a bypass immediately.
    return freeProvider(account, freeLaneConfigs.get(companyId)) != null
      || freeProvider(account, live?.freeLanes) != null;
  }

  function safeFreeAgentIds(live, companyId) {
    if (live == null) return [];
    const cfg = freeLaneConfigs.get(companyId);
    return (cfg?.lowRiskAgentIds ?? []).filter(agentId => lowRiskRun({
      agentId, runId: 'eligibility', issueId: 'eligibility', previous: null,
    }, cfg, { role: roleOf({ roles: live ?? {} }, agentId),
      kept: live?.keepAgentIds?.includes(agentId) === true,
      reviewer: liveIsReviewAgent(live, agentId) || live?.reviewerRouting?.agentIds?.includes(agentId) === true }));
  }

  function freeRunGroups(live, companyId, account, role, nowMs, report = null) {
    const cfg = live.freeLanes;
    const provider = freeProvider(account, cfg);
    const ledger = ledgers.get(companyId) ?? new Map();
    const candidates = live.taskRanking?.mode === 'enforce'
      ? account.taskRoles?.[role]?.candidates ?? [] : account.credentialRanking?.candidates ?? [];
    const manual = live.freeManualExclusions?.[role] ?? [];
    const arms = candidates.filter(arm => {
      const verdict = freeArmVerdict(arm, provider, ledger.values(), cfg, nowMs);
      if (report) report.push({ accountId: account.accountId, provider, armId: arm.armId, model: arm.model, ...verdict });
      if (!verdict.eligible) return false;
      // Replace only the paid quality floor. Task trust, exact effort support,
      // operational identity and a usable resource estimate stay mandatory.
      if (arm.taskRanking && (!arm.benchmarkTrusted || !arm.effortVerified
        || (arm.operationalReasons?.length ?? 0) > 0 || !Number.isFinite(arm.taskCostProxy)
        || !['eligible', 'pareto-dominated', 'min-quality'].includes(arm.selectionReason))) return false;
      return true;
    }).map(arm => ({ ...arm, eligible: true }));
    const groups = filterRungsByExcludedFamilies([{ rung: 0, arms }], manual);
    const ready = credentialReadinessEnforced(companyId) ? filterCredentialRungs(groups, nowMs) : groups;
    return filterBreakerRungs(ready, breakerStores.get(companyId) ?? createBreakerStore(), account.accountId,
      nowMs, lastConfig.get(companyId)?.breakers ?? DEFAULT_BREAKERS);
  }

  function freeDecisionFor(params, live, role, account, nowMs, available) {
    if (!account.reactive && !account.remainingKnown) return { decision: { kind: 'defer' }, groups: [] };
    const adapter = params.adapterType ?? liveAdapterFor(live, params.agentId);
    const groups = freeRunGroups(live, params.companyId, account, role, nowMs).map(g => ({ ...g,
      arms: g.arms.filter(a => adapterAllowsTrial(live.trialAdapters, adapter, a.family)) }));
    const trialBudget = Object.fromEntries(groups.flatMap(g => g.arms.map(a => [a.family, available])));
    const decision = decide({ runId: params.runId, agentId: params.agentId, role,
      ladderRungs: groups, accountId: account.accountId, pointer: 0,
      roleBands: { [role]: { floorRung: 0, ceilingRung: 0 } }, contextCaps: live.contextCaps,
      adapterType: adapter, trialBudget, trialAdapters: live.trialAdapters, trialRoles: live.trialRoles,
      fiveHourHeadroomPct: account.headroomPct, burnPerRunPct: account.burnPerRunPct,
      reservePct: 0.05, taskRanking: live.taskRanking });
    return { decision, groups };
  }

  function freeCapacityReport(live, companyId, nowMs) {
    const cfg = live.freeLanes;
    const ledger = ledgers.get(companyId) ?? new Map();
    const usage = freeLaneUsage.get(companyId) ?? {};
    const providers = {}, arms = [];
    const allowed = safeFreeAgentIds(live, companyId);
    for (const provider of Object.keys(cfg.providers)) {
      const accounts = live.accounts.filter(a => freeProvider(a, cfg) === provider);
      const budget = freeLaneBudget(provider, live.accounts, ledger, usage, cfg, nowMs, null, live.staleHorizonMs);
      const usable = accounts.some(a => a.health === 'healthy' && a.action !== 'excluded'
        && allowed.some(agentId => freeDecisionFor({ runId: 'free-capacity-preview', companyId, agentId },
          live, roleOf({ roles: live }, agentId), a, nowMs, budget.slots).decision.kind === 'decide'));
      for (const a of accounts) freeRunGroups(live, companyId, a, 'doer', nowMs, arms);
      Object.defineProperty(providers, provider, { enumerable: true, value: { ...budget,
        target: usable && (budget.dailyRemaining == null || budget.dailyRemaining >= cfg.providers[provider].requestsPerRun)
          ? budget.slots : 0 } });
    }
    return { enabled: true, minQuality: cfg.minQuality, providers, arms,
      target: Object.values(providers).reduce((sum, p) => sum + p.target, 0),
      outcomeSignal: 'failed-run-or-status-progress; not adjudicated review acceptance' };
  }

  function routeFreeRun(params, live, role, ledger) {
    const cfg = freeLaneConfigs.get(params.companyId);
    if (!lowRiskRun(params, cfg, { role,
      kept: live.keepAgentIds?.includes(params.agentId),
      reviewer: liveIsReviewAgent(live, params.agentId) || live.reviewerRouting?.agentIds?.includes(params.agentId) })) return null;
    if (JSON.stringify(cfg) !== JSON.stringify(live.freeLanes)) return null;
    const previous = ledger.get(params.runId);
    if (previous?.freeAnswer && previous.enforced && !isTerminalStatus(previous.status)) return previous.freeAnswer;
    if (previous?.enforced || isTerminalStatus(previous?.status)) return null;
    const nowMs = clock();
    if (nowMs < live.atMs) return null;
    const executing = [...ledger.values()].filter(r => r.runId !== params.runId
      && !deferredRuns.get(params.companyId)?.has(r.runId)
      && isInflight(r, nowMs, live.staleHorizonMs)).length;
    if (executing >= live.freeLanesMaxTotal) return null;
    const usage = freeLaneUsage.get(params.companyId);
    if (!usage) return null; // no native tick/usage load yet
    for (const account of live.accounts) {
      const provider = freeProvider(account, cfg);
      if (!provider || account.health !== 'healthy' || account.action === 'excluded') continue;
      const budget = freeLaneBudget(provider, live.accounts, ledger, usage, cfg, nowMs, params.runId, live.staleHorizonMs);
      if (budget.available < 1) continue;
      const { decision: d, groups } = freeDecisionFor(params, live, role, account, nowMs, budget.available);
      if (d.kind !== 'decide' || !decisionCredentialReady(d, groups, params.companyId)) continue;
      const bstore = breakerStores.get(params.companyId) ?? createBreakerStore();
      const bcfg = lastConfig.get(params.companyId)?.breakers ?? DEFAULT_BREAKERS;
      if (breakerState(bstore, account.accountId, d.armId, nowMs, bcfg) === 'half-open'
        && !startProbe(bstore, account.accountId, d.armId, params.runId, nowMs, bcfg)) continue;
      const answer = { kind: 'decide', decisionId: d.decisionId, model: d.model, effort: d.effort,
        env: d.env, source: d.source, reason: `additive free lane ${provider}: ${d.reason}` };
      // Synchronous admission + reservation + record, with no await between
      // them: concurrent hook RPCs cannot spend the same provider slot twice.
      reserveFreeRun(usage, provider, cfg, nowMs);
      recordDecision(ledger, { runId: params.runId, agentId: params.agentId, accountId: d.accountId,
        armId: d.armId, effort: d.effort, enforced: true, wouldModel: d.model, rung: d.rung,
        trial: d.trial, family: inferFamily(canonicalModelName(d.model)), reason: answer.reason,
        freeProvider: provider, freeAnswer: answer }, nowMs);
      return answer;
    }
    return null;
  }

  function credentialReadinessEnforced(companyId) {
    const live = liveViews.get(companyId);
    // Disabling is an immediate safety escape hatch. Enabling takes effect
    // with the next tick, which publishes an admission view built in that mode.
    // The company set (not the tick-refreshed lastConfig) is read here so a
    // stale in-flight tick cannot re-enable enforcement after an on-to-off
    // flip: only onConfigChanged writes the set.
    return credentialEnforceCompanies.has(companyId)
      && live?.credentialReadinessEnforced === true;
  }

  // Omit the flag and admission stays legacy: the default must fail open so
  // a new or merged call site cannot silently re-enable the readiness filter
  // in an opt-in-off installation.
  function credentialLadderFor(ranking, nowMs, enforce = false, admits = null) {
    const trusted = ranking.candidates.filter(c => c.taskRanking !== true
      || (c.eligible === true && (!admits || admits(c))));
    const ready = enforce
      ? trusted.filter(c => credentialReadiness(c.credentialEvidence, nowMs).eligible)
      : trusted;
    const byArm = new Map(ready.map(c => [c.armId, c]));
    const admitted = buildLadder(ready, ranking.previousRungs, ranking.gateByArm, ranking.heldPairs);
    const benchmark = ranking.rankingRungs;
    const rungByArm = new Map(benchmark.map(r => [r.armId, r.rung]));
    const candidatesByArm = new Map(ranking.candidates.map(c => [c.armId, c]));
    const excluded = new Set(ranking.excludedArmIds ?? []);
    // Admission may revive dominated backups, but must not move the pacing
    // pointer or role bands into another benchmark rung. A revived backup
    // occupies the lowest benchmark rung whose incumbent strictly dominates it.
    const rungs = admitted.rungs.flatMap(r => {
      if (excluded.has(r.armId)) return [];
      const rung = rungByArm.get(r.armId) ?? benchmark.find(b =>
        byArm.get(r.armId)?.taskRanking === true
          ? ladderDominates({ ...candidatesByArm.get(b.armId), ...b }, { ...byArm.get(r.armId), ...r })
          : b.Q >= r.Q && b.C <= r.C && (b.Q > r.Q || b.C < r.C))?.rung;
      if (rung == null) return [];
      return [{
        ...byArm.get(r.armId), ...r, rung,
        maxRung: r.coverage < LOW_COVERAGE_THRESHOLD ? LOW_COVERAGE_MAX_RUNG : benchmark.length - 1,
      }];
    });
    return { ...admitted, rungs };
  }

  function credentialGroupsFor(ladder, nowMs = clock(), enforce = false, role = 'doer', taskMode = null, admits = null) {
    const roleRanking = (taskMode ?? ladder?.taskRankingMode) === 'enforce' ? ladder?.taskRoles?.[role] : null;
    const ranking = roleRanking ?? ladder?.credentialRanking;
    if (!ranking) {
      const groups = ladder?.ladderRungs ?? groupByRung(ladder?.rungs ?? []);
      return enforce ? filterCredentialRungs(groups, nowMs) : groups;
    }
    const admitted = credentialLadderFor(ranking, nowMs, enforce, roleRanking ? c =>
      (!c.trial || roleTakesTrial(ladder.taskTrialRoles ?? DEFAULT_TRIALS.roles, role, c.family)) && (!admits || admits(c)) : null);
    const byRung = new Map(groupByRung(admitted.rungs).map(g => [g.rung, g]));
    // decide and placement use group count as topRung; retain empty shells
    // just like the breaker and family-exclusion filters.
    return ranking.rankingRungs.map(r => byRung.get(r.rung) ?? { rung: r.rung, arms: [] });
  }

  // Per-arm aggregator fallback (owner rule 2026-09-17): duplicate arms of a
  // Devin lane are held back from the first routing pass.
  function routableGroupsFor(ladder, duplicates = true, nowMs = clock(), enforce = false, role = 'doer', taskMode = null, admits = null) {
    const duplicateIds = ladder?.credentialRanking?.duplicateArmIds ?? [];
    const duplicateSlugs = new Set((ladder?.credentialRanking?.candidates ?? []).filter(c => duplicateIds.includes(c.armId)).map(c => c.armId));
    const taskIds = (ladder?.taskRoles?.[role]?.candidates ?? []).filter(c => duplicateSlugs.has(c.aaSlug)).map(c => c.armId);
    const held = duplicates ? null : new Set([...duplicateIds, ...taskIds]);
    const groups = credentialGroupsFor(ladder, nowMs, enforce, role, taskMode,
      c => (!held || !held.has(c.armId)) && (!admits || admits(c)));
    if (!held || held.size === 0) return groups;
    return groups.map(g => ({ ...g, arms: (g.arms ?? []).filter(a => !held.has(a.armId)) }));
  }

  // Run-local feasibility precedes Pareto pruning in the task path. Calling
  // the same pure decision on a singleton prevents a context/adapter/burn/
  // trial/breaker-ineligible dominator from hiding an executable backup.
  function taskRunAdmission(inputs, bstore, nowMs, bcfg) {
    if (inputs.taskRanking?.mode !== 'enforce') return null;
    return arm => decide({ ...inputs, pointer: 0,
      roleBands: { [inputs.role ?? 'doer']: { floorRung: 0, ceilingRung: 0 } },
      ladderRungs: filterBreakerRungs([{ rung: 0, arms: [arm] }], bstore, inputs.accountId, nowMs, bcfg),
    }).kind === 'decide';
  }

  function routingBurn(ladder) {
    return ladder?.taskRankingMode === 'enforce' ? ladder?.taskBurnPerRunPct ?? {} : ladder?.burnPerRunPct ?? {};
  }

  function withDuplicatePass(allocate) {
    const held = allocate(false);
    const full = allocate(true);
    return {
      order: [...held.order, ...full.order],
      paced: full.paced,
      pools: full.pools,
      reserveHeld: full.reserveHeld,
    };
  }

  function decisionCredentialReady(decision, groups, companyId) {
    if (!credentialReadinessEnforced(companyId)) return true;
    const arm = groups.flatMap(group => group.arms ?? []).find(a => a.armId === decision.armId);
    return credentialReadiness(arm?.credentialEvidence, clock()).eligible;
  }

  function credentialDefer(companyId, reason = 'no fresh ready credential evidence') {
    if (credentialReadinessEnforced(companyId)) {
      warnEligibility(companyId, [{ code: reason === 'routing snapshot stale or invalid'
        ? 'credential-availability-stale-snapshot' : 'credential-availability-all-unavailable',
        message: `${reason}; admission deferred`,
      }], clock());
    }
    return { kind: 'defer', retryAfterMs: 60000, reason };
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
   * mutate the view. The pooled value drives ORDERING and the pace guard;
   * the reactive per-account cap is checked separately against per-account
   * counts (see the hook and event-time loops).
   * Returns { order, paced, pools, reserveHeld } (see
   * orderAccountsWithPacing): the pace guard reads the same knobs and plan
   * positions the tick used, so the hook, the event-time path and the tick
   * hold and release a pool alike; the review reserve holds the tick's held
   * accounts for non-review runs (forReview true runs past the hold).
   */
  function allocationOrderFromLive(live, companyId, excludeRunId = null, role = 'doer', roleExcluded = [], duplicates = true, forReview = false, run = {}) {
    const providerOf = new Map((live.accounts ?? []).map(a =>
      [a.accountId, String(a.pool ?? a.provider ?? String(a.accountId).split(':')[0]).toLowerCase()]));
    const poolOf = (id) => providerOf.get(id) ?? String(id).split(':')[0].toLowerCase();
    const poolPending = {};
    const lanePending = new Map();
    for (const q of decisionsSinceTick(live, companyId, excludeRunId)) {
      if (!q?.decidedAccount) continue;
      const p = poolOf(q.decidedAccount);
      poolPending[p] = (poolPending[p] ?? 0) + 1;
      lanePending.set(q.decidedAccount, (lanePending.get(q.decidedAccount) ?? 0) + 1);
    }
    // The pace guard counts from the ledger itself, fresh at call time (the
    // frozen pooled count plus pending decisions above drives ordering
    // only): executing runs, without the ones the hook deferred and without
    // the caller's own run.
    const pacePools = live.paceGuard?.enabled === true && ledgers.has(companyId)
      ? paceInFlightByPool(companyId, ledgers.get(companyId), {
        nowMs: clock(), horizonMs: live.staleHorizonMs, selfRunId: excludeRunId, poolOf,
      }).pools
      : {};
    const bstore = breakerStores.get(companyId) ?? createBreakerStore();
    const bcfg = lastConfig.get(companyId)?.breakers ?? DEFAULT_BREAKERS;
    const nowMs = clock();
    const inputsFor = a => ({ runId: run.runId ?? 'preview', agentId: run.agentId ?? 'preview', role,
      excludedFamilies: roleExcluded, pointer: a.pointer ?? 0,
      retryCount: 0, failureClass: 'none', contextTokens: null,
      fiveHourHeadroomPct: a.headroomPct, burnPerRunPct: a.burnPerRunPct ?? {}, reservePct: .05,
      accountId: a.accountId, roleBands: live.roleBands, contextCaps: live.contextCaps,
      adapterType: run.adapterType ?? liveAdapterFor(live, run.agentId) ?? null,
      trialBudget: effectiveTrialBudget(live, companyId, excludeRunId),
      trialAdapters: live.trialAdapters ?? {}, trialRoles: live.trialRoles ?? DEFAULT_TRIALS.roles,
      taskRanking: live.taskRanking,
    });
    const routesRun = (a, dups) => filterBreakerRungs(routableGroupsFor(a, dups, nowMs,
      credentialReadinessEnforced(companyId), role, null, taskRunAdmission(inputsFor(a), bstore, nowMs, bcfg)),
    bstore, a.accountId, nowMs, bcfg);
    return orderAccountsWithPacing(
      (live.accounts ?? []).filter(a => !managedFreeAccount(live, companyId, a) && (rungsHaveEligibleArms(routesRun(a, true))
        || (forReview && live.taskRanking?.mode === 'enforce' && (a.policyReviewerArms?.length ?? 0) > 0))).map(a => {
        const p = poolOf(a.accountId);
        const ladderRungs = routesRun(a, duplicates);
        const preview = live.taskRanking?.mode === 'enforce' ? decide({ ...inputsFor(a), ladderRungs }) : null;
        const taskView = preview ? taskPlacement(preview, ladderRungs) : {};
        if (preview && ((!a.reactive && !a.remainingKnown)
          || (a.reactive && (a.inFlight ?? 0) + (lanePending.get(a.accountId) ?? 0) >= liveTrialInflightCapFor(live, a)))) taskView.taskFeasible = false;
        return {
          ...a,
          ladderRungs,
          roleEligible: roleLadderAccess(ladderRungs, {
            role, roleBands: live.roleBands, excludedFamilies: roleExcluded,
            trialRoles: live.trialRoles ?? DEFAULT_TRIALS.roles,
          }).eligible,
          held: !duplicates && !rungsHaveEligibleArms(ladderRungs),
          targetShare: a.targetShare ?? null,
          inFlight: (live.inFlightByPool?.[p] ?? 0) + (poolPending[p] ?? 0),
          paceInFlight: pacePools[p] ?? 0,
          pool: p,
          laneInFlight: (a.inFlight ?? 0) + (lanePending.get(a.accountId) ?? 0),
          placementQ: placementArm(ladderRungs, {
            role, roleBands: live.roleBands, excludedFamilies: roleExcluded,
            trialRoles: live.trialRoles ?? DEFAULT_TRIALS.roles, pointer: a.pointer ?? 0,
          })?.quality ?? null,
          ...taskView,
        };
      }),
      {
        reservePct: 0.05, rateDeadbandRel: live.rateDeadbandRel ?? 0.15, placement: live.placement ?? null, pacing: live.paceGuard ?? null,
        reviewReserve: live.reviewReserve?.enabled === true
          ? { heldAccountIds: live.reviewReserve.heldAccountIds ?? [], forReview }
          : null,
        creditPriority: live.creditPriority ?? 'fallback',
        taskRanking: live.taskRanking,
      },
    );
  }

  /**
   * Defer text for one paced pool. A whole pool reads as before; a pool
   * where only ahead lanes are held (per-lane guard) names those lanes.
   */
  function pacedPoolText(p) {
    if (p.paced === false && (p.pacedAccountIds?.length ?? 0) > 0) {
      const lanes = (p.laneVerdicts ?? []).filter(l => l.paced)
        .map(l => `${l.accountId} ${Math.round(l.planAhead * 1000) / 10}% ahead of plan`);
      return `${p.pool} lanes ${lanes.join(', ')}; ${p.inFlight} of ${p.cap} in flight`;
    }
    return `${p.pool} ${Math.round(p.planAhead * 1000) / 10}% ahead of plan, ${p.inFlight} of ${p.cap} in flight`;
  }

  /** True when the run's agent serves reviews past the reserve hold. */
  function liveIsReviewAgent(live, agentId) {
    return Array.isArray(live?.reviewReserve?.agentIds) && live.reviewReserve.agentIds.includes(agentId);
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
      if (q?.trial !== true || !q?.family
        || (live.freeLanes?.enabled === true && q.enforced === true && q.freeProvider != null)) continue;
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

  /**
   * Reviewer-arm service check for one account (shared by the hook and the
   * tick's /capacity preview). The arm's model must be served (feed model
   * list or a ladder arm), its family and arm tokens must survive the
   * role's exclusions, and a ladder arm serving it must have a closed
   * breaker (open and half-open probes route nothing here). Returns true or
   * a refusal string; `match` is the ladder arm used for attribution.
   */
  function reviewerArmCheck(account, arm, { ladderArms = [], readyArms = null, roleExcluded = [], bstore = null, bcfg = DEFAULT_BREAKERS, nowMs = clock() } = {}) {
    const canon = String(canonicalModelName(arm.model) ?? '').toLowerCase();
    if (!canon) return { ok: 'model unmappable' };
    const sameModel = (m) => String(canonicalModelName(m) ?? '').toLowerCase() === canon;
    const matches = ladderArms.filter((x) => x != null && sameModel(x.model));
    const listed = (account.models ?? []).some(sameModel);
    if (matches.length === 0 && !listed) return { ok: `${arm.model} not served` };
    const effort = arm.effort != null ? String(arm.effort).toLowerCase() : null;
    const match = matches.find((x) => effort != null && String(x.effort ?? '').toLowerCase() === effort) ?? matches[0] ?? null;
    // Admission belongs to the selected arm, not a sibling effort of the model.
    if (readyArms != null && (!match || !readyArms.some((x) => x != null
      && x.armId === match.armId && sameModel(x.model)))) {
      return { ok: `${arm.model} has no credential-ready arm` };
    }
    const excluded = new Set(normalizeExcludedFamilies(roleExcluded));
    const fam = inferFamily(canon);
    if (fam && excluded.has(fam)) return { ok: `family ${fam} excluded for the role` };
    if (excluded.has(armToken(canon)) || (match && (excluded.has(String(match.family ?? '').toLowerCase())
      || excluded.has(armToken(match.armId)) || (match.aaSlug && excluded.has(armToken(match.aaSlug)))
      || (match.legacyArmIds ?? []).some(id => excluded.has(armToken(id)))))) {
      return { ok: 'arm excluded for the role' };
    }
    if (bstore && bcfg?.enabled !== false && match?.armId != null
      && breakerState(bstore, account.accountId, match.armId, nowMs, bcfg) !== 'closed') {
      return { ok: 'arm breaker not closed' };
    }
    return {
      ok: true, match,
      model: match?.model ?? servedIdForArm(account.models, canonicalModelName(arm.model), account.laneProvider ?? account.provider),
    };
  }

  /** Flat arm list of a live account (grouped rungs plus ranked candidates). */
  function liveLadderArms(a) {
    const out = [];
    for (const g of [...(a?.ladderRungs ?? []), ...(a?.credentialRanking?.candidates ?? []), ...(a?.taskRankingMode === 'enforce' ? a?.policyReviewerArms ?? [] : [])]) {
      if (Array.isArray(g?.arms)) out.push(...g.arms);
      else if (g && typeof g === 'object' && g.model != null) out.push(g);
    }
    return out;
  }

  /** One admission policy for routed reviewer capacity, preview and hook. */
  function reviewerArmAdmission(live, companyId, agentId, nowMs = clock()) {
    const role = roleOf({ roles: { thinkerAgentIds: live.thinkerAgentIds, doerAgentIds: live.doerAgentIds } }, agentId);
    const roleExcluded = normalizeExcludedFamilies((live.taskRanking?.mode === 'enforce'
      ? live.reviewerPolicyExclusions?.[role] : live.excludeFamilies?.[role]) ?? []);
    const bstore = breakerStores.get(companyId) ?? createBreakerStore();
    const bcfg = lastConfig.get(companyId)?.breakers ?? DEFAULT_BREAKERS;
    const readiness = credentialReadinessEnforced(companyId);
    const taskEnforce = live.taskRanking?.mode === 'enforce';
    return (a, arm) => {
      // Use the policy identity, not a legacy sibling of the same model.
      // Even with readiness off, require the policy record: its construction
      // enforces the model identity and emitted-servability fences.
      const policy = a.policyReviewerArms ?? [];
      return reviewerArmCheck(a, arm, {
        ladderArms: taskEnforce ? policy : liveLadderArms(a),
        readyArms: taskEnforce
          ? policy.filter(c => !readiness || credentialReadiness(c.credentialEvidence, nowMs).eligible)
          : readiness ? credentialGroupsFor(a, nowMs, true).flatMap((g) => g?.arms ?? []) : null,
        roleExcluded, bstore, bcfg, nowMs,
      });
    };
  }

  /** Sync reviewer-route pick over a live view (hook and /capacity preview). */
  function pickReviewerRoute(live, companyId, agentId, selfId = null, nowMs = clock(), excludeIds = null) {
    const cfg = live?.reviewerRouting;
    const pending = pendingByAccount(live, companyId, selfId);
    const admit = reviewerArmAdmission(live, companyId, agentId, nowMs);
    const admissionOf = new Map();
    const pick = selectReviewerRoute({
      cfg,
      accounts: (live.accounts ?? []).filter(a => !excludeIds?.has(a.accountId) && !managedFreeAccount(live, companyId, a)),
      burnTokens: new Set(live.burnModeTokens ?? []),
      taskRanking: live.taskRanking,
      primaryUnavailableReasons: (live.accounts ?? []).filter(a => excludeIds?.has(a.accountId)
        && String(a.pool ?? a.provider).toLowerCase() === 'meta').map(() => 'pace guard holds the approved Meta lane'),
      inFlightOf: (a) => (a.inFlight ?? 0) + (pending.get(a.accountId) ?? 0),
      serves: (a, arm) => {
        const r = admit(a, arm);
        if (r.ok === true) admissionOf.set(`${a.accountId}|${arm.provider}|${arm.model}|${arm.effort ?? ''}`, r);
        return r.ok;
      },
    });
    return { pick, admissionOf };
  }

  function configuredTaskReviewer(live, agentId) {
    return live?.taskRanking?.mode === 'enforce' && live.reviewerRouting?.agentIds?.includes(agentId) === true;
  }

  function recordReviewerShadow(ledger, live, companyId, run, selection, eventTime) {
    const { pick, admissionOf } = selection;
    if (pick.none) return null;
    const { match, emitModel, env } = reviewerPickEmission(live, pick, admissionOf);
    const adapter = run.adapterType ?? liveAdapterFor(live, run.agentId) ?? null;
    const model = decoratedModelFor({ model: emitModel, effort: pick.arm.effort,
      contextWindow: match?.contextWindow ?? null }, adapter) ?? `${emitModel}(${pick.arm.effort ?? 'default'})`;
    recordDecision(ledger, { runId: String(run.runId), agentId: run.agentId, accountId: pick.accountId,
      armId: match?.armId ?? null, effort: pick.arm.effort ?? null, enforced: false,
      wouldModel: model, family: inferFamily(canonicalModelName(emitModel)), reason: pick.reason, eventTime }, clock());
    return { kind: 'decide', model: emitModel, effort: pick.arm.effort, accountId: pick.accountId, env };
  }

  /**
   * Caps env for a run executing `model` outside decide(): the same
   * contextCapsEnv decide() applies, keyed off the matched ladder arm when
   * there is one (its tier cap and family), else the family inferred from
   * the model id -- a Sol id served without a ladder arm is still Sol. The
   * emitted model id picks the Sol window vs the Luna cliff caps.
   */
  function capsEnvForModel(model, match, contextCaps) {
    return contextCapsEnv({
      cap: match?.cap ?? null,
      family: match?.family ?? inferFamily(canonicalModelName(model)),
      model: match?.model ?? model,
    }, contextCaps);
  }

  /** The live ladder arm serving `model` (first account in live order), or null. */
  function liveArmForModel(live, model) {
    const canon = String(canonicalModelName(model) ?? '').toLowerCase();
    if (!canon) return null;
    for (const a of live?.accounts ?? []) {
      const hit = liveLadderArms(a).find((x) => x != null
        && String(canonicalModelName(x.model) ?? '').toLowerCase() === canon);
      if (hit) return hit;
    }
    return null;
  }

  /** Emitted model and caps env of a reviewer pick (hook and /capacity preview). */
  function reviewerPickEmission(live, pick, admissionOf) {
    const arm = pick.arm;
    const admission = admissionOf.get(`${pick.accountId}|${arm.provider}|${arm.model}|${arm.effort ?? ''}`);
    const match = admission?.match ?? null;
    const emitModel = admission?.model ?? arm.model;
    return { match, emitModel, env: capsEnvForModel(emitModel, match, live?.contextCaps) };
  }

  /**
   * A `keep` answer carries no env, so a kept run on a Sol/Luna model would
   * execute without the context caps (or under the agent's base-config
   * window, e.g. a Muse-sized 1M). For those families only, answer a decide
   * on the SAME configured model string (the host's agentDefaultModel is
   * the adapter config `model` verbatim; effort omitted: the host keeps the
   * configured effort) carrying the caps env -- the configured Sol window /
   * Luna cliff caps, lowered by the model's tier cap when its ladder arm has
   * one. Every other model (or an unknown default) returns null: the caller
   * keeps, exactly as before.
   */
  function keptCapsAnswer(params, live, why) {
    const model = params?.agentDefaultModel;
    if (typeof model !== 'string' || model.trim().length === 0) return null;
    const match = liveArmForModel(live, model);
    const family = match?.family ?? inferFamily(canonicalModelName(model));
    if (!needsContextCap(family, model)) return null;
    const env = capsEnvForModel(model, match, live?.contextCaps);
    if (Object.keys(env).length === 0) return null;
    const sanitize = (x) => String(x).replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 80) || 'x';
    return {
      kind: 'decide',
      decisionId: `mc-${sanitize(params.runId ?? 'unknown')}-kept-${sanitize(model)}`,
      model,
      env,
      source: 'model-capacity',
      reason: `${why}: configured ${model} kept with ${family} context caps`,
    };
  }

  /**
   * Deferral-exhaustion answer (Design B, memory-only). The host gives the
   * hook RUN_MODEL_RESOLVE_MAX_ATTEMPTS = 12 chained retries (a new runId
   * every retry) and then freezes the card; the per-runId deferredRuns marks
   * reset every retry, so they can never see the chain end. When the
   * per-issue+agent streak reaches the final attempts, this stops deferring
   * and answers instead:
   *
   * 1. Candidate accounts are live accounts with health healthy/degraded, a
   *    closed-breaker arm surviving the role exclusions, and role access --
   *    IGNORING the pace-guard pool cap and the 5h headroom reserve (the two
   *    holds that strand pacing, priced below). The review reserve still
   *    holds: quota reserved for review runs is never spent here.
   * 2. Hard caps are never bypassed: the per-account reactive cap
   *    (liveTrialInflightCapFor), the per-family trial budget
   *    (effectiveTrialBudget), roleTakesTrial/adapterAllowsTrial, the role
   *    exclusions, credential readiness, and the arm breaker.
   * 3. Order is cheapest-first: free-cost providers (nvidia-nim) first, then
   *    trial-eligible accounts, then the lowest burnPerRunPct/ladder cost.
   *    Metered pools ahead of plan or exhausted are NEVER selected: an
   *    ahead lane needs no more runs, whatever the host budget says. (A pool
   *    held only by the pace-guard in-flight cap is the explicitly priced
   *    bypass and may be selected.)
   * 4. No selectable arm falls back to a bounded keep on the agent default
   *    model -- but ONLY when that model serves from a healthy/degraded
   *    account, and for non-review runs not from a review-reserve held
   *    account. An exhausted, held-only, or unmapped default keeps
   *    deferring: strand the card rather than burn an exhausted pool or
   *    held quota.
   *
   * Returns { answer } (decide or keep, recorded enforced:true / kept with a
   * 'deferral-exhausted: <prior> -> <arm|kept model>' reason) or
   * { answer: null, skips } with one per-account skip reason for
   * diagnosability. Never throws for a malformed view: bad accounts are
   * skipped, never selected.
   */
  async function exhaustionAnswer({ live, params, role, selfId, priorReason, forReview, hookLedger, nowMs }) {
    const skips = [];
    const fail = () => ({ answer: null, skips });
    const companyId = params?.companyId;
    if (live?.taskRanking?.mode === 'enforce' && forReview) {
      skips.push('approved reviewer policy retained; no ordinary overflow or bounded default keep');
      return fail();
    }
    const roleExcluded = normalizeExcludedFamilies(live?.excludeFamilies?.[role] ?? []);
    const adapter = params?.adapterType ?? liveAdapterFor(live, params?.agentId) ?? null;
    const bstore = breakerStores.get(companyId) ?? createBreakerStore();
    const bcfg = lastConfig.get(companyId)?.breakers ?? DEFAULT_BREAKERS;
    const trialRoles = live?.trialRoles ?? DEFAULT_TRIALS.roles;
    const trialAdapters = live?.trialAdapters ?? {};
    // The review reserve holds quota FOR review runs: non-review runs never
    // spend it, even at exhaustion.
    const heldIds = new Set(
      (!forReview && live?.reviewReserve?.enabled === true)
        ? (live.reviewReserve.heldAccountIds ?? [])
        : [],
    );
    const margin = typeof live?.paceGuard?.marginPct === 'number' ? live.paceGuard.marginPct : 0.02;
    const capBase = new Map((live?.accounts ?? []).map(a => [a.accountId, a.inFlight ?? 0]));
    const acctPending = pendingByAccount(live, companyId, selfId);
    const budget = effectiveTrialBudget(live, companyId, selfId);
    const trialOkFor = (arm) => arm?.trial === true
      && roleTakesTrial(trialRoles, role, arm.family)
      && adapterAllowsTrial(trialAdapters, adapter, arm.family)
      && (budget[arm.family] ?? 0) > 0;
    const armCost = (view, arm) => {
      const burn = view?.burnPerRunPct?.[arm?.armId];
      if (typeof burn === 'number' && Number.isFinite(burn)) return burn;
      const cost = arm?.costEffective ?? arm?.C;
      if (typeof cost === 'number' && Number.isFinite(cost)) return cost;
      return Infinity;
    };
    const inputsFor = view => ({ runId: params.runId, agentId: params.agentId, role,
      excludedFamilies: roleExcluded, pointer: view.pointer ?? 0,
      retryCount: 0, failureClass: 'none', contextTokens: null,
      // Exhaustion relaxes only the legacy reserve, not actual headroom or
      // any capability/trial/credential/adapter/breaker requirement.
      fiveHourHeadroomPct: view.headroomPct ?? null, burnPerRunPct: view.burnPerRunPct ?? {}, reservePct: 0,
      accountId: view.accountId, roleBands: live.roleBands, contextCaps: live.contextCaps,
      adapterType: adapter, trialBudget: budget, trialAdapters, trialRoles, taskRanking: live.taskRanking,
    });
    const cands = [];
    for (const view of live?.accounts ?? []) {
      const accountId = view?.accountId;
      // Managed free lanes have one admission path. Exhaustion cannot bypass
      // low-risk eligibility, provider slots, daily reservations or demotion.
      if (managedFreeAccount(live, companyId, view)) continue;
      if (typeof accountId !== 'string' || accountId.length === 0) continue;
      if (view.health !== 'healthy' && view.health !== 'degraded') {
        skips.push(`${accountId} health ${view.health ?? 'unknown'}`);
        continue;
      }
      if (view.health === 'healthy' && view.action === 'excluded') {
        skips.push(`${accountId} ${view.reason ?? 'excluded from admission'}`);
        continue;
      }
      if (heldIds.has(accountId)) {
        skips.push(`${accountId} review-reserve held`);
        continue;
      }
      // Ahead-of-plan metered pools are never selected at exhaustion: the
      // pool needs no more runs this window, whatever the host budget says.
      // Reactive accounts carry no plan position (never ahead); burn-mode
      // accounts are operator-flagged to spend.
      const ahead = !view.reactive && view.burn !== true && view.planAhead != null && view.planAhead > margin;
      if (ahead) {
        skips.push(`${accountId} ahead of plan ${Math.round(view.planAhead * 1000) / 10}%`);
        continue;
      }
      // Breaker-filtered like the tick loop, so the hook never picks an arm
      // the tick would skip; then the role exclusions, same as the main loop.
      const roleRungs = filterRungsByExcludedFamilies(
        filterBreakerRungs(credentialGroupsFor(view, nowMs, credentialReadinessEnforced(companyId), role, null,
          taskRunAdmission(inputsFor(view), bstore, nowMs, bcfg)), bstore, accountId, nowMs, bcfg),
        roleExcluded,
      );
      if (!rungsHaveEligibleArms(roleRungs)) {
        skips.push(`${accountId} no eligible arm (breaker/readiness/exclusions)`);
        continue;
      }
      if (roleLadderAccess(roleRungs, {
        role, roleBands: live.roleBands, excludedFamilies: roleExcluded, trialRoles,
      }).eligible !== true) {
        skips.push(`${accountId} no arm reachable for role ${role}`);
        continue;
      }
      // Unknown headroom on a metered account is never "plenty of quota"
      // (CISO unknown-headroom rule); reactive accounts carry no meter.
      if (!view.reactive && !view.remainingKnown) {
        skips.push(`${accountId} metered headroom unknown`);
        continue;
      }
      // A spent weekly window cannot serve until reset. Credit-backed lanes
      // publish `credits` instead and remain eligible under their own guard.
      // This still matters for degraded accounts, whose recovery eligibility
      // intentionally bypasses the healthy-only action exclusion above.
      if (!view.reactive && view.headroomSource === 'weekly') {
        skips.push(`${accountId} weekly window exhausted`);
        continue;
      }
      // The per-account reactive cap is a hard cap, even at exhaustion.
      if (view.reactive
        && (capBase.get(accountId) ?? 0) + (acctPending.get(accountId) ?? 0) >= liveTrialInflightCapFor(live, view)) {
        skips.push(`${accountId} trial cap ${(capBase.get(accountId) ?? 0) + (acctPending.get(accountId) ?? 0)}/${liveTrialInflightCapFor(live, view)} in flight`);
        continue;
      }
      const arms = roleRungs.flatMap(g => g?.arms ?? []);
      const free = view.freeCost === true;
      const preview = live.taskRanking?.mode === 'enforce' ? decide({ ...inputsFor(view), ladderRungs: roleRungs }) : null;
      if (preview && preview.kind !== 'decide') {
        skips.push(`${accountId} no feasible exhaustion arm: ${preview.reason}`);
        continue;
      }
      const actualArm = preview && arms.find(a => a.armId === preview.armId);
      const trialEligible = preview ? preview.trial : arms.some(trialOkFor);
      let cost = actualArm ? actualArm.taskCostProxy ?? Infinity : Infinity;
      if (!preview) for (const arm of arms) cost = Math.min(cost, armCost(view, arm));
      cands.push({ view, roleRungs, preview, actualArm, tier: free ? 0 : (trialEligible ? 1 : 2), cost });
    }
    cands.sort((a, b) => (a.tier - b.tier) || (a.actualArm && b.actualArm ? compareTaskCosts(a.actualArm, b.actualArm) : a.cost - b.cost)
      || (a.view.accountId < b.view.accountId ? -1 : a.view.accountId > b.view.accountId ? 1 : 0));
    for (const { view, roleRungs, preview } of cands) {
      const d = preview ?? decide({ ...inputsFor(view), ladderRungs: roleRungs });
      if (d.kind !== 'decide') {
        skips.push(`${view.accountId} decide skipped (${d.reason})`);
        continue;
      }
      if (!decisionCredentialReady(d, roleRungs, companyId)) {
        skips.push(`${view.accountId} arm ${d.armId ?? d.model} not credential-ready`);
        continue;
      }
      // Half-open probe claim, exactly like the main loop: only enforced
      // runs route real traffic, so only they occupy the probe slot.
      if (d.armId != null && params?.runId != null
        && breakerState(bstore, d.accountId, d.armId, nowMs, bcfg) === 'half-open'
        && !startProbe(bstore, d.accountId, d.armId, params.runId, nowMs, bcfg)) {
        skips.push(`${view.accountId} arm ${d.armId} half-open probe occupied`);
        continue;
      }
      const reason = `deferral-exhausted: ${priorReason} -> ${d.accountId}/${d.armId ?? d.model}`;
      const emitAdapter = params?.adapterType ?? liveAdapterFor(live, params?.agentId) ?? null;
      const decorated = decoratedModelFor(d, emitAdapter);
      clearDeferred(companyId, params.runId);
      clearExhaustionStreak(companyId, params);
      recordDecision(hookLedger, {
        runId: String(params.runId ?? 'unknown'),
        agentId: String(params.agentId ?? 'unknown'),
        accountId: d.accountId,
        armId: d.armId ?? null,
        effort: d.effort ?? null,
        enforced: true,
        wouldModel: decorated ?? `${d.model}(${d.effort ?? 'default'})`,
        rung: d.rung,
        trial: d.trial === true,
        family: inferFamily(canonicalModelName(d.model)),
        reason,
      }, nowMs);
      return {
        answer: {
          kind: 'decide',
          decisionId: d.decisionId,
          model: decorated ?? d.model,
          effort: d.effort,
          env: d.env,
          source: d.source,
          reason,
        },
      };
    }
    if (live.taskRanking?.mode === 'enforce') {
      // The hook does not receive the configured default effort. Proving a
      // sibling effort cannot authorize keep (or caps-only decide) on that
      // unknown binding after every explicit feasible decision was refused.
      skips.push('bounded default keep unavailable: task ranking requires an explicit admitted model-effort decision');
      return fail();
    }
    // No selectable arm: a bounded keep on the agent default model, but only
    // when its serving account passes the same hard admission gates as a
    // candidate. Pace-pool and 5h headroom holds remain the only relaxations.
    // An exhausted, held-only, excluded, or unmapped default keeps deferring:
    // strand the card rather than burn an exhausted pool or held quota.
    const defModel = params?.agentDefaultModel;
    if (typeof defModel === 'string' && defModel.trim().length > 0) {
      const canon = String(canonicalModelName(defModel) ?? '').toLowerCase();
      let serving = null;
      let heldOnly = false;
      if (canon) {
        for (const a of live?.accounts ?? []) {
          const accountId = a?.accountId;
          if (typeof accountId !== 'string' || accountId.length === 0) continue;
          if (managedFreeAccount(live, companyId, a)) continue;
          if (a.health !== 'healthy' && a.health !== 'degraded') continue;
          if (a.health === 'healthy' && a.action === 'excluded') continue;
          const hasDefault = liveLadderArms(a).some((x) => x != null
            && String(canonicalModelName(x.model) ?? '').toLowerCase() === canon);
          if (!hasDefault) continue;
          // Reserve quota is for review runs: a non-review keep must not
          // spend a held account, even at exhaustion.
          if (heldIds.has(accountId)) { heldOnly = true; continue; }
          const ahead = !a.reactive && a.burn !== true && a.planAhead != null && a.planAhead > margin;
          if (ahead || (!a.reactive && !a.remainingKnown)
            || (!a.reactive && a.headroomSource === 'weekly')) continue;
          if (a.reactive
            && (capBase.get(accountId) ?? 0) + (acctPending.get(accountId) ?? 0) >= liveTrialInflightCapFor(live, a)) continue;
          const roleRungs = filterRungsByExcludedFamilies(
            filterBreakerRungs(credentialGroupsFor(a, nowMs, credentialReadinessEnforced(companyId), role, null,
              taskRunAdmission({ ...inputsFor(a), fiveHourHeadroomPct: null }, bstore, nowMs, bcfg)), bstore, accountId, nowMs, bcfg),
            roleExcluded,
          );
          if (!rungsHaveEligibleArms(roleRungs)
            || !roleLadderAccess(roleRungs, {
              role, roleBands: live.roleBands, excludedFamilies: roleExcluded, trialRoles,
            }).eligible) continue;
          const defaultRungs = roleRungs.map(group => ({
            ...group,
            arms: (group.arms ?? []).filter(arm => arm != null
              && String(canonicalModelName(arm.model) ?? '').toLowerCase() === canon),
          }));
          if (!rungsHaveEligibleArms(defaultRungs)) continue;
          const d = decide({
            runId: params.runId,
            agentId: params.agentId,
            role,
            ladderRungs: defaultRungs,
            excludedFamilies: roleExcluded,
            pointer: a.pointer ?? 0,
            retryCount: 0,
            failureClass: 'none',
            contextTokens: null,
            // A bounded keep intentionally ignores the transient 5h hold;
            // the account still had to prove known metered headroom above.
            fiveHourHeadroomPct: null,
            burnPerRunPct: a.burnPerRunPct ?? {},
            reservePct: 0,
            accountId,
            roleBands: live.roleBands,
            contextCaps: live.contextCaps,
            adapterType: adapter,
            trialBudget: budget,
            trialAdapters,
            trialRoles,
            taskRanking: live.taskRanking,
          });
          if (d.kind !== 'decide' || !decisionCredentialReady(d, defaultRungs, companyId)) continue;
          if (d.armId != null && params?.runId != null
            && breakerState(bstore, d.accountId, d.armId, nowMs, bcfg) === 'half-open'
            && !startProbe(bstore, d.accountId, d.armId, params.runId, nowMs, bcfg)) continue;
          const arm = defaultRungs.flatMap(group => group.arms ?? [])
            .find(item => item.armId === d.armId) ?? null;
          serving = { account: a, arm };
          break;
        }
      }
      if (serving) {
        const reason = `deferral-exhausted: ${priorReason} -> kept ${defModel}`;
        recordDecision(hookLedger, {
          runId: String(params?.runId ?? 'unknown'),
          agentId: String(params?.agentId ?? 'unknown'),
          accountId: serving.account.accountId,
          armId: serving.arm?.armId ?? null,
          enforced: false,
          wouldModel: defModel,
          family: serving.arm?.family ?? inferFamily(canonicalModelName(defModel)),
          reason,
        }, nowMs);
        clearDeferred(companyId, params?.runId);
        clearExhaustionStreak(companyId, params);
        return { answer: keptCapsAnswer(params, live, `deferral-exhausted: ${priorReason}; kept`) ?? { kind: 'keep' } };
      }
      if (heldOnly) skips.push(`default model ${defModel} serves only from review-reserve held accounts`);
      else skips.push(`default model ${defModel} has no safe serving account`);
    } else {
      skips.push('no agent default model to keep');
    }
    return fail();
  }

  /**
   * Reviewer routing in the hook (memory-only apart from the ledger join).
   * Returns a decide answer, or null when routing is off for the agent, the
   * snapshot is stale, or no arm qualifies (the caller keeps / routes as
   * before). The outcome is remembered for /capacity reviewer.routing.last.
   */
  async function routeReviewerRun(params, live) {
    const cfg = live?.reviewerRouting;
    if (!cfg || !Array.isArray(cfg.agentIds) || !cfg.agentIds.includes(params?.agentId)) return null;
    const companyId = params.companyId;
    const fallback = Array.isArray(live.keepAgentIds) && live.keepAgentIds.includes(params?.agentId) ? 'keep' : 'route';
    const note = (out) => {
      reviewerRouteLast.set(companyId, {
        atMs: clock(), runId: params?.runId != null ? String(params.runId) : null,
        agentId: params?.agentId ?? null, ...out,
      });
    };
    if (!Number.isFinite(live.atMs) || clock() - live.atMs > 120000 || clock() < live.atMs) {
      note({ routed: false, fallback, reason: `routing snapshot stale: ${fallback}` });
      return null;
    }
    const ledger = await getOrLoadLedger(companyId);
    if (!enforceCompanies.has(companyId)) return null;
    if (!liveIsCurrent(companyId, live)) return invalidatedDefer(params, live);
    if (!taskModeCompatible(live, companyId)) return { kind: 'defer', retryAfterMs: 20000, reason: 'task ranking configuration changed; awaiting the next native tick' };
    const nowMs = clock();
    const selfId = params?.runId != null ? String(params.runId) : null;
    // Reviewer runs obey the pace guard like every other run: lanes the guard
    // holds right now (ahead of plan, pool at its cap) are not candidates.
    const role = roleOf({ roles: { thinkerAgentIds: live.thinkerAgentIds, doerAgentIds: live.doerAgentIds } }, params.agentId);
    const paced = live.paceGuard?.enabled === true
      ? (allocationOrderFromLive(live, companyId, selfId, role,
        normalizeExcludedFamilies(live.excludeFamilies?.[role] ?? []), true, true).paced ?? [])
      : [];
    const pacedIds = new Set(paced.flatMap(p => p.pacedAccountIds ?? []));
    const { pick, admissionOf } = pickReviewerRoute(live, companyId, params.agentId, selfId, nowMs, pacedIds);
    if (pick.none) {
      // Only the pace guard stood in the way: wait for a run to finish instead
      // of falling back to keep, which would run on the held lane unpaced.
      if (pacedIds.size > 0 && !pickReviewerRoute(live, companyId, params.agentId, selfId, nowMs).pick.none) {
        const retryAfterMs = live.paceGuard?.retryAfterMs ?? 300000;
        markDeferred(companyId, params.runId, clock(), live.staleHorizonMs ?? 2 * 3600 * 1000, retryAfterMs);
        const reason = `pace guard: reviewer lanes held (${paced.map(pacedPoolText).join('; ')})`;
        note({ routed: false, deferred: true, reason });
        return { kind: 'defer', retryAfterMs, reason };
      }
      if (live.taskRanking?.mode === 'enforce') {
        const reason = `no approved reviewer arm available: ${pick.reason}`;
        note({ routed: false, deferred: true, reason });
        return { kind: 'defer', retryAfterMs: 20000, reason };
      }
      note({ routed: false, fallback, reason: `${pick.reason}: ${fallback}` });
      return null;
    }
    const arm = pick.arm;
    // Same caps env decide() would emit for this arm (0.2.61 returned
    // `env: {}`, so a review routed to Sol/Luna ran under the reviewer's
    // base-config window, e.g. a Muse-sized one).
    const { match, emitModel, env } = reviewerPickEmission(live, pick, admissionOf);
    const adapter = params.adapterType ?? liveAdapterFor(live, params.agentId) ?? null;
    const decorated = decoratedModelFor({ model: emitModel, effort: arm.effort, contextWindow: match?.contextWindow ?? null }, adapter);
    const model = decorated ?? emitModel;
    clearDeferred(companyId, params.runId);
    recordDecision(ledger, {
      runId: String(params.runId ?? 'unknown'),
      agentId: String(params.agentId ?? 'unknown'),
      accountId: pick.accountId,
      armId: match?.armId ?? null,
      effort: arm.effort ?? null,
      enforced: true,
      wouldModel: decorated ?? `${emitModel}(${arm.effort ?? 'default'})`,
      rung: match?.rung ?? null,
      family: inferFamily(canonicalModelName(arm.model)),
      reason: pick.reason,
    }, nowMs);
    note({
      routed: true, provider: pick.provider, arm: { ...arm }, accountId: pick.accountId,
      burn: pick.burn, poolPlanAhead: pick.poolPlanAhead, reason: pick.reason, env: { ...env },
      ...(live.taskRanking?.mode === 'enforce' ? { primary: pick.primary, fallbackReason: pick.fallbackReason, evidenceTrust: pick.evidenceTrust } : {}),
    });
    const sanitize = (x) => String(x).replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 80) || 'x';
    const out = {
      kind: 'decide',
      decisionId: `mc-${sanitize(params.runId ?? 'unknown')}-${sanitize(pick.accountId)}-review-${sanitize(arm.model)}`,
      model,
      env,
      source: 'model-capacity',
      reason: pick.reason,
    };
    if (arm.effort != null) out.effort = arm.effort;
    return out;
  }

  // A pinned agent's run, counted on the account serving its configured
  // model (published by the last tick). Not enforced and no arm: the
  // breaker and trial accounting ignore it; decisionsSinceTick counts it.
  async function recordKeptDecision(companyId, live, runId, agentId) {
    const kept = live?.keptByAgent?.[agentId];
    if (!kept || runId == null) return;
    const ledger = await getOrLoadLedger(companyId);
    if (!liveIsCurrent(companyId, live)) return;
    recordDecision(ledger, {
      runId: String(runId), agentId: String(agentId ?? 'unknown'), accountId: kept.accountId,
      armId: null, enforced: false, wouldModel: kept.model,
      family: inferFamily(canonicalModelName(kept.model)),
      reason: 'kept: agent pinned to its configured model (roles.keepAgentIds)',
    }, clock());
  }

  async function recordEventTimeShadow(companyId, run) {
    const live = liveViews.get(companyId);
    const config = lastConfig.get(companyId);
    if (!live || !config || !liveIsCurrent(companyId, live) || !taskModeCompatible(live, companyId)) return null;
    const credentialEnforced = credentialReadinessEnforced(companyId);
    if (!Number.isFinite(live.atMs) || clock() - live.atMs > 120000
      || (credentialEnforced && clock() < live.atMs)) {
      if (credentialEnforced) credentialDefer(companyId, 'routing snapshot stale or invalid');
      return null;
    }
    // Already covered: the hook (or an earlier event) decided this runId.
    // The decision lives in the ledger -- one record per runId, first
    // decision wins -- so recording again would double-count the run in
    // pool pressure and trial use.
    if (run?.runId != null) {
      if (ledgers.get(companyId)?.get(String(run.runId))?.decidedAccount != null) return null;
    }
    if (configuredTaskReviewer(live, run?.agentId)) {
      const ledger = await getOrLoadLedger(companyId);
      if (!liveIsCurrent(companyId, live) || !taskModeCompatible(live, companyId)) return null;
      const role = roleOf(config, run.agentId);
      const paced = allocationOrderFromLive(live, companyId, run.runId, role,
        normalizeExcludedFamilies(live.excludeFamilies?.[role] ?? []), true, true, run).paced;
      const held = new Set(paced.flatMap(p => p.pacedAccountIds ?? []));
      return recordReviewerShadow(ledger, live, companyId, run,
        pickReviewerRoute(live, companyId, run.agentId, run.runId, clock(), held), true);
    }
    // Pinned agents never get a routed decision: record the kept model so the
    // run counts against its serving account before the next tick.
    if (Array.isArray(live.keepAgentIds) && live.keepAgentIds.includes(run?.agentId)) {
      await recordKeptDecision(companyId, live, run?.runId, run?.agentId);
      return null;
    }
    // Await before admission, not between selection and recording.
    const ledger = await getOrLoadLedger(companyId);
    if (!liveIsCurrent(companyId, live)) return null;
    const role = roleOf(config, run.agentId);
    const roleExcluded = normalizeExcludedFamilies(live.excludeFamilies?.[role] ?? []);
    const { order } = withDuplicatePass(duplicates => allocationOrderFromLive(
      live, companyId, null, role, roleExcluded, duplicates, liveIsReviewAgent(live, run.agentId), run,
    ));
    // Per-account cap inputs: the live view's per-account in-flight plus
    // queued decisions per account. The pooled inFlight on the ordered
    // views drives ordering only -- comparing the pool total against the
    // per-account cap starves multi-lane providers.
    const capBase = new Map((live.accounts ?? []).map(a => [a.accountId, a.inFlight ?? 0]));
    const acctPending = pendingByAccount(live, companyId);
    const budget = effectiveTrialBudget(live, companyId);
    for (const view of order) {
      if (!view || !view.ladderRungs || view.ladderRungs.length === 0) continue;
      if (!view.reactive && !view.remainingKnown) continue;
      // Provider-scoped reactive cap (nvidia-nim 1, others on the global).
      if (view.reactive && (capBase.get(view.accountId) ?? 0) + (acctPending.get(view.accountId) ?? 0) >= liveTrialInflightCapFor(live, view)) continue;
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
        taskRanking: live.taskRanking,
      });
      if (d.kind !== 'decide') continue;
      const emitAdapter = run.adapterType ?? liveAdapterFor(live, run.agentId) ?? null;
      // The pending load was joined before selection; the next tick
      // persists this record. actualPending until a tick backfills it.
      if (!decisionCredentialReady(d, roleRungs, companyId)) continue;
      recordDecision(ledger, {
        runId: String(run.runId ?? 'unknown'),
        agentId: String(run.agentId ?? 'unknown'),
        accountId: d.accountId,
        armId: d.armId ?? null,
        effort: d.effort ?? null,
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
    if (credentialReadinessEnforced(companyId)
      && !(live.accounts ?? []).some(a => rungsHaveEligibleArms(credentialGroupsFor(a, clock(), true)))) {
      credentialDefer(companyId);
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
    const previousTimestamp = Date.parse(previous.fetchedAt ?? '');
    const previousSnapshotAgeHours = Number.isFinite(previousTimestamp) ? Math.max(0, (clock() - previousTimestamp) / 3600000) : null;
    const apiKey = await ctx.secrets.resolve(config.aa.apiKeySecretRef, { companyId, configPath: 'aa.apiKeySecretRef' });
    const [fetched, board] = await Promise.all([
      fetchAaFreeList({ http: ctx.http, apiKey }),
      fetchAaLeaderboard({ http: ctx.http }),
    ]);
    const parsed = fetched.ok && fetched.text ? parseAaFreeList(fetched.text) : null;
    const priorVersion = previous.intelligenceIndexVersion;
    const currentVersion = parsed?.intelligenceIndexVersion;
    const major = v => String(v).split('.')[0];
    const versionMismatch = priorVersion != null && currentVersion != null && major(priorVersion) !== major(currentVersion);
    if (!parsed) {
      const error = fetched.error ?? 'aa-parse-failed';
      const freshBoard = board.ok && board.html ? parseAaLeaderboardHtml(board.html) : null;
      const patch = {};
      if (freshBoard?.length) {
        // The leaderboard carries no provable index generation when the API failed.
        // Only exact-evaluation benchmarks can safely update the old generation.
        const boardRows = stampAaObservations(freshBoard.map(row => Object.fromEntries(
          Object.entries(row).filter(([key]) => key === 'slug' || BENCHMARK_FIELDS.includes(key))
        )), nowIso, 'public-leaderboard');
        const priorRows = stampAaObservations(previous.rows ?? [], previous.fetchedAt ?? null, 'previous-snapshot');
        const merged = mergeAaRows(priorRows, boardRows);
        patch.rows = markStaleBenchmarks(merged.rows, nowIso);
        // Preserve the full source separately; only benchmark fields enter the
        // current generation until the API version can be established.
        patch.leaderboardRows = stampAaObservations(freshBoard, nowIso, 'public-leaderboard');
        patch.leaderboardSlugs = merged.leaderboardSlugs;
        patch.leaderboardAt = nowIso;
      }
      await ctx.state.set(scopeKey(companyId, AA_KEY), { ...previous, ...patch, lastAttemptAt: nowIso, lastError: error });
      ctx.logger.error('model-capacity: AA API refresh failed; retaining previous API freshness', { companyId, error, previousSnapshotAgeHours, cachedRows: previous.rows?.length ?? 0 });
      return { companyId, status: 'error', error, previousSnapshotAgeHours, cachedRows: previous.rows?.length ?? 0 };
    }
    // A new major is a fresh generation: never blend prior API, leaderboard or carried evidence.
    const compatiblePrevious = versionMismatch ? {} : previous;
    // Second source is best-effort but NEVER zeroing: a leaderboard fetch
    // or parse failure keeps the PREVIOUS snapshot's raw leaderboard layer
    // (2026-10-17: a parse failure stored API-only rows with
    // leaderboardSlugs [] and every ladder lost its arms). The raw layer
    // is persisted separately on success (`leaderboardRows`) so the keep
    // path overlays leaderboard-only rows -- never the previous MERGED
    // rows, whose stale API values would win every non-null field. The
    // keep path also merges gap-fill only: fresh API values always win,
    // the stale layer only supplies fields the API left null. Snapshots
    // stored before the raw layer existed fall back to their merged rows
    // filtered to the leaderboard slugs, still gap-fill only, until the
    // first successful refresh stores the raw layer.
    let leaderboardRows = [];
    let leaderboardError = null;
    if (!board.ok || !board.html) {
      leaderboardError = board.error ?? 'aa-leaderboard-fetch-failed';
    } else {
      const boardParsed = parseAaLeaderboardHtml(board.html);
      if (!boardParsed) {
        leaderboardError = 'aa-leaderboard-parse-failed';
      } else {
        leaderboardRows = stampAaObservations(boardParsed, nowIso, 'public-leaderboard');
      }
    }
    const prevSlugs = Array.isArray(compatiblePrevious.leaderboardSlugs) ? compatiblePrevious.leaderboardSlugs : [];
    const prevRows = Array.isArray(compatiblePrevious.rows) ? compatiblePrevious.rows : [];
    const prevLeaderboardRows = (Array.isArray(compatiblePrevious.leaderboardRows) ? compatiblePrevious.leaderboardRows : [])
      .filter(r => r && typeof r.slug === 'string');
    const keptRows = prevLeaderboardRows.length > 0
      ? prevLeaderboardRows
      : prevRows.filter(r => r && typeof r.slug === 'string' && prevSlugs.includes(r.slug));
    const freshApiRows = stampAaObservations(parsed.rows, nowIso, 'free-api');
    const datedKeptRows = stampAaObservations(keptRows, compatiblePrevious.leaderboardAt ?? compatiblePrevious.fetchedAt ?? null, 'public-leaderboard');
    let merged;
    let leaderboardAt;
    let keptPreviousLeaderboard = false;
    if (leaderboardError) {
      if (keptRows.length > 0) {
        merged = mergeAaRowsGapFill(freshApiRows, datedKeptRows);
        keptPreviousLeaderboard = true;
      } else {
        merged = mergeAaRows(freshApiRows, []);
      }
      // Never store an empty leaderboardSlugs over a non-empty one: when the
      // previous snapshot has slugs but its rows are gone (pruned state),
      // keep the slug list so downstream guards see continuity.
      if (merged.leaderboardSlugs.length === 0 && prevSlugs.length > 0) {
        merged = { ...merged, leaderboardSlugs: [...prevSlugs] };
        keptPreviousLeaderboard = true;
      }
      leaderboardAt = compatiblePrevious.leaderboardAt ?? null;
    } else {
      merged = mergeAaRows(freshApiRows, leaderboardRows);
      if (merged.leaderboardSlugs.length === 0 && prevSlugs.length > 0) {
        if (keptRows.length > 0) {
          merged = mergeAaRowsGapFill(freshApiRows, datedKeptRows);
        } else {
          merged = { ...merged, leaderboardSlugs: [...prevSlugs] };
        }
        keptPreviousLeaderboard = true;
        leaderboardError = 'aa-leaderboard-empty-kept-previous';
      }
      leaderboardAt = leaderboardRows.length > 0 && !keptPreviousLeaderboard
        ? nowIso
        : (compatiblePrevious.leaderboardAt ?? null);
    }
    // Cost carry (2026-10-22): a refresh can keep every row but drop the cost
    // fields for some slugs -- the leaderboard check passes, so the keep path
    // above never fires, yet every null-cost arm loses its ladder rungs.
    // Carry the last known cost and prices forward per slug from the previous
    // snapshot's merged rows (fresh values always win; carried rows are marked
    // costCarriedFrom). The raw layer below stays raw: the next refresh
    // carries from these merged rows again.
    const carriedRows = markStaleBenchmarks(carryForwardCosts(carryForwardBenchmarks(merged.rows, prevRows, compatiblePrevious.fetchedAt), prevRows, compatiblePrevious.fetchedAt ?? 'previous-snapshot'), nowIso);
    const carriedSlugs = carriedRows.filter(r => r?.costCarriedFrom != null).map(r => r.slug);
    const carriedTimes = carriedRows.flatMap(row => [
      ...Object.keys(row.staleBenchmarkFields ?? {}).map(field => row.fieldObservedAt?.[field]),
      ...Object.values(row.costFieldObservedAt ?? {}),
    ]).map(value => Date.parse(value ?? '')).filter(Number.isFinite);
    const oldestCarriedAgeHours = carriedTimes.length ? Math.max(0, (clock() - carriedTimes.reduce((earliest, time) => Math.min(earliest, time), Infinity)) / 3600000) : null;
    const coverage = { totalRows: carriedRows.length, configuredArms: resolveArms(carriedRows, config.armMap).arms.length, benchmarkRows: carriedRows.filter(row => ['scicode', 'terminalbenchV40', 'hle', 'lcr', 'ifbench', 'gpqa'].some(field => row[field] != null)).length, carriedBenchmarkRows: carriedRows.filter(row => Object.keys(row.staleBenchmarkFields ?? {}).length > 0).length };
    const refreshSummary = { pagesFetched: fetched.pagesFetched, previousSnapshotAgeHours, oldestCarriedAgeHours, coverage };
    // The raw layer carried into the next snapshot: freshly parsed rows on
    // success, the kept layer on failure (never the merged rows).
    const storedLeaderboardRows = keptPreviousLeaderboard ? datedKeptRows : leaderboardRows;
    await ctx.state.set(scopeKey(companyId, AA_KEY), {
      fetchedAt: nowIso,
      intelligenceIndexVersion: parsed.intelligenceIndexVersion,
      pagesFetched: fetched.pagesFetched,
      refreshSummary,
      rows: carriedRows,
      duplicateSlugs: merged.duplicateSlugs,
      leaderboardSlugs: merged.leaderboardSlugs,
      leaderboardRows: storedLeaderboardRows,
      leaderboardAt,
      lastAttemptAt: nowIso,
      lastError: null,
      lastLeaderboardError: leaderboardError,
      ...(keptPreviousLeaderboard ? { leaderboardKeptFromPrevious: true } : {}),
    });
    ctx.logger.info('model-capacity: AA refresh summary', { companyId, ...refreshSummary });
    if (leaderboardError) {
      ctx.logger.error('model-capacity: AA leaderboard failed; kept prior leaderboard rows', {
        companyId, leaderboardError, keptPreviousLeaderboard,
        rows: merged.rows.length, leaderboardSlugs: merged.leaderboardSlugs.length,
      });
    } else {
      ctx.logger.info('model-capacity: AA snapshot refreshed', {
        companyId, rows: merged.rows.length, leaderboardRows: leaderboardRows.length, leaderboardError,
      });
    }
    if (carriedSlugs.length > 0) {
      ctx.logger.error('model-capacity: AA refresh dropped cost fields; carried forward from previous snapshot', {
        companyId, carriedSlugs,
      });
    }
    return {
      companyId, status: 'ok', rows: carriedRows.length, pagesFetched: fetched.pagesFetched, previousSnapshotAgeHours, oldestCarriedAgeHours,
      coverage,
      leaderboardRows: storedLeaderboardRows.length,
      leaderboardError, keptPreviousLeaderboard,
      costCarriedSlugs: carriedSlugs,
    };
  }

  const plugin = {
    multiCompanyConfig: true,

    // Slice 4 must call this synchronously at decision time, never retain a
    // tick's config as the authority for operator-verified pool metadata.
    getRouterConfig(companyId) {
      return routerConfigFor(companyId);
    },

    onRouteAiConnection(params) { return routeConnection(params); },

    async setup(context) {
      ctx = context;
      routeConnection = createRouterAdapter({getConfig:routerConfigFor,getSnapshot:id=>quotaRefresh?.get(id),
        getPolicy:id=>{const live=liveViews.get(id);return liveIsCurrent(id,live) ? live?.routerPolicy : null;},
        getOverlay:(id,version)=>nativeOverlay.deltas(id,version),getOverlayStatus:id=>nativeOverlay.status(id),
        logger:ctx.logger,
      });
      quotaRefresh = createQuotaRefresh({state:ctx.state,logger:ctx.logger,clock,inspectPools,
        captureOverlay:id=>nativeOverlay.capture(id),onPublished:(id,snapshot,checkpoint)=>nativeOverlay.publish(id,snapshot.version,checkpoint,snapshot.inFlightRunAccounts),
        keyFor:companyId => scopeKey(companyId, 'router-quota-v1'),
        listAgents:async companyId => {
          const agents=[];
          for(let offset=0;offset<10_000;offset+=200) {
            const rows=await ctx.agents.list({companyId,limit:200,offset});
            if(!Array.isArray(rows))throw new Error('invalid agents list');
            agents.push(...rows);
            if(rows.length<200)return agents;
          }
          throw new Error('agents list exceeds quota inspection bound');
        },
      });
      ctx.jobs.register('aa-refresh', async job => {
        const results = await Promise.allSettled([...configured].sort().map(companyId => runAaRefresh(companyId)));
        if (results.some(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value?.status === 'error'))) throw new Error('aa-refresh-failed');
        return results.map(r => r.value);
      });
      ctx.jobs.register('quota-refresh', async job => {
        const results = await Promise.allSettled([...configured].sort().map(async companyId => {
          try {
            await runQuotaTick(companyId, job);
          } catch (error) {
            // Fetch/native failures were already classified and rate-limited.
            // Unknown legacy tick failures never log raw upstream exception text.
            if (!/^(cliproxy-|quota-fetch-failed|native-quota-failed)/.test(error?.message ?? '')) {
              quotaRefresh.failure(companyId, 'quota-refresh-failed', 'model-capacity: shadow tick failed');
            }
            throw error;
          } finally {
            await runClusterMaintenance(companyId);
          }
        }));
        if (results.some(r => r.status === 'rejected')) throw new Error('quota-refresh-failed');
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
          clearDeferred(companyId, entry.runId);
        }
        // Only observed run models attribute native pressure. Never use a
        // callback guess, agent default or a synthetic shadow decision. Current
        // upstream lifecycle events omit account/model metadata; expose those
        // runs as unattributed rather than fabricating an R2 guarantee.
        const observed = evtLedger.get(entry.runId);
        const model = entry.model ?? (observed?.actualModelSource === 'run-decision' ? observed.actualModel : null);
        nativeOverlay.observe(companyId,{runId:entry.runId,status,
          accountKey:accountKeyForModel(model,lastConfig.get(companyId)?.router?.accounts ?? []),
        });
        const st = runEventStats.get(companyId) ?? { seen: 0, lastAtMs: null, lastRunId: null };
        st.seen += 1;
        st.lastAtMs = entry.at;
        st.lastRunId = entry.runId;
        runEventStats.set(companyId, st);
        // Alert-only failure-cluster ingest (failed events only, opt-in
        // only). Contained: a cluster failure must never break the ledger
        // or the event-time shadow path above.
        if (status === 'failed' && lastConfig.get(companyId)?.failureClusterAlert?.enabled === true) {
          try {
            await chainCluster(companyId, () => updateFailureClusters({
              ctx,
              companyId,
              alert: lastConfig.get(companyId).failureClusterAlert,
              nowMs: clock(),
              event,
              stateKey: scopeKey,
            }));
          } catch (error) {
            ctx.logger.error('model-capacity: failure-cluster ingest failed', { companyId, error: error?.message ?? String(error) });
          }
        }
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
        attestedPools.set(companyId, noAttestedPools);
        ctx.logger.error('model-capacity: config rejected', { companyId, errors });
        throw new Error('invalid-config');
      }
      const config = resolveConfig(raw);
      rememberConfig(companyId, config);
      configured.add(companyId);
      configGenerations.set(companyId, configGenerationOf(companyId) + 1);
      readReviewDemand.invalidate(companyId);
      blockingPriorityCache.delete(companyId);
      priorityReadyCache.delete(companyId);
      if (config.allocation.blockingPriority !== lastConfig.get(companyId)?.allocation?.blockingPriority) {
        queuedCache.delete(companyId);
      }
      taskRankingModes.set(companyId, config.taskRanking.mode);
      freeLaneConfigs.set(companyId, config.freeLanes);
      // Enforcement switches retain their established immediate-disable /
      // next-compatible-tick-enable semantics, independent of policy identity.
      attestedPools.set(companyId, config.router
        ? Object.freeze(normalizeRegistry(config.router).pools.filter(p=>p.poolId)) : noAttestedPools);
      lastConfig.set(companyId, config);
      if (raw?.enforce === true) enforceCompanies.add(companyId);
      else enforceCompanies.delete(companyId);
      if (raw?.credentialReadiness?.enforce === true) credentialEnforceCompanies.add(companyId);
      else credentialEnforceCompanies.delete(companyId);
      // setup has no company-scoped config until this native lifecycle call.
      // Start asynchronously so worker readiness never waits for the quota feed.
      if (config.router) void runQuotaTick(companyId, {trigger:'config'}).catch(() => {});
    },

    async onValidateConfig(raw) {
      const errors = validateConfigShape(raw);
      return errors.length === 0 ? { ok: true } : { ok: false, errors };
    },

    async onHealth() {
      const enforcing = [...enforceCompanies].filter(c => configured.has(c)).length;
      // A build that did not pin a real lane host cannot read the feed.
      const laneHostPinned = !isPlaceholderLaneHost();
      const baseStatus = configured.size === 0 || !laneHostPinned ? 'degraded' : 'ok';
      const baseMessage = !laneHostPinned
        ? 'Lane host not pinned by this build (public placeholder); lane reads cannot succeed.'
        : enforcing > 0
          ? `Enforcing run models for ${enforcing} of ${configured.size} companies; the rest stay shadow.`
          : 'Shadow only; no runs are changed.';
      const baseDetails = { configuredCompanies: configured.size, enforcingCompanies: enforcing, laneHostPinned, manifest: manifest.id };
      // Failure-cluster health (opt-in companies only): error while any
      // cluster is active or an alert write is failing. Best-effort reads:
      // an unreadable company is skipped, never fatal to health itself.
      let clusters = null;
      if (ctx && typeof ctx.state?.get === 'function') {
        try {
          clusters = await summarizeFailureClusters();
        } catch {
          clusters = null;
        }
      }
      if (clusters !== null) baseDetails.failureClusters = clusters.summary;
      if (clusters !== null && (clusters.activeTotal > 0 || clusters.writeErrors > 0)) {
        const parts = [];
        if (clusters.activeTotal > 0) parts.push(`${clusters.activeTotal} failure cluster${clusters.activeTotal === 1 ? '' : 's'} active`);
        if (clusters.writeErrors > 0) parts.push(`${clusters.writeErrors} alert write${clusters.writeErrors === 1 ? '' : 's'} failing`);
        return { status: 'error', message: `${parts.join('; ')}. ${baseMessage}`, details: baseDetails };
      }
      return { status: baseStatus, message: baseMessage, details: baseDetails };
    },

    async onApiRequest(input) {
      const companyId = input.companyId;
      if (!configured.has(companyId)) return { status: 404, body: { error: 'company-not-configured' } };
      if (input.routeKey === 'capacity') {
        const body = (await ctx.state.get(scopeKey(companyId, CAPACITY_KEY))) ?? { target: null };
        const verifiedPools = (attestedPools.get(companyId) ?? noAttestedPools).map(
          ({poolKey,poolId,pluginKey,expectedRevision,expectedMemberOrder,members}) =>
            ({poolKey,poolId,pluginKey,expectedRevision,expectedMemberOrder,members}));
        return { status: 200, body: lastConfig.get(companyId)?.router
          ? {...body,nativeRouter:{...quotaRefresh.status(companyId),...nativeOverlay.status(companyId),verifiedPools}} : body };
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
        const generation = configGenerationOf(companyId);
        const resolved = lastConfig.get(companyId);
        const cap = (await ctx.state.get(scopeKey(companyId, CAPACITY_KEY))) ?? {};
        const atMs = cap.atMs ?? null;
        const calibration = cap.calibration ?? 'weak';
        const target = cap.target ?? null;
        const paidTarget = cap.freeLanes ? cap.paidTarget : target;
        // Weak calibration means no target at all: no caps, never zeros
        // masquerading as a recommendation.
        const freeRunningFloor = cap.freeLanes && Object.values(cap.agentRunning ?? {}).some(r => r.freeRunning > 0);
        if ((target == null || calibration === 'weak') && !(cap.freeLanes?.target > 0) && !freeRunningFloor) {
          return { status: 200, body: { atMs, calibration, target: null, agents: [] } };
        }
        // Agents with queued/ready work: assigned non-terminal issues
        // (todo + in_progress), grouped by assignee and weighted by count.
        // issues.read is already declared; any denial degrades to no
        // recommendation instead of failing the request.
        const priorityRequested = lastConfig.get(companyId)?.allocation?.blockingPriority === true;
        let counts, priorities = null;
        try {
          if (priorityRequested) ({ counts, priorities } = await blockingSnapshot(companyId, atMs));
          // An unavailable graph keeps the ordinary demand TTL as well as the
          // legacy allocator. Only usable metadata pins counts to the tick.
          if (!priorityRequested || priorities == null) counts = await queuedByAgent(companyId, clock());
        } catch (error) {
          // Sanitized: callers get a stable code, never upstream text.
          // Details go server-side only.
          ctx.logger.error('model-capacity: caps issues read failed', { companyId, error: error?.message ?? String(error) });
          return { status: 200, body: { atMs, calibration, target, agents: [], capsError: 'issues-unavailable' } };
        }
        // Demand-aware caps: C* splits across agents in proportion to
        // CURRENT demand (running + queued), never historical share. Below
        // the target every agent covers its full demand; every shed is
        // running-first (at/above target the fleet starts nothing new). No
        // cap lands below an agent's running count -- throttling existing
        // runs while the fleet idles is the failure this replaces.
        const blockingPriority = priorityRequested && priorities != null;
        const runningByAgent = cap.agentRunning ?? {};
        const keptIds = new Set(cap.keepAgentIds ?? Object.keys(cap.keptByAgent ?? {}));
        // Review identities do not depend on model routing: fixed-model
        // reviewers receive the census too, but can use only their own pool.
        const reviewIds = reviewAgentIdsFor(resolved);
        const routedReviewIds = new Set(resolved?.reviewerRouting?.agentIds ?? []);
        const heartbeatIds = new Set([...keptIds, ...reviewIds]);
        const heartbeat = await queuedHeartbeatsByAgent(companyId, clock());
        const admissionAgeMs = Number.isFinite(atMs) ? clock() - atMs : Infinity;
        const reviewAdmissionFresh = admissionAgeMs >= 0 && admissionAgeMs <= 120_000
          && (cap.reviewAdmissionGeneration == null || cap.reviewAdmissionGeneration === generation)
          && (cap.reviewAdmissionGeneration == null || cap.reviewAdmissionEpoch === reviewAdmissionEpoch)
          && generation === configGenerationOf(companyId);
        const reviewDemandConfig = reviewIds.size > 0 ? resolved?.reviewDemand : null;
        const reviewDemand = reviewDemandConfig && !reviewAdmissionFresh
          ? { status: 'unavailable', eligibleHeads: 0, reason: 'review-admission-stale' }
          : await readReviewDemand(ctx, companyId, reviewDemandConfig);
        const agentIds = new Set([...counts.keys(), ...Object.keys(runningByAgent), ...reviewIds]);
        if (heartbeat.ok) {
          for (const agentId of heartbeat.counts.keys()) {
            if (heartbeatIds.has(agentId)) agentIds.add(agentId);
          }
        }
        const baseInputs = [...agentIds].map(agentId => ({
          agentId,
          running: runningByAgent[agentId]?.running ?? 0,
          queued: heartbeatIds.has(agentId)
            ? (heartbeat.ok ? (heartbeat.counts.get(agentId) ?? 0) : 0)
            : (counts.get(agentId) ?? 0),
          overPace: runningByAgent[agentId]?.overPace === true,
          ...(blockingPriority ? { allocationWeight: priorities.get(agentId)?.weight ?? 1 } : {}),
        }));
        const allocationInput = {
          target: paidTarget ?? 0,
          blockingPriority,
          maxTotal: cap.maxTotal ?? 75,
          demandFactor: cap.demandFactor ?? 1,
          keepAgentIds: [...keptIds],
          keptByAgent: cap.keptByAgent ?? {},
          accounts: cap.accounts ?? [],
          perAccount: cap.perAccount ?? [],
          pacePools: cap.paceGuard?.pools ?? [],
          unavailableAccountIds: cap.breakerUnavailableAccountIds ?? [],
          reviewerAccountIdsByAgent: Object.fromEntries([...routedReviewIds].map(id => [id,
            reviewAdmissionFresh && Array.isArray(cap.reviewerAccountIdsByAgent?.[id])
              ? cap.reviewerAccountIdsByAgent[id] : []])),
        };
        // Probe the SAME account/pool/fleet guards without committing slots.
        // Weight each once-only head share by usable post-heartbeat capacity:
        // empty admissions and spent pools cannot strand a sibling's backlog.
        const reviewShares = new Map();
        if (reviewDemand.eligibleHeads > 0) {
          const probe = allocateKeptAndRoutedCaps({ ...allocationInput, agents: baseInputs.map(a => ({ ...a,
            // Priority competition happens AFTER heads join demand. Letting
            // other queued work spend this feasibility probe can hide heads
            // before the real weighted split; all running still reserves room.
            queued: reviewIds.has(a.agentId) ? a.queued + reviewDemand.eligibleHeads : blockingPriority ? 0 : a.queued,
          })) });
          const queuedOf = new Map(baseInputs.map(a => [a.agentId, a.queued]));
          const funded = [...probe.kept, ...probe.routed].filter(a => reviewIds.has(a.agentId))
            .map(a => ({ id: a.agentId, slots: Math.max(0, a.allocated - a.running - queuedOf.get(a.agentId)) }))
            .filter(a => a.slots > 0);
          const slots = funded.reduce((sum, a) => sum + a.slots, 0);
          const shares = funded.map(a => ({ ...a, exact: reviewDemand.eligibleHeads * a.slots / slots }));
          for (const a of shares) reviewShares.set(a.id, Math.floor(a.exact));
          let remainder = reviewDemand.eligibleHeads - [...reviewShares.values()].reduce((sum, n) => sum + n, 0);
          shares.sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.id.localeCompare(b.id));
          for (const a of shares) {
            if (remainder-- <= 0) break;
            reviewShares.set(a.id, reviewShares.get(a.id) + 1);
          }
        }
        const capInputs = baseInputs.map(a => ({ ...a, queued: a.queued + (reviewShares.get(a.agentId) ?? 0) }));
        const demandSourceOf = new Map([...agentIds].map(agentId => [agentId,
          heartbeatIds.has(agentId) ? (heartbeat.ok ? 'heartbeat-runs' : 'heartbeat-runs-unavailable') : 'issues',
        ]));
        const allocated = allocateKeptAndRoutedCaps({ ...allocationInput, agents: capInputs });
        const keptCaps = allocated.kept;
        const unheld = allocated.routed;
        // Hysteresis (#3): wants follow the instantaneous queue, so served
        // caps fall on a half-life instead of tracking every dip (increases
        // pass at once; a cap under demand would throttle real work). The
        // hold state is advisory for routed agents; kept-agent pool ceilings
        // are hard and must not be smoothed upward.
        const nowMs = clock();
        let agents = [...keptCaps, ...unheld];
        try {
          const prevHold = (await ctx.state.get(scopeKey(companyId, CAPS_HOLD_KEY)))?.agents ?? {};
          const held = holdCaps(unheld, prevHold, nowMs, {
            halfLifeMs: (lastConfig.get(companyId)?.smoothing?.halfLifeMin ?? SMOOTHING_DEFAULTS.halfLifeMin) * 60000,
            staleMs: (lastConfig.get(companyId)?.smoothing?.staleHours ?? SMOOTHING_DEFAULTS.staleHours) * 3600000,
            ceiling: blockingPriority ? Math.min(allocated.routedCeiling,
              Math.max(0, Math.round(paidTarget) - keptCaps.reduce((sum, entry) => sum + entry.allocated, 0)))
              : allocated.routedCeiling,
          });
          agents = [...keptCaps, ...held.entries];
          if (generation === configGenerationOf(companyId)) {
            await ctx.state.set(scopeKey(companyId, CAPS_HOLD_KEY), { atMs: nowMs, agents: held.hold });
          }
        } catch (error) {
          ctx.logger.error('model-capacity: caps hold unavailable', { companyId, error: error?.message ?? String(error) });
        }
        // Reserved floors run LAST, after the allocator and the hold. Floors
        // suspend during fleet-wide breaker cooling, and a kept-agent floor
        // above its pool ceiling is blocked rather than violating pace.
        const reservedFloors = resolved?.caps?.reservedFloors ?? {};
        let floorsSuspended = false;
        let floorSummary = {};
        if (Object.keys(reservedFloors).length > 0) {
          try {
            const bstore = breakerStores.get(companyId) ?? createBreakerStore();
            floorsSuspended = breakerSuspendsFloors(bstore, nowMs, resolved?.breakers ?? DEFAULT_BREAKERS);
          } catch (error) {
            ctx.logger.error('model-capacity: caps breaker read failed', { companyId, error: error?.message ?? String(error) });
          }
          const blockedAgentIds = new Set(floorsSuspended ? Object.keys(reservedFloors) : []);
          // A configured floor cannot invent new slots or override the winner
          // of a scarce priority split. Report the conflict, never hide it.
          if (blockingPriority) {
            for (const agent of agents) {
              const floor = computeReservedFloor(agent.running, agent.queued, reservedFloors[agent.agentId]);
              if (floor != null && floor > agent.allocated) blockedAgentIds.add(agent.agentId);
            }
          }
          const inputsByAgent = new Map(capInputs.map(agent => [agent.agentId, agent]));
          for (const agent of keptCaps) {
            const spec = reservedFloors[agent.agentId];
            const input = inputsByAgent.get(agent.agentId);
            const floor = input ? computeReservedFloor(input.running, input.queued, spec) : null;
            const poolCeiling = allocated.keptCeilings.get(agent.agentId);
            if (floor != null && floor > poolCeiling) blockedAgentIds.add(agent.agentId);
          }
          const floored = applyReservedFloors(agents, {
            reservedFloors,
            ceiling: cap.maxTotal ?? 75,
            blockedAgentIds: [...blockedAgentIds],
          });
          agents = floored.entries;
          floorSummary = floored.floors;
        }
        if (cap.freeLanes) {
          const freeRunning = Object.fromEntries(Object.entries(runningByAgent).map(([id, r]) => [id, r.freeRunning ?? 0]));
          // Free running and headroom stay outside the paid allocation above.
          const freeEnabled = freeLaneConfigs.get(companyId)?.enabled === true;
          agents = freeLaneCaps(agents, freeRunning, freeEnabled ? cap.freeLanes.target : 0,
            freeEnabled ? safeFreeAgentIds(liveViews.get(companyId), companyId) : [], cap.maxTotal ?? 75);
        }
        for (const agent of agents) {
          agent.demandSource = demandSourceOf.get(agent.agentId) ?? 'issues';
          if (blockingPriority && priorities.has(agent.agentId)) agent.allocationPriority = priorities.get(agent.agentId);
          if (reviewIds.has(agent.agentId) && reviewDemand.status !== 'disabled') {
            agent.heartbeatQueued = heartbeat.ok ? (heartbeat.counts.get(agent.agentId) ?? 0) : 0;
            agent.reviewEligibleHeads = reviewShares.get(agent.agentId) ?? 0;
            agent.demandSource = `heartbeat-runs+review-heads${reviewDemand.status === 'ok' ? '' : '-unavailable'}`;
          }
        }
        // Reader invalidation alone cannot revoke a result already resolved
        // before hold-state I/O. Fence the entire publication: an old config
        // may preserve running work, but cannot authorize ANY new slots.
        if (generation !== configGenerationOf(companyId)) {
          const paidFloors = baseInputs.map(a => ({ ...a, allocated: a.running, maxConcurrentRuns: a.running }));
          const freeRunning = Object.fromEntries(Object.entries(runningByAgent).map(([id, r]) => [id, r.freeRunning ?? 0]));
          const floors = (cap.freeLanes
            ? freeLaneCaps(paidFloors, freeRunning, 0, [], cap.maxTotal ?? 75) : paidFloors)
            .filter(a => a.running + a.queued > 0).map(a => ({ ...a,
              demand: a.running + a.queued, reason: 'configuration-changed', reviewEligibleHeads: 0,
            }));
          return { status: 200, body: { atMs, calibration, target: null, agents: floors,
            capsError: 'configuration-changed',
            reviewDemand: { status: 'unavailable', eligibleHeads: 0, reason: 'configuration-changed' },
            reservedFloors: {}, floorsSuspended: false } };
        }
        return { status: 200, body: { atMs, calibration, target, agents, reviewDemand, reservedFloors: floorSummary, floorsSuspended,
          ...(priorityRequested ? { allocation: { blockingPriority,
            ...(allocated.resourceStatus ? { resourceStatus: allocated.resourceStatus } : {}),
            ...(!blockingPriority ? { error: 'priority-unavailable' } : {}) } } : {}),
        } };
      }
      return { status: 404, body: { error: 'unknown-route' } };
    },

    /**
     * v0.2.1 enforcement hook. MEMORY-ONLY: it reads the in-memory live view
     * the last tick published and performs zero I/O -- no config, state,
     * network, or db reads. The host's RPC deadline is 1.5s; no latency
     * guarantee is implied by synthetic tests. Fail-safe order: unknown company, enforce off, human
     * operator overrides answer `keep` (the agent default runs). Enforced
     * When credential-readiness admission is enabled, stale snapshots or
     * unavailable credentials defer (~60s retry); when it is off, stale
     * snapshots answer `keep` and readiness does not filter candidates. A
     * pace-guard hold answers `defer` with pacing.guard.retryAfterMs. No
     * headroom still defers. Every enforced decision is recorded in the
     * ledger with `enforced:true` (memory-only; the next tick persists it).
     *
     * Note: ResolveRunModelParams carries no retry/context signals, so each
     * call is decided fresh (retryCount 0, failureClass none, contextTokens
     * null) -- determinism comes from the cached tick state, which is
     * identical for identical params until the next tick moves it.
     */
    async onResolveRunModel(params) {
      // A run the hook keeps executes on its default model whatever it was
      // told before: it is no longer waiting, so the pace guard counts it.
      // A routed run proves the lane servable: the exhaustion streak resets.
      const keep = () => {
        clearDeferred(params?.companyId, params?.runId);
        if (exhaustionEnabledFor(params?.companyId)) clearExhaustionStreak(params.companyId, params);
        return { kind: 'keep' };
      };
      const live = params?.companyId ? liveViews.get(params.companyId) : null;
      if (!live && enforceCompanies.has(params?.companyId) && taskRankingModes.get(params.companyId) === 'enforce'
        && !(typeof params?.issueOverrideModel === 'string' && params.issueOverrideModel.length > 0)) {
        return { kind: 'defer', retryAfterMs: 20000, reason: 'awaiting native task-ranking evidence snapshot' };
      }
      if (!live && enforceCompanies.has(params?.companyId) && freeLaneConfigs.get(params.companyId)?.enabled === true
        && !(typeof params?.issueOverrideModel === 'string' && params.issueOverrideModel.length > 0)) {
        return { kind: 'defer', retryAfterMs: 20000, reason: 'awaiting native free-lane evidence snapshot' };
      }
      if (!live || live.enforce !== true || !enforceCompanies.has(params.companyId)) return keep();
      if (typeof params?.issueOverrideModel === 'string' && params.issueOverrideModel.length > 0) {
        return keep();
      }
      // Keep the old view for its safety guards, but never route from retired
      // policy/source data. Deleting it would make missing-view fail open.
      if (!liveIsCurrent(params.companyId, live)) return invalidatedDefer(params, live);
      if (!taskModeCompatible(live, params.companyId)) return { kind: 'defer', retryAfterMs: 20000,
        reason: 'task ranking configuration changed; awaiting the next native tick' };
      if (live.taskRanking?.mode === 'enforce' && (!Number.isFinite(live.atMs)
        || clock() - live.atMs > 120000 || clock() < live.atMs)) {
        return { kind: 'defer', retryAfterMs: 20000, reason: 'task-ranking evidence snapshot stale or invalid' };
      }
      if (freeLaneConfigs.get(params.companyId)?.enabled === true
        && JSON.stringify(live.freeLanes) !== JSON.stringify(freeLaneConfigs.get(params.companyId))) {
        return { kind: 'defer', retryAfterMs: 20000, reason: 'free-lane configuration changed; awaiting the next native tick' };
      }
      // Reviewer routing: listed review agents route to the best configured
      // arm (burn mode, then the pool most behind plan); no qualifying arm
      // falls through to keep below. Off (absent config) = unchanged.
      const reviewRoute = await routeReviewerRun(params, live);
      if (!enforceCompanies.has(params.companyId)) return keep();
      if (!liveIsCurrent(params.companyId, live)) return invalidatedDefer(params, live);
      if (reviewRoute) {
        // A routed review run resets the card's streak; a pace-held reviewer
        // defer extends it, like every other hook deferral -- and answers
        // from the final attempt instead of stranding, exactly like the
        // terminal defers below (same Design B scan, same gates; forReview
        // reads through so review runs keep spending held quota).
        if (exhaustionEnabledFor(params?.companyId)) {
          if (reviewRoute.kind === 'decide') clearExhaustionStreak(params.companyId, params);
          else if (reviewRoute.kind === 'defer') {
            const priorCount = exhaustionStreakCount(params.companyId, params, clock());
            if (priorCount + 1 >= exhaustionFinalAttemptFor(params.companyId)) {
              const hookLedger = await getOrLoadLedger(params.companyId);
              if (!enforceCompanies.has(params.companyId)) return keep();
              if (!liveIsCurrent(params.companyId, live)) return invalidatedDefer(params, live);
              const { answer, skips } = await exhaustionAnswer({
                live,
                params,
                role: roleOf({ roles: {
                  thinkerAgentIds: live.thinkerAgentIds,
                  doerAgentIds: live.doerAgentIds,
                } }, params.agentId),
                selfId: params?.runId != null ? String(params.runId) : null,
                priorReason: reviewRoute.reason,
                forReview: liveIsReviewAgent(live, params.agentId),
                hookLedger,
                nowMs: clock(),
              });
              if (answer) return answer;
              bumpExhaustionStreak(params.companyId, params, clock());
              return {
                ...reviewRoute,
                reason: `${reviewRoute.reason}; exhaustion scan: ${skips.length > 0 ? skips.join('; ') : 'no candidates'}`,
              };
            }
            bumpExhaustionStreak(params.companyId, params, clock());
          }
        }
        return reviewRoute;
      }
      // Every defer below leaves the run waiting, not executing: the pace
      // guard stops counting it as in flight while its mark is fresh (see
      // the retry-lifespan bound on deferredRuns). Terminal capacity defers
      // extend the card's exhaustion streak; stale credential evidence does
      // not, because it is not a capacity-retry chain.
      const deferred = (out, { countTowardExhaustion = true } = {}) => {
        markDeferred(params.companyId, params.runId, clock(), live.staleHorizonMs ?? 2 * 3600 * 1000, out?.retryAfterMs);
        if (countTowardExhaustion && exhaustionEnabledFor(params.companyId)) {
          bumpExhaustionStreak(params.companyId, params, clock());
        }
        return out;
      };
      // Operator-pinned agents retain their configured model and context caps,
      // but keep must not bypass managed free-provider admission.
      if (Array.isArray(live.keepAgentIds) && live.keepAgentIds.includes(params?.agentId)) {
        const defaultKey = canonicalKey(params.agentDefaultModel);
        if (defaultKey && (live.accounts ?? []).some(a => managedFreeAccount(live, params.companyId, a)
          && (a.models ?? []).some(m => canonicalKey(m) === defaultKey))) {
          return deferred({ kind: 'defer', retryAfterMs: 20000, reason: 'kept agent default requires managed free-lane admission' }, {
            countTowardExhaustion: false,
          });
        }
        await recordKeptDecision(params.companyId, live, params.runId, params.agentId);
        if (!enforceCompanies.has(params.companyId)) return keep();
        if (!liveIsCurrent(params.companyId, live)) return invalidatedDefer(params, live);
        const capped = keptCapsAnswer(params, live, 'kept: agent pinned to its configured model (roles.keepAgentIds)');
        if (capped) {
          clearDeferred(params.companyId, params.runId);
          if (exhaustionEnabledFor(params.companyId)) clearExhaustionStreak(params.companyId, params);
          return capped;
        }
        return keep();
      }
      const credentialEnforced = credentialReadinessEnforced(params.companyId);
      if (!Number.isFinite(live.atMs) || clock() - live.atMs > 120000
        || (credentialEnforced && clock() < live.atMs)) {
        if (credentialEnforced) {
          return deferred(credentialDefer(params.companyId, 'routing snapshot stale or invalid'), {
            countTowardExhaustion: false,
          });
        }
        // Keep executes the configured model; it must not reopen a managed
        // free provider without low-risk, rate and demotion admission. Model
        // aliases can be ambiguous across accounts, so fail closed on a match.
        const defaultKey = canonicalKey(params.agentDefaultModel);
        if (defaultKey && (live.accounts ?? []).some(a => managedFreeAccount(live, params.companyId, a)
          && (a.models ?? []).some(m => canonicalKey(m) === defaultKey))) {
          return deferred({ kind: 'defer', retryAfterMs: 20000, reason: 'free-lane evidence snapshot stale or invalid' }, {
            countTowardExhaustion: false,
          });
        }
        const staleAns = keptCapsAnswer(params, live, 'routing snapshot stale') ?? { kind: 'keep' };
        // Either answer executes the run, ending the chain: the streak
        // resets (a plain stale keep is a routed run like any other, not a
        // deferral, so it must not count toward a future chain's grace).
        if (exhaustionEnabledFor(params.companyId)) clearExhaustionStreak(params.companyId, params);
        return staleAns;
      }
      // Join any ledger load before selection; no await may split admission,
      // the half-open probe claim, and the recorded/emitted decision.
      const hookLedger = await getOrLoadLedger(params.companyId);
      // Config changes can land while the ledger load yields, even when the
      // tick cannot refresh the live view. Enforce off is an immediate kill switch.
      if (!enforceCompanies.has(params.companyId)) return keep();
      if (!liveIsCurrent(params.companyId, live)) return invalidatedDefer(params, live);
      if (!taskModeCompatible(live, params.companyId)) return { kind: 'defer', retryAfterMs: 20000,
        reason: 'task ranking configuration changed; awaiting the next native tick' };
      const role = roleOf({ roles: {
        thinkerAgentIds: live.thinkerAgentIds,
        doerAgentIds: live.doerAgentIds,
      } }, params.agentId);
      const roleExcluded = normalizeExcludedFamilies(live.excludeFamilies?.[role] ?? []);
      if (freeLaneConfigs.get(params.companyId)?.enabled === true
        && JSON.stringify(live.freeLanes) !== JSON.stringify(freeLaneConfigs.get(params.companyId))) {
        return { kind: 'defer', retryAfterMs: 20000, reason: 'free-lane configuration changed; awaiting the next native tick' };
      }
      const freeAnswer = routeFreeRun(params, live, role, hookLedger);
      if (freeAnswer) {
        clearDeferred(params.companyId, params.runId);
        if (exhaustionEnabledFor(params.companyId)) clearExhaustionStreak(params.companyId, params);
        return freeAnswer;
      }
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
      // Review runs admit past the reserve hold (the reserve holds quota FOR
      // them); other work defers while its only account is held, and the
      // reason says so -- not a generic no-headroom.
      const forReview = liveIsReviewAgent(live, params.agentId);
      const { order, paced, reserveHeld } = withDuplicatePass(duplicates => allocationOrderFromLive(
        live, params.companyId, selfId, role, roleExcluded, duplicates, forReview, params,
      ));
      const capBase = new Map((live.accounts ?? []).map(a => [a.accountId, a.inFlight ?? 0]));
      const acctPending = pendingByAccount(live, params.companyId, selfId);
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
        // Provider-scoped reactive cap (nvidia-nim 1, others on the global).
        if (view.reactive && (capBase.get(view.accountId) ?? 0) + (acctPending.get(view.accountId) ?? 0) >= liveTrialInflightCapFor(live, view)) continue;
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
          taskRanking: live.taskRanking,
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
          if (!decisionCredentialReady(d, roleRungs, params.companyId)) continue;
          if (d.armId != null && params?.runId != null
            && breakerState(bstore, d.accountId, d.armId, bnow, bcfg) === 'half-open'
            && !startProbe(bstore, d.accountId, d.armId, params.runId, bnow, bcfg)) {
            continue;
          }
          clearDeferred(params.companyId, params.runId);
          if (exhaustionEnabledFor(params.companyId)) clearExhaustionStreak(params.companyId, params);
          const emitAdapter = params.adapterType ?? liveAdapterFor(live, params.agentId) ?? null;
          const decorated = decoratedModelFor(d, emitAdapter);
          recordDecision(hookLedger, {
            runId: String(params.runId ?? 'unknown'),
            agentId: String(params.agentId ?? 'unknown'),
            accountId: d.accountId,
            armId: d.armId ?? null,
            effort: d.effort ?? null,
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
      if (credentialReadinessEnforced(params.companyId)
        && !(live.accounts ?? []).some(a => rungsHaveEligibleArms(credentialGroupsFor(a, clock(), true)))) {
        return deferred(credentialDefer(params.companyId));
      }
      // Terminal defer selection (unchanged strings when exhaustion is off).
      // When the review reserve holds every account that could serve, the
      // wait is for a review slot (or the hold's release near reset): say so
      // and retry on the pace-guard scale -- a 60 s retry would burn the
      // host's 12-attempt budget in ~12 min and abandon the wait long before
      // the hold lifts. A co-holding pace guard is named too, so operators
      // see both holds instead of only the reserve.
      //
      // Deferral-exhaustion (Design B): the host retries a deferred run as a
      // NEW runId up to RUN_MODEL_RESOLVE_MAX_ATTEMPTS = 12 times and then
      // freezes the card. When the card's streak reaches the final attempts,
      // answer instead of deferring -- the cheapest selectable free-overflow
      // arm under the existing trial caps, else a bounded keep -- so the
      // chain ends in a run, not a freeze. The deferred() wrapper below
      // extends the streak by one for the defer being returned, so the count
      // here adds that pending deferral: the final attempt is the first call
      // that answers. Every answer clears the streak because it ends the
      // defer chain; a failed scan appends its per-account skip reasons to
      // the defer reason for diagnosability. Disabled reads bit-for-bit as
      // before: the same three terminal defers, untouched.
      let terminal;
      if (order.length === 0 && (reserveHeld?.length ?? 0) > 0) {
        const names = reserveHeld.map(h => h.accountId).join(', ');
        const guard = live.paceGuard ?? {};
        const held = (paced ?? []).map(pacedPoolText);
        const also = held.length > 0 ? `; pace guard also holds ${held.join('; ')}` : '';
        terminal = {
          kind: 'defer',
          retryAfterMs: guard.retryAfterMs ?? 300000,
          reason: `review reserve: ${names} held for review runs${also}`,
        };
      } else if (paced.length > 0) {
        const guard = live.paceGuard ?? {};
        const held = paced.map(pacedPoolText);
        const also = order.length > 0 ? `; ${new Set(order.map(v => v.accountId)).size} unpaced account(s) also unselectable this call` : '';
        terminal = {
          kind: 'defer',
          retryAfterMs: guard.retryAfterMs ?? 300000,
          reason: `pace guard: ${held.join('; ')}${also}`,
        };
      } else {
        terminal = { kind: 'defer', retryAfterMs: 60000, reason: 'no account has headroom right now' };
      }
      if (exhaustionEnabledFor(params.companyId)) {
        const priorCount = exhaustionStreakCount(params.companyId, params, clock());
        if (priorCount + 1 >= exhaustionFinalAttemptFor(params.companyId)) {
          const { answer, skips } = await exhaustionAnswer({
            live, params, role, selfId,
            priorReason: terminal.reason, forReview, hookLedger, nowMs: clock(),
          });
          if (answer) return answer;
          return deferred({
            ...terminal,
            reason: `${terminal.reason}; exhaustion scan: ${skips.length > 0 ? skips.join('; ') : 'no candidates'}`,
          });
        }
      }
      return deferred(terminal);
    },
  };
  if (variant === 'clean') delete plugin.onResolveRunModel;
  return plugin;
}
