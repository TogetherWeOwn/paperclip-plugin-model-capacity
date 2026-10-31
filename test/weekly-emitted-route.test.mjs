import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, config, lane, policy, rows, drive, agent } from './weekly-compatibility-fixture.mjs';
import { syntheticAvailability } from './synthetic-readiness.mjs';
import { isWeeklyHeldModelRoute } from '../src/paceguard.mjs';

// Bare policy requests never equal prefixed emissions. All expected hook,
// caps and membership values below are independent literals.

function safeOpusAccount() {
  const safe = lane('safe', 0.3, 84, {
    provider: 'devin',
    models: ['devin/claude-opus-5-5'],
    meter: 'reactive',
    weekly: { used: null, resetsAt: null },
    fiveHour: { used: null, resetsAt: null },
    quality: 'reactive',
  });
  safe.credentialAvailability = syntheticAvailability(safe, NOW, {
    models: ['claude-opus-5-5', 'devin/claude-opus-5-5'],
  });
  return safe;
}

function heldOpusAccount() {
  const held = lane('held', 0.85, 120, { models: ['devin/claude-opus-5-5'] });
  held.credentialAvailability = syntheticAvailability(held, NOW, {
    models: ['claude-opus-5-5', 'devin/claude-opus-5-5'],
  });
  return held;
}

function safeSonnetAccount() {
  const safe = lane('safe', 0.3, 84, {
    provider: 'devin',
    models: ['devin/claude-sonnet-5-5'],
    meter: 'reactive',
    weekly: { used: null, resetsAt: null },
    fiveHour: { used: null, resetsAt: null },
    quality: 'reactive',
  });
  safe.credentialAvailability = syntheticAvailability(safe, NOW, {
    models: ['claude-sonnet-5-5', 'devin/claude-sonnet-5-5'],
  });
  return safe;
}

function assertReadyRow(account, accountId, provider, model) {
  assert.equal(account.credentialAvailability.version, 1);
  const row = account.credentialAvailability.models.find((entry) => entry.model === model);
  assert.ok(row, `synthetic readiness names exact ${model} for ${accountId}`);
  assert.equal(row.provider, provider);
  assert.equal(row.accountId, accountId);
  assert.equal(row.servingCredentials, 1);
  assert.equal(row.readyCredentials, 1);
}

function assertBoundedDefer(decision) {
  assert.equal(decision.kind, 'defer');
  assert.ok(Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0 && decision.retryAfterMs <= 600000);
  assert.equal(decision.model, undefined);
  assert.equal(decision.effort, undefined);
  assert.equal(decision.fallback, undefined);
  assert.equal(decision.env, undefined);
  assert.match(decision.reason, /weekly|held/);
}

function assertBoundedNoEmission(decision) {
  assert.equal(decision.kind, 'defer');
  assert.ok(Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0 && decision.retryAfterMs <= 600000);
  assert.equal(decision.model, undefined);
  assert.equal(decision.effort, undefined);
  assert.equal(decision.fallback, undefined);
  assert.equal(decision.env, undefined);
}

