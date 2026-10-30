/** Pure, synchronous decision core for the upstream AI connection router.
 * No callback is registered here: the host adapter owns logging and IO.
 */
import { orderAccountsWithPacing, DEFAULT_PLACEMENT } from './select.mjs';
import { applyInFlightOverlay } from './views.mjs';
import { accountKeyForModel } from './ledger.mjs';
import { computeRuntimePolicySkips } from './pool-quality.mjs';
import { poolHasExpectedPluginKey, verifiedPoolError } from './registry.mjs';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const allowedReasons = new Set(['quota-snapshot-stale', 'account-reading-stale', 'weekly-exhausted', 'five-hour-exhausted', 'pace-held', 'quality-floor', 'outcome-gated', 'role-excluded', 'credential-unavailable', 'burn-not-target', 'unmapped-member', 'router-disabled']);
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const candidatesOf = p => Array.isArray(p?.candidates) ? p.candidates : [];
const memberId = c => c?.member?.id;
const allSkipped = (candidates, reason) => Object.fromEntries(candidates.map(c => [memberId(c), reason]));
const nowOf = params => {
  const n = typeof params?.now === 'string' ? Date.parse(params.now) : NaN;
  return Number.isFinite(n) && Number.isFinite(new Date(n + 7 * DAY).getTime()) ? n : NaN;
};
const freshAt = (at, now, maxAge) => Number.isFinite(at) && now - at >= -60_000 && now - at <= maxAge;
const wait = (now, skipped, retry = now + MINUTE) => ({kind: 'exhausted', retryAt: new Date(clamp(retry, now + MINUTE, now + 7 * DAY)).toISOString(), skipped});
const unavailable = skipped => ({kind: 'unavailable', skipped});
const validPool = p => p && typeof p.id === 'string' && p.id.trim().length > 0 && typeof p.name === 'string' && p.name.trim().length > 0 && poolHasExpectedPluginKey(p) && Array.isArray(p.members);
const registry = config => Array.isArray(config?.router?.accounts) ? config.router.accounts : [];

export function taskKeyKind(key) {
  if (key === '__heartbeat__') return 'heartbeat';
  if (typeof key === 'string' && key.startsWith('lifecycle:')) return 'lifecycle';
  return typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key) ? 'issue' : 'other';
}

/** Operator --check supplies expected config; the host supplies current call
 * metadata. Never trust snapshot attestation, nor compare candidate-narrowed
 * pool.members to the full host memberOrder. No IO or callback-side state. */
function poolTripwire(params, config, options) {
  if (options?.syntheticShadow === true) return null;
  const entries=Array.isArray(config?.router?.pools) ? config.router.pools.filter(p=>p?.poolId===params?.pool?.id) : [];
  const entry=entries[0];
  const fail=code=>({code,entry});
  if (!entry) return fail('unverified-pool');
  if (entries.length!==1 || !entry.poolId || typeof entry.poolKey!=='string' || !entry.poolKey.trim()
      || !['doer','thinker','reviewer'].includes(entry.role) || verifiedPoolError(entry)) return fail('invalid-attestation');
  if (params.pool.pluginKey!==entry.pluginKey) return fail('plugin-key-mismatch');
  if (params.pool.revision!==entry.expectedRevision) return fail('revision-mismatch');
  if (!Array.isArray(params.memberOrder) || params.memberOrder.length!==entry.expectedMemberOrder.length
      || params.memberOrder.some((id,i)=>id!==entry.expectedMemberOrder[i])) return fail('member-order-mismatch');
  for (const c of candidatesOf(params)) {
    const expected=entry.members.find(m=>m.memberId===memberId(c));
    if (!expected) return fail('candidate-member-mismatch');
    if (c?.member?.binding?.connectionId!==expected.connectionId || c?.member?.binding?.grantId!==expected.grantId) return fail('candidate-binding-mismatch');
  }
  return null;
}

/** Side-effect-free log facts; adapter emits the indicated level, never this core. */
export function routerDiagnostics(params, snapshot, config = {}, options = {}) {
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
  if (candidates.length && Number.isFinite(nowOf(params)) && config?.router?.enabled !== false) {
    const trip=poolTripwire(params,config,options);
    if (trip) {
      d.level='error';d.tripwire=trip.code;
      if (typeof trip.entry?.poolKey==='string') d.poolKey=trip.entry.poolKey;
      if (Number.isSafeInteger(trip.entry?.expectedRevision)) d.expectedRevision=trip.entry.expectedRevision;
      if (Number.isSafeInteger(params?.pool?.revision)) d.actualRevision=params.pool.revision;
    }
  }
  return d;
}

