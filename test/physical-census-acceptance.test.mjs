import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, OPUS, SONNET, config, lane, drive, agent } from './weekly-compatibility-fixture.mjs';

// Physical census acceptance: verified in-scope running records stay pressure
// independent of usable agent identity. Ledger, physical counts and the real
// pace bound are asserted BEFORE allocation in every case. The sizing seam
// below changes target, calibration, per-account slots and kept bindings only.

const ledgerRecords = d => [...d.store.entries()]
  .filter(([k]) => k.includes('ledger-v1'))
  .flatMap(([, v]) => v);
const attributed = r => r.decidedAccount ?? r.actualAccount ?? null;
const rawPool = (snapshot, pool) => snapshot.paceGuard.rawPools.find(p => p.pool === pool);
const capsRow = (caps, id) => caps.agents.find(r => r.agentId === id);
const labelOf = v => v === null ? 'null' : v === undefined ? 'missing' : v === '' ? 'empty' : String(v);

const unusableIds = ['unknown', '', null, undefined];

function firePhysical(d, runId, agentId, fields = {}, type = 'agent.run.started') {
  if (agentId !== undefined) return d.fire(runId, agentId, fields, type);
  const run = { provider: 'claude', ...fields };
  assert.equal(Object.hasOwn(run, 'agentId'), false, 'missing identity is an omitted wire field, not just undefined');
  return d.fireEvent({ type, companyId: 'acme', entityId: runId,
    occurredAt: new Date(d.now()).toISOString(), payload: { run } });
}
const FREE_MODEL = 'nvidia-nim/step-5-preview-nim';

// Genuine unknown-account fixtures. A single unready account plus a full
// family exclusion leaves the started record with final null attribution
// (no invented shadow or routing account). Usable and missing metadata are
// built first and the null precondition is asserted explicitly.
async function unknownAccountDrive(agentId) {
  const raw = config();
  raw.reviewerRouting = undefined;
  raw.roles.keepAgentIds = ['fixed'];
  raw.roles.excludeFamilies = { doer: ['opus'], thinker: ['opus'], other: ['opus'] };
  const blocked = lane('one', 0.3, 84);
  blocked.credentialAvailability = { version: 1, models: [] };
  const d = await drive({ raw, accounts: [blocked], demand: [{ agentId: 'fixed', queued: 4 }] });
  await d.tick();
  await firePhysical(d,`genuine-unknown-${labelOf(agentId)}`, agentId, { provider: 'unmapped-provider' });
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } }, 4);
  return d;
}

test('genuine unknown-account usable identity keeps null attribution and denies fixed', async t => {
  const d = await unknownAccountDrive('peer');
  const records = ledgerRecords(d);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'running');
  assert.equal(records[0].unverified, false);
  assert.equal(attributed(records[0]), null, 'no invented account for the running record');
  const snapshot = d.snapshot();
  assert.deepEqual(snapshot.inFlightByAccount, {});
  assert.deepEqual(snapshot.inFlightByPool, {});
  assert.equal(snapshot.paceGuard.unattributedInFlight, 1);
  assert.deepEqual(snapshot.paceGuard.rawPools, []);
  assert.equal(snapshot.agentRunning.peer?.running, 1);
  assert.equal(snapshot.agentRunning.peer?.unattributedRunning, 1);
  const caps = await d.caps();
  t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
  assert.equal(capsRow(caps, 'fixed').allocated, 0);
  assert.equal(capsRow(caps, 'fixed').maxConcurrentRuns, 0);
  assert.equal(capsRow(caps, 'fixed').running, 0);
  assert.equal(capsRow(caps, 'fixed').queued, 4);
  assert.equal(capsRow(caps, 'fixed').freeAllocated ?? 0, 0, 'unknown charge is never free capacity');
  assert.equal(capsRow(caps, 'peer').running, 1);
  assert.ok(capsRow(caps, 'peer').allocated >= 1, 'named running floor survives');
});

