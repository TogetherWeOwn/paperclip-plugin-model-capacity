import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchAaFreeList, parseAaFreeList} from '../src/aa.mjs';

const page = (n, changes = {}) => ({ intelligence_index_version: '5.0', pagination: {page:n,total_pages:4,page_size:1,has_more:n<4}, data:[{slug:`model-${n}`,evaluations:{artificial_analysis_intelligence_index:30+n}}], ...changes });
function client(pages, failPage = 0, status = 500) {
  const seen = [];
  return { seen, fetch: async url => {
    const n = Number(new URL(url).searchParams.get('page') || 1); seen.push(n);
    if (n === failPage) return {status,headers:{get:()=>status===429?'30':null}};
    return {status:200,text:async()=>JSON.stringify(pages[n-1])};
  }};
}
test('follows pagination and returns one validated complete catalog with version', async () => {
  const http = client([1,2,3,4].map(n=>page(n)));
  const result = await fetchAaFreeList({http,apiKey:'test'});
  assert.equal(result.ok,true);
  assert.deepEqual(http.seen,[1,2,3,4]);
  const parsed = parseAaFreeList(result.text);
  assert.equal(parsed.rows.length,4);
  assert.equal(parsed.intelligenceIndexVersion,'5.0');
  assert.equal(result.pagesFetched,4);
});
for (const status of [410,401,403,429,500]) for (const failPage of [2,4]) {
  test(`page ${failPage} HTTP ${status} fails without returning partial text`, async () => {
    const result = await fetchAaFreeList({http:client([1,2,3,4].map(n=>page(n)),failPage,status),apiKey:'test'});
    assert.equal(result.ok,false);
    assert.equal(result.text,undefined);
    if (status===429) assert.equal(result.retryAfterSeconds,30);
  });
}
for (const [name, changes] of [
  ['wrong page',{pagination:{page:1,total_pages:4,page_size:1,has_more:true}}],
  ['inconsistent version',{intelligence_index_version:'4.0'}],
  ['duplicate slug',{data:[{slug:'model-1'}]}],
  ['inconsistent total',{pagination:{page:2,total_pages:5,page_size:1,has_more:true}}],
  ['premature end',{pagination:{page:2,total_pages:4,page_size:1,has_more:false}}],
]) test(`rejects ${name}`, async () => {
  const pages=[1,2,3,4].map(n=>page(n)); pages[1]=page(2,changes);
  const result=await fetchAaFreeList({http:client(pages),apiKey:'test'});
  assert.equal(result.ok,false); assert.equal(result.text,undefined);
});

test('carry forward uncovered benchmarks and slugs without changing their original timestamps', async () => {
  const { carryForwardBenchmarks } = await import('../src/aa.mjs');
  const old = [{slug:'missing',scicode:0.65,fieldObservedAt:{scicode:'2026-10-01T00:00:00Z'},fieldSources:{scicode:'free-api'}}];
  const first = carryForwardBenchmarks([],old,'2026-10-10T00:00:00Z');
  assert.equal(first[0].scicode,0.65);
  assert.equal(first[0].fieldObservedAt.scicode,'2026-10-01T00:00:00Z');
  assert.equal(first[0].fieldSources.scicode,'free-api');
  assert.equal(first[0].staleBenchmarkFields.scicode,true);
  const second = carryForwardBenchmarks([{slug:'missing',scicode:null}],first,'2026-10-20T00:00:00Z');
  assert.equal(second[0].fieldObservedAt.scicode,'2026-10-01T00:00:00Z');
  assert.equal(second[0].staleBenchmarkFields.scicode,true);
});

