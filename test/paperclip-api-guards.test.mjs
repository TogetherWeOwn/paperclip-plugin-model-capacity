import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperclipApi } from '../scripts/paperclip-api.mjs';

// The operator client carries the board bearer token and resolves lane API
// keys. These tests pin the guards that keep both on the intended host and
// out of logs, error messages and retained objects.
const companyId = '10000000-0000-4000-8000-000000000001';
const otherCompany = '10000000-0000-4000-8000-000000000009';
const connectionId = '10000000-0000-4000-8000-000000000002';
const agentId = '10000000-0000-4000-8000-000000000003';

function recorder(respond = () => Response.json({})) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  return { calls, fetchImpl };
}

const make = (overrides = {}) => createPaperclipApi({ target: 'https://paperclip.example', companyId,
  token: 'BOARD_DUMMY', fetchImpl: recorder().fetchImpl, ...overrides });

test('target must be HTTPS or loopback HTTP, without credentials, query, fragment or a non-API path', () => {
  for (const target of [
    'http://paperclip.example',            // plaintext bearer token to a remote host
    'http://127.0.0.1.example:3100',
    'http://localhost.evil.example',
    'https://' + 'user:pass@paperclip.example', // credentials in the URL (split so the host scan reads no host)
    'https://' + 'user@paperclip.example',
    'https://paperclip.example/?x=1',
    'https://paperclip.example/#frag',
    'https://paperclip.example/other',
    'https://paperclip.example/api/v2',
    'ftp://paperclip.example',
    'not a url',
    undefined,
  ]) {
    assert.throws(() => make({ target }), /HTTPS or loopback/, String(target));
  }
  for (const [target, origin] of [
    ['https://paperclip.example', 'https://paperclip.example'],
    ['https://paperclip.example/api', 'https://paperclip.example'],
    ['https://paperclip.example/api/', 'https://paperclip.example'],
    ['http://localhost:3100', 'http://localhost:3100'],
    ['http://127.0.0.1:3100/api', 'http://127.0.0.1:3100'],
    ['http://[::1]:3100', 'http://[::1]:3100'],
  ]) {
    assert.equal(make({ target }).target, origin, target);
  }
});

test('board token must be a non-empty single-line string with no surrounding whitespace', () => {
  for (const token of [undefined, null, '', '   ', ' BOARD', 'BOARD ', 'BOARD\r\nX-Injected: 1', 'A\nB', 42]) {
    assert.throws(() => make({ token }), /board auth is required/, JSON.stringify(token));
  }
});

test('companyId and every path ID must be a UUID, so no path segment can be injected', async () => {
  assert.throws(() => make({ companyId: '../admin' }), /invalid host object ID/);
  assert.throws(() => make({ companyId: undefined }), /invalid host object ID/);
  const { calls, fetchImpl } = recorder();
  const api = make({ fetchImpl });
  for (const bad of ['../../companies', `../${connectionId}`, `${connectionId}/grants`, `${connectionId}?x=1`, '', null]) {
    await assert.rejects(api.getConnection(bad), /invalid host object ID/);
    await assert.rejects(api.deleteConnection(bad), /invalid host object ID/);
    await assert.rejects(api.getAgent(bad), /invalid host object ID/);
    await assert.rejects(api.wakeAgent(bad, {}), /invalid host object ID/);
    await assert.rejects(api.deletePool(bad, 1), /invalid host object ID/);
  }
  assert.equal(calls.length, 0, 'no request leaves the client for a malformed ID');
});

test('company-scoped calls refuse a different company before any request', async () => {
  const { calls, fetchImpl } = recorder();
  const api = make({ fetchImpl });
  await assert.rejects(api.listConnections(otherCompany), /company mismatch/);
  await assert.rejects(api.listPools(otherCompany), /company mismatch/);
  await assert.rejects(api.listAgents(otherCompany), /company mismatch/);
  await assert.rejects(api.savePool({ companyId: otherCompany, config: {} }), /company mismatch/);
  assert.equal(calls.length, 0);
  await api.listPools(companyId);
  assert.equal(calls[0].url, `https://paperclip.example/api/companies/${companyId}/ai-connection-pools`);
});