for (const agentId of unusableIds) {
  test(`genuine unknown-account ${labelOf(agentId)} identity keeps null attribution and denies fixed likewise`, async t => {
    const d = await unknownAccountDrive(agentId);
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'running');
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), null, 'no invented account for the running record');
    const snapshot = d.snapshot();
    assert.deepEqual(snapshot.inFlightByAccount, {});
    assert.deepEqual(snapshot.inFlightByPool, {});
    assert.equal(snapshot.paceGuard.unattributedInFlight, 1);
    assert.deepEqual(snapshot.paceGuard.rawPools, []);
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'fixed').allocated, 0, 'identity-less pressure denies exactly like the named peer');
    assert.equal(capsRow(caps, 'fixed').maxConcurrentRuns, 0);
    assert.equal(capsRow(caps, 'fixed').freeAllocated ?? 0, 0, 'unknown charge is never free capacity');
    assert.equal(capsRow(caps, 'unknown'), undefined, 'no fabricated runnable identity');
    assert.equal(capsRow(caps, ''), undefined, 'no fabricated runnable identity');
  });
}

// Known recorded account and pool charge: one real pool at cap 1 with one
// verified running record, fixed demand of four queued runs.
async function knownDrive(agentId, fields = {}, subject = 'fixed') {
  const raw = config();
  raw.reviewerRouting = undefined;
  raw.roles.keepAgentIds = [subject];
  const d = await drive({ raw, accounts: [lane('one', 0.3, 84)], demand: [{ agentId: subject, queued: 4 }] });
  await d.tick();
  await firePhysical(d,`known-${subject}-${labelOf(agentId)}-${Object.keys(fields).length}`, agentId, fields);
  await d.tick();
  d.size({ [subject]: { accountId: 'claude:one' } }, 4);
  return d;
}

test('known charge named peer denies fixed new grant', async t => {
  const d = await knownDrive('peer');
  const records = ledgerRecords(d);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'running');
  assert.equal(records[0].unverified, false);
  assert.equal(attributed(records[0]), 'claude:one');
  const snapshot = d.snapshot();
  assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
  assert.equal(snapshot.inFlightByPool.claude, 1);
  assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 1, inFlight: 1 });
  assert.equal(snapshot.agentRunning.peer?.running, 1);
  const caps = await d.caps();
  t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
  assert.equal(capsRow(caps, 'fixed').allocated, 0);
  assert.equal(capsRow(caps, 'fixed').maxConcurrentRuns, 0);
  assert.equal(capsRow(caps, 'peer').running, 1);
  assert.ok(capsRow(caps, 'peer').allocated >= 1, 'named running floor survives');
});

for (const agentId of unusableIds) {
  test(`known charge ${labelOf(agentId)} identity denies fixed exactly like the named peer`, async t => {
    const d = await knownDrive(agentId);
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'running');
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), 'claude:one', 'actual recorded charge is kept');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
    assert.equal(snapshot.inFlightByPool.claude, 1);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 1, inFlight: 1 });
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'fixed').allocated, 0, 'identity-less pressure denies exactly like the named peer');
    assert.equal(capsRow(caps, 'fixed').maxConcurrentRuns, 0);
    assert.equal(capsRow(caps, 'unknown'), undefined, 'no fabricated runnable identity');
    assert.equal(capsRow(caps, ''), undefined, 'no fabricated runnable identity');
  });
}

test('known charge explicit input still denies fixed for named and identity-less runs', async t => {
  for (const agentId of ['peer', 'unknown']) {
    const d = await knownDrive(agentId, { model: OPUS, accountId: 'claude:one' });
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), 'claude:one');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
    assert.equal(rawPool(snapshot, 'claude').cap, 1);
    assert.equal(rawPool(snapshot, 'claude').inFlight, 1);
    assert.equal(capsRow(await d.caps(), 'fixed').allocated, 0, `explicit ${labelOf(agentId)} input`);
  }
});

