import test from 'node:test';
import assert from 'node:assert/strict';
import { computeComposite, DEFAULT_WEIGHTS } from '../src/quality.mjs';

const arm = (armId, row) => ({ armId, row });

test('weights sum to 1 across the research metrics', () => {
  const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('nulls renormalize instead of zero-imputing', () => {
  const arms = [
    arm('full', { terminalbenchHard: 70, scicode: 60, tau2: 90, apexAgents: 30, intelligenceIndex: 55, omniscience: 90, lcr: 50 }),
    // Sparse newcomer: measured only on the general index. Zero-imputation
    // would tank it; renormalization scores it on what exists.
    arm('sparse', { intelligenceIndex: 58 }),
  ];
  const [full, sparse] = computeComposite(arms);
  assert.ok(Math.abs(sparse.coverage - 0.1) < 1e-9);
  // Scored only on intelligenceIndex, where it sits above the two-arm mean:
  // renormalization keeps its full z-score instead of diluting it toward 0.
  assert.ok(Math.abs(sparse.Q - 1) < 1e-9);
  assert.ok(sparse.Q > full.Q);
});

test('omniscience is a penalty term: higher hallucination scores lower', () => {
  // Per spec the raw field is a hallucination rate (higher = worse) and the
  // composite negates it. OPEN: verify this direction against live AA data.
  const arms = [
    arm('clean', { terminalbenchHard: 60, omniscience: 5 }),
    arm('sloppy', { terminalbenchHard: 60, omniscience: 50 }),
  ];
  const byId = new Map(computeComposite(arms, { terminalBench: 0.5, omniscience: 0.5 }).map(s => [s.armId, s]));
  assert.ok(byId.get('clean').Q > byId.get('sloppy').Q);
});

test('identical arms score zero; empty arms are ineligible, not zero', () => {
  const [a, b] = computeComposite([arm('a', { intelligenceIndex: 50 }), arm('b', { intelligenceIndex: 50 })]);
  assert.equal(a.Q, 0);
  assert.equal(b.Q, 0);
  const [empty] = computeComposite([arm('empty', {})]);
  assert.equal(empty.Q, null);
  assert.equal(empty.coverage, 0);
});

test('terminal-bench falls back to V40 when Hard and V21 are null', () => {
  // Free-tier rows (e.g. claude-opus-5-5) carry only terminalbenchV40.
  const [lo, hi] = computeComposite([
    arm('lo', { terminalbenchV40: 0.5 }),
    arm('hi', { terminalbenchV40: 0.6 }),
  ]);
  assert.equal(lo.coverage, 1);
  assert.equal(hi.coverage, 1);
  assert.ok(Math.abs(lo.Q - -1) < 1e-9);
  assert.ok(Math.abs(hi.Q - 1) < 1e-9);
});

test('hle scores arms: higher is better', () => {
  const byId = new Map(computeComposite([
    arm('low', { hle: 10 }),
    arm('high', { hle: 20 }),
  ]).map(s => [s.armId, s]));
  assert.ok(byId.get('high').Q > byId.get('low').Q);
  assert.equal(byId.get('high').coverage, 1);
});

test('coverage is against common support, not the full metric list', () => {
  // Neither arm is measured on tau2/apex/hle/omniscience/lcr; those leave
  // the denominator instead of dragging both arms under the ladder bar.
  const [a, b] = computeComposite([
    arm('a', { intelligenceIndex: 50, scicode: 60 }),
    arm('b', { intelligenceIndex: 60 }),
  ]);
  assert.equal(a.coverage, 1);
  const expected = DEFAULT_WEIGHTS.intelligenceIndex
    / (DEFAULT_WEIGHTS.intelligenceIndex + DEFAULT_WEIGHTS.scicode);
  assert.ok(Math.abs(b.coverage - expected) < 1e-9);
});

test('composite is deterministic for the same snapshot', () => {
  const arms = [
    arm('m1', { terminalbenchHard: 61, scicode: 55, intelligenceIndex: 43.4 }),
    arm('m2', { terminalbenchHard: 70, tau2: 99, intelligenceIndex: 51.8 }),
  ];
  assert.deepEqual(computeComposite(arms), computeComposite(structuredClone(arms)));
});
