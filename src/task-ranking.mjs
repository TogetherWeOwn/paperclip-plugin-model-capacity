/** Role-aware AA workload-cost priors. Pure scoring/reporting, reused by the
 * plugin's native tick/resolver; no scheduler, telemetry collector or new I/O. */
import { createHash } from 'node:crypto';
import { computeRoleComposite, DEFAULT_ROLE_METRIC_WEIGHTS, METRIC_REGISTRY, validateMetricWeights, metricObservation } from './quality.mjs';
import { buildLadder } from './ladder.mjs';
import { fillCosts, costProfile } from './cost.mjs';
import { computeEeeComposite, blendQ, eeeGateDatum } from './eee.mjs';
import { DEFAULT_TASK_CALIBRATION, compareTaskCosts } from './task-cost.mjs';
import { DEFAULT_MIN_QUALITY, MIN_FLEET_ARMS } from './eligibility.mjs';

export const TASK_RANKING_ROLES = Object.freeze(['doer', 'reviewer', 'thinker', 'other']);
const object = v => v != null && typeof v === 'object' && !Array.isArray(v);
export function validateTaskRanking(raw) {
  if (raw == null) return [];
  if (!object(raw)) return ['taskRanking must be an object'];
  const errors = [];
  const allowedKeys = new Set(['mode', 'profileVersion', 'minAbsoluteCoverage', 'roleMetricWeights', 'effortSupport', 'calibration']);
  for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) errors.push(`taskRanking.${key} is not a known key`);
  if (raw.mode != null && !['off', 'shadow', 'enforce'].includes(raw.mode)) errors.push('taskRanking.mode must be off, shadow or enforce');
  if (raw.profileVersion != null && raw.profileVersion !== 'aa-role-v1') errors.push('taskRanking.profileVersion must be aa-role-v1');
  if (raw.minAbsoluteCoverage != null && !(Number.isFinite(raw.minAbsoluteCoverage) && raw.minAbsoluteCoverage >= .6 && raw.minAbsoluteCoverage <= 1)) errors.push('taskRanking.minAbsoluteCoverage must be in [0.6, 1]');
  if (raw.roleMetricWeights != null) {
    if (!object(raw.roleMetricWeights)) errors.push('taskRanking.roleMetricWeights must be an object');
    else for (const [role, weights] of Object.entries(raw.roleMetricWeights)) {
      if (!TASK_RANKING_ROLES.includes(role)) errors.push(`taskRanking: unknown role ${role}`);
      errors.push(...validateMetricWeights(weights).map(e => `taskRanking.${role}: ${e}`));
    }
  }
  if (raw.effortSupport != null) {
    if (!object(raw.effortSupport)) errors.push('taskRanking.effortSupport must be an object of exact emitted ID to verified efforts');
    else for (const [model, efforts] of Object.entries(raw.effortSupport)) {
      if (!model || !Array.isArray(efforts) || efforts.length === 0 || efforts.some(e => !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(e))) errors.push(`taskRanking.effortSupport[${model}] must list verified efforts`);
    }
  }
  if (raw.calibration != null) {
    if (!object(raw.calibration)) errors.push('taskRanking.calibration must be an object');
    else {
      if (raw.calibration.enabled != null && typeof raw.calibration.enabled !== 'boolean') errors.push('taskRanking.calibration.enabled must be boolean');
      if (raw.calibration.enabled === true) errors.push('taskRanking.calibration: awaiting-native-attributed-outcomes; automatic ingestion is not supported');
      for (const k of ['windowDays', 'minClosedTasks', 'minAcceptedTasks', 'priorTasks']) {
        if (raw.calibration[k] != null && (!Number.isInteger(raw.calibration[k]) || raw.calibration[k] < DEFAULT_TASK_CALIBRATION[k])) errors.push(`taskRanking.calibration.${k} cannot be below ${DEFAULT_TASK_CALIBRATION[k]}`);
      }
      const v = raw.calibration.maxRelativeCiHalfWidth;
      if (v != null && !(Number.isFinite(v) && v > 0 && v <= .5)) errors.push('taskRanking.calibration.maxRelativeCiHalfWidth must be in (0, 0.5]');
    }
  }
  return errors;
}
export function normalizeTaskRanking(raw) {
  const r = object(raw) ? raw : {};
  // The normal config loader validates. The pure normalizer also refuses bad
  // profiles, rather than silently merging a typo into apparently valid data.
  const errors = validateTaskRanking(r);
  if (errors.length) throw new Error(errors.join('; '));
  return { mode: r.mode ?? 'shadow', profileVersion: 'aa-role-v1', minAbsoluteCoverage: r.minAbsoluteCoverage ?? .6,
    roleMetricWeights: Object.fromEntries(TASK_RANKING_ROLES.map(role => [role, { ...(r.roleMetricWeights?.[role] ?? DEFAULT_ROLE_METRIC_WEIGHTS[role]) }])),
    effortSupport: r.effortSupport ?? {}, calibration: { ...DEFAULT_TASK_CALIBRATION, ...r.calibration, enabled: false } };
}

