/** Job-side native router snapshots. No host calls in the builder or readers.
 * Publication is persist-before-replace; the state envelope keeps history and
 * snapshot at one commit point. A failed tick never refreshes the old timestamp.
 */
import { parseLaneBody, resetAtMsOf } from './cliproxy.mjs';
import { CREDENTIAL_MAX_AGE_MS, credentialEvidenceFor, credentialReadiness } from './availability.mjs';
import { joinRegistryFeed } from './registry.mjs';
import { accountKeyForModel, isInflight } from './ledger.mjs';
import { appendUtilReading, appendTickLog, robustRatePerHour, stepRateController, DEFAULT_PACING, RATE_HISTORY_KEEP_MS, RATE_HISTORY_CAP } from './pacing.mjs';
import { snapshotAccountView } from './views.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, WEEK = 7 * 24 * HOUR;
const credibleQuality = q => ['passive', 'live', 'cached'].includes(q);
const fresh = (at, now, age) => Number.isFinite(at) && Number.isFinite(now) && now - at >= -MINUTE && now - at <= age;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const nonNegative = n => Number.isFinite(n) ? Math.max(0, n) : 0;

export function freezeSnapshot(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshotIsStale(snapshot, nowMs, staleSnapshotMs = 180_000) {
  return !snapshot || !fresh(snapshot.atMs, nowMs, staleSnapshotMs);
}
export function accountReadingIsStale(account, nowMs, accountStaleMs = 900_000) {
  return !account || Number.isFinite(account.staleSinceMs) || !credibleQuality(account.quality) || !Number.isFinite(account.weeklyUsed)
    || !fresh(account.observedAtMs, nowMs, Math.min(accountStaleMs, CREDENTIAL_MAX_AGE_MS));
}

function appendWindow(previous, kind, used, resetAtMs, observedAtMs, nowMs) {
  const resetKey = `${kind}ResetsAtMs`, ticksKey = `${kind}Ticks`;
  const sameWindow = previous?.[resetKey] === resetAtMs;
  let history = sameWindow ? previous?.[kind] ?? [] : [];
  let ticks = sameWindow ? previous?.[ticksKey] ?? [] : [];
  if (Number.isFinite(used) && Number.isFinite(observedAtMs)) {
    const last = history.at(-1)?.atMs ?? null;
    if (!history.some(p => p.atMs === observedAtMs && p.usedPct === used)) {
      history = appendUtilReading(history, {atMs:observedAtMs, usedPct:used}, nowMs);
      ticks = appendTickLog(ticks, {atMs:observedAtMs, usedPct:used}, nowMs, last);
    } else {
      // Even a repeated cached reading must prune the retained history.
      history = history.filter(p => nowMs - p.atMs <= RATE_HISTORY_KEEP_MS).slice(-RATE_HISTORY_CAP);
    }
  }
  return {[kind]:history, [ticksKey]:ticks, [resetKey]:resetAtMs};
}
function retryTime(account, reason, nowMs, recheckMs, hardCapFiveHour) {
  if (reason === 'weekly-exhausted' || reason === 'five-hour-exhausted') {
    const reset = reason === 'weekly-exhausted' ? account.weeklyResetsAtMs : account.fiveHourResetsAtMs;
    if (Number.isFinite(reset) && reset > nowMs) {
      const five = account.fiveHourResetsAtMs;
      const both = reason === 'weekly-exhausted' && account.view.projectedFiveHourUsed >= hardCapFiveHour && Number.isFinite(five) && five > nowMs;
      return clamp(both ? Math.max(reset,five) : reset, nowMs + MINUTE, nowMs + WEEK);
    }
  }
  if (reason === 'pace-held') {
    const end = account.view.bindingWindow === 'five-hour' ? account.fiveHourResetsAtMs : account.weeklyResetsAtMs;
    const start = end - (account.view.bindingWindow === 'five-hour' ? 5 * HOUR : WEEK);
    const used = account.view.bindingWindow === 'five-hour' ? account.view.projectedFiveHourUsed : account.view.projectedUsed;
    return clamp(Math.ceil(start + (used - account.deadband) * (end - start)), nowMs + MINUTE, nowMs + 30 * MINUTE);
  }
  const k = clamp(Math.floor((nowMs - (account.staleSinceMs ?? nowMs)) / recheckMs), 0, 30);
  return nowMs + Math.min(30 * MINUTE, recheckMs * 2 ** k);
}

/** Feed is the lane JSON, not an already restamped parse. Unknown/missing
 * observations are never replaced with the current tick time. Extra feed
 * fields (labels, email, vendor errors) never enter persisted router state.
 * Quality/outcome/effort policy is wired by the selection adapter (slice 4).
 */
export function buildQuotaSnapshot({registry, feed, nowMs, previous = null, histories = {}, controllers = {}, ledger = new Map(),
  config = {}, meanRunWeeklyPctByAccount = {}, meanRunFiveHourPctByAccount = {}, horizonMs = 2 * HOUR,
  unavailablePoolIds = [], unavailablePoolKeys = [], memberSkipReasons = {}, drift = null}) {
  if (!Number.isFinite(nowMs)) throw new Error('invalid snapshot clock');
  if (!Array.isArray(feed?.accounts) || feed.accounts.some(a => !a || typeof a !== 'object' || Array.isArray(a))) throw new Error('invalid quota feed');
  const joined = joinRegistryFeed(registry, feed);
  const parsed = parseLaneBody(feed, nowMs);
  if (!parsed) throw new Error('invalid quota feed');
  const rawByKey = new Map(feed.accounts.map(a => [a.accountKey, a]));
  const byKey = new Map(parsed.accounts.map(a => [a.accountKey, a]));
  const router = config.router ?? registry, pacing = {...DEFAULT_PACING, ...config.pacing};
  const staleMs = Math.min(router.accountStaleMs ?? 900_000, CREDENTIAL_MAX_AGE_MS);
  const counts = new Map();
  for (const run of ledger.values()) {
    if (!isInflight(run, nowMs, horizonMs)) continue;
    // Observed actual prefixed model only. A shadow decision is not a run.
    const key = accountKeyForModel(run.actualModel ?? run.eventModel, registry.accounts);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const outHistories = {}, outControllers = {}, accounts = {}, skipReasons = {...memberSkipReasons};
  for (const registered of registry.accounts) {
    const key = registered.accountKey, a = byKey.get(key), raw = rawByKey.get(key);
    const bodyAtMs = resetAtMsOf(feed.observedAt);
    const entryAtMs = raw && Object.hasOwn(raw,'observedAt') && raw.observedAt !== undefined ? resetAtMsOf(raw.observedAt) : bodyAtMs;
    const observedAtMs = Number.isFinite(bodyAtMs) && Number.isFinite(entryAtMs) ? Math.min(bodyAtMs,entryAtMs) : null;
    const quality = credibleQuality(a?.quality) && Number.isFinite(a?.weekly?.utilization) ? a.quality : 'unknown';
    const stale = !fresh(bodyAtMs,nowMs,staleMs) || !fresh(entryAtMs,nowMs,staleMs) || quality === 'unknown'
      || !Number.isFinite(a?.weekly?.resetsAtMs) || a.weekly.resetsAtMs <= nowMs;
    const weeklyUsed = a?.weekly?.utilization ?? null, fiveHourUsed = a?.fiveHour?.utilization ?? null;
    const weeklyResetsAtMs = a?.weekly?.resetsAtMs ?? null, fiveHourResetsAtMs = a?.fiveHour?.resetsAtMs ?? null;
    const history = {
      ...appendWindow(histories[key], 'weekly', weeklyUsed, weeklyResetsAtMs, observedAtMs, nowMs),
      ...appendWindow(histories[key], 'fiveHour', fiveHourUsed, fiveHourResetsAtMs, observedAtMs, nowMs),
    };
    outHistories[key] = history;
    const inFlightBase = counts.get(key) ?? 0;
    const measure = kind => robustRatePerHour(history[kind], nowMs, pacing.rateWindowMin, pacing.rateMinSpanMin, {tickLog:history[`${kind}Ticks`], inFlight:inFlightBase})?.ratePerHour ?? null;
    let credentialReady = false;
    for (const [id, member] of Object.entries(registry.memberIndex)) {
      if (member.accountKey !== key) continue;
      const model = `${registered.prefix}/${registered.pools[member.poolKey].model}`;
      const readiness = credentialReadiness(credentialEvidenceFor(a,model),nowMs);
      if (readiness.eligible) credentialReady = true;
      else skipReasons[id] ??= 'credential-unavailable';
    }
    const account = {
      weeklyUsed, weeklyResetsAtMs, fiveHourUsed, fiveHourResetsAtMs,
      weeklyPeriodStartMs:weeklyResetsAtMs == null ? null : weeklyResetsAtMs - WEEK,
      quality, observedAtMs,
      staleSinceMs:stale ? previous?.accounts?.[key]?.staleSinceMs ?? nowMs : null,
      credentialReady, inFlightBase, laneInFlight:inFlightBase,
      measuredRatePerHour:measure('weekly'), measuredFiveHourRatePerHour:measure('fiveHour'),
      meanRunWeeklyPct:nonNegative(meanRunWeeklyPctByAccount[key]), meanRunFiveHourPct:nonNegative(meanRunFiveHourPctByAccount[key]),
      burn:{active:false,expiresAtMs:null}, provider:registered.provider,
      // Reactive/credit feed facts pass through, but never fabricate a weekly meter.
      reactive:a?.meter === 'reactive', meter:a?.meter ?? null,
      deadband:pacing.deadband,
    };
    account.view = snapshotAccountView(key, account, {nowMs,accountStaleMs:staleMs});
    account.requiredRatePerHour = account.view.requiredRatePerHour;
    account.measuredRatePerHour = account.view.measuredRatePerHour;
    account.deficit = account.view.deficit;
    account.paceState = stepRateController(controllers[key] ?? {}, {weeklyUsedPct:weeklyUsed,fiveHourUsedPct:fiveHourUsed,
      requiredRatePerHour:account.requiredRatePerHour,measuredRatePerHour:account.measuredRatePerHour,positionError:account.view.planAhead}, nowMs,pacing,0);
    outControllers[key] = account.paceState;
    let reason = stale ? 'account-reading-stale' : !credentialReady ? 'credential-unavailable'
      : account.view.projectedUsed >= (router.hardCapWeekly ?? .995) ? 'weekly-exhausted'
      : fiveHourUsed != null && account.view.projectedFiveHourUsed >= (router.hardCapFiveHour ?? .99) ? 'five-hour-exhausted' : null;
    if (!reason && Number.isFinite(account.view.planAhead) && account.view.planAhead > pacing.deadband
        && Number.isFinite(account.measuredRatePerHour) && Number.isFinite(account.requiredRatePerHour)
        && account.measuredRatePerHour > account.requiredRatePerHour * (1 + pacing.rateDeadbandRel)) reason = 'pace-held';
    account.eligible = reason == null;
    account.skipReason = reason;
    account.held = reason === 'pace-held';
    account.view.held = account.held;
    account.nextEligibleAtMs = reason ? retryTime(account,reason,nowMs,router.recheckMs ?? 300_000,router.hardCapFiveHour ?? .99) : nowMs + MINUTE;
    accounts[key] = account;
  }
  const totalRequired = Object.values(accounts).reduce((s,a)=>s + nonNegative(a.requiredRatePerHour),0);
  for (const a of Object.values(accounts)) {
    a.targetShare = totalRequired > 0 ? nonNegative(a.requiredRatePerHour) / totalRequired : 0;
    a.view.targetShare = a.targetShare;
  }
  const snapshot = freezeSnapshot({version:(previous?.version ?? 0) + 1,atMs:nowMs,accounts,
    memberIndex:structuredClone(registry.memberIndex),poolRoles:{...registry.poolRoles},staleMemberIds:joined.staleMemberIds,
    memberSkipReasons:skipReasons,unavailablePoolIds:[...unavailablePoolIds],unavailablePoolKeys:[...unavailablePoolKeys],drift});
  return {snapshot,histories:outHistories,controllers:outControllers,warnings:joined.warnings};
}

/** Single state write before the atomic in-memory replacement. The caller
 * serializes ticks per company and fences config changes with isCurrent(). */
export function createSnapshotPublisher({state,keyFor}) {
  const published = new Map();
  return {
    get: companyId => published.get(companyId)?.snapshot ?? null,
    envelope: companyId => published.get(companyId) ?? null,
    async publish(companyId,tick,{isCurrent = () => true,onPublish = () => {}} = {}) {
      if (!isCurrent()) return false;
      const envelope = freezeSnapshot({...tick});
      await state.set(keyFor(companyId),envelope);
      if (!isCurrent()) return false;
      published.set(companyId,envelope);
      onPublish(); // Synchronous with base replacement: no callback can see a stale overlay.
      return true;
    },
  };
}
