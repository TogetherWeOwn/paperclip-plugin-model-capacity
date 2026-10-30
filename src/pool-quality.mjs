/** Pure generation-time policy verdicts, independent of the deployed hook. */
import { normalizeRegistry } from './registry.mjs';
import { armQuality, normalizeMinQuality, normalizeOutcomeGate, outcomeGates } from './eligibility.mjs';
import { armToken, normalizeExcludedFamilies } from './decide.mjs';

/** Reviewer has no separate legacy eligibility role: use roles.other. */
export function computePoolQualityVerdicts(rawRegistry, { arms, roles = {}, records, nowMs, roleOf, familyOf }) {
  const registry = normalizeRegistry(rawRegistry);
  if (!Array.isArray(arms) || !Array.isArray(records) || !Number.isFinite(nowMs) || typeof roleOf !== 'function' || typeof familyOf !== 'function') throw new Error('quality and outcome evidence required');
  const minima = normalizeMinQuality(roles.minQuality);
  const gate = normalizeOutcomeGate(roles.outcomeGate);
  const verdicts = new Map(registry.accounts.map(a => [a.accountKey, new Map()]));
  for (const pool of registry.pools) {
    const role = pool.role === 'reviewer' ? 'other' : pool.role;
    const excluded = new Set(normalizeExcludedFamilies(roles.excludeFamilies?.[role]));
    const candidates = [];
    for (const account of registry.accounts) {
      const membership = account.pools[pool.poolKey];
      if (!membership) continue;
      const matching = arms.filter(a => a?.model === membership.model);
      // Several effort variants for one saved model are ambiguous. All must
      // clear the floor and exclusions; unknown evidence cannot qualify.
      const ok = matching.length > 0 && matching.every(a => {
        const family = typeof a.family === 'string' ? a.family.toLowerCase() : '';
        const q = armQuality(a, role), min = minima[role];
        return family && family !== 'unknown' && !excluded.has(family) && !excluded.has(armToken(a.armId)) && a.roleTrusted?.[role] !== false && (min === null || (q !== null && q >= min));
      });
      candidates.push({account, matching, ok: Boolean(ok)});
    }
    const usable = new Set(candidates.filter(c => c.ok).flatMap(c => c.matching.map(a => a.family.toLowerCase())));
    // The comparator must not be a family absent or ineligible in this pool.
    const skip = [...new Set(records.map(familyOf).filter(f => typeof f === 'string' && !usable.has(f.toLowerCase())))];
    const outcomes = outcomeGates(records, {nowMs, cfg:gate, roleOf, familyOf, excludedFamilies:{[role]:skip}});
    const gated = new Set(outcomes[role].gated.map(f => f.toLowerCase()));
    for (const c of candidates) verdicts.get(c.account.accountKey).set(pool.poolKey, c.ok && !c.matching.some(a => gated.has(a.family.toLowerCase())));
  }
  return Object.fromEntries([...verdicts].map(([account, pools]) => [account, Object.fromEntries(pools)]));
}
