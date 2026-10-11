// Test-only, SYNTHETIC credential-readiness evidence for plugin integration
// fixtures. Admission is fail-closed: a lane feed with no version-1
// credentialAvailability row for the exact emitted/proxy model id admits
// nothing. These fixtures that exercise OTHER features (pacing, placement,
// caps...) therefore state, explicitly and in plain data, that every model
// they route is ready. The helper deliberately does not import the parser,
// the arm resolver, or the admission gate: it never derives actual readiness,
// it only writes the wire shape a feed would carry. Tests that need a
// non-ready state set `credentialAvailability` on the raw account themselves
// (an own key on the entry is never overwritten here).

export const SYNTHETIC_TTL_MS = 120000;

// Explicit fixture identities for the classic provider->arm bindings, used
// when a raw account carries no `models` discovery list. Exact emitted ids.
export const SYNTHETIC_CLASSIC_MODELS = Object.freeze({
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  codex: ['gpt-6.1-sol', 'gpt-6.1-luna', 'gpt-6-luna', 'gpt-6-astra'],
  meta: ['muse-spark-1.3-contributor'],
});

/** One ready row per exact model id for one raw lane account. */
export function syntheticAvailability(entry, nowMs, { models = [], serving = 1, ready = 1 } = {}) {
  const provider = entry?.provider;
  const accountId = `${provider}:${entry?.accountKey ?? entry?.lane ?? 'x'}`;
  // Bare discovery ids are exact emitted ids. Prefixed/decorated discovery
  // ids are NOT aliased: the fixture must name the bare emitted id via
  // `models` (or `emitted` on the wrapper).
  const discovered = (Array.isArray(entry?.models) ? entry.models : [])
    .filter(m => typeof m === 'string' && !/[\/()\[\]]/.test(m));
  const ids = [...new Set([...discovered, ...(SYNTHETIC_CLASSIC_MODELS[provider] ?? []), ...models])];
  return {
    version: 1,
    models: ids.map(model => ({
      model, provider, accountId,
      servingCredentials: serving, readyCredentials: ready,
      observedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + SYNTHETIC_TTL_MS).toISOString(),
    })),
  };
}

/**
 * Copy a raw lane body, adding synthetic ready evidence (observed at the
 * fixture clock) to each account that does not carry its own
 * `credentialAvailability` key. `emitted` adds extra exact ids for every
 * account, or `{ [provider]: [ids] }` per provider.
 */
export function withSyntheticReadiness(body, nowMs, { emitted = [] } = {}) {
  if (!body || !Array.isArray(body.accounts)) return body;
  return {
    ...body,
    accounts: body.accounts.map(entry => {
      if (!entry || typeof entry !== 'object' || Object.hasOwn(entry, 'credentialAvailability')) return entry;
      const extra = Array.isArray(emitted) ? emitted : (emitted[entry.provider] ?? []);
      return { ...entry, credentialAvailability: syntheticAvailability(entry, nowMs, { models: extra }) };
    }),
  };
}
