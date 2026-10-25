import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decide.mjs';

const TERRA = 'gpt-5.6-terra';
const SOL = 'gpt-6.1-sol';
const arm = (model, family, contextWindow) => ({
  armId: `${model}:high`, model, family, effort: 'high', contextWindow,
  Q: 1, C: 1, trial: false, cap: null,
});
const ladder = (terraWindow = 372000, solWindow = 1000000) => [
  { rung: 0, arms: [arm(TERRA, 'terra', terraWindow)] },
  { rung: 1, arms: [arm(SOL, 'sol', solWindow)] },
];
const pick = (extra = {}) => decide({
  runId: 'context-run', agentId: 'agent-9', role: 'doer', accountId: 'codex:c1',
  ladderRungs: ladder(), ...extra,
});

// Catch dropping the context filter while choosing the first available rung.
test('a known 500k context skips the 372k Terra arm', () => {
  const out = pick({ contextTokens: 500000 });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
});

test('a 372k served-id ceiling beats larger 1M metadata for a known 500k context', () => {
  const out = pick({
    ladderRungs: ladder(1000000), contextTokens: 500000,
    contextCaps: { servedIds: { [TERRA]: { maxTokens: 372000, autoCompactTokens: 350000 } } },
  });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
});

test('a fresh session remains eligible for a 372k Terra arm', () => {
  const out = pick({ contextTokens: null });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, TERRA);
});

// Literal wire result: adding context safety must not change equal-window
// choices, decision identity, effort, env, source, or reason bytes.
test('equal-window decisions remain byte-identical with a known context count', () => {
  const out = pick({ ladderRungs: ladder(1000000), contextTokens: 500000 });
  assert.equal(JSON.stringify(out), JSON.stringify({
    kind: 'decide', decisionId: 'mc-context-run-codex-c1-r0-gpt-5-6-terra',
    armId: 'gpt-5.6-terra:high', model: TERRA, effort: 'high', trial: false,
    contextWindow: 1000000, env: {}, source: 'model-capacity', calibration: 'weak',
    reason: 'rung 0 on codex:c1 (doer)', rung: 0, accountId: 'codex:c1', agentId: 'agent-9',
  }));
});
