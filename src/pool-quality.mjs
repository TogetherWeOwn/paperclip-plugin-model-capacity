/** Pure generation-time policy verdicts, independent of the deployed hook. */
import { normalizeRegistry } from './registry.mjs';
import { buildEligibility, normalizeMinQuality, normalizeOutcomeGate, qualityVerdicts, outcomeGates } from './eligibility.mjs';
import { roleLadderAccess, normalizeExcludedFamilies, armToken } from './decide.mjs';

/**
 * Reviewer uses the legacy other role. An explicit membership effort restricts
 * evidence to that effort; without it, the model qualifies if any known effort
 * survives. The omitted case is existential, not proof of the runner's default.
 * Runtime selection checks the host's effective effort separately and never
 * suspends a floor or borrows evidence from another effort.
 * Gate suspension follows legacy policy, scoped to the pool; onReport receives
 * its full report, including suspensions. Unknown families are never evidence.
 */
export function computePoolQualityVerdicts(rawRegistry, { arms, roles = {}, records, nowMs, roleOf, familyOf, onReport }) {
  const registry = normalizeRegistry(rawRegistry);
  if (!Array.isArray(arms) || !Array.isArray(records) || !Number.isFinite(nowMs) || typeof roleOf !== 'function' || typeof familyOf !== 'function') throw new Error('quality and outcome evidence required');
  const verdicts = new Map(registry.accounts.map(a => [a.accountKey, new Map()]));
  for (const pool of registry.pools) {
    const role = pool.role === 'reviewer' ? 'other' : pool.role;
    const candidates = registry.accounts.filter(a => a.pools[pool.poolKey]).map(account => ({
      account,
      matching: arms.filter(a => a?.model === account.pools[pool.poolKey].model
        && (account.pools[pool.poolKey].effort === undefined || a.effort === account.pools[pool.poolKey].effort)
        && typeof a.family === 'string' && a.family && a.family.toLowerCase() !== 'unknown'),
    }));
    const poolArms = [...new Set(candidates.flatMap(c => c.matching))];
    // All efforts represent the same fixed model; trial gating and rung bands
    // are not part of the pool profile. Only the quality/exclusion policy is.
    const groups = candidates.map(c => [{rung:0, arms:c.matching.map(a => ({...a, trial:false}))}]);
    const eligibility = buildEligibility({
      arms: poolArms, qualityArms: arms, records, nowMs,
      minQuality: normalizeMinQuality(roles.minQuality), outcomeGate: normalizeOutcomeGate(roles.outcomeGate),
      manual: roles.excludeFamilies, roleOf, familyOf, accountGroups: groups,
    });
    onReport?.(pool.poolKey, eligibility.report);
    for (let i=0; i<candidates.length; i++) {
      const ok = roleLadderAccess(groups[i], {role, excludedFamilies:eligibility.exclusions[role]}).eligible;
      verdicts.get(candidates[i].account.accountKey).set(pool.poolKey, ok);
    }
  }
  return Object.fromEntries([...verdicts].map(([account, pools]) => [account, Object.fromEntries(pools)]));
}

/** Call-time policy for the ACTUAL host-authorized runtime, not a model's best
 * possible effort. Upstream poolMemberRuntimeConfig (server/services/
 * ai-connection-router.ts) supplies one of these effort keys. If it supplies
 * none, the runner's default is not attested: a finite floor fails closed.
 * A null floor still requires every known variant to pass the remaining gates.
 * A fixed-profile router cannot raise effort or suspend a floor to rescue a
 * member. No IO, mutations, or provider-default guesses are permitted here.
 */
export function computeRuntimePolicySkips(params, snapshot, config, evidence) {
  const candidates = params?.candidates ?? [], nowMs = Date.parse(params?.now ?? '');
  const skipAll = () => Object.fromEntries(candidates.map(c => [c.member.id, 'quality-floor']));
  if (!evidence || !Array.isArray(evidence.arms) || !Array.isArray(evidence.records)
      || !Number.isFinite(nowMs) || !Number.isFinite(evidence.atMs)
      || nowMs - evidence.atMs < -60_000 || nowMs - evidence.atMs > (config.router?.staleSnapshotMs ?? 180_000)) return skipAll();
  const roles = config.roles ?? {}, minQuality = normalizeMinQuality(roles.minQuality);
  // Unlike generation, runtime cannot use another effort to meet the floor.
  // Even a small fleet / an empty role must never authorize a weaker effort.
  const quality = qualityVerdicts(evidence.arms, minQuality, {minFleetArms:0});
  const outcomes = outcomeGates(evidence.records, {nowMs, cfg:normalizeOutcomeGate(roles.outcomeGate),
    roleOf:evidence.roleOf ?? (() => 'other'), familyOf:evidence.familyOf ?? (r => r.family),
    excludedFamilies:roles.excludeFamilies});
  const skips = [];
  for (const c of candidates) {
    const indexed = snapshot?.memberIndex?.[c.member.id];
    const account = config.router?.accounts?.find(a => a.accountKey === indexed?.accountKey);
    const membership = account?.pools?.[indexed?.poolKey];
    const configuredRole = config.router?.pools?.find(p => p.poolKey === indexed?.poolKey)?.role;
    const role = configuredRole === 'reviewer' ? 'other' : configuredRole;
    let reason;
    if (!account || !membership || !quality[role]
        || c.runtimeConfig?.model !== `${account.prefix}/${membership.model}`) reason = 'unmapped-member';
    else {
      const efforts = ['modelReasoningEffort','reasoningEffort','effort','variant']
        .filter(k => c.runtimeConfig[k] != null).map(k => c.runtimeConfig[k]);
      const ambiguous = efforts.some(e => typeof e !== 'string' || !e || e !== efforts[0]);
      const matching = evidence.arms.filter(a => a.model === membership.model && a.family && a.family.toLowerCase() !== 'unknown'
        && (!efforts.length || a.effort === efforts[0]));
      const excluded = new Set(normalizeExcludedFamilies(roles.excludeFamilies?.[role]));
      if (ambiguous || (!efforts.length && Number.isFinite(minQuality[role])) || !matching.length || matching.some(a => quality[role][a.armId]?.ok !== true)) reason = 'quality-floor';
      else if (matching.some(a => excluded.has(a.family.toLowerCase()) || excluded.has(armToken(a.armId)))) reason = 'role-excluded';
      else if (matching.some(a => outcomes[role].gated.includes(a.family))) reason = 'outcome-gated';
    }
    if (reason) skips.push([c.member.id, reason]);
  }
  return Object.fromEntries(skips);
}
