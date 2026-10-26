import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest } from '../src/manifest.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { validateReviewDemand } from '../src/review-demand.mjs';

// Independent contract checks: every state, census response and secret is synthetic.
const NOW = Date.parse('2026-10-25T08:00:00Z');
const COMPANY = 'example-company';
const REF = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555', version: 1 };
const CHECKS = ['ci-ok', 'pr-lint'];
const source = repository => ({ repositories: [repository], tokenSecretRef: { ...REF }, requiredChecks: CHECKS });

const repositoryCases = [
  ['minimum lengths', 'a/b', true],
  ['mixed case and repository punctuation', 'Example-Org/Repo_v2.0-test', true],
  ['maximum owner length', `${'a'.repeat(39)}/repo`, true],
  ['maximum repository length', `owner/${'r'.repeat(100)}`, true],
  ['both maximum lengths', `${'a'.repeat(39)}/${'r'.repeat(100)}`, true],
  ['repository leading dot', 'owner/.repo', true],
  ['repository leading dash', 'owner/-repo', true],
  ['non-traversal dots', 'owner/...', true],
  ['traversal-like owner', '../x', false],
  ['overlong owner', `${'a'.repeat(40)}/repo`, false],
  ['leading-dash owner', '-owner/repo', false],
  ['trailing-dash owner', 'owner-/repo', false],
  ['dot in owner', 'own.er/repo', false],
  ['underscore in owner', 'own_er/repo', false],
  ['single-dot repository', 'owner/.', false],
  ['double-dot repository', 'owner/..', false],
  ['overlong repository', `owner/${'r'.repeat(101)}`, false],
  ['missing owner', '/repo', false],
  ['missing repository', 'owner/', false],
  ['extra path segment', 'owner/repo/extra', false],
];

for (const [label, repository, accepted] of repositoryCases) {
  test(`repository contract: schema and runtime agree on ${label}`, () => {
    const item = manifest.instanceConfigSchema.properties.reviewDemand.properties.repositories.items;
    assert.equal(item.type, 'string');
    assert.equal(typeof item.pattern, 'string');
    const runtimeAccepted = validateReviewDemand(source(repository)).length === 0;
    assert.equal(runtimeAccepted, accepted, 'runtime positive/negative control');
    assert.equal(new RegExp(item.pattern).test(repository), runtimeAccepted,
      `schema acceptance must match runtime for ${JSON.stringify(repository)}`);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function pull(number) {
  const oid = number.toString(16).padStart(40, '0');
  return { number, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: {
      nodes: CHECKS.map(name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
      pageInfo: { hasNextPage: false },
    } } } }] } };
}

async function capsFixture({ running = 0, pause = false } = {}) {
  const gate = deferred();
  const reached = deferred();
  const calls = [];
  let censusResolved = false;
  const raw = {
    roles: { keepAgentIds: ['reviewer'] }, reviewReserve: { enabled: false },
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'codex', model: 'gpt-6.1-sol' }] },
    reviewDemand: source('example/product'),
    caps: { reservedFloors: { reviewer: { base: 4, perQueued: 20, max: 4 } } },
  };
  const store = new Map([['capacity-v1', {
    atMs: NOW, target: 8, maxTotal: 8, calibration: 'measured', demandFactor: 1,
    agentRunning: running ? { reviewer: { running } } : {}, keepAgentIds: ['reviewer'],
    keptByAgent: { reviewer: { accountId: 'meta:a' } },
    reviewerAccountIdsByAgent: { reviewer: ['codex:a'] },
    accounts: [{ accountId: 'meta:a', pool: 'meta' }, { accountId: 'codex:a', pool: 'codex' }],
    perAccount: [{ accountId: 'meta:a', slots: 0 }, { accountId: 'codex:a', slots: 8 }],
    paceGuard: { pools: [{ pool: 'meta', cap: 0 }, { pool: 'codex', cap: 8 }] },
  }]]);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    state: { get: async k => {
      if (k.stateKey === 'caps-hold-v1' && pause) {
        assert.equal(censusResolved, true, 'hold pause must occur after census resolution');
        reached.resolve();
        await gate.promise;
      }
      return store.get(k.stateKey) ?? null;
    }, set: async (k, value) => { store.set(k.stateKey, value); } },
    issues: { list: async () => [] },
    agents: { getQueuedRunCounts: async () => [{ agentId: 'reviewer', queued: 1 }] },
    jobs: { register() {} }, events: { on() {} }, logger: { info() {}, error() {} },
    secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async (url, init) => {
      assert.equal(url, 'https://api.github.com/graphql');
      calls.push(JSON.parse(init.body).variables);
      return { status: 200, json: async () => {
        censusResolved = true;
        return { data: { repository: { pullRequests: {
          nodes: Array.from({ length: 8 }, (_, i) => pull(i + 1)),
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } };
      } };
    } },
  });
  await plugin.onConfigChanged(raw, { companyId: COMPANY });
  return { plugin, raw, calls, gate, reached, read: async () => {
    const result = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
    assert.equal(result.status, 200);
    return result.body;
  } };
}

