import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BREAKERS, BREAKER_MAX_SEEN, sanitizeBreakers, classifyArmError,
  createBreakerStore, breakerStoreFromJSON, breakerStoreToJSON,
  breakerState, breakerAllows, breakerProbeRunId, recordArmFailure,
  startProbe, resolveProbe, breakerHousekeep, filterBreakerRungs, breakerReport,
} from '../src/breakers.mjs';
import { createLedger, recordStart, recordDecision, recordTerminal, terminalRecords } from '../src/ledger.mjs';
import { decide } from '../src/decide.mjs';
import { validateConfigShape, resolveConfig, extractRunErrorText } from '../src/plugin.mjs';
import { manifest, PLUGIN_VERSION } from '../src/manifest.mjs';

const T0 = 1_750_000_000_000;
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const cfg = sanitizeBreakers();

// Both live incident strings trip after two failures in the window.
test('live gemini-2.5-pro 400 trips; live antigravity strings trip', () => {
  assert.equal(classifyArmError(
    `400 unknown provider for model 'gemini-2.5-pro': provider registry has no route`, cfg), 'fatal');
  assert.equal(classifyArmError('auth_unavailable: no auth available for claude-opus-5-5-high', cfg), 'fatal');
  assert.equal(classifyArmError('404 Requested entity was not found', cfg), 'fatal');
  assert.equal(classifyArmError('model_not_found: claude-opus-5-5-high is not provisioned', cfg), 'fatal');
  assert.equal(classifyArmError('400 Upstream request failed: Model is unavailable.', cfg), 'fatal');
  assert.equal(classifyArmError('500 no healthy managed Z.ai capacity remains', cfg), 'fatal');
});

test('generic 400-about-model trips; transients never do', () => {
  assert.equal(classifyArmError('400 Bad Request: model parameter rejected by provider', cfg), 'fatal');
  assert.equal(classifyArmError(null, cfg), null);
  assert.equal(classifyArmError('', cfg), null);
  for (const transient of [
    'stream disconnected mid-response on claude-opus-5-5-high, retrying',
    '429 rate limit exceeded for gpt-6.1-sol, backing off',
    '529 overloaded: provider capacity exhausted for model claude-opus-5-5',
    "400 This model's maximum context length is 200000 tokens, too many tokens in request",
    'request timeout after 600s waiting on model output',
    'upstream busy, please try again later (model claude-haiku-5-5)',
  ]) {
    assert.equal(classifyArmError(transient, cfg), null, transient);
  }
});

test('specific knowledge beats the transient veto', () => {
  // auth_unavailable with a retry suffix still trips: the specific pattern wins.
  assert.equal(classifyArmError('auth_unavailable for model x; please try again later', cfg), 'fatal');
  // A bare 400 with a model mention but a context veto does not.
  assert.equal(classifyArmError('400 error: model hit maximum context window', cfg), null);
});

test('two arm-fatal failures in 30 min open; one does not; stale ones do not', () => {
  const s = createBreakerStore();
  assert.equal(recordArmFailure(s, 'a', 'arm', { atMs: T0, errorText: 'auth_unavailable' }, T0, cfg), null);
  assert.equal(breakerState(s, 'a', 'arm', T0, cfg), 'closed');
  const t = recordArmFailure(s, 'a', 'arm', { atMs: T0 + 5 * MIN, errorText: 'auth_unavailable' }, T0 + 5 * MIN, cfg);
  assert.equal(t.transition, 'opened');
  assert.equal(t.cooloffHours, 6);
  assert.equal(breakerState(s, 'a', 'arm', T0 + 5 * MIN, cfg), 'open');
  assert.equal(breakerAllows(s, 'a', 'arm', T0 + 5 * MIN, cfg), false);

  const s2 = createBreakerStore();
  assert.equal(recordArmFailure(s2, 'a', 'arm', { atMs: T0, errorText: 'auth_unavailable' }, T0, cfg), null);
  assert.equal(recordArmFailure(s2, 'a', 'arm', { atMs: T0 + 31 * MIN, errorText: 'auth_unavailable' }, T0 + 31 * MIN, cfg), null);
  assert.equal(breakerState(s2, 'a', 'arm', T0 + 31 * MIN, cfg), 'closed');
});

