import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REVIEW_DEMAND_MAX_RESPONSE_BYTES, createReviewDemandReader, normalizeReviewDemand, validateReviewDemand } from '../src/review-demand.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Independent boundary acceptance. Every secret, response and clock is a fixture;
// these tests do not establish the installed SDK/host's transport behavior.
const NOW = Date.parse('2026-10-25T08:00:00Z');
const REF = { type: 'secret_ref', secretId: '11111111-1111-1111-1111-111111111111', version: 1 };
const TOKEN = 'fixture-not-a-credential';
const CHECKS = ['ci-ok', 'pr-lint'];
const QUERY_HASH = '72401a923d18492087efe2185402714d5ba8b74f055761c6bb94fc9a2742d424';
const config = (extra = {}) => normalizeReviewDemand({ repositories: ['example/product'], tokenSecretRef: { ...REF }, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const check = name => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
function pull(number = 1) {
  const oid = number.toString(16).padStart(40, '0');
  return { number, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: {
      contexts: { nodes: CHECKS.map(check), pageInfo: { hasNextPage: false } },
    } } }] } };
}
const page = (nodes = [pull()], hasNextPage = false, endCursor = null) => ({
  data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } },
});
const response = (body = page(), status = 200, extra = {}) => ({ status, text: async () => JSON.stringify(body), ...extra });
function fixture({ fetch = async () => response(), resolve = async () => TOKEN } = {}) {
  const calls = { secrets: [], http: [], state: [], logs: [] };
  const ctx = {
    secrets: { resolve: async (...args) => { calls.secrets.push(args); return resolve(...args); } },
    http: { fetch: async (...args) => { calls.http.push(args); return fetch(...args); } },
    state: { get: async () => null, set: async (...args) => { calls.state.push(args); } },
    logger: { info: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args) },
  };
  return { ctx, calls };
}
function assertClosed(result) {
  assert.equal(result.status, 'unavailable');
  assert.equal(result.eligibleHeads, 0);
  assert.deepEqual(Object.keys(result).sort(), ['atMs', 'eligibleHeads', 'source', 'status']);
  assert.equal(result.source, 'github-current-head-checks');
}