for (const mode of ['off', 'shadow', 'enforce']) {
  test(`reviewer bare policy admits exact prefixed emission with useful caps (${mode}, safe only)`, async (t) => {
    const raw = config(mode);
    raw.reviewerRouting.arms = [policy('devin', 'claude-opus-5-5', 'high')];
    assert.equal(raw.reviewerRouting.arms[0].model, 'claude-opus-5-5');
    assert.equal(raw.reviewerRouting.arms[0].provider, 'devin');
    const safe = safeOpusAccount();
    assert.deepEqual(safe.models, ['devin/claude-opus-5-5']);
    assertReadyRow(safe, 'devin:safe', 'devin', 'claude-opus-5-5');
    assertReadyRow(safe, 'devin:safe', 'devin', 'devin/claude-opus-5-5');
    const d = await drive({ raw, accounts: [safe], demand: [{ agentId: 'review', queued: 4 }] });
    await d.tick();
    d.size();
    const snapshot = d.snapshot();
    const caps = await d.caps();
    const decision = await d.hook(`emitted-safe-${mode}`, { agentId: 'review', adapterType: 'opencode_local' });
    t.diagnostic(JSON.stringify({ decision, caps: caps.agents, safe: snapshot.reviewerSafeAccountIdsByAgent }));
    assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, []);
    assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-opus-5-5' }), false);
    assert.equal(decision.kind, 'decide');
    assert.equal(decision.model, 'devin/claude-opus-5-5');
    assert.equal(decision.effort, 'high');
    assert.deepEqual(decision.env, {});
    assert.ok(!String(decision.model).includes('[1m]'));
    assert.equal(agent(caps, 'review').allocated, 4);
    assert.equal(agent(caps, 'review').maxConcurrentRuns, 4);
    assert.deepEqual(snapshot.reviewerSafeAccountIdsByAgent.review, ['devin:safe']);
  });

  test(`same prefixed route defers through hook (${mode}, held sibling)`, async (t) => {
    const raw = config(mode);
    raw.reviewerRouting.arms = [policy('devin', 'claude-opus-5-5', 'high')];
    assert.equal(raw.reviewerRouting.arms[0].model, 'claude-opus-5-5');
    const held = heldOpusAccount();
    const safe = safeOpusAccount();
    assert.deepEqual(held.models, ['devin/claude-opus-5-5']);
    assert.deepEqual(safe.models, ['devin/claude-opus-5-5']);
    assertReadyRow(held, 'claude:held', 'claude', 'claude-opus-5-5');
    assertReadyRow(held, 'claude:held', 'claude', 'devin/claude-opus-5-5');
    assertReadyRow(safe, 'devin:safe', 'devin', 'claude-opus-5-5');
    assertReadyRow(safe, 'devin:safe', 'devin', 'devin/claude-opus-5-5');
    const d = await drive({ raw, accounts: [held, safe], demand: [{ agentId: 'review', queued: 4 }] });
    await d.tick();
    d.size();
    const snapshot = d.snapshot();
    const caps = await d.caps();
    const decision = await d.hook(`emitted-held-${mode}`, { agentId: 'review', adapterType: 'opencode_local' });
    t.diagnostic(JSON.stringify({ decision, caps: caps.agents, safe: snapshot.reviewerSafeAccountIdsByAgent, held: snapshot.weeklyRouteFacts.hardHeldAccountIds }));
    assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, ['claude:held']);
    assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-opus-5-5' }), true);
    const capacity = await d.capacity();
    const pool = capacity.paceGuard.rawPools.find((p) => p.pool === 'claude');
    assert.ok(pool.hardHeldAccountIds.includes('claude:held'));
    assert.ok(!(pool.burnAccountIds ?? []).includes('claude:held'));
    assert.equal(agent(caps, 'review').allocated, 0);
    assert.equal(agent(caps, 'review').maxConcurrentRuns, 0);
    assertBoundedDefer(decision);
  });

  test(`same prefixed route excludes unsafe reviewer-safe membership (${mode}, held sibling)`, async (t) => {
    const raw = config(mode);
    raw.reviewerRouting.arms = [policy('devin', 'claude-opus-5-5', 'high')];
    assert.equal(raw.reviewerRouting.arms[0].model, 'claude-opus-5-5');
    const held = heldOpusAccount();
    const safe = safeOpusAccount();
    assert.deepEqual(held.models, ['devin/claude-opus-5-5']);
    assert.deepEqual(safe.models, ['devin/claude-opus-5-5']);
    const d = await drive({ raw, accounts: [held, safe], demand: [{ agentId: 'review', queued: 4 }] });
    await d.tick();
    d.size();
    const snapshot = d.snapshot();
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ caps: caps.agents, safe: snapshot.reviewerSafeAccountIdsByAgent, held: snapshot.weeklyRouteFacts.hardHeldAccountIds }));
    assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, ['claude:held']);
    assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-opus-5-5' }), true);
    assert.equal(agent(caps, 'review').allocated, 0);
    assert.equal(agent(caps, 'review').maxConcurrentRuns, 0);
    assert.deepEqual(snapshot.reviewerSafeAccountIdsByAgent.review ?? [], []);
  });

  test(`distinct approved prefixed emission remains useful beside held route (${mode})`, async (t) => {
    const raw = config(mode);
    raw.reviewerRouting.arms = [
      policy('devin', 'claude-opus-5-5', 'high'),
      policy('devin', 'claude-sonnet-5-5', 'high'),
    ];
    const held = heldOpusAccount();
    const safe = safeSonnetAccount();
    assert.deepEqual(held.models, ['devin/claude-opus-5-5']);
    assert.deepEqual(safe.models, ['devin/claude-sonnet-5-5']);
    assertReadyRow(safe, 'devin:safe', 'devin', 'devin/claude-sonnet-5-5');
    const d = await drive({ raw, accounts: [held, safe], demand: [{ agentId: 'review', queued: 4 }] });
    await d.tick();
    d.size();
    const snapshot = d.snapshot();
    const caps = await d.caps();
    const decision = await d.hook(`emitted-alt-${mode}`, { agentId: 'review', adapterType: 'opencode_local' });
    t.diagnostic(JSON.stringify({ decision, caps: caps.agents }));
    assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, ['claude:held']);
    assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-sonnet-5-5' }), false);
    assert.equal(decision.kind, 'decide');
    assert.equal(decision.model, 'devin/claude-sonnet-5-5');
    assert.equal(decision.effort, 'high');
    assert.ok(agent(caps, 'review').allocated > 0);
  });

  test(`burn-exempt held route stays decidable (${mode})`, async (t) => {
    const raw = config(mode);
    raw.reviewerRouting.arms = [policy('devin', 'claude-opus-5-5', 'high')];
    raw.burnMode = { accounts: ['claude:held'] };
    const held = heldOpusAccount();
    const safe = safeOpusAccount();
    const d = await drive({ raw, accounts: [held, safe], demand: [{ agentId: 'review', queued: 4 }] });
    await d.tick();
    d.size();
    const capacity = await d.capacity();
    const caps = await d.caps();
    const decision = await d.hook(`emitted-burn-${mode}`, { agentId: 'review', adapterType: 'opencode_local' });
    t.diagnostic(JSON.stringify({ decision, caps: caps.agents }));
    assert.equal(capacity.accounts.find((a) => a.accountId === 'claude:held').burnMode, true);
    assert.equal(decision.kind, 'decide');
    assert.equal(decision.model, 'devin/claude-opus-5-5');
    assert.equal(decision.effort, 'high');
    assert.ok(agent(caps, 'review').allocated > 0);
  });

  test(`fixed grant stays conservative on the same prefixed held route (${mode})`, async (t) => {
    const raw = config(mode);
    raw.reviewerRouting.arms = [policy('devin', 'claude-opus-5-5', 'high')];
    const held = heldOpusAccount();
    const safe = safeOpusAccount();
    const d = await drive({ raw, accounts: [held, safe], demand: [{ agentId: 'fixed', queued: 4 }] });
    await d.tick();
    d.size({ fixed: { accountId: 'devin:safe' } });
    const snapshot = d.snapshot();
    const caps = await d.caps();
    const pinnedNull = await d.hook(`emitted-fixed-null-${mode}`, { agentId: 'fixed', adapterType: 'opencode_local' });
    const pinnedBare = await d.hook(`emitted-fixed-bare-${mode}`, { agentId: 'fixed', agentDefaultModel: 'claude-opus-5-5', adapterType: 'opencode_local' });
    const ordinary = await d.hook(`emitted-fixed-${mode}`, { agentId: 'doer', agentDefaultModel: 'claude-opus-5-5', adapterType: 'opencode_local' });
    t.diagnostic(JSON.stringify({ pinnedNull, pinnedBare, ordinary, caps: caps.agents }));
    assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, ['claude:held']);
    assert.equal(agent(caps, 'fixed').allocated, 0);
    assertBoundedDefer(pinnedNull);
    assert.deepEqual(pinnedBare, { kind: 'keep' });
    assertBoundedNoEmission(ordinary);
  });

  for (const authority of ['enforce-off', 'unknown-company', 'issue-override']) {
    test(`prefixed held route preserves explicit ${authority} authority (${mode})`, async (t) => {
      const raw = config(mode);
      raw.reviewerRouting.arms = [policy('devin', 'claude-opus-5-5', 'high')];
      if (authority === 'enforce-off') raw.enforce = false;
      const held = heldOpusAccount();
      const safe = safeOpusAccount();
      const d = await drive({ raw, accounts: [held, safe], demand: [{ agentId: 'review', queued: 4 }] });
      await d.tick();
      d.size();
      assert.deepEqual(d.snapshot().weeklyRouteFacts.hardHeldAccountIds, ['claude:held']);
      const extra = {
        agentId: 'review',
        agentDefaultModel: 'claude-opus-5-5',
        adapterType: 'opencode_local',
        ...(authority === 'unknown-company' ? { companyId: 'another-company' } : {}),
        ...(authority === 'issue-override' ? { issueOverrideModel: 'claude-opus-5-5' } : {}),
      };
      const decision = await d.hook(`emitted-authority-${mode}-${authority}`, extra);
      t.diagnostic(JSON.stringify({ decision }));
      assert.deepEqual(decision, { kind: 'keep' });
    });
  }
}