test('known charge named peer denies kept reviewer new grant', async t => {
  const d = await knownDrive('peer', {}, 'review');
  const records = ledgerRecords(d);
  assert.equal(attributed(records[0]), 'claude:one');
  assert.equal(records[0].unverified, false);
  const snapshot = d.snapshot();
  assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
  assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 1, inFlight: 1 });
  assert.equal(capsRow(await d.caps(), 'review').allocated, 0);
});

for (const agentId of unusableIds) {
  test(`known charge ${labelOf(agentId)} identity denies kept reviewer exactly like the named peer`, async t => {
    const d = await knownDrive(agentId, {}, 'review');
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), 'claude:one');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
    assert.equal(snapshot.inFlightByPool.claude, 1);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 1, inFlight: 1 });
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'review').allocated, 0, 'identity-less pressure denies exactly like the named peer');
    assert.equal(capsRow(caps, 'unknown'), undefined, 'no fabricated runnable identity');
  });
}

// Discriminating slack: cap 2 with one running run leaves exactly one new
// slot. A dropped run grants two, a double count grants zero.
async function slackDrive(agentId) {
  const raw = config();
  raw.reviewerRouting = undefined;
  raw.roles.keepAgentIds = ['fixed'];
  const d = await drive({ raw, accounts: [lane('one', 0.1, 84), lane('two', 0.1, 84)], demand: [{ agentId: 'fixed', queued: 4 }] });
  await d.tick();
  await firePhysical(d,`slack-${labelOf(agentId)}`, agentId, {});
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } }, 4);
  return d;
}

test('slack control named peer leaves exactly one new fixed slot on cap 2', async t => {
  const d = await slackDrive('peer');
  const records = ledgerRecords(d);
  assert.equal(attributed(records[0]), 'claude:one');
  assert.equal(records[0].unverified, false);
  const snapshot = d.snapshot();
  assert.equal(snapshot.inFlightByPool.claude, 1);
  assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 2, inFlight: 1 });
  assert.equal(capsRow(await d.caps(), 'fixed').allocated, 1);
});

for (const agentId of unusableIds) {
  test(`slack ${labelOf(agentId)} identity leaves exactly one new fixed slot, not two or zero`, async t => {
    const d = await slackDrive(agentId);
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), 'claude:one');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
    assert.equal(snapshot.inFlightByPool.claude, 1);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 2, inFlight: 1 });
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'fixed').allocated, 1, 'a dropped run would grant two, a double count zero');
  });
}

// Overlapping census on a wider pool: two physical runs on cap 4 leave two
// new slots however the identities mix.
async function overlapDrive(firstId, secondId) {
  const raw = config();
  raw.reviewerRouting = undefined;
  raw.roles.keepAgentIds = ['fixed'];
  const d = await drive({ raw, accounts: [lane('one', 0.05, 84), lane('two', 0.05, 84), lane('three', 0.05, 84)], demand: [{ agentId: 'fixed', queued: 4 }] });
  await d.tick();
  await firePhysical(d,`overlap-${labelOf(firstId)}-1`, firstId, {});
  await firePhysical(d,`overlap-${labelOf(secondId)}-2`, secondId, {});
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } }, 4);
  return d;
}

for (const [firstId, secondId] of [['peer', 'peer2'], ['peer', 'unknown'], ['unknown', '']]) {
  test(`overlapping ${labelOf(firstId)} plus ${labelOf(secondId)} counts two physical runs once each`, async t => {
    const d = await overlapDrive(firstId, secondId);
    const records = ledgerRecords(d);
    assert.equal(records.length, 2);
    for (const r of records) {
      assert.equal(r.status, 'running');
      assert.equal(r.unverified, false);
      assert.ok(attributed(r)?.startsWith('claude:'), 'each run keeps its recorded charge');
    }
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByPool.claude, 2);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 4, inFlight: 2 });
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'fixed').allocated, 2, 'two runs on cap 4 leave two new slots');
  });
}

