import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEeeComposite, blendQ, blendAlphaForRole, eeeUsable,
  ciGateAllowsReorder, eeeFamilyPrior, eeeGateDatum, normalizeEeeId, eeeKeyToArm,
  DEFAULT_EEE_WEIGHTS, DEFAULT_EEE_BLEND_DOER, DEFAULT_EEE_BLEND_THINKER,
  EEE_VERSION,
} from '../src/eee.mjs';
import { buildLadder } from '../src/ladder.mjs';

// ---------------------------------------------------------------------------
// Fixture: derived-JSON-shaped scores with the report's real TB4 numbers.
// opus-5.5 64.85 (CI 61.7-68.0), sonnet-5.5 61.82 (58.9-64.8),
// gpt-6.1-sol 58.18 (55.1-61.3), glm-5.3 41.82 (38.6-45.1),
// gpt-6-luna 16.36 (13.6-19.1). SE derived from the CI half-width / 1.96.
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-10-09T00:00:00Z');
const tb4 = (score, lo, hi, evalDate, harness = 'Claude Code') => ({
  score, se: (hi - lo) / (2 * 1.96), ciLow: lo, ciHigh: hi, n: 330,
  evalDate, harness, firstParty: false,
});
const FIXTURE = {
  'opus-5.5(max)': { benchmarks: { tb4: tb4(64.85, 61.74, 67.96, '2026-09-22') } },
  'sonnet-5.5(max)': { benchmarks: { tb4: tb4(61.82, 58.9, 64.8, '2026-09-28') } },
  'gpt-6.1-sol(max)': { benchmarks: { tb4: tb4(58.18, 55.07, 61.29, '2026-09-29', 'Codex') } },
  'gpt-6-astra(high)': { benchmarks: { tb4: tb4(57.88, 54.9, 60.9, '2026-09-03', 'Codex') } },
  'glm-5.3(max)': { benchmarks: { tb4: tb4(41.82, 38.59, 45.05, '2026-08-14') } },
  'gpt-6-luna(max)': { benchmarks: { tb4: tb4(16.36, 13.64, 19.08, '2026-09-22', 'Codex') } },
  'muse-spark-1.3(xhigh)': { benchmarks: { tb4: tb4(14.55, 11.6, 17.5, '2026-09-02', 'Muse Code') } },
};
const arms = Object.keys(FIXTURE).map(k => {
  const m = /^(.*)\((.*)\)$/.exec(k);
  return { armId: k, model: m[1], effort: m[2] };
});