test('distinguishable burn route remains useful beside prefixed held route', async (t) => {
  const raw = config('enforce');
  raw.reviewerRouting.arms = [
    policy('devin', 'claude-opus-5-5', 'high'),
    policy('claude', 'claude-sonnet-5-5', 'max'),
  ];
  raw.burnMode = { accounts: ['claude:burn'] };
  const held = heldOpusAccount();
  const burn = lane('burn', 0.85, 120, { models: ['claude-sonnet-5-5'] });
  burn.credentialAvailability = syntheticAvailability(burn, NOW, {
    models: ['claude-sonnet-5-5', 'devin/claude-sonnet-5-5'],
  });
  assert.deepEqual(held.models, ['devin/claude-opus-5-5']);
  assert.deepEqual(burn.models, ['claude-sonnet-5-5']);
  const d = await drive({ raw, accounts: [held, burn], demand: [{ agentId: 'review', queued: 4 }] });
  await d.tick();
  d.size();
  const capacity = await d.capacity();
  const caps = await d.caps();
  const decision = await d.hook('emitted-distinguishable-burn', { agentId: 'review', adapterType: 'opencode_local' });
  t.diagnostic(JSON.stringify({ decision, caps: caps.agents }));
  assert.ok(capacity.paceGuard.rawPools.some((p) => (p.burnAccountIds ?? []).includes('claude:burn')));
  assert.equal(decision.kind, 'decide');
  assert.equal(decision.model, 'claude-sonnet-5-5');
  assert.ok(agent(caps, 'review').allocated > 0);
});

