/** Pure, synchronous decision core for the upstream AI connection router.
 * No callback is registered here: the host adapter owns logging and IO.
 */
import { orderAccountsWithPacing, DEFAULT_PLACEMENT } from './select.mjs';
import { applyInFlightOverlay } from './views.mjs';

const PLUGIN_KEY = 'togetherweown.model-capacity';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const allowedReasons = new Set(['quota-snapshot-stale', 'account-reading-stale', 'weekly-exhausted', 'five-hour-exhausted', 'pace-held', 'quality-floor', 'outcome-gated', 'role-excluded', 'credential-unavailable', 'burn-not-target', 'unmapped-member', 'router-disabled']);
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const candidatesOf = p => Array.isArray(p?.candidates) ? p.candidates : [];
const memberId = c => c?.member?.id;
const allSkipped = (candidates, reason) => Object.fromEntries(candidates.map(c => [memberId(c), reason]));
const nowOf = params => { const n = Date.parse(params?.now); return Number.isFinite(n) ? n : 0; };
const wait = (now, skipped, retry = now + MINUTE) => ({kind: 'exhausted', retryAt: new Date(clamp(retry, now + MINUTE, now + 7 * DAY)).toISOString(), skipped});
const unavailable = skipped => ({kind: 'unavailable', skipped});
const validPool = p => p && typeof p.id === 'string' && typeof p.name === 'string' && p.pluginKey === PLUGIN_KEY && Array.isArray(p.members);
const registry = config => Array.isArray(config?.router?.accounts) ? config.router.accounts : [];

export function taskKeyKind(key) {
  if (key === '__heartbeat__') return 'heartbeat';
  if (typeof key === 'string' && key.startsWith('lifecycle:')) return 'lifecycle';
  return typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key) ? 'issue' : 'other';
}

/** Side-effect-free log facts; adapter emits the indicated level, never this core. */
export function routerDiagnostics(params, snapshot) {
  const candidates = candidatesOf(params);
  const ids = new Set(candidates.map(memberId));
  const memberOrder = Array.isArray(params?.memberOrder) ? params.memberOrder : [];
  const poolKeys = new Set(candidates.map(c => snapshot?.memberIndex?.[memberId(c)]?.poolKey).filter(k => typeof k === 'string'));
  const poolKey = poolKeys.size === 1 ? [...poolKeys][0] : candidates.length === 0 && Object.hasOwn(snapshot?.poolRoles ?? {}, params?.pool?.name) ? params.pool.name : 'unknown';
  const d = {poolId: params?.pool?.id, poolKey, taskKeyKind: taskKeyKind(params?.taskKey), pinned: Boolean(params?.pinnedMemberId), candidateCount: candidates.length, memberOrderCount: memberOrder.length, level: 'info'};
  if (poolKey !== 'unknown' && params?.pool?.name !== poolKey) d.poolNameMismatch = true;
  if (!validPool(params?.pool) || candidates.length === 0 || (snapshot && poolKeys.size !== 1)) d.level = 'error';
  if (candidates.length === 0) d.droppedMemberIds = [...memberOrder];
  else if (params?.pinnedMemberId) d.droppedSuppressed = 'pinned';
  else if (candidates.length === 1 && memberOrder.length > 1) d.droppedSuppressed = 'ambiguous-single-candidate';
  else {
    d.droppedMemberIds = memberOrder.filter(id => !ids.has(id));
    if (d.droppedMemberIds.length && d.level !== 'error') d.level = 'warn';
  }
  return d;
}

function candidateInfo(c, snapshot, config, poolKey) {
  const indexed = snapshot.memberIndex?.[memberId(c)];
  let key = indexed?.accountKey;
  if (!key) {
    const model = c?.runtimeConfig?.model;
    const prefix = typeof model === 'string' && model.includes('/') ? model.slice(0, model.indexOf('/')) : null;
    key = registry(config).find(a => a.prefix === prefix)?.accountKey;
  }
  return {id: memberId(c), key, account: snapshot.accounts?.[key], membership: registry(config).find(a => a.accountKey === key)?.pools?.[poolKey]};
}