// A slug the feed stopped serving keeps its history for reporting but must
// never resolve into an arm; once it is served again the marker disappears.
test('a slug absent from the snapshot is carried as historicalOnly and never resolves', async () => {
  const { carryForwardBenchmarks } = await import('../src/aa.mjs');
  const { resolveArms } = await import('../src/arms.mjs');
  const map = [{ aaSlug: 'retired', model: 'm', effort: 'max', family: 'claude', providers: ['claude'] }];
  const carried = carryForwardBenchmarks([], [{ slug: 'retired', scicode: 0.9 }], '2026-10-01T00:00:00Z');
  assert.equal(carried[0].historicalOnly, true, 'history kept, marked historical-only');
  assert.equal(carried[0].scicode, 0.9, 'the value is still available for reporting');
  const { arms, skipped } = resolveArms(carried, map);
  assert.equal(arms.length, 0, 'a retired slug must not stay eligible forever');
  assert.deepEqual(skipped, [{ aaSlug: 'retired', reason: 'slug-prior-only' }]);
  // Served again: the marker must not survive on a present row.
  const back = carryForwardBenchmarks([{ slug: 'retired', scicode: 0.91 }], carried, '2026-10-02T00:00:00Z');
  assert.equal(back[0].historicalOnly, undefined);
  assert.equal(resolveArms(back, map).arms.length, 1);
});

// Review finding 1: gating only the classic table reroutes a retired model
// into a dynamic arm, because buildAccountLadders covers classic arms only for
// the classic path. A lane that still lists the id must not resurrect it.
test('a historical-only row resolves no dynamic arm either', async () => {
  const { carryForwardBenchmarks } = await import('../src/aa.mjs');
  const { buildDynamicBindings, resolveDynamicArms } = await import('../src/arms.mjs');
  const carried = carryForwardBenchmarks([], [{ slug: 'retired-model', scicode: 0.9 }], '2026-10-01T00:00:00Z');
  const { bindings } = buildDynamicBindings(['retired-model'], {});
  assert.equal(bindings.length, 1, 'the lane still serves the id');
  const { arms, unscored } = resolveDynamicArms(carried, bindings);
  assert.equal(arms.length, 0, 'a retired slug must not come back as a dynamic arm');
  assert.deepEqual(unscored.map(u => [u.model, u.reason]), [['retired-model', 'slug-prior-only']]);
  // Served again is still routine: the row loses the marker and resolves.
  const back = carryForwardBenchmarks([{ slug: 'retired-model', scicode: 0.91 }], carried, '2026-10-02T00:00:00Z');
  assert.equal(resolveDynamicArms(back, bindings).arms.length, 1);
});

test('dynamic resolution skips historical aliases and tries the next fresh candidate', async () => {
  const { carryForwardBenchmarks } = await import('../src/aa.mjs');
  const { buildDynamicBindings, resolveDynamicArms } = await import('../src/arms.mjs');
  for (const [model, freshSlug] of [
    ['foo-1m', 'foo'], ['foo.2', 'foo-2'], ['foo-20261029', 'foo'],
    ['foo-free', 'foo'], ['foo-contributor', 'foo-xhigh'],
  ]) {
    const { bindings } = buildDynamicBindings([model]);
    let rows = [{ slug: model, scicode: 0.9 }];
    // Repeated refreshes keep the old alias but must not let it mask the fresh one.
    for (const now of ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z']) {
      rows = carryForwardBenchmarks([{ slug: freshSlug, scicode: 0.91 }], rows, now);
      assert.equal(rows.find(r => r.slug === model).historicalOnly, true);
      for (const input of [rows, [...rows].reverse()]) {
        const { arms, unscored } = resolveDynamicArms(input, bindings);
        assert.equal(arms.length, 1, `${model} must fall through to ${freshSlug}`);
        assert.equal(arms[0].aaSlug, freshSlug);
        assert.equal(arms[0].row.scicode, 0.91);
        assert.equal(arms[0].row.historicalOnly, undefined);
        assert.deepEqual(unscored, []);
      }
    }
  }
});

