/** Validated, deterministic registry for native router pool membership.
 * This module is deliberately independent of the deployed routing hook.
 */
import { createHash } from 'node:crypto';

export const PLUGIN_KEY = 'togetherweown.model-capacity';

/** Ownership predicate for upstream pool read objects. Runtime ownership is
 * checked per call; full inspection belongs to the operator --check path. */
export function poolHasExpectedPluginKey(pool) {
  return pool?.pluginKey === PLUGIN_KEY;
}
export const ROUTER_CONFIG_KEYS = Object.freeze({
  router: Object.freeze(['enabled','allowMessages','companyId','ownerUserId','staleSnapshotMs','accountStaleMs','recheckMs','hardCapWeekly','hardCapFiveHour','accounts','pools']),
  pool: Object.freeze(['poolKey','role','poolId','pluginKey','expectedRevision','expectedMemberOrder','members']),
  verifiedMember: Object.freeze(['memberId','accountKey','connectionId','grantId']),
  account: Object.freeze(['accountKey','prefix','provider','protocol','harnessProfile','acpxAgent','connectionName','feedExempt','pools']),
  membership: Object.freeze(['model','probeEligible']),
});
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

const verifiedFields = ['poolId','pluginKey','expectedRevision','expectedMemberOrder','members'];
/** Shared defensive shape check. An unverified entry is valid configuration,
 * but callers must separately require poolId before authorizing a real call. */
export function verifiedPoolError(pool) {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return 'invalid verified pool';
  if (!verifiedFields.some(k=>Object.hasOwn(pool,k))) return null;
  if (!verifiedFields.every(k=>Object.hasOwn(pool,k))) return 'partial verified pool';
  if (typeof pool.poolId !== 'string' || !uuidPattern.test(pool.poolId) || pool.pluginKey !== PLUGIN_KEY
      || !Number.isSafeInteger(pool.expectedRevision) || pool.expectedRevision < 0) return 'invalid verified pool identity';
  const order=pool.expectedMemberOrder, members=pool.members;
  if (!Array.isArray(order) || order.some(id=>typeof id !== 'string' || !uuidPattern.test(id))
      || new Set(order).size !== order.length || !Array.isArray(members)) return 'invalid verified member order';
  if (members.some(m=>!m || typeof m !== 'object' || Array.isArray(m)
      || Object.keys(m).some(k=>!ROUTER_CONFIG_KEYS.verifiedMember.includes(k))
      || ['memberId','connectionId','grantId'].some(k=>typeof m[k] !== 'string' || !uuidPattern.test(m[k]))
      || typeof m.accountKey !== 'string' || !keyPattern.test(m.accountKey))) return 'invalid verified member';
  if (order.length !== members.length || new Set(members.map(m=>m.memberId)).size !== members.length
      || members.some(m=>!order.includes(m.memberId))) return 'verified member set mismatch';
  if (['connectionId','grantId'].some(k=>new Set(members.map(m=>m[k])).size !== members.length)) return 'duplicate verified binding';
  return null;
}

