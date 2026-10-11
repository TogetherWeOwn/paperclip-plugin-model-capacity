/** Counts-only credential readiness. No credential identities or error text. */
export const CREDENTIAL_MAX_AGE_MS = 120000;
const MAX_MODELS = 2048;
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  // Date.parse normalizes impossible calendar days: they are not evidence.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : null;
}
const identity = value => typeof value === 'string' && value.length > 0
  && value.length <= 512 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Validate once at the feed boundary; allowlist fields, never retain raw rows. */
export function parseCredentialAvailability(raw, { accountId, provider, nowMs = Date.now() } = {}) {
  if (raw === undefined) return { status: 'missing', models: [] };
  if (!raw || raw.version !== 1 || !Array.isArray(raw.models) || raw.models.length > MAX_MODELS) {
    return { status: 'malformed', models: [] };
  }
  const models = [];
  const seen = new Set();
  for (const row of raw.models) {
    // An unidentifiable row could contradict any model: fail this envelope,
    // not an invented empty authoritative list. Identifiable bad rows only
    // close their exact model; unrelated valid rows remain usable.
    if (!identity(row?.model)) return { status: 'malformed', models: [] };
    const observedAtMs = timestamp(row.observedAt);
    const expiresAtMs = timestamp(row.expiresAt);
    const valid = identity(provider) && identity(accountId)
      && row.provider === provider && row.accountId === accountId
      && count(row.servingCredentials) && count(row.readyCredentials)
      && row.readyCredentials <= row.servingCredentials
      && observedAtMs != null && expiresAtMs != null && expiresAtMs > observedAtMs;
    if (seen.has(row.model)) {
      const prior = models.find(m => m.model === row.model);
      prior.status = 'malformed';
      continue;
    }
    seen.add(row.model);
    if (valid && (!Number.isFinite(nowMs) || observedAtMs > nowMs)) {
      models.push({ model: row.model, status: 'future' });
      continue;
    }
    models.push(valid ? {
      model: row.model, provider, accountId, status: 'valid',
      servingCredentials: row.servingCredentials, readyCredentials: row.readyCredentials,
      observedAtMs, expiresAtMs: Math.min(expiresAtMs, observedAtMs + CREDENTIAL_MAX_AGE_MS),
    } : { model: row.model, status: 'malformed' });
  }
  return { version: 1, status: 'valid', models };
}

/** Exact proxy request identity only: no provider-prefix or alias normalization. */
export function credentialEvidenceFor(account, model) {
  const evidence = account?.credentialAvailability;
  if (evidence?.status !== 'valid') return { status: evidence?.status ?? 'missing' };
  return evidence.models.find(row => row.model === model) ?? { status: 'missing-model' };
}

/** Expiry NEVER implies recovery. Only a new ready observation opens an arm. */
export function credentialReadiness(evidence, nowMs) {
  if (evidence?.status !== 'valid') return { eligible: false, reason: evidence?.status ?? 'missing' };
  if (!Number.isFinite(nowMs) || nowMs < evidence.observedAtMs) return { eligible: false, reason: 'future' };
  if (nowMs >= evidence.expiresAtMs) return { eligible: false, reason: 'expired' };
  if (evidence.servingCredentials === 0) return { eligible: false, reason: 'zero-serving' };
  if (evidence.readyCredentials === 0) return { eligible: false, reason: 'all-cooling' };
  return { eligible: true, reason: 'ready' };
}

/** Preserve rung numbers/role windows while narrowing arms before placement. */
export function filterCredentialRungs(groups, nowMs) {
  return (groups ?? []).map(group => ({
    ...group, arms: (group.arms ?? []).filter(arm => credentialReadiness(arm.credentialEvidence, nowMs).eligible),
  }));
}