// Over-cap running never creates new allowance.
async function overcapDrive(firstId, secondId) {
  const raw = config();
  raw.reviewerRouting = undefined;
  raw.roles.keepAgentIds = ['fixed'];
  const d = await drive({ raw, accounts: [lane('one', 0.3, 84)], demand: [{ agentId: 'fixed', queued: 4 }] });
  await d.tick();
  await firePhysical(d,`overcap-${labelOf(firstId)}-1`, firstId, {});
  await firePhysical(d,`overcap-${labelOf(secondId)}-2`, secondId, {});
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } }, 4);
  return d;
}

for (const [firstId, secondId] of [['peer', 'peer2'], ['peer', 'unknown'], ['unknown', ''], ['unknown', null]]) {
  test(`over-cap ${labelOf(firstId)} plus ${labelOf(secondId)} grants no new fixed allowance`, async t => {
    const d = await overcapDrive(firstId, secondId);
    const records = ledgerRecords(d);
    assert.equal(records.length, 2);
    for (const r of records) {
      assert.equal(r.unverified, false);
      assert.equal(attributed(r), 'claude:one');
    }
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:one'], 2);
    assert.equal(snapshot.inFlightByPool.claude, 2);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 1, inFlight: 2 });
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'fixed').allocated, 0, 'over-cap work is retained, never extra allowance');
    assert.equal(capsRow(caps, 'fixed').running, 0);
  });
}

// Independent pool totals: pressure on one pool never blocks the other.
for (const agentId of ['peer', 'unknown']) {
  test(`pressure on one pool leaves the independent pool useful (${labelOf(agentId)} occupant)`, async t => {
    const raw = config();
    raw.reviewerRouting = undefined;
    raw.roles.keepAgentIds = ['fixed'];
    const other = lane('g1', 0.1, 84, { provider: 'gemini', models: ['gemini-2-5-flash'] });
    const d = await drive({ raw, accounts: [lane('one', 0.3, 84), other], demand: [{ agentId: 'fixed', queued: 4 }] });
    await d.tick();
    await firePhysical(d,`independent-${labelOf(agentId)}`, agentId, {});
    await d.tick();
    d.size({ fixed: { accountId: 'gemini:g1' } }, 4);
    const records = ledgerRecords(d);
    assert.equal(attributed(records[0]), 'claude:one');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
    assert.equal(rawPool(snapshot, 'claude').cap, 1);
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'fixed').allocated, 4, 'the independent pool keeps its own total');
  });
}

// Reviewer-local ordinary pressure: a run on the admitted review arm blocks
// reviewer new work however its identity reads.
for (const agentId of ['peer', 'ordinary', ...unusableIds]) {
  test(`reviewer-local ${labelOf(agentId)} pressure blocks reviewer new work`, async t => {
    const raw = config();
    raw.reviewerRouting.agentIds = ['review', 'peer'];
    const d = await drive({ raw, accounts: [lane('review-only', 0.58, 84), lane('other-arm', 0.3, 84, { models: [SONNET] })], demand: [{ agentId: 'review', queued: 8 }] });
    await d.tick();
    await firePhysical(d,`review-local-${labelOf(agentId)}`, agentId, {});
    await d.tick();
    d.size({ peer: { accountId: 'claude:review-only' } });
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].unverified, false);
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByPool.claude, 1);
    const local = snapshot.reviewerPaceByAgent.review.pools.find(p => p.pool === 'claude');
    assert.equal(local.cap, 1, 'only the admitted review arm supplies local allowance');
    assert.equal(local.inFlight, 1);
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, local, caps: caps.agents }));
    assert.equal(capsRow(caps, 'review').allocated, 0);
  });
}

