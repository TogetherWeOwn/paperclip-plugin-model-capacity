import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, placementArm, MAX_CONTEXT_ENV_KEY, AUTO_COMPACT_ENV_KEY, MAX_OUTPUT_ENV_KEY } from '../src/decide.mjs';

const arm = (armId, model, effort, family, Q, contextWindow = 1000000) => ({ armId, model, effort, family, Q, C: 1, contextWindow });
const ladderRungs = [
  { rung: 0, arms: [arm('haiku-max', 'claude-haiku-5-5', 'max', 'haiku', 1)] },
  { rung: 1, arms: [arm('sol-high', 'gpt-6.1-sol', 'high', 'sol', 2)] },
  { rung: 2, arms: [arm('opus-max', 'claude-opus-5-5', 'max', 'opus', 3)] },
];
const burn = { 'haiku-max': 0.0005, 'sol-high': 0.0017, 'opus-max': 0.01 };
const base = {
  runId: 'run-1', agentId: 'agent-1', role: 'doer', ladderRungs, pointer: 0,
  fiveHourHeadroomPct: 0.5, burnPerRunPct: burn, reservePct: 0.05, accountId: 'claude:1',
};

test('decision is deterministic for the same input', () => {
  const a = decide({ ...base });
  const b = decide(structuredClone({ ...base }));
  assert.deepEqual(a, b);
  assert.equal(a.kind, 'decide');
  assert.equal(a.model, 'claude-haiku-5-5');
});

test('thinker floor binds; retries escalate one rung each', () => {
  const bands = { thinker: { floorRung: 2, ceilingRung: null }, doer: { floorRung: 0, ceilingRung: null } };
  const thinker = decide({ ...base, role: 'thinker', roleBands: bands });
  assert.equal(thinker.model, 'claude-opus-5-5');
  const retry = decide({ ...base, retryCount: 1, roleBands: bands });
  assert.equal(retry.rung, 1);
  const testFail = decide({ ...base, failureClass: 'test-fail', roleBands: bands });
  assert.equal(testFail.rung, 1);
});

test('sol carries the 890k window, luna the price-cliff caps', () => {
  const d = decide({ ...base, pointer: 1 });
  assert.equal(d.model, 'gpt-6.1-sol');
  assert.equal(d.env[MAX_CONTEXT_ENV_KEY], '890000');
  assert.equal(d.env[AUTO_COMPACT_ENV_KEY], '870000');
  const lunaRungs = [{ rung: 0, arms: [arm('luna-high', 'gpt-6-luna', 'high', 'luna', 1)] }];
  const luna = decide({ ...base, ladderRungs: lunaRungs, burnPerRunPct: { 'luna-high': 0.0005 } });
  assert.equal(luna.model, 'gpt-6-luna');
  assert.equal(luna.env[MAX_CONTEXT_ENV_KEY], '260000');
  assert.equal(luna.env[AUTO_COMPACT_ENV_KEY], '240000');
  const haiku = decide({ ...base });
  assert.deepEqual(haiku.env, { [MAX_OUTPUT_ENV_KEY]: '64000' });
});

test('context window filters; rate-limit reroutes', () => {
  const d = decide({ ...base, pointer: 2, contextTokens: 600000 });
  // opus (1M window) cannot hold 2x600k; walk down finds nothing fitting either.
  assert.equal(d.kind, 'defer');
  const reroute = decide({ ...base, failureClass: 'rate-limit' });
  assert.equal(reroute.kind, 'defer');
  assert.match(reroute.reason, /reroute/);
});

test('defer only when no arm fits headroom', () => {
  const d = decide({ ...base, fiveHourHeadroomPct: 0.0001 });
  assert.equal(d.kind, 'defer');
  assert.match(d.reason, /headroom/);
});

test('decision ids are unique per run but stable per input', () => {
  const a = decide({ ...base, runId: 'run-a' });
  const b = decide({ ...base, runId: 'run-b' });
  assert.notEqual(a.decisionId, b.decisionId);
  assert.equal(decide({ ...base, runId: 'run-a' }).decisionId, a.decisionId);
});

