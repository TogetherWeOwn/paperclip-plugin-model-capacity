import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRoleComposite, METRIC_REGISTRY } from '../src/quality.mjs';
import { discoverTaskArms } from '../src/arms.mjs';
import { normalizeTaskRanking, validateTaskRanking, buildTaskRanking, translateTaskExclusions } from '../src/task-ranking.mjs';
import { orderAccountsForRun } from '../src/select.mjs';
import { decide } from '../src/decide.mjs';
import { carryForwardCosts } from '../src/aa.mjs';
import { selectReviewerRoute } from '../src/reviewerrouting.mjs';

const row = (slug, v, cost = 1) => ({ slug, terminalbenchV40: v, scicode: v, lcr: v,
  ifbench: v, omniscienceNonHallucination: v, hle: 1 - v, gpqa: 1 - v,
  critpt: 1 - v, gdpvalNormalized: 1 - v, intelligenceIndexCostPerTask: cost });
const arms = [row('a', .8), row('b', .2)].map(r => ({ armId: r.slug, row: r }));

test('task exclusions match every identity case-insensitively and preserve unmatched tokens', () => {
  const candidate = { armId: 'gpt-6-1-sol@high', aaSlug: 'gpt-6-1-sol-high',
    canonicalModel: 'GPT-6.1-Sol', model: 'Codex/GPT-6.1-Sol' };
  for (const token of ['arm:GPT-6-1-Sol@High', 'arm:GPT-6-1-Sol-High', 'ARM:GPT-6-1-Sol-High',
    'arm:gpt-6.1-sol', 'arm:codex/gpt-6.1-sol']) {
    const translated = translateTaskExclusions({ doer: [token], thinker: [token], other: [token] }, [candidate]);
    for (const role of ['doer', 'thinker', 'other']) {
      assert.deepEqual(translated[role], ['arm:gpt-6-1-sol@high'], `${role}: ${token}`);
    }
  }
  const untouched = ['ARM:Unknown-Model', 'SoL', null];
  assert.deepEqual(translateTaskExclusions({ doer: untouched }, [candidate]).doer, untouched);
});

test('role profiles are distinct, reliability is higher-is-better, missing metrics are not zero', () => {
  const doer = computeRoleComposite(arms, { terminalbenchV40: 1 });
  const thinker = computeRoleComposite(arms, { hle: 1 });
  assert.equal(doer[0].Q, 1);
  assert.equal(thinker[0].Q, -1);
  const reliability = computeRoleComposite(arms, { omniscienceNonHallucination: 1 });
  assert.equal(reliability[0].Q, 1);
  const sparse = computeRoleComposite([{ armId: 's', row: { lcr: .8 } }], { lcr: .2, hle: .8 })[0];
  assert.equal(sparse.Q, 0);
  assert.equal(sparse.coverage, 1);
  assert.equal(sparse.absoluteCoverage, .2);
});

test('benchmark versions and tau datasets never cross-fill; invalid observations are isolated', () => {
  const score = computeRoleComposite([{ armId: 'old', row: { terminalbenchHard: .9, terminalbenchV21: .9,
    tauBanking: .9, omniscienceNonHallucination: 90, lcr: .5 } }],
  { terminalbenchV40: .3, tau2: .3, omniscienceNonHallucination: .2, lcr: .2 })[0];
  assert.equal(score.absoluteCoverage, .2);
  assert.equal(score.components.terminalbenchV40.value, null);
  assert.equal(score.components.tau2.value, null);
  assert.equal(score.components.omniscienceNonHallucination.reason, 'invalid-observation');
  assert.equal(METRIC_REGISTRY.omniscience.direction, 'higher');
  const headline = computeRoleComposite([{ armId: 'hi', row: { omniscience: 80 } },
    { armId: 'lo', row: { omniscience: 20 } }], { omniscience: 1 });
  assert.equal(headline[0].Q, 1);
});