test('cool-off doubles per consecutive reopen, capped at 48h', () => {
  const s = createBreakerStore();
  let now = T0;
  const fail = (at) => {
    recordArmFailure(s, 'a', 'arm', { atMs: at, errorText: 'auth_unavailable' }, at, cfg);
    return recordArmFailure(s, 'a', 'arm', { atMs: at + MIN, errorText: 'auth_unavailable' }, at + MIN, cfg);
  };
  assert.equal(fail(now).cooloffHours, 6);
  const expected = [12, 24, 48, 48];
  for (const cool of expected) {
    const entry = s.arms[Object.keys(s.arms)[0]];
    now = entry.openedAt + entry.cooloffHours * HOUR + 1;
    assert.deepEqual(breakerHousekeep(s, now, cfg).map(t => t.transition), ['half-open']);
    assert.equal(startProbe(s, 'a', 'arm', `probe-${now}`, now, cfg), true);
    const t = resolveProbe(s, 'a', 'arm', `probe-${now}`, 'arm-fatal', 'auth_unavailable', now + MIN, cfg);
    assert.equal(t.transition, 'reopened');
    assert.equal(t.cooloffHours, cool);
  }
});

test('half-open probe success closes and resets backoff; other frees the slot', () => {
  const s = createBreakerStore();
  recordArmFailure(s, 'a', 'arm', { atMs: T0, errorText: 'auth_unavailable' }, T0, cfg);
  recordArmFailure(s, 'a', 'arm', { atMs: T0 + MIN, errorText: 'auth_unavailable' }, T0 + MIN, cfg);
  const openAt = T0 + MIN;
  assert.equal(breakerState(s, 'a', 'arm', openAt + 6 * HOUR - 1, cfg), 'open');
  const trans = breakerHousekeep(s, openAt + 6 * HOUR + 1, cfg);
  assert.deepEqual(trans.map(t => t.transition), ['half-open']);
  assert.equal(breakerState(s, 'a', 'arm', openAt + 6 * HOUR + 1, cfg), 'half-open');
  // Half-open with no probe is pickable again...
  assert.equal(breakerAllows(s, 'a', 'arm', openAt + 6 * HOUR + 1, cfg), true);
  assert.equal(startProbe(s, 'a', 'arm', 'run-9', openAt + 6 * HOUR + 1, cfg), true);
  // ...but blocked while the probe is out.
  assert.equal(breakerAllows(s, 'a', 'arm', openAt + 6 * HOUR + 2, cfg), false);
  assert.equal(breakerProbeRunId(s, 'a', 'arm', openAt + 6 * HOUR + 2, cfg), 'run-9');
  const t = resolveProbe(s, 'a', 'arm', 'run-9', 'success', null, openAt + 6 * HOUR + 3, cfg);
  assert.equal(t.transition, 'closed');
  assert.equal(breakerAllows(s, 'a', 'arm', openAt + 6 * HOUR + 3, cfg), true);
  // Unknown runIds resolve to nothing.
  assert.equal(resolveProbe(s, 'a', 'arm', 'run-zzz', 'arm-fatal', 'auth_unavailable', openAt + 7 * HOUR, cfg), null);
});

test('non-fatal probe outcome stays half-open with a free slot', () => {
  const s = createBreakerStore();
  recordArmFailure(s, 'a', 'arm', { atMs: T0, errorText: 'auth_unavailable' }, T0, cfg);
  recordArmFailure(s, 'a', 'arm', { atMs: T0 + MIN, errorText: 'auth_unavailable' }, T0 + MIN, cfg);
  const t0 = T0 + MIN + 6 * HOUR + 1;
  breakerHousekeep(s, t0, cfg);
  assert.equal(startProbe(s, 'a', 'arm', 'run-10', t0, cfg), true);
  assert.equal(resolveProbe(s, 'a', 'arm', 'run-10', 'other', 'stream disconnected', t0 + MIN, cfg), null);
  assert.equal(breakerState(s, 'a', 'arm', t0 + MIN, cfg), 'half-open');
  assert.equal(breakerAllows(s, 'a', 'arm', t0 + MIN, cfg), true);
});

