import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelLine, buildAccountSupersession, isSupersededModel, isSupersededArm } from '../src/newest-version.mjs';

const parse = value => { const x = parseModelLine(value); return x && [x.product, x.version]; };
const view = (models, overrides = {}) => buildAccountSupersession({ models }, [], { overrides });

test('N-T01/T03/T04: product and version parsing retains distinct product lines and sizes', () => {
  for (const [id, product, version] of [
    ['claude-sonnet-5-5', 'claude-sonnet', [5, 5]], ['gemini-3.5-flash-lite', 'gemini-flash-lite', [3, 5]],
    ['gemini-3-flash', 'gemini-flash', [3]], ['deepseek-v4.1-flash-1017', 'deepseek-flash', [4, 1]],
    ['claude-haiku-4-5-20251001', 'claude-haiku', [4, 5]], ['gpt-oss-120b', 'gpt-oss-120b', null],
    ['kimi-k3-256k', 'kimi-k-256k', [3]], ['kimi-k3', 'kimi-k', [3]], ['qwen3.8-27b', 'qwen-27b', [3, 8]],
    ['nemotron-3-super-120b', 'nemotron-super-120b', [3]], ['nemotron-3.5-super-vl-free', 'nemotron-super-vl', [3,5]],
    ['muse-wonder-full-1.0-contributor', 'muse-wonder-full', [1,0]], ['ling-3.0-flash-fin-free', 'ling-flash-fin', [3,0]],
    ['mimo-v2.5-free', 'mimo', [2,5]], ['mimo-v2.6-flash-free', 'mimo-flash', [2,6]],
    ['step-5-preview-nim', 'step-preview-nim', [5]], ['step-5-preview-free', 'step-preview', [5]],
  ]) assert.deepEqual(parse(id), [product, version], id);
  assert.equal(parseModelLine(''), null);
  assert.equal(parseModelLine('123'), null);
});

test('N-T02/T02b: decoration peeling reaches a fixed point without stripping sole tokens', () => {
  for (const id of ['muse-spark-1.3-contributor-free', 'muse-spark-1.3-free-contributor']) {
    const result = parseModelLine(id);
    assert.deepEqual([result.product, result.version, result.channels, result.channel], ['muse-spark', [1,3], ['contributor','free'], 'contributor']);
  }
  for (const id of ['gemini-3.8-flash-high-free', 'gemini-3.8-flash-free-high']) {
    assert.deepEqual(parse(id), ['gemini-flash', [3,8]]);
    assert.deepEqual(parse({armId: id, effort:'high'}), ['gemini-flash', [3,8]]);
  }
  assert.deepEqual(parse('free'), ['free', null]);
  assert.deepEqual(parse('high'), ['high', null]);
  assert.deepEqual(parse('model-1m'), ['model-1m', null]);
  assert.deepEqual(parse({ model: 'vendor/gpt-6.1-sol', armId: 'gpt-6-1-sol-high', effort: 'high' }), ['gpt-sol', [6,1]]);
});

test('N-T06/T06b/T07/T07b/T08/T25: served universe, not score evidence, determines maxima per account', () => {
  const old = 'claude-sonnet-5', newest = 'claude-sonnet-5-5';
  const v = view([old, newest, 'claude-sonnet-5-5-high', 'gpt-oss-120b']);
  assert.deepEqual(v.supersededCanonicalModels, [old]);
  assert.equal(isSupersededModel(v, old), true);
  assert.equal(isSupersededModel(v, newest), false);
  assert.equal(isSupersededModel(v, 'gpt-oss-120b'), false);
  assert.equal(isSupersededModel(view([old]), old), false);
  assert.deepEqual(view([]).identities, {});
  const inferred = buildAccountSupersession({provider:'p'}, [{armId:'old', model: old, providers:['p']}, {armId:'new', model:newest, providers:['p']}], {});
  assert.equal(inferred.universeSource, 'inferred-provider-arms');
  assert.equal(isSupersededModel(inferred, old), true);
  assert.equal(isSupersededModel(null, old), false);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});

