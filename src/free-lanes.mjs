/** Additive free capacity. Pure policy; the existing tick owns persistence. */
import { isInflight } from './ledger.mjs';
import { applyReservedFloors } from './concurrency.mjs';

const object = v => v != null && typeof v === 'object' && !Array.isArray(v);
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const strings = v => Array.isArray(v) && v.every(s => typeof s === 'string' && s.trim().length > 0);
const day = nowMs => new Date(nowMs).toISOString().slice(0, 10);
const own = (o, k) => Object.hasOwn(o ?? {}, k) ? o[k] : undefined;
const set = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

export function normalizeFreeLanes(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    // Fleet-normalized AA/EEE Q, not an AA Intelligence Index percentage.
    minQuality: Number.isFinite(raw?.minQuality) ? raw.minQuality : 0.4,
    lowRiskAgentIds: strings(raw?.lowRiskAgentIds) ? [...new Set(raw.lowRiskAgentIds)] : [],
    providers: Object.fromEntries(Object.entries(object(raw?.providers) ? raw.providers : {}).map(([p, v]) =>
      [p.trim().toLowerCase(), { requestsPerMinute: v?.requestsPerMinute,
        requestsPerMinutePerSlot: v?.requestsPerMinutePerSlot ?? 12,
        ...(v?.requestsPerDay != null ? { requestsPerDay: v.requestsPerDay, requestsPerRun: v.requestsPerRun } : {}),
      }])),
    demotion: { lastRuns: raw?.demotion?.lastRuns ?? 10, minSuccessRate: raw?.demotion?.minSuccessRate ?? 0.8,
      windowHours: raw?.demotion?.windowHours ?? 24 },
  };
}

export function validateFreeLanes(raw) {
  if (raw == null) return [];
  if (!object(raw)) return ['freeLanes must be an object'];
  const errors = [];
  if ('enabled' in raw && typeof raw.enabled !== 'boolean') errors.push('freeLanes.enabled must be boolean');
  if ('minQuality' in raw && !Number.isFinite(raw.minQuality)) errors.push('freeLanes.minQuality must be finite');
  if ('lowRiskAgentIds' in raw && !strings(raw.lowRiskAgentIds)) errors.push('freeLanes.lowRiskAgentIds must contain non-empty agent ids');
  if ('providers' in raw && !object(raw.providers)) errors.push('freeLanes.providers must be an object');
  const seen = new Set();
  for (const [p, v] of Object.entries(object(raw.providers) ? raw.providers : {})) {
    const key = p.trim().toLowerCase();
    if (!key || seen.has(key)) errors.push('freeLanes.providers must have unique non-empty provider names');
    seen.add(key);
    if (!object(v) || !positive(v.requestsPerMinute)
      || ('requestsPerMinutePerSlot' in v && !positive(v.requestsPerMinutePerSlot))
      || ('requestsPerDay' in v && (!Number.isInteger(v.requestsPerDay) || v.requestsPerDay < 1 || !positive(v.requestsPerRun)))) {
      errors.push(`freeLanes.providers[${JSON.stringify(p)}] needs finite positive request limits and a requestsPerRun estimate with requestsPerDay`);
    }
  }
  if ('demotion' in raw) {
    const d = raw.demotion;
    if (!object(d) || ('lastRuns' in d && (!Number.isInteger(d.lastRuns) || d.lastRuns < 1 || d.lastRuns > 1000))
      || ('minSuccessRate' in d && !(Number.isFinite(d.minSuccessRate) && d.minSuccessRate >= 0 && d.minSuccessRate <= 1))
      || ('windowHours' in d && !(positive(d.windowHours) && d.windowHours <= 24))) {
      errors.push('freeLanes.demotion needs lastRuns in [1,1000], minSuccessRate in [0,1], windowHours in (0,24]');
    }
  }
  return errors;
}

/** Model requests happen inside runs. This is a slot estimate, NOT an API limiter. */
export function providerSlots(limits) {
  return positive(limits?.requestsPerMinute) && positive(limits?.requestsPerMinutePerSlot ?? 12)
    ? Math.floor(limits.requestsPerMinute / (limits.requestsPerMinutePerSlot ?? 12)) : 0;
}

export function freeProvider(account, config) {
  if (config?.enabled !== true || account?.freeCost !== true) return null;
  const p = String(account.laneProvider ?? account.provider ?? '').trim().toLowerCase();
  // Synthetic is paid. The feed has no free-neuron remainder for Workers AI:
  // fail closed rather than silently grant permission for overage billing.
  if (p.startsWith('synthetic') || p.startsWith('cloudflare')) return null;
  return own(config.providers, p) ? p : null;
}

/** No title/NL classifier and no assumption that a monitor/comment wake is safe. */
export function lowRiskRun(params, config, { role, kept = false, reviewer = false } = {}) {
  return config?.enabled === true && ['doer', 'other'].includes(role) && !kept && !reviewer
    && typeof params?.issueId === 'string' && params.issueId.length > 0
    && typeof params?.runId === 'string' && params.runId.length > 0
    && config.lowRiskAgentIds.includes(params.agentId)
    && params.previous == null && !params.issueOverrideModel;
}

