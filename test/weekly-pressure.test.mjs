import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateKeptAndRoutedCaps } from '../src/concurrency.mjs';
import { OPUS, SONNET, config, lane, policy, drive, agent, assertDeferred } from './weekly-compatibility-fixture.mjs';

for (const mode of ['off', 'shadow', 'enforce']) {
  for (const subject of ['fixed', 'review']) {
    test(`a sole held ${subject} preserves its actual running floor but starts nothing (${mode})`, async t => {
      const d = await drive({ raw: config(mode), accounts: [lane('held', .85, 120)],
        demand: [{ agentId: subject, queued: 8 }], agents: { [subject]: { adapterConfig: { model: OPUS } } } });
      await d.tick();
      await d.fire(`held-floor-${mode}-${subject}`, subject, { provider: 'claude', model: OPUS, accountId: 'claude:held' });
      await d.tick();
      d.size({ [subject]: { accountId: 'claude:held' } });
      const capacity = await d.capacity(), row = agent(await d.caps(), subject);
      const decision = await d.hook(`held-extra-${mode}-${subject}`, {
        agentId: subject === 'fixed' ? 'doer' : subject, agentDefaultModel: OPUS,
      });
      t.diagnostic(JSON.stringify({ row, inFlight: capacity.inFlightByAccount, decision }));
      assert.equal(row.running, 1); assert.equal(row.allocated, 1);
      assert.equal(capacity.inFlightByAccount['claude:held'], 1);
      assert.equal(capacity.inFlightByPool.claude, 1);
      assertDeferred(decision);
    });
  }
}

for (const blockingPriority of [false, true]) {
  for (const occupant of ['fixed', 'review']) {
    test(`caps retains the held ${occupant} physical charge before another fixed grant (priority=${blockingPriority})`, async t => {
      const raw = config(); raw.allocation = { blockingPriority };
      raw.roles.keepAgentIds = ['occupant', 'fixed'];
      raw.pacing = { holdAheadPts: null };
      if (occupant === 'review') raw.reviewerRouting.agentIds = ['occupant'];
      else raw.reviewerRouting = undefined;
      const d = await drive({ raw, accounts: [lane('held', .85, 120), lane('unheld', .58, 84, { models: [SONNET] }),
        lane('other', .3, 84, { provider: 'gemini', models: ['gemini-2-5-flash'] })],
        agents: { occupant: { adapterConfig: { model: OPUS } }, fixed: { adapterConfig: { model: SONNET } } },
        demand: [{ agentId: 'fixed', queued: 4 }] });
      await d.tick();
      await d.fire(`physical-${occupant}-${blockingPriority}`, 'occupant', { model: OPUS, accountId: 'claude:held' });
      await d.tick();
      const next = { ...raw, pacing: { holdAheadPts: .1 }, ...(occupant === 'review' ? {
        reviewerRouting: { agentIds: ['occupant'], arms: [policy('gemini', 'gemini-2-5-flash')] },
      } : {}) };
      await d.configure(next);
      await d.tick();
      d.size({ occupant: { accountId: 'claude:held' }, fixed: { accountId: 'claude:unheld' } });
      const capacity = await d.capacity(), caps = await d.caps();
      t.diagnostic(JSON.stringify({ caps: caps.agents, actual: capacity.inFlightByAccount,
        pools: capacity.paceGuard.rawPools, admissions: capacity.reviewerAccountIdsByAgent }));
      assert.equal(capacity.inFlightByAccount['claude:held'], 1);
      assert.equal(capacity.paceGuard.rawPools.find(p => p.pool === 'claude').cap, 1);
      assert.equal(agent(caps, 'occupant').running, 1);
      assert.equal(agent(caps, 'occupant').allocated, 1);
      assert.equal(agent(caps, 'fixed').allocated, 0,
        'the real Claude pool is already at 1/1 even if current review admission points elsewhere');
    });
  }

  for (const peerRunning of [0, 1, 2]) {
    test(`caps never overstates the real reviewer hook local allowance (peer=${peerRunning}, priority=${blockingPriority})`, async t => {
      const raw = config(); raw.allocation = { blockingPriority };
      raw.reviewerRouting.agentIds = ['review', 'peer'];
      const d = await drive({ raw, accounts: [lane('review-only', .58, 84), lane('other-arm', .3, 84, { models: [SONNET] })],
        agents: { peer: { adapterConfig: { model: OPUS } } }, demand: [{ agentId: 'review', queued: 8 }] });
      await d.tick();
      for (let i = 0; i < peerRunning; i++) await d.fire(`pooled-peer-${blockingPriority}-${i}`, 'peer', {
        model: OPUS, accountId: 'claude:review-only',
      });
      await d.tick(); d.size({ peer: { accountId: 'claude:review-only' } });
      const capacity = await d.capacity(), caps = await d.caps();
      const local = capacity.reviewerPaceByAgent.review.pools.find(p => p.pool === 'claude');
      assert.equal(local.cap, 1, 'only the admitted review arm supplies local allowance');
      const first = await d.hook(`local-review-${blockingPriority}-${peerRunning}-1`, { agentId: 'review' });
      const second = await d.hook(`local-review-${blockingPriority}-${peerRunning}-2`, { agentId: 'review' });
      t.diagnostic(JSON.stringify({ local, caps: caps.agents, decisions: [first, second] }));
      assert.equal(first.kind, peerRunning === 0 ? 'decide' : 'defer');
      assertDeferred(second);
      assert.equal(agent(caps, 'review').allocated, peerRunning === 0 ? 1 : 0,
        'caps may understate, but never exceed hook-admissible new work at identical pressure');
      if (peerRunning > 0) assert.equal(agent(caps, 'peer').allocated, peerRunning);
    });
  }
}

test('allocator preserves an unknown real charge without inventing a free affected pool', t => {
  const result = allocateKeptAndRoutedCaps({ target: 8,
    agents: [{ agentId: 'unknown', running: 1, queued: 0 }, { agentId: 'fixed', running: 0, queued: 4 }],
    keepAgentIds: ['unknown', 'fixed'], keptByAgent: { fixed: { accountId: 'one' } },
    accounts: [{ accountId: 'one', pool: 'claude' }], perAccount: [{ accountId: 'one', slots: 4 }],
    pacePools: [{ pool: 'claude', cap: 4 }],
  });
  const rows = [...result.kept, ...result.routed];
  t.diagnostic(JSON.stringify(rows));
  assert.equal(rows.find(row => row.agentId === 'unknown').allocated, 1);
  assert.equal(rows.find(row => row.agentId === 'fixed').allocated, 0,
    'the only affected pool has no established charge for the existing run');
});