const positive = v => Number.isFinite(v) && v > 0;
const primaryFor = (c, role) => {
  const has = k => metricObservation(c.row, k).value != null;
  if (role === 'thinker') return ['hle', 'gpqa', 'critpt'].some(has);
  return has('terminalbenchV40') || (has('codingIndex') && c.row?.codingIndexVersion === 'coding-agent-v2');
};
const calibrationPending = () => ({ ready: false, reason: 'awaiting-native-attributed-outcomes', closedTasks: 0,
  acceptedTasks: 0, pendingTasks: 0, relativeCiHalfWidth: null });
const knownRowMetadata = new Set(['slug', 'name', 'shortName', 'modelCreatorName', 'paramClass', 'priceClass', 'deprecated',
  'isReasoning', 'isOpenWeights', 'intelligenceIndexIsEstimated', 'costCarriedFrom', 'costFieldObservedAt', 'fieldObservedAt',
  'codingIndexVersion', 'observedAt', 'source', 'schemaWarnings', 'fieldSources']);
export function metricSchemaWarnings(rows) {
  const warnings = new Set();
  for (const r of rows ?? []) {
    for (const k of Object.keys(r ?? {})) if (!Object.hasOwn(METRIC_REGISTRY, k) && !knownRowMetadata.has(k)) warnings.add(`unregistered-source-field:${k}`);
    for (const k of Object.keys(METRIC_REGISTRY)) if (metricObservation(r, k).reason === 'invalid-observation') warnings.add(`invalid-observation:${r.slug ?? 'unknown'}:${k}`);
    for (const w of r?.schemaWarnings ?? []) warnings.add(w);
  }
  return [...warnings].sort();
}

/** Same existing cost fallback, labelled without changing its legacy return
 * shape. A cost estimate cannot establish quality or model identity. */
export function taskCostEvidence(candidates, fleet = candidates, snapshotAt = null) {
  const entry = a => ({ armId: a.armId, family: a.family, cost: a.row?.intelligenceIndexCostPerTask,
    priceIn: a.row?.price1mInputTokens, priceOut: a.row?.price1mOutputTokens });
  const entries = [...new Map(candidates.map(c => [c.armId, entry(c)])).values()], pool = fleet.map(entry);
  const costs = fillCosts(entries, { medianPool: pool });
  const profile = costProfile(entries);
  return candidates.map(c => {
    const filled = costs.get(c.armId);
    const measured = positive(c.row?.intelligenceIndexCostPerTask);
    const sourceObservedAt = c.row?.fieldObservedAt?.intelligenceIndexCostPerTask ?? null;
    const carriedAt = c.row?.costFieldObservedAt?.intelligenceIndexCostPerTask
      ?? (c.row?.costFieldObservedAt == null ? c.row?.costCarriedFrom : null)
      ?? (sourceObservedAt !== snapshotAt ? sourceObservedAt : null);
    const family = pool.some(e => e.family === c.family && positive(e.cost));
    const source = measured ? (carriedAt ? 'carried' : 'measured') : filled?.C == null ? 'missing'
      : profile != null && positive(c.row?.price1mInputTokens) && positive(c.row?.price1mOutputTokens) ? 'price-profile-estimate'
        : family ? 'family-median' : 'fleet-median';
    const base = c.costBase ?? filled?.C ?? null;
    const multiplier = c.costMultiplier ?? 1;
    return { ...c, costBase: base, costEstimated: filled?.estimated ?? false,
      aaCostPerTask: measured ? c.row.intelligenceIndexCostPerTask : null, aaCostSource: source,
      aaCostObservedAt: carriedAt ?? c.row?.fieldObservedAt?.intelligenceIndexCostPerTask ?? snapshotAt,
      costMultiplier: multiplier, taskCostProxy: base != null ? base * multiplier : null,
      estimatedApiEquivalentPerAcceptedTask: null, cashUsdPerAcceptedTask: c.costFree === true ? 0 : null,
      calibration: calibrationPending() };
  });
}

/** Each role starts from all candidates, independently of another role's
 * frontier. Fleet normalization deduplicates account copies of each arm. */
