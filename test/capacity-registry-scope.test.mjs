import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { companyId } from './support/native-api.mjs';
import { config, quotaFeed, stateHarness, NOW, HOUR, MINUTE } from './support/quota.mjs';

// The pinned lane feed is shared by every company on the instance. An account
// outside this company's registry must not reach any /capacity or /ladder field.
const OUTSIDER = 'other-company';
const OUTSIDER_MODEL = 'zz/claude-opus-4-1';

function feedWithOutsider(now) {
  const feed = quotaFeed(now);
  feed.servedModels.push(OUTSIDER_MODEL);
  feed.accounts.push({
    accountKey: OUTSIDER, provider: 'anthropic', lane: OUTSIDER, quality: 'live', health: 'healthy',
    models: [OUTSIDER_MODEL], observedAt: new Date(now).toISOString(),
    weekly: { used: 0.97, resetsAt: NOW + 84 * HOUR }, fiveHour: { used: 0.4, resetsAt: NOW + 4 * HOUR },
    credits: { balance: 42, currency: 'usd' },
    credentialAvailability: { version: 1, models: [{ model: OUTSIDER_MODEL, provider: 'anthropic',
      accountId: `anthropic:${OUTSIDER}`, servingCredentials: 1, readyCredentials: 1,
      observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 2 * MINUTE).toISOString() }] },
  });
  return feed;
}

// One tick per config; state carries over, as across a plugin upgrade.
async function run(...configs) {
  const harness = stateHarness(), jobs = new Map();
  let now = NOW, cfg = configs[0];
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    state: harness.state, logger: harness.logger, config: { get: async () => cfg },
    secrets: { resolve: async () => 'TEST_LANE_KEY' },
    http: { fetch: async () => ({ status: 200, json: async () => feedWithOutsider(now) }) },
    jobs: { register: (key, fn) => jobs.set(key, fn) }, events: { on: () => {} },
    agents: { get: async () => null, list: async () => [] }, issues: { get: async () => null, list: async () => [] },
  });
  for (const [i, next] of configs.entries()) {
    now = NOW + i * MINUTE; cfg = next;
    await plugin.onConfigChanged(cfg, { companyId });
    await jobs.get('quota-refresh')({});
  }
  const get = async routeKey => (await plugin.onApiRequest({ companyId, routeKey })).body;
  return { capacity: await get('capacity'), ladder: await get('ladder'), store: harness.store };
}

const noRegistry = () => { const cfg = config(); delete cfg.router; return cfg; };

// JSON paths of every object key or string value naming the outsider.
function findOutsider(value, path = '$', hits = []) {
  const names = s => s.includes(OUTSIDER) || s.includes(OUTSIDER_MODEL);
  if (typeof value === 'string') {
    if (names(value)) hits.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findOutsider(v, `${path}[${i}]`, hits));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (names(k)) hits.push(`${path}.${k} (key)`);
      findOutsider(v, `${path}.${k}`, hits);
    }
  }
  return hits;
}

test('with a router registry, /capacity and /ladder carry no lane account outside it', async () => {
  const { capacity, ladder } = await run(config());
  assert.ok(capacity.accounts.length > 0, 'registered accounts are still reported');
  assert.ok(Object.keys(ladder.ladders).length > 0, 'registered ladders are still reported');
  assert.deepEqual(findOutsider(capacity), [], 'capacity');
  assert.deepEqual(findOutsider(ladder), [], 'ladder');
});

test('state saved before the registry scope cannot resurface an unregistered account', async () => {
  const { capacity, ladder, store } = await run(noRegistry(), config());
  assert.deepEqual(findOutsider(capacity), [], 'capacity (no capacityChange.removed entry)');
  assert.deepEqual(findOutsider(ladder), [], 'ladder');
  const legacyState = [...store].filter(([key]) => JSON.parse(key).stateKey !== 'router-quota-v1');
  assert.deepEqual(legacyState.flatMap(([key, v]) => findOutsider(v, JSON.parse(key).stateKey)), [], 'persisted legacy state');
});

test('without a router registry the lane key decides scope: every feed account is reported', async () => {
  const { capacity, ladder } = await run(noRegistry());
  assert.ok(findOutsider(capacity).length > 0);
  assert.ok(Object.keys(ladder.ladders).some(k => k.endsWith(`:${OUTSIDER}`)));
});