function candidateInfo(c, snapshot, config, poolKey) {
  const indexed = snapshot.memberIndex?.[memberId(c)];
  let key = indexed?.accountKey;
  if (!key) {
    key = accountKeyForModel(c?.runtimeConfig?.model, registry(config));
  }
  return {id: memberId(c), key, account: snapshot.accounts?.[key], membership: registry(config).find(a => a.accountKey === key)?.pools?.[poolKey]};
}

function staleDelay(account, now, recheck) {
  const since = Number.isFinite(account?.staleSinceMs) ? account.staleSinceMs : now;
  const k = clamp(Math.floor((now - since) / recheck), 0, 30);
  return now + Math.min(30 * MINUTE, recheck * 2 ** k);
}
function nextTime(account, reason, now, recheck, hardCap = .995, hardCapFiveHour = .99, deadband = .02) {
  const validReset = t => Number.isFinite(t) && t > now && ['passive', 'live', 'cached'].includes(account.quality);
  if (reason === 'weekly-exhausted' && validReset(account.weeklyResetsAtMs)) {
    if (account.fiveHourUsed >= hardCapFiveHour && validReset(account.fiveHourResetsAtMs)) return {at: Math.max(account.weeklyResetsAtMs, account.fiveHourResetsAtMs), credible: true};
    return {at: account.weeklyResetsAtMs, credible: true};
  }
  if (reason === 'five-hour-exhausted' && validReset(account.fiveHourResetsAtMs)) return {at: account.fiveHourResetsAtMs, credible: true};
  if (reason === 'pace-held') {
    const solve = (used, start, end) => Number.isFinite(used) && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.ceil(start + (used - deadband) * (end - start)) : null;
    const times = [
      solve(account.weeklyUsed, account.weeklyPeriodStartMs, account.weeklyResetsAtMs),
      solve(account.fiveHourUsed, account.fiveHourResetsAtMs - 5 * HOUR, account.fiveHourResetsAtMs),
    ].filter(Number.isFinite);
    const t = times.length ? Math.max(...times) : account.nextEligibleAtMs;
    return {at: clamp(Number.isFinite(t) ? t : now + recheck, now + MINUTE, now + 30 * MINUTE), credible: true};
  }
  if (reason === 'credential-unavailable') return {at: clamp(Number.isFinite(account.nextEligibleAtMs) ? account.nextEligibleAtMs : now + recheck, now + MINUTE, now + 6 * HOUR), credible: true};
  if (reason !== 'account-reading-stale' && reason !== 'weekly-exhausted' && reason !== 'five-hour-exhausted' && Number.isFinite(account.nextEligibleAtMs) && account.nextEligibleAtMs > now) return {at: account.nextEligibleAtMs, credible: true};
  return {at: staleDelay(account, now, recheck), credible: false};
}