// Transport assertions below cover the plugin's request contract only. The
// bridge drops RequestInit.redirect/signal: native source evidence is required.
test('security: destination and read-only query stay literal despite injected configuration fields', async () => {
  const f = fixture();
  const cfg = config({ repositories: ['Example/Product', 'example/product', 'Example/Other'],
    url: 'https://sink.example.com/graphql', endpoint: 'https://sink.example.com',
    query: 'mutation { forbidden }', token: 'untrusted-inline-value', headers: { Authorization: 'untrusted-inline-value' } });
  const result = await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', cfg);
  assert.equal(result.status, 'ok');
  assert.equal(f.calls.secrets.length, 1);
  assert.deepEqual(f.calls.secrets[0], [REF, { companyId: 'tenant-a', configPath: 'reviewDemand.tokenSecretRef' }]);
  assert.equal(f.calls.http.length, 2, 'case-insensitive canonicalization and deduplication');
  const seen = [];
  for (const [url, init] of f.calls.http) {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual', 'request intent only, not host redirect proof');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    const { query, variables, ...rest } = JSON.parse(init.body);
    assert.deepEqual(rest, {});
    assert.equal(createHash('sha256').update(query).digest('hex'), QUERY_HASH);
    assert.match(query, /^query ReviewDemand\(/);
    assert.doesNotMatch(query, /\b(mutation|subscription)\b/);
    assert.match(query, /pullRequests\(first:100,/);
    assert.match(query, /contexts\(first:100\)/);
    assert.deepEqual(Object.keys(variables).sort(), ['cursor', 'name', 'owner']);
    seen.push(variables);
    assert.ok(!init.body.includes(TOKEN));
    assert.ok(!JSON.stringify(init).includes('untrusted-inline-value'));
  }
  assert.deepEqual(seen, [{ owner: 'example', name: 'other', cursor: null }, { owner: 'example', name: 'product', cursor: null }]);
  assert.deepEqual(Object.keys(result).sort(), ['atMs', 'eligibleHeads', 'source', 'status']);
  assert.deepEqual(f.calls.state, []);
  assert.deepEqual(f.calls.logs, []);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('security: absent, disabled and invalid normalized configuration start no secret or HTTP work', async () => {
  const f = fixture();
  const read = createReviewDemandReader({ clock: () => NOW });
  for (const cfg of [undefined, null, config({ enabled: false }), config({ repositories: [] }), config({ tokenSecretRef: null })]) {
    assert.deepEqual(await read(f.ctx, 'tenant-a', cfg), { status: 'disabled', eligibleHeads: 0 });
  }
  assert.deepEqual(f.calls.secrets, []);
  assert.deepEqual(f.calls.http, []);
});

for (const [label, resolve] of [
  ['denied', async () => { throw new Error('private-secret-detail'); }],
  ['empty', async () => ''], ['non-string', async () => ({ token: TOKEN })],
]) {
  test(`security: ${label} secret refuses census without any alternate identity or HTTP`, async () => {
    const f = fixture({ resolve });
    assertClosed(await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config()));
    assert.equal(f.calls.secrets.length, 1);
    assert.equal(f.calls.http.length, 0);
    assert.deepEqual(f.calls.logs, []);
  });
}

for (const status of [301, 302, 303, 307, 308, 401, 403, 429, 500]) {
  test(`security: HTTP ${status} stops without body parsing, redirect following or retry`, async () => {
    let parsed = 0;
    const f = fixture({ fetch: async () => response(page(), status, {
      headers: new Headers({ Location: 'https://sink.example.com/graphql', 'Retry-After': '1' }),
      text: async () => { parsed++; return JSON.stringify(page()); },
    }) });
    assertClosed(await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config()));
    assert.equal(f.calls.secrets.length, 1);
    assert.equal(f.calls.http.length, 1);
    assert.equal(parsed, 0);
  });
}

for (const [label, fetch] of [
  ['network rejection', async () => { throw new Error(`private-upstream-${TOKEN}`); }],
  ['invalid JSON', async () => response(null, 200, { text: async () => '{"private-json-detail' })],
  ['followed response', async () => response(page(), 200, { redirected: true })],
  ['GraphQL partial error', async () => response({ ...page(), errors: [{ message: `private-upstream-${TOKEN}` }] })],
  ['missing repository', async () => response({ data: { repository: null } })],
  ['missing pagination evidence', async () => response({ data: { repository: { pullRequests: { nodes: [pull()], pageInfo: {} } } } })],
  ['oversize PR page', async () => response(page(Array.from({ length: 101 }, (_, i) => pull(i + 1))))],
]) {
  test(`security: ${label} is closed and sanitized, never retried or stored`, async () => {
    const f = fixture({ fetch });
    const result = await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config());
    assertClosed(result);
    assert.equal(f.calls.secrets.length, 1);
    assert.equal(f.calls.http.length, 1);
    assert.deepEqual(f.calls.logs, []);
    assert.deepEqual(f.calls.state, []);
    assert.doesNotMatch(JSON.stringify(result), /private-|fixture-not-a-credential/);
  });
}

test('security: the census asks the host for a byte cap and refuses an oversized page before parsing', async () => {
  let parsed = 0;
  const declared = response(page(), 200, {
    headers: new Headers({ 'content-length': String(REVIEW_DEMAND_MAX_RESPONSE_BYTES + 1) }),
    text: async () => { parsed++; return JSON.stringify(page()); },
  });
  const endless = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
  }), { status: 200 });
  for (const res of [declared, endless]) {
    const f = fixture({ fetch: async () => res });
    assertClosed(await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config()));
    assert.equal(f.calls.http[0][1].maxResponseBytes, REVIEW_DEMAND_MAX_RESPONSE_BYTES);
  }
  assert.equal(parsed, 0);
});

test('security: second-page failure discards first-page positives and remaining repositories', async () => {
  let pages = 0;
  const f = fixture({ fetch: async () => ++pages === 1
    ? response(page([pull()], true, 'page-two')) : response(page(), 403) });
  const result = await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config({ repositories: ['example/a', 'example/b'] }));
  assertClosed(result);
  assert.equal(f.calls.http.length, 2);
});

