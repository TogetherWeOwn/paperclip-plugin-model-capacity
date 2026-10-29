/** Pure SaveInput planning only. Operator CLI is deliberately disabled until
 * live-session and per-agent selectability checks and the saga are implemented.
 */
import { pathToFileURL } from 'node:url';
import { normalizeRegistry, memberIdFor, validatePoolMember } from '../src/registry.mjs';

/** Build validated disabled pool SaveInputs using previously discovered grants.
 * Quality verdicts are required for each membership; unknown never passes.
 */
export function buildPoolPlan(raw, connectionRows, qualityVerdicts) {
  const registry = normalizeRegistry(raw);
  if (!Array.isArray(connectionRows)) throw new Error('connection discovery required');
  const resolved = new Map();
  for (const account of registry.accounts) {
    const matching = connectionRows.filter(row => row.name === account.connectionName);
    const ids = new Set(matching.map(row => row.id));
    if (ids.size > 1) throw new Error(`ambiguous connection: ${account.connectionName}`);
    const grants = matching.filter(row => row.provider === account.provider && row.method === 'api_key' && row.ownership === 'shared');
    if (grants.length > 1) throw new Error(`ambiguous grant: ${account.connectionName}`);
    if (grants.length !== 1) throw new Error(`connection or shared grant missing: ${account.connectionName}`);
    resolved.set(account.accountKey, grants[0]);
  }
  const excluded = [], pools = [];
  for (const {poolKey} of registry.pools) {
    const members = [];
    for (const account of registry.accounts) {
      const membership = account.pools[poolKey];
      if (!membership) continue;
      const verdict = qualityVerdicts?.[account.accountKey]?.[poolKey];
      if (typeof verdict !== 'boolean') throw new Error(`quality evidence missing: ${account.accountKey}/${poolKey}`);
      if (!verdict) { excluded.push({accountKey:account.accountKey,poolKey,reason:'excluded-by-policy'}); continue; }
      const connection = resolved.get(account.accountKey);
      const member = {
        id:memberIdFor(poolKey,account.accountKey),
        binding:{mode:'shared',provider:account.provider,method:'api_key',connectionId:connection.id,grantId:connection.grantId},
        profile:{provider:account.harnessProfile,...(account.harnessProfile === 'acpx' ? {acpxAgent:'claude'} : {}),model:`${account.prefix}/${membership.model}`},
      };
      validatePoolMember(member,account);
      members.push(member);
    }
    // Upstream rejects empty pools; report exclusions without emitting one.
    if (members.length) pools.push({companyId:registry.companyId,config:{name:poolKey,enabled:false,mode:'round_robin',thresholdPercent:90,members}});
  }
  return {pools,memberIndex:registry.memberIndex,poolRoles:registry.poolRoles,excluded};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('Pool generator operator CLI is not implemented; no changes were made.');
  process.exitCode = 1;
}