function staleDelay(account, now, recheck) {
  const since = Number.isFinite(account?.staleSinceMs) ? account.staleSinceMs : now;
  const k = clamp(Math.floor((now - since) / recheck), 0, 30);
  return now + Math.min(30 * MINUTE, recheck * 2 ** k);
}
function nextTime(account, reason, now, recheck) {
  const validReset = t => Number.isFinite(t) && t > now && ['passive', 'live', 'cached'].includes(account.quality);
  if (reason === 'weekly-exhausted' && validReset(account.weeklyResetsAtMs)) return {at: account.weeklyResetsAtMs, credible: true};
  if (reason === 'five-hour-exhausted' && validReset(account.fiveHourResetsAtMs)) return {at: account.fiveHourResetsAtMs, credible: true};
  if (reason === 'pace-held') {
    let t = account.nextEligibleAtMs;
    if (!Number.isFinite(t) && Number.isFinite(account.weeklyPeriodStartMs) && Number.isFinite(account.weeklyResetsAtMs) && Number.isFinite(account.weeklyUsed)) {
      t = account.weeklyPeriodStartMs + (account.weeklyUsed - (account.deadband ?? .02)) * (account.weeklyResetsAtMs - account.weeklyPeriodStartMs);
    }
    return {at: clamp(Number.isFinite(t) ? t : now + recheck, now + MINUTE, now + 30 * MINUTE), credible: true};
  }
  if (reason === 'credential-unavailable') return {at: clamp(Number.isFinite(account.nextEligibleAtMs) ? account.nextEligibleAtMs : now + recheck, now + MINUTE, now + 6 * HOUR), credible: true};
  if (reason !== 'account-reading-stale' && reason !== 'weekly-exhausted' && reason !== 'five-hour-exhausted' && Number.isFinite(account.nextEligibleAtMs) && account.nextEligibleAtMs > now) return {at: account.nextEligibleAtMs, credible: true};
  return {at: staleDelay(account, now, recheck), credible: false};
}

