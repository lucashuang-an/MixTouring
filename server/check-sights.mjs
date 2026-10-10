/* 卡 C 行为回归：预算冲突、未知交通、多轮取舍、来源及私人状态隔离。 */
import assert from 'node:assert/strict';
import { compareSights, normalizeSightState, parseSightChange, sightCatalog } from './lib/sights.mjs';
import { parseGuideTurn } from './lib/guide.mjs';
import { sightAccess, validAccessReference } from './lib/sight-access.mjs';
import { transportReferences, validTransportReference, validSchedule } from './lib/transport-references.mjs';
let count = 0;
function check(value, label) {assert.ok(value,label);count++;console.log('✓ '+label);}
const fourState={selected_ids:['nalati','kalajun','xiata','kuerdening']};
const four = compareSights({state:fourState});
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
const response = compareSights({state:fourState}); response.comparisons[0].source.url='https://example.org/fake';
check(normalizeSightState().selected_ids.length===0 && compareSights({state:fourState}).comparisons[0].source.url.includes('gov.cn'),
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
const fixedNow=Date.parse('2026-10-09T04:00:00Z');
check(compareSights().status==='empty' && compareSights().budget.visit_hours===0,'默认未选景点，不替用户制造预算冲突');
check(compareSights({relevant:false,state:fourState,destination:'昆明'}).comparisons.length===0,'无关行程不派生伊犁景点比较');
const publicLead=sightAccess('qiongkushitai','琼库什台',fixedNow);
check(publicLead.no_car_access==='source_lead' && publicLead.travel_time_hours===null && publicLead.components.every((c)=>c.duration_minutes===null),
  '线路车报道只作为线索，候车与本次总时长仍未知');
check(publicLead.components.find((c)=>c.kind==='road').references[0].duration_minutes===155 &&
  publicLead.components.find((c)=>c.kind==='public_transport').references[0].duration_minutes===null,
  '驾车资料参考与公共交通时间分别保留，不互相替代');
check(sightAccess('qiongkushitai','琼库什台',Date.parse('2026-11-01T04:00:00Z')).no_car_access==='unverified',
  '线路车线索超过复核期不作为新鲜依据');
check(sightAccess('qiongkushitai','琼库什台',Date.parse('2026-09-01T04:00:00Z')).no_car_access==='unverified',
  '未来发布或采样的来源不冒充当时已知事实');
const reference=publicLead.components.find((c)=>c.kind==='public_transport').references[0];
check(!validAccessReference({...reference,duration_minutes:0}) && !validAccessReference({...reference,mode:'self_drive'}) &&
  !validAccessReference({...reference,source:{...reference.source,sampled_at:'2026-02-31'}}),
  '接驳字段拒绝零时长、错方式与不存在日期');
check(sightCatalog().attractions.every((a)=>sightAccess(a.id,a.name,fixedNow).location?.source?.url),
  '七处位置都有可追溯资料及精度说明');
const lock={outbound:{mode:'plane',from_city:'北京',to_city:'伊宁',date:'2026-09-30',arrive_date:'2026-09-30'},
  return:{mode:'plane',from_city:'乌鲁木齐',to_city:'北京',date:'2026-10-03'}};
const period={selected_ids:['xiata','kuerdening'],full_days:2,play_window:'2026-10-01 ~ 2026-10-02'};
const fits=compareSights({state:period,anchors:lock},fixedNow);
check(fits.window.full_days_bounds.possible_max===2 && fits.window.issues.length===0 && fits.status==='transport_pending',
  '锚点间两完整游玩日可以检查日期，仍不升级接驳可执行');
check(compareSights({state:{...period,full_days:3,play_window:null},anchors:lock},fixedNow).status==='window_conflict',
  '增加天数超过锁定交通期间明确冲突');
check(compareSights({state:{...period,play_window:'2026-09-30 ~ 2026-10-01'},anchors:lock},fixedNow).window.issues.some((n)=>n.includes('交通日')),
  '完整游玩日期不能包含交通日');
check(compareSights({state:{...period,full_days:1},anchors:lock},fixedNow).window.issues.some((n)=>n.includes('不一致')),
  '游玩日期和日数不一致要求确认');
const unknown=compareSights({state:period,anchors:{...lock,outbound:{...lock.outbound,arrive_date:undefined}}},fixedNow);
check(unknown.window.full_days_bounds===null && unknown.window.status==='pending',
  '未填到达日和时刻不猜到达日期');
const sameDay={outbound:{mode:'plane',from_city:'北京',to_city:'阿拉木图',date:'2026-10-08',arrive_date:'2026-10-08',arrive_time:'18:00'},
  return:{mode:'plane',from_city:'阿拉木图',to_city:'北京',date:'2026-10-08'}};
check(!compareSights({state:period,anchors:sameDay},fixedNow).window.issues.some((n)=>n.includes('晚于返程')),
  '返程时刻未填不补午夜并误判先后');
const crossing={outbound:{mode:'plane',from_city:'北京',to_city:'阿拉木图',date:'2026-09-30',arrive_time:'23:00'},
  return:{mode:'plane',from_city:'乌鲁木齐',to_city:'北京',date:'2026-10-03',depart_time:'08:00'}};
check(compareSights({state:period,anchors:crossing},fixedNow).window.full_days_bounds.possible_max===1,
  '跨时区到达跨伊犁当地午夜，完整游玩日按当地日期计算');
const stay=compareSights({state:period,anchors:lock,constraints:{lodging_stays:[{city:'伊宁',date:'2026-09-30'}],no_self_drive:true}},fixedNow);
check(stay.window.affected_dates.includes('2026-09-30') && stay.window.notes.some((n)=>n.includes('住宿')&&n.includes('接驳')) && stay.no_self_drive,
  '保留住宿与无车条件，标出相关日期和接驳待查');
const kept=structuredClone(lock);compareSights({state:{...period,full_days:14},anchors:lock},fixedNow);
assert.deepEqual(kept,lock);check(true,'预算冲突不自动修改交通锚点');
const playTurn=parseGuideTurn('游玩日期改成10月1日至2日',Date.parse('2026-09-20T00:00:00Z'));
check(playTurn.sights.play_window==='2026-10-01 ~ 2026-10-02' && Object.keys(playTurn.travel).length===0,
  '游玩日期口语进入景点状态，不改写去程交通窗口');
const clearTurn=parseGuideTurn('取消游玩日期',fixedNow);
check(clearTurn.sights.play_window===null && Object.keys(clearTurn.travel).length===0,
  '取消游玩日期不清空去返日期');
const lodgingTurn=parseGuideTurn('2026年9月30日住伊宁',fixedNow);
check(lodgingTurn.constraints.lodging_stays[0].date==='2026-09-30' && !lodgingTurn.travel.outbound_window,
  '住宿日期保留明确年份，不改写去程出发窗口');
const checklist=compareSights({state:{...period,selected_ids:['qiongkushitai']},anchors:crossing,destination:'阿拉木图',constraints:{no_self_drive:true, lodging_stays:[{date:'2026-10-01',city:'伊宁'},{date:'2026-09-30',city:'伊宁'}]}},fixedNow).access_checklist;
check(checklist.rows.some(r=>r.id==='destination-to-return' && r.from==='阿拉木图' && r.to==='乌鲁木齐' && r.date_window===null),
  '独立列出目的地至返程城市缺口，不把返程日当接驳出发日');
check(checklist.rows.some(r=>r.id==='arrival-to-base' && r.from==='阿拉木图' && r.to==='伊宁') && checklist.rows.some(r=>r.id==='base-to-destination'),
  '游玩地区不同于锁定到达城及目的地时列两端缺口');
const forward=checklist.rows.find(r=>r.from==='特克斯县客运站' && r.to==='琼库什台村');
const reverse=checklist.rows.find(r=>r.from==='琼库什台村' && r.to==='特克斯县客运站');
check(forward.references.length===1 && reverse.references.length===0, '公交报道仅附在相同方向及两端，不反转充当返程依据');
check(checklist.rows.every(r=>r.duration_minutes===null && r.fare===null && r.operator===null && r.applicable_dates===null) && checklist.executable===false,
  '线索不填本次运营、时长和费用，不升级可执行');
check(checklist.rows.some(r=>r.purpose.includes('返回住宿地') && r.date_window==='2026-10-01 ~ 2026-10-01'),
  '住宿接驳保留日期并明确尚未分配景点日');
check(!checklist.rows.some(r=>r.purpose.includes('返回住宿地') && r.date_window==='2026-09-30 ~ 2026-09-30'),
  '住宿日期在明确游玩窗口之外，不生成该日景点返住宿查询');
const emptyChecklist=compareSights({state:{selected_ids:[]},destination:'伊宁',anchors:{...lock,return:{...lock.return,from_city:'伊宁'}}}).access_checklist;
check(emptyChecklist.rows.length===0, '不选景点且返程贴目的地时不制造查询路段');
const missingChecklist=compareSights({state:{selected_ids:['xiata']}}).access_checklist;
check(missingChecklist.missing_context.length===2 && missingChecklist.rows.every(r=>r.date_window===null),
  '目的地与返程未识别时明示缺口，日期不猜测');
const airOut=transportReferences('伊宁','阿拉木图',fixedNow).find(r=>r.mode==='plane');
const airBack=transportReferences('阿拉木图','伊宁',fixedNow).find(r=>r.mode==='plane');
check(airOut && airBack && airOut.source.url!==airBack.source.url && airOut.reported_operator.includes('FlyArystan'),
  '航空去返分别采运营方方向页，不镜像去程来源');
check(airOut.source.published_at===null && airOut.evidence_state==='source_lead' && airOut.duration_minutes===null,
  '未注明发布时间不填采样日，航线页不提供本次耗时');
check(transportReferences('阿拉木图','乌鲁木齐',fixedNow).filter(r=>r.mode==='road_passenger').length===0 && transportReferences('乌鲁木齐','阿拉木图',fixedNow)[0].evidence_state==='historical',
  '乌鲁木齐始发道路报道不冒充阿拉木图始发班次');
check(transportReferences('伊宁','阿拉木图',Date.parse('2026-10-24T04:00:00Z')).find(r=>r.mode==='plane').evidence_state==='stale',
  '售期边界过去后航空方向页待重新核查');
check(transportReferences('伊宁','阿拉木图',Date.parse('2026-10-08T04:00:00Z')).every(r=>r.evidence_state==='unsupported'),
  '来源未采样时不能冒充当时已查事实');
check(transportReferences('伊宁','阿拉木图',fixedNow,'2026-10-22 ~ 2026-10-25').find(r=>r.mode==='plane').date_scope==='outside_reference',
  '日期范围部分超过售期也提示超范围，不认全窗覆盖');
check(!validTransportReference({...airOut,mode:'cargo'}) && !validTransportReference({...airOut,source:{...airOut.source,sampled_at:'2026-02-31'}}),
  '货运方式及无效来源日期不进入客运资料');
airOut.reported_operator='客户端改写';
check(transportReferences('伊宁','阿拉木图',fixedNow)[0].reported_operator!==airOut.reported_operator,
  '资料每次独立返回，客户端改写不污染策展库');
const crossChecklist=compareSights({state:{selected_ids:['xiata']},destination:'阿拉木图',anchors:{return:{mode:'plane',from_city:'乌鲁木齐',to_city:'北京',date:'2026-10-08'}}},fixedNow).access_checklist;
const crossReturn=crossChecklist.rows.find(r=>r.id==='destination-to-return');
check(crossReturn.references.filter(r=>r.evidence_state!=='unsupported').length===0 && crossReturn.opposite_references.filter(r=>r.mode==='road_passenger').length===1 && crossReturn.operator===null,
  '返程缺口展示反方向历史追查材料，保持本段无证据和运营方未知');
const current=Date.parse('2026-10-11T04:00:00Z');
const dated=transportReferences('阿拉木图','乌鲁木齐',current,'2026-10-22 ~ 2026-10-22').find(r=>r.id==='ala-urc-cz6012');
check(dated.evidence_state==='dated_partial' && dated.schedule_dates[0]==='2026-10-22' && dated.schedule.arrival_day_offset===1,'独立返程时刻表按适用日期匹配，保留到达次日');
check(transportReferences('北京','阿拉木图',current,'2026-10-15 ~ 2026-10-15').some(r=>r.schedule?.service_no==='CZ5097'),'直达基准有独立运营方时刻表');
check(transportReferences('阿拉木图','乌鲁木齐',current,'2026-10-25 ~ 2026-10-25').find(r=>r.id==='ala-urc-cz6012').evidence_state==='unsupported','超出时刻表适用期不升级日期证据');
check(!validSchedule({...dated.schedule,arrival_day_offset:0}) && !validSchedule({...dated.schedule,from_tz:'错误时区'}),'时刻表拒绝丢跨日和非法时区');
const assigned={selected_ids:['xiata','kuerdening'],visit_dates:{xiata:'2026-10-16',kuerdening:'2026-10-16'},full_days:2};
check(compareSights({state:assigned},current).window.issues.some(n=>n.includes('当天预算')),'同一天多景点检查分日预算，不只算总小时');
check(compareSights({state:{...assigned,play_window:'2026-10-17 ~ 2026-10-18'}},current).window.issues.some(n=>n.includes('超出游玩')),'分配日期超出游玩窗口明确提示');
check(normalizeSightState({selected_ids:['xiata'],visit_dates:{xiata:'2026-02-31'}}).visit_dates.xiata===null,'非法景点日期不保存为真实日期');
check(compareSights({state:{selected_ids:['kuerdening','xiata'],visit_dates:{kuerdening:'2026-10-17',xiata:'2026-10-16'}}},current).window.issues.some(n=>n.includes('顺序与日期')),'重排不暗改日期，顺序与日期倒置时明确提示');
console.log('✓ 景点比较与时间预算回归通过（'+count+' 项）');
