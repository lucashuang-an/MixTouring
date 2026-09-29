/* 卡 C 行为回归：预算冲突、未知交通、多轮取舍、来源及私人状态隔离。 */
import assert from 'node:assert/strict';
import { compareSights, normalizeSightState, parseSightChange, sightCatalog } from './lib/sights.mjs';
import { parseGuideTurn } from './lib/guide.mjs';
let count = 0;
function check(value, label) {assert.ok(value,label);count++;console.log('✓ '+label);}
const four = compareSights();
check(four.status==='budget_conflict' && four.budget.visit_hours===24 && four.budget.available_hours===16,
  '四处完整游玩预算超过两天，不生成赶路时刻表');
check(four.options.length===3 && four.options.every((o)=>o.selected_ids.length===2 && o.evidence_state==='explore'),
  '冲突时给出有理由的两处组合，均为探索');
const two = compareSights({state:{selected_ids:['kalajun','xiata'],full_days:2},constraints:{no_self_drive:true}});
check(two.status==='transport_pending' && two.budget.travel_hours===null && two.no_self_drive,
  '删减到两处仍不假称无车接驳可执行');
check(two.comparisons.every((a)=>a.no_car_access==='unverified' && a.travel_time_hours===null),
  '路上时间和无车可达性未知，逐处列出核验问题');
check(two.warnings.some((s)=>s.includes('不开车')), '不开车限制贯穿比较');
const compressed = compareSights({state:{selected_ids:four.state.selected_ids,visit_hours:{nalati:1,kalajun:1,xiata:1,kuerdening:1}}});
check(compressed.status==='transport_pending' && compressed.warnings.some((s)=>s.includes('局部范围')),
  '压缩游玩预算不把未知交通升级成可完成');
check(compareSights({state:{selected_ids:[]}}).status==='empty','空选择诚实提示');
check(normalizeSightState(null).full_days===2 && normalizeSightState({full_days:99}).full_days===2,
  '无效预算输入不进入计算');
check(normalizeSightState({selected_ids:['nalati','nalati','月球景区']}).selected_ids.join()==='nalati',
  '景点来源只从服务端目录读取');
const source = sightCatalog(); source.attractions[0].source.url='https://example.org/fake';
check(sightCatalog().attractions[0].source.url.includes('gov.cn'),'客户端来源修改不污染目录');
const defaultState = normalizeSightState(); defaultState.selected_ids.pop();
const response = compareSights(); response.comparisons[0].source.url='https://example.org/fake';
check(normalizeSightState().selected_ids.length===4 && compareSights().comparisons[0].source.url.includes('gov.cn'),
  '比较响应与默认选择互不污染，后续请求仍读原始目录');
check(sightCatalog().attractions.length===7 && sightCatalog().attractions.every((a)=>a.source.evidence_state==='historical'),
  '七处景点保留原始来源和历史分级');
const mixed = parseSightChange('去掉那拉提，再加赛里木湖，伊犁有两个完整游玩日');
check(mixed.patch.remove_ids.join()==='nalati' && mixed.patch.add_ids.join()==='sayram' && mixed.patch.full_days===2,
  '同轮删减和追加分句处理，不把新增项误删');
const adjacent = parseSightChange('不去那拉提想去夏塔，再加那拉提');
check(adjacent.patch.add_ids.includes('xiata') && adjacent.patch.add_ids.includes('nalati') && !adjacent.patch.remove_ids?.includes('nalati'),
  '无标点增删也按动作边界处理，同景点以后一次意图为准');
const turn = parseGuideTurn('只保留夏塔和库尔德宁，我不会开车');
check(turn.recognized && turn.sights.selected_ids.length===2 && turn.constraints.no_self_drive,
  '对话确认景点取舍同时保留无车约束');
check(!parseSightChange('返程十月八日').patch.full_days,'交通日期不被当成游玩日');
const input = {state:{selected_ids:['nalati','xiata'],full_days:2},anchors:{outbound:{date:'2026-09-30'}},constraints:{lodging_stays:[{city:'伊宁',date:'2026-09-30'}]}};
const before = structuredClone(input); compareSights(input);
assert.deepEqual(input,before);check(true,'景点比较不改锚点、住宿或用户输入');
console.log('✓ 景点比较与时间预算回归通过（'+count+' 项）');