test('N-T05/T26: keep applies to the named scope, never to sibling efforts', () => {
  const models = ['claude-sonnet-5', 'claude-sonnet-5-5'];
  const high = {model:models[0], armId:'claude-sonnet-5@high', effort:'high'};
  const max = {model:models[0], armId:'claude-sonnet-5@max', effort:'max'};
  const scoped = view(models, {keep:['arm:claude-sonnet-5@max']});
  assert.equal(isSupersededArm(scoped, max), false);
  assert.equal(isSupersededArm(scoped, high), true);
  assert.equal(isSupersededModel(scoped, models[0]), true);
  for (const keep of ['model:claude-sonnet-5', 'claude-sonnet-5', 'product:claude-sonnet']) {
    const v = view(models, {keep:[keep]});
    assert.equal(isSupersededArm(v, max), false, keep);
    assert.equal(isSupersededArm(v, high), false, keep);
    assert.equal(isSupersededModel(v, models[0]), false, keep);
    assert.equal(v.verdicts[0].kept, true);
  }
});

test('N-T05: aliases and pins move only the specified identity, never the maximum from an arm pin', () => {
  const models = ['old-1', 'new-2'];
  const v = view(models, {productAliases:{new:'old'}, parsePins:{'old-1':{product:'old', version:[3]}}});
  assert.equal(isSupersededModel(v, 'new-2'), true);
  assert.equal(isSupersededModel(v, 'old-1'), false);
  const armPin = view(['model-1', 'model-2'], {parsePins:{'model-1@high':{product:'model',version:[3]}}});
  assert.equal(isSupersededArm(armPin, {armId:'model-1@high'}), false);
  assert.equal(isSupersededArm(armPin, {armId:'model-1@max'}), true);
  assert.deepEqual(armPin.byProduct.model.maxVersion, [2]);
});

test('N-T01/T01b: captured 54 arms and 67 served models match the documented fleet verdicts', async () => {
  const { readFile } = await import('node:fs/promises');
  const arms = JSON.parse(await readFile(new URL('./fixtures/newest-scored-20261029.json', import.meta.url)));
  const { accounts } = JSON.parse(await readFile(new URL('./fixtures/newest-served-20261029.json', import.meta.url)));
  const expected = [
    ['claude-fable',[5,1]], ['claude-haiku',[5,5]], ['claude-haiku',[5,5]], ['claude-opus',[5,5]], ['claude-opus',[5,5]],
    ['claude-sonnet',[5]], ['claude-sonnet',[5,5]], ['claude-sonnet',[5,5]], ['claude-sonnet',[5,5]],
    ['deepseek-flash',[4]], ['deepseek-flash',[4,1]], ['deepseek-flash',[4,1]], ['deepseek-flash',[4,1]],
    ['gemini-flash',[3]], ['gemini-flash-lite',[3,5]], ['gemini-flash',[3,8]], ['glm-flash',[4,7]], ['glm',[5,3]], ['glm-flash',[5,3]], ['glm-flash',[5,3]],
    ['gpt-terra',[5,6]], ['gpt-sol',[6,1]], ['gpt-sol',[6,1]], ['gpt-astra',[6]], ['gpt-astra',[6]], ['gpt-astra',[6]], ['gpt-astra',[6]], ['gpt-astra',[6]],
    ['gpt-luna',[6]], ['gpt-luna',[6]], ['gpt-luna',[6]], ['gpt-luna',[6]], ['gpt-luna',[6]], ['gpt-sol',[6]], ['gpt-terra',[6,1]],
    ['gpt-oss-120b',null], ['gpt-oss-120b',null], ['kimi-k',[3]], ['ling-flash-fin',[3,0]], ['ling-flash',[3,1]], ['mimo-flash',[2,6]], ['mistral-large',[4]],
    ['muse-spark',[1,3]], ['muse-spark',[1,3]], ['muse-spark',[1,1]], ['muse-spark',[1,2]], ['muse-spark',[1,3]], ['muse-wonder',[1,0]], ['muse-wonder-full',[1,0]],
    ['nemotron-super-120b',[3]], ['nemotron-lightning',[3,5]], ['nemotron-super-vl',[3,5]], ['qwen-27b',[3,8]], ['step-preview-nim',[5]],
  ];
  assert.equal(arms.length, 54);
  assert.equal(new Set(accounts.flatMap(a => a.models.map(m => m.split('/').at(-1).toLowerCase()))).size, 67);
  arms.forEach((arm, i) => {
    assert.deepEqual(parse(arm.armId), expected[i], arm.armId);
    assert.deepEqual(parse(arm), expected[i], arm.armId);
    assert.deepEqual(parse(arm.model), expected[i], arm.model);
  });
  const expectedByAccount = [
    ...Array(4).fill(['claude-haiku-4-5-20251001','claude-sonnet-5']),
    ['gpt-5.6-terra','gpt-6-sol'], ['gpt-5.6-terra'], ['gpt-5.6-terra','gpt-6-sol'], ['gpt-5.6-terra','gpt-6-sol'],
    ['gemini-3-flash','gemini-3.1-flash-lite'], ['gemini-3-flash','gemini-3.1-flash-lite'], [],
    ...Array(3).fill(['muse-spark-1.1','muse-spark-1.2']), [], ['glm-4.7-flash'], [],
    ['deepseek-v4-flash-free','muse-spark-1.2-contributor-free'],
  ];
  assert.equal(accounts.length, expectedByAccount.length);
  accounts.forEach((account, i) => {
    const v = buildAccountSupersession(account, arms, {});
    assert.deepEqual(v.supersededCanonicalModels, expectedByAccount[i], account.id);
    for (const group of Object.values(v.byProduct)) for (const model of group.membersAtMax) assert.equal(isSupersededModel(v, model), false);
  });
});

