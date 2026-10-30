import test from 'node:test';
import assert from 'node:assert/strict';
import { accountKeyForModel } from '../src/ledger.mjs';

const registry = [{accountKey:'one',prefix:'lane1'}, {accountKey:'two',prefix:'lane10'}];
test('router model attribution uses the exact first segment without guessing', () => {
  assert.equal(accountKeyForModel('lane1/model',registry),'one');
  assert.equal(accountKeyForModel('lane10/model',registry),'two');
  assert.equal(accountKeyForModel('lane/model',registry),null);
  assert.equal(accountKeyForModel('model',registry),null);
  assert.equal(accountKeyForModel('lane1/',registry),null);
  assert.equal(accountKeyForModel(null,registry),null);
});
