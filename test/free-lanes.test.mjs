import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFreeLanes, validateFreeLanes, providerSlots, freeProvider,
  lowRiskRun, freeArmVerdict, freeLaneBudget, reserveFreeRun, freeLaneCaps,
} from '../src/free-lanes.mjs';

const NOW = Date.parse('2026-10-25T15:00:00Z');
const config = (extra = {}) => normalizeFreeLanes({ enabled: true, lowRiskAgentIds: ['triage'],
  providers: { 'nvidia-nim': { requestsPerMinute: 36, requestsPerMinutePerSlot: 12 },
    openrouter: { requestsPerMinute: 20, requestsPerMinutePerSlot: 12, requestsPerDay: 1000, requestsPerRun: 100 } }, ...extra });
const account = { accountId: 'nim:a', laneProvider: 'nvidia-nim', freeCost: true };
const arm = { armId: 'step:max', family: 'step', model: 'nvidia-nim/step-5-preview-nim', qFleet: 0.446 };
const run = { runId: 'r', agentId: 'triage', issueId: 'i', previous: null };
const records = (successes, extra = {}) => Array.from({ length: 10 }, (_, i) => ({
  runId: `r${i}`, enforced: true, freeProvider: 'nvidia-nim', armId: arm.armId,
  status: i < successes ? 'finished' : 'failed', progress: i < successes ? 'progressed' : null,
  terminalAt: NOW - i * 1000, ...extra,
}));

test('free lanes default off; validation rejects malformed and unbounded budgets', () => {
  assert.equal(normalizeFreeLanes().enabled, false);
  assert.equal(normalizeFreeLanes().minQuality, 0.4);
  assert.deepEqual(validateFreeLanes(config()), []);
  for (const raw of [false, [], { enabled: 'true' }, { minQuality: NaN },
    { providers: { nim: { requestsPerMinute: Infinity } } },
    { providers: { nim: { requestsPerMinute: 36, requestsPerMinutePerSlot: 0 } } },
    { providers: { openrouter: { requestsPerMinute: 20, requestsPerDay: 1000 } } },
    { demotion: { lastRuns: 0 } }, { lowRiskAgentIds: [''] }]) {
    assert.ok(validateFreeLanes(raw).length > 0, JSON.stringify(raw));
  }
});

test('rate sizing uses one shared provider limit, not accounts or keys', () => {
  assert.equal(providerSlots(config().providers['nvidia-nim']), 3);
  assert.equal(providerSlots(config().providers.openrouter), 1);
  assert.equal(providerSlots({ requestsPerMinute: 5, requestsPerMinutePerSlot: 12 }), 0);
  assert.equal(providerSlots({ requestsPerMinute: 36 }), 3);
  assert.equal(freeProvider(account, config()), 'nvidia-nim');
  assert.equal(freeProvider({ ...account, freeCost: false }, config()), null);
  for (const provider of ['synthetic', 'cloudflare', 'cloudflare-workers-ai']) {
    assert.equal(freeProvider({ ...account, laneProvider: provider }, config({ providers: {
      [provider]: { requestsPerMinute: 36 },
    } })), null, 'paid or unmetered-neuron providers cannot become a free lane by config');
  }
  assert.equal(freeProvider(account, normalizeFreeLanes()), null);
});

test('low risk requires an issue, explicit dedicated agent, non-gating role, no previous attempt', () => {
  assert.equal(lowRiskRun(run, config(), { role: 'other' }), true);
  for (const params of [{ ...run, issueId: null }, { ...run, agentId: 'builder' },
    { ...run, previous: { runId: 'previous' } }, { ...run, issueOverrideModel: 'pinned' }]) {
    assert.equal(lowRiskRun(params, config(), { role: 'doer' }), false);
  }
  assert.equal(lowRiskRun(run, config(), { role: 'thinker' }), false);
  assert.equal(lowRiskRun(run, config(), { role: 'doer', kept: true }), false);
  assert.equal(lowRiskRun(run, config(), { role: 'doer', reviewer: true }), false);
  assert.equal(lowRiskRun({ ...run, agentId: 'builder', wakeReason: 'monitor_due' }, config(), { role: 'doer' }), false);
});