test('N-T01b/T07b: documented unscored served identities have correct parse and build evidence', () => {
  for (const [model, product, version] of [
    ['claude-haiku-4-5-20251001','claude-haiku',[4,5]], ['codex-auto-review','codex-auto-review',null],
    ['gemini-3.1-flash-lite','gemini-flash-lite',[3,1]], ['muse-canary','muse-canary',null],
    ['muse-wonder-1.0','muse-wonder',[1,0]], ['muse-wonder-full-1.0','muse-wonder-full',[1,0]],
    ['beam-free','beam',null], ['big-pickle','big-pickle',null], ['cat-jam-free','cat-jam',null],
    ['exo-free','exo',null], ['fledge-alpha-free','fledge-alpha',null], ['jev-1.13','jev',[1,13]],
    ['jev-1.13-free','jev',[1,13]], ['ll-alpha-free','ll-alpha',null], ['longcat-2.5-preview-free','longcat-preview',[2,5]],
    ['mimo-v2.5-free','mimo',[2,5]], ['muse-spark-1.2-contributor-free','muse-spark',[1,2]],
    ['muse-spark-1.3-contributor-free','muse-spark',[1,3]], ['nemotron-3-ultra-free','nemotron-ultra',[3]],
    ['space-bunny-free','space-bunny',null], ['step-5-preview-free','step-preview',[5]], ['union-alpha','union-alpha',null],
  ]) assert.deepEqual(parse(model), [product,version], model);
  assert.equal(parseModelLine('claude-haiku-4-5-20251001').build, 20251001);
  assert.equal(parseModelLine('deepseek-v4.1-flash-1017').build, 1017);
});

test('N-T05: arm-scoped legacy keep and task keep do not protect distinct representations', () => {
  const v = view(['old-1','old-2'], {keep:['arm:legacy-max','old-1@high']});
  assert.equal(isSupersededArm(v, {model:'old-1',armId:'legacy-max',effort:'max'}), false);
  assert.equal(isSupersededArm(v, {model:'old-1',armId:'legacy-other',effort:'max'}), true);
  assert.equal(isSupersededArm(v, {model:'old-1',armId:'legacy-other',effort:'high'}), false);
  assert.equal(isSupersededArm(v, {model:'old-1',armId:'old-1@max',effort:'max'}), true);
  assert.deepEqual(v.supersededCanonicalModels, ['old-1']);
});

