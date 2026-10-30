import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateKeptAndRoutedCaps } from '../src/concurrency.mjs';
import { NOW, HOUR, OPUS, SONNET, WONDER, config, lane, policy, rows, drive, agent, assertDeferred } from './weekly-compatibility-fixture.mjs';

// Each fixture distinguishes the emitted model from the internal account label.
// No live proxy, provider invocation, worker bootstrap or credential binding.
for (const mode of ['off', 'shadow', 'enforce']) {
  for (const [siblingBurn, grantSubject] of [false, true].flatMap(burn => ['fixed', 'review'].map(id => [burn, id]))) {
    test(`shared emission fails closed through hook, defaults, efforts and ${grantSubject} caps (${mode}, burn=${siblingBurn})`, async t => {
      const raw = config(mode);
      raw.reviewerRouting.arms = [policy('claude', OPUS, 'high'), policy('claude', OPUS, 'max')];
      if (siblingBurn) raw.burnMode = { accounts: ['claude:unheld'] };
      const d = await drive({ raw, accounts: [lane('held', .85, 120), lane('unheld', .3, 84)],
        demand: [{ agentId: grantSubject, queued: 8 }] });
      await d.tick();
      d.size({ fixed: { accountId: 'claude:unheld' } });
      const caps = await d.caps();
      const decisions = [];
      for (const agentId of ['doer', 'review']) {
        for (const agentDefaultModel of [null, OPUS]) {
          decisions.push(await d.hook(`ambiguous-${mode}-${siblingBurn}-${agentId}-${agentDefaultModel}`, {
            agentId, agentDefaultModel, adapterType: 'opencode_local',
          }));
        }
      }
      t.diagnostic(JSON.stringify({ decisions, caps: caps.agents }));
      for (const decision of decisions) assertDeferred(decision);
      assert.equal(agent(caps, grantSubject).allocated, 0,
        'a nominal unheld/burn label cannot authorize a new grant on the common route');
      const capacity = await d.capacity();
      const held = capacity.paceGuard.rawPools.find(p => p.pool === 'claude');
      assert.ok(held.hardHeldAccountIds.includes('claude:held'));
      if (siblingBurn) {
        assert.ok(held.burnAccountIds.includes('claude:unheld'), 'ambiguity is not a reclassification of burn');
        assert.equal(capacity.accounts.find(a => a.accountId === 'claude:unheld').burnMode, true);
      }
    });
  }

  for (const subject of ['fixed', 'review']) {
    test(`a distinct approved emission remains useful beside a held credential (${mode}, ${subject})`, async () => {
      const raw = config(mode);
      raw.reviewerRouting.arms = [policy('claude', OPUS), policy('claude', SONNET)];
      const d = await drive({ raw, accounts: [lane('held', .85, 120), lane('safe', .3, 84, { models: [SONNET] })],
        demand: [{ agentId: subject, queued: 4 }] });
      await d.tick();
      d.size({ fixed: { accountId: 'claude:safe' } });
      assert.ok(agent(await d.caps(), subject).allocated > 0, 'the safe emission has actual new capacity');
      const decision = await d.hook(`safe-${mode}-${subject}`, { agentId: subject === 'fixed' ? 'doer' : 'review' });
      assert.equal(decision.kind, 'decide');
      assert.equal(decision.model, SONNET, 'only the safe model rules out the held credential');
    });
  }

  for (const held of [false, true]) {
    test(`policy-only reviewer admission obeys the weekly hold in every mode (${mode}, held=${held})`, async t => {
      const raw = config(mode);
      raw.reviewerRouting.arms = [policy('meta', WONDER, 'max')];
      const d = await drive({ raw, accounts: [lane('policy', held ? .85 : .3, held ? 120 : 84,
        { provider: 'meta', models: [WONDER] })], demand: [{ agentId: 'review', queued: 4 }] });
      await d.tick();
      const ladder = (await d.api('ladder')).ladders['meta:policy'];
      assert.equal(ladder.rungs.length, 0, 'this is genuinely policy-only, not ordinary scored capacity');
      if (mode === 'enforce') assert.ok(ladder.policyReviewerArms.some(a => a.model === WONDER));
      d.size();
      const caps = await d.caps();
      const decisions = [await d.hook(`policy-${mode}-${held}-1`, { agentId: 'review', agentDefaultModel: WONDER }),
        await d.hook(`policy-${mode}-${held}-2`, { agentId: 'review', agentDefaultModel: WONDER })];
      t.diagnostic(JSON.stringify({ decisions, caps: caps.agents }));
      if (held) {
        for (const decision of decisions) assertDeferred(decision);
        assert.equal(agent(caps, 'review').allocated, 0);
        assert.deepEqual((await d.capacity()).reviewerPaceByAgent.review.holdSuspendedAccountIds, []);
      } else if (mode === 'enforce') {
        assert.equal(decisions[0].kind, 'decide');
        assert.equal(decisions[0].model, WONDER);
        assert.ok(agent(caps, 'review').allocated > 0, 'an actually admitted non-held policy reviewer remains useful');
      } else {
        // This unpriced incumbent is not admitted in legacy modes. Preserve
        // that refusal; the scored safe-emission tests above are the positive controls.
        assert.deepEqual(decisions, [{ kind: 'keep' }, { kind: 'keep' }]);
        assert.equal(agent(caps, 'review').allocated, 0);
      }
    });
  }

  test(`a temporarily full reactive alternative cannot unlock a hard-held lane (${mode})`, async t => {
    const raw = config(mode);
    raw.reviewerRouting.arms.push(policy('gemini', 'gemini-2-5-flash'));
    const d = await drive({ raw, accounts: [lane('held', .85, 120),
      lane('reactive', .3, 84, { provider: 'gemini', models: ['gemini-2-5-flash'],
        meter: 'reactive', quality: 'reactive', weekly: undefined })] });
    await d.tick();
    const first = await d.hook(`reactive-${mode}-1`);
    const second = await d.hook(`reactive-${mode}-2`);
    assert.deepEqual([first.kind, first.model, second.kind, second.model],
      ['decide', 'gemini-2-5-flash', 'decide', 'gemini-2-5-flash']);
    const third = await d.hook(`reactive-${mode}-3`, { agentDefaultModel: OPUS });
    const review = await d.hook(`reactive-${mode}-review`, { agentId: 'review', agentDefaultModel: OPUS });
    await d.tick();
    d.size({ fixed: { accountId: 'claude:held' } });
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ third, review, agents: caps.agents }));
    assertDeferred(third);
    assertDeferred(review);
    assert.equal(agent(caps, 'fixed').allocated, 0);
    assert.equal(agent(caps, 'review').allocated, 0);
    assert.deepEqual((await d.capacity()).paceGuard.roleSafety, []);
  });
}

