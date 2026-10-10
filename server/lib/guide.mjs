/* 将补充表达转成待用户确认的变更，不直接修改原行程。 */
import guide from '../../mixtouring-hifi/assets/trip-guide.js';
import { buildTravelIntent, extractConstraints, extractReturnDate, extractLodgingStays } from './anywhere.mjs';
import { loadPlaces } from './trip-service.mjs';
import { parseSightChange, compareSights, sightCatalog } from './sights.mjs';
import { transportReferences } from './transport-references.mjs';

const CITY_NAMES = loadPlaces().filter((p) => p.kind === 'city').map((p) => p.name);

function answerRouteQuestion(text, plan, selectedCandidateId, preferences,nowMs) {
  const candidates = plan?.candidates || [];
  if (!candidates.length) return null;
  const selected = candidates.find((c) => c.id === selectedCandidateId);
  if (/推荐|选哪|哪条好|怎么选|比较一下/.test(text) && !/为什么|为何|依据|来源/.test(text)) {
    const choice=guide.rank(candidates,preferences).items[0]?.candidate;
    if (!choice) return '当前条件下没有合适走法。要不要先放宽交通方式，再比较？';
    const path=choice.legs.map(l=>l.from).concat(choice.legs.at(-1).to).join(' → ');
    return '建议先看 '+path+'。'+(choice.kind==='direct'?'不用换乘，安排更省心。':
      '可以在'+choice.legs[0].to+'停留，把途中城市也加入旅行。')+'具体交通安排见详情。';
  }
  if (/(?:班次|航班号|车次|票价|多少钱|价格|能买|能订|能成行)/.test(text)) {
    const choice=selected || guide.rank(candidates,preferences).items[0]?.candidate;
    const refs=(choice?.legs || []).flatMap((l,i)=>transportReferences(l.from,l.to,nowMs,i===0?plan.intent?.outbound_window:null)
      .filter(r=>r.schedule && !['unsupported','stale'].includes(r.evidence_state) && (!l.mode_guess || l.mode_guess==='plane')));
    if(refs.length) return '已有运营方时刻表参考：'+refs.slice(0,2).map(r=>r.schedule.service_no+' '+r.schedule.depart_time+' → '+r.schedule.arrive_time+(r.schedule.arrival_day_offset?'（到达次日）':'')).join('；')+'，均为两端当地时间。详情可看适用日期；余票、价格和行李仍待查询。';
    return '当前只有路线探索线索，尚无这条走法指定日期的逐段班次、价格和衔接证据。打开走法详情可按清单逐段核对。';
  }
  if (/(?:直达|直飞)/.test(text) && /(?:有|呢|怎么|为什么|是否)/.test(text)) {
    const direct = candidates.find((c) => c.kind === 'direct');
    return direct
      ? '当前有直达方向，但仍是待核验的路线假设；班期和费用未知。可以选直达卡查看需核对的事项。'
      : '本次候选没有直达方向，不能据此断定实际不存在直达服务。';
  }
  const city = candidates.flatMap((c) => c.legs.slice(1).map((l) => l.from))
    .find((name) => text.includes(name));
  if (city && /(?:为什么|为何|依据|来源|有没|有没有|能否|可以|可不可以|怎么)/.test(text)) {
    const candidate = candidates.find((c) => c.legs.slice(1).some((l) => l.from === city));
    const source = candidate.basis?.sources?.[0]?.title;
    const lead = source ? `参考线索《${source}》；` : '';
    return `当前有经${city}的探索走法。${lead}${candidate.explanation || '连接关系仍需逐段核对'}。这不代表指定日期有可衔接的客运班次，来源可在走法详情查看。`;
  }
  if (/先.*(?:火车|铁路).*再.*(?:飞机|航班)/.test(text)) {
    const match = candidates.find((c) => c.legs.length >= 2 && c.legs[0].mode_guess === 'rail' && c.legs[1].mode_guess === 'plane');
    return match
      ? `当前有经${match.legs[0].to}的铁路接航班探索走法，可点开比较；两段班期与衔接尚未核验。`
      : '当前候选没有明确的铁路接航班走法；方式待查的路段不能当作火车或飞机。';
  }
  if (selected && /(?:这条|所选|选中).*(?:怎么|为何|为什么|依据|来源)/.test(text)) {
    return `${selected.explanation || '这条走法仍需逐段核验'}。具体来源与待查项可在走法详情查看。`;
  }
  return null;
}

