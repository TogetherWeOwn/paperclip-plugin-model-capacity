import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ledgerFromJSON, ledgerToJSON, reconcileLedger, shadowEntries,
  inflightByAccount, decidedSince, migrateLegacy,
} from '../src/ledger.mjs';

// Prod upgrade shape (v0.1.13 -> v0.1.14): the legacy in-memory ring held
// 58 entries, but the persisted runs feed already marked 32 of those runs
// terminal. Migration keeps decisions for live runs only -- entries for
// terminal runs are excluded by design (decisions never land on terminal
// records) -- and a same-version restart afterwards loses nothing further.

const T0 = 1_760_000_000_000;
const LIVE = Array.from({ length: 26 }, (_, i) => `run-live-${i}`);
const DEAD = Array.from({ length: 32 }, (_, i) => `run-dead-${i}`);

function legacyInputs() {
  const runs = [
    ...LIVE.map((runId, i) => ({ runId, agentId: 'a', status: 'running', at: T0 - (25 - i) * 60_000 })),
    ...DEAD.map((runId, i) => ({ runId, agentId: 'a', status: 'finished', at: T0 - (300 + i) * 60_000 })),
  ];
  const ringEntries = [
    ...LIVE.map((runId, i) => ({
      runId, agentId: 'a', accountId: 'kimi:k1', enforced: true,
      wouldModel: 'm', at: T0 - (25 - i) * 60_000,
    })),
    ...DEAD.map((runId, i) => ({
      runId, agentId: 'a', accountId: 'kimi:k1', enforced: true,
      wouldModel: 'm', at: T0 - (300 + i) * 60_000,
    })),
  ];
  return { runs, ringEntries };
}

test('upgrade migration keeps live decisions; terminal-run ring entries excluded by design', () => {
  const ledger = migrateLegacy(legacyInputs());
  const shown = new Set(shadowEntries(ledger).map(e => e.runId));
  assert.equal(shown.size, 26);
  for (const id of LIVE) assert.ok(shown.has(id), `${id} lost in migration`);
  for (const id of DEAD) assert.ok(!shown.has(id), `${id} should stay excluded`);
});

test('same-version restart after migration loses nothing (drop is migration-only)', () => {
  const nowMs = T0 + 90_000;
  const reloaded = ledgerFromJSON(ledgerToJSON(migrateLegacy(legacyInputs())));
  reconcileLedger(reloaded, { nowMs, verifyWindowMs: 2 * 3600 * 1000 });
  const shown = new Set(shadowEntries(reloaded).map(e => e.runId));
  assert.equal(shown.size, 26);
  for (const id of LIVE) assert.ok(shown.has(id), `${id} lost on same-version restart`);
});

test('opt-in terminal import is history-only: visible, never counted, never fresh pressure', () => {
  const nowMs = T0 + 90_000;
  const ledger = migrateLegacy({ ...legacyInputs(), includeTerminalDecisions: true });
  const shown = shadowEntries(ledger);
  assert.equal(shown.length, 58);
  const census = inflightByAccount(ledger, { nowMs, horizonMs: 2 * 3600 * 1000 });
  const counted = Object.values(census.byAccount).reduce((a, b) => a + b, 0) + census.unattributed;
  assert.equal(counted, 26);
  // decidedAt stays historical, so a tick at nowMs sees no fresh pressure.
  assert.equal(decidedSince(ledger, nowMs).length, 0);
});