async function measuredSibling(mode, refusal) {
  const raw = config(mode);
  raw.concurrency.meanRunDurationHours = 4;
  if (refusal === 'guarded') raw.pacing = { guardHighPct: .8, guardRejoinPct: .75 };
  raw.reviewerRouting.arms = [policy(), policy('claude', SONNET, 'max')];
  const trial = 'devin/swe-2';
  if (['expired-price', 'disallowed-trial'].includes(refusal)) {
    raw.reviewerRouting.arms.push(policy('devin', trial, 'max'));
    raw.trials = { roles: refusal === 'disallowed-trial' ? [] : ['doer', 'thinker', 'other'],
      unscoredServedIds: [{ servedId: trial, reason: 'synthetic acceptance' }] };
    raw.placement = { freeCostServedIds: { [trial]: {
      until: refusal === 'expired-price' ? '2026-10-29T00:00:00Z' : '2026-12-01T00:00:00Z',
      reason: 'synthetic acceptance',
    } } };
  }
  if (refusal === 'excluded') raw.roles.excludeFamilies = { doer: ['sonnet'], thinker: ['sonnet'], other: ['sonnet'] };
  const d = await drive({ raw, accounts: [lane('one', .55, 84.5)],
    aaRows: rows().filter(row => !row.slug.startsWith('claude-sonnet')),
    demand: [{ agentId: 'fixed', queued: 8 }] });
  await d.tick();
  d.setNow(NOW + .5 * HOUR);
  const ready = lane('one', .58, 84.5);
  d.setAccounts([ready]);
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } });
  const before = await d.capacity();
  assert.equal(before.paceGuard.rawPools.find(p => p.pool === 'claude').cap, 1);
  assert.equal(agent(await d.caps(), 'fixed').allocated, 1);
  let sibling = lane('sibling', .1, 84, { models: [SONNET], weekly: { used: .1, resetsAt: null } });
  if (refusal === 'guarded') sibling.fiveHour.used = .85;
  if (refusal === 'unready') sibling.credentialAvailability = { version: 1, models: [] };
  if (['expired-price', 'disallowed-trial'].includes(refusal)) {
    sibling = { provider: 'devin', accountKey: 'sibling', lane: 'sibling', models: [trial],
      health: 'healthy', meter: 'reactive', quality: 'reactive' };
  }
  d.setNow(NOW + 31 * 60000);
  d.setAccounts([ready, sibling]);
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } });
  return d;
}