test('security: page requests are sequential and the total 50-page budget spans repositories', async () => {
  let active = 0;
  let maximum = 0;
  let count = 0;
  const f = fixture({ fetch: async (_url, init) => {
    active++; maximum = Math.max(maximum, active);
    await flush();
    const { name } = JSON.parse(init.body).variables;
    count++;
    return response(null, 200, { text: async () => {
      active--;
      return JSON.stringify(page([pull(count)], name === 'b' || count < 25, `cursor-${count}`));
    } });
  } });
  assertClosed(await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config({ repositories: ['example/a', 'example/b'] })));
  assert.equal(f.calls.http.length, 50);
  assert.equal(maximum, 1);
});

test('security: exactly 50 complete pages may succeed and count each PR head only once', async () => {
  let count = 0;
  const f = fixture({ fetch: async () => {
    count++;
    return response(page([pull(1), pull(count)], count < 50, `cursor-${count}`));
  } });
  const result = await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config());
  assert.equal(result.status, 'ok');
  assert.equal(result.eligibleHeads, 50);
  assert.equal(f.calls.http.length, 50);
});

for (const cursor of [null, '', 7]) {
  test(`security: invalid cursor ${JSON.stringify(cursor)} refuses subsequent pages`, async () => {
    const f = fixture({ fetch: async () => response(page([pull()], true, cursor)) });
    assertClosed(await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config()));
    assert.equal(f.calls.http.length, 1);
  });
}

test('security: repeated cursors refuse the census instead of looping', async () => {
  const f = fixture({ fetch: async () => response(page([pull()], true, 'same-cursor')) });
  assertClosed(await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config()));
  assert.equal(f.calls.http.length, 2);
});

test('security: cursor text stays opaque variable data and never alters the fixed query', async () => {
  const cursor = 'opaque\" ) { mutation }\\\nvalue';
  const f = fixture({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(createHash('sha256').update(body.query).digest('hex'), QUERY_HASH);
    if (body.variables.cursor === null) return response(page([pull()], true, cursor));
    assert.equal(body.variables.cursor, cursor);
    return response(page([pull(2)]));
  } });
  const result = await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config());
  assert.equal(result.eligibleHeads, 2);
  assert.deepEqual(f.calls.logs, []);
});

test('security: oversized upstream cursor is refused before it can be sent back', async () => {
  const f = fixture({ fetch: async (_url, init) => JSON.parse(init.body).variables.cursor === null
    ? response(page([pull()], true, 'x'.repeat(65_536))) : response(page([pull(2)])) });
  const result = await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config());
  assertClosed(result);
  assert.equal(f.calls.http.length, 1);
});

test('security: repository configuration is canonical, deduplicated and bounded to 1-25', () => {
  assert.equal(config({ repositories: [] }), null);
  assert.equal(config({ repositories: Array.from({ length: 26 }, (_, i) => `example/r${i}`) }), null);
  assert.equal(config({ repositories: Array.from({ length: 25 }, (_, i) => `example/r${i}`) }).repositories.length, 25);
  assert.deepEqual(config({ repositories: ['Example/B', 'example/a', 'example/b'] }).repositories, ['example/a', 'example/b']);
  for (const repository of ['example/a/b', 'example/a?b', 'example/a#b', 'example/a b', 'éxample/a', '/a', 'example/']) {
    assert.ok(validateReviewDemand({ repositories: [repository], tokenSecretRef: REF }).length > 0, repository);
  }
});

for (const [label, repository] of [
  ['overlong owner', `${'o'.repeat(1024)}/product`],
  ['overlong repository', `example/${'r'.repeat(1024)}`],
]) {
  test(`security: ${label} is rejected rather than interpolated into a request`, () => {
    assert.equal(config({ repositories: [repository] }), null);
  });
}