test('free floor is strict even for tiny populations, unknown scores and NIM Muse are denied', () => {
  assert.equal(freeArmVerdict(arm, 'nvidia-nim', [], config(), NOW).eligible, true);
  for (const qFleet of [null, undefined, NaN, 0.399]) {
    assert.equal(freeArmVerdict({ ...arm, qFleet }, 'nvidia-nim', [], config(), NOW).eligible, false);
  }
  assert.equal(freeArmVerdict({ ...arm, qFleet: 0.3 }, 'nvidia-nim', [], config({ minQuality: 0.2 }), NOW).eligible, true);
  assert.equal(freeArmVerdict({ ...arm, model: 'nvidia-nim/meta/muse-spark', family: 'muse' }, 'nvidia-nim', [], config(), NOW).eligible, false);
  assert.equal(freeArmVerdict({ ...arm, model: 'nvidia-nim/meta/muse-spark', family: 'other' }, 'nvidia-nim', [], config(), NOW).eligible, false);
});

test('demote exact free arm below 80% of last ten measured outcomes, never forgive because all failed', () => {
  assert.equal(freeArmVerdict(arm, 'nvidia-nim', records(8), config(), NOW).eligible, true);
  const bad = freeArmVerdict(arm, 'nvidia-nim', records(7), config(), NOW);
  assert.equal(bad.eligible, false);
  assert.equal(bad.reason, 'outcome-demoted');
  assert.equal(bad.successRate, 0.7);
  assert.equal(freeArmVerdict(arm, 'nvidia-nim', records(0), config(), NOW).eligible, false);
  assert.equal(freeArmVerdict(arm, 'nvidia-nim', records(0).slice(0, 9), config(), NOW).eligible, true);
  for (const extra of [{ armId: 'another' }, { freeProvider: 'other' }, { enforced: false },
    { status: 'cancelled' }, { status: 'finished', progress: 'unknown' }, { terminalAt: NOW - 25 * 3600000 }]) {
    assert.equal(freeArmVerdict(arm, 'nvidia-nim', records(0, extra), config(), NOW).eligible, true);
  }
  assert.equal(freeArmVerdict(arm, 'nvidia-nim', records(10, { progress: 'noChange' }), config(), NOW).eligible, false);
});

test('latest ten outcomes and duplicate run ids do not inflate evidence', () => {
  const olderBad = records(0).map((r, i) => ({ ...r, runId: `old${i}`, terminalAt: NOW - 60000 - i }));
  assert.equal(freeArmVerdict(arm, 'nvidia-nim', [...olderBad, ...records(10)], config(), NOW).eligible, true);
  assert.equal(freeArmVerdict(arm, 'nvidia-nim', Array(10).fill(records(0)[0]), config(), NOW).eligible, true);
});

test('provider occupancy counts enforced pending and running across accounts once, excluding self and terminals', () => {
  const accounts = [account, { ...account, accountId: 'nim:b' }];
  const ledger = new Map(Array.from({ length: 3 }, (_, i) => [`r${i}`, {
    runId: `r${i}`, decidedAccount: i % 2 ? 'nim:b' : 'nim:a', enforced: true,
    decidedAt: NOW, status: 'running',
  }]));
  assert.equal(freeLaneBudget('nvidia-nim', accounts, ledger, {}, config(), NOW).available, 0);
  assert.equal(freeLaneBudget('nvidia-nim', accounts, ledger, {}, config(), NOW, 'r0').available, 1);
  ledger.get('r0').status = 'finished';
  assert.equal(freeLaneBudget('nvidia-nim', accounts, ledger, {}, config(), NOW).available, 1);
  ledger.get('r1').enforced = false;
  assert.equal(freeLaneBudget('nvidia-nim', accounts, ledger, {}, config(), NOW).available, 2);
});