test('lane secret refs resolve only a single own env reference with a valid name and a usable value', async () => {
  const env = { LANE_ONE: 'KEY_ONE', EMPTY: '  ', HUGE: 'x'.repeat(32769) };
  const api = make({ env, secretRefs: {
    good: { env: 'LANE_ONE' },
    extra: { env: 'LANE_ONE', value: 'INLINE' },
    file: { file: '/etc/passwd' },
    lower: { env: 'lane_one' },
    dashed: { env: 'LANE-ONE' },
    unset: { env: 'NOT_SET' },
    empty: { env: 'EMPTY' },
    huge: { env: 'HUGE' },
    nonString: { env: 42 },
  } });
  assert.doesNotThrow(() => api.assertSecretRefs(['good']));
  for (const key of ['extra', 'file', 'lower', 'dashed', 'missing', 'toString', '__proto__', 'constructor']) {
    assert.throws(() => api.assertSecretRefs([key]), /missing or invalid lane secret reference/, key);
  }
  for (const key of ['unset', 'empty', 'huge']) {
    assert.throws(() => api.assertSecretRefs([key]), /did not resolve/, key);
  }
  assert.throws(() => api.assertSecretRefs(['nonString']), /missing or invalid lane secret reference/);
  assert.throws(() => api.assertSecretRefs(['good', 'unset']), /did not resolve/, 'every key is checked, not only the first');
});

test('lane secret lookups ignore inherited properties of the refs and env objects', () => {
  const env = Object.create({ INHERITED_KEY: 'FROM_PROTOTYPE' });
  env.LANE_ONE = 'KEY_ONE';
  const api = make({ env, secretRefs: { inherited: { env: 'INHERITED_KEY' } } });
  assert.throws(() => api.assertSecretRefs(['inherited']), /did not resolve/);
  const refs = Object.create({ planted: { env: 'LANE_ONE' } });
  assert.throws(() => make({ env, secretRefs: refs }).assertSecretRefs(['planted']), /missing or invalid lane secret reference/);
});

test('createConnection refuses a plan that already carries an apiKey and sends nothing', async () => {
  const { calls, fetchImpl } = recorder();
  const api = make({ fetchImpl, env: { LANE_ONE: 'KEY_ONE' }, secretRefs: { one: { env: 'LANE_ONE' } } });
  await assert.rejects(api.createConnection({ name: 'x', apiKey: 'PLAN_SECRET' }, 'one'), /secret-bearing plans are forbidden/);
  await assert.rejects(api.createConnection({ name: 'x', apiKey: undefined }, 'one'), /secret-bearing plans are forbidden/);
  assert.equal(calls.length, 0);
});