for (const mode of ['off', 'shadow', 'enforce']) {
  for (const refusal of ['guarded', 'unready', 'excluded', 'expired-price', 'disallowed-trial']) {
    test(`unservable sibling supplies no allowance or alternative (${mode}, ${refusal})`, async t => {
      const d = await measuredSibling(mode, refusal);
      const capacity = await d.capacity();
      const raw = capacity.paceGuard.rawPools.find(p => p.pool === 'claude');
      const caps = await d.caps();
      const decisions = [await d.hook(`${mode}-${refusal}-1`, { agentId: 'review' }),
        await d.hook(`${mode}-${refusal}-2`, { agentId: 'review' })];
      t.diagnostic(JSON.stringify({ raw, admissions: capacity.reviewerAccountIdsByAgent.review,
        fixed: agent(caps, 'fixed'), decisions }));
      assert.deepEqual({ lanes: raw.lanes, cap: raw.cap }, { lanes: 1, cap: 1 });
      assert.deepEqual(capacity.reviewerAccountIdsByAgent.review, ['claude:one']);
      assert.equal(agent(caps, 'fixed').allocated, 1);
      assert.deepEqual(decisions.map(d => d.kind), ['decide', 'defer']);
      assert.equal(decisions[0].model, OPUS);
    });
  }
}

const rowsOf = result => [...result.kept, ...result.routed];
const allocationRow = (rows, id) => rows.find(row => row.agentId === id);
for (const blockingPriority of [false, true]) {
  for (const occupant of ['fixed', 'review']) {
    test(`actual held running occupancy stays in its original pool (${occupant}, priority=${blockingPriority})`, t => {
      const input = { target: 4, blockingPriority,
        agents: [{ agentId: 'occupant', running: 1, queued: 0 }, { agentId: 'same-pool', running: 0, queued: 1 },
          { agentId: 'other-pool', running: 0, queued: 1 }],
        keepAgentIds: ['occupant', 'same-pool', 'other-pool'],
        keptByAgent: { occupant: { accountId: 'held' }, 'same-pool': { accountId: 'unheld' }, 'other-pool': { accountId: 'other' } },
        ...(occupant === 'review' ? { reviewerAccountIdsByAgent: { occupant: ['other'] } } : {}),
        accounts: [{ accountId: 'held', pool: 'original' }, { accountId: 'unheld', pool: 'original' }, { accountId: 'other', pool: 'other' }],
        perAccount: [{ accountId: 'held', slots: 0 }, { accountId: 'unheld', slots: 1 }, { accountId: 'other', slots: 1 }],
        pacePools: [{ pool: 'original', cap: 1, hardHeldAccountIds: ['held'] }, { pool: 'other', cap: 1 }],
      };
      const rows = rowsOf(allocateKeptAndRoutedCaps(input));
      t.diagnostic(JSON.stringify(rows));
      assert.deepEqual(Object.fromEntries(rows.map(row => [row.agentId, row.allocated])),
        { occupant: 1, 'same-pool': 0, 'other-pool': 1 }, 'no empty-pool charge, synthetic rematch or double charge');
    });
  }

  for (const running of [0, 1, 2]) {
    test(`every reviewer local cap includes other reviewers' actual ordinary pressure (${running}, priority=${blockingPriority})`, t => {
      const rows = rowsOf(allocateKeptAndRoutedCaps({ target: 8, blockingPriority,
        agents: [{ agentId: 'review', running: 0, queued: 8 }, { agentId: 'peer', running, queued: 0 }],
        keepAgentIds: ['peer'], keptByAgent: { peer: { accountId: 'one' } },
        reviewerAccountIdsByAgent: { review: ['one'], peer: ['one'] },
        reviewerPaceByAgent: { review: { holdSuspendedAccountIds: [], pools: [{ pool: 'shared', cap: 1 }] },
          peer: { holdSuspendedAccountIds: [], pools: [{ pool: 'shared', cap: 4 }] } },
        accounts: [{ accountId: 'one', pool: 'shared' }], perAccount: [{ accountId: 'one', slots: 8 }],
        pacePools: [{ pool: 'shared', cap: 8 }],
      }));
      t.diagnostic(JSON.stringify(rows));
      assert.equal(allocationRow(rows, 'peer')?.allocated ?? 0, running, 'over-cap running work is retained');
      assert.equal(allocationRow(rows, 'review').allocated, running === 0 ? 1 : 0,
        'a local cap is total ordinary pool pressure, not extra slots for this identity');
    });
  }
}

