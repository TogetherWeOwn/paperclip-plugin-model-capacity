/** Pure synthesis of the selector's account view at a quota snapshot tick. */
import { scheduleError } from './pacing.mjs';

const nonNegative = n => Number.isFinite(n) ? Math.max(0, n) : 0;

export function snapshotAccountView(accountKey, account, { nowMs, accountStaleMs = 15 * 60_000 } = {}) {
  const fresh = ['passive', 'live', 'cached'].includes(account.quality) && Number.isFinite(account.observedAtMs)
    && Number.isFinite(nowMs) && nowMs - account.observedAtMs >= -60_000 && nowMs - account.observedAtMs <= accountStaleMs;
  const inFlight = nonNegative(account.inFlightBase);
  const view = {
    accountId: accountKey,
    health: fresh && account.credentialReady === true ? 'healthy' : 'unavailable',
    weeklyUsed: account.weeklyUsed ?? null, fiveHourUsed: account.fiveHourUsed ?? null,
    fiveHourResetsAtMs: account.fiveHourResetsAtMs ?? null,
    meanRunFiveHourPct: nonNegative(account.meanRunFiveHourPct),
    usedPct: account.weeklyUsed ?? null,
    resetAtMs: account.weeklyResetsAtMs ?? null,
    measuredRatePerHour: account.measuredRatePerHour ?? null,
    measuredFiveHourRatePerHour: account.measuredFiveHourRatePerHour ?? null,
    targetShare: account.targetShare ?? null,
    inFlight, laneInFlight: account.laneInFlight ?? inFlight,
    placementQ: account.placementQ ?? null,
    roleEligible: account.roleEligible, taskFeasible: account.taskFeasible,
    held: account.held === true, burn: account.burn?.active === true,
    burnFirst: account.burnFirst, reactive: account.reactive, meter: account.meter,
    quality: account.quality, provider: account.provider, models: account.models,
    fallbackOnly: account.fallbackOnly, creditFallback: account.creditFallback,
    guardActive: account.guardActive, freeCost: account.freeCost,
    calibration: account.calibration, taskCostProxy: account.taskCostProxy,
    estimatedApiEquivalentPerAcceptedTask: account.estimatedApiEquivalentPerAcceptedTask,
    meanRunWeeklyPct: nonNegative(account.meanRunWeeklyPct),
    nowMs, weeklyPeriodStartMs: account.weeklyPeriodStartMs ?? null,
  };
  return applyInFlightOverlay(view, 0);
}

/** Delta is starts since the snapshot minus finishes of pre-snapshot runs. */
export function applyInFlightOverlay(view, delta) {
  const inFlight = Math.max(0, nonNegative(view.inFlight) + (Number.isFinite(delta) ? delta : 0));
  const projectedUsed = Number.isFinite(view.weeklyUsed)
    ? view.weeklyUsed + inFlight * nonNegative(view.meanRunWeeklyPct) : null;
  const hours = (view.resetAtMs - view.nowMs) / 3_600_000;
  const weeklyRequiredRatePerHour = projectedUsed != null && Number.isFinite(hours) && hours > 0
    ? Math.max(0, 1 - projectedUsed) / hours : null;
  const weeklyPlanAhead = projectedUsed != null && Number.isFinite(view.weeklyPeriodStartMs) && Number.isFinite(view.resetAtMs)
    ? scheduleError({ usedPct: projectedUsed, nowMs: view.nowMs, periodStartMs: view.weeklyPeriodStartMs, periodEndMs: view.resetAtMs }) : null;
  const projectedFiveHourUsed = Number.isFinite(view.fiveHourUsed)
    ? view.fiveHourUsed + inFlight * nonNegative(view.meanRunFiveHourPct) : null;
  const fiveHours = (view.fiveHourResetsAtMs - view.nowMs) / 3_600_000;
  const fiveRequired = projectedFiveHourUsed != null && Number.isFinite(fiveHours) && fiveHours > 0
    ? Math.max(0, 1 - projectedFiveHourUsed) / fiveHours : null;
  const weeklyMeasured = view.weeklyMeasuredRatePerHour ?? view.measuredRatePerHour;
  const fiveMeasured = view.measuredFiveHourRatePerHour;
  const weeklyDeficit = weeklyRequiredRatePerHour != null && Number.isFinite(weeklyMeasured) ? weeklyRequiredRatePerHour - weeklyMeasured : null;
  const fiveDeficit = fiveRequired != null && Number.isFinite(fiveMeasured) ? fiveRequired - fiveMeasured : null;
  const useFive = fiveDeficit != null && (weeklyDeficit == null || fiveDeficit < weeklyDeficit);
  const requiredRatePerHour = useFive ? fiveRequired : weeklyRequiredRatePerHour;
  const measuredRatePerHour = useFive ? fiveMeasured : weeklyMeasured;
  const planAhead = useFive ? scheduleError({ usedPct: projectedFiveHourUsed, nowMs: view.nowMs, periodStartMs: view.fiveHourResetsAtMs - 5 * 3_600_000, periodEndMs: view.fiveHourResetsAtMs }) : weeklyPlanAhead;
  return { ...view, inFlight, projectedFiveHourUsed,
    weeklyMeasuredRatePerHour: weeklyMeasured, bindingWindow: useFive ? 'five-hour' : 'weekly', measuredRatePerHour, laneInFlight: Math.max(0, nonNegative(view.laneInFlight) + (Number.isFinite(delta) ? delta : 0)),
    projectedUsed, headroomPct: projectedUsed == null ? null : 1 - projectedUsed,
    remainingPct: projectedUsed == null ? null : Math.max(0, 1 - projectedUsed),
    requiredRatePerHour, deficit: requiredRatePerHour == null || !Number.isFinite(measuredRatePerHour)
      ? null : requiredRatePerHour - measuredRatePerHour, planAhead };
}