test('stale probes free the slot via housekeep', () => {
  const s = createBreakerStore();
  recordArmFailure(s, 'a', 'arm', { atMs: T0, errorText: 'auth_unavailable' }, T0, cfg);
  recordArmFailure(s, 'a', 'arm', { atMs: T0 + MIN, errorText: 'auth_unavailable' }, T0 + MIN, cfg);
  const t0 = T0 + MIN + 6 * HOUR + 1;
  breakerHousekeep(s, t0, cfg);
  assert.equal(startProbe(s, 'a', 'arm', 'run-11', t0, cfg), true);
  const late = t0 + 2 * HOUR + 1;
  assert.equal(breakerAllows(s, 'a', 'arm', late, cfg), true);
  assert.deepEqual(breakerHousekeep(s, late, cfg).map(t => t.transition), ['probe-expired']);
  assert.equal(breakerAllows(s, 'a', 'arm', late, cfg), true);
});

test('restart persistence: open survives a JSON round-trip; quiet closed entries drop', () => {
  const s = createBreakerStore();
  recordArmFailure(s, 'a', 'dead', { atMs: T0, errorText: 'auth_unavailable' }, T0, cfg);
  recordArmFailure(s, 'a', 'dead', { atMs: T0 + MIN, errorText: 'auth_unavailable' }, T0 + MIN, cfg);
  const reloaded = breakerStoreFromJSON(JSON.parse(JSON.stringify(breakerStoreToJSON(s, { nowMs: T0 + MIN, cfg }))));
  assert.equal(breakerState(reloaded, 'a', 'dead', T0 + MIN, cfg), 'open');
  assert.equal(breakerAllows(reloaded, 'a', 'dead', T0 + MIN, cfg), false);
  // Still open after the cool-off has NOT elapsed; half-open after it has.
  assert.equal(breakerState(reloaded, 'a', 'dead', T0 + MIN + 5 * HOUR, cfg), 'open');
  assert.equal(breakerState(reloaded, 'a', 'dead', T0 + MIN + 6 * HOUR + 1, cfg), 'half-open');
  // A probe occupies the slot across the restart; its terminal resolves it.
  assert.equal(startProbe(reloaded, 'a', 'dead', 'run-12', T0 + MIN + 6 * HOUR + 1, cfg), true);
  const reloaded2 = breakerStoreFromJSON(JSON.parse(JSON.stringify(breakerStoreToJSON(reloaded, { nowMs: T0 + MIN + 6 * HOUR + 1, cfg }))));
  assert.equal(breakerProbeRunId(reloaded2, 'a', 'dead', T0 + MIN + 6 * HOUR + 2, cfg), 'run-12');
  assert.equal(resolveProbe(reloaded2, 'a', 'dead', 'run-12', 'success', null, T0 + MIN + 6 * HOUR + 3, cfg).transition, 'closed');

  // Quiet closed arms are pruned on write; seen ids are bounded.
  const s2 = createBreakerStore();
  recordArmFailure(s2, 'a', 'flaky', { atMs: T0 - HOUR, errorText: 'auth_unavailable' }, T0 - HOUR, cfg);
  const json = breakerStoreToJSON(s2, { nowMs: T0, cfg });
  assert.deepEqual(Object.keys(json.arms), []);
  const s3 = createBreakerStore();
  s3.seen = Array.from({ length: BREAKER_MAX_SEEN + 100 }, (_, i) => `run-${i}`);
  assert.equal(breakerStoreToJSON(s3, { nowMs: T0, cfg }).seen.length, BREAKER_MAX_SEEN);
});

test('garbage JSON loads as an empty store', () => {
  for (const bad of [null, undefined, 42, 'x', [], { arms: { 'k': { state: 'bogus' } } }]) {
    const s = breakerStoreFromJSON(bad);
    assert.equal(breakerState(s, 'a', 'arm', T0, cfg), 'closed');
  }
});

