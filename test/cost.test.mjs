import test from 'node:test';
import assert from 'node:assert/strict';
import { costProfile, fillCosts } from '../src/cost.mjs';

test('profile is the median effective MTok-per-task over complete arms', () => {
  // cost/(in+out): 1/4 = 0.25, 2/8 = 0.25, 3/8 = 0.375 -> median 0.25.
  const entries = [
    { armId: 'cheap', cost: 1.0, priceIn: 1, priceOut: 3 },
    { armId: 'mid', cost: 2.0, priceIn: 2, priceOut: 6 },
    { armId: 'rich', cost: 3.0, priceIn: 2, priceOut: 6 },
  ];
  assert.equal(costProfile(entries), 0.25);
  assert.equal(costProfile([]), null);
  assert.equal(costProfile([{ armId: 'x', cost: null, priceIn: 1, priceOut: 1 }]), null);
});

test('measured costs are kept; missing costs estimate from prices', () => {
  const filled = fillCosts([
    { armId: 'measured', cost: 1.0, priceIn: 1, priceOut: 3 },
    { armId: 'estimated', cost: null, priceIn: 4, priceOut: 4 },
    { armId: 'priceless', cost: null, priceIn: null, priceOut: null },
  ]);
  assert.deepEqual(filled.get('measured'), { C: 1.0, estimated: false });
  assert.deepEqual(filled.get('estimated'), { C: 0.25 * 8, estimated: true });
  assert.deepEqual(filled.get('priceless'), { C: null, estimated: false });
});

test('no profile without a complete arm: everything missing stays null', () => {
  const filled = fillCosts([
    { armId: 'a', cost: null, priceIn: 1, priceOut: 1 },
    { armId: 'b', cost: null, priceIn: 2, priceOut: 2 },
  ]);
  assert.equal(filled.get('a').C, null);
  assert.equal(filled.get('b').C, null);
});

test('non-positive costs and prices never seed the profile', () => {
  assert.equal(costProfile([{ armId: 'z', cost: 0, priceIn: 1, priceOut: 1 }]), null);
  const filled = fillCosts([
    { armId: 'good', cost: 2.0, priceIn: 2, priceOut: 6 },
    { armId: 'free', cost: null, priceIn: 0, priceOut: 0 },
  ]);
  assert.equal(filled.get('free').C, null);
});