test('profile validation rejects typos, empty profiles, correlations, and invalid weights', () => {
  for (const weights of [{ typoo: 1 }, { hle: Infinity }, { hle: -1 }, { hle: 1e308, gpqa: 1e308 }, {}, { intelligenceIndex: .5, hle: .5 }]) {
    assert.ok(validateTaskRanking({ roleMetricWeights: { doer: weights } }).length > 0);
  }
  assert.ok(validateTaskRanking({ roleMetricWeights: { typoRole: { hle: 1 } } }).length > 0);
  const cfg = normalizeTaskRanking({ roleMetricWeights: { thinker: { hle: 1 } } });
  assert.deepEqual(cfg.roleMetricWeights.thinker, { hle: 1 }, 'replace, not merge');
  assert.equal(cfg.mode, 'shadow');
  assert.equal(cfg.calibration.enabled, false);
});

test('discovery enumerates exact effort rows, dedupes classic/dynamic, and composes aliases', () => {
  const rows = [row('gpt-6-1-sol', .8, .7241670655535033), row('gpt-6-1-sol-high', .7, .31914442375664703),
    row('gpt-6-1-sol-low', .6, .13075190869859377), row('muse-spark-1-3', .8), row('muse-spark-1-3-xhigh', .7)];
  const out = discoverTaskArms(rows, ['gpt-6.1-sol', 'vendor/muse-spark-1.3-contributor-free']);
  const sol = out.arms.filter(a => a.model === 'gpt-6.1-sol');
  assert.equal(sol.length, 3);
  assert.equal(new Set(sol.map(a => a.armId)).size, 3);
  assert.equal(sol.find(a => a.effort === 'high').row.intelligenceIndexCostPerTask, .31914442375664703);
  assert.equal(sol.find(a => a.effort === 'low').effortVerified, false);
  assert.ok(out.arms.some(a => a.model.endsWith('-contributor-free') && a.matchType === 'verified-alias'));
  assert.equal(out.arms.some(a => a.model === 'muse-spark-1.3'), false);
});

test('borrowed evidence, missing evidence, unsupported efforts and forbidden identities remain visible', () => {
  const out = discoverTaskArms([row('a', .5)], ['new-model', 'unknown', 'muse-spark-1.3', 'gpt-6-sol'],
    { overrides: { 'new-model': { slug: 'a', effort: 'high' } }, effortSupport: { 'new-model': ['high'] } });
  assert.equal(out.arms.find(a => a.model === 'new-model').matchType, 'borrowed');
  assert.equal(out.unscored.find(a => a.model === 'unknown').reason, 'no-aa-match');
  assert.equal(out.unscored.find(a => a.model === 'muse-spark-1.3').reason, 'identity-policy');
  assert.equal(out.unscored.find(a => a.model === 'gpt-6-sol').reason, 'banned-model');
});

test('fleet normalization counts each arm once, role ladders start before other-role Pareto pruning', () => {
  const cfg = normalizeTaskRanking();
  const candidates = arms.map((a, i) => ({ ...a, model: a.armId, effort: 'max', family: 'test',
    matchType: 'exact', effortVerified: true, C: i + 1, costBase: i + 1, costMultiplier: 1 }));
  const build = cs => buildTaskRanking({ candidatesByAccount: cs, config: cfg, minQuality: { doer: null, thinker: null, other: null } });
  const a = build({ one: candidates });
  const b = build({ one: candidates, two: candidates });
  assert.equal(a.accounts.one.roles.doer.candidates[0].qFleet, b.accounts.one.roles.doer.candidates[0].qFleet);
  assert.ok(a.accounts.one.roles.thinker.rungs.some(r => r.armId === 'b'), 'thinker evidence is not doer-pruned');
  assert.equal(a.accounts.one.roles.doer.candidates[0].estimatedApiEquivalentPerAcceptedTask, null);
  assert.equal(a.calibration.reason, 'awaiting-native-attributed-outcomes');
});