test('ladder skips open arms: decide falls to the next rung, or defers to the next account', () => {
  const arm = (armId, model, effort, family, Q) => ({ armId, model, effort, family, Q, C: 1, contextWindow: 1000000 });
  const rungs = [
    { rung: 0, arms: [arm('cheap-arm', 'claude-haiku-5-5', 'max', 'haiku', 5)] },
    { rung: 1, arms: [arm('dead-arm', 'gemini-2.5-pro', 'default', 'gemini', 9)] },
  ];
  const burn = { 'cheap-arm': 0.0005, 'dead-arm': 0.0005 };
  const base = {
    runId: 'run-1', agentId: 'agent-1', role: 'doer', pointer: 1,
    fiveHourHeadroomPct: 0.5, burnPerRunPct: burn, reservePct: 0.05, accountId: 'antigravity:1',
  };
  const s = createBreakerStore();
  recordArmFailure(s, 'antigravity:1', 'dead-arm', { atMs: T0, errorText: 'unknown provider for model' }, T0, cfg);
  recordArmFailure(s, 'antigravity:1', 'dead-arm', { atMs: T0 + MIN, errorText: 'unknown provider for model' }, T0 + MIN, cfg);
  const filtered = filterBreakerRungs(rungs, s, 'antigravity:1', T0 + 2 * MIN, cfg);
  // Rung shells stay (decide indexes positionally); only the arms are gone.
  assert.deepEqual(filtered.map(g => g.arms.length), [1, 0]);
  // Pointer at rung 1 finds it empty and falls back down to rung 0.
  const d = decide({ ...base, ladderRungs: filtered });
  assert.equal(d.kind, 'decide');
  assert.equal(d.armId, 'cheap-arm');
  assert.equal(d.rung, 0);
  // Unfiltered, the dead arm wins its rung on Q.
  const d0 = decide({ ...base, ladderRungs: rungs });
  assert.equal(d0.armId, 'dead-arm');
  // An account whose target rung is empty and has nothing below defers, so
  // the tick loop moves on to the next account in the allocation order.
  const onlyDead = filterBreakerRungs(
    [{ rung: 0, arms: [rungs[1].arms[0]] }], s, 'antigravity:1', T0 + 2 * MIN, cfg);
  assert.equal(decide({ ...base, pointer: 0, ladderRungs: onlyDead }).kind, 'defer');
});

test('decide exposes armId for ledger attribution', () => {
  const rungs = [{ rung: 0, arms: [{ armId: 'a1', model: 'm', effort: 'e', family: 'f', Q: 1, C: 1 }] }];
  const d = decide({
    runId: 'r', agentId: 'a', role: 'doer', ladderRungs: rungs, pointer: 0,
    fiveHourHeadroomPct: 0.5, burnPerRunPct: { a1: 0.0001 }, reservePct: 0.05, accountId: 'x:1',
  });
  assert.equal(d.armId, 'a1');
});

test('ledger carries armId on decisions and error text on failed terminals only', () => {
  const ledger = createLedger();
  recordStart(ledger, { runId: 'r1', agentId: 'a' }, T0);
  recordDecision(ledger, { runId: 'r1', accountId: 'a:1', armId: 'dead-arm' }, T0);
  assert.equal(ledger.get('r1').armId, 'dead-arm');
  recordTerminal(ledger, { runId: 'r1', errorText: 'auth_unavailable: kaboom' }, 'failed', T0 + MIN);
  assert.equal(ledger.get('r1').errorText, 'auth_unavailable: kaboom');
  recordStart(ledger, { runId: 'r2', agentId: 'a' }, T0);
  recordDecision(ledger, { runId: 'r2', accountId: 'a:1', armId: 'ok-arm' }, T0);
  recordTerminal(ledger, { runId: 'r2', errorText: 'should-not-store' }, 'finished', T0 + MIN);
  assert.equal(ledger.get('r2').errorText, undefined);
  assert.equal(terminalRecords(ledger).length, 2);
  // Error text is bounded so one verbose provider cannot bloat the blob.
  recordStart(ledger, { runId: 'r3', agentId: 'a' }, T0);
  recordTerminal(ledger, { runId: 'r3', errorText: 'x'.repeat(2000) }, 'failed', T0 + MIN);
  assert.equal(ledger.get('r3').errorText.length, 500);
});

test('extractRunErrorText reads every known placement, tolerantly', () => {
  assert.equal(extractRunErrorText(null), null);
  assert.equal(extractRunErrorText({}), null);
  assert.equal(extractRunErrorText({ payload: { error: 'unknown provider for model x', run: { code: 'auth_unavailable' } } }),
    'unknown provider for model x | auth_unavailable');
  assert.equal(extractRunErrorText({ payload: { run: { errorMessage: 'Requested entity was not found' } } }),
    'Requested entity was not found');
  assert.equal(extractRunErrorText({ payload: { error_message: '  ', error_code: 400 } }), '400');
});