// Held occupancy stays blocking however the identity reads.
for (const agentId of ['peer', 'unknown']) {
  test(`held occupancy ${labelOf(agentId)} blocks fixed new work`, async t => {
    const raw = config();
    raw.reviewerRouting = undefined;
    raw.roles.keepAgentIds = ['fixed'];
    const d = await drive({ raw, accounts: [lane('held', 0.85, 120)], demand: [{ agentId: 'fixed', queued: 4 }] });
    await d.tick();
    await firePhysical(d,`held-${labelOf(agentId)}`, agentId, { model: OPUS, accountId: 'claude:held' });
    await d.tick();
    d.size({ fixed: { accountId: 'claude:held' } }, 4);
    const records = ledgerRecords(d);
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), 'claude:held');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:held'], 1);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 0, inFlight: 1 });
    assert.equal(capsRow(await d.caps(), 'fixed').allocated, 0);
  });
}

test('ordinary named occupancy blocks fixed new work', async () => {
  const d = await knownDrive('ordinary');
  const records = ledgerRecords(d);
  assert.equal(attributed(records[0]), 'claude:one');
  const snapshot = d.snapshot();
  assert.equal(snapshot.inFlightByPool.claude, 1);
  assert.equal(rawPool(snapshot, 'claude').cap, 1);
  assert.equal(capsRow(await d.caps(), 'fixed').allocated, 0);
  assert.equal(capsRow(await d.caps(), 'ordinary').running, 1);
});

// Unknown charge is never free capacity.
for (const agentId of ['peer', 'unknown']) {
  test(`free lanes ${labelOf(agentId)} charge keeps paid pressure without free grant`, async t => {
    const raw = config();
    raw.reviewerRouting = undefined;
    raw.roles.keepAgentIds = ['fixed'];
    raw.freeLanes = { enabled: true, lowRiskAgentIds: ['triage'], providers: { 'nvidia-nim': { requestsPerMinute: 36, requestsPerMinutePerSlot: 12 } } };
    const d = await drive({ raw, accounts: [lane('one', 0.3, 84)], demand: [{ agentId: 'fixed', queued: 4 }] });
    await d.tick();
    await firePhysical(d,`free-${labelOf(agentId)}`, agentId, {});
    await d.tick();
    d.size({ fixed: { accountId: 'claude:one' } }, 4);
    const records = ledgerRecords(d);
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), 'claude:one');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByPool.claude, 1);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 1, inFlight: 1 });
    const caps = await d.caps();
    assert.equal(capsRow(caps, 'fixed').allocated, 0);
    assert.equal(capsRow(caps, 'fixed').freeAllocated ?? 0, 0, 'unknown charge is never free capacity');
  });
}

// Genuine free-credential physical occupancy. One real nim free account plus
// one paid claude account, existing free-lane semantics (freeCost provider,
// low-risk triage, reactive free meter). Fire-only running (hook defers on
// missing fresh evidence in this harness) still yields verified actual free
// attribution and a paid/free census split. Extra free grants beyond the
// running floor are not constructible here (free target stays 0); only the
// floor, attribution and no-reclassification are pinned.
function genuineFreeRaw() {
  const raw = config();
  raw.reviewerRouting = undefined;
  raw.roles.keepAgentIds = ['fixed'];
  raw.freeLanes = { enabled: true, lowRiskAgentIds: ['triage'], providers: { 'nvidia-nim': { requestsPerMinute: 36, requestsPerMinutePerSlot: 12 } } };
  raw.placement = { freeCostProviders: ['nvidia-nim'] };
  raw.modelAaOverrides = { 'step-5-preview-nim': { slug: 'step-5', effort: 'max' } };
  raw.trials = { maxInFlightPerAccount: 1, maxInFlightPerFamily: 1 };
  raw.roles.minQuality = { doer: 0.4, other: 0.4, thinker: 0.4 };
  return raw;
}
function genuineFreeAccounts() {
  const iso = new Date(NOW).toISOString();
  return [
    { lane: 'n1', provider: 'nvidia-nim', accountKey: 'n1', plan: 'free', meter: 'reactive', health: 'healthy', models: [FREE_MODEL], observedAt: iso, weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null } },
    lane('one', 0.3, 84),
  ];
}
function genuineFreeRows() {
  return [
    { slug: 'step-5', intelligenceIndex: 72, intelligenceIndexCostPerTask: 9, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: OPUS, intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  ];
}
async function genuineFreeDrive(agentId) {
  const d = await drive({ raw: genuineFreeRaw(), accounts: genuineFreeAccounts(), aaRows: genuineFreeRows(), demand: [{ agentId: 'fixed', queued: 4 }] });
  await d.tick();
  await firePhysical(d,`genuine-free-${labelOf(agentId)}`, agentId, { issueId: 'i1', model: FREE_MODEL, modelSource: 'run-decision' });
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } }, 4);
  return d;
}