test('EEE weights sum to 1', () => {
  const total = Object.values(DEFAULT_EEE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('fixture -> exact Q_eee ordering: opus > sonnet > sol > glm > luna', () => {
  // The max-effort fixture arms all score; the high/xhigh rows (astra-high,
  // muse-xhigh) have no same-effort comparison set on this metric and score
  // null here (high->max borrowing only flows into max arms, and xhigh rows
  // inform only xhigh arms). The ordering assertion covers the scored arms.
  const maxArms = arms.filter(a => a.effort === 'max');
  const out = computeEeeComposite(maxArms, FIXTURE, { nowMs: NOW });
  const q = new Map([...out].map(([k, v]) => [k, v.Qeee]));
  for (const [, v] of out) assert.notEqual(v.Qeee, null);
  assert.ok(q.get('opus-5.5(max)') > q.get('sonnet-5.5(max)'));
  assert.ok(q.get('sonnet-5.5(max)') > q.get('gpt-6.1-sol(max)'));
  assert.ok(q.get('gpt-6.1-sol(max)') > q.get('glm-5.3(max)'));
  assert.ok(q.get('glm-5.3(max)') > q.get('gpt-6-luna(max)'));
  // Same-effort comparison: xhigh arms against each other score and order.
  const xArms = [
    { armId: 'muse-spark-1.3(xhigh)', model: 'muse-spark-1.3', effort: 'xhigh' },
    { armId: 'fable-5.1(xhigh)', model: 'fable-5.1', effort: 'xhigh' },
  ];
  const xFix = {
    'muse-spark-1.3(xhigh)': FIXTURE['muse-spark-1.3(xhigh)'],
    'fable-5.1(xhigh)': { benchmarks: { tb4: tb4(57.88, 54.52, 61.24, '2026-09-01') } },
  };
  const xOut = computeEeeComposite(xArms, xFix, { nowMs: NOW });
  assert.ok(xOut.get('fable-5.1(xhigh)').Qeee > xOut.get('muse-spark-1.3(xhigh)').Qeee);
});

test('fixture Q_eee values are exact and deterministic', () => {
  const once = computeEeeComposite(arms, FIXTURE, { nowMs: NOW });
  const twice = computeEeeComposite(structuredClone(arms), structuredClone(FIXTURE), { nowMs: NOW });
  assert.deepEqual([...once], [...twice]);
  // Spot values pinned by this fixture (single shared metric: z-scored TB4
  // with reliability+staleness adjustments; harness mismatch x0.7 applies
  // to the Codex/Muse-Code rows against claude-family arms only where the
  // families differ -- here every row informs its own arm, so the z-scores
  // dominate). Values printed by the module, pinned against regressions.
  const q = new Map([...once].map(([k, v]) => [k, v.Qeee]));
  assert.ok(Math.abs(q.get('opus-5.5(max)') - 0.9938) < 0.005);
  assert.ok(Math.abs(q.get('sonnet-5.5(max)') - 0.8416) < 0.005);
  assert.ok(Math.abs(q.get('gpt-6.1-sol(max)') - 0.6588) < 0.005);
  assert.ok(Math.abs(q.get('glm-5.3(max)') - -0.1630) < 0.005);
  assert.ok(Math.abs(q.get('gpt-6-luna(max)') - -1.4420) < 0.005);
});

test('mapping: -fc strips, unknown/ rows normalize but stay joinable', () => {
  assert.equal(normalizeEeeId('moonshotai/moonshotai-kimi-k2-instruct-fc'), 'moonshotai-kimi-k2-instruct');
  assert.equal(normalizeEeeId('anthropic/claude-opus-4-5-20251101-prompt'), 'claude-opus-4-5-20251101');
  assert.equal(normalizeEeeId('unknown/CodeArts-MiniMax-M2.5'), 'codearts-minimax-m2.5');
  // Dotted ids survive: gpt-6.1-sol and muse-spark-1.3 keep their dots, and
  // (effort) decorations strip only on known effort labels.
  assert.equal(normalizeEeeId('gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(normalizeEeeId('muse-spark-1.3(xhigh)'), 'muse-spark-1.3');
  assert.deepEqual(eeeKeyToArm('glm-5.3(max)'), { model: 'glm-5.3', effort: 'max' });
  assert.deepEqual(eeeKeyToArm('claude-haiku-5-5(max)[1m]'), { model: 'claude-haiku-5-5', effort: 'max' });
  assert.equal(eeeKeyToArm(null), null);
});

test('haiku-5-5 (no EEE data) scores null: AA-only by construction', () => {
  const withHaiku = [...arms, { armId: 'claude-haiku-5-5', model: 'claude-haiku-5-5', effort: 'max' }];
  const out = computeEeeComposite(withHaiku, FIXTURE, { nowMs: NOW });
  const haiku = out.get('claude-haiku-5-5');
  assert.equal(haiku.Qeee, null);
  assert.equal(haiku.coverage, 0);
  // Blend keeps Q_aa untouched when Q_eee is null.
  assert.equal(blendQ(0.7, null, DEFAULT_EEE_BLEND_DOER), 0.7);
});

test('CI gate: opus vs sonnet no reorder; glm vs luna reorder', () => {
  // Report §5: opus-sonnet Δ=3.03 with combined 95% bar ≈ 4.3 -> retain.
  const opusSe = (67.96 - 61.74) / (2 * 1.96);
  const sonnetSe = (64.8 - 58.9) / (2 * 1.96);
  assert.equal(ciGateAllowsReorder(opusSe, sonnetSe, 64.85 - 61.82), false);
  // glm-luna Δ=25.5 -> reorder allowed.
  const glmSe = (45.05 - 38.59) / (2 * 1.96);
  const lunaSe = (19.08 - 13.64) / (2 * 1.96);
  assert.equal(ciGateAllowsReorder(glmSe, lunaSe, 41.82 - 16.36), true);
  // Missing SE abstains (today's behavior decides).
  assert.equal(ciGateAllowsReorder(null, lunaSe, 25.5), true);
});

test('blend alphas: 0.25 doers, 0.10 thinkers', () => {
  assert.equal(blendAlphaForRole('doer', { doer: 0.25, thinker: 0.1 }), 0.25);
  assert.equal(blendAlphaForRole('thinker', { doer: 0.25, thinker: 0.1 }), 0.1);
  assert.equal(DEFAULT_EEE_BLEND_DOER, 0.25);
  assert.equal(DEFAULT_EEE_BLEND_THINKER, 0.1);
  assert.equal(blendQ(1.0, -1.0, 0.25), 0.5);
});

test('stale artifact -> unusable (AA-only bit-equality path)', () => {
  const fresh = { version: EEE_VERSION, builtAt: '2026-10-08T00:00:00Z', scores: FIXTURE };
  const stale = { version: EEE_VERSION, builtAt: '2026-09-01T00:00:00Z', scores: FIXTURE };
  assert.equal(eeeUsable(fresh, { nowMs: NOW, maxAgeDays: 7 }), true);
  assert.equal(eeeUsable(stale, { nowMs: NOW, maxAgeDays: 7 }), false);
  assert.equal(eeeUsable(null, { nowMs: NOW }), false);
  assert.equal(eeeUsable({ version: 999, builtAt: '2026-10-08T00:00:00Z' }, { nowMs: NOW }), false);
  assert.equal(eeeUsable({ version: EEE_VERSION }, { nowMs: NOW }), false);
});

test('staleness decay: SWE-age rows weigh ~floor, fresh rows full', () => {
  const mk = (date) => ({ armId: 'a', model: 'x', effort: 'max' });
  void mk;
  const old = { 'x(max)': { benchmarks: { tb4: tb4(50, 48, 52, '2025-12-15') } } };
  const freshRows = { 'x(max)': { benchmarks: { tb4: tb4(50, 48, 52, '2026-10-01') } } };
  const o = computeEeeComposite([{ armId: 'x(max)', model: 'x', effort: 'max' },
    { armId: 'y(max)', model: 'y', effort: 'max' }], { ...old, 'y(max)': { benchmarks: { tb4: tb4(60, 58, 62, '2026-10-01') } } }, { nowMs: NOW });
  const f = computeEeeComposite([{ armId: 'x(max)', model: 'x', effort: 'max' },
    { armId: 'y(max)', model: 'y', effort: 'max' }], { ...freshRows, 'y(max)': { benchmarks: { tb4: tb4(60, 58, 62, '2026-10-01') } } }, { nowMs: NOW });
  // Same z-scores (same scores), but the stale row's detail weight is lower.
  assert.ok(o.get('x(max)').detail.tb4.weight < f.get('x(max)').detail.tb4.weight);
});

test('first-party rows discount x0.5; harness mismatch x0.7', () => {
  const base = { score: 50, se: 1, ciLow: 48, ciHigh: 52, n: 100, evalDate: '2026-10-01', harness: 'Claude Code', firstParty: false };
  const mkScores = (row) => ({ 'claude-x(max)': { benchmarks: { tb4: row } }, 'claude-y(max)': { benchmarks: { tb4: { ...base } } } });
  const full = computeEeeComposite([{ armId: 'claude-x(max)', model: 'claude-x', effort: 'max' }, { armId: 'claude-y(max)', model: 'claude-y', effort: 'max' }], mkScores(base), { nowMs: NOW });
  const fp = computeEeeComposite([{ armId: 'claude-x(max)', model: 'claude-x', effort: 'max' }, { armId: 'claude-y(max)', model: 'claude-y', effort: 'max' }], mkScores({ ...base, firstParty: true }), { nowMs: NOW });
  const mm = computeEeeComposite([{ armId: 'claude-x(max)', model: 'claude-x', effort: 'max' }, { armId: 'claude-y(max)', model: 'claude-y', effort: 'max' }], mkScores({ ...base, harness: 'Grok Build' }), { nowMs: NOW });
  assert.ok(Math.abs(fp.get('claude-x(max)').detail.tb4.weight - full.get('claude-x(max)').detail.tb4.weight * 0.5) < 1e-9);
  assert.ok(Math.abs(mm.get('claude-x(max)').detail.tb4.weight - full.get('claude-x(max)').detail.tb4.weight * 0.7) < 1e-9);
});

test('ladder integration: blended Q keeps pareto shape on the fixture', () => {
  const out = computeEeeComposite(arms, FIXTURE, { nowMs: NOW });
  const costs = { 'opus-5.5(max)': 5.98, 'sonnet-5.5(max)': 5.46, 'gpt-6.1-sol(max)': 0.72, 'gpt-6-astra(high)': 3.0, 'glm-5.3(max)': 0.5, 'gpt-6-luna(max)': 0.07, 'muse-spark-1.3(xhigh)': 1.61 };
  const blended = [...out].map(([armId, s]) => ({ armId, Q: blendQ(s.Qeee, s.Qeee, 0) ?? s.Qeee, C: costs[armId], coverage: 1 }));
  const { rungs } = buildLadder(blended);
  assert.ok(rungs.length > 0);
  assert.equal(rungs[0].armId, 'gpt-6-luna(max)');
});

test('family prior: Beta display prior from Q_eee values', () => {
  const p = eeeFamilyPrior([1.0, 0.5]);
  assert.ok(p.a0 > p.b0);
  assert.ok(Math.abs(p.a0 + p.b0 - 5) < 1e-9);
  assert.equal(eeeFamilyPrior([]), null);
  assert.equal(eeeFamilyPrior([null]), null);
});

test('composite is deterministic: no clock or network inside', () => {
  const a = computeEeeComposite(arms, FIXTURE, { nowMs: NOW });
  const b = computeEeeComposite(structuredClone(arms), structuredClone(FIXTURE), { nowMs: NOW });
  assert.deepEqual([...a], [...b]);
});

test('gate datum: tb4 score+se surfaced, null without a tb4 row', () => {
  const out = computeEeeComposite(
    [{ armId: 'o', model: 'opus-5.5', effort: 'max' }],
    { 'opus-5.5(max)': { benchmarks: { tb4: tb4(64.85, 61.74, 67.96, '2026-09-22') } } },
    { nowMs: NOW },
  );
  const d = eeeGateDatum(out.get('o'));
  assert.equal(d.score, 64.85);
  assert.ok(Math.abs(d.se - (67.96 - 61.74) / (2 * 1.96)) < 1e-9);
  assert.equal(eeeGateDatum({ Qeee: null, coverage: 0, detail: {} }), null);
  assert.equal(eeeGateDatum(null), null);
});

// Rung-level CI gate at the dominance level: newcomer n is strictly better
// than incumbent i on blended Q and cheaper, so today i would drop as
// dominated. When n sits within TB4 noise of i (Δ=1.15 vs bar≈4.4), i keeps
// its rung and the pair is reported challenger-within-noise; a 25-point gap
// (glm vs luna, report §5) knocks i out.
const gateEntries = () => ([
  { armId: 'n', Q: 1.5, C: 4, coverage: 1 },
  { armId: 'i', Q: 1.0, C: 5, coverage: 1 },
]);
const gatePrev = () => ([{ armId: 'i', rung: 0 }]);
const se = (lo, hi) => (hi - lo) / (2 * 1.96);

test('rung gate: within-noise newcomer does not knock out the incumbent', () => {
  const gate = new Map([
    ['i', { score: 64.85, se: se(61.74, 67.96) }],
    ['n', { score: 66.0, se: se(62.9, 69.1) }],
  ]);
  const { rungs, dominated, withinNoise } = buildLadder(gateEntries(), gatePrev(), gate);
  assert.deepEqual(rungs.map(r => r.armId), ['n', 'i']);
  assert.deepEqual(dominated, []);
  assert.deepEqual(withinNoise, [{ challenger: 'n', incumbent: 'i' }]);
});

test('rung gate: a 25-point gap knocks out; missing SE keeps today behavior', () => {
  const gate = new Map([
    ['i', { score: 41.82, se: se(38.59, 45.05) }],
    ['n', { score: 66.36, se: se(63.64, 69.08) }],
  ]);
  const knocked = buildLadder(gateEntries(), gatePrev(), gate);
  assert.deepEqual(knocked.rungs.map(r => r.armId), ['n']);
  assert.deepEqual(knocked.dominated, ['i']);
  assert.deepEqual(knocked.withinNoise, []);
  // No error model on either side: strict dominance decides, as today.
  const noSe = new Map([['i', { score: 1, se: null }], ['n', { score: 2, se: null }]]);
  const bare = buildLadder(gateEntries(), gatePrev(), noSe);
  assert.deepEqual(bare.rungs.map(r => r.armId), ['n']);
  assert.deepEqual(bare.dominated, ['i']);
});

test('rung gate: no gate data is bit-for-bit identical to today', () => {
  const a = buildLadder(gateEntries(), gatePrev());
  const b = buildLadder(gateEntries(), gatePrev(), null);
  const c = buildLadder(gateEntries(), gatePrev(), new Map());
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(a.withinNoise, []);
  // And the incumbent-incumbent pair never consults the gate at all.
  const d = buildLadder(gateEntries(), [{ armId: 'n', rung: 0 }, { armId: 'i', rung: 1 }],
    new Map([['i', { score: 64.85, se: 1.5 }], ['n', { score: 66.0, se: 1.5 }]]));
  assert.deepEqual(d.rungs.map(r => r.armId), ['n']);
});

test('config: eee defaults resolve, nested and flat keys accepted', async () => {
  const { resolveConfig } = await import('../src/plugin.mjs');
  const d = resolveConfig({}).eee;
  assert.equal(d.blendDoer, 0.25);
  assert.equal(d.blendThinker, 0.1);
  assert.equal(d.maxAgeDays, 7);
  assert.equal(d.firstPartyDiscount, 0.5);
  assert.equal(d.decayHalfLifeDays, 120);
  assert.equal(d.weights.tb4, 0.35);
  assert.equal(resolveConfig({ eeeBlendDoer: 0.5 }).eee.blendDoer, 0.5);
  assert.equal(resolveConfig({ eee: { weights: { tb4: 0.5 } } }).eee.weights.tb4, 0.5);
});
