/* 灵感复用保留结构，但不继承历史价格、日期或已核事实。 */
import assert from 'node:assert/strict';
import { listInspirations, inspirationFor } from './lib/inspirations.mjs';
import { planAnywhere } from './lib/anywhere.mjs';
import { buildJourneyDetail } from './lib/journey.mjs';
const items = listInspirations();
assert.equal(items.filter((r) => r.scope === 'international').length, 3);
assert.equal(items.filter((r) => r.scope === 'domestic').length, 6);
for (const item of items) {
  assert.equal(item.modes.length, item.stops.length - 1);
  assert.ok(!/"(?:price|depart|arrive|service_no|saved)"/.test(JSON.stringify(item)));
  const plan = await planAnywhere({ origin: item.from, destination: item.to, inspiration_id: item.id }, { env: {}, callJson: async () => null });
  const chosen = plan.candidates.find((c) => c.inspiration_id === item.id);
  assert.ok(chosen, item.id + '保留所选灵感');
  assert.deepEqual(chosen.legs.map((l) => l.from).concat(chosen.legs.at(-1).to), item.stops);
  assert.deepEqual(chosen.legs.map((l) => l.mode_guess), item.modes);
  assert.equal(plan.intent.outbound_window, null);
  const detail = buildJourneyDetail(plan, chosen.id, 1);
  assert.equal(detail.evidence_state, 'explore');
  assert.equal(detail.cost.known_total, null);
  assert.equal(detail.stopover.city, item.stops[1]);
}
assert.equal(inspirationFor('tpl-001', '上海', '昆明'), null);
const capped = await planAnywhere({ origin: '北京', destination: '喀什', inspiration_id: 'tpl-001', constraints: { max_transfers: 0 } }, { env: {}, callJson: async () => null });
assert.ok(capped.candidates.every((c) => c.transfers === 0), '灵感不越过用户明确限制');
console.log('✓ 国内与国际灵感：结构、方式、证据边界、日期隔离、停留详情与硬约束通过');