export function parseGuideTurn(text, nowMs = Date.now(), plan = null, selectedCandidateId = null, context = {}) {
  const t = String(text || '').trim().slice(0, 500);
  const preferences = guide.parse(t);
  const parsed = buildTravelIntent(t, null, nowMs);
  const travel = {}, constraints = extractConstraints(t), labels = guide.summary(preferences.patch);
  const sightChange = parseSightChange(t,nowMs);
  let suggestion=null;
  if (/(?:推荐|只去|只选|保留|少选).*(?:两|二|2|几个).*(?:景点|处)|(?:两|二|2)个景点/.test(t) && !/为什么|为何|依据|来源|不用推荐|不要推荐/.test(t) && !sightChange.patch.selected_ids) {
    if (guide.sightRelevant(plan,t) || context.sight_requested === true) {
      const ids=context.sights?.selected_ids?.length>=2?context.sights.selected_ids:sightCatalog().attractions.map(a=>a.id);
      const comparison=compareSights({state:{...context.sights,selected_ids:ids},constraints:{...plan?.intent?.constraints,...extractConstraints(t)}},nowMs);
      const pair=comparison.options[0];
      if (pair) {sightChange.patch.selected_ids=pair.selected_ids;sightChange.labels.push('建议保留：'+pair.names.join('、'));suggestion=pair.reason;}
    } else suggestion='想比较哪个城市的景点？';
  }
  labels.push(...sightChange.labels);
  /* 卡 B：住宿约束口语（城市须已收录）；「不住 X 了 / 取消住宿」撤销 */
  const lodging = extractLodgingStays(t, CITY_NAMES, nowMs);
  if (lodging.length) constraints.lodging_stays = lodging;
  if (/(?:不住|取消)了?(?:住宿|住宿安排)|取消住宿|住宿不限了?/.test(t)) constraints.lodging_stays = null;
  /* 撤销不开车：肯定语境（可以/会/能 开车），lookbehind 排除「不会/没法开车」里的否定子串 */
  if (/(?<![不会没能])(?:可以|会|能)(?:自己)?开车|取消不开车|恢复自驾/.test(t)) constraints.no_self_drive = null;
  for (const key of ['outbound_window', 'arrival_window', 'return_window']) {
    const isSightDate=key!=='return_window' && parsed.intent[key]===sightChange.patch.play_window && !/去程|出发|启程/.test(t);
    const isLodgingDate=key!=='return_window' && lodging.length>0 && !/去程|出发|启程/.test(t);
    if (parsed.intent[key] && !isSightDate && !isLodgingDate) travel[key] = parsed.intent[key];
  }
  const explicitReturn = extractReturnDate(t, nowMs);
  if (explicitReturn) { travel.return_window = explicitReturn; travel.trip_type = 'round_trip'; }
  if (travel.return_window && travel.outbound_window === travel.return_window &&
      /返回|返程|回程|回来/.test(t) && !/出发|去程|启程/.test(t)) delete travel.outbound_window;
  if (parsed.intent.trip_type !== 'pending') travel.trip_type = parsed.intent.trip_type;
  if (/(?:取消|不要|不想).{0,4}(?:返程|回程|往返)/.test(t)) {
    travel.trip_type = 'one_way'; travel.return_window = null;
  }
  if (/[一二两1-9]\s*个?人|独自|一个人/.test(t)) travel.traveler_count = parsed.intent.traveler_count;
  if (/日期.*(?:不定|取消|不限)|取消日期/.test(t) && !/(?:景点|游玩|游览)日期/.test(t)) {
    travel.outbound_window = null; travel.arrival_window = null; travel.return_window = null;
  }
  if (/预算.*(?:不限|取消)|取消预算/.test(t)) constraints.budget_max_cny = null;
  if (/(?:换乘|中转|转机).*(?:不限|取消)|取消换乘/.test(t)) constraints.max_transfers = null;
  if (/夜间到达.*不限|取消夜间/.test(t)) constraints.night_arrival = null;
  if (/(?:最晚|不晚于).*(?:到|到达|抵达)/.test(t)) {
    delete travel.outbound_window; delete travel.arrival_window;
    preferences.notes.push('你给的是最晚到达日，不等于当天出发或当天到达。请再说可接受的到达日期范围，我会记为到达偏好。');
  }
  const fields = { outbound_window: '出发', arrival_window: '希望到达', return_window: '返回', trip_type: '行程', traveler_count: '人数' };
  for (const [key, value] of Object.entries(travel)) labels.push(fields[key] + '：' + (value === null ? '先不定' : value === 'round_trip' ? '往返' : value === 'one_way' ? '单程' : value));
  const names = { budget_max_cny: '预算上限（元）', max_layover_hours: '最长中转（小时）', max_transfers: '最多换乘', night_arrival: '夜间到达' };
  for (const [key, value] of Object.entries(constraints)) {
    if (key === 'no_self_drive' || key === 'lodging_stays') continue; /* 新约束单独展示 */
    labels.push(names[key] + '：' + (value == null ? '不限' : value === 'avoid' ? '不接受' : value === 'allow' ? '可接受' : value));
  }
  if (constraints.no_self_drive === true) labels.push('不开车：是（不含自驾/租车走法）');
  else if (constraints.no_self_drive === null) labels.push('不开车：不限（已恢复）');
  for (const stay of (Array.isArray(constraints.lodging_stays) ? constraints.lodging_stays : [])) {
    labels.push('住宿：' + stay.date + ' 住 ' + stay.city);
  }
  if (constraints.lodging_stays === null) labels.push('住宿：已取消');
  const answer = labels.length ? null : answerRouteQuestion(t, plan, selectedCandidateId,context.preferences,nowMs);
  const requiresConfirmation = Object.keys(travel).length>0 || Object.keys(constraints).length>0 ||
    Object.prototype.hasOwnProperty.call(sightChange.patch,'selected_ids') || Object.prototype.hasOwnProperty.call(sightChange.patch,'play_window') || Object.prototype.hasOwnProperty.call(sightChange.patch,'full_days');
  return { preferences: preferences.patch, travel, constraints, sights: sightChange.patch, labels, notes: preferences.notes,
    requires_confirmation:requiresConfirmation,
    recognized: labels.length > 0,
    message: suggestion || (labels.length ? requiresConfirmation?'确认后更新这些安排。':'已更新，可以随时撤销。'
      : answer || preferences.notes[0] || '想调整路线、景点还是日期？告诉我其中一项就好。') };
}
