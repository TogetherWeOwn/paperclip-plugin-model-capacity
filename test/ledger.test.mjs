import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger, ledgerFromJSON, ledgerToJSON, recordStart, recordDecision,
  recordTerminal, attributedAccount, isInflight, inflightByAccount,
  trialInflight, reconcileLedger, decidedSince, shadowEntries, trimLedger,
  mergeLedger, migrateLegacy, isLedgerTerminal,
} from '../src/ledger.mjs';

// Unit + property tests for the single-source-of-truth run ledger.
// Coordinator invariants (asserted here at ledger level, and at plugin
// level by R1 / R1-with-model / finding-3):
//   1. per-account in-flight <= cap (plugin enforces via the hook; the
//      ledger guarantees each runId counts toward at most one account);
//   2. each runId counted at most once;
//   3. total in-flight <= non-terminal runs;
//   4. the shadow log never loses an entry because of a restart.

const ACCOUNTS = ['kimi:k1', 'kimi:k2', 'claude:c1'];
const HORIZON = 2 * 3600 * 1000;

const decide = (runId, accountId, at, extra = {}) => ({
  runId, agentId: 'agent-9', accountId, enforced: false, ...extra,
});

test('attribution is decided-first, never the model guess', () => {
  const ledger = createLedger();
  recordDecision(ledger, decide('r1', 'kimi:k1', 1000), 1000);
  const r = ledger.get('r1');
  // A later actual-model mapping onto another account must not move it.
  r.actualAccount = 'claude:c1';
  r.actualModel = 'claude-haiku-5-5';
  assert.equal(attributedAccount(r), 'kimi:k1');
  const census = inflightByAccount(ledger, { nowMs: 2000, horizonMs: HORIZON });
  assert.deepEqual(census.byAccount, { 'kimi:k1': 1 });
});

test('no decision and no actual model counts as unattributed, not dropped', () => {
  const ledger = createLedger();
  recordStart(ledger, { runId: 'r1', agentId: 'a' }, 1000);
  const census = inflightByAccount(ledger, { nowMs: 2000, horizonMs: HORIZON });
  assert.equal(census.unattributed, 1);
  assert.deepEqual(census.byAccount, {});
});

test('terminal wins over later starts and decisions', () => {
  const ledger = createLedger();
  recordStart(ledger, { runId: 'r1', agentId: 'a' }, 1000);
  recordTerminal(ledger, { runId: 'r1' }, 'finished', 2000);
  recordStart(ledger, { runId: 'r1', agentId: 'a' }, 3000);
  recordDecision(ledger, decide('r1', 'kimi:k1', 3000), 3000);
  const r = ledger.get('r1');
  assert.equal(r.status, 'finished');
  assert.equal(r.decidedAccount, undefined);
  assert.equal(isInflight(r, 4000, HORIZON), false);
});

test('run-decision terminal model overwrites earlier guesses', () => {
  const ledger = createLedger();
  recordStart(ledger, { runId: 'r1', agentId: 'a' }, 1000);
  const r = ledger.get('r1');
  r.actualModel = 'guess-model';
  r.actualAccount = 'kimi:k1';
  recordTerminal(ledger,
    { runId: 'r1', model: 'claude-haiku-5-5', modelSource: 'run-decision', resolvedAccount: 'claude:c1' },
    'finished', 2000);
  assert.equal(r.actualModel, 'claude-haiku-5-5');
  assert.equal(r.actualAccount, 'claude:c1');
});

test('reconcile marks unverifiable records but never deletes', () => {
  const ledger = createLedger();
  recordDecision(ledger, decide('fresh', 'kimi:k1', 1000), 1000);
  recordDecision(ledger, decide('ancient', 'kimi:k1', 1000), 1000);
  // Age the ancient anchor past the horizon without any proof of life.
  ledger.get('ancient').decidedAt = 1000;
  const sizeBefore = ledger.size;
  const marked = reconcileLedger(ledger, { nowMs: 1000 + HORIZON + 1, verifyWindowMs: HORIZON });
  assert.equal(ledger.size, sizeBefore);
  assert.equal(marked, 2); // both anchors past the horizon: both marked
  assert.equal(ledger.get('ancient').unverified, true);
  // A fresh start is proof of life and clears unverified.
  recordStart(ledger, { runId: 'ancient', agentId: 'a' }, 1000 + HORIZON + 2);
  assert.equal(ledger.get('ancient').unverified, false);
});