test('coverage and provenance trust cannot be suspended by a small population or empty-role safeguard', () => {
  const cfg = normalizeTaskRanking();
  const cs = [
    { armId: 'sparse', model: 'sparse', row: { lcr: .8 }, effortVerified: true, matchType: 'exact', C: 1 },
    { armId: 'borrowed', model: 'borrowed', row: row('b', .8), effortVerified: true, matchType: 'borrowed', C: 1 },
    { armId: 'unverified', model: 'unverified', row: row('u', .8), effortVerified: false, matchType: 'exact', C: 1 },
  ];
  const out = buildTaskRanking({ candidatesByAccount: { one: cs }, config: cfg });
  assert.equal(out.accounts.one.roles.doer.rungs.length, 0);
  const cands = out.accounts.one.roles.doer.candidates;
  assert.equal(cands[0].trustReason, 'insufficient-profile-coverage');
  assert.equal(cands[1].trustReason, 'borrowed-evidence');
  assert.equal(cands[2].trustReason, 'effort-unverified');
});

const view = (id, cost, q, extra = {}) => ({ accountId: id, headroomPct: .9, remainingPct: .9, health: 'healthy',
  measuredRatePerHour: .01, requiredRatePerHour: .02, placementQ: q,
  taskCostProxy: cost, targetShare: 3, ...extra });
test('cost precedes surplus quality and allowance inside policy buckets, not funding or burn policy', () => {
  const cheap = view('cheap', .31914442375664703, .5);
  const expensive = view('expensive', 1.3987235612691513, 2, { targetShare: 20 });
  const opts = { taskRanking: { mode: 'enforce' }, placement: { qualityWeight: 1, allowanceWeight: .35 } };
  assert.equal(orderAccountsForRun([expensive, cheap], opts)[0].accountId, 'cheap');
  assert.equal(orderAccountsForRun([expensive, cheap], { ...opts, taskRanking: { mode: 'shadow' } })[0].accountId, 'expensive');
  assert.equal(orderAccountsForRun([{ ...expensive, burn: true }, cheap], opts)[0].accountId, 'expensive');
  assert.equal(orderAccountsForRun([expensive, { ...cheap, creditFallback: true }], opts)[0].accountId, 'expensive');
});

test('doer chooses Sol high rather than Terra max if both are capable and servable', () => {
  // Exact public AA workload costs; capability below is an independent fixture, not inferred from cost.
  const sol = { armId: 'sol-high', model: 'gpt-6.1-sol', effort: 'high', Q: .5, C: .31914442375664703,
    taskCostProxy: .31914442375664703, taskRanking: true, contextWindow: 1000000 };
  const terra = { armId: 'terra-max', model: 'gpt-5.6-terra', effort: 'max', Q: 2, C: 1.3987235612691513,
    taskCostProxy: 1.3987235612691513, taskRanking: true, contextWindow: 1000000 };
  const pick = cs => decide({ runId: 'run', agentId: 'builder', accountId: 'lane', role: 'doer',
    ladderRungs: [{ rung: 0, arms: cs }], taskRanking: { mode: 'enforce' } });
  assert.equal(pick([terra, sol]).model, 'gpt-6.1-sol');
  assert.equal(pick([terra]).model, 'gpt-5.6-terra');
  assert.equal(pick([terra, { ...sol, contextWindow: 1 }]).model, 'gpt-6.1-sol', 'without context requirement no extra gate is invented');
  const constrained = decide({ runId: 'run', accountId: 'lane', contextTokens: 1000,
    ladderRungs: [{ rung: 0, arms: [terra, { ...sol, contextWindow: 100 }] }], taskRanking: { mode: 'enforce' } });
  assert.equal(constrained.model, 'gpt-5.6-terra');
});

