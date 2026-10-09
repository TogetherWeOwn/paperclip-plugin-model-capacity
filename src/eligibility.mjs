/**
 * Which arms may serve a role, decided from data (pure; the tick feeds it).
 *
 * Two gates replace hand-picked family bans:
 *
 *  1. Quality minimum, per role (`roles.minQuality`): an arm whose
 *     fleet-comparable quality Q is below the role's minimum is ineligible
 *     for that role on every account. Q is the same composite the ladder
 *     uses (AA metrics plus the EEE prior, same weights and blend), scored
 *     once against the whole served fleet instead of one account's arm set,
 *     so an arm has one Q per role and the minimum means the same thing on
 *     every lane. New models are scored and placed automatically.
 *
 *  2. Measured outcomes, per (family, role) (`roles.outcomeGate`): the
 *     share of the family's recent finished runs that made progress on their
 *     issue (a status move to a disposition, or a work product the run
 *     created; see outcomes.mjs). Below the bar, and clearly worse than the
 *     best family measured for the same role, the family is ineligible for
 *     that role. Recovery is by evidence aging: a gated family gets no new
 *     runs, its old ones leave the window (the ledger keeps 24h), it drops
 *     under `minRuns` and is eligible again; if it still does not do the
 *     job, `minRuns` runs later it is gated again.
 *
 * `roles.excludeFamilies` stays as an emergency override and is reported
 * with a warning while it is non-empty.
 *
 * Exclusions leave this module as TOKENS in the list the decision code
 * already honors: `muse` (a family) or `arm:<armId>` (one arm).
 *
 * Safety: the best-measured family for a role is never outcome-gated (a
 * role where every family reads low, e.g. reviewers who answer in comments,
 * keeps them all), and if the data gates would leave a role with no arm on
 * any account they are suspended for that role (reported, never a defer
 * loop); only the operator's list still applies.
 */

import { ARM_TOKEN_PREFIX, armToken, normalizeExcludedFamilies, roleLadderAccess } from './decide.mjs';
import { LEDGER_TERMINAL_TTL_MS } from './ledger.mjs';

export const ELIGIBILITY_ROLES = Object.freeze(['doer', 'thinker', 'other']);

/**
 * Defaults, proposed from data (README "Eligibility from data" has the
 * table). AA-only fleet Q on the 2026-10-09 leaderboard, over a 28-arm fleet
 * (every classic arm plus the other models the lanes serve):
 *   - doers and other agents, -1.0: gpt-oss-120b sits at about -1.75 and the
 *     weakest Luna effort at -1.07, with every Haiku/Sonnet/Opus/Sol/Astra/
 *     Muse arm above -0.5, so the floor trims only the bottom tail;
 *   - thinkers, 0.4: Opus (1.13..1.33), Sonnet max/xhigh (0.86, 0.48) and
 *     Gemini 3.1 Pro (0.83) clear it; Sol (0.31..0.35), Muse (0.32), Astra
 *     (<= 0.24), Haiku and Luna do not. That is where an internal reviewer
 *     bake-off put Claude over Codex. The line sits inside a gap of about
 *     0.1 on either side, and Q is a z-score, so it moves with the fleet:
 *     audit /capacity -> eligibility before relying on it.
 * Q cannot rank Muse low (it scores +0.3 to +0.6); only the outcome gate
 * can keep it off doers.
 */
export const DEFAULT_MIN_QUALITY = Object.freeze({ doer: -1.0, thinker: 0.4, other: -1.0 });

/**
 * Q is a z-score over the served fleet: a minimum only means something over
 * a population. Below this many scored arms (a two-arm fleet scores +-1 by
 * construction) the quality minimum is not applied and the report says so.
 */
export const MIN_FLEET_ARMS = 8;

export const DEFAULT_OUTCOME_GATE = Object.freeze({
  enabled: true,
  /** Judged runs (progressed or noChange) a family needs before it can be gated. */
  minRuns: 12,
  /** Gate when the progress rate is below this ... */
  minProgressRate: 0.5,
  /** ... AND below this fraction of the best-measured family's rate for the role. */
  relativeToBest: 0.75,
  /** Evidence window; clamped to what the ledger keeps. */
  windowHours: 24,
  /** Only the most recent N judged runs per (family, role) count. */
  lastRuns: 40,
});