test('dynamic historical alias skips preserve no-match reasons and explicit overrides', async () => {
  const { buildDynamicBindings, resolveDynamicArms } = await import('../src/arms.mjs');
  const retired = { slug: 'foo-1m', scicode: 0.9, historicalOnly: true };
  const { bindings } = buildDynamicBindings(['foo-1m']);
  for (const rows of [[retired], [retired, { slug: 'foo', historicalOnly: true }]]) {
    const result = resolveDynamicArms(rows, bindings);
    assert.deepEqual(result.arms, []);
    assert.deepEqual(result.unscored, [{ model: 'foo-1m', reason: 'slug-prior-only', tried: ['foo-1m', 'foo'] }]);
  }
  assert.equal(resolveDynamicArms([], bindings).unscored[0].reason, 'no-aa-match');
  const override = buildDynamicBindings(['foo-1m'], { overrides: { 'foo-1m': 'foo-1m' } });
  const result = resolveDynamicArms([retired, { slug: 'foo', scicode: 0.91 }], override.bindings);
  assert.deepEqual(result.arms, [], 'an explicit override must not fall back to an unconfigured alias');
  assert.deepEqual(result.unscored, [{ model: 'foo-1m', reason: 'slug-prior-only', tried: ['foo-1m'] }]);
});

// The unscored allowlist admits a family AA has never scored. It must not
// admit a model AA scored and then retired: that entry may predate the
// retirement, and a null-score trial arm would route the retired model again.
test('a stale unscored admission cannot resurrect a retired slug', async () => {
  const { buildDynamicBindings, resolveDynamicArms } = await import('../src/arms.mjs');
  const retired = { slug: 'swe-2', scicode: 0.9, historicalOnly: true };
  const { bindings } = buildDynamicBindings(['devin/swe-2']);
  const unscoredAllowlist = new Map([['swe-2', [{ servedId: 'devin/swe-2', reason: 'documented trial' }]]]);
  const result = resolveDynamicArms([retired], bindings, { unscoredAllowlist });
  assert.deepEqual(result.arms, [], 'a retired slug must not come back as a trial arm');
  assert.deepEqual(result.unscored.map(u => [u.model, u.reason]), [['swe-2', 'slug-prior-only']]);
  // Same allowlist, no AA history at all: admission still works as before.
  assert.equal(resolveDynamicArms([], bindings, { unscoredAllowlist }).arms.length, 1);
});

// Review finding 2: task ranking is the third consumer of snapshot rows.
test('task discovery never scores a historical-only row', async () => {
  const { carryForwardBenchmarks } = await import('../src/aa.mjs');
  const { discoverTaskArms } = await import('../src/arms.mjs');
  const carried = carryForwardBenchmarks([], [{ slug: 'retired-model', scicode: 0.9 }], '2026-10-01T00:00:00Z');
  const { arms, unscored } = discoverTaskArms(carried, ['retired-model'], {});
  assert.equal(arms.length, 0, 'task ranking must not recruit a retired slug');
  assert.deepEqual(unscored.map(u => [u.model, u.reason]), [['retired-model', 'slug-prior-only']]);
  const back = carryForwardBenchmarks([{ slug: 'retired-model', scicode: 0.91 }], carried, '2026-10-02T00:00:00Z');
  assert.equal(discoverTaskArms(back, ['retired-model'], {}).arms.length, 1);
});

// A kept layer must never hand the marker to a row the fresh feed serves, or a
// re-served slug stays blocked forever (contrary to C3). It must also never
// *invent* the marker: this path runs only while the leaderboard is failing,
// so absence from the fresh API is not retirement evidence -- a
// leaderboard-only model would otherwise lose its rung on an outage.
test('gap fill never leaks or invents the marker onto fresh and kept-only rows', async () => {
  const { mergeAaRowsGapFill } = await import('../src/aa.mjs');
  const merged = mergeAaRowsGapFill(
    [{ slug: 'live-model', scicode: 0.8 }],
    [{ slug: 'live-model', scicode: 0.7, historicalOnly: true }, { slug: 'board-only', scicode: 0.9 }],
  );
  const live = merged.rows.find(r => r.slug === 'live-model');
  const boardOnly = merged.rows.find(r => r.slug === 'board-only');
  assert.equal(live.historicalOnly, undefined, 'the fresh feed serves this slug: no marker');
  assert.equal(live.scicode, 0.8, 'fresh API value still wins');
  assert.equal(boardOnly.historicalOnly, undefined, 'absent from the API during an outage is not retirement');
  assert.equal(boardOnly.scicode, 0.9, 'and its values are still kept for reporting');
});