test('genuine free named triage keeps verified free attribution with paid-free distinction', async t => {
  const d = await genuineFreeDrive('triage');
  const records = ledgerRecords(d);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'running');
  assert.equal(records[0].unverified, false);
  assert.equal(records[0].decidedAccount ?? null, null, 'fire-only free has no shadow decision');
  assert.equal(records[0].actualAccount ?? null, 'nvidia-nim:n1', 'verified actual free-credential charge');
  assert.equal(attributed(records[0]), 'nvidia-nim:n1');
  const snapshot = d.snapshot();
  const capacity = await d.capacity();
  t.diagnostic(JSON.stringify({ records, agentRunning: snapshot.agentRunning, inFlightByAccount: snapshot.inFlightByAccount, inFlightByPool: snapshot.inFlightByPool, freeProviders: capacity.freeLanes?.providers }));
  assert.equal(snapshot.inFlightByAccount['nvidia-nim:n1'], 1, 'actual physical free count, not a config label');
  assert.equal(snapshot.inFlightByPool['nvidia-nim'], 1);
  assert.equal(snapshot.inFlightByAccount['claude:one'] ?? 0, 0, 'free work is never reclassified into paid pressure');
  assert.equal(snapshot.inFlightByPool.claude ?? 0, 0);
  assert.equal(snapshot.agentRunning.triage?.running, 0, 'paid running stays zero');
  assert.equal(snapshot.agentRunning.triage?.freeRunning, 1, 'free running is distinct from paid');
  assert.equal(capacity.freeLanes?.providers?.['nvidia-nim']?.inFlight, 1, 'actual free provider occupancy');
  const caps = await d.caps();
  assert.equal(capsRow(caps, 'triage')?.running, 1);
  assert.equal(capsRow(caps, 'triage')?.freeAllocated, 1, 'running-free floor survives; extra grant not constructible here');
  assert.equal(capsRow(caps, 'fixed')?.freeAllocated ?? 0, 0, 'paid fixed never receives free capacity');
});

for (const agentId of unusableIds) {
  test(`genuine free ${labelOf(agentId)} identity keeps verified free attribution without fabrication`, async t => {
    const d = await genuineFreeDrive(agentId);
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'running');
    assert.equal(records[0].unverified, false);
    assert.equal(records[0].actualAccount ?? null, 'nvidia-nim:n1', 'verified actual free-credential charge independent of identity');
    assert.equal(attributed(records[0]), 'nvidia-nim:n1');
    const snapshot = d.snapshot();
    const capacity = await d.capacity();
    t.diagnostic(JSON.stringify({ records, agentRunning: snapshot.agentRunning, inFlightByAccount: snapshot.inFlightByAccount, inFlightByPool: snapshot.inFlightByPool, freeProviders: capacity.freeLanes?.providers, caps: (await d.caps()).agents }));
    assert.equal(snapshot.inFlightByAccount['nvidia-nim:n1'], 1, 'actual physical free count matches the named control');
    assert.equal(snapshot.inFlightByPool['nvidia-nim'], 1);
    assert.equal(snapshot.inFlightByAccount['claude:one'] ?? 0, 0, 'free work is never reclassified into paid pressure');
    assert.equal(capacity.freeLanes?.providers?.['nvidia-nim']?.inFlight, 1, 'actual free provider occupancy matches the named control');
    const caps = await d.caps();
    assert.equal(capsRow(caps, 'unknown'), undefined, 'no fabricated runnable identity');
    assert.equal(capsRow(caps, ''), undefined, 'no fabricated runnable identity');
    assert.equal(capsRow(caps, 'fixed')?.freeAllocated ?? 0, 0, 'no invented free exemption for identity-less runs');
  });
}