export function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid registry');
  const shapeErrors = routerShapeErrors(raw);
  if (shapeErrors.length) throw new Error(shapeErrors.join('; '));
  text(raw.companyId, 'companyId'); text(raw.ownerUserId, 'ownerUserId');
  if (!uuidPattern.test(raw.companyId) || !uuidPattern.test(raw.ownerUserId)) throw new Error('companyId and ownerUserId must be UUIDs');
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
    const valid = a.provider === 'openai' && a.protocol === 'responses' && a.harnessProfile === 'codex'
      || raw.allowMessages === true && a.provider === 'anthropic' && a.protocol === 'messages' && a.harnessProfile === 'acpx';
    if (!valid || (a.acpxAgent != null && (a.harnessProfile !== 'acpx' || a.acpxAgent !== 'claude'))) throw new Error('invalid protocol matrix');
    if (!a.pools || typeof a.pools !== 'object' || Array.isArray(a.pools)) throw new Error('invalid memberships');
    const memberships = Object.entries(a.pools).map(([poolKey, membership]) => {
      if (!roles.has(poolKey) || !membership || typeof membership !== 'object' || Array.isArray(membership)) throw new Error('invalid pool membership');
      const model = text(membership.model, 'model');
      if (model.includes('/') || `${a.prefix}/${model}`.length > 256) throw new Error('model must be unprefixed');
      if (Object.hasOwn(membership, 'probeEligible') && typeof membership.probeEligible !== 'boolean') throw new Error('invalid probeEligible');
      index.push([memberIdFor(poolKey,a.accountKey), {accountKey:a.accountKey,poolKey}]);
      return [poolKey, {...membership, probeEligible: membership.probeEligible ?? false}];
    });
    return {...a, pools:Object.fromEntries(memberships)};
  });
  const poolIds=new Set();
  const pools=raw.pools.map(p=>{
    if (!Object.hasOwn(p,'poolId')) return Object.freeze({...p});
    if (poolIds.has(p.poolId)) throw new Error('duplicate verified poolId');
    poolIds.add(p.poolId);
    for (const m of p.members) {
      const a=accounts.find(a=>a.accountKey===m.accountKey);
      if (!a?.pools[p.poolKey] || m.memberId!==memberIdFor(p.poolKey,m.accountKey)) throw new Error('verified member not in registry pool');
    }
    return Object.freeze({...p,expectedMemberOrder:Object.freeze([...p.expectedMemberOrder]),
      members:Object.freeze(p.members.map(m=>Object.freeze({...m})))});
  });
  return {...raw, pools:Object.freeze(pools), accounts, poolRoles:Object.fromEntries(roles), memberIndex:Object.fromEntries(index),
    prefixByAccount:Object.fromEntries(accounts.map(a => [a.accountKey, a.prefix])),
    accountByPrefix:Object.fromEntries(accounts.map(a => [a.prefix, a.accountKey]))};
}

/** Join validated feed identities to registry members. Slice 3's per-tick
 * quota producer owns applying staleMemberIds to the published snapshot and
 * emitting warnings; an exemption is not a reading. */
export function joinRegistryFeed(registry, feed) {
  const validKey = value => typeof value === 'string' && keyPattern.test(value);
  if (!registry || !Array.isArray(registry.accounts) || !registry.memberIndex || typeof registry.memberIndex !== 'object' || Array.isArray(registry.memberIndex)
      || registry.accounts.some(a => !a || typeof a !== 'object' || Array.isArray(a) || !validKey(a.accountKey) || ('feedExempt' in a && typeof a.feedExempt !== 'boolean'))) throw new Error('invalid registry');
  const accountKeys = new Set(registry.accounts.map(a => a.accountKey));
  if (accountKeys.size !== registry.accounts.length || Object.values(registry.memberIndex).some(m => !m || !validKey(m.accountKey) || !accountKeys.has(m.accountKey) || !validKey(m.poolKey))) throw new Error('invalid registry');
  if (!Array.isArray(feed?.accounts) || feed.accounts.some(a => !a || typeof a.accountKey !== 'string' || !a.accountKey.trim() || a.accountKey !== a.accountKey.trim())) throw new Error('invalid feed accounts');
  const present = new Set(feed.accounts.map(a => a.accountKey));
  if (present.size !== feed.accounts.length) throw new Error('invalid feed accounts: duplicate accountKey');
  const missingAccountKeys = registry.accounts.filter(a => !a.feedExempt && !present.has(a.accountKey)).map(a => a.accountKey);
  const missing = new Set(missingAccountKeys);
  return {
    missingAccountKeys,
    warnings: missingAccountKeys.map(accountKey => ({accountKey, reason:'account-missing-from-feed'})),
    staleMemberIds: Object.entries(registry.memberIndex).filter(([, member]) => missing.has(member.accountKey)).map(([id]) => id),
  };
}

