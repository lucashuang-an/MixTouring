/* 将补充表达转成待用户确认的变更，不直接修改原行程。 */
import guide from '../../mixtouring-hifi/assets/trip-guide.js';
import { buildTravelIntent, extractConstraints } from './anywhere.mjs';

export function parseGuideTurn(text, nowMs = Date.now()) {
  const t = String(text || '').trim().slice(0, 500);
  const preferences = guide.parse(t);
  const parsed = buildTravelIntent(t, null, nowMs);
  const travel = {}, constraints = extractConstraints(t), labels = guide.summary(preferences.patch);
  for (const key of ['outbound_window', 'arrival_window', 'return_window']) {
    if (parsed.intent[key]) travel[key] = parsed.intent[key];
  }
  if (parsed.intent.trip_type !== 'pending') travel.trip_type = parsed.intent.trip_type;
  if (/[一二两1-9]\s*个?人|独自|一个人/.test(t)) travel.traveler_count = parsed.intent.traveler_count;
  if (/日期.*(?:不定|取消|不限)|取消日期/.test(t)) {
    travel.outbound_window = null; travel.arrival_window = null; travel.return_window = null;
  }
  if (/预算.*(?:不限|取消)|取消预算/.test(t)) constraints.budget_max_cny = null;
  if (/(?:换乘|中转|转机).*(?:不限|取消)|取消换乘/.test(t)) constraints.max_transfers = null;
  if (/夜间到达.*不限|取消夜间/.test(t)) constraints.night_arrival = null;
  const fields = { outbound_window: '出发', arrival_window: '希望到达', return_window: '返回', trip_type: '行程', traveler_count: '人数' };
  for (const [key, value] of Object.entries(travel)) labels.push(fields[key] + '：' + (value === null ? '先不定' : value === 'round_trip' ? '往返' : value === 'one_way' ? '单程' : value));
  const names = { budget_max_cny: '预算上限（元）', max_layover_hours: '最长中转（小时）', max_transfers: '最多换乘', night_arrival: '夜间到达' };
  for (const [key, value] of Object.entries(constraints)) labels.push(names[key] + '：' + (value == null ? '不限' : value === 'avoid' ? '不接受' : value === 'allow' ? '可接受' : value));
  return { preferences: preferences.patch, travel, constraints, labels, notes: preferences.notes,
    recognized: labels.length > 0,
    message: labels.length ? '我理解到下面这些调整，确认后应用。其余表达暂未转成条件。' : '这句话还没能转成明确条件。可以点选下面的回答，或说明停留晚数、交通偏好、日期和预算。' };
}