test('sanitizeBreakers: defaults, garbage, explicit empty, kill switch', () => {
  assert.deepEqual(sanitizeBreakers(), DEFAULT_BREAKERS);
  assert.deepEqual(sanitizeBreakers('nope'), DEFAULT_BREAKERS);
  const g = sanitizeBreakers({ tripCount: 0, windowMin: -5, cooloffHours: 'x', enabled: 'yes', fatalPatterns: [42, '', '  AUTH_UNAVAILABLE  '] });
  assert.equal(g.tripCount, 2);
  assert.equal(g.windowMin, 30);
  assert.equal(g.cooloffHours, 6);
  assert.equal(g.enabled, true);
  assert.deepEqual(g.fatalPatterns, ['auth_unavailable']);
  // Explicit [] is honored: no fatal patterns, nothing trips.
  const empty = sanitizeBreakers({ fatalPatterns: [] });
  assert.deepEqual(empty.fatalPatterns, []);
  assert.equal(classifyArmError('auth_unavailable', empty), null);
  // Kill switch: everything is allowed, rungs pass through untouched.
  const off = sanitizeBreakers({ enabled: false });
  const s = createBreakerStore();
  recordArmFailure(s, 'a', 'arm', { atMs: T0, errorText: 'auth_unavailable' }, T0, off);
  recordArmFailure(s, 'a', 'arm', { atMs: T0 + MIN, errorText: 'auth_unavailable' }, T0 + MIN, off);
  assert.equal(breakerAllows(s, 'a', 'arm', T0 + 2 * MIN, off), true);
  const rungs = [{ rung: 0, arms: [{ armId: 'arm' }] }];
  assert.equal(filterBreakerRungs(rungs, s, 'a', T0 + 2 * MIN, off), rungs);
});

test('resolveConfig carries breakers; validator rejects bad shapes', () => {
  assert.deepEqual(resolveConfig({}).breakers, DEFAULT_BREAKERS);
  assert.equal(resolveConfig({ breakers: { tripCount: 3 } }).breakers.tripCount, 3);
  assert.deepEqual(validateConfigShape({}), []);
  assert.deepEqual(validateConfigShape({ breakers: { tripCount: 2, windowMin: 30 } }), []);
  for (const bad of [
    { breakers: 'x' },
    { breakers: { enabled: 'yes' } },
    { breakers: { tripCount: 0 } },
    { breakers: { tripCount: 1.5 } },
    { breakers: { windowMin: -1 } },
    { breakers: { cooloffHours: 0 } },
    { breakers: { maxCooloffHours: 1, cooloffHours: 6 } },
    { breakers: { fatalPatterns: 'auth_unavailable' } },
    { breakers: { vetoPatterns: [42] } },
  ]) {
    assert.ok(validateConfigShape(bad).length > 0, JSON.stringify(bad));
  }
});

test('manifest breakers schema defaults match the code defaults', () => {
  const props = manifest.instanceConfigSchema.properties;
  assert.equal(props.breakers.properties.tripCount.default, 2);
  assert.equal(props.breakers.properties.cooloffHours.default, 6);
  assert.equal(props.breakers.properties.maxCooloffHours.default, 48);
  assert.deepEqual(props.breakers.properties.fatalPatterns.default, DEFAULT_BREAKERS.fatalPatterns);
  assert.deepEqual(props.breakers.properties.vetoPatterns.default, DEFAULT_BREAKERS.vetoPatterns);
  assert.equal(PLUGIN_VERSION, '0.2.18');
});

test('/capacity armBreakers lists tracked arms with effective state', () => {
  const s = createBreakerStore();
  recordArmFailure(s, 'a:1', 'dead', { atMs: T0, errorText: 'auth_unavailable' }, T0, cfg);
  recordArmFailure(s, 'a:1', 'dead', { atMs: T0 + MIN, errorText: 'auth_unavailable' }, T0 + MIN, cfg);
  const report = breakerReport(s, T0 + 2 * MIN, cfg);
  assert.equal(report.length, 1);
  assert.equal(report[0].accountId, 'a:1');
  assert.equal(report[0].armId, 'dead');
  assert.equal(report[0].status, 'open');
  assert.equal(report[0].cooloffHours, 6);
  assert.equal(report[0].probeRunId, null);
  assert.match(report[0].lastError, /auth_unavailable/);
});