export function routeDecision(params, snapshot, config = {}, options = {}) {
  const now = nowOf(params), candidates = candidatesOf(params), router = config?.router ?? {};
  const inspectedKeys = new Set(candidates.map(c => snapshot?.memberIndex?.[memberId(c)]?.poolKey).filter(Boolean));
  const inspectedUnavailable = snapshot?.unavailablePoolIds?.includes(params?.pool?.id)
    || [...inspectedKeys].some(key => snapshot?.unavailablePoolKeys?.includes(key));
  if (!validPool(params?.pool) || inspectedUnavailable) return unavailable(allSkipped(candidates, 'unmapped-member'));
  if (!candidates.length) return unavailable({});
  // A pure decision cannot construct a future retry without a trustworthy clock.
  if (!Number.isFinite(now)) return unavailable(allSkipped(candidates, 'quota-snapshot-stale'));
  if (router.enabled === false) return wait(now, allSkipped(candidates, 'router-disabled'));
  if (poolTripwire(params,config,options)) return unavailable(allSkipped(candidates, 'unmapped-member'));
  if (!snapshot || !freshAt(snapshot.atMs, now, router.staleSnapshotMs ?? 180_000)) return wait(now, allSkipped(candidates, 'quota-snapshot-stale'));
  const pin = params.pinnedMemberId;
  if (pin && !candidates.some(c => memberId(c) === pin)) return unavailable(allSkipped(candidates, 'unmapped-member'));
  const poolKeys = new Set(candidates.map(c => snapshot.memberIndex?.[memberId(c)]?.poolKey).filter(k => typeof k === 'string'));
  const poolKey = poolKeys.size === 1 ? [...poolKeys][0] : null;
  const infos = (pin ? candidates.filter(c => memberId(c) === pin) : candidates).map(c => candidateInfo(c, snapshot, config, poolKey));
  const kind = taskKeyKind(params.taskKey), probe = !pin && (kind === 'heartbeat' || kind === 'lifecycle');
  const restrictProbes = probe && registry(config).some(a => a.pools?.[poolKey]?.probeEligible === true);
  const recheck = Number.isFinite(router.recheckMs) && router.recheckMs > 0 ? router.recheckMs : 5 * MINUTE;
  const hardCap = Number.isFinite(router.hardCapWeekly) ? router.hardCapWeekly : .995;
  const skipped = {}, retries = [], eligible = [];
  const feedStaleMembers = new Set(snapshot.staleMemberIds ?? []);
  const burnConfig = snapshot.burn ?? config.burn ?? router.burn ?? {};
  const burnActive = a => a?.burn?.active === true && Number.isFinite(a.burn.expiresAtMs) && now < a.burn.expiresAtMs && (!Number.isFinite(a.weeklyResetsAtMs) || now < a.weeklyResetsAtMs) && (!Number.isFinite(a.weeklyUsed) || a.weeklyUsed < (Number.isFinite(a.burn.endAtUsedPct) ? a.burn.endAtUsedPct : Number.isFinite(burnConfig.endAtUsedPct) ? burnConfig.endAtUsedPct : hardCap));
  const burnTargets = Object.values(snapshot.accounts ?? {}).filter(burnActive);
  const exclusive = !pin && !probe && burnConfig.mode === 'exclusive' && burnTargets.length > 0;
  for (const i of infos) {
    const a = i.account;
    let reason = null;
    if (!poolKey || !snapshot.poolRoles?.[poolKey] || !i.key || !a) reason = 'unmapped-member';
    else if (allowedReasons.has(snapshot.memberSkipReasons?.[i.id])) reason = snapshot.memberSkipReasons[i.id];
    else if (feedStaleMembers.has(i.id) || !['passive', 'live', 'cached'].includes(a.quality) || !freshAt(a.observedAtMs, now, router.accountStaleMs ?? 15 * MINUTE) || [a.weeklyUsed, a.fiveHourUsed].some(u => u != null && (!Number.isFinite(u) || u < 0 || u > 1))) reason = 'account-reading-stale';
    else if (a.credentialReady === false) reason = 'credential-unavailable';
    else if (Number.isFinite(a.weeklyUsed) && a.weeklyUsed >= hardCap) reason = 'weekly-exhausted';
    else if (Number.isFinite(a.fiveHourUsed) && a.fiveHourUsed >= (router.hardCapFiveHour ?? .99)) reason = 'five-hour-exhausted';
    else if (restrictProbes && i.membership?.probeEligible !== true) reason = 'role-excluded';
    else if (exclusive && !burnActive(a)) reason = 'burn-not-target';
    else if (a.eligible !== true && !(a.eligible === false && a.skipReason === 'pace-held' && burnActive(a) && !pin && !probe)) reason = allowedReasons.has(a.skipReason) ? a.skipReason : 'account-reading-stale';
    if (!reason && a.view) {
      const v = applyInFlightOverlay(a.view, config.overlayDelta?.[i.key] ?? 0);
      const burn = burnActive(a) && !pin && !probe;
      const ahead = Number.isFinite(v.planAhead) && v.planAhead > (config.pacing?.deadband ?? .02);
      const fast = Number.isFinite(v.measuredRatePerHour) && Number.isFinite(v.requiredRatePerHour) && v.measuredRatePerHour > v.requiredRatePerHour * (1 + (config.pacing?.rateDeadbandRel ?? .15));
      if (v.projectedFiveHourUsed != null && v.projectedFiveHourUsed >= (router.hardCapFiveHour ?? .99)) reason = 'five-hour-exhausted';
      else if (v.roleEligible === false) reason = 'role-excluded';
      else if (v.taskFeasible === false) reason = 'outcome-gated';
      else if (ahead && fast && !burn) reason = 'pace-held';
      else if (v.health !== 'healthy') reason = a.credentialReady === false ? 'credential-unavailable' : 'account-reading-stale';
      else if (v.headroomPct != null && v.headroomPct <= 1 - hardCap) reason = 'weekly-exhausted';
      else eligible.push({...v, pool: poolKey, burn, held:false, memberId:i.id, accountId:i.key});
    } else if (!reason) reason = 'account-reading-stale';
    if (reason) {
      skipped[i.id] = reason;
      if (!exclusive || burnActive(a)) {
        if (reason === 'unmapped-member') retries.push({at:now + MINUTE, credible:false});
        else retries.push(nextTime(a, reason, now, recheck, hardCap, router.hardCapFiveHour ?? .99, config.pacing?.deadband ?? .02));
      }
    }
  }
  if (pin && eligible.length) return {kind:'selected', memberId:pin};
  if (eligible.length) {
    const selected = orderAccountsWithPacing(eligible, {reservePct: 1 - hardCap, placement: config.placement ?? DEFAULT_PLACEMENT, pacing: null}).order;
    // The existing selector supplies placement order. Apply burn first, then
    // restrict to accounts within the relative rate deadband of the best
    // deficit; placement breaks those near ties without a non-transitive sort.
    if (selected.length) {
      const burn = selected.some(v => v.burn);
      const group = selected.filter(v => v.burn === burn);
      const best = Math.max(...group.map(v => Number.isFinite(v.deficit) ? v.deficit : 0));
      const band = Math.abs(best) * (config.pacing?.rateDeadbandRel ?? .15);
      const winner = group.find(v => (Number.isFinite(v.deficit) ? v.deficit : 0) >= best - band);
      return {kind:'selected', memberId:winner.memberId, ...(Object.keys(skipped).length ? {skipped} : {})};
    }
  }
  for (const i of infos) if (!skipped[i.id]) {skipped[i.id] = 'weekly-exhausted'; retries.push(nextTime(i.account, 'weekly-exhausted', now, recheck));}
  const credible = retries.filter(r => r.credible);
  let retry = Math.min(...(credible.length ? credible : retries).map(r => r.at));
  if (exclusive) {
    const targetTimes = burnTargets.flatMap(a => [a.burn.expiresAtMs, a.nextEligibleAtMs]).filter(t => Number.isFinite(t) && t > now);
    if (targetTimes.length) retry = Math.min(retry, ...targetTimes);
  }
  return wait(now, skipped, Number.isFinite(retry) ? retry : now + MINUTE);
}