test('updateConnection only patches name and enabled', async () => {
  const { calls, fetchImpl } = recorder();
  const api = make({ fetchImpl });
  for (const input of [{ routing: { mode: 'x' } }, { name: 'ok', apiKey: 'K' }, { config: {} }, { enabled: true, provider: 'openai' }]) {
    await assert.rejects(api.updateConnection(connectionId, input), /only connection name\/enabled/);
  }
  assert.equal(calls.length, 0);
  await api.updateConnection(connectionId, { name: 'Renamed', enabled: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Renamed', enabled: false });
});

test('transport failures never echo the token, URL credentials or the thrown error', async () => {
  const api = make({ fetchImpl: async () => { throw new Error('connect failed: Bearer BOARD_DUMMY at internal-host'); } });
  await assert.rejects(api.listPools(companyId), e => {
    assert.match(e.message, /Paperclip request failed; response\/credentials suppressed/);
    assert.doesNotMatch(e.message, /BOARD_DUMMY|internal-host/);
    return true;
  });
});

test('requests disable redirects and set a timeout signal, so the bearer token cannot follow a 3xx', async () => {
  const { calls, fetchImpl } = recorder();
  await make({ fetchImpl }).listPools(companyId);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers['Content-Type'], undefined, 'GET carries no JSON body header');
});

test('only getConnection treats 404 as absent; other reads and non-2xx statuses fail', async () => {
  const notFound = recorder(() => new Response('{"error":"PRIVATE"}', { status: 404 }));
  const api = make({ fetchImpl: notFound.fetchImpl });
  assert.equal(await api.getConnection(connectionId), null);
  await assert.rejects(api.getAgent(agentId), /HTTP 404/);
  await assert.rejects(api.getGrants(connectionId), /HTTP 404/);
  for (const status of [301, 401, 403, 500]) {
    const r = recorder(() => new Response('PRIVATE_BODY', { status }));
    await assert.rejects(make({ fetchImpl: r.fetchImpl }).getConnection(connectionId), e => {
      assert.match(e.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(e.message, /PRIVATE/);
      return true;
    });
  }
});

test('204 returns null and an unparseable 2xx body is a suppressed error', async () => {
  assert.equal(await make({ fetchImpl: async () => new Response(null, { status: 204 }) }).deleteConnection(connectionId), null);
  await assert.rejects(make({ fetchImpl: async () => new Response('PRIVATE <html>', { status: 200 }) }).listPools(companyId),
    e => { assert.equal(e.message, 'invalid Paperclip JSON response'); return true; });
});

test('getConnection projects only routing metadata and drops credentials, headers and transport config', async () => {
  const api = make({ fetchImpl: async () => Response.json({
    id: connectionId, companyId, name: 'lane', enabled: true, status: 'active', healthStatus: 'ok', createdByUserId: 'u1',
    apiKey: 'TOP_SECRET', headers: { Authorization: 'Bearer LEAK' },
    config: { ai: { provider: 'openai', method: 'api_key', routing: { mode: 'shared' }, apiKey: 'NESTED_SECRET', baseUrl: 'https://lane.example' }, transport: { proxy: 'p' } },
  }) });
  const c = await api.getConnection(connectionId);
  assert.deepEqual(c, { id: connectionId, companyId, name: 'lane', enabled: true, status: 'active', healthStatus: 'ok',
    createdByUserId: 'u1', provider: 'openai', method: 'api_key', routing: { mode: 'shared' } });
  assert.doesNotMatch(JSON.stringify(c), /SECRET|LEAK|baseUrl|proxy/);
});

test('getGrants keeps secret references but never secret values, and rejects a malformed list', async () => {
  const api = make({ fetchImpl: async () => Response.json({ grants: [{
    id: 'g1', connectionId, companyId, kind: 'shared', status: 'active', createdByUserId: 'u1',
    members: [{ subjectType: 'agent', subjectId: agentId, token: 'MEMBER_SECRET' }],
    credentialSecretRefs: [{ secretId: 's1', configPath: 'apiKey', value: 'RESOLVED_SECRET' }],
    credentials: { apiKey: 'GRANT_SECRET' },
  }] }) });
  const { grants } = await api.getGrants(connectionId);
  assert.deepEqual(grants[0].credentialSecretRefs, [{ secretId: 's1', configPath: 'apiKey' }]);
  assert.deepEqual(grants[0].members, [{ subjectType: 'agent', subjectId: agentId }]);
  assert.doesNotMatch(JSON.stringify(grants), /SECRET/);
  for (const body of [{}, { grants: null }, { grants: {} }]) {
    await assert.rejects(make({ fetchImpl: async () => Response.json(body) }).getGrants(connectionId), /invalid grants response/);
  }
});

test('getInstalls and listSessions project to their target fields and reject non-array bodies', async () => {
  const installs = make({ fetchImpl: async () => Response.json({ installs: [{ targetType: 'agent', targetId: agentId, config: { apiKey: 'S' } }] }) });
  assert.deepEqual(await installs.getInstalls(connectionId), [{ targetType: 'agent', targetId: agentId }]);
  await assert.rejects(make({ fetchImpl: async () => Response.json({ installs: 'x' }) }).getInstalls(connectionId), /invalid installs response/);
  const sessions = make({ fetchImpl: async () => Response.json([{ taskKey: 'issue:1', sessionToken: 'S' }]) });
  assert.deepEqual(await sessions.listSessions(agentId), [{ taskKey: 'issue:1' }]);
  await assert.rejects(make({ fetchImpl: async () => Response.json({ rows: [] }) }).listSessions(agentId), /invalid session list/);
});

test('CAS binding refuses an agent configuration from another company before writing', async () => {
  const { calls, fetchImpl } = recorder(() => Response.json({ companyId: otherCompany, configurationRevision: 'a'.repeat(64),
    runtimeConfig: { aiConnection: { mode: 'responsible_user', provider: 'openai', method: 'api_key' } } }));
  const api = make({ fetchImpl });
  await assert.rejects(api.bindAgent(agentId, { mode: 'router', connectionId }, { mode: 'responsible_user', provider: 'openai', method: 'api_key' }),
    /agent company mismatch/);
  assert.deepEqual(calls.map(c => c.init.method), ['GET']);
});

test('CAS binding fails when the host does not retain the requested binding', async () => {
  const before = { mode: 'responsible_user', provider: 'openai', method: 'api_key' };
  const after = { mode: 'router', connectionId };
  const { calls, fetchImpl } = recorder((url, init) => init.method === 'PATCH' ? Response.json({})
    : Response.json({ companyId, configurationRevision: 'a'.repeat(64), runtimeConfig: { aiConnection: before } }));
  await assert.rejects(make({ fetchImpl }).bindAgent(agentId, after, before), /did not retain/);
  assert.deepEqual(calls.map(c => c.init.method), ['GET', 'PATCH', 'GET']);
});