function rows1MOpus() {
  return rows().map((row) => (row.slug === 'claude-opus-5-5' ? { ...row, contextWindowTokens: 1000000 } : row));
}

test('reviewer prefixed emission stays undecorated even with 1M context on every adapter', async (t) => {
  const aaRows = rows1MOpus();
  assert.equal(aaRows.find((row) => row.slug === 'claude-opus-5-5').contextWindowTokens, 1000000);
  for (const adapterType of ['opencode_local', 'claude-code', 'claude_local']) {
    const raw = config('enforce');
    raw.reviewerRouting.arms = [policy('devin', 'claude-opus-5-5', 'high')];
    assert.equal(raw.reviewerRouting.arms[0].model, 'claude-opus-5-5');
    const safe = safeOpusAccount();
    assert.deepEqual(safe.models, ['devin/claude-opus-5-5']);
    const d = await drive({ raw, accounts: [safe], demand: [{ agentId: 'review', queued: 4 }], aaRows });
    await d.tick();
    d.size();
    const snapshot = d.snapshot();
    const caps = await d.caps();
    const decision = await d.hook(`emitted-reviewer-1m-${adapterType}`, { agentId: 'review', adapterType });
    t.diagnostic(JSON.stringify({ adapterType, decision }));
    assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, []);
    assert.equal(decision.kind, 'decide');
    assert.equal(decision.model, 'devin/claude-opus-5-5');
    assert.equal(decision.effort, 'high');
    assert.deepEqual(decision.env, {});
    assert.equal(agent(caps, 'review').allocated, 4);
  }
});