/** SDK boundary adapter. Getters are synchronous process-local views. The
 * callback never reads SDK config/state, touches the ledger, or reserves a
 * member: a host cursor retry must be safe to discard without side effects.
 */
export function createRouterAdapter({getConfig,getSnapshot,getPolicy,getOverlay=()=>({}),getOverlayStatus=()=>({}),logger}) {
  return params => {
    const companyId=params?.companyId, snapshot=getSnapshot(companyId), config=getConfig(companyId);
    const policySkips=snapshot && config?.router?.enabled !== false
      ? computeRuntimePolicySkips(params,snapshot,config,getPolicy(companyId)) : {};
    const decisionSnapshot=snapshot ? {...snapshot,memberSkipReasons:{...policySkips,...snapshot.memberSkipReasons}} : null;
    const decisionConfig={...config,overlayDelta:getOverlay(companyId,snapshot?.version)};
    const decision=routeDecision(params,decisionSnapshot,decisionConfig);
    const {level,...diagnostics}=routerDiagnostics(params,decisionSnapshot,decisionConfig);
    const counts=new Map();
    for (const reason of Object.values(decision.skipped ?? {})) counts.set(reason,(counts.get(reason) ?? 0)+1);
    const nowMs=nowOf(params);
    const facts={...diagnostics,kind:decision.kind,
      snapshotAgeMs:snapshot && Number.isFinite(nowMs) ? nowMs-snapshot.atMs : null,
      topSkipReasons:[...counts].map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count || a.reason.localeCompare(b.reason)).slice(0,5),
      ...getOverlayStatus(companyId),
    };
    if (decision.kind==='selected') {
      facts.chosenMemberId=decision.memberId;
      const candidate=candidatesOf(params).find(c=>memberId(c)===decision.memberId);
      facts.accountKey=snapshot?.memberIndex?.[decision.memberId]?.accountKey
        ?? accountKeyForModel(candidate?.runtimeConfig?.model,registry(config));
    }
    if (decision.kind==='exhausted') facts.retryAt=decision.retryAt;
    logger?.info?.('model-capacity: native route',facts);
    if (level==='warn' || level==='error') logger?.[level]?.('model-capacity: native route configuration',facts);
    return decision;
  };
}