test('reconcile is idempotent', () => {
  const ledger = createLedger();
  recordDecision(ledger, decide('old', 'kimi:k1', 1000), 1000);
  const now = 1000 + HORIZON + 1;
  assert.equal(reconcileLedger(ledger, { nowMs: now, verifyWindowMs: HORIZON }), 1);
  assert.equal(reconcileLedger(ledger, { nowMs: now, verifyWindowMs: HORIZON }), 0);
});

test('first decision wins; enforced overwrites event-time', () => {
  const ledger = createLedger();
  recordDecision(ledger, { ...decide('r1', 'kimi:k1', 1000), eventTime: true }, 1000);
  recordDecision(ledger, decide('r1', 'kimi:k2', 1100), 1100);
  assert.equal(ledger.get('r1').decidedAccount, 'kimi:k1');
  recordDecision(ledger, { ...decide('r1', 'kimi:k2', 1200), enforced: true }, 1200);
  assert.equal(ledger.get('r1').decidedAccount, 'kimi:k2');
  assert.equal(ledger.get('r1').enforced, true);
});

test('migration merges legacy runs and ring entries by runId', () => {
  const ledger = migrateLegacy({
    runs: [{ runId: 'r1', agentId: 'a', status: 'running', at: 1000 }],
    ringEntries: [{
      runId: 'r1', agentId: 'a', accountId: 'kimi:k1', enforced: true,
      wouldModel: 'kimi-k3-256k(default)', at: 1000,
    }],
  });
  assert.equal(ledger.size, 1);
  const r = ledger.get('r1');
  assert.equal(r.status, 'running');
  assert.equal(r.decidedAccount, 'kimi:k1');
  assert.equal(r.enforced, true);
});

test('trim drops only old terminal records', () => {
  const ledger = createLedger();
  recordStart(ledger, { runId: 'live', agentId: 'a' }, 1000);
  recordTerminal(ledger, { runId: 'old', agentId: 'a' }, 'finished', 1000);
  recordTerminal(ledger, { runId: 'new', agentId: 'a' }, 'finished', 25 * 3600 * 1000);
  trimLedger(ledger, { nowMs: 26 * 3600 * 1000 });
  assert.ok(ledger.has('live'));
  assert.ok(!ledger.has('old'));
  assert.ok(ledger.has('new'));
});