/** Operational outcome proxy, not a claim of adjudicated review acceptance. */
export function freeArmVerdict(arm, provider, records, config, nowMs) {
  if (provider?.startsWith('openrouter') && !/:free$/i.test(arm?.model ?? '')) {
    return { eligible: false, reason: 'not-an-openrouter-free-id' };
  }
  if (provider === 'nvidia-nim' && (arm?.family === 'muse' || /(?:^|\/)meta\/muse-|(?:^|\/)muse-/i.test(arm?.model ?? ''))) {
    return { eligible: false, reason: 'nim-muse-excluded' };
  }
  if (!Number.isFinite(arm?.qFleet) || arm.qFleet < config.minQuality) return { eligible: false, reason: 'free-min-quality' };
  const seen = new Set();
  const judged = [...records].filter(r => {
    if (seen.has(r?.runId) || r?.enforced !== true || r?.freeProvider !== provider || r?.armId !== arm.armId
      || !Number.isFinite(r?.terminalAt) || r.terminalAt > nowMs || nowMs - r.terminalAt > config.demotion.windowHours * 3600000) return false;
    const measured = r.status === 'failed' || (r.status === 'finished' && ['progressed', 'noChange'].includes(r.progress));
    if (measured) seen.add(r.runId);
    return measured;
  }).sort((a, b) => b.terminalAt - a.terminalAt || a.runId.localeCompare(b.runId)).slice(0, config.demotion.lastRuns);
  const successRate = judged.length ? judged.filter(r => r.status === 'finished' && r.progress === 'progressed').length / judged.length : null;
  const demoted = judged.length >= config.demotion.lastRuns && successRate < config.demotion.minSuccessRate;
  return { eligible: !demoted, reason: demoted ? 'outcome-demoted' : 'eligible', measuredRuns: judged.length, successRate };
}

export function freeLaneBudget(provider, accounts, ledger, usage, config, nowMs, selfRunId = null, horizonMs = 7200000) {
  const limits = own(config.providers, provider);
  const slots = providerSlots(limits);
  const ids = new Set(accounts.filter(a => freeProvider(a, config) === provider).map(a => a.accountId));
  let inFlight = 0;
  for (const r of ledger.values()) {
    if (r?.runId === selfRunId || !isInflight(r, nowMs, horizonMs)) continue;
    const account = r.enforced === true ? r.decidedAccount : r.actualAccount;
    if (ids.has(account)) inFlight += 1;
  }
  const reserved = usage?.day === day(nowMs) ? (own(usage.requests, provider) ?? 0) : 0;
  const dailyRemaining = limits?.requestsPerDay != null ? Math.max(0, limits.requestsPerDay - reserved) : null;
  const available = dailyRemaining != null && dailyRemaining < limits.requestsPerRun ? 0 : Math.max(0, slots - inFlight);
  return { slots, inFlight, available, reservedRequests: reserved, dailyRemaining };
}

/** Counts reservations even if a run fails/cancels. Persisted by the next tick, like the run ledger. */
export function reserveFreeRun(usage, provider, config, nowMs) {
  if (usage.day !== day(nowMs)) { usage.day = day(nowMs); usage.requests = {}; }
  const requests = own(config.providers, provider)?.requestsPerRun ?? 0;
  set(usage.requests, provider, (own(usage.requests, provider) ?? 0) + requests);
}

/** Free admissions have their own budget, never the paid family's trial cap. */
export function paidTrialLedger(ledger, config) {
  return config?.enabled === true
    ? new Map([...ledger].filter(([, r]) => !(r?.enforced === true && r?.freeProvider != null)))
    : ledger;
}

/** Add free headroom after paid caps, preserving all running and the process ceiling. */
export function freeLaneCaps(paid, runningByAgent, slots, allowedIds, maxTotal) {
  const allowed = new Set(allowedIds);
  const combined = paid.map(a => {
    const freeRunning = own(runningByAgent, a.agentId) ?? 0;
    return { ...a, running: a.running + freeRunning, allocated: a.allocated + freeRunning, freeAllocated: freeRunning };
  });
  const included = new Set(combined.map(a => a.agentId));
  for (const [agentId, running] of Object.entries(runningByAgent)) {
    if (running > 0 && !included.has(agentId)) combined.push({ agentId, running, queued: 0,
      allocated: running, freeAllocated: running, reason: 'floor-running' });
  }
  // A rising paid target can meet free runs admitted under an earlier tick.
  // Reuse the running-first ceiling policy: trim only not-yet-running starts,
  // never live work. Below the physical ceiling paid caps remain unchanged.
  const rows = applyReservedFloors(combined, { ceiling: maxTotal }).entries;
  const freeRunning = Object.values(runningByAgent).reduce((sum, n) => sum + n, 0);
  const allocated = rows.reduce((sum, r) => sum + r.allocated, 0);
  let extra = Math.max(0, Math.min(slots - freeRunning, maxTotal - allocated));
  const candidates = rows.filter(a => allowed.has(a.agentId)).sort((a, b) => a.agentId.localeCompare(b.agentId));
  while (extra > 0) {
    let placed = false;
    for (const a of candidates) {
      if (a.queued <= Math.max(0, a.allocated - a.running) || extra <= 0) continue;
      a.freeAllocated += 1; a.allocated += 1; extra -= 1; placed = true;
    }
    if (!placed) break;
  }
  return rows.map(a => ({ ...a, maxConcurrentRuns: a.allocated }));
}