// Burn identity is explicit: an ordinary recorded charge is never burn.
test('verified burn running pressure preserves the explicit ordinary-cap exemption', async () => {
  const burnRaw = config();
  burnRaw.burnMode = { accounts: ['claude:burn'] };
  const burnDrive = await drive({ raw: burnRaw, accounts: [lane('ordinary', 0.58, 84), lane('burn', 0.85, 120, { models: [SONNET] })], demand: [{ agentId: 'review', queued: 1 }] });
  await burnDrive.tick();
  await burnDrive.fire('burn-ordinary-control', 'burn-worker', { model: SONNET, accountId: 'claude:burn' });
  await burnDrive.tick();
  const burnCapacity = await burnDrive.capacity();
  assert.equal(burnCapacity.inFlightByPool.claude ?? 0, 1, 'actual burn work remains physical pool occupancy');
  const burnPool = burnCapacity.paceGuard.rawPools.find(p => p.pool === 'claude');
  assert.ok(burnPool.burnAccountIds?.includes('claude:burn'), 'burn identity is explicit');
  assert.equal(burnPool.inFlight, 0, 'burn pressure is not ordinary paced pressure');
});

test('a verified actual ordinary charge is not relabelled as its prior burn decision', async t => {
  const raw = config();
  raw.burnMode = { accounts: ['claude:burn'] };
  const d = await drive({ raw, accounts: [lane('ordinary', 0.58, 84), lane('burn', 0.85, 120, { models: [SONNET] })], demand: [{ agentId: 'review', queued: 1 }] });
  await d.tick();
  await firePhysical(d,'burn-unknown-ordinary', 'unknown', { model: OPUS, accountId: 'claude:ordinary' });
  await d.tick();
  const records = ledgerRecords(d);
  assert.equal(records.length, 1);
  assert.equal(records[0].unverified, false);
  // The recorded ordinary charge must not be reclassified as burn.
  assert.equal(records[0].actualAccount ?? null, 'claude:ordinary');
  const snapshot = d.snapshot();
  t.diagnostic(JSON.stringify({ records: records.map(r => ({ runId: r.runId, agentId: r.agentId, status: r.status, unverified: r.unverified, decidedAccount: r.decidedAccount ?? null, actualAccount: r.actualAccount ?? null, actualModel: r.actualModel ?? null, eventModel: r.eventModel ?? null })), inFlightByAccount: snapshot.inFlightByAccount, inFlightByPool: snapshot.inFlightByPool, rawPools: snapshot.paceGuard.rawPools, localPools: snapshot.reviewerPaceByAgent?.review?.pools ?? null }));
  assert.equal(snapshot.inFlightByPool.claude, 1);
  const pool = snapshot.paceGuard.rawPools.find(p => p.pool === 'claude');
  assert.ok(pool.burnAccountIds?.includes('claude:burn'), 'the ordinary allowance filter cannot erase burn identity');
  assert.equal(pool.inFlight, 1, 'an ordinary recorded charge is never burn-excluded');
});