/** The ledger keeps terminal runs for this long: no evidence window can be wider. */
export const MAX_WINDOW_HOURS = LEDGER_TERMINAL_TTL_MS / 3600000;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Per-role minimum: a finite number, null (no minimum for the role), else the default. */
export function normalizeMinQuality(raw) {
  const out = {};
  for (const role of ELIGIBILITY_ROLES) {
    const v = raw?.[role];
    if (v === null) out[role] = null;
    else out[role] = isFiniteNumber(v) ? v : DEFAULT_MIN_QUALITY[role];
  }
  return out;
}

export function normalizeOutcomeGate(raw) {
  const d = DEFAULT_OUTCOME_GATE;
  const int1 = (v, dflt) => (Number.isInteger(v) && v >= 1 ? v : dflt);
  const unit = (v, dflt) => (isFiniteNumber(v) && v >= 0 && v <= 1 ? v : dflt);
  const minRuns = int1(raw?.minRuns, d.minRuns);
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled,
    minRuns,
    minProgressRate: unit(raw?.minProgressRate, d.minProgressRate),
    relativeToBest: unit(raw?.relativeToBest, d.relativeToBest),
    windowHours: isFiniteNumber(raw?.windowHours) && raw.windowHours > 0
      ? Math.min(raw.windowHours, MAX_WINDOW_HOURS) : d.windowHours,
    // A family can only be judged on `minRuns` runs, so the recent-runs
    // slice is never shorter than that (a shorter one would never gate).
    lastRuns: Math.max(int1(raw?.lastRuns, d.lastRuns), minRuns),
  };
}

/** The quality an arm is judged on for a role; null when it has no score. */
export function armQuality(arm, role) {
  const q = role === 'thinker' ? (arm?.qFleetThinker ?? arm?.qFleet) : arm?.qFleet;
  return isFiniteNumber(q) ? q : null;
}

/**
 * Quality verdict per role per arm: { [role]: { [armId]: { ok, q, min,
 * reason } } }. A set minimum fails closed on an arm with no score (it
 * cannot be shown to qualify); a null minimum passes everything.
 */
export function qualityVerdicts(arms, minQuality, { minFleetArms = MIN_FLEET_ARMS } = {}) {
  const out = {};
  for (const role of ELIGIBILITY_ROLES) {
    const min = minQuality?.[role];
    // Entries, not indexed writes: arm ids come from served model ids, and
    // fromEntries defines own properties even for a key like '__proto__'.
    const entries = [];
    const scored = (arms ?? []).filter(a => armQuality(a, role) != null).length;
    const applies = isFiniteNumber(min) && scored >= minFleetArms;
    for (const arm of arms ?? []) {
      const q = armQuality(arm, role);
      let verdict;
      if (!applies) verdict = { ok: true, q, min: isFiniteNumber(min) ? min : null, reason: null };
      else if (q == null) verdict = { ok: false, q, min, reason: 'unscored' };
      else if (q < min) verdict = { ok: false, q, min, reason: `min-quality: ${q.toFixed(2)} < ${min}` };
      else verdict = { ok: true, q, min, reason: null };
      entries.push([arm.armId, verdict]);
    }
    out[role] = Object.fromEntries(entries);
  }
  return out;
}

/**
 * Outcome gate per role: { [role]: { families: { [family]: { judged,
 * progressed, rate, gated, reason } }, gated: [family], best } }.
 * records: terminal ledger records; roleOf(agentId) and familyOf(record)
 * are injected. Only finished runs with a judged outcome are evidence:
 * failed runs belong to the arm breaker, cancelled runs say nothing about
 * the model, and an unreadable outcome is not a miss.
 */