for (const running of [0, 2]) {
  test(`caps control: unchanged configuration grants above running=${running}`, async () => {
    const d = await capsFixture({ running });
    const body = await d.read();
    assert.equal(body.target, 8);
    assert.equal(body.capsError, undefined);
    assert.equal(body.floorsSuspended, false);
    assert.equal(body.reviewDemand.status, 'ok');
    assert.equal(body.reviewDemand.eligibleHeads, 8);
    const reviewer = body.agents.find(a => a.agentId === 'reviewer');
    assert.equal(reviewer.running, running);
    assert.equal(reviewer.reviewEligibleHeads, 8);
    assert.ok(reviewer.maxConcurrentRuns > running, 'fixture must authorize new work without invalidation');
  });

  for (const change of ['disable', 'replacement']) {
    test(`caps invalidation: ${change} after census preserves only running=${running}`, { timeout: 5000 }, async t => {
      const d = await capsFixture({ running, pause: true });
      t.after(() => { d.gate.resolve(); });
      const pending = d.read();
      await d.reached.promise;
      assert.deepEqual(d.calls, [{ owner: 'example', name: 'product', cursor: null }]);
      try {
        await d.plugin.onConfigChanged({ ...d.raw, reviewDemand: change === 'disable'
          ? { enabled: false } : source('example/replacement') }, { companyId: COMPANY });
      } finally {
        d.gate.resolve();
      }
      const body = await pending;
      t.diagnostic(JSON.stringify(body));
      assert.deepEqual(body.reviewDemand, {
        status: 'unavailable', eligibleHeads: 0, reason: 'configuration-changed',
      }, 'no resolved old-generation source or head count may escape');
      assert.equal(d.calls.length, 1, 'the old request must not fetch the replacement source');
      assert.deepEqual(body.reservedFloors, {}, 'old reserved floors must not authorize grants');
      assert.equal(body.agents.length, 1, 'running/heartbeat reviewer row must survive invalidation');
      for (const agent of body.agents) {
        assert.equal(agent.agentId, 'reviewer');
        assert.equal(agent.running, running);
        assert.equal(agent.maxConcurrentRuns, running, 'no old-generation slots above running');
        assert.equal(agent.allocated, running);
        assert.equal(agent.reviewEligibleHeads, 0);
        assert.equal(agent.reason, 'configuration-changed');
        assert.ok(!agent.demandSource?.includes('review-heads'), 'no stale review-head source label');
      }
      assert.deepEqual({ target: body.target, capsError: body.capsError, floorsSuspended: body.floorsSuspended }, {
        target: null, capsError: 'configuration-changed', floorsSuspended: false,
      }, 'configuration invalidation is not breaker cooling and has no current target');
    });
  }
}