for (const [label, change] of [
  ['truncated contexts', p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true; }],
  ['missing contexts', p => { delete p.commits.nodes[0].commit.statusCheckRollup.contexts; }],
  ['wrong head', p => { p.commits.nodes[0].commit.oid = 'f'.repeat(40); }],
  ['missing required check', p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.pop(); }],
  ['oversize contexts', p => { p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push(...Array.from({ length: 99 }, (_, i) => check(`extra-${i}`))); }],
]) {
  test(`security: ${label} cannot qualify a head`, async () => {
    const p = pull(); change(p);
    const f = fixture({ fetch: async () => response(page([p])) });
    const result = await createReviewDemandReader({ clock: () => NOW })(f.ctx, 'tenant-a', config());
    assert.equal(result.eligibleHeads, 0);
  });
}

test('security: company, full configuration and explicit secret version isolate single-flight results', async () => {
  const read = createReviewDemandReader({ clock: () => NOW });
  const first = deferred();
  let count = 0;
  const f = fixture({ fetch: async () => ++count === 1 ? first.promise : response(page([])) });
  const cfg = config();
  const a = read(f.ctx, 'tenant-a', cfg);
  await flush();
  const same = read(f.ctx, 'tenant-a', structuredClone(cfg));
  const other = await read(f.ctx, 'tenant-b', cfg);
  assert.equal(other.eligibleHeads, 0);
  assert.equal(f.calls.http.length, 2);
  first.resolve(response(page([pull()])));
  assert.equal((await a).eligibleHeads, 1);
  assert.equal((await same).eligibleHeads, 1);
  for (const changed of [config({ repositories: ['example/other'] }),
    config({ requiredChecks: ['other-check'] }), config({ tokenSecretRef: { ...REF, version: 2 } }),
    config({ tokenSecretRef: { ...REF, secretId: '22222222-2222-2222-2222-222222222222' } })]) {
    const before = f.calls.http.length;
    assert.equal((await read(f.ctx, 'tenant-a', changed)).eligibleHeads, 0);
    assert.equal(f.calls.http.length, before + 1);
  }
  assert.deepEqual(f.calls.secrets.map(([, opts]) => opts.companyId), ['tenant-a', 'tenant-b', 'tenant-a', 'tenant-a', 'tenant-a', 'tenant-a']);
  assert.deepEqual(f.calls.state, []);
});

test('security: five-minute expiry fails closed, negative caching is bounded, old positives never return', async () => {
  let now = NOW;
  let fail = false;
  const read = createReviewDemandReader({ clock: () => now });
  const f = fixture({ fetch: async () => fail ? response(page(), 429) : response(page()) });
  const cfg = config();
  assert.equal((await read(f.ctx, 'tenant-a', cfg)).eligibleHeads, 1);
  now += 299_999;
  assert.equal((await read(f.ctx, 'tenant-a', cfg)).eligibleHeads, 1);
  assert.equal(f.calls.http.length, 1);
  now++; fail = true;
  assertClosed(await read(f.ctx, 'tenant-a', cfg));
  fail = false;
  now += 299_999;
  assertClosed(await read(f.ctx, 'tenant-a', cfg));
  assert.equal(f.calls.http.length, 2);
  now++;
  assert.equal((await read(f.ctx, 'tenant-a', cfg)).eligibleHeads, 1);
  assert.equal(f.calls.http.length, 3);
});

test('security: logical secret wait is at most five seconds and late resolution issues no request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const secret = deferred();
  const f = fixture({ resolve: () => secret.promise });
  const pending = createReviewDemandReader()(f.ctx, 'tenant-a', config());
  await flush();
  t.mock.timers.tick(5_001);
  await flush();
  assertClosed(await pending);
  secret.resolve(TOKEN);
  await flush();
  assert.equal(f.calls.secrets.length, 1);
  assert.equal(f.calls.http.length, 0);
});

test('security: logical page wait is at most ten seconds; late native work cannot add another page', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const http = deferred();
  const f = fixture({ fetch: () => http.promise });
  const pending = createReviewDemandReader()(f.ctx, 'tenant-a', config());
  await flush();
  t.mock.timers.tick(10_001);
  await flush();
  assertClosed(await pending);
  http.resolve(response(page([pull()], true, 'late-page')));
  await flush();
  assert.equal(f.calls.http.length, 1);
});

