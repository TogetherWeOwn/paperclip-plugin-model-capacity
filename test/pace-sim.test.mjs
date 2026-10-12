import test from 'node:test';
import assert from 'node:assert/strict';
import { orderAccountsWithPacing } from '../src/select.mjs';

// Deterministic week-long simulation of single-provider fleets, driven by
// the same ordering the plugin uses. A pool of equal lanes shares one
// credential bucket; a run burns E (a fraction of ONE lane's weekly quota,
// the plugin's per-run burn) spread over D hours and over the lanes. Work is
// always queued (demand exceeds what the plan allows), so the only brake on
// spend is the plugin and the host's own concurrency caps.
//
// Each step builds the lane views the way the plugin's tick does: required
// rate = remaining / hours to reset, target share = required / E, plan
// position = used - elapsed. A lane drops out of rotation when its weekly
// remainder reaches the exhaustion floor (1%), as in the tick.

const WEEK_H = 168;
const STEP_H = 1 / 12;
const GUARD = { enabled: true, marginPct: 0.02 };

function simulate({ lanes, E, D, lambda, guard, hostFactor }) {
  const used = new Array(lanes).fill(0);
  const finishAt = [];
  let queue = 0;
  let carry = 0;
  let started = 0;
  let firstOutAtH = null;
  let maxLead = -Infinity;
  let maxLag = Infinity;
  const dayEnd = [];
  const pacing = guard ? { ...guard, meanRunDurationHours: D } : null;
  for (let step = 0; step < WEEK_H / STEP_H; step++) {
    const t = step * STEP_H;
    for (let i = finishAt.length - 1; i >= 0; i--) if (finishAt[i] <= t + 1e-9) finishAt.splice(i, 1);
    carry += lambda * STEP_H;
    const arrived = Math.floor(carry);
    carry -= arrived;
    queue += arrived;
    const hoursToReset = Math.max(WEEK_H - t, 0.25);
    const sharesOf = () => used.map(u => Math.max(0, 1 - u) / hoursToReset / E);
    // The host admits up to hostFactor x the paced target (the plugin's
    // concurrency target is the sum of the lanes' slots).
    const hostCap = Math.max(1, Math.ceil(sharesOf().reduce((s, x) => s + x, 0) * D * hostFactor - 1e-9));
    while (queue > 0 && finishAt.length < hostCap) {
      const views = used.map((u, i) => {
        const remaining = Math.max(0, 1 - u);
        return {
          accountId: `fleet:${i}`, pool: 'fleet', health: 'healthy',
          headroomPct: remaining <= 0.01 ? remaining : 1,
          resetAtMs: WEEK_H, measuredRatePerHour: null,
          requiredRatePerHour: remaining / hoursToReset,
          targetShare: remaining > 0 ? remaining / hoursToReset / E : null,
          inFlight: finishAt.length, laneInFlight: 0,
          planAhead: u - t / WEEK_H,
        };
      });
      if (orderAccountsWithPacing(views, { pacing }).order.length === 0) break;
      finishAt.push(t + D);
      queue -= 1;
      started += 1;
    }
    const burn = finishAt.length * (E / D) * STEP_H / lanes;
    for (let i = 0; i < lanes; i++) used[i] = Math.min(1, used[i] + burn);
    const mean = used.reduce((s, x) => s + x, 0) / lanes;
    const lead = mean - (t + STEP_H) / WEEK_H;
    maxLead = Math.max(maxLead, lead);
    maxLag = Math.min(maxLag, lead);
    if (firstOutAtH == null && used.every(u => 1 - u <= 0.01)) firstOutAtH = t + STEP_H;
    if ((step + 1) % (24 / STEP_H) === 0) dayEnd.push(mean);
  }
  const final = used.reduce((s, x) => s + x, 0) / lanes;
  return { final, firstOutAtH, maxLead, maxLag, dayEnd, started };
}

// Demand is well above what the weekly plan allows for each fleet.
const FLEETS = {
  claude: { lanes: 3, E: 0.004, D: 0.5, lambda: 12 },
  codex: { lanes: 2, E: 0.0015, D: 0.25, lambda: 20 },
  meta: { lanes: 1, E: 0.0008, D: 0.15, lambda: 15 },
};

for (const [name, fleet] of Object.entries(FLEETS)) {
  test(`${name}-only fleet with loose host caps (3x the target): spends evenly to the reset`, () => {
    const r = simulate({ ...fleet, guard: GUARD, hostFactor: 3 });
    assert.ok(r.firstOutAtH == null || r.firstOutAtH >= 156,
      `no lane leaves rotation before the last 12h, left at ${r.firstOutAtH?.toFixed(1)}h`);
    assert.ok(r.final >= 0.98, `the week is used, not wasted: ${r.final.toFixed(3)}`);
    assert.ok(r.maxLead <= 0.10, `never more than 10 points ahead of plan: ${r.maxLead.toFixed(3)}`);
    assert.ok(r.maxLag >= -0.02, `never more than 2 points behind plan: ${r.maxLag.toFixed(3)}`);
    r.dayEnd.forEach((used, i) => {
      const plan = (i + 1) / 7;
      assert.ok(used >= plan - 0.02 && used <= plan + 0.10, `day ${i + 1}: used ${used.toFixed(3)} vs plan ${plan.toFixed(3)}`);
    });
  });

  test(`${name}-only fleet: without the guard the same host runs dry days early`, () => {
    const r = simulate({ ...fleet, guard: null, hostFactor: 3 });
    assert.ok(r.firstOutAtH != null && r.firstOutAtH < 120,
      `unguarded, the lanes are out of quota at ${r.firstOutAtH?.toFixed(1)}h of 168h`);
    assert.ok(r.maxLead > 0.3, `and run ${r.maxLead.toFixed(2)} of the week ahead of plan`);
  });

  test(`${name}-only fleet: when the host caps already hold the target, the guard changes nothing`, () => {
    const on = simulate({ ...fleet, guard: GUARD, hostFactor: 1 });
    const off = simulate({ ...fleet, guard: null, hostFactor: 1 });
    assert.deepEqual(on.dayEnd, off.dayEnd);
    assert.equal(on.started, off.started);
    assert.ok(on.firstOutAtH >= 156 && on.final >= 0.98, 'and that is already an even spend');
  });
}

test('a pool behind plan is not throttled: the guard only acts above plan plus margin', () => {
  // Demand is a trickle: far below the plan, so spend never reaches it.
  const r = simulate({ lanes: 2, E: 0.0015, D: 0.25, lambda: 1, guard: GUARD, hostFactor: 3 });
  const off = simulate({ lanes: 2, E: 0.0015, D: 0.25, lambda: 1, guard: null, hostFactor: 3 });
  assert.equal(r.started, off.started, 'every run that arrived was admitted');
  assert.ok(r.maxLead < 0, 'and the pool stayed behind plan throughout');
});
