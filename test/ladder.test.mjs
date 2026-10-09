import test from 'node:test';
import assert from 'node:assert/strict';
import { paretoFilter, pinRungs, buildLadder } from '../src/ladder.mjs';

// Worked figures from the research example (intelligence, $/task).
const entry = (armId, Q, C, coverage = 1) => ({ armId, Q, C, coverage });

test('pareto drops dominated arms and sorts cheapest-first', () => {
  const { rungs, dominated, dropped } = paretoFilter([
    entry('luna-max', 38.1, 0.07),
    entry('haiku-xhigh', 41.2, 0.124),
    entry('haiku-max', 43.4, 0.213),
    entry('sol-max', 51.8, 0.72),
    entry('sonnet-high', 46.8, 0.88), // beaten on quality by sol-max AND on cost: dominated
    entry('spark-1-3', 48.1, 1.61), // dominated by sol-max
    entry('sonnet-max', 56.0, 5.46),
    entry('opus-5-5', 57.6, 5.98),
  ]);
  assert.ok(!rungs.some(r => r.armId === 'sonnet-high'));
  assert.ok(!rungs.some(r => r.armId === 'spark-1-3'));
  assert.deepEqual(dominated.sort(), ['sonnet-high', 'spark-1-3'].sort());
  assert.deepEqual(dropped, []);
  const costs = rungs.map(r => r.C);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
  assert.equal(rungs[0].rung, 0);
  assert.equal(rungs[rungs.length - 1].armId, 'opus-5-5');
});

test('null Q/C arms are dropped, never scored as zero', () => {
  const { rungs, dropped } = paretoFilter([entry('a', 50, 1), entry('no-cost', 60, null), entry('no-q', null, 0.5)]);
  assert.deepEqual(rungs.map(r => r.armId), ['a']);
  assert.deepEqual(dropped.sort(), ['no-cost', 'no-q']);
});

test('tie-break is deterministic: Q desc, C asc, armId lexical', () => {
  const once = paretoFilter([entry('b', 50, 1), entry('a', 50, 1), entry('c', 40, 0.5)]).rungs.map(r => r.armId);
  const twice = paretoFilter([entry('c', 40, 0.5), entry('a', 50, 1), entry('b', 50, 1)]).rungs.map(r => r.armId);
  assert.deepEqual(once, twice);
});

test('low-coverage arms cannot jump above rung 1', () => {
  const { rungs } = paretoFilter([
    entry('cheap', 30, 0.1, 1),
    entry('mid', 45, 0.5, 1),
    entry('unmeasured-star', 60, 2.0, 0.3),
  ]);
  const star = rungs.find(r => r.armId === 'unmeasured-star');
  assert.ok(star.maxRung <= 1);
});

test('stability: non-dominating newcomers do not displace incumbents', () => {
  const first = buildLadder([entry('a', 40, 0.2), entry('b', 55, 2.0)]);
  const before = new Map(first.rungs.map(r => [r.armId, r.rung]));
  const second = buildLadder(
    [entry('a', 40.5, 0.21), entry('b', 55.2, 2.1), entry('niche', 39, 0.25)],
    first.rungs,
  );
  const after = new Map(second.rungs.map(r => [r.armId, r.rung]));
  assert.equal(after.get('a'), before.get('a'));
  assert.equal(after.get('b'), before.get('b'));
});

test('live codex order: stale pins cannot break cost order', () => {
  // Exact arm set the 0.1.3 shadow served out of order (costs as observed).
  const live = [
    ['luna-low', 1, 0.005], ['luna-medium', 2, 0.017], ['luna-high', 3, 0.029],
    ['luna-xhigh', 4, 0.042], ['luna', 5, 0.068], ['sol-high', 6, 0.319],
    ['sol', 7, 0.724], ['astra-xhigh', 8, 2.309], ['astra', 9, 3.258],
  ];
  const entries = live.map(([armId, Q, C]) => entry(armId, Q, C));
  // Previous snapshot pinned the broken live positions (stale costs).
  const previous = ['luna-low', 'sol-high', 'luna-medium', 'sol', 'luna-high', 'luna-xhigh', 'luna', 'astra-xhigh', 'astra']
    .map((armId, rung) => ({ armId, rung }));
  const { rungs } = buildLadder(entries, previous);
  assert.deepEqual(rungs.map(r => r.armId),
    ['luna-low', 'luna-medium', 'luna-high', 'luna-xhigh', 'luna', 'sol-high', 'sol', 'astra-xhigh', 'astra']);
  const costs = rungs.map(r => r.C);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
  const qs = rungs.map(r => r.Q);
  assert.deepEqual(qs, [...qs].sort((a, b) => a - b));
  assert.deepEqual(rungs.map(r => r.rung), rungs.map((_, i) => i));
});

test('pins hold while cost order is unchanged', () => {
  const first = buildLadder([entry('a', 40, 0.2), entry('b', 55, 2.0)]);
  const second = buildLadder([entry('a', 40.5, 0.21), entry('b', 55.2, 2.1)], first.rungs);
  assert.deepEqual(second.rungs.map(r => r.armId), ['a', 'b']);
  assert.deepEqual(second.rungs.map(r => r.rung), [0, 1]);
});

test('stability: a strictly-dominating newcomer displaces', () => {
  const first = buildLadder([entry('old', 45, 0.8)]);
  const second = buildLadder([entry('old', 45, 0.8), entry('new', 50, 0.5)], first.rungs);
  assert.ok(!second.dominated.includes('new'));
  assert.ok(second.dominated.includes('old'));
});