export function buildTaskRanking({ candidatesByAccount = {}, config = normalizeTaskRanking(),
  minQuality = DEFAULT_MIN_QUALITY, previous = {}, snapshotAt = null, eee = null, supersededTaskArmIdsByAccount = null } = {}) {
  const unique = new Map();
  const canNormalize = c => ['exact', 'verified-alias'].includes(c.matchType) && c.effortVerified === true;
  for (const cs of Object.values(candidatesByAccount)) for (const c of cs) {
    if (!unique.has(c.armId) || (canNormalize(c) && !canNormalize(unique.get(c.armId)))) unique.set(c.armId, c);
  }
  const fleet = [...unique.values()];
  const population = fleet.filter(canNormalize);
  const fleetEee = eee?.scores ? computeEeeComposite(population, eee.scores, eee.options) : null;
  const fleetScores = Object.fromEntries(TASK_RANKING_ROLES.map(role => [role,
    new Map(computeRoleComposite(fleet, config.roleMetricWeights[role], { population }).map(s => [s.armId, s]))]));
  const profiles = {};
  const trusted = (c, score, role) => {
    if (!['exact', 'verified-alias'].includes(c.matchType)) return c.matchType === 'borrowed' ? 'borrowed-evidence' : 'missing-aa-evidence';
    if (c.effortVerified !== true) return c.evidenceReason ?? 'effort-unverified';
    if (score.absoluteCoverage < config.minAbsoluteCoverage) return 'insufficient-profile-coverage';
    if (!primaryFor(c, role)) return 'missing-task-aligned-primary';
    return null;
  };
  for (const role of TASK_RANKING_ROLES) {
    const fs = fleetScores[role];
    const scored = fleet.filter(c => !trusted(c, fs.get(c.armId), role) && fs.get(c.armId)?.Q != null);
    const min = role === 'reviewer' ? null : minQuality?.[role];
    const alpha = eee?.scores ? (['thinker', 'reviewer'].includes(role) ? eee.blendThinker : eee.blendDoer) : 0;
    const q = c => blendQ(fs.get(c.armId)?.Q ?? null, fleetEee?.get(c.armId)?.Qeee ?? null, alpha ?? 0);
    const applies = Number.isFinite(min) && scored.length >= MIN_FLEET_ARMS;
    const suspend = applies && scored.length > 0 && scored.every(c => q(c) < min);
    profiles[role] = { min: Number.isFinite(min) ? min : null, scoredPopulation: scored.length, alpha: alpha ?? 0,
      suspended: Number.isFinite(min) && (!applies || suspend),
      suspensionReason: !Number.isFinite(min) ? null : !applies ? 'insufficient-scored-population' : suspend ? 'known-data-empty-role' : null,
      applies: applies && !suspend, advisory: role === 'reviewer' };
  }
  const accounts = Object.fromEntries(Object.entries(candidatesByAccount).map(([accountId, cs]) => {
    const priced = taskCostEvidence(cs, fleet, snapshotAt).sort((a, b) =>
      Number(canNormalize(b)) - Number(canNormalize(a))
      || (a.operationalReasons?.length ?? 0) - (b.operationalReasons?.length ?? 0)
      || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    const localPopulation = [...new Map(priced.filter(canNormalize).map(c => [c.armId, c])).values()];
    const localEee = eee?.scores ? computeEeeComposite(localPopulation, eee.scores, eee.options) : null;
    const roles = Object.fromEntries(TASK_RANKING_ROLES.map(role => {
      const local = new Map(computeRoleComposite(cs, config.roleMetricWeights[role], { population: localPopulation }).map(s => [s.armId, s]));
      const profile = profiles[role], fs = fleetScores[role];
      const seenBindings = new Set();
      const candidates = priced.map(c => {
        const duplicate = seenBindings.has(c.armId);
        seenBindings.add(c.armId);
        const s = local.get(c.armId), f = fs.get(c.armId);
        const qEee = localEee?.get(c.armId)?.Qeee ?? null;
        const qFleetEee = fleetEee?.get(c.armId)?.Qeee ?? null;
        const qFleet = blendQ(f.Q, qFleetEee, profile.alpha);
        const trustReason = trusted(c, f, role);
        const qualityOk = !profile.applies || qFleet >= profile.min;
        const Q = blendQ(s.Q, qEee, profile.alpha);
        const refusal = (c.newestVersionSuperseded ? 'superseded-version' : null) ?? (duplicate ? 'duplicate-benchmark-binding' : null) ?? trustReason ?? (!qualityOk ? 'min-quality' : null)
          ?? c.operationalReasons?.[0] ?? (c.taskCostProxy == null ? 'missing-task-cost' : null);
        return { ...c, taskRanking: true, role, Q, qThinker: Q, qFleet, qFleetThinker: qFleet,
          qAa: s.Q, qFleetAa: f.Q, qEee, qFleetEee, qBlended: Q, blendAlpha: profile.alpha,
          components: s.components, fleetComponents: f.components,
          coverage: s.coverage, absoluteCoverage: s.absoluteCoverage,
          primaryEvidence: primaryFor(c, role), minQuality: { ok: qualityOk, min: profile.min, q: qFleet, suspended: profile.suspensionReason },
          benchmarkTrusted: trustReason == null, trustReason, selectionReason: refusal,
          metricObservations: Object.fromEntries(Object.keys(METRIC_REGISTRY).filter(k => c.row?.[k] != null).map(k => [k, {
            ...metricObservation(c.row, k), observedAt: c.row?.costFieldObservedAt?.[k] ?? c.row?.fieldObservedAt?.[k] ?? snapshotAt,
            source: c.row?.fieldSources?.[k] ?? 'aa-snapshot',
          }])),
          // Free cash is a funding bucket, not a zero resource estimate. The
          // role frontier compares resources within that account/bucket.
          C: c.taskCostProxy, eligible: refusal == null,
          benchmarkEligible: !c.newestVersionSuperseded && !duplicate && trustReason == null && qualityOk && c.taskCostProxy != null };
      });
      const prior = previous[accountId]?.roles?.[role] ?? {};
      const gateByArm = localEee ? new Map([...localEee].map(([id, e]) => [id, eeeGateDatum(e)])) : null;
      const ladder = buildLadder(candidates.filter(c => c.benchmarkEligible), prior.rankingRungs ?? prior.rungs ?? [], gateByArm, prior.withinNoise ?? []);
      const rungIds = new Set(ladder.rungs.map(r => r.armId));
      for (const c of candidates) if (c.eligible) c.selectionReason = rungIds.has(c.armId) ? 'eligible' : 'pareto-dominated';
      return [role, { ...ladder, candidates,
        ...(supersededTaskArmIdsByAccount ? { excludedArmIds: [...(supersededTaskArmIdsByAccount.get(accountId) ?? [])] } : {}),
        rankingRungs: ladder.rungs, previousRungs: prior.rankingRungs ?? prior.rungs ?? [],
        gateByArm: gateByArm ? Object.fromEntries(gateByArm) : null, heldPairs: prior.withinNoise ?? [] }];
    }));
    return [accountId, { roles }];
  }));
  const normalizationVersion = createHash('sha256').update(JSON.stringify({ snapshotAt,
    profiles: config.roleMetricWeights, population: population.map(c => c.armId).sort(),
    eeeAt: eee?.options?.nowMs ?? null })).digest('hex').slice(0, 16);
  return { mode: config.mode, profileVersion: config.profileVersion, normalizationVersion,
    metricRegistryVersion: 'aa-fields-v1', metricRegistry: METRIC_REGISTRY, schemaWarnings: metricSchemaWarnings(fleet.map(c => c.row)),
    correlationNotice: 'Role profiles are priors; residual correlation is not independent evidence.',
    profiles, accounts, calibration: calibrationPending(),
    coverage: { uniqueArms: fleet.length, candidates: Object.values(candidatesByAccount).reduce((n, cs) => n + cs.length, 0) } };
}

/** A feasible preview is a decide() result, never an attractive-but-ineligible
 * ladder head. The caller supplies exactly the enforcement run inputs. */
export function taskPlacement(decision, groups) {
  if (decision?.kind !== 'decide') return { taskCostProxy: null, placementQ: null, taskFeasible: false };
  const arm = groups.flatMap(g => g.arms ?? []).find(a => a.armId === decision.armId);
  return { taskCostProxy: arm?.taskCostProxy ?? null, placementQ: arm?.qFleet ?? null,
    estimatedApiEquivalentPerAcceptedTask: arm?.estimatedApiEquivalentPerAcceptedTask ?? null,
    calibration: arm?.calibration ?? null, taskFeasible: true, taskArmId: decision.armId };
}
export { compareTaskCosts };

/** Preserve pre-existing per-arm overrides when the new identity canonicalizes
 * model + effort. A legacy dynamic model token covers its discovered efforts;
 * a classic AA slug covers that exact effort. No configuration is rewritten. */
export function translateTaskExclusions(raw, candidates) {
  return Object.fromEntries(['doer', 'thinker', 'other'].map(role => [role,
    [...new Set((raw?.[role] ?? []).flatMap(token => {
      if (typeof token !== 'string' || !token.toLowerCase().startsWith('arm:')) return [token];
      const id = token.slice(4).toLowerCase();
      const matched = candidates.filter(c => c.armId && [c.armId, c.aaSlug, c.canonicalModel, c.model]
        .some(value => typeof value === 'string' && value.toLowerCase() === id));
      return matched.length > 0 ? matched.map(c => `arm:${c.armId}`) : [token];
    }))],
  ]));
}
