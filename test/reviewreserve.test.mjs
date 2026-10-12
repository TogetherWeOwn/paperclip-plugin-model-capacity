/**
 * Review reserve (native port of the host stopgap ops/model-capacity/review_reserve.py):
 * the share of a reserved provider's pace held back for review runs follows a
 * demand envelope (APF style: mean + 1 stdev over the trailing hours, instant
 * rise, half-life decay) plus a backlog term, clamped and lent out while no
 * review run is waiting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEW_RESERVE,
  REVIEW_FOLDED_CAP,
  normalizeReviewReserve,
  priceReviewBurn,
  priorProviderReserveState,
  reviewEventsFromLedger,
  queuedReviewsByAccount,
  foldReviewEvents,
  hourlyBurnTotals,
  envelopeSample,
  stepEnvelope,
  runsRateStep,
  reserveFor,
  accountHeld,
  computeProviderReserve,
} from '../src/reviewreserve.mjs';

const H = 3600000;
const T0 = 1760000000000; // fixed clock: deterministic buckets
const hourStart = (ms) => Math.floor(ms / H) * H;

test('defaults: enabled on claude, floor 0.10, cap 0.95, APF envelope constants', () => {
  assert.equal(DEFAULT_REVIEW_RESERVE.enabled, true);
  assert.deepEqual(DEFAULT_REVIEW_RESERVE.providers, ['claude']);
  assert.equal(DEFAULT_REVIEW_RESERVE.rMin, 0.10);
  assert.equal(DEFAULT_REVIEW_RESERVE.rMax, 0.95);
  assert.equal(DEFAULT_REVIEW_RESERVE.envWindowH, 3);
  assert.equal(DEFAULT_REVIEW_RESERVE.envHalfLifeH, 3);
  assert.equal(DEFAULT_REVIEW_RESERVE.drainH, 8);
  assert.equal(DEFAULT_REVIEW_RESERVE.releaseWeeklyH, 24);
  assert.equal(DEFAULT_REVIEW_RESERVE.release5hMin, 45);
});

test('normalize: agentIds null resolves to keepAgentIds; garbage reads as defaults', () => {
  const keep = ['68cba6b5-f816-4853-a3db-4389cd9ae8ca'];
  const cfg = normalizeReviewReserve(null, { keepAgentIds: keep });
  assert.deepEqual(cfg.agentIds, keep);
  assert.equal(cfg.enabled, true);
  const bad = normalizeReviewReserve(
    { enabled: 'yes', providers: 'claude', rMin: -5, rMax: 99, envWindowH: 0, agentIds: [42] },
    { keepAgentIds: keep },
  );
  assert.equal(bad.enabled, true);
  assert.deepEqual(bad.providers, ['claude']);
  assert.equal(bad.rMin, 0.10);
  assert.equal(bad.rMax, 0.95);
  assert.equal(bad.envWindowH, 3);
  assert.deepEqual(bad.agentIds, keep);
  const explicit = normalizeReviewReserve(
    { enabled: false, providers: ['claude', 'codex'], agentIds: ['a1', 'a1', ''] },
    { keepAgentIds: keep },
  );
  assert.equal(explicit.enabled, false);
  assert.deepEqual(explicit.providers, ['claude', 'codex']);
  assert.deepEqual(explicit.agentIds, ['a1']);
});

test('ledger fold: review runs contribute tier-adjusted burn once, on their attributed account', () => {
  const ledger = new Map([
    ['r1', { runId: 'r1', agentId: 'rev-1', armId: 'claude-haiku-5-5', decidedAccount: 'claude:a', startedAt: T0 - 1000, status: 'finished' }],
    ['r2', { runId: 'r2', agentId: 'doer-9', armId: 'claude-haiku-5-5', decidedAccount: 'claude:a', startedAt: T0 - 1000, status: 'finished' }],
    ['r3', { runId: 'r3', agentId: 'rev-1', armId: 'claude-haiku-5-5', actualAccount: 'claude:b', decidedAt: T0 - 2000, status: 'running' }],
    ['r4', { runId: 'r4', agentId: 'rev-1', armId: 'unknown-arm', decidedAccount: 'claude:a', startedAt: T0 - 3000, status: 'running' }],
  ]);
  // Tier-adjusted burn map (Haiku 5.5 long sessions at ~5x base): the fold
  // uses the caller's number verbatim, so the #28 tier pricing flows through.
  const burnOf = (arm) => (arm === 'claude-haiku-5-5' ? 0.05 : null);
  const first = reviewEventsFromLedger(ledger, { agentIds: ['rev-1'], burnOf, sinceMs: T0 - H });
  assert.deepEqual(first.events, [
    { atMs: T0 - 1000, accountId: 'claude:a', burnPct: 0.05 },
    { atMs: T0 - 2000, accountId: 'claude:b', burnPct: 0.05 },
  ]);
  assert.deepEqual([...first.runIds].sort(), ['r1', 'r3']);
  // Folded runIds (not the watermark) bound the fold: passing the first
  // fold's ids back skips them even with an old sinceMs, so a run
  // attributed after its tick still folds exactly once.
  const seen = new Set(first.runIds);
  assert.deepEqual(
    reviewEventsFromLedger(ledger, { agentIds: ['rev-1'], burnOf, sinceMs: T0 - H, seenRunIds: seen }).events,
    [],
  );
  // A run the first fold skipped for lack of attribution folds once the
  // attribution lands, however old its start is (late attribution).
  const late = new Map([
    ['q1', { runId: 'q1', agentId: 'rev-1', armId: 'claude-haiku-5-5', startedAt: T0 - 10 * H, status: 'running' }],
  ]);
  assert.deepEqual(
    reviewEventsFromLedger(late, { agentIds: ['rev-1'], burnOf, sinceMs: T0 - H, seenRunIds: new Set() }).events,
    [],
    'no account yet: still skipped, and not marked folded',
  );
  late.get('q1').decidedAccount = 'claude:a';
  const lateFold = reviewEventsFromLedger(late, { agentIds: ['rev-1'], burnOf, sinceMs: T0 - H, seenRunIds: new Set() });
  assert.deepEqual(lateFold.events, [{ atMs: T0 - 10 * H, accountId: 'claude:a', burnPct: 0.05 }]);
  assert.deepEqual(
    reviewEventsFromLedger(late, { agentIds: ['rev-1'], burnOf, sinceMs: T0 - H, seenRunIds: new Set(lateFold.runIds) }).events,
    [],
  );
});

test('queued reviews: non-terminal verified review records by account', () => {
  const ledger = new Map([
    ['r1', { runId: 'r1', agentId: 'rev-1', decidedAccount: 'claude:a', startedAt: T0, status: 'running' }],
    ['r2', { runId: 'r2', agentId: 'rev-1', decidedAccount: 'claude:a', startedAt: T0, status: 'finished' }],
    ['r3', { runId: 'r3', agentId: 'rev-1', decidedAccount: 'claude:a', startedAt: T0, status: 'running', unverified: true }],
    ['r4', { runId: 'r4', agentId: 'doer-9', decidedAccount: 'claude:a', startedAt: T0, status: 'running' }],
  ]);
  assert.deepEqual(queuedReviewsByAccount(ledger, { agentIds: ['rev-1'] }), { byAccount: { 'claude:a': 1 }, unattributed: 0 });
  const unattributed = new Map([
    ['q1', { runId: 'q1', agentId: 'rev-1', startedAt: T0, status: 'running' }],
  ]);
  assert.deepEqual(queuedReviewsByAccount(unattributed, { agentIds: ['rev-1'] }), { byAccount: {}, unattributed: 1 });
});

test('fold: events land in hour buckets, old buckets pruned, bounded', () => {
  const events = [
    { atMs: T0 - 5 * H, accountId: 'claude:a', burnPct: 0.05 },
    { atMs: T0 - 5 * H + 1000, accountId: 'claude:a', burnPct: 0.05 },
    { atMs: T0 - 60 * 1000, accountId: 'claude:b', burnPct: 0.02 },
  ];
  const buckets = foldReviewEvents([], events, T0, { windowH: 6 });
  assert.equal(buckets.length, 2);
  const old = buckets.find(b => b.atMs === hourStart(T0 - 5 * H));
  assert.equal(old.burn['claude:a'], 0.10);
  assert.equal(old.runs['claude:a'], 2);
  // Pruning: a bucket 30h old is dropped even when re-folded.
  const ancient = [{ atMs: hourStart(T0 - 30 * H), burn: { 'claude:a': 9 }, runs: { 'claude:a': 9 } }];
  const pruned = foldReviewEvents(ancient, [], T0, { windowH: 6 });
  assert.ok(!pruned.some(b => b.atMs === hourStart(T0 - 30 * H)));
});

test('envelope: mean + 1 stdev over the trailing window', () => {
  // mean 1.0, sd 1.0 -> 2.0
  assert.equal(envelopeSample([0, 2]), 2.0);
  assert.equal(envelopeSample([]), null);
  assert.equal(envelopeSample([0.5]), 0.5);
});

test('envelope step: rises instantly, decays on the half-life', () => {
  const hl = 3 * H;
  // Instant rise: a burst sample applies in full on the same tick.
  const risen = stepEnvelope({ value: 0.2, atMs: T0 }, 2.0, T0 + 60000, hl);
  assert.equal(risen.value, 2.0);
  // Decay: one half-life later with a low sample, the carried value halves.
  const decayed = stepEnvelope({ value: 2.0, atMs: T0 }, 0.5, T0 + hl, hl);
  assert.equal(decayed.value, 1.0);
  // Null sample (no closed hours yet): the carried value still decays.
  const aged = stepEnvelope({ value: 2.0, atMs: T0 }, null, T0 + hl, hl);
  assert.equal(aged.value, 1.0);
  // Cold start: no previous value, no sample -> 0, never null-poisoned.
  assert.equal(stepEnvelope(null, null, T0, hl).value, 0);
  assert.equal(stepEnvelope(null, 1.5, T0, hl).value, 1.5);
});

test('runs rate: EWMA of hourly review starts on a 6h half-life', () => {
  const hl = 6 * H;
  const first = runsRateStep(null, 24, T0, hl);
  assert.equal(first.value, 24);
  // One half-life later with no new starts, the rate halves.
  const later = runsRateStep(first, 0, T0 + hl, hl);
  assert.equal(later.value, 12);
});

test('reserve: clamp(need / capacity), floor, cap, fail-closed on no capacity', () => {
  const cfg = { rMin: 0.10, rMax: 0.95 };
  assert.equal(reserveFor({ need: 0.5, capacity: 1.0, queued: 3, ...cfg }).reserve, 0.5);
  assert.equal(reserveFor({ need: 0.01, capacity: 10, queued: 3, ...cfg }).reserve, 0.10);
  assert.equal(reserveFor({ need: 5, capacity: 1.0, queued: 3, ...cfg }).reserve, 0.95);
  // No measurable capacity: fail closed (reviews keep their share).
  assert.equal(reserveFor({ need: 0.5, capacity: 0, queued: 3, ...cfg }).reserve, 0.95);
});

test('lending: with no review run waiting the reserve drops to the floor', () => {
  const cfg = { rMin: 0.10, rMax: 0.95 };
  // Need far above capacity, but nothing queued: lent at the floor.
  const lent = reserveFor({ need: 5, capacity: 0.5, queued: 0, ...cfg });
  assert.equal(lent.reserve, 0.10);
  assert.equal(lent.lent, true);
  const held = reserveFor({ need: 5, capacity: 0.5, queued: 1, ...cfg });
  assert.equal(held.reserve, 0.95);
  assert.equal(held.lent, false);
});

test('account hold: over the scaled allowance on either window; released near reset', () => {
  const cfg = {
    ...DEFAULT_REVIEW_RESERVE,
    marginW: 0.10,
    margin5h: 0.15,
  };
  const base = {
    weeklyElapsed: 0.4, fiveHourElapsed: 0.4,
    hoursToWeeklyReset: 100, hoursTo5hReset: 3,
  };
  // R=0.5: weekly allowed = 0.4*0.5 + 0.10*0.5 = 0.25; used 0.30 is over.
  const held = accountHeld({ ...base, weeklyUsed: 0.30, fiveHourUsed: 0.10, reserve: 0.5 }, cfg);
  assert.equal(held.held, true);
  assert.equal(held.window, 'weekly');
  // Under the allowance on both windows: not held.
  const free = accountHeld({ ...base, weeklyUsed: 0.10, fiveHourUsed: 0.10, reserve: 0.5 }, cfg);
  assert.equal(free.held, false);
  // 5h over while weekly fine: held on the 5h window.
  const held5 = accountHeld({ ...base, weeklyUsed: 0.10, fiveHourUsed: 0.40, reserve: 0.5 }, cfg);
  assert.equal(held5.held, true);
  assert.equal(held5.window, 'five-hour');
  // Release: inside the last 24h before the weekly reset the weekly window
  // stops holding (unused quota must not be wasted).
  const released = accountHeld({
    ...base, weeklyUsed: 0.95, fiveHourUsed: 0.10, reserve: 0.5, hoursToWeeklyReset: 12,
  }, cfg);
  assert.equal(released.held, false);
  assert.equal(released.released, true);
  // Release: inside the last 45 min before the 5h reset.
  const released5 = accountHeld({
    ...base, weeklyUsed: 0.10, fiveHourUsed: 0.95, reserve: 0.5, hoursTo5hReset: 0.5,
  }, cfg);
  assert.equal(released5.held, false);
  // Zero reserve never holds.
  assert.equal(accountHeld({ ...base, weeklyUsed: 0.99, fiveHourUsed: 0.99, reserve: 0 }, cfg).held, false);
});

test('hourlyBurnTotals: closed hours only, per-account sums', () => {
  const buckets = [
    { atMs: hourStart(T0 - 2 * H), burn: { 'claude:a': 0.3 }, runs: { 'claude:a': 2 } },
    { atMs: hourStart(T0), burn: { 'claude:a': 99 }, runs: {} }, // partial current hour: excluded
  ];
  const totals = hourlyBurnTotals(buckets, T0, { envWindowH: 3 });
  assert.deepEqual(totals, [0.3]);
});

test('computeProviderReserve: end-to-end need, capacity, clamp, backlog', () => {
  const nowMs = hourStart(T0) + 30 * 60000; // mid-hour: last closed hour is complete
  const h1 = hourStart(nowMs) - H;
  const h2 = h1 - H;
  const cfg = { ...DEFAULT_REVIEW_RESERVE, marginW: 0.10, margin5h: 0.15 };
  const accounts = [
    {
      accountId: 'claude:a', provider: 'claude',
      weeklyUsed: 0.3, weeklyElapsed: 0.4, hoursToWeeklyReset: 100,
      fiveHourUsed: 0.2, fiveHourElapsed: 0.4, hoursTo5hReset: 3,
    },
  ];
  const state = {
    buckets: [
      { atMs: h2, burn: { 'claude:a': 1.0 }, runs: { 'claude:a': 10 } },
      { atMs: h1, burn: { 'claude:a': 1.0 }, runs: { 'claude:a': 10 } },
    ],
    envelope: null,
    runsRate: null,
    lastFoldMs: h1,
  };
  // One review run's worth of backlog: queued=8, per-run measured below.
  const out = computeProviderReserve({
    provider: 'claude', accounts, state, nowMs, cfg,
    events: [], queuedByAccount: { 'claude:a': 8 },
  });
  // Envelope over [1.0, 1.0]: mean 1, sd 0 -> review rate 1.0 %/h.
  assert.equal(out.reviewRatePctPerH, 1.0);
  // Capacity: (1-0.3)*100/100 = 0.7 %/h. Need 1.0 + backlog > capacity -> cap.
  assert.equal(out.capacityPctPerH, 0.7);
  assert.ok(out.backlogRatePctPerH > 0);
  assert.equal(out.reserve, 0.95);
  assert.equal(out.lent, false);
  assert.equal(out.queuedReviews, 8);
  // The over-allowance account is held for non-review work.
  assert.deepEqual(out.heldAccountIds, ['claude:a']);
  // State advances: envelope persisted for the next tick.
  assert.ok(out.state.envelope.value > 0);
});

test('computeProviderReserve: unknown-capacity accounts stay out of capacity but can still hold', () => {
  const nowMs = hourStart(T0) + 30 * 60000;
  const cfg = { ...DEFAULT_REVIEW_RESERVE, marginW: 0.10, margin5h: 0.15 };
  const out = computeProviderReserve({
    provider: 'claude',
    accounts: [{
      accountId: 'claude:a', provider: 'claude',
      weeklyUsed: null, weeklyElapsed: null, hoursToWeeklyReset: null,
      fiveHourUsed: null, fiveHourElapsed: null, hoursTo5hReset: null,
    }],
    state: { buckets: [], envelope: null, runsRate: null, lastFoldMs: nowMs - H },
    nowMs, cfg, events: [], queuedByAccount: {},
  });
  // No capacity signal and no demand: floor, lent (nothing waiting).
  assert.equal(out.capacityPctPerH, 0);
  assert.equal(out.reserve, 0.10);
  assert.equal(out.lent, true);
  assert.deepEqual(out.heldAccountIds, []);
});

test('computeProviderReserve: weekly-exhausted accounts (>=99%) leave capacity', () => {
  const nowMs = hourStart(T0) + 30 * 60000;
  const cfg = { ...DEFAULT_REVIEW_RESERVE, marginW: 0.10, margin5h: 0.15 };
  const mk = (used) => ({
    accountId: `claude:${used}`, provider: 'claude',
    weeklyUsed: used, weeklyElapsed: 0.9, hoursToWeeklyReset: 10,
    fiveHourUsed: 0.1, fiveHourElapsed: 0.5, hoursTo5hReset: 2,
  });
  const out = computeProviderReserve({
    provider: 'claude', accounts: [mk(0.5), mk(1.0)],
    state: { buckets: [], envelope: null, runsRate: null, lastFoldMs: nowMs - H },
    nowMs, cfg, events: [], queuedByAccount: {},
  });
  // Only the 50%-used account counts: 50%/10h = 5 %/h.
  assert.equal(out.capacityPctPerH, 5);
});

test('priceReviewBurn: exact arm wins; null/unknown armId prices the hottest arm', () => {
  const perArm = { 'claude-haiku-5-5': 0.05, 'claude-opus-5-5': 0.4 };
  assert.equal(priceReviewBurn(perArm, 'claude-haiku-5-5'), 0.05);
  // Pinned/keep runs decide before arm selection (armId null): they price
  // at the hottest arm so review demand is never invisible.
  assert.equal(priceReviewBurn(perArm, null), 0.4);
  assert.equal(priceReviewBurn(perArm, 'unknown-arm'), 0.4);
  assert.equal(priceReviewBurn({}, null), null);
  assert.equal(priceReviewBurn(null, null), null);
  assert.equal(priceReviewBurn({ a: 0, b: -1 }, null), null);
});

test('priceReviewBurn: a pinned run prices from its pinned model, not the hottest arm', () => {
  const perArm = { 'arm-haiku': 0.05, 'arm-opus': 0.4 };
  const armModels = { 'arm-haiku': 'claude-haiku-5-5', 'arm-opus': 'claude-opus-5-5' };
  // The kept record stores the decorated model (slug + effort); it matches
  // the rung model it was pinned to.
  assert.equal(priceReviewBurn(perArm, null, { model: 'claude-haiku-5-5(xhigh)', armModels }), 0.05);
  assert.equal(priceReviewBurn(perArm, null, { model: 'claude-opus-5-5', armModels }), 0.4);
  // An unmatched model (or none) falls back to the hottest arm: review
  // demand stays visible, the conservative direction.
  assert.equal(priceReviewBurn(perArm, null, { model: 'gemini-2-5-flash', armModels }), 0.4);
  assert.equal(priceReviewBurn(perArm, null, { armModels }), 0.4);
});

test('normalize: rMin above rMax falls back to both defaults (never a pinned reserve)', () => {
  const cfg = normalizeReviewReserve({ rMin: 0.9, rMax: 0.5 }, { keepAgentIds: [] });
  assert.equal(cfg.rMin, DEFAULT_REVIEW_RESERVE.rMin);
  assert.equal(cfg.rMax, DEFAULT_REVIEW_RESERVE.rMax);
  const ok = normalizeReviewReserve({ rMin: 0.2, rMax: 0.8 }, { keepAgentIds: [] });
  assert.equal(ok.rMin, 0.2);
  assert.equal(ok.rMax, 0.8);
});

test('queued reviews: a stale horizon drops stuck records so they cannot hold R high', () => {
  const ledger = new Map([
    ['fresh', { runId: 'fresh', agentId: 'rev-1', decidedAccount: 'claude:a', startedAt: T0 - H, status: 'running' }],
    ['stuck', { runId: 'stuck', agentId: 'rev-1', decidedAccount: 'claude:a', startedAt: T0 - 10 * H, status: 'running' }],
    ['timeless', { runId: 'timeless', agentId: 'rev-1', decidedAccount: 'claude:a', status: 'running' }],
  ]);
  assert.deepEqual(
    queuedReviewsByAccount(ledger, { agentIds: ['rev-1'], nowMs: T0, staleHorizonMs: 2 * H }),
    { byAccount: { 'claude:a': 1 }, unattributed: 0 },
  );
  // No horizon: the old behavior (everything counts) is unchanged.
  assert.deepEqual(
    queuedReviewsByAccount(ledger, { agentIds: ['rev-1'] }),
    { byAccount: { 'claude:a': 3 }, unattributed: 0 },
  );
});

test('priorProviderReserveState: per-provider state wins; legacy v1 seeds every provider', () => {
  const legacy = { buckets: [{ atMs: 1, burn: {}, runs: {} }], envelope: null, runsRate: null, lastFoldMs: 7 };
  assert.equal(priorProviderReserveState(null, 'claude'), null);
  assert.deepEqual(priorProviderReserveState(legacy, 'claude'), legacy);
  assert.deepEqual(priorProviderReserveState(legacy, 'gemini'), legacy);
  const stored = { byProvider: { claude: { buckets: [], envelope: { value: 2, atMs: 9 }, runsRate: null, lastFoldMs: 9, folded: ['r1'] } } };
  assert.deepEqual(priorProviderReserveState(stored, 'claude'), stored.byProvider.claude);
  assert.equal(priorProviderReserveState(stored, 'gemini'), null);
  // Legacy migration restricts shared buckets to the provider's accounts.
  const mixedLegacy = {
    buckets: [{ atMs: 1, burn: { 'claude:a': 2, 'gemini:g': 3 }, runs: { 'claude:a': 4, 'gemini:g': 5 } }],
    envelope: null, runsRate: null, lastFoldMs: 7,
  };
  const geminiPrior = priorProviderReserveState(mixedLegacy, 'gemini', { accountIds: ['gemini:g'] });
  assert.deepEqual(geminiPrior.buckets, [{ atMs: 1, burn: { 'gemini:g': 3 }, runs: { 'gemini:g': 5 } }]);
});

test('folded-runId cap: REVIEW_FOLDED_CAP dwarfs the ledger cap so a folded id cannot be pruned early', async () => {
  const { LEDGER_CAP } = await import('../src/ledger.mjs');
  assert.ok(REVIEW_FOLDED_CAP >= 5 * LEDGER_CAP);
});