test('repeated cost carry keeps original per-field observation age', () => {
  const first = carryForwardCosts([{ slug: 'a', intelligenceIndexCostPerTask: null }],
    [{ slug: 'a', intelligenceIndexCostPerTask: 1 }], '2026-10-01T00:00:00Z');
  const second = carryForwardCosts([{ slug: 'a', intelligenceIndexCostPerTask: null }], first, '2026-10-02T00:00:00Z');
  assert.equal(second[0].costCarriedFrom, '2026-10-01T00:00:00Z');
  assert.equal(second[0].costFieldObservedAt.intelligenceIndexCostPerTask, '2026-10-01T00:00:00Z');
});

test('Meta-primary routing is explicit only in new enforce mode and preserves configured reviewers', () => {
  const cfg = { arms: [{ provider: 'meta', model: 'approved-meta', effort: 'max' },
    { provider: 'claude', model: 'approved-fallback', effort: 'high' }] };
  const accounts = [view('meta:one', 1, null, { provider: 'meta', planAhead: .1 }),
    view('claude:one', 1, null, { provider: 'claude', burn: true, planAhead: -.2 })];
  assert.equal(selectReviewerRoute({ cfg, accounts }).provider, 'claude');
  const out = selectReviewerRoute({ cfg, accounts, taskRanking: { mode: 'enforce' } });
  assert.equal(out.provider, 'meta');
  assert.equal(out.primary, true);
  const fallback = selectReviewerRoute({ cfg, accounts, serves: a => a.provider !== 'meta', taskRanking: { mode: 'enforce' } });
  assert.equal(fallback.provider, 'claude');
  assert.equal(fallback.primary, false);
  assert.match(fallback.fallbackReason, /unavailable/);
});

test('provider/price aliases share one benchmark identity across account normalization', () => {
  const rows = [row('gpt-6-1-sol-high', .8)];
  const out = discoverTaskArms(rows, ['gpt-6.1-sol', 'vendor/gpt-6-1-sol-free']);
  assert.equal(new Set(out.arms.map(a => a.armId)).size, 1);
});

test('schema drift is diagnostic, never a silently accepted new weighted metric', async () => {
  const { metricSchemaWarnings } = await import('../src/task-ranking.mjs');
  assert.ok(metricSchemaWarnings([{ slug: 'a', newBenchmark: .9 }]).includes('unregistered-source-field:newBenchmark'));
  const { parseAaLeaderboardHtml } = await import('../src/aa.mjs');
  const parsed = parseAaLeaderboardHtml('"models":' + JSON.stringify([{ slug: 'a', intelligenceIndex: 50, unexpectedScore: .8 }]) + '}');
  assert.ok(parsed[0].schemaWarnings.includes('unregistered-source-field:unexpectedScore'));
});

test('new arm identity never splits pending/enforced quota attribution from observed model-effort', async () => {
  const { armKeyOfRecord } = await import('../src/arm-calibration.mjs');
  const pending = { armId: 'gpt-6-1-sol@high', effort: 'high', wouldModel: 'gpt-6.1-sol(high)', enforced: true };
  assert.equal(armKeyOfRecord(pending), 'gpt-6.1-sol:high');
  assert.equal(armKeyOfRecord({ ...pending, actualModel: 'gpt-6.1-sol' }), armKeyOfRecord(pending));
});

test('snapshot gap fill preserves per-field ages across successful API refreshes', async () => {
  const { stampAaObservations, mergeAaRowsGapFill } = await import('../src/aa.mjs');
  const fresh = stampAaObservations([{ slug: 'a', intelligenceIndex: 55 }], '2026-10-25T00:00:00Z', 'free-api');
  const old = stampAaObservations([{ slug: 'a', terminalbenchV40: .6, intelligenceIndexCostPerTask: 1 }], '2026-10-01T00:00:00Z', 'public-leaderboard');
  const merged = mergeAaRowsGapFill(fresh, old).rows[0];
  assert.equal(merged.fieldObservedAt.intelligenceIndex, '2026-10-25T00:00:00Z');
  assert.equal(merged.fieldObservedAt.terminalbenchV40, '2026-10-01T00:00:00Z');
  const out = buildTaskRanking({ candidatesByAccount: { a: [{ armId: 'a', model: 'a', effortVerified: true,
    matchType: 'exact', row: merged }] }, snapshotAt: '2026-10-25T00:00:00Z' });
  const candidate = out.accounts.a.roles.doer.candidates[0];
  assert.equal(candidate.aaCostObservedAt, '2026-10-01T00:00:00Z');
  assert.equal(candidate.aaCostSource, 'carried');
});

