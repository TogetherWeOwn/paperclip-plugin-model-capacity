/** Pure generation-time policy verdicts, independent of the deployed hook. */
import { normalizeRegistry } from './registry.mjs';
import { buildEligibility, normalizeMinQuality, normalizeOutcomeGate } from './eligibility.mjs';
import { roleLadderAccess } from './decide.mjs';

/**
 * Reviewer uses the legacy other role. Each saved model is represented by all
 * its known effort arms: it qualifies if any variant survives the policy.
 * This is existential, not a promise that an upstream fixed profile can select
 * that effort. Slice 4 owns the runtime-effort floor guarantee and must resolve
 * upstream effort selection before claiming that guarantee.
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
      matching: arms.filter(a => a?.model === account.pools[pool.poolKey].model && typeof a.family === 'string' && a.family && a.family.toLowerCase() !== 'unknown'),
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
