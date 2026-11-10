import assert from 'node:assert/strict';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const fixtureJobs = new WeakMap();

// Allocation-only fixtures still choose their numeric inputs, but persisted
// numbers alone no longer authorize /caps. Obtain worker/config provenance
// from a real same-instance tick, never a forged epoch or production evidence.
export async function setupCapsAdmission(plugin, io, { raw = {}, cap, companyId = 'acme', nowMs }) {
  const config = { ...raw, concurrency: { ...raw.concurrency, maxTotal: cap.maxTotal ?? 75 } };
  let jobs = fixtureJobs.get(io);
  if (!jobs) {
    jobs = new Map();
    const register = io.jobs.register;
    io.jobs.register = (name, fn) => { jobs.set(name, fn); register.call(io.jobs, name, fn); };
    await plugin.setup(io);
    io.jobs.register = register;
    fixtureJobs.set(io, jobs);
    await plugin.onConfigChanged(config, { companyId });
  }
  const saved = { config: io.config, http: io.http, secrets: io.secrets, agents: io.agents };
  const ref = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
  const key = stateKey => ({ scopeKind: 'company', scopeId: companyId, namespace: 'model-capacity', stateKey });
  io.config = { get: async () => ({ ...config, cliproxy: { ...config.cliproxy, laneKeySecretRef: ref } }) };
  io.secrets = { resolve: async () => 'synthetic-only' };
  io.agents = { ...saved.agents, get: saved.agents?.get ?? (async () => null) };
  io.http = { fetch: async (url, ...args) => {
    if (!url.endsWith('/telemetry/cliproxy/live/accounts.json')) {
      if (saved.http?.fetch) return saved.http.fetch(url, ...args);
      throw Error('unexpected synthetic request');
    }
    return { status: 200, json: async () => withSyntheticReadiness({
      observedAt: new Date(nowMs).toISOString(), accounts: [{
        lane: 'synthetic', provider: 'claude', accountKey: 'synthetic', health: 'healthy',
        models: ['claude-haiku-5-5'], observedAt: new Date(nowMs).toISOString(), quality: 'live',
        weekly: { used: 0.1, resetsAt: new Date(nowMs + 7 * 86400000).toISOString() },
        fiveHour: { used: 0.1, resetsAt: new Date(nowMs + 5 * 3600000).toISOString() },
      }],
    }, nowMs) };
  } };
  await io.state.set(key('aa-snapshot-v1'), { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [],
    rows: [{ slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7 }] });
  try {
    await jobs.get('quota-refresh')({ companyId });
    const produced = await io.state.get(key('capacity-v1'));
    assert.equal(produced.atMs, nowMs, 'fixture admission requires a real published tick');
    assert.equal(typeof produced.reviewAdmissionGeneration, 'number');
    cap.reviewAdmissionGeneration = produced.reviewAdmissionGeneration;
    if (produced.reviewAdmissionEpoch != null) cap.reviewAdmissionEpoch = produced.reviewAdmissionEpoch;
    await io.state.set(key('capacity-v1'), cap);
  } finally {
    Object.assign(io, saved);
  }
}
