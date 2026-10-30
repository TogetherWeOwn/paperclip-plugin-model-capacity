import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, OPUS, config, lane, rows, drive, assertDeferred } from './weekly-compatibility-fixture.mjs';

const SOL = 'gpt-6.1-sol';
const models = [
  { provider: 'claude', model: OPUS },
  { provider: 'codex', model: SOL },
];

async function fixture(mode, provider, model, { held = true, burn = false, enforce = true } = {}) {
  const raw = config(mode);
  raw.enforce = enforce;
  raw.credentialReadiness.enforce = false;
  if (burn) raw.burnMode = { accounts: [`${provider}:ahead`] };
  return drive({ raw, demand: [{ agentId: 'fixed', queued: 4 }],
    aaRows: [...rows(), { ...rows()[0], slug: 'gpt-6-1-sol-high', intelligenceIndex: 61,
      intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 10 }],
    accounts: [lane('ahead', held ? .85 : .3, held ? 120 : 84, { provider, models: [model] }),
      lane('safe', .3, 84, { provider, models: [model] })] });
}

function assertSafeDefault(decision, model) {
  if (model === OPUS) assert.deepEqual(decision, { kind: 'keep' });
  else {
    assert.equal(decision.kind, 'decide');
    assert.equal(decision.model, SOL);
    assert.deepEqual(decision.env, {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '890000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '870000',
    });
    assert.equal(decision.effort, undefined, 'the configured effort stays with the host');
  }
}

for (const mode of ['off', 'shadow', 'enforce']) {
  for (const { provider, model } of models) {
    for (const held of [false, true]) {
      test(`pinned default cannot emit through an ambiguous held route (${mode}, ${provider}, held=${held})`, async () => {
        const d = await fixture(mode, provider, model, { held });
        await d.tick();
        const runId = `pinned-guard-${mode}-${provider}-${held}`;
        const decision = await d.hook(runId, { agentId: 'fixed', agentDefaultModel: model });
        if (!held) return assertSafeDefault(decision, model);
        assertDeferred(decision);
        assert.equal(decision.retryAfterMs, 300000);
        assert.match(decision.reason, /^weekly hold: pinned emission can reach a held credential$/);
        assert.equal(decision.env, undefined, 'a context cap must not turn a refusal into an emission');
        await d.fire(runId, 'fixed', { provider });
        await d.tick();
        const entry = (await d.shadow()).entries.find(row => row.runId === runId);
        assert.equal(entry?.wouldModel, undefined, 'a delayed event cannot revive the deferred emission');
        assert.equal(entry?.accountId, undefined);
      });
    }
  }

  for (const authority of ['enforce-off', 'unknown-company', 'issue-override']) {
    test(`weekly default guards preserve explicit ${authority} authority (${mode})`, async () => {
      const d = await fixture(mode, 'claude', OPUS, { enforce: authority !== 'enforce-off' });
      await d.tick();
      assert.ok((await d.capacity()).paceGuard.rawPools.some(pool => pool.hardHeldAccountIds?.includes('claude:ahead')),
        'the fixture really contains an ordinary weekly-held credential');
      const extra = { agentId: 'fixed', agentDefaultModel: OPUS,
        ...(authority === 'unknown-company' ? { companyId: 'another-company' } : {}),
        ...(authority === 'issue-override' ? { issueOverrideModel: OPUS } : {}) };
      assert.deepEqual(await d.hook(`authority-${mode}-${authority}`, extra), { kind: 'keep' });
    });
  }
}

// Enforced ranking rejects stale admission evidence earlier. These isolate the
// readiness-disabled legacy stale fallback without weakening that earlier gate.
for (const mode of ['off', 'shadow']) {
  for (const { provider, model } of models) {
    for (const held of [false, true]) {
      test(`stale default cannot fall back through an ambiguous held route (${mode}, ${provider}, held=${held})`, async () => {
        const d = await fixture(mode, provider, model, { held });
        await d.tick();
        d.setNow(NOW + 121000);
        const decision = await d.hook(`stale-guard-${mode}-${provider}-${held}`, { agentDefaultModel: model });
        if (!held) return assertSafeDefault(decision, model);
        assertDeferred(decision);
        assert.equal(decision.retryAfterMs, 300000);
        assert.match(decision.reason, /^weekly hold: stale default emission can reach a held credential$/);
        assert.equal(decision.env, undefined);
      });
    }
  }
}

for (const { provider, model } of models) {
  for (const stale of [false, true]) {
    test(`default guards preserve an explicitly burn-exempt route (${provider}, stale=${stale})`, async () => {
      const d = await fixture('off', provider, model, { burn: true });
      await d.tick();
      const capacity = await d.capacity();
      const ahead = capacity.accounts.find(account => account.accountId === `${provider}:ahead`);
      assert.equal(ahead.burnMode, true);
      assert.ok(capacity.paceGuard.rawPools.some(pool => pool.burnAccountIds?.includes(`${provider}:ahead`)));
      if (stale) d.setNow(NOW + 121000);
      assertSafeDefault(await d.hook(`burn-default-${provider}-${stale}`, {
        agentId: stale ? 'doer' : 'fixed', agentDefaultModel: model,
      }), model);
    });
  }
}