// A leaderboard outage must leave a live leaderboard-only arm routing exactly
// as it does when both sources are healthy (2026-10-17 ladder-emptying rule).
test('a leaderboard-only arm keeps routing through an outage, as it does when healthy', async () => {
  const { mergeAaRows, mergeAaRowsGapFill } = await import('../src/aa.mjs');
  const { resolveArms } = await import('../src/arms.mjs');
  const map = [{ aaSlug: 'board-only', model: 'board/model', effort: 'max', family: 'claude', providers: ['claude'] }];
  const api = [{ slug: 'api-only', scicode: 0.5 }];
  const healthy = resolveArms(mergeAaRows(api, [{ slug: 'board-only', scicode: 0.9 }]).rows, map);
  const outage = resolveArms(mergeAaRowsGapFill(api, [{ slug: 'board-only', scicode: 0.9 }]).rows, map);
  assert.deepEqual(outage.arms.map(a => a.armId), healthy.arms.map(a => a.armId));
  assert.equal(outage.arms.length, 1, 'a failed leaderboard source is not retirement evidence');
  assert.deepEqual(outage.skipped, []);
});

// Retiring a slug is only proven when the feed itself stops serving it. A
// re-served slug must shed the carried marker, including on the API-failure
// path where the previous merged rows are the base layer.
test('a re-served slug sheds a stale marker on the API-failure merge path', async () => {
  const { mergeAaRows } = await import('../src/aa.mjs');
  const { resolveArms } = await import('../src/arms.mjs');
  const map = [{ aaSlug: 'revived', model: 'x/revived', effort: 'max', family: 'claude', providers: ['claude'] }];
  const merged = mergeAaRows(
    [{ slug: 'revived', scicode: 0.8, historicalOnly: true }],
    [{ slug: 'revived', scicode: 0.85 }],
  );
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].historicalOnly, undefined, 'the fresh leaderboard serves it again');
  assert.equal(resolveArms(merged.rows, map).arms.length, 1);
});

// A duplicate slug whose rows are ALL carried history is retired, not merely
// ambiguous. Falling through to the unscored allowlist would re-admit it.
test('an all-historical duplicate slug reports retirement instead of ambiguity', async () => {
  const { buildDynamicBindings, resolveDynamicArms } = await import('../src/arms.mjs');
  const rows = [{ slug: 'dup', scicode: 0.7, historicalOnly: true }, { slug: 'dup', scicode: 0.8, historicalOnly: true }];
  const { bindings } = buildDynamicBindings(['dup']);
  const allowlist = new Map([['dup', [{ servedId: 'dup', reason: 'documented trial' }]]]);
  const result = resolveDynamicArms(rows, bindings, { unscoredAllowlist: allowlist });
  assert.deepEqual(result.arms, [], 'no unscored trial may resurrect a retired slug');
  assert.deepEqual(result.unscored, [{ model: 'dup', reason: 'slug-prior-only', tried: ['dup'] }]);
});

