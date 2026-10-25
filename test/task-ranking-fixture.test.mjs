import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAaLeaderboardHtml, LEADERBOARD_NUMERIC_FIELDS, FREE_EVAL_FIELD_MAP } from '../src/aa.mjs';
import { discoverTaskArms } from '../src/arms.mjs';
import { METRIC_REGISTRY } from '../src/quality.mjs';
import { buildTaskRanking } from '../src/task-ranking.mjs';
import { decide } from '../src/decide.mjs';

// Stored public observations only. This is deterministic routing replay, not
// a model comparison/evaluation: no network, credentials, provider work or I/O
// except reading the existing checked-in fixture.
test('stored AA observations retain workload costs, sparse coverage and explicit gate suspension', () => {
  const rows = parseAaLeaderboardHtml(readFileSync(new URL('./fixtures/aa-leaderboard-20261017.html', import.meta.url), 'utf8'));
  const discovered = discoverTaskArms(rows, ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
  const ranking = buildTaskRanking({ candidatesByAccount: { fixture: discovered.arms }, snapshotAt: '2026-10-17T00:00:00Z' });
  const doer = ranking.accounts.fixture.roles.doer;
  const haiku = doer.candidates.find(c => c.model === 'claude-haiku-5-5');
  assert.equal(haiku.absoluteCoverage, .85);
  assert.equal(haiku.benchmarkTrusted, true);
  assert.equal(haiku.aaCostPerTask, .21276971216992022);
  assert.equal(haiku.taskCostProxy, haiku.aaCostPerTask);
  assert.equal(haiku.estimatedApiEquivalentPerAcceptedTask, null);
  assert.equal(haiku.cashUsdPerAcceptedTask, null);
  assert.equal(ranking.profiles.doer.suspensionReason, 'insufficient-scored-population');
  const groups = doer.rungs.map(r => ({ rung: r.rung, arms: [doer.candidates.find(c => c.armId === r.armId)] }));
  const selected = decide({ ladderRungs: groups, taskRanking: { mode: 'enforce' } });
  assert.equal(selected.model, 'claude-haiku-5-5');
  assert.match(selected.reason, /AA workload proxy/);
  assert.equal(ranking.calibration.reason, 'awaiting-native-attributed-outcomes');
});

test('every already-ingested metric has a declared registry disposition', () => {
  for (const field of new Set([...LEADERBOARD_NUMERIC_FIELDS, ...Object.values(FREE_EVAL_FIELD_MAP)])) {
    assert.ok(METRIC_REGISTRY[field], `unregistered ingested metric: ${field}`);
    assert.ok(METRIC_REGISTRY[field].category);
    assert.ok(METRIC_REGISTRY[field].units);
    assert.ok(METRIC_REGISTRY[field].version);
  }
});
