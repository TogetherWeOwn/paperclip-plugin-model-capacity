import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, OPUS, config, lane, drive, agent } from './weekly-compatibility-fixture.mjs';

async function produced({ disabled = false, running = 1, subject = 'fixed', ahead = false } = {}) {
  const raw = config();
  raw.concurrency.meanRunDurationHours = 4;
  if (disabled) raw.pacing = { holdAheadPts: null };
  const d = await drive({ raw, accounts: [lane('one', ahead ? .85 : .3, ahead ? 120 : 84)],
    demand: [{ agentId: subject, queued: 8 }] });
  await d.tick();
  for (let i = 0; i < running; i++) await d.fire(`evidence-${subject}-${i}`, subject, { model: OPUS });
  await d.tick();
  d.size({ [subject]: { accountId: 'claude:one' } });
  const row = agent(await d.caps(), subject);
  assert.equal(row.running, running, 'real event-backed running floor');
  assert.ok(row.allocated > running, 'the real fresh tick must first grant useful extra capacity');
  return d;
}

// A synthetic legacy wire snapshot, NOT a historical capture or a fabricated
// compatible producer attestation. Retain its sizing/pressure, omit all hold
// evidence and current-instance provenance. It must never authorize new work.
function preFeature(snapshot) {
  const keys = ['atMs', 'companyId', 'target', 'maxTotal', 'calibration', 'accounts', 'perAccount',
    'keepAgentIds', 'keptByAgent', 'inFlightByPool', 'agentRunning', 'demand', 'reviewerAccountIdsByAgent',
    'reviewReserve', 'reviewer', 'allocation', 'roles', 'anchor', 'concurrency', 'routedAccountIds'];
  const old = Object.fromEntries(keys.filter(key => Object.hasOwn(snapshot, key))
    .map(key => [key, structuredClone(snapshot[key])]));
  old.paceGuard = { enabled: true, marginPct: .02,
    pools: snapshot.paceGuard.pools.map(({ pool, lanes, cap, inFlight, pacedSlots, state }) =>
      ({ pool, lanes, cap, inFlight, pacedSlots, state })) };
  return old;
}

// Remove explicit schema/evidence versions, wherever a current producer puts
// them. Do not forge a "current" generation or hard-code a future schema name.
function withoutVersions(value) {
  if (Array.isArray(value)) return value.map(withoutVersions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !/version/i.test(name))
    .map(([name, child]) => [name, withoutVersions(child)]));
}

function reasonValues(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string' && /reason|message|code|error|status|state/i.test(key)
      ? [child] : reasonValues(child));
}

for (const subject of ['fixed', 'review']) {
  for (const running of [0, 1, 2]) {
    test(`fresh compatible ${subject} facts authorize useful new work above the floor (${running})`, async () => {
      const d = await produced({ subject, running });
      const capacity = await d.capacity();
      assert.equal(capacity.atMs, NOW);
      assert.equal(capacity.paceGuard.holdAheadPts, .1);
      assert.deepEqual(capacity.reviewerAccountIdsByAgent.review, ['claude:one']);
      assert.ok(agent(await d.caps(), subject).allocated > running);
    });
  }
}

const invalidations = [
  ['old-policy-now-held', async d => {
    assert.ok(d.snapshot().accounts[0].planAhead > .5, 'the lane is genuinely far ahead before the policy changes');
    await d.configure({ ...d.raw, pacing: { holdAheadPts: .1 } });
  }, { disabled: true, ahead: true }],
  ['pre-feature', async d => { d.seedSnapshot(preFeature(d.snapshot())); }],
  ['missing-evidence-version', async d => { d.seedSnapshot(withoutVersions(d.snapshot())); }],
  ['configuration-generation', async d => {
    await d.configure({ ...d.raw, pacing: { holdAheadPts: .05 } });
  }],
  ['admission-generation', async d => {
    await d.configure({ ...d.raw, roles: { ...d.raw.roles,
      excludeFamilies: { doer: ['opus'], thinker: ['opus'], other: ['opus'] } } });
  }],
  ['previous-instance-epoch', async d => { await d.restart(); }],
  ['numeric-only-admission', async d => {
    const snapshot = structuredClone(d.snapshot());
    delete snapshot.reviewAdmissionEpoch;
    d.seedSnapshot(snapshot);
  }],
  ['expired-120001ms', async d => { d.setNow(NOW + 120001); }],
  ['future-1ms', async d => {
    const snapshot = structuredClone(d.snapshot()); snapshot.atMs = NOW + 1; d.seedSnapshot(snapshot);
  }],
];

for (const [name, invalidate, producerOptions] of invalidations) {
  for (const subject of ['fixed', 'review']) {
    for (const running of [0, 1]) {
      test(`unavailable ${name} facts after failed refresh grant no ${subject} NEW slots (${running} running)`, async t => {
        const d = await produced({ ...producerOptions, subject, running });
        d.failRefresh();
        await invalidate(d);
        const replay = structuredClone(d.snapshot());
        await d.tick().catch(error => assert.match(error.message, /quota-refresh-failed|synthetic-refresh-failed/));
        // Consumer acceptance: replay the exact last-good/legacy wire blob
        // after a real refresh failure. Do not claim the failed producer emitted it.
        d.seedSnapshot(replay);
        const body = await d.caps(), row = agent(body, subject);
        t.diagnostic(JSON.stringify({ name, now: d.now(), atMs: body.atMs, row, capsError: body.capsError }));
        assert.equal(row.running, running, 'unavailable evidence cannot erase an executing physical run');
        assert.equal(row.allocated, running, 'a once-measured snapshot is not current-policy hold evidence');
        assert.match(reasonValues(body).join('\n'), /stale|unavailable|incompatible|evidence|epoch|generation|freshness|refresh.failed/i,
          'the API must expose why affected extra capacity is unavailable');
      });
    }
  }
}

for (const disabled of [false, true]) {
  test(`hold-specific freshness does not change disabled-hold fixed behavior (disabled=${disabled})`, async t => {
    const raw = config(); raw.concurrency.meanRunDurationHours = 4;
    if (disabled) raw.pacing = { holdAheadPts: null };
    const d = await drive({ raw, demand: [{ agentId: 'fixed', queued: 4 }] });
    await d.tick(); d.size({ fixed: { accountId: 'claude:one' } }, 4);
    assert.equal(agent(await d.caps(), 'fixed').allocated, 4);
    const replay = structuredClone(d.snapshot());
    d.failRefresh(); d.setNow(NOW + 120001);
    await d.tick().catch(error => assert.match(error.message, /quota-refresh-failed|synthetic-refresh-failed/));
    d.seedSnapshot(replay);
    const row = agent(await d.caps(), 'fixed');
    t.diagnostic(JSON.stringify(row));
    assert.equal(row.allocated, disabled ? 4 : 0);
  });
}