test('N-T26: model and product keeps protect every string and object dialect', () => {
  const models = ['claude-sonnet-5', 'claude-sonnet-6'];
  const forms = ['claude-sonnet-5', 'claude-sonnet-5@max',
    {armId:'claude-sonnet-5@max'}, {model:'claude-sonnet-5', armId:'legacy-max', legacyArmIds:['legacy-policy'], effort:'max'}];
  for (const keep of ['claude-sonnet-5', 'model:claude-sonnet-5', 'product:claude-sonnet']) {
    const v = view(models, {keep:[keep]});
    for (const arm of forms) assert.equal(isSupersededArm(v, arm), false, `${keep}: ${JSON.stringify(arm)}`);
  }
  const unkept = view(models);
  for (const arm of forms) assert.equal(isSupersededArm(unkept, arm), true, JSON.stringify(arm));
});

test('N-T26: legacy policy aliases and task keeps protect only matching arm representations', () => {
  const models = ['old-1', 'old-2'];
  const policy = {model:'old-1', armId:'policy', legacyArmIds:['legacy-max'], effort:'max'};
  for (const keep of ['legacy-max', 'arm:legacy-max', 'old-1@max', 'arm:old-1@max']) {
    const v = view(models, {keep:[keep]});
    assert.equal(isSupersededArm(v, policy), false, keep);
    assert.equal(isSupersededArm(v, {model:'old-1',armId:'other',effort:'high'}), true, keep);
    assert.equal(isSupersededModel(v, 'old-1'), true, keep);
  }
  for (const keep of ['old-1@max', 'arm:old-1@max']) {
    const v = view(models, {keep:[keep]});
    assert.equal(isSupersededArm(v, 'old-1@max'), false);
    assert.equal(isSupersededArm(v, 'old-1@high'), true);
    assert.equal(isSupersededArm(v, 'old-1'), true);
  }
});

test('N-T05: task-only identities inherit model aliases and model pins', () => {
  const aliased = view(['old-1', 'new-2'], {productAliases:{old:'new'}});
  assert.equal(isSupersededArm(aliased, 'old-1@max'), true);
  assert.equal(isSupersededArm(aliased, {model:'old-1',armId:'old-1@max'}), true);
  const pinned = view(['old-1', 'new-2'], {parsePins:{'model:old-1':{product:'new',version:[1]}}});
  assert.equal(isSupersededArm(pinned, 'old-1@max'), true);
  assert.equal(isSupersededArm(pinned, {model:'old-1',armId:'old-1@max'}), true);
});

test('N-T05: competing arm pins honor task, legacy, then canonical precedence', () => {
  const v = view(['old-1', 'old-2'], {parsePins:{
    'old-1@max':{product:'old',version:[1]},
    'legacy':{product:'old',version:[3]},
    'old-1':{product:'old',version:[3]},
  }});
  assert.equal(isSupersededArm(v, {armId:'old-1@max',legacyArmIds:['legacy']}), true);
  assert.equal(isSupersededArm(v, {armId:'old-1@high',legacyArmIds:['legacy']}), false);
  assert.equal(isSupersededArm(v, 'old-1@high'), false);
  assert.deepEqual(v.byProduct.old.maxVersion, [3]);
});

test('N-T05: malformed overrides fail open without throwing or creating a superseder', () => {
  const v = view(['old-1', 'old-2'], {keep:[null, 42, {}], productAliases:{old:42},
    parsePins:{'old-1':{product:'old',version:[-1]}, 'old-1@max':{product:'old',version:['3']}}});
  assert.equal(isSupersededModel(v, 'old-1'), true);
  assert.equal(isSupersededArm(v, 'old-1@max'), true);
  assert.deepEqual(v.byProduct.old.maxVersion, [2]);
  assert.deepEqual(v.overrides.keep, []);
});

test('N-T02/T02b: nested provider decorations and repeated effort-channel suffixes parse on all paths', () => {
  for (const raw of ['vendor/sub/claude-haiku-5-5(max)[1m]', 'vendor/sub/claude-haiku-5-5(xhigh)']) {
    for (const input of [raw, {model:raw}, {armId:raw}]) assert.deepEqual(parse(input), ['claude-haiku',[5,5]]);
  }
  for (const input of ['x-1-high-free-max', {armId:'x-1-high-free-max',effort:'max'}, {model:'x-1-high-free-max'}]) {
    const parsed = parseModelLine(input);
    assert.deepEqual([parsed.product, parsed.version, parsed.channels], ['x',[1],['free']]);
  }
  const v = view(['x-1-high-free-max']);
  assert.deepEqual([v.identities['x-1-high-free-max'].product,v.identities['x-1-high-free-max'].version,v.identities['x-1-high-free-max'].channels], ['x',[1],['free']]);
});

