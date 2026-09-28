/* 将补充表达转成待用户确认的变更，不直接修改原行程。 */
import guide from '../../mixtouring-hifi/assets/trip-guide.js';
import { buildTravelIntent, extractConstraints, extractReturnDate } from './anywhere.mjs';

function answerRouteQuestion(text, plan, selectedCandidateId) {
  const candidates = plan?.candidates || [];
  if (!candidates.length) return null;
  const selected = candidates.find((c) => c.id === selectedCandidateId);
  if (/(?:班次|航班号|车次|票价|多少钱|价格|能买|能订|能成行)/.test(text)) {
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

export function parseGuideTurn(text, nowMs = Date.now(), plan = null, selectedCandidateId = null) {
  const t = String(text || '').trim().slice(0, 500);
  const preferences = guide.parse(t);
  const parsed = buildTravelIntent(t, null, nowMs);
  const travel = {}, constraints = extractConstraints(t), labels = guide.summary(preferences.patch);
  for (const key of ['outbound_window', 'arrival_window', 'return_window']) {
    if (parsed.intent[key]) travel[key] = parsed.intent[key];
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
  if (/日期.*(?:不定|取消|不限)|取消日期/.test(t)) {
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
  for (const [key, value] of Object.entries(constraints)) labels.push(names[key] + '：' + (value == null ? '不限' : value === 'avoid' ? '不接受' : value === 'allow' ? '可接受' : value));
  const answer = labels.length ? null : answerRouteQuestion(t, plan, selectedCandidateId);
  return { preferences: preferences.patch, travel, constraints, labels, notes: preferences.notes,
    recognized: labels.length > 0,
    message: labels.length ? '我理解到下面这些调整，确认后应用。其余表达暂未转成条件。'
      : answer || preferences.notes[0] || '我还没理解你想调整什么。可以问当前走法的依据或待查项，也可以说明停留晚数、交通偏好、日期和预算。' };
}