// A classic binding pins its own AA slug, so a retired model can be skipped
// out of the dynamic pass entirely and be re-admitted by an unscored entry
// that predates the retirement. Retirement must survive that slug mismatch.
test('classic-pass retirement evidence blocks unscored admission under another slug', async () => {
  const { resolveArms, buildDynamicBindings, resolveDynamicArms, canonicalModelName } = await import('../src/arms.mjs');
  const armMap = [{ aaSlug: 'foo-retired', model: 'm/foo', effort: 'max', family: 'claude', providers: ['claude'] }];
  const rows = [{ slug: 'foo-retired', scicode: 0.9, historicalOnly: true }];
  const classic = resolveArms(rows, armMap);
  assert.deepEqual(classic.skipped, [{ aaSlug: 'foo-retired', reason: 'slug-prior-only' }]);
  const { bindings } = buildDynamicBindings(['m/foo'], { coveredModels: classic.arms.map(a => a.model) });
  const allowlist = new Map([['foo', [{ servedId: 'm/foo', reason: 'documented trial' }]]]);
  // Mirrors the plugin wiring: the set is keyed by canonical id, like the
  // dynamic bindings it is compared against.
  const retiredModels = new Set(armMap.filter(b => b.aaSlug === 'foo-retired').map(b => canonicalModelName(b.model)));
  const guarded = resolveDynamicArms(rows, bindings, { unscoredAllowlist: allowlist, retiredModels });
  assert.deepEqual(guarded.arms, [], 'history known to the classic pass still retires the model');
  assert.deepEqual(guarded.unscored, [{ model: 'foo', reason: 'slug-prior-only', tried: ['foo'] }]);
  // Without the evidence the same allowlist still admits: the guard is the
  // cross-pass set, not a blanket ban on unscored trials.
  assert.equal(resolveDynamicArms(rows, bindings, { unscoredAllowlist: allowlist }).arms.length, 1);
});

test('rejects a changed final page size that can skip rows', async () => {
  const { readFileSync } = await import('node:fs');
  const pages = [1,2,3,4].map(n => JSON.parse(readFileSync(new URL(`./fixtures/aa-free-20261029-page-${n}.json`, import.meta.url))));
  pages[3].pagination.page_size = 210;
  pages[3].data.splice(0, 30);
  const result = await fetchAaFreeList({http:client(pages),apiKey:'test'});
  assert.equal(result.ok,false);
  assert.equal(result.error,'aa-incomplete-snapshot');
  assert.equal(result.text,undefined);
});

test('rejects a short nonfinal page even if metadata claims more pages', async () => {
  const { readFileSync } = await import('node:fs');
  const pages = [1,2,3,4].map(n => JSON.parse(readFileSync(new URL(`./fixtures/aa-free-20261029-page-${n}.json`, import.meta.url))));
  pages[1].data.pop();
  const result = await fetchAaFreeList({http:client(pages),apiKey:'test'});
  assert.equal(result.ok,false);
  assert.equal(result.error,'aa-incomplete-snapshot');
  assert.equal(result.text,undefined);
});

test('cumulative byte limit rejects individually valid pages exceeding the total cap', async () => {
  const pages = [1,2,3,4].map(n => page(n));
  const sizes = pages.map(p => Buffer.byteLength(JSON.stringify(p)));
  const cap = Math.max(...sizes) + 10;
  assert.ok(sizes[0] + sizes[1] > cap);
  const result = await fetchAaFreeList({http:client(pages), apiKey:'test', maxResponseBytes:cap});
  assert.equal(result.ok,false);
  assert.equal(result.error,'aa-response-too-large');
  assert.equal(result.text,undefined);
});

test('later pages receive only the remaining total deadline', async () => {
  const pages = [1,2].map(n => ({...page(n),pagination:{page:n,total_pages:2,page_size:1,has_more:n===1}}));
  const http = {fetch: async url => {
    const n=Number(new URL(url).searchParams.get('page'));
    await new Promise(resolve => setTimeout(resolve,80));
    return {status:200,text:async()=>JSON.stringify(pages[n-1])};
  }};
  const result = await fetchAaFreeList({http,apiKey:'test',timeoutMs:130});
  assert.equal(result.ok,false);
  assert.equal(result.text,undefined);
  assert.match(result.error,/aa-request-(failed|timeout)/);
});
