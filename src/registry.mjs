/** Validated, deterministic registry for native router pool membership.
 * This module is deliberately independent of the deployed routing hook.
 */
import { createHash } from 'node:crypto';

export const PLUGIN_KEY = 'togetherweown.model-capacity';
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const text = (v, name) => {
  if (typeof v !== 'string' || !v.trim() || v !== v.trim()) throw new Error(`invalid ${name}`);
  return v;
};
const key = (v, name) => {
  text(v, name);
  if (!keyPattern.test(v)) throw new Error(`invalid ${name}`);
  return v;
};
function uuid5(name, namespace) {
  const bytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(bytes).update(name, 'utf8').digest().subarray(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
// UUIDv5's namespace must itself be a UUID: derive the plugin namespace from
// the standard DNS namespace, then derive each member in that namespace.
const pluginNamespace = uuid5(PLUGIN_KEY, DNS_NAMESPACE);
export function memberIdFor(poolKey, accountKey) {
  return uuid5(`${key(poolKey, 'poolKey')}:${key(accountKey, 'accountKey')}`, pluginNamespace);
}

export function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid registry');
  text(raw.companyId, 'companyId'); text(raw.ownerUserId, 'ownerUserId');
  if (!Array.isArray(raw.accounts) || !Array.isArray(raw.pools)) throw new Error('accounts and pools must be arrays');
  const roles = new Map(), accountKeys = new Set(), prefixes = new Set(), names = new Set();
  for (const pool of raw.pools) {
    key(pool?.poolKey, 'poolKey');
    if (!['doer', 'thinker', 'reviewer'].includes(pool.role) || roles.has(pool.poolKey)) throw new Error('invalid or duplicate pool');
    roles.set(pool.poolKey, pool.role);
  }
  const index = [], accounts = raw.accounts.map(a => {
    key(a?.accountKey, 'accountKey'); key(a?.prefix, 'prefix'); text(a?.connectionName, 'connectionName');
    if (accountKeys.has(a.accountKey) || prefixes.has(a.prefix) || names.has(a.connectionName)) throw new Error('duplicate account identity');
    accountKeys.add(a.accountKey); prefixes.add(a.prefix); names.add(a.connectionName);
    if (Object.hasOwn(a, 'probeEligible')) throw new Error('probeEligible belongs to pool membership');
    if (a.harnessProfile === 'opencode' || a.harnessProfile === 'grok' || a.acpxAgent === 'grok') throw new Error('lane-excluded-by-policy');
    const valid = a.provider === 'openai' && a.protocol === 'responses' && a.harnessProfile === 'codex'
      || raw.allowMessages === true && a.provider === 'anthropic' && a.protocol === 'messages' && a.harnessProfile === 'acpx';
    if (!valid || (a.acpxAgent != null && (a.harnessProfile !== 'acpx' || a.acpxAgent !== 'claude'))) throw new Error('invalid protocol matrix');
    if (!a.pools || typeof a.pools !== 'object' || Array.isArray(a.pools)) throw new Error('invalid memberships');
    const memberships = Object.entries(a.pools).map(([poolKey, membership]) => {
      if (!roles.has(poolKey) || !membership || typeof membership !== 'object' || Array.isArray(membership)) throw new Error('invalid pool membership');
      const model = text(membership.model, 'model');
      if (model.includes('/') || `${a.prefix}/${model}`.length > 256) throw new Error('model must be unprefixed');
      if (membership.probeEligible != null && typeof membership.probeEligible !== 'boolean') throw new Error('invalid probeEligible');
      index.push([memberIdFor(poolKey,a.accountKey), {accountKey:a.accountKey,poolKey}]);
      return [poolKey, {...membership, probeEligible: membership.probeEligible ?? false}];
    });
    return {...a, pools:Object.fromEntries(memberships)};
  });
  return {...raw, accounts, poolRoles:Object.fromEntries(roles), memberIndex:Object.fromEntries(index)};
}

export function validatePoolMember(member, account) {
  const binding = member?.binding, profile = member?.profile;
  if (!binding || !['shared','delegated'].includes(binding.mode) || binding.provider !== account.provider || !['api_key','subscription'].includes(binding.method) || !uuidPattern.test(binding.connectionId ?? '') || !uuidPattern.test(binding.grantId ?? '')) throw new Error('invalid pool binding');
  if (!profile || profile.provider !== account.harnessProfile || typeof profile.model !== 'string' || !profile.model.startsWith(`${account.prefix}/`) || profile.model.length <= account.prefix.length + 1 || profile.model.length > 256) throw new Error('invalid pool profile');
  if (profile.provider === 'acpx' ? profile.acpxAgent !== 'claude' : Object.hasOwn(profile, 'acpxAgent')) throw new Error('invalid harness profile');
  return member;
}