test('manifest exposes the additive mode without adding capabilities or learned calibration', async () => {
  const { manifest, enforceManifest } = await import('../src/manifest.mjs');
  const schema = manifest.instanceConfigSchema.properties.taskRanking;
  assert.deepEqual(schema.properties.mode.enum, ['off', 'shadow', 'enforce']);
  assert.equal(schema.properties.mode.default, 'shadow');
  assert.equal(manifest.capabilities.includes('run.model.resolve'), false);
  assert.equal(enforceManifest.capabilities.includes('run.model.resolve'), true);
});

test('a model name ending in an effort word is not stripped into another generation', () => {
  const out = discoverTaskArms([row('new-model-ultra', .8), row('new-model-ultra-high', .7)],
    ['new-model-ultra'], { effortSupport: { 'new-model-ultra': ['max', 'high'] } });
  assert.equal(out.arms.length, 2);
  assert.equal(out.arms.find(a => a.aaSlug === 'new-model-ultra').effort, 'max');
  assert.equal(out.arms.find(a => a.aaSlug === 'new-model-ultra-high').effort, 'high');
});

test('borrowed or effort-unverified arms cannot move trusted fleet capability scores', () => {
  const cs = [
    { armId: 'one', model: 'one', effort: 'max', row: row('one', .8), matchType: 'exact', effortVerified: true },
    { armId: 'two', model: 'two', effort: 'max', row: row('two', .6), matchType: 'exact', effortVerified: true },
  ];
  const base = buildTaskRanking({ candidatesByAccount: { lane: cs } });
  const injected = buildTaskRanking({ candidatesByAccount: { lane: [...cs,
    { armId: 'fake', model: 'fake', effort: 'max', row: row('fake', .01), matchType: 'borrowed', effortVerified: true },
    { armId: 'unverified', model: 'unverified', effort: 'low', row: row('unverified', .02), matchType: 'exact', effortVerified: false },
  ] } });
  assert.equal(injected.accounts.lane.roles.doer.candidates[0].qFleet, base.accounts.lane.roles.doer.candidates[0].qFleet);
  assert.equal(injected.accounts.lane.roles.doer.candidates[0].Q, base.accounts.lane.roles.doer.candidates[0].Q);
});

test('cheapest-capable spans role rungs without spending for the pointer; retries retain their rung policy', () => {
  const a = { armId: 'cheap', model: 'cheap', Q: .5, taskCostProxy: .2 };
  const b = { armId: 'expensive', model: 'expensive', Q: 2, taskCostProxy: 2 };
  const input = { ladderRungs: [{ rung: 0, arms: [a] }, { rung: 1, arms: [b] }],
    taskRanking: { mode: 'enforce' }, pointer: 1, role: 'doer' };
  assert.equal(decide(input).armId, 'cheap');
  assert.equal(decide({ ...input, retryCount: 1 }).armId, 'expensive');
  assert.equal(decide({ ...input, roleBands: { doer: { floorRung: 1 } } }).armId, 'expensive');
});

test('absolute coverage describes observations even outside the trusted normalization population', () => {
  const out = computeRoleComposite([{ armId: 'trial', row: { hle: .7 } }], { hle: 1 }, { population: [] })[0];
  assert.equal(out.Q, null);
  assert.equal(out.absoluteCoverage, 1);
});