test('security: logical census deadline is twenty seconds across sequential pages', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const pages = [deferred(), deferred(), deferred()];
  let index = 0;
  const f = fixture({ fetch: () => pages[index++].promise });
  const pending = createReviewDemandReader()(f.ctx, 'tenant-a', config());
  await flush();
  t.mock.timers.tick(9_000);
  pages[0].resolve(response(page([pull()], true, 'second')));
  await flush();
  t.mock.timers.tick(9_000);
  pages[1].resolve(response(page([pull(2)], true, 'third')));
  await flush();
  assert.equal(f.calls.http.length, 3);
  t.mock.timers.tick(2_001);
  await flush();
  assertClosed(await pending);
  pages[2].resolve(response(page([pull(3)], true, 'fourth')));
  await flush();
  assert.equal(f.calls.http.length, 3);
});

test('security: observed disable invalidates a completed positive cache before re-enable', async () => {
  const read = createReviewDemandReader({ clock: () => NOW });
  let positive = true;
  const f = fixture({ fetch: async () => response(page(positive ? [pull()] : [])) });
  const cfg = config();
  assert.equal((await read(f.ctx, 'tenant-a', cfg)).eligibleHeads, 1);
  assert.equal((await read(f.ctx, 'tenant-a', null)).status, 'disabled');
  positive = false;
  const result = await read(f.ctx, 'tenant-a', cfg);
  assert.equal(result.eligibleHeads, 0);
  assert.equal(f.calls.http.length, 2, 're-enable must start a fresh generation');
});

test('security: observed disable during secret wait prevents the first page and pending positive publication', async () => {
  const secret = deferred();
  const read = createReviewDemandReader({ clock: () => NOW });
  const f = fixture({ resolve: () => secret.promise });
  const pending = read(f.ctx, 'tenant-a', config());
  await flush();
  assert.deepEqual(await read(f.ctx, 'tenant-a', null), { status: 'disabled', eligibleHeads: 0 });
  secret.resolve(TOKEN);
  const result = await pending;
  assert.equal(result.eligibleHeads, 0, 'invalidated callers cannot publish old positives');
  assert.equal(f.calls.http.length, 0, 'no request was in flight at disable');
});

for (const change of ['disable', 'repository', 'secret-version']) {
  test(`security: observed ${change} during first page prevents subsequent pages and old publication`, async () => {
    const gate = deferred();
    let count = 0;
    const read = createReviewDemandReader({ clock: () => NOW });
    const f = fixture({ fetch: async () => ++count === 1 ? gate.promise : response(page([])) });
    const pending = read(f.ctx, 'tenant-a', config());
    await flush();
    const changed = change === 'disable' ? null : change === 'repository'
      ? config({ repositories: ['example/other'] }) : config({ tokenSecretRef: { ...REF, version: 2 } });
    await read(f.ctx, 'tenant-a', changed);
    const issuedAtChange = f.calls.http.length;
    gate.resolve(response(page([pull()], true, 'must-not-request')));
    const result = await pending;
    assert.equal(f.calls.http.length, issuedAtChange, 'only already-issued requests may drain');
    assert.equal(result.eligibleHeads, 0, 'old generation cannot publish positives');
    assert.equal((await read(f.ctx, 'tenant-a', config())).eligibleHeads, 0, 'original configuration cannot resurrect old result');
  });
}

// Exercise local onConfigChanged directly: invalidation cannot depend on a
// second /caps caller happening to observe the updated configuration.
async function pluginFixture(fetch) {
  const f = fixture({ fetch });
  const raw = {
    roles: { keepAgentIds: ['reviewer'] },
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'codex', model: 'fixture-model' }] },
    reviewDemand: { repositories: ['example/product'], tokenSecretRef: { ...REF } },
  };
  const cap = { atMs: NOW, target: 5, maxTotal: 5, calibration: 'measured', demandFactor: 1,
    agentRunning: { reviewer: { running: 1 } }, keepAgentIds: ['reviewer'],
    keptByAgent: { reviewer: { accountId: 'codex:a' } }, reviewerAccountIdsByAgent: { reviewer: ['codex:a'] },
    accounts: [{ accountId: 'codex:a', pool: 'codex' }], perAccount: [{ accountId: 'codex:a', slots: 4 }],
    paceGuard: { pools: [{ pool: 'codex', cap: 4 }] } };
  const plugin = createModelCapacityPlugin({ clock: () => NOW });
  await plugin.setup({ ...f.ctx, state: { ...f.ctx.state, get: async key => key.stateKey === 'capacity-v1' ? cap : null },
    issues: { list: async () => [] }, agents: { getQueuedRunCounts: async () => [{ agentId: 'reviewer', queued: 2 }] },
    jobs: { register() {} }, events: { on() {} } });
  await plugin.onConfigChanged(raw, { companyId: 'tenant-a' });
  return { ...f, plugin, raw, read: async () => (await plugin.onApiRequest({ companyId: 'tenant-a', routeKey: 'caps' })).body };
}

