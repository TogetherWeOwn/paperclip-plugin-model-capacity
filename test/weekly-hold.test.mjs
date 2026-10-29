import test from 'node:test';
import assert from 'node:assert/strict';
import { paceGuardPools } from '../src/paceguard.mjs';
import { orderAccountsWithPacing } from '../src/select.mjs';
import { resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { scheduleError } from '../src/pacing.mjs';

const pacing = { enabled: true, marginPct: 0.02, holdAheadPts: 0.10, meanRunDurationHours: 0.2 };
const lane = (accountId, overrides = {}) => ({ accountId, pool: accountId, health: 'healthy',
  headroomPct: 0.8, targetShare: 0.1, planAhead: 0.45, inFlight: 0, ...overrides });
const pools = lanes => paceGuardPools(lanes, { pacing, poolKeyOf: v => v.pool });
const order = (lanes, opts = {}) => orderAccountsWithPacing(lanes, { pacing, ...opts });
const ids = r => r.order.map(v => v.accountId);

test('deeply ahead idle account has zero slots even without a measured run duration or share', () => {
  for (const patch of [{}, { targetShare: null }]) {
    const [p] = pools([lane('ahead', patch)]);
    assert.equal(p.cap, 0);
    assert.equal(p.pacedSlots, 0);
    assert.deepEqual(p.hardHeldAccountIds, ['ahead']);
    assert.deepEqual(p.pacedAccountIds, ['ahead']);
  }
  const [p] = paceGuardPools([lane('ahead')], { pacing: { ...pacing, meanRunDurationHours: null }, poolKeyOf: v => v.pool });
  assert.equal(p.cap, 0);
});

test('ahead hold releases at the band boundary and does not survive the next plan reading', () => {
  const peer = lane('peer', { planAhead: -0.1 });
  assert.deepEqual(ids(order([lane('ahead'), peer])), ['peer']);
  assert.ok(ids(order([lane('ahead', { planAhead: 0.10 }), peer])).includes('ahead'));
  assert.ok(ids(order([lane('ahead', { planAhead: -0.01 }), peer])).includes('ahead'));
});

test('null disables the hard hold; burn and reactive accounts remain exempt', () => {
  const peer = lane('peer', { planAhead: -0.1 });
  assert.ok(ids(order([lane('ahead'), peer], { pacing: { ...pacing, holdAheadPts: null } })).includes('ahead'));
  assert.ok(ids(order([lane('burn', { burn: true }), peer])).includes('burn'));
  assert.ok(ids(order([lane('reactive', { meter: 'reactive' }), peer])).includes('reactive'));
});

test('one held sibling cannot contribute allowance or block its behind-plan sibling', () => {
  const [p] = pools([lane('ahead', { pool: 'shared', targetShare: 100 }), lane('behind', { pool: 'shared', planAhead: -0.2 })]);
  assert.deepEqual(p.hardHeldAccountIds, ['ahead']);
  assert.equal(p.cap, 1);
  assert.deepEqual(p.pacedAccountIds, ['ahead']);
});

test('role-empty safety suspends only hard holds and retains the ordinary in-flight cap', () => {
  const first = order([lane('only')]);
  assert.deepEqual(ids(first), ['only']);
  assert.deepEqual(first.holdSuspendedAccountIds, ['only']);
  assert.equal(first.pools[0].cap, 1);
  const busy = order([lane('only', { inFlight: 1 })]);
  assert.deepEqual(ids(busy), []);
  assert.deepEqual(busy.holdSuspendedAccountIds, ['only']);
  // A peer that cannot serve this role must not suppress safety.
  assert.deepEqual(ids(order([lane('only'), lane('wrong-role', { planAhead: -0.1, roleEligible: false })])).filter(id => id === 'only'), ['only']);
});

test('role-empty safety cannot lift reserve or health exclusions', () => {
  const r = order([lane('reserved'), lane('sick', { health: 'unavailable' })],
    { reviewReserve: { heldAccountIds: ['reserved'], forReview: false } });
  assert.deepEqual(ids(r), []);
  assert.deepEqual(r.holdSuspendedAccountIds, []);
});

test('configuration defaults to a 10-point hold, accepts null and rejects malformed thresholds', () => {
  assert.equal(resolveConfig({}).pacing.holdAheadPts, 0.10);
  assert.equal(resolveConfig({ pacing: { holdAheadPts: null } }).pacing.holdAheadPts, null);
  for (const holdAheadPts of [-0.01, 1.01, NaN, Infinity, '0.1', false, {}, []]) {
    assert.ok(validateConfigShape({ pacing: { holdAheadPts } }).some(e => e.includes('pacing.holdAheadPts')), String(holdAheadPts));
  }
  for (const holdAheadPts of [null, 0, 0.2, 1]) assert.deepEqual(validateConfigShape({ pacing: { holdAheadPts } }), []);
});

test('linear plan ends at 100% minus the explicit quota floor without an extra remainder', () => {
  const args = { periodStartMs: 0, periodEndMs: 100, targetUsedPct: 0.85 };
  assert.equal(scheduleError({ ...args, nowMs: 100, usedPct: 0.85 }), 0);
  assert.equal(scheduleError({ ...args, nowMs: 50, usedPct: 0.425 }), 0);
  assert.equal(scheduleError({ periodStartMs: 0, periodEndMs: 100, nowMs: 100, usedPct: 1 }), 0);
});

test('caps cannot allocate a routed reviewer on a hard-held sibling in an otherwise open pool', async () => {
  const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
  const out = allocateKeptAndRoutedCaps({ target: 10,
    agents: [{ agentId: 'review', running: 0, queued: 3 }],
    reviewerAccountIdsByAgent: { review: ['ahead'] },
    accounts: [{ accountId: 'ahead', pool: 'shared' }, { accountId: 'behind', pool: 'shared' }],
    perAccount: [{ accountId: 'ahead', slots: 4 }, { accountId: 'behind', slots: 4 }],
    pacePools: [{ pool: 'shared', cap: 4, hardHeldAccountIds: ['ahead'] }],
  });
  assert.equal([...out.kept, ...out.routed].find(a => a.agentId === 'review').allocated, 0);
});

test('caps preserve running work but give no new fixed-model slots to a hard-held account', async () => {
  const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
  const out = allocateKeptAndRoutedCaps({ target: 10,
    agents: [{ agentId: 'kept', running: 1, queued: 3 }], keepAgentIds: ['kept'],
    keptByAgent: { kept: { accountId: 'ahead' } },
    accounts: [{ accountId: 'ahead', pool: 'shared' }, { accountId: 'behind', pool: 'shared' }],
    perAccount: [{ accountId: 'ahead', slots: 4 }, { accountId: 'behind', slots: 4 }],
    pacePools: [{ pool: 'shared', cap: 4, hardHeldAccountIds: ['ahead'] }],
  });
  assert.equal(out.kept.find(a => a.agentId === 'kept').allocated, 1);
});

test('unknown weekly allowance is not alternate role capacity for empty-role safety', () => {
  const r = order([lane('only'), lane('unknown', { planAhead: null, remainingKnown: false })]);
  assert.deepEqual(r.holdSuspendedAccountIds, ['only']);
  assert.ok(ids(r).includes('only'));
});

test('floating-point noise at exactly ten points ahead does not prolong a weekly hold', () => {
  const r = order([lane('edge', { planAhead: 0.8 - 0.7 }), lane('peer', { planAhead: -0.1 })]);
  assert.ok(ids(r).includes('edge'));
});

test('a role-local routing exception cannot reopen globally pinned capacity for another role', async () => {
  const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
  const local = order([lane('ahead')]);
  assert.ok(ids(local).includes('ahead'), 'the requesting role keeps its safety exception');
  const out = allocateKeptAndRoutedCaps({ target: 10,
    agents: [{ agentId: 'other-role-pin', running: 0, queued: 3 }], keepAgentIds: ['other-role-pin'],
    keptByAgent: { 'other-role-pin': { accountId: 'ahead' } },
    accounts: [{ accountId: 'ahead', pool: 'ahead' }], perAccount: [{ accountId: 'ahead', slots: 4 }],
    pacePools: local.rawPools ?? local.pools,
  });
  assert.equal(out.kept.find(a => a.agentId === 'other-role-pin').allocated, 0);
});

for (const blockingPriority of [false, true]) {
  test(`role-local exception shares one soft-cap slot without admitting other roles (priority=${blockingPriority})`, async () => {
    const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
    const out = allocateKeptAndRoutedCaps({ target: 5, blockingPriority,
      agents: [{ agentId: 'review', running: 0, queued: 2 }, { agentId: 'peer', running: 0, queued: 1 },
        { agentId: 'fixed', running: 0, queued: 1, allocationWeight: 404 }], keepAgentIds: ['fixed'],
      keptByAgent: { fixed: { accountId: 'ahead' } },
      reviewerAccountIdsByAgent: { review: ['ahead'], peer: ['ahead'] },
      reviewerPaceByAgent: { review: { holdSuspendedAccountIds: ['ahead'], pools: [{ pool: 'shared', cap: 1 }] } },
      accounts: [{ accountId: 'ahead', pool: 'shared' }, { accountId: 'behind', pool: 'shared' }],
      perAccount: [{ accountId: 'ahead', slots: 2 }, { accountId: 'behind', slots: 2 }],
      pacePools: [{ pool: 'shared', cap: 1, hardHeldAccountIds: ['ahead'] }],
    });
    const row = id => [...out.kept, ...out.routed].find(a => a.agentId === id);
    assert.equal(row('review').allocated, 1);
    assert.equal(row('peer').allocated, 0);
    assert.equal(row('fixed').allocated, 0);
  });
}

for (const blockingPriority of [false, true]) {
  test(`an idle reviewer's restored pool budget is not fungible for another reviewer (priority=${blockingPriority})`, async () => {
    const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
    const input = { target: 10, blockingPriority,
      agents: [{ agentId: 'exempt', running: 0, queued: 0 }, { agentId: 'peer', running: 0, queued: 5 }],
      reviewerAccountIdsByAgent: { exempt: ['held'], peer: ['unheld'] },
      reviewerPaceByAgent: {
        exempt: { holdSuspendedAccountIds: ['held'], pools: [{ pool: 'shared', cap: 4 }] },
        peer: { holdSuspendedAccountIds: [], pools: [{ pool: 'shared', cap: 3 }] },
      },
      accounts: [{ accountId: 'held', pool: 'shared' }, { accountId: 'unheld', pool: 'shared' }],
      perAccount: [{ accountId: 'held', slots: 1 }, { accountId: 'unheld', slots: 8 }],
      pacePools: [{ pool: 'shared', cap: 3, hardHeldAccountIds: ['held'] }],
    };
    const out = allocateKeptAndRoutedCaps(input);
    const peer = [...out.kept, ...out.routed].find(a => a.agentId === 'peer');
    const both = allocateKeptAndRoutedCaps({ ...input,
      agents: [{ agentId: 'exempt', running: 0, queued: 1 }, { agentId: 'peer', running: 0, queued: 5 }] });
    const rows = [...both.kept, ...both.routed];
    assert.equal(rows.find(a => a.agentId === 'exempt').allocated, 1, 'the exemption still serves its own role');
    assert.equal(rows.find(a => a.agentId === 'peer').allocated, 3);
    assert.equal(rows.reduce((sum, row) => sum + row.allocated, 0), 4, 'one restored slot, spent once');
    assert.equal(peer.allocated, 3, 'a peer cannot spend the idle reviewer\'s restored fourth slot');
  });
}

for (const blockingPriority of [false, true]) {
  for (const heldFirst of [false, true]) {
    test(`overlapping reviewer admissions retain both funded slots (priority=${blockingPriority}, heldFirst=${heldFirst})`, async () => {
      const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
      const input = { target: 2, blockingPriority,
        agents: [{ agentId: 'a', running: 0, queued: 1 }, { agentId: 'b', running: 0, queued: 1 }],
        reviewerAccountIdsByAgent: {
          a: heldFirst ? ['held', 'shared-unheld'] : ['shared-unheld', 'held'],
          b: ['shared-unheld', 'other-unheld'],
        },
        reviewerPaceByAgent: {
          a: { holdSuspendedAccountIds: ['held'], pools: [{ pool: 'shared', cap: 2 }] },
          b: { holdSuspendedAccountIds: [], pools: [{ pool: 'shared', cap: 1 }] },
        },
        accounts: ['held', 'shared-unheld', 'other-unheld'].map(accountId => ({ accountId, pool: 'shared' })),
        perAccount: ['held', 'shared-unheld', 'other-unheld'].map(accountId => ({ accountId, slots: 1 })),
        pacePools: [{ pool: 'shared', cap: 1, hardHeldAccountIds: ['held'] }],
      };
      const rows = result => [...result.kept, ...result.routed];
      const fenced = allocateKeptAndRoutedCaps({ ...input,
        reviewerPaceByAgent: { ...input.reviewerPaceByAgent,
          a: { holdSuspendedAccountIds: [], pools: [{ pool: 'shared', cap: 1 }] } } });
      assert.equal(rows(fenced).reduce((sum, row) => sum + row.allocated, 0), 1,
        'without the exception the single raw pool slot remains the limit');
      const out = rows(allocateKeptAndRoutedCaps(input));
      assert.deepEqual(Object.fromEntries(out.map(row => [row.agentId, row.allocated])), { a: 1, b: 1 },
        'fund A from its held exception so B can still use the ordinary pool slot');
      assert.equal(out.reduce((sum, row) => sum + row.allocated, 0), 2);
    });
  }

  test(`unequal reviewer-local caps stay bound to their own agent (priority=${blockingPriority})`, async () => {
    const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
    const accounts = [
      lane('held-a', { pool: 'shared', targetShare: 20, requiredRatePerHour: 0.01, measuredRatePerHour: 0.04 }),
      lane('held-b', { pool: 'shared', targetShare: 20, requiredRatePerHour: 0.01, measuredRatePerHour: 0.01 }),
    ];
    const raw = pools(accounts);
    const aPace = order(accounts.map(a => ({ ...a, roleEligible: a.accountId === 'held-a' })));
    const bPace = order(accounts.map(a => ({ ...a, roleEligible: a.accountId === 'held-b' })));
    assert.deepEqual(raw[0].hardHeldAccountIds, ['held-a', 'held-b']);
    assert.deepEqual(aPace.holdSuspendedAccountIds, ['held-a']);
    assert.deepEqual(bPace.holdSuspendedAccountIds, ['held-b']);
    // Both C* allowances are 20 * 0.2 = 4, but A's measured-rate correction is 1/4.
    assert.deepEqual([raw[0].cap, aPace.pools[0].cap, bPace.pools[0].cap], [0, 1, 4]);
    const out = allocateKeptAndRoutedCaps({ target: 4, blockingPriority,
      agents: [{ agentId: 'a', running: 0, queued: 4 }, { agentId: 'b', running: 0, queued: 0 }],
      reviewerAccountIdsByAgent: { a: ['held-a'], b: ['held-b'] },
      reviewerPaceByAgent: { a: aPace, b: bPace }, accounts,
      perAccount: [{ accountId: 'held-a', slots: 4 }, { accountId: 'held-b', slots: 4 }], pacePools: raw,
    });
    const rows = [...out.kept, ...out.routed];
    assert.equal(rows.find(a => a.agentId === 'a').allocated, 1,
      'A cannot borrow idle B\'s four-slot exception past its own local cap of one');
    assert.equal(rows.reduce((sum, row) => sum + row.allocated, 0), 1);
  });
}

for (const blockingPriority of [false, true]) {
  test(`reviewer exceptions share capacity and cannot bypass breakers (priority=${blockingPriority})`, async () => {
    const { allocateKeptAndRoutedCaps } = await import('../src/concurrency.mjs');
    const input = { target: 4, blockingPriority,
      agents: [{ agentId: 'a', running: 0, queued: 2 }, { agentId: 'b', running: 0, queued: 2 }],
      reviewerAccountIdsByAgent: { a: ['ahead'], b: ['ahead'] },
      reviewerPaceByAgent: Object.fromEntries(['a', 'b'].map(id => [id,
        { holdSuspendedAccountIds: ['ahead'], pools: [{ pool: 'shared', cap: 1 }] }])),
      accounts: [{ accountId: 'ahead', pool: 'shared' }], perAccount: [{ accountId: 'ahead', slots: 4 }],
      pacePools: [{ pool: 'shared', cap: 0, hardHeldAccountIds: ['ahead'] }] };
    const total = result => result.kept.reduce((n, row) => n + row.allocated, 0);
    assert.equal(total(allocateKeptAndRoutedCaps(input)), 1);
    assert.equal(total(allocateKeptAndRoutedCaps({ ...input, unavailableAccountIds: ['ahead'] })), 0);
  });
}