for (const [mode, mixed] of ['off', 'shadow', 'enforce'].flatMap(mode => [false, true].map(mixed => [mode, mixed]))) {
  test(`thinker-only burn identity survives raw doer filtering (${mode}, held sibling=${mixed})`, async t => {
    const raw = config(mode);
    raw.roles = { ...raw.roles, keepAgentIds: ['fixed'], thinkerAgentIds: ['fixed', 'thinker'], doerAgentIds: ['doer'],
      excludeFamilies: { doer: ['opus'], other: ['opus'] } };
    raw.reviewerRouting = undefined;
    raw.burnMode = { accounts: ['claude:burn'] };
    const d = await drive({ raw, accounts: [lane('burn', .85, 120),
      ...(mixed ? [lane('held', .85, 120, { models: [SONNET] })] : [])], demand: [{ agentId: 'fixed', queued: 4 }] });
    await d.tick();
    d.size({ fixed: { accountId: 'claude:burn' } }, 4);
    const capacity = await d.capacity(), caps = await d.caps();
    const pool = capacity.paceGuard.rawPools.find(p => p.pool === 'claude');
    t.diagnostic(JSON.stringify({ pool, fixed: agent(caps, 'fixed') }));
    assert.equal(agent(caps, 'fixed').allocated, 4, 'a different held doer route cannot zero the distinguishable burn grant');
    assert.ok(pool?.burnAccountIds.includes('claude:burn'));
    // An ordinary thinker proves an actual safe emission, not a kept-pin bypass.
    const thinker = await d.hook(`thinker-emission-${mixed}`, { agentId: 'thinker', agentDefaultModel: null });
    assert.equal(thinker.kind, 'decide');
    assert.equal(thinker.model, OPUS);
    assert.equal(capacity.accounts.find(a => a.accountId === 'claude:burn').burnMode, true);
  });
}

for (const burnRunning of [0, 2]) {
  test(`reviewer-scoped ordinary pressure excludes another-arm burn runs (${burnRunning})`, async t => {
    const raw = config();
    raw.burnMode = { accounts: ['claude:burn'] };
    const d = await drive({ raw, accounts: [lane('ordinary', .58, 84),
      lane('burn', .85, 120, { models: [SONNET] })], demand: [{ agentId: 'review', queued: 1 }] });
    await d.tick();
    for (let i = 0; i < burnRunning; i++) await d.fire(`burn-pressure-${i}`, 'burn-worker', { model: SONNET, accountId: 'claude:burn' });
    await d.tick();
    const capacity = await d.capacity();
    const pool = capacity.reviewerPaceByAgent.review.pools.find(p => p.pool === 'claude');
    const decision = await d.hook(`ordinary-review-${burnRunning}`, { agentId: 'review' });
    t.diagnostic(JSON.stringify({ pool, inFlightByPool: capacity.inFlightByPool, decision }));
    assert.equal(capacity.inFlightByPool.claude ?? 0, burnRunning, 'actual burn work remains physical pool occupancy');
    assert.ok(pool.burnAccountIds?.includes('claude:burn'), 'the ordinary allowance filter cannot erase burn identity');
    assert.equal(pool.inFlight, 0, 'burn pressure is not ordinary paced pressure');
    assert.equal(decision.kind, 'decide');
    assert.equal(decision.model, OPUS);
  });
}

