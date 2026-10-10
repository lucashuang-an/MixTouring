/* G3：探索详情、可选停留和服务端候选信任边界。 */
import { strict as assert } from 'node:assert';
import { planAnywhere } from './lib/anywhere.mjs';
import { buildJourneyDetail, registerJourneyPlan, journeyDetailFromPlanId } from './lib/journey.mjs';
import taskPreview from '../mixtouring-hifi/assets/task-preview.js';

const task={request:{origin:'北京',destination:'阿拉木图'},place_names:{origin:'北京',destination:'阿拉木图'},
  travel:{trip_type:'round_trip'},anchors:{outbound:{from_city:'北京',to_city:'伊宁',date:'2026-09-30',arrive_date:'2026-09-30'},
    return:{from_city:'乌鲁木齐',to_city:'北京',date:'2026-10-08',depart_time:'21:00'}},
  constraints:{no_self_drive:true,lodging_stays:[{date:'2026-09-30',city:'伊宁'}]},
  candidate:{legs:[{from:'伊宁',to:'阿拉木图',mode_guess:'road'}]},sights:{selected_ids:['xiata'],play_window:'2026-10-01 ~ 2026-10-02'}};
const original=JSON.stringify(task), preview=taskPreview.derive(task,[{id:'xiata',name:'夏塔'}]);
assert.equal(preview.route,'伊宁 → 阿拉木图');
assert.equal(preview.sights[0],'夏塔');
assert.ok(preview.dates.some(r=>r.label==='住 伊宁'));
assert.ok(preview.dates.find(r=>r.label.startsWith('去程')).note.includes('时刻待补'));
assert.ok(preview.pending.some(n=>n.includes('阿拉木图 → 乌鲁木齐')));
assert.equal(preview.executable,false);
assert.equal(JSON.stringify(task),original,'草案预览不改变当前条件');
const restored=taskPreview.derive(JSON.parse(JSON.stringify(task)),[{id:'xiata',name:'夏塔'}]);
assert.deepEqual(restored,preview,'私人版本保存再读取派生同一预览');
assert.equal(taskPreview.derive({request:{origin:'上海',destination:'昆明'},sights:{selected_ids:[]}}).dates.length,0,'没有日期不生成精确逐日安排');
const scheduled=structuredClone(task);scheduled.sights.visit_dates={xiata:'2026-10-01'};
assert.ok(taskPreview.derive(scheduled,[{id:'xiata',name:'夏塔'}]).dates.some(r=>r.date==='2026-10-01' && r.label==='游玩 夏塔'));
assert.deepEqual(taskPreview.affected(task,scheduled),['2026-10-01']);
const changed=structuredClone(scheduled);changed.sights.visit_dates.xiata='2026-10-02';
assert.deepEqual(taskPreview.affected(scheduled,changed),['2026-10-01','2026-10-02']);

const deps = { callJson: async () => null, env: {}, searchWeb: null, webSearchStatus: () => ({ status: 'unavailable' }) };
const plan = await planAnywhere({
  origin: '北京', destination: '阿拉木图',
  travel: { trip_type: 'round_trip', outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1 }
}, deps);
const mixed = plan.candidates.find((c) => c.kind === 'mixed');
assert.ok(mixed, '北京→阿拉木图应有可探索的混合方向');
const detail = buildJourneyDetail(plan, mixed.id, 2);
const anchored={...plan,anchors:{return:{mode:'plane',from_city:'乌鲁木齐',to_city:'北京',date:'2026-10-22'}}};
const withReturn=buildJourneyDetail(anchored,mixed.id,2);
assert.equal(withReturn.inbound.at(-1).to,'乌鲁木齐','返程接驳接到锁定出发城');
assert.equal(withReturn.return_anchor.from_city,'乌鲁木齐');
assert.equal(withReturn.transport_references.find(r=>r.direction==='inbound').references.find(r=>r.id==='ala-urc-cz6076').date_scope,'unverified','返程航班日不代替接驳日期');
assert.equal(detail.evidence_state, 'explore');
assert.equal(detail.outbound.length, 2);
assert.equal(detail.outbound[0].to, detail.outbound[1].from, '停留前后两段必须连续');
assert.equal(detail.stopover.city, detail.outbound[0].to);
assert.equal(detail.stopover.nights, 2);
assert.equal(detail.inbound.length, 1, '往返须独立生成返程探索方向');
assert.equal(detail.inbound[0].from, '阿拉木图');
assert.equal(detail.inbound[0].to, '北京');
assert.equal(detail.inbound[0].evidence_state, 'explore', '返程不能套用去程证据');
assert.equal(detail.checklist.length, 3, '去程两段与返程一段都应列入核验清单');
assert.ok(!detail.checklist[0].missing.includes('出入境条件'), '北京→乌鲁木齐国内段不得提示入境');
assert.ok(detail.checklist[1].missing.includes('出入境条件'), '乌鲁木齐→阿拉木图跨境段须提示出入境');
assert.equal(detail.cost.known_total, null, '无证据不得给已知总额');
assert.ok(detail.cost.unknown_items.some((item) => item.includes('住宿')));
assert.ok(detail.warnings.some((item) => item.includes('后半程')));
const plain = buildJourneyDetail(plan, mixed.id, 0);
assert.equal(plain.stopover, null);
assert.ok(!plain.cost.unknown_items.some((item) => item.includes('住宿')));
assert.throws(() => buildJourneyDetail(plan, mixed.id, 3), /仅支持/);
assert.throws(() => buildJourneyDetail(plan, '伪造候选', 0), /不在本次规划/);
assert.throws(() => buildJourneyDetail(plan, plan.candidates.find((c) => c.kind === 'direct').id, 1), /没有中途城市/);

const id = registerJourneyPlan(plan, 1000);
assert.equal(journeyDetailFromPlanId(id, mixed.id, 1, 1001).stopover.nights, 1);
assert.throws(() => journeyDetailFromPlanId(id, mixed.id, 1, 1000 + 30 * 60 * 1000), /已失效/);

const oneWay = await planAnywhere({ origin: '北京', destination: '喀什', travel: { trip_type: 'one_way' } }, deps);
const oneDetail = buildJourneyDetail(oneWay, oneWay.candidates[0].id, 0);
assert.equal(oneDetail.inbound.length, 0);
assert.equal(oneDetail.return_window, null);
assert.ok(oneDetail.checklist.every((row) => !row.missing.includes('出入境条件')), '国内单程不得提示入境');
console.log('✓ G3 探索详情：去返独立、停留后半程、未知费用、候选存证与过期边界');
