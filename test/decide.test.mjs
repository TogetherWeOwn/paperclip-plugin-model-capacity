import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, MAX_CONTEXT_ENV_KEY, AUTO_COMPACT_ENV_KEY, MAX_OUTPUT_ENV_KEY } from '../src/decide.mjs';

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

test('sol/luna carry the price-cliff context caps', () => {
  const d = decide({ ...base, pointer: 1 });
  assert.equal(d.model, 'gpt-6.1-sol');
  assert.equal(d.env[MAX_CONTEXT_ENV_KEY], '260000');
  assert.equal(d.env[AUTO_COMPACT_ENV_KEY], '240000');
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
