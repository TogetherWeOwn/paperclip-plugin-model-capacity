/**
 * Model inventory projection: a pure, read-only view over the model ids the
 * fleet already reports. It retains the raw feed id, the canonical bare id
 * and the exact emitted id per account, and it names what is unknown instead
 * of guessing: an absent served list reads `unknown` (fail-open, as routing
 * does), protocol/tool/reasoning compatibility reads `unknown` without
 * evidence, and configured-model coverage reads `incomplete` because
 * other-agent adapter configuration is restricted.
 *
 * No routing, enforcement, inference, privilege or scheduling change rides
 * here: the tick calls this once and publishes the result on `/capacity`.
 * Classic arm-table entries whose AA slug is absent stay visible in the
 * existing `skippedArms` capacity field; this projection covers feed-reported
 * ids, matched arms and unscored models only.
 */

import { canonicalModelName, servedIdForArm, inferFamily } from './arms.mjs';

export const INVENTORY_VERSION = 1;

/**
 * Compatibility without evidence. Every model and the fleet report carry
 * this verbatim: no probe, no portability claim.
 */
export const COMPAT_UNKNOWN = Object.freeze({
  protocol: 'unknown',
  tools: 'unknown',
  reasoning: 'unknown',
  reason: 'no-evidence',
});

/** Configured-model coverage: fleet adapter configuration is restricted. */
export const CONFIGURED_MODELS_INCOMPLETE = Object.freeze({
  coverage: 'incomplete',
  reason: 'agent-config-restricted',
  detail: 'other-agent adapter configuration is restricted; no fleet-wide configured-model census is claimed',
});

const sorted = values => [...new Set(values)].sort();

function accountIdOf(account, index, accountKeys) {
  if (Array.isArray(accountKeys) && typeof accountKeys[index] === 'string') return accountKeys[index];
  return account?.accountId ?? `${account?.provider ?? 'unknown'}:x`;
}

/**
 * Build the inventory. All inputs are the tick's already-computed values;
 * nothing is fetched, probed or persisted here.
 *
 * @param {object} input
 * @param {Array} input.accounts lane accounts (with `models`, `provider`)
 * @param {Array|null} [input.accountKeys] stable per-account keys (see uniqueAccountKeys)
 * @param {Array<string>|null} [input.servedModels] exact served ids, or null when the feed publishes none
 * @param {Array} [input.arms] matched arms ({ model, aaSlug, effort })
 * @param {Array} [input.unscored] unmatched models ({ model, reason, tried })
 * @param {Array} [input.unservable] refused emissions ({ model, accountId, emitted })
 * @param {Array} [input.credentialAdmission] readiness rows ({ accountId, model, eligible, reason })
 * @param {number} input.nowMs tick time
 */