const trialArm = (extra = {}) => ({
  armId: 'kimi-k3-256k', model: 'kimi-k3-256k', effort: 'max', family: 'kimi',
  trial: true, Q: 50, C: 50, contextWindow: 1000000, ...extra,
});
const trialBase = {
  runId: 'run-t', agentId: 'agent-1', role: 'doer',
  ladderRungs: [{ rung: 0, arms: [trialArm()] }], pointer: 0,
  fiveHourHeadroomPct: null, burnPerRunPct: {}, reservePct: 0.05,
  accountId: 'kimi:1', adapterType: 'claude-code',
  trialBudget: { kimi: 2 }, trialAdapters: { 'claude-code': ['*'] },
};

test('trial arms route doer-only through opted-in adapters with budget', () => {
  const d = decide({ ...trialBase });
  assert.equal(d.kind, 'decide');
  assert.equal(d.trial, true);
  assert.equal(d.model, 'kimi-k3-256k');
  // Unmeasured by definition: always weak, never blocked on calibration.
  assert.equal(d.calibration, 'weak');
});

test('trial arms are excluded for thinkers, unknown adapters, and empty budgets', () => {
  assert.equal(decide({ ...trialBase, role: 'thinker' }).kind, 'defer');
  assert.equal(decide({ ...trialBase, adapterType: null }).kind, 'defer');
  assert.equal(decide({ ...trialBase, adapterType: 'opencode' }).kind, 'defer');
  assert.equal(decide({ ...trialBase, trialBudget: { kimi: 0 } }).kind, 'defer');
  assert.equal(decide({ ...trialBase, trialBudget: {} }).kind, 'defer');
});

test('trial picks bypass the burn check: unmeasured by definition', () => {
  const d = decide({ ...trialBase, fiveHourHeadroomPct: 0.06 });
  assert.equal(d.kind, 'decide');
  assert.equal(d.trial, true);
});

test('proven arms ignore trial gating entirely', () => {
  const d = decide({ ...base, adapterType: null, trialBudget: {}, trialAdapters: {} });
  assert.equal(d.kind, 'decide');
  assert.equal(d.trial, false);
});

// A role whose arms at and below the pacing pointer are all excluded is not
// stranded: decide climbs to the first fitting arm above the pointer.
test('empty rungs at and below the pointer climb to the next fitting arm', () => {
  const open = { thinker: { floorRung: 0, ceilingRung: null }, doer: { floorRung: 0, ceilingRung: null } };
  const d = decide({ ...base, role: 'thinker', roleBands: open, excludedFamilies: ['haiku'], pointer: 0 });
  assert.equal(d.kind, 'decide');
  assert.deepEqual([d.model, d.rung], ['gpt-6.1-sol', 1]);
  // The downward walk still wins when it finds an arm.
  assert.equal(decide({ ...base, role: 'thinker', roleBands: open, pointer: 2, excludedFamilies: ['haiku'] }).rung, 2);
  assert.equal(decide({ ...base, role: 'thinker', roleBands: open, pointer: 1, excludedFamilies: ['haiku'] }).rung, 1);
  // Climbing respects the ceiling and the burn check.
  const capped = { thinker: { floorRung: 0, ceilingRung: 0 }, doer: { floorRung: 0, ceilingRung: null } };
  assert.equal(decide({ ...base, role: 'thinker', excludedFamilies: ['haiku'], roleBands: capped }).kind, 'defer');
  assert.equal(decide({ ...base, role: 'thinker', roleBands: open, excludedFamilies: ['haiku'], fiveHourHeadroomPct: 0.002, reservePct: 0 }).kind, 'decide');
  assert.equal(decide({ ...base, role: 'thinker', roleBands: open, excludedFamilies: ['haiku', 'sol'], fiveHourHeadroomPct: 0.002, reservePct: 0 }).kind, 'defer');
});

test('placementArm follows the same climb as decide', () => {
  const open = { thinker: { floorRung: 0, ceilingRung: null }, doer: { floorRung: 0, ceilingRung: null } };
  const rungs = ladderRungs.map(g => ({ ...g, arms: g.arms.map(a => ({ ...a, qFleet: a.Q / 10 })) }));
  const d = decide({ ...base, ladderRungs: rungs, role: 'thinker', roleBands: open, excludedFamilies: ['haiku'], pointer: 0 });
  const p = placementArm(rungs, { role: 'thinker', roleBands: open, excludedFamilies: ['haiku'], pointer: 0 });
  assert.deepEqual([p.armId, p.rung, p.quality], [d.armId, d.rung, 0.2]);
});