test('N-T04: build tokens and distinct Kimi products survive in a shared view', () => {
  const parsed = parseModelLine('claude-sonnet-4-5-20250929');
  assert.deepEqual([parsed.product, parsed.version, parsed.build], ['claude-sonnet',[4,5],20250929]);
  for (const value of [null, undefined, 123, false, {}, []]) assert.equal(parseModelLine(value), null);
  const v = view(['kimi-k3', 'kimi-k3-256k']);
  for (const model of ['kimi-k3','kimi-k3-256k']) assert.equal(isSupersededModel(v, model), false);
  assert.deepEqual(v.supersededCanonicalModels, []);
});

test('N-T06: equal version build and channel siblings survive together', () => {
  const models = ['model-1', 'model-2-20250929', 'model-2-20251001', 'model-2-free', 'model-2-contributor'];
  const v = view(models);
  assert.deepEqual(v.supersededCanonicalModels, ['model-1']);
  assert.deepEqual(v.byProduct.model.membersAtMax, models.slice(1).sort());
  for (const model of models.slice(1)) assert.equal(isSupersededModel(v, model), false, model);
});

test('N-T01b: every raw served model agrees across string, object and account identity paths', async () => {
  const {readFile} = await import('node:fs/promises');
  const {accounts} = JSON.parse(await readFile(new URL('./fixtures/newest-served-20261029.json', import.meta.url)));
  const unique = new Set();
  for (const account of accounts) {
    const v = buildAccountSupersession(account, [], {});
    for (const model of account.models) {
      const key = model.split('/').at(-1).toLowerCase();
      unique.add(key);
      const a = parseModelLine(model), b = parseModelLine({model,armId:`${key}@max`,effort:'max'});
      assert.deepEqual([b?.product,b?.version,b?.channels], [a?.product,a?.version,a?.channels], model);
      const identity = v.identities[key];
      assert.deepEqual([identity.product,identity.version,identity.channels], [a?.product,a?.version,a?.channels], model);
    }
  }
  assert.equal(unique.size, 67);
});

test('N-T26: legacy arm-only effort suffix uses canonical model for keeps, aliases and pins', () => {
  for (const keep of ['old-1', 'model:old-1']) {
    const v = view(['old-1','old-2'], {keep:[keep]});
    for (const arm of ['old-1-high', {armId:'old-1-high'}]) assert.equal(isSupersededArm(v, arm), false, keep);
  }
  const aliased = view(['old-1','new-2'], {productAliases:{old:'new'}});
  assert.equal(isSupersededArm(aliased, 'old-1-high'), true);
  const pinned = view(['old-1','new-2'], {parsePins:{'model:old-1':{product:'new',version:[1]}}});
  assert.equal(isSupersededArm(pinned, 'old-1-high'), true);
  const armKeep = view(['old-1','old-2'], {keep:['arm:old-1-max']});
  assert.equal(isSupersededArm(armKeep, 'old-1-max'), false);
  assert.equal(isSupersededArm(armKeep, 'old-1-high'), true);
});

test('N-T02: ultra is a product word unless explicitly the arm effort', () => {
  assert.deepEqual(parse('nemotron-3-ultra-free'), ['nemotron-ultra',[3]]);
  assert.deepEqual(parse({armId:'nemotron-3-ultra',effort:'ultra'}), ['nemotron',[3]]);
  assert.deepEqual(parse('nemotron-3-ultra'), ['nemotron-ultra',[3]]);
});

test('N-T04: product names matching object prototype properties are safe identities', () => {
  const v = view(['constructor-1', 'constructor-2', 'toString-1']);
  assert.deepEqual(v.supersededCanonicalModels, ['constructor-1']);
  assert.equal(isSupersededModel(v, 'constructor-1'), true);
  assert.equal(isSupersededModel(v, 'tostring-1'), false);
});