for (const change of ['disable', 'repository', 'secret-version']) {
  test(`security: onConfigChanged ${change} invalidates a pending census without another caps read`, async () => {
    const gate = deferred();
    let count = 0;
    const f = await pluginFixture(async () => ++count === 1 ? gate.promise : response(page([])));
    const pending = f.read();
    await flush();
    assert.equal(f.calls.http.length, 1, 'fixture reached the first page');
    const raw = structuredClone(f.raw);
    if (change === 'disable') raw.reviewDemand = { enabled: false };
    if (change === 'repository') raw.reviewDemand.repositories = ['example/other'];
    if (change === 'secret-version') raw.reviewDemand.tokenSecretRef.version = 2;
    await f.plugin.onConfigChanged(raw, { companyId: 'tenant-a' });
    gate.resolve(response(page([pull()], true, 'must-not-request')));
    const body = await pending;
    assert.equal(f.calls.http.length, 1, 'no subsequent page after the local event');
    assert.equal(body.reviewDemand.eligibleHeads, 0, 'no pending old-generation publication');
  });
}

for (const change of ['disable', 'repository', 'secret-version']) {
  test(`security: onConfigChanged ${change} prevents publication of an already-issued final page`, async () => {
    const gate = deferred();
    const f = await pluginFixture(() => gate.promise);
    const pending = f.read();
    await flush();
    assert.equal(f.calls.http.length, 1);
    const raw = structuredClone(f.raw);
    if (change === 'disable') raw.reviewDemand = { enabled: false };
    if (change === 'repository') raw.reviewDemand.repositories = ['example/other'];
    if (change === 'secret-version') raw.reviewDemand.tokenSecretRef.version = 2;
    await f.plugin.onConfigChanged(raw, { companyId: 'tenant-a' });
    gate.resolve(response(page([pull()])));
    const body = await pending;
    assert.equal(body.reviewDemand.eligibleHeads, 0, 'the old final page must not become a sizing signal');
    assert.equal(f.calls.http.length, 1);
  });
}

test('security: locally disabled plugin performs no census I/O and re-enable cannot resurrect its cache', async () => {
  let positive = true;
  const f = await pluginFixture(async () => response(page(positive ? [pull()] : [])));
  assert.equal((await f.read()).reviewDemand.eligibleHeads, 1);
  const calls = { secrets: f.calls.secrets.length, http: f.calls.http.length };
  await f.plugin.onConfigChanged({ ...f.raw, reviewDemand: { enabled: false } }, { companyId: 'tenant-a' });
  assert.equal((await f.read()).reviewDemand.status, 'disabled');
  assert.equal(f.calls.secrets.length, calls.secrets);
  assert.equal(f.calls.http.length, calls.http);
  positive = false;
  await f.plugin.onConfigChanged(f.raw, { companyId: 'tenant-a' });
  assert.equal((await f.read()).reviewDemand.eligibleHeads, 0);
  assert.equal(f.calls.http.length, calls.http + 1);
});

test('security: unavailable source adds zero census demand and retains normal heartbeat queue', async () => {
  const f = await pluginFixture(async () => response(page(), 429));
  const body = await f.read();
  assert.equal(body.reviewDemand.status, 'unavailable');
  const reviewer = body.agents.find(a => a.agentId === 'reviewer');
  assert.equal(reviewer.reviewEligibleHeads, 0);
  assert.equal(reviewer.heartbeatQueued, 2);
  assert.equal(reviewer.queued, 2);
  assert.equal(f.calls.http.length, 1);
});