export function validatePoolMember(member, account) {
  const binding = member?.binding, profile = member?.profile;
  if (profile?.provider === 'opencode' || profile?.acpxAgent === 'grok') throw new Error('lane-excluded-by-policy');
  if (!binding || !['shared','delegated'].includes(binding.mode) || binding.provider !== account.provider || !['api_key','subscription'].includes(binding.method) || !uuidPattern.test(binding.connectionId ?? '') || !uuidPattern.test(binding.grantId ?? '')) throw new Error('invalid pool binding');
  if (!profile || profile.provider !== account.harnessProfile || typeof profile.model !== 'string' || !profile.model.startsWith(`${account.prefix}/`) || profile.model.length <= account.prefix.length + 1 || profile.model.length > 256) throw new Error('invalid pool profile');
  if (profile.provider === 'acpx' ? profile.acpxAgent !== 'claude' : Object.hasOwn(profile, 'acpxAgent')) throw new Error('invalid harness profile');
  return member;
}

/** Schema-shaped checks shared by generator and plugin validation. */
function routerShapeErrors(raw) {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['router must be an object'];
  const errors = [];
  const checkKeys = (obj, allowed, path) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${path}.${k} is not a known key`);
  };
  checkKeys(raw, ROUTER_CONFIG_KEYS.router, 'router');
  for (const k of ['enabled','allowMessages']) if (k in raw && typeof raw[k] !== 'boolean') errors.push(`router.${k} must be a boolean`);
  for (const k of ['companyId','ownerUserId']) if (typeof raw[k] !== 'string' || !uuidPattern.test(raw[k])) errors.push(`router.${k} must be a UUID`);
  for (const k of ['staleSnapshotMs','accountStaleMs','recheckMs']) if (k in raw && !(Number.isSafeInteger(raw[k]) && raw[k] > 0)) errors.push(`router.${k} must be a positive integer`);
  for (const k of ['hardCapWeekly','hardCapFiveHour']) if (k in raw && !(Number.isFinite(raw[k]) && raw[k] >= 0 && raw[k] <= 1)) errors.push(`router.${k} must be a number in [0, 1]`);
  if (Array.isArray(raw.pools)) for (const pool of raw.pools) {
    if (pool && typeof pool === 'object' && !Array.isArray(pool)) {
      checkKeys(pool, ROUTER_CONFIG_KEYS.pool, 'router.pools[]');
      const verifiedError=verifiedPoolError(pool);
      if (verifiedError) errors.push(`router.pools[]: ${verifiedError}`);
      if (Array.isArray(pool.members)) for (const member of pool.members) {
        if (member && typeof member === 'object' && !Array.isArray(member)) checkKeys(member, ROUTER_CONFIG_KEYS.verifiedMember, 'router.pools[].members[]');
      }
      if (typeof pool.poolKey === 'string' && pool.poolKey.length > 160) errors.push('router poolKey exceeds 160 characters');
    }
  }
  if (Array.isArray(raw.accounts)) for (const account of raw.accounts) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) continue;
    if (Object.hasOwn(account, 'probeEligible')) errors.push('probeEligible belongs to pool membership');
    checkKeys(account, ROUTER_CONFIG_KEYS.account, 'router.accounts[]');
    if (account.harnessProfile === 'opencode' || account.harnessProfile === 'grok' || account.acpxAgent === 'grok') errors.push('lane-excluded-by-policy');
    else if ('acpxAgent' in account && account.acpxAgent !== 'claude') errors.push('router account acpxAgent must be claude');
    if ('feedExempt' in account && typeof account.feedExempt !== 'boolean') errors.push('router account feedExempt must be a boolean');
    if (typeof account.connectionName === 'string' && account.connectionName.length > 160) errors.push('router connectionName exceeds 160 characters');
    if (account.pools && typeof account.pools === 'object' && !Array.isArray(account.pools)) for (const member of Object.values(account.pools)) {
      if (member && typeof member === 'object' && !Array.isArray(member)) {
        checkKeys(member, ROUTER_CONFIG_KEYS.membership, 'router membership');
        if ('probeEligible' in member && typeof member.probeEligible !== 'boolean') errors.push('router membership probeEligible must be a boolean');
      }
    }
  }
  return errors;
}

/** Validate plugin router configuration without changing the deployed hook. */
export function validateRouterConfig(raw) {
  if (raw === undefined) return [];
  const errors = routerShapeErrors(raw);
  if (errors.length) return errors;
  try { normalizeRegistry(raw); } catch (error) { errors.push(`router registry: ${error.message}`); }
  return errors;
}
