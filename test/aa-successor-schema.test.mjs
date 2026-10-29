import test from 'node:test';
import assert from 'node:assert/strict';
import { AA_FREE_LIST_URL, fetchAaFreeList, parseAaFreeList, parseAaLeaderboardHtml } from '../src/aa.mjs';

test('free endpoint is the replacement', () => {
  assert.equal(AA_FREE_LIST_URL, 'https://artificialanalysis.ai/api/v2/language/models/free');
});

test('free endpoint normalizes successor nested values without converting nulls', () => {
  const { rows: [row] } = parseAaFreeList(JSON.stringify({data:[{
    slug:'example', intelligence_index_version:'4.0',
    evaluations:{ artificial_analysis_intelligence_index:42, artificial_analysis_coding_index:null, artificial_analysis_agentic_index:null },
    artificial_analysis_intelligence_index_cost:{cost_per_task:{total_cost:0.42}},
    pricing:{price_1m_input_tokens:1,price_1m_output_tokens:2,price_1m_cache_hit_tokens:null,price_1m_cache_write_tokens:0.5},
    performance:{median_output_tokens_per_second:50,median_time_to_first_token_seconds:0.3}
  }]}));
  assert.equal(row.intelligenceIndex,42);
  assert.equal(row.intelligenceIndexCostPerTask,0.42);
  assert.equal(row.price1mInputTokens,1);
  assert.equal(row.price1mOutputTokens,2);
  assert.equal(row.cacheHitPrice,null);
  assert.equal(row.cacheWritePrice,0.5);
  assert.equal(row.medianOutputTokensPerSecond,50);
  assert.equal(row.medianTimeToFirstTokenSeconds,0.3);
  assert.equal(row.codingIndex,null);
  assert.equal(row.agenticIndex,null);
});

test('public scores map only matching evaluations', () => {
  const html=JSON.stringify({initialModels:[{slug:'example',scores:{'terminalbench-4-0':0.5,scicode:0.6,'humanitys-last-exam':0.3,'artificial-analysis-long-context-reasoning':0.7,ifbench:0.8,'omniscience-accuracy':0.9,'omniscience-non-hallucination':0.95,'gdpval-aa-normalized':1328}}]});
  const [row]=parseAaLeaderboardHtml(html);
  assert.equal(row.terminalbenchV40,0.5);
  assert.equal(row.scicode,0.6);
  assert.equal(row.hle,0.3);
  assert.equal(row.lcr,0.7);
  assert.equal(row.ifbench,0.8);
  assert.equal(row.omniscienceAccuracy,0.9);
  assert.equal(row.omniscienceNonHallucination,0.95);
  assert.equal(row.gdpvalNormalized,null);
});

test('recorded public leaderboard includes nested benchmark scores', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./fixtures/aa-leaderboard-20261029.html', import.meta.url), 'utf8');
  const rows = parseAaLeaderboardHtml(html);
  assert.ok(rows.length > 0);
  assert.ok(rows.some(row => row.terminalbenchV40 != null));
  assert.ok(rows.some(row => row.scicode != null));
});


test('flat legacy cache prices survive normalization', () => {
  const {rows:[row]} = parseAaFreeList(JSON.stringify({data:[{slug:'legacy', cacheHitPrice:0.3, cacheWritePrice:0.9}]}));
  assert.equal(row.cacheHitPrice,0.3);
  assert.equal(row.cacheWritePrice,0.9);
});

test('recorded free pages preserve actual nested values and index version', async () => {
  const { readFile } = await import('node:fs/promises');
  let count = 0;
  for (let page=1; page<=4; page++) {
    const source=JSON.parse(await readFile(new URL(`./fixtures/aa-free-20261029-page-${page}.json`, import.meta.url),'utf8'));
    const parsed=parseAaFreeList(JSON.stringify(source));
    assert.equal(parsed.intelligenceIndexVersion, source.intelligence_index_version);
    assert.equal(parsed.rows.length, source.data.length);
    assert.equal(source.pagination.page,page);
    assert.equal(source.pagination.has_more,page<source.pagination.total_pages);
    const bySlug=new Map(parsed.rows.map(row=>[row.slug,row]));
    for (const original of source.data) {
      const row=bySlug.get(original.slug);
      assert.equal(row.intelligenceIndexCostPerTask, original.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ?? null);
      assert.equal(row.price1mInputTokens, original.pricing?.price_1m_input_tokens ?? null);
      assert.equal(row.price1mOutputTokens, original.pricing?.price_1m_output_tokens ?? null);
      assert.equal(row.cacheHitPrice, original.pricing?.price_1m_cache_hit_tokens ?? null);
      assert.equal(row.cacheWritePrice, original.pricing?.price_1m_cache_write_tokens ?? null);
      assert.equal(row.medianOutputTokensPerSecond, original.performance?.median_output_tokens_per_second ?? null);
      assert.equal(row.medianTimeToFirstTokenSeconds, original.performance?.median_time_to_first_token_seconds ?? null);
      assert.equal(row.medianTimeToFirstAnswerTokenSeconds, original.performance?.median_time_to_first_answer_token_seconds ?? null);
      assert.equal(row.medianEndToEndResponseTimeSeconds, original.performance?.median_end_to_end_response_time_seconds ?? null);
    }
    count += parsed.rows.length;
  }
  assert.equal(count,718);
});


test('recorded free pages pass complete fetch traversal and size bounds', async () => {
  const { readFile } = await import('node:fs/promises');
  const pages=await Promise.all([1,2,3,4].map(page => readFile(new URL(`./fixtures/aa-free-20261029-page-${page}.json`,import.meta.url),'utf8')));
  const requested=[];
  const result=await fetchAaFreeList({apiKey:'fixture-key',http:{fetch:async url => {
    const page=Number(new URL(url).searchParams.get('page')); requested.push(page);
    return {status:200,headers:{get:()=>null},text:async()=>pages[page-1]};
  }}});
  assert.equal(result.ok,true);
  assert.deepEqual(requested,[1,2,3,4]);
  assert.equal(result.pagesFetched,4);
  assert.equal(parseAaFreeList(result.text).rows.length,718);
});


test('recorded leaderboard maps every verified matching nested evaluation', async () => {
  const {readFile} = await import('node:fs/promises');
  const text = await readFile(new URL('./fixtures/aa-leaderboard-20261029.html', import.meta.url), 'utf8');
  const source = JSON.parse(text).initialModels;
  const rows = new Map(parseAaLeaderboardHtml(text).map(row => [row.slug,row]));
  const fields = {'gpqa-diamond':'gpqa', critpt:'critpt', 'tau2-bench':'tau2', 'tau3-banking':'tauBanking', 'terminalbench-hard':'terminalbenchHard', 'terminalbench-2-1':'terminalbenchV21', 'mmmu-pro':'mmmuPro', 'aa-analyst-agent':'analystAgent', 'itbench-aa':'itbenchSre'};
  for (const [key, field] of Object.entries(fields)) {
    const examples = source.filter(row => typeof row.scores?.[key] === 'number');
    assert.ok(examples.length > 0, `recorded fixture has ${key}`);
    for (const row of examples) assert.equal(rows.get(row.slug)[field], row.scores[key], `${row.slug} ${field}`);
  }
});