export function routeDecision(params, snapshot, config = {}) {
  const now = nowOf(params), candidates = candidatesOf(params), router = config.router ?? {};
  if (!validPool(params?.pool)) return unavailable(allSkipped(candidates, 'unmapped-member'));
  if (!candidates.length) return unavailable({});
  if (router.enabled === false) return wait(now, allSkipped(candidates, 'router-disabled'));
  if (!snapshot || !Number.isFinite(snapshot.atMs) || now - snapshot.atMs > (router.staleSnapshotMs ?? 180_000)) return wait(now, allSkipped(candidates, 'quota-snapshot-stale'));
  const pin = params.pinnedMemberId;
  if (pin && !candidates.some(c => memberId(c) === pin)) return unavailable(allSkipped(candidates, 'unmapped-member'));
  const poolKeys = new Set(candidates.map(c => snapshot.memberIndex?.[memberId(c)]?.poolKey).filter(k => typeof k === 'string'));
  const poolKey = poolKeys.size === 1 ? [...poolKeys][0] : null;
  const infos = (pin ? candidates.filter(c => memberId(c) === pin) : candidates).map(c => candidateInfo(c, snapshot, config, poolKey));
  const kind = taskKeyKind(params.taskKey), probe = !pin && (kind === 'heartbeat' || kind === 'lifecycle');
  const restrictProbes = probe && infos.some(i => i.membership?.probeEligible === true);
  const recheck = Number.isFinite(router.recheckMs) && router.recheckMs > 0 ? router.recheckMs : 5 * MINUTE;
  const hardCap = Number.isFinite(router.hardCapWeekly) ? router.hardCapWeekly : .995;
  const skipped = {}, retries = [], eligible = [];
  const burnConfig = config.burn ?? router.burn ?? {};
  const burnActive = a => a?.burn?.active === true && Number.isFinite(a.burn.expiresAtMs) && now < a.burn.expiresAtMs && (!Number.isFinite(a.weeklyResetsAtMs) || now < a.weeklyResetsAtMs) && (!Number.isFinite(burnConfig.endAtUsedPct) || a.weeklyUsed < burnConfig.endAtUsedPct);
  const exclusive = !pin && !probe && burnConfig.mode === 'exclusive' && infos.some(i => burnActive(i.account));
  for (const i of infos) {
    const a = i.account;
    let reason = null;
    if (!poolKey || !snapshot.poolRoles?.[poolKey] || !i.key || !a) reason = 'unmapped-member';
    else if (a.quality === 'unknown' || !Number.isFinite(a.observedAtMs) || now - a.observedAtMs > (router.accountStaleMs ?? 15 * MINUTE)) reason = 'account-reading-stale';
    else if (a.credentialReady === false) reason = 'credential-unavailable';
    else if (Number.isFinite(a.weeklyUsed) && a.weeklyUsed >= hardCap) reason = 'weekly-exhausted';
    else if (Number.isFinite(a.fiveHourUsed) && a.fiveHourUsed >= (router.hardCapFiveHour ?? .99)) reason = 'five-hour-exhausted';
    else if (restrictProbes && i.membership?.probeEligible !== true) reason = 'role-excluded';
    else if (exclusive && !burnActive(a)) reason = 'burn-not-target';
    else if (a.eligible === false && !(a.skipReason === 'pace-held' && burnActive(a) && !pin && !probe)) reason = allowedReasons.has(a.skipReason) ? a.skipReason : 'account-reading-stale';
    if (!reason && a.view) {
      const v = applyInFlightOverlay(a.view, config.overlayDelta?.[i.key] ?? 0);
      const burn = burnActive(a) && !pin && !probe;
      const ahead = Number.isFinite(v.planAhead) && v.planAhead > (config.pacing?.deadband ?? .02);
      const fast = Number.isFinite(v.measuredRatePerHour) && Number.isFinite(v.requiredRatePerHour) && v.measuredRatePerHour > v.requiredRatePerHour * (1 + (config.pacing?.rateDeadbandRel ?? .15));
      if (ahead && fast && !burn) reason = 'pace-held';
      else if (v.health !== 'healthy') reason = a.credentialReady === false ? 'credential-unavailable' : 'account-reading-stale';
      else if (v.headroomPct != null && v.headroomPct <= 1 - hardCap) reason = 'weekly-exhausted';
      else eligible.push({...v, pool: poolKey, burn, held:false, memberId:i.id, accountId:i.key});
    } else if (!reason) reason = 'account-reading-stale';
    if (reason) {
      skipped[i.id] = reason;
      if (reason === 'unmapped-member') retries.push({at:now + MINUTE, credible:false});
      else retries.push(nextTime(a, reason, now, recheck));
    }
  }
  if (pin && eligible.length) return {kind:'selected', memberId:pin};
  if (eligible.length) {
    const selected = orderAccountsWithPacing(eligible, {reservePct: 1 - hardCap, placement: config.placement ?? DEFAULT_PLACEMENT, pacing: null}).order;
    // Explicit deficit precedence; the existing placement/shortfall order breaks ties.
    selected.sort((a,b) => Number(b.burn) - Number(a.burn) || (b.deficit ?? 0) - (a.deficit ?? 0));
    if (selected.length) return {kind:'selected', memberId:selected[0].memberId};
  }
  for (const i of infos) if (!skipped[i.id]) {skipped[i.id] = 'weekly-exhausted'; retries.push(nextTime(i.account, 'weekly-exhausted', now, recheck));}
  const credible = retries.filter(r => r.credible);
  let retry = Math.min(...(credible.length ? credible : retries).map(r => r.at));
  if (exclusive) {
    const expiry = infos.map(i => i.account?.burn?.expiresAtMs).filter(t => Number.isFinite(t) && t > now);
    if (expiry.length) retry = Math.min(retry, ...expiry);
  }
  return wait(now, skipped, Number.isFinite(retry) ? retry : now + MINUTE);
}