test('carrying an old price cannot age a freshly measured AA task cost', () => {
  const date = '2026-10-25T00:00:00Z';
  const carried = carryForwardCosts([{ slug: 'a', intelligenceIndexCostPerTask: 2, price1mInputTokens: null,
    fieldObservedAt: { intelligenceIndexCostPerTask: date } }],
  [{ slug: 'a', intelligenceIndexCostPerTask: 1, price1mInputTokens: 1 }], '2026-10-01T00:00:00Z');
  const c = buildTaskRanking({ candidatesByAccount: { lane: [{ armId: 'a', model: 'a', row: carried[0],
    matchType: 'exact', effortVerified: true }] }, snapshotAt: date }).accounts.lane.roles.doer.candidates[0];
  assert.equal(c.aaCostSource, 'measured');
  assert.equal(c.aaCostObservedAt, date);
});

test('known served efforts missing from the snapshot stay visible without borrowing a base cost', () => {
  const out = discoverTaskArms([row('gpt-6-1-sol', .8, .7)], ['gpt-6.1-sol']);
  const absent = out.unscored.find(a => a.model === 'gpt-6.1-sol' && a.effort === 'high');
  assert.equal(absent.reason, 'no-aa-effort-match');
  assert.equal(out.arms.some(a => a.effort === 'high'), false);
});

test('overlapping aliases on one account are one scoring vote and one selectable binding', () => {
  const cs = [
    { armId: 'one', model: 'one', effort: 'max', row: row('one', .8), matchType: 'exact', effortVerified: true },
    { armId: 'two', model: 'two', effort: 'max', row: row('two', .6), matchType: 'exact', effortVerified: true },
  ];
  const baseline = buildTaskRanking({ candidatesByAccount: { lane: cs } }).accounts.lane.roles.doer;
  const duplicate = buildTaskRanking({ candidatesByAccount: { lane: [cs[0], { ...cs[0], model: 'one-free' }, cs[1]] } }).accounts.lane.roles.doer;
  assert.equal(duplicate.candidates[0].Q, baseline.candidates[0].Q);
  assert.equal(duplicate.candidates.filter(c => c.armId === 'one' && c.eligible).length, 1);
});

test('an explicit override cannot turn a max-effort observation into measured high-effort evidence', () => {
  const out = discoverTaskArms([row('gpt-6-1-sol', .8, .7)], ['gpt-6.1-sol'], {
    overrides: { 'gpt-6.1-sol': { slug: 'gpt-6-1-sol', effort: 'high' } },
    effortSupport: { 'gpt-6.1-sol': ['high'] },
  });
  assert.equal(out.arms[0].matchType, 'borrowed');
  const scored = buildTaskRanking({ candidatesByAccount: { lane: out.arms } }).accounts.lane.roles.doer.candidates[0];
  assert.equal(scored.benchmarkTrusted, false);
});

test('task-feasible selection respects an emitted arm context ceiling, not LCR or the advertised AA window', () => {
  const cheap = { armId: 'cheap', model: 'cheap', Q: 2, taskCostProxy: .2, contextWindow: 1000000,
    cap: { maxTokens: 500000 } };
  const expensive = { armId: 'expensive', model: 'expensive', Q: .5, taskCostProxy: 2, contextWindow: 1000000 };
  const d = decide({ ladderRungs: [{ rung: 0, arms: [cheap, expensive] }], contextTokens: 300000,
    taskRanking: { mode: 'enforce' } });
  assert.equal(d.armId, 'expensive');
});

test('reviewer fallback explains an exhausted primary instead of attributing it to model quality', () => {
  const cfg = { arms: [{ provider: 'meta', model: 'approved-primary' }, { provider: 'claude', model: 'approved-fallback' }] };
  const out = selectReviewerRoute({ cfg, taskRanking: { mode: 'enforce' }, accounts: [
    view('meta:primary', 1, 1, { provider: 'meta', headroomPct: .01 }),
    view('claude:fallback', 2, 1, { provider: 'claude' }),
  ] });
  assert.equal(out.provider, 'claude');
  assert.match(out.fallbackReason, /headroom/);
});