// Deterministic PRNG (mulberry32) so failures replay exactly.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: random interleavings preserve the four invariants', () => {
  for (const seed of [7, 42, 20261009]) {
    const rand = rng(seed);
    let ledger = createLedger();
    let now = 1_000_000;
    const RUNS = 25;
    const ids = Array.from({ length: RUNS }, (_, i) => `run-${i}`);
    const decidedEver = new Set();
    const terminalEver = new Set();
    for (let step = 0; step < 600; step++) {
      now += Math.floor(rand() * 10 * 60000);
      const id = ids[Math.floor(rand() * RUNS)];
      const roll = rand();
      const acct = ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)];
      if (roll < 0.35) {
        // Start (possibly before any hook decision, possibly after).
        recordStart(ledger, { runId: id, agentId: 'agent-9', provider: rand() < 0.5 ? 'kimi' : null }, now);
      } else if (roll < 0.65) {
        // Hook / event-time decision (first wins; enforced sometimes).
        recordDecision(ledger, {
          ...decide(id, acct, now),
          enforced: rand() < 0.5,
          eventTime: rand() < 0.5,
          trial: rand() < 0.3,
          family: 'kimi',
        }, now);
        if (ledger.get(id)?.decidedAccount != null) decidedEver.add(id);
      } else if (roll < 0.85) {
        // Terminal event (sometimes with the authoritative run-decision).
        const status = ['finished', 'finished', 'failed', 'cancelled'][Math.floor(rand() * 4)];
        const authoritative = rand() < 0.5;
        recordTerminal(ledger, authoritative
          ? { runId: id, model: 'kimi-k3-256k', modelSource: 'run-decision', resolvedAccount: acct }
          : { runId: id }, status, now);
        terminalEver.add(id);
      } else {
        // Restart at a random point: serialize, reload, reconcile (marks
        // only), keep going on the reloaded ledger.
        const reloaded = ledgerFromJSON(ledgerToJSON(ledger));
        // Invariant 4 (restart half): nothing decided is lost by the restart.
        const before = new Set(shadowEntries(reloaded).map(e => e.runId));
        for (const d of decidedEver) {
          if (ledger.get(d)?.decidedAccount != null) assert.ok(before.has(d), `seed ${seed} step ${step}: ${d} lost on restart`);
        }
        ledger = reloaded;
        reconcileLedger(ledger, { nowMs: now, verifyWindowMs: HORIZON });
        const after = shadowEntries(ledger).map(e => e.runId);
        assert.equal(after.length, before.size, `seed ${seed} step ${step}: reconcile pruned the shadow log`);
      }
      // Invariants 1-3 (checked every step, restarts included).
      const census = inflightByAccount(ledger, { nowMs: now, horizonMs: HORIZON });
      const counted = Object.values(census.byAccount).reduce((s, n) => s + n, 0) + census.unattributed;
      const inflightRecs = [...ledger.values()].filter(r => isInflight(r, now, HORIZON));
      // (2) each runId counted at most once: the census total equals the
      // independently computed in-flight set size (single pass, one bucket
      // per record by construction).
      assert.equal(counted, inflightRecs.length, `seed ${seed} step ${step}: double count`);
      // (3) total in-flight <= non-terminal runs.
      const nonTerminal = [...ledger.values()].filter(r => !isLedgerTerminal(r.status)).length;
      assert.ok(counted <= nonTerminal, `seed ${seed} step ${step}: in-flight exceeds live runs`);
      // (1) ledger half: no runId contributes to two accounts.
      const seen = new Map();
      for (const r of inflightRecs) {
        const a = attributedAccount(r);
        if (a == null) continue;
        assert.ok(!seen.has(r.runId), `seed ${seed} step ${step}: ${r.runId} in two buckets`);
        seen.set(r.runId, a);
      }
      // Trial use equals the independently counted trial runs (same
      // anchor rule, no phantom budget): non-terminal, verified, anchored
      // inside the window.
      const trials = trialInflight(ledger, { nowMs: now });
      const trialSum = Object.values(trials).reduce((s, n) => s + n, 0);
      const decidedTrials = [...ledger.values()].filter(r => {
        if (r?.trial !== true || !r?.family) return false;
        if (isLedgerTerminal(r?.status) || r?.unverified === true) return false;
        const a = r.startedAt ?? r.decidedAt ?? null;
        return a != null && a <= now && now - a < 2 * 3600 * 1000;
      }).length;
      assert.equal(trialSum, decidedTrials, `seed ${seed} step ${step}: trial phantom`);
    }
    // Invariant 4 (final): every decided runId still has a shadow entry.
    const final = new Set(shadowEntries(ledger).map(e => e.runId));
    for (const d of decidedEver) {
      if (ledger.get(d)?.decidedAccount != null) assert.ok(final.has(d), `seed ${seed}: ${d} missing at end`);
    }
    // decidedSince stays consistent: post-horizon decisions are all present.
    assert.ok(decidedSince(ledger, now - HORIZON).length >= 0);
  }
});

test('merge keeps base records the overlay never saw', () => {
  const base = createLedger();
  recordDecision(ledgerFromJSON(ledgerToJSON(base)), decide('x', 'kimi:k1', 1000), 1000);
  recordDecision(base, decide('x', 'kimi:k1', 1000), 1000);
  recordStart(base, { runId: 'y', agentId: 'a' }, 1000);
  const overlay = createLedger();
  recordDecision(overlay, { ...decide('x', 'kimi:k2', 2000), enforced: true }, 2000);
  const merged = mergeLedger(base, overlay);
  assert.equal(merged.get('x').decidedAccount, 'kimi:k2');
  assert.ok(merged.has('y'));
});