// Pending hook decisions count the physical run once after it starts.
async function pendingDrive(agentId) {
  const raw = config();
  raw.reviewerRouting = undefined;
  raw.roles.keepAgentIds = ['fixed'];
  const d = await drive({ raw, accounts: [lane('one', 0.1, 84), lane('two', 0.1, 84)], demand: [{ agentId: 'fixed', queued: 4 }] });
  await d.tick();
  const hook = await d.hook(`pending-${labelOf(agentId)}`, { agentId });
  assert.equal(hook.kind, 'decide');
  await firePhysical(d,`pending-${labelOf(agentId)}`, agentId, {});
  await d.tick();
  d.size({ fixed: { accountId: 'claude:one' } }, 4);
  return d;
}

test('pending named run counts once and leaves one slack slot', async () => {
  const d = await pendingDrive('peer');
  const records = ledgerRecords(d);
  assert.equal(records.length, 1);
  assert.equal(records[0].unverified, false);
  assert.equal(attributed(records[0]), 'claude:one');
  const snapshot = d.snapshot();
  assert.equal(snapshot.inFlightByPool.claude, 1);
  assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 2, inFlight: 1 });
  assert.equal(capsRow(await d.caps(), 'fixed').allocated, 1);
});

for (const agentId of unusableIds) {
  test(`pending ${labelOf(agentId)} run counts once and leaves one slack slot`, async t => {
    const d = await pendingDrive(agentId);
    const records = ledgerRecords(d);
    assert.equal(records.length, 1);
    assert.equal(records[0].unverified, false);
    assert.equal(attributed(records[0]), 'claude:one');
    const snapshot = d.snapshot();
    assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
    assert.equal(snapshot.inFlightByPool.claude, 1);
    assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 2, inFlight: 1 });
    const caps = await d.caps();
    t.diagnostic(JSON.stringify({ records, caps: caps.agents }));
    assert.equal(capsRow(caps, 'fixed').allocated, 1, 'a dropped pending run would grant two, a double count zero');
  });
}

test('hostile identity counts without polluting the shared prototype', async () => {
  const d = await knownDrive('__proto__');
  const records = ledgerRecords(d);
  assert.equal(records.length, 1);
  assert.equal(records[0].unverified, false);
  assert.equal(attributed(records[0]), 'claude:one');
  const snapshot = d.snapshot();
  assert.equal(snapshot.inFlightByAccount['claude:one'], 1);
  assert.deepEqual({ cap: rawPool(snapshot, 'claude').cap, inFlight: rawPool(snapshot, 'claude').inFlight }, { cap: 1, inFlight: 1 });
  assert.equal(Object.hasOwn(snapshot.agentRunning, '__proto__'), true);
  assert.equal(snapshot.agentRunning['__proto__']?.running, 1);
  const caps = await d.caps();
  assert.equal(capsRow(caps, 'fixed').allocated, 0);
  assert.equal(capsRow(caps, '__proto__').running, 1);
  assert.equal({}.running, undefined);
  assert.equal(Object.prototype.running, undefined);
});

test('a distinct safe emission remains useful beside a held credential', async () => {
  const raw = config();
  raw.reviewerRouting.arms = [{ provider: 'claude', model: OPUS }, { provider: 'claude', model: SONNET }];
  const d = await drive({ raw, accounts: [lane('held', 0.85, 120), lane('safe', 0.3, 84, { models: [SONNET] })], demand: [{ agentId: 'fixed', queued: 4 }] });
  await d.tick();
  d.size({ fixed: { accountId: 'claude:safe' } });
  const caps = await d.caps();
  assert.ok(capsRow(caps, 'fixed').allocated > 0, 'the safe emission has actual new capacity');
  const decision = await d.hook('safe-useful-census', { agentId: 'doer' });
  assert.equal(decision.kind, 'decide');
  assert.equal(decision.model, SONNET, 'only the safe model rules out the held credential');
});
