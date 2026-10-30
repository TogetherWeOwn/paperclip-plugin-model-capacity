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
