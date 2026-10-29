/** Pure synthesis of the selector's account view at a quota snapshot tick. */
import { scheduleError } from './pacing.mjs';

const nonNegative = n => Number.isFinite(n) ? Math.max(0, n) : 0;

export function snapshotAccountView(accountKey, account, { nowMs, accountStaleMs = 15 * 60_000 } = {}) {
  const fresh = ['passive', 'live', 'cached'].includes(account.quality) && Number.isFinite(account.observedAtMs)
    && Number.isFinite(nowMs) && nowMs - account.observedAtMs <= accountStaleMs;
  const inFlight = nonNegative(account.inFlightBase);
  const view = {
    accountId: accountKey,
    health: fresh && account.credentialReady === true ? 'healthy' : 'unavailable',
    weeklyUsed: account.weeklyUsed ?? null,
    usedPct: account.weeklyUsed ?? null,
    resetAtMs: account.weeklyResetsAtMs ?? null,
    measuredRatePerHour: account.measuredRatePerHour ?? null,
    targetShare: account.targetShare ?? null,
    inFlight, laneInFlight: account.laneInFlight ?? inFlight,
    placementQ: account.placementQ ?? null,
    roleEligible: account.roleEligible, taskFeasible: account.taskFeasible,
    held: account.held === true, burn: account.burn?.active === true,
    burnFirst: account.burnFirst, reactive: account.reactive, meter: account.meter,
    quality: account.quality, provider: account.provider, models: account.models,
    fallbackOnly: account.fallbackOnly, creditFallback: account.creditFallback,
    guardActive: account.guardActive,
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
  const requiredRatePerHour = projectedUsed != null && Number.isFinite(hours) && hours > 0
    ? Math.max(0, 1 - projectedUsed) / hours : null;
  const planAhead = projectedUsed != null && Number.isFinite(view.weeklyPeriodStartMs) && Number.isFinite(view.resetAtMs)
    ? scheduleError({ usedPct: projectedUsed, nowMs: view.nowMs, periodStartMs: view.weeklyPeriodStartMs, periodEndMs: view.resetAtMs }) : null;
  return { ...view, inFlight, laneInFlight: Math.max(0, nonNegative(view.laneInFlight) + (Number.isFinite(delta) ? delta : 0)),
    projectedUsed, headroomPct: projectedUsed == null ? null : 1 - projectedUsed,
    remainingPct: projectedUsed == null ? null : Math.max(0, 1 - projectedUsed),
    requiredRatePerHour, deficit: requiredRatePerHour == null || !Number.isFinite(view.measuredRatePerHour)
      ? null : requiredRatePerHour - view.measuredRatePerHour, planAhead };
}