test('ordinary prefixed 1M emits supported adapter-decorated form on claude-code only (safe only)', async (t) => {
  const aaRows = rows1MOpus();
  const safe = safeOpusAccount();
  assert.deepEqual(safe.models, ['devin/claude-opus-5-5']);
  assertReadyRow(safe, 'devin:safe', 'devin', 'claude-opus-5-5');
  assertReadyRow(safe, 'devin:safe', 'devin', 'devin/claude-opus-5-5');
  const raw = config('enforce');
  const d = await drive({ raw, accounts: [safe], demand: [{ agentId: 'fixed', queued: 4 }], aaRows });
  await d.tick();
  d.size({ fixed: { accountId: 'devin:safe' } });
  const snapshot = d.snapshot();
  const caps = await d.caps();
  const decorated = await d.hook('emitted-ordinary-1m-claude-code', { agentId: 'doer', adapterType: 'claude-code' });
  const plain = await d.hook('emitted-ordinary-1m-opencode', { agentId: 'doer', adapterType: 'opencode_local' });
  t.diagnostic(JSON.stringify({ decorated, plain, caps: caps.agents }));
  assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, []);
  assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-opus-5-5' }), false);
  assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-opus-5-5(max)[1m]' }), false);
  assert.equal(decorated.kind, 'decide');
  assert.equal(decorated.model, 'devin/claude-opus-5-5(max)[1m]');
  assert.equal(decorated.effort, 'max');
  assert.deepEqual(decorated.env, {});
  assert.equal(plain.kind, 'decide');
  assert.equal(plain.model, 'devin/claude-opus-5-5');
  assert.equal(plain.effort, 'max');
  assert.deepEqual(plain.env, {});
  assert.equal(agent(caps, 'fixed').allocated, 4);
});

test('ordinary prefixed 1M defers safely on both adapters when held (decorated route unsafe)', async (t) => {
  const aaRows = rows1MOpus();
  const held = heldOpusAccount();
  const safe = safeOpusAccount();
  assert.deepEqual(held.models, ['devin/claude-opus-5-5']);
  assert.deepEqual(safe.models, ['devin/claude-opus-5-5']);
  const raw = config('enforce');
  const d = await drive({ raw, accounts: [held, safe], demand: [{ agentId: 'fixed', queued: 4 }], aaRows });
  await d.tick();
  d.size({ fixed: { accountId: 'devin:safe' } });
  const snapshot = d.snapshot();
  const caps = await d.caps();
  const decorated = await d.hook('emitted-ordinary-held-1m-claude-code', { agentId: 'doer', adapterType: 'claude-code' });
  const plain = await d.hook('emitted-ordinary-held-1m-opencode', { agentId: 'doer', adapterType: 'opencode_local' });
  t.diagnostic(JSON.stringify({ decorated, plain, caps: caps.agents, held: snapshot.weeklyRouteFacts.hardHeldAccountIds }));
  assert.deepEqual(snapshot.weeklyRouteFacts.hardHeldAccountIds, ['claude:held']);
  assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-opus-5-5' }), true);
  assert.equal(isWeeklyHeldModelRoute({ ...snapshot.weeklyRouteFacts, model: 'devin/claude-opus-5-5(max)[1m]' }), true);
  assert.equal(agent(caps, 'fixed').allocated, 0);
  assertBoundedNoEmission(decorated);
  assertBoundedNoEmission(plain);
});