export function outcomeGates(records, { nowMs, cfg = DEFAULT_OUTCOME_GATE, roleOf, familyOf }) {
  const out = {};
  for (const role of ELIGIBILITY_ROLES) out[role] = { families: {}, gated: [], best: null };
  if (cfg?.enabled === false) return out;
  const windowMs = cfg.windowHours * 3600000;
  const runs = new Map(); // role -> family -> [{ at, runId, progressed }]
  for (const r of records ?? []) {
    if (r?.status !== 'finished') continue;
    if (r.progress !== 'progressed' && r.progress !== 'noChange') continue;
    // A future stamp (clock stepped back) is not evidence: it would outlive the window.
    if (!isFiniteNumber(r.terminalAt) || r.terminalAt > nowMs || nowMs - r.terminalAt > windowMs) continue;
    const family = familyOf(r);
    if (typeof family !== 'string' || family.length === 0 || family === 'unknown') continue;
    const role = roleOf(r.agentId);
    if (!out[role]) continue;
    let byFamily = runs.get(role);
    if (!byFamily) { byFamily = new Map(); runs.set(role, byFamily); }
    let list = byFamily.get(family);
    if (!list) { list = []; byFamily.set(family, list); }
    list.push({ at: r.terminalAt, runId: String(r.runId), progressed: r.progress === 'progressed' });
  }
  for (const role of ELIGIBILITY_ROLES) {
    const stats = new Map();
    const rows = [];
    for (const [family, list] of runs.get(role) ?? []) {
      list.sort((a, b) => (b.at - a.at) || (a.runId < b.runId ? -1 : 1));
      const recent = list.slice(0, cfg.lastRuns);
      const progressed = recent.filter(x => x.progressed).length;
      stats.set(family, { judged: recent.length, progressed, rate: progressed / recent.length });
    }
    let best = null;
    for (const [family, s] of stats) {
      if (s.judged < cfg.minRuns) continue;
      if (best == null || s.rate > best.rate || (s.rate === best.rate && family < best.family)) best = { family, rate: s.rate };
    }
    for (const [family, s] of [...stats].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      let gated = false;
      let reason;
      if (s.judged < cfg.minRuns) {
        reason = `insufficient-evidence: ${s.judged}/${cfg.minRuns} judged runs`;
      } else if (s.rate < cfg.minProgressRate && best != null && s.rate < cfg.relativeToBest * best.rate) {
        gated = true;
        reason = `progress-rate ${s.rate.toFixed(2)} < ${cfg.minProgressRate} over ${s.judged} runs `
          + `(best ${best.family} ${best.rate.toFixed(2)})`;
      } else {
        reason = 'ok';
      }
      rows.push([family, { ...s, gated, reason }]);
      if (gated) out[role].gated.push(family);
    }
    out[role].families = Object.fromEntries(rows);
    out[role].best = best;
  }
  return out;
}

/**
 * The full picture for one tick.
 *
 * arms: unique arms across the fleet's ladders ({ armId, family, model,
 *   effort, qFleet, qFleetThinker }).
 * accountGroups: per-account grouped rungs (for the empty-role guard).
 * manual: the operator's emergency list ({ doer, thinker, other } families).
 *
 * Returns { exclusions: { role: [token] }, report }.
 */