export function buildModelInventory({
  accounts = [],
  accountKeys = null,
  servedModels = null,
  arms = [],
  unscored = [],
  unservable = [],
  credentialAdmission = [],
  nowMs,
} = {}) {
  const servedListPresent = Array.isArray(servedModels);
  const servedIds = servedListPresent ? new Set(servedModels) : null;
  const list = Array.isArray(accounts) ? accounts : [];
  const matched = Array.isArray(arms) ? arms : [];
  const unmatched = Array.isArray(unscored) ? unscored : [];
  const refused = Array.isArray(unservable) ? unservable : [];
  const readinessRows = Array.isArray(credentialAdmission) ? credentialAdmission : [];

  const ids = list.map((account, i) => accountIdOf(account, i, accountKeys));
  const feedModelsAbsentAccounts = sorted(
    list.map((account, i) => (Array.isArray(account?.models) ? null : ids[i])).filter(Boolean),
  );

  // Canonical universe: feed-reported ids, matched arms, unscored models.
  const canonicals = new Set();
  const rawByCanonical = new Map();
  const addRaw = (raw, canonical) => {
    if (!canonical) return;
    canonicals.add(canonical);
    if (typeof raw === 'string' && raw.length > 0) {
      if (!rawByCanonical.has(canonical)) rawByCanonical.set(canonical, new Set());
      rawByCanonical.get(canonical).add(raw);
    }
  };
  for (const account of list) {
    for (const raw of account?.models ?? []) addRaw(raw, canonicalModelName(raw));
  }
  for (const arm of matched) {
    if (typeof arm?.model === 'string' && arm.model.length > 0) canonicals.add(arm.model);
  }
  for (const entry of unmatched) {
    if (typeof entry?.model === 'string' && entry.model.length > 0) canonicals.add(entry.model);
  }

  const armsByModel = new Map();
  for (const arm of matched) {
    if (typeof arm?.model !== 'string') continue;
    if (!armsByModel.has(arm.model)) armsByModel.set(arm.model, []);
    armsByModel.get(arm.model).push({ aaSlug: arm.aaSlug ?? null, effort: arm.effort ?? null });
  }
  for (const entries of armsByModel.values()) {
    entries.sort((a, b) => String(a.aaSlug).localeCompare(String(b.aaSlug)));
  }
  const unscoredByModel = new Map();
  for (const entry of unmatched) {
    if (typeof entry?.model === 'string' && !unscoredByModel.has(entry.model)) {
      unscoredByModel.set(entry.model, {
        reason: entry.reason ?? 'unknown',
        tried: Array.isArray(entry.tried) ? [...entry.tried] : [],
      });
    }
  }
  const refusedByModel = new Map();
  for (const entry of refused) {
    const canonical = canonicalModelName(entry?.model);
    if (!canonical) continue;
    if (!refusedByModel.has(canonical)) refusedByModel.set(canonical, []);
    refusedByModel.get(canonical).push({ accountId: entry.accountId ?? null, emitted: entry.emitted ?? null });
  }
  for (const entries of refusedByModel.values()) {
    entries.sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
  }
  const readinessByModel = new Map();
  for (const row of readinessRows) {
    if (typeof row?.model !== 'string') continue;
    if (!readinessByModel.has(row.model)) readinessByModel.set(row.model, []);
    readinessByModel.get(row.model).push({
      accountId: row.accountId ?? null,
      eligible: row.eligible === true,
      reason: row.reason ?? null,
    });
  }
  for (const entries of readinessByModel.values()) {
    entries.sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
  }

  const serves = (account, canonical) => {
    if (Array.isArray(account?.models)) {
      return account.models.map(canonicalModelName).includes(canonical);
    }
    // Feeds that predate `models`: classic arms bind by provider tag.
    return matched.some(arm => arm?.model === canonical
      && Array.isArray(arm?.providers) && arm.providers.includes(account?.provider));
  };

  let servedPresent = 0;
  let servedAbsent = 0;
  let servedUnknown = 0;
  let unscoredCount = 0;
  let unservableCount = 0;

  const models = [...canonicals].sort().map(canonical => {
    const providers = new Set();
    const servedBy = [];
    const rawIdsByAccount = {};
    const emittedByAccount = {};
    const servedIdStatusByAccount = {};
    for (let i = 0; i < list.length; i += 1) {
      const account = list[i];
      if (!serves(account, canonical)) continue;
      const accountId = ids[i];
      servedBy.push(accountId);
      rawIdsByAccount[accountId] = sorted((account?.models ?? []).filter(raw => canonicalModelName(raw) === canonical));
      if (typeof account?.provider === 'string') providers.add(account.provider);
      const emitted = servedIdForArm(account?.models, canonical, account?.provider, servedIds);
      emittedByAccount[accountId] = emitted;
      const status = servedIds == null ? 'unknown' : (servedIds.has(emitted) ? 'present' : 'absent');
      servedIdStatusByAccount[accountId] = status;
      if (status === 'present') servedPresent += 1;
      else if (status === 'absent') servedAbsent += 1;
      else servedUnknown += 1;
    }
    servedBy.sort();
    const armEntries = armsByModel.get(canonical) ?? [];
    const unscoredEntry = armEntries.length === 0 ? (unscoredByModel.get(canonical) ?? null) : null;
    if (unscoredEntry) unscoredCount += 1;
    const refusedEntries = refusedByModel.get(canonical) ?? [];
    if (refusedEntries.length > 0) unservableCount += 1;
    return {
      canonical,
      family: inferFamily(canonical),
      rawIds: sorted(rawByCanonical.get(canonical) ?? []),
      rawIdsByAccount,
      providers: [...providers].sort(),
      servedBy,
      emittedByAccount,
      servedIdStatusByAccount,
      arms: armEntries,
      unscored: unscoredEntry,
      unservable: refusedEntries,
      readiness: readinessByModel.get(canonical) ?? [],
      compatibility: { ...COMPAT_UNKNOWN },
    };
  });

  return {
    version: INVENTORY_VERSION,
    atMs: nowMs ?? null,
    servedList: { status: servedListPresent ? 'present' : 'unknown', count: servedListPresent ? servedModels.length : null },
    configuredModels: { ...CONFIGURED_MODELS_INCOMPLETE },
    compatibility: { ...COMPAT_UNKNOWN },
    feedModelsAbsentAccounts,
    counts: {
      canonicalModels: models.length,
      rawIds: models.reduce((sum, m) => sum + m.rawIds.length, 0),
      servedPresent,
      servedAbsent,
      servedUnknown,
      unscored: unscoredCount,
      unservable: unservableCount,
    },
    models,
  };
}