test('daily request reservations bound admissions and reset at UTC day boundary', () => {
  const usage = {};
  const or = [{ accountId: 'or:a', laneProvider: 'openrouter', freeCost: true }];
  for (let i = 0; i < 10; i++) {
    assert.equal(freeLaneBudget('openrouter', or, new Map(), usage, config(), NOW).available, 1);
    reserveFreeRun(usage, 'openrouter', config(), NOW);
  }
  assert.equal(freeLaneBudget('openrouter', or, new Map(), usage, config(), NOW).available, 0);
  assert.equal(freeLaneBudget('openrouter', or, new Map(), usage, config(), NOW + 86400000).available, 1);
});

test('additive caps preserve paid allocation exactly and do not charge free running to paid', () => {
  const paid = [{ agentId: 'builder', running: 1, queued: 4, allocated: 2 },
    { agentId: 'triage', running: 0, queued: 5, allocated: 0 }];
  const original = structuredClone(paid);
  const out = freeLaneCaps(paid, { triage: 2 }, 3, ['triage'], 75);
  assert.deepEqual(paid, original);
  assert.equal(out.find(a => a.agentId === 'builder').allocated, 2);
  assert.equal(out.find(a => a.agentId === 'triage').allocated, 3);
  assert.equal(out.find(a => a.agentId === 'triage').freeAllocated, 3);
  const shed = freeLaneCaps(paid, { triage: 4 }, 0, ['triage'], 75);
  assert.equal(shed.find(a => a.agentId === 'triage').allocated, 4, 'never cancel existing free runs');
});

test('OpenRouter requires an exact :free model id, not just a free-plan account', () => {
  assert.equal(freeArmVerdict({ ...arm, model: 'openrouter/vendor/step:free' }, 'openrouter', [], config(), NOW).eligible, true);
  assert.equal(freeArmVerdict({ ...arm, model: 'openrouter/vendor/step' }, 'openrouter', [], config(), NOW).eligible, false);
  assert.equal(freeProvider({ ...account, laneProvider: 'synthetic-infinite' }, config({ providers: {
    'synthetic-infinite': { requestsPerMinute: 36 },
  } })), null);
});

test('caps retain free-only running agents even when no queue or paid allocation remains', () => {
  const out = freeLaneCaps([{ agentId: 'builder', running: 1, queued: 0, allocated: 1 }], { triage: 3 }, 0, [], 75);
  assert.equal(out.find(a => a.agentId === 'triage')?.allocated, 3);
  assert.equal(out.find(a => a.agentId === 'triage')?.running, 3);
});

test('additive caps cannot grant paid starts above the hard ceiling already occupied by free runs', () => {
  const out = freeLaneCaps([{ agentId: 'builder', running: 0, queued: 10, allocated: 2 }], { triage: 1 }, 1, [], 2);
  assert.equal(out.reduce((sum, a) => sum + a.allocated, 0), 2);
  assert.equal(out.find(a => a.agentId === 'triage')?.allocated, 1);
});

test('all cap consumers see free headroom and free-only running floors', () => {
  const out = freeLaneCaps([{ agentId: 'triage', running: 0, queued: 5, allocated: 0, maxConcurrentRuns: 0 }], {}, 3, ['triage'], 75);
  assert.equal(out[0].maxConcurrentRuns, 3);
  const runningOnly = freeLaneCaps([], { triage: 2 }, 0, [], 75);
  assert.equal(runningOnly[0].maxConcurrentRuns, 2);
});


test('running-first free caps honor the process ceiling across mixed running and queued demand', () => {
  for (let paidRunning = 0; paidRunning <= 3; paidRunning++) {
    for (let paidQueued = 0; paidQueued <= 3; paidQueued++) {
      for (let freeRunning = 0; freeRunning <= 3; freeRunning++) {
        for (let ceiling = 1; ceiling <= 5; ceiling++) {
          const input = [{ agentId: 'triage', running: paidRunning, queued: 8, allocated: paidRunning + paidQueued }];
          const out = freeLaneCaps(input, { triage: freeRunning }, 3, ['triage'], ceiling);
          assert.ok(out[0].allocated >= paidRunning + freeRunning);
          assert.ok(out[0].allocated <= Math.max(ceiling, paidRunning + freeRunning));
          assert.equal(out[0].maxConcurrentRuns, out[0].allocated);
          assert.equal(input[0].allocated, paidRunning + paidQueued, 'input remains unchanged');
        }
      }
    }
  }
});