for (const includeDeniedAlternative of [false, true]) {
  test(`a non-held policy reviewer stays useful with a denied trial record (configured=${includeDeniedAlternative})`, async () => {
    const raw = config();
    raw.credentialReadiness.enforce = false;
    raw.trials = { roles: [], unscoredServedIds: [{ servedId: 'devin/swe-2', reason: 'synthetic acceptance' }] };
    raw.placement = { freeCostServedIds: { 'devin/swe-2': { until: '2026-12-01T00:00:00Z', reason: 'synthetic acceptance' } } };
    raw.reviewerRouting.arms = [policy('meta', WONDER, 'max'),
      ...(includeDeniedAlternative ? [policy('devin', 'devin/swe-2', 'max')] : [])];
    const d = await drive({ raw, accounts: [lane('policy', .58, 84, { provider: 'meta', models: [WONDER] }),
      { provider: 'devin', accountKey: 'trial', models: ['devin/swe-2'], health: 'healthy', meter: 'reactive', quality: 'reactive' }],
      demand: [{ agentId: 'review', queued: 2 }] });
    await d.tick(); d.size();
    const capacity = await d.capacity();
    assert.deepEqual(capacity.reviewerAccountIdsByAgent.review, ['meta:policy']);
    assert.deepEqual(capacity.reviewerPaceByAgent.review.holdSuspendedAccountIds, []);
    assert.equal(agent(await d.caps(), 'review').allocated, 1);
    const first = await d.hook(`nonheld-trial-${includeDeniedAlternative}-1`, { agentId: 'review' });
    assert.deepEqual({ kind: first.kind, model: first.model, effort: first.effort },
      { kind: 'decide', model: WONDER, effort: 'max' });
    assertDeferred(await d.hook(`nonheld-trial-${includeDeniedAlternative}-2`, { agentId: 'review' }));
  });
}

for (const refusal of ['ready', 'unready', 'manual-exclusion']) {
  test(`non-held policy reviewer readiness and exclusion gates remain observable (${refusal})`, async () => {
    const raw = config(); raw.reviewerRouting.arms = [policy('meta', WONDER, 'max')];
    if (refusal === 'manual-exclusion') raw.roles.excludeFamilies = { doer: ['muse'] };
    const d = await drive({ raw, accounts: [lane('policy', .58, 84, { provider: 'meta', models: [WONDER],
      ...(refusal === 'unready' ? { credentialAvailability: { version: 1, models: [] } } : {}) })],
      demand: [{ agentId: 'review', queued: 2 }] });
    await d.tick(); d.size();
    const capacity = await d.capacity(), caps = await d.caps();
    const decision = await d.hook(`nonheld-policy-${refusal}`, { agentId: 'review' });
    assert.deepEqual(capacity.reviewerAccountIdsByAgent.review, refusal === 'ready' ? ['meta:policy'] : []);
    if (refusal === 'ready') {
      assert.equal(decision.kind, 'decide'); assert.equal(decision.model, WONDER);
      assert.equal(agent(caps, 'review').allocated, 1);
    } else {
      assertDeferred(decision); assert.equal(agent(caps, 'review').allocated, 0);
    }
  });
}

for (const mode of ['off', 'shadow', 'enforce']) {
  test(`an unestablished reachable credential set is not proof of a safe common route (${mode})`, async () => {
    const d = await drive({ raw: config(mode), accounts: [lane('held', .85, 120, { models: undefined }), lane('unheld')],
      demand: [{ agentId: 'review', queued: 2 }] });
    await d.tick(); d.size();
    assertDeferred(await d.hook(`unknown-reachability-${mode}`, { agentDefaultModel: OPUS }));
    assertDeferred(await d.hook(`unknown-review-reachability-${mode}`, { agentId: 'review', agentDefaultModel: OPUS }));
    assert.equal(agent(await d.caps(), 'review').allocated, 0);
  });
}

for (const disabledBy of ['hold-null', 'guard-disabled']) {
  test(`shared-model routing retains its old behavior when the weekly overlay is disabled (${disabledBy})`, async () => {
    const raw = config();
    raw.pacing = disabledBy === 'hold-null' ? { holdAheadPts: null } : { guard: { enabled: false } };
    const d = await drive({ raw, accounts: [lane('ahead', .85, 120), lane('behind')],
      demand: [{ agentId: 'fixed', queued: 2 }] });
    await d.tick(); d.size({ fixed: { accountId: 'claude:behind' } });
    const decision = await d.hook(`disabled-shared-${disabledBy}`);
    assert.equal(decision.kind, 'decide'); assert.equal(decision.model, OPUS);
    assert.ok(agent(await d.caps(), 'fixed').allocated > 0);
  });
}