export function buildEligibility({
  arms, records, nowMs, minQuality, outcomeGate, manual, roleOf, familyOf,
  accountGroups = [], roleBands, trialRoles, minFleetArms = MIN_FLEET_ARMS,
}) {
  const quality = qualityVerdicts(arms, minQuality, { minFleetArms });
  const outcomes = outcomeGates(records, { nowMs, cfg: outcomeGate, roleOf, familyOf });
  const exclusions = {};
  const roles = {};
  const warnings = [];
  const manualByRole = {};
  const suspendedByRole = {};
  const accessible = (role, tokens) => (accountGroups ?? []).some(groups => roleLadderAccess(groups, {
    role, roleBands, excludedFamilies: tokens, trialRoles,
  }).eligible);

  for (const role of ELIGIBILITY_ROLES) {
    const manualList = normalizeExcludedFamilies(manual?.[role]);
    manualByRole[role] = manualList;
    const qualityTokens = (arms ?? []).filter(a => quality[role][a.armId]?.ok === false).map(a => armToken(a.armId));
    const outcomeTokens = outcomes[role].gated;
    // If the data gates would empty the role, give back the least trusted
    // first: the empirical outcome gate (noisy, small samples), then the
    // benchmark minimum, then both. Only the operator list is never dropped.
    const attempts = [
      { quality: true, outcome: true },
      { quality: true, outcome: false },
      { quality: false, outcome: true },
      { quality: false, outcome: false },
    ];
    const tokensFor = (a) => [...(a.quality ? qualityTokens : []), ...(a.outcome ? outcomeTokens : [])];
    let active = attempts[0];
    if (qualityTokens.length + outcomeTokens.length > 0
      && !accessible(role, [...manualList, ...tokensFor(active)]) && accessible(role, manualList)) {
      active = attempts.find(a => accessible(role, [...manualList, ...tokensFor(a)])) ?? attempts[3];
    }
    const suspendedGates = [
      ...(!active.quality && qualityTokens.length > 0 ? ['quality'] : []),
      ...(!active.outcome && outcomeTokens.length > 0 ? ['outcome'] : []),
    ];
    if (suspendedGates.length > 0) {
      warnings.push({
        code: 'role-empty-suspended',
        role,
        gates: suspendedGates,
        message: `the ${suspendedGates.join(' and ')} gate would leave no eligible arm for ${role}; suspended for this role`,
      });
    }
    suspendedByRole[role] = new Set(suspendedGates);
    const tokens = [...new Set([...manualList, ...tokensFor(active)])];
    exclusions[role] = tokens;
    roles[role] = {
      excludedFamilies: tokens.filter(t => !t.startsWith(ARM_TOKEN_PREFIX)),
      excludedArms: tokens.filter(t => t.startsWith(ARM_TOKEN_PREFIX)).map(t => t.slice(ARM_TOKEN_PREFIX.length)),
      suspended: suspendedGates.length > 0,
      suspendedGates,
      outcome: outcomes[role],
    };
  }

  for (const role of ELIGIBILITY_ROLES) {
    const scored = (arms ?? []).filter(a => armQuality(a, role) != null).length;
    if (isFiniteNumber(minQuality?.[role]) && scored < minFleetArms) {
      warnings.push({
        code: 'fleet-too-small',
        role,
        message: `only ${scored} scored arms (< ${minFleetArms}): the ${role} quality minimum is not applied`,
      });
    }
  }
  const manualRoles = Object.fromEntries(Object.entries(manualByRole).filter(([, v]) => v.length > 0));
  if (Object.keys(manualRoles).length > 0) {
    warnings.unshift({
      code: 'manual-exclusions',
      roles: manualRoles,
      message: 'roles.excludeFamilies is an emergency override; eligibility is decided by roles.minQuality and roles.outcomeGate',
    });
  }

  const armRows = (arms ?? []).map(a => {
    const eligible = {};
    for (const role of ELIGIBILITY_ROLES) {
      const reasons = [];
      let ok = true;
      if (manualByRole[role].includes(String(a.family ?? '').toLowerCase()) || manualByRole[role].includes(armToken(a.armId))) {
        ok = false;
        reasons.push(`manual-exclusion: ${a.family}`);
      }
      const qv = quality[role][a.armId];
      if (qv?.ok === false) {
        if (suspendedByRole[role].has('quality')) reasons.push(`suspended: ${qv.reason}`);
        else { ok = false; reasons.push(qv.reason); }
      }
      const og = outcomes[role].families[a.family];
      if (og?.gated) {
        if (suspendedByRole[role].has('outcome')) reasons.push(`suspended: outcome-gate: ${og.reason}`);
        else { ok = false; reasons.push(`outcome-gate: ${og.reason}`); }
      }
      eligible[role] = { ok, reasons };
    }
    return {
      armId: a.armId, family: a.family ?? null, model: a.model ?? null, effort: a.effort ?? null,
      qFleet: isFiniteNumber(a.qFleet) ? a.qFleet : null,
      qFleetThinker: isFiniteNumber(a.qFleetThinker) ? a.qFleetThinker : null,
      eligible,
    };
  }).sort((x, y) => (x.armId < y.armId ? -1 : x.armId > y.armId ? 1 : 0));

  return {
    exclusions,
    report: {
      atMs: nowMs,
      minQuality,
      outcomeGate,
      manual: manualByRole,
      warnings,
      roles,
      arms: armRows,
    },
  };
}
