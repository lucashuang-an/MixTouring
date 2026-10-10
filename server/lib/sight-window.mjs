/* 景点完整游玩日校验：交通日不算完整游玩日；缺失时刻仅构造可能范围，不冒充午夜班次。 */
import { sanitizeAnchors, resolvePlace, isValidWindow } from './anywhere.mjs';
import { zonedToUtc, utcToZoned } from './trip.mjs';
const DAY = 86400000;
const LOCAL_TZ = 'Asia/Shanghai';
const midnight = (s) => Date.parse(s + 'T00:00:00Z');
const localDay = (ms) => utcToZoned(ms, LOCAL_TZ).dateStr;
function range(a, arriving) {
  if (!a) return null;
  if (arriving && !a.arrive_date && !a.arrive_time) return null;
  const date = arriving ? a.arrive_date || a.date : a.date;
  const time = arriving ? a.arrive_time : a.depart_time;
  const tz = resolvePlace(arriving ? a.to_city : a.from_city)?.tz;
  if (!tz) return null;
  try { return { first:zonedToUtc(date,time || '00:00',tz).getTime(), last:zonedToUtc(date,time || '23:59',tz).getTime() }; }
  catch { return null; }
}
export function assessSightWindow(state, rawAnchors, constraints = {}) {
  if (!constraints || typeof constraints!=='object') constraints={};
  const anchors = sanitizeAnchors(rawAnchors), issues = [], notes = [], affected = new Set();
  if (anchors.invalid.length) issues.push('部分交通锚点字段不完整或先后矛盾，请修正后检查游玩窗口。');
  const out = range(anchors.outbound,true), back = range(anchors.return,false);
  let bounds = null;
  if (out && back) {
    if (out.first > back.last) issues.push('去程到达晚于返程出发，锁定交通期间无法安排游玩。');
    const full = (arr,dep) => Math.max(0,Math.floor((midnight(localDay(dep))-midnight(localDay(arr)))/DAY)-1);
    bounds = { confirmed_min:full(out.last,back.first), possible_max:full(out.first,back.last),
      earliest_arrival_day:localDay(out.first), latest_arrival_day:localDay(out.last),
      earliest_return_day:localDay(back.first), latest_return_day:localDay(back.last) };
    if (state.full_days > bounds.possible_max) issues.push('完整游玩日数量超过锁定交通期间，请删减天数或主动修改锚点。');
    else if (state.full_days > bounds.confirmed_min) notes.push('交通时刻不完整，所选游玩日只能在部分时刻安排下成立，请确认。');
  } else notes.push('去程到达日期／时刻或返程信息不全，尚不能检查完整游玩窗口。');
  const win = state.play_window;
  if (win && isValidWindow(win)) {
    const start=win.slice(0,10),end=win.slice(13,23),days=Math.floor((midnight(end)-midnight(start))/DAY)+1;
    affected.add(start); affected.add(end);
    if (days!==state.full_days) issues.push('游玩日期范围与完整游玩日数量不一致，请统一这两项设置。');
    if (bounds && (start<=bounds.earliest_arrival_day || end>=bounds.latest_return_day)) issues.push('游玩日期包含交通日或超出锚点期间，不能当作完整游玩日。');
    else if (bounds && (start<=bounds.latest_arrival_day || end>=bounds.earliest_return_day)) notes.push('游玩日期是否避开交通日仍取决于缺失时刻，需继续确认。');
  } else if (win) notes.push('游玩日期范围无效，请填写真实日期且起始不晚于结束。');
  else notes.push('尚未指定游玩日期；天数预算不等于已安排的逐日日程。');
  const dayBudget={};let lastAssigned=null;
  for(const id of state.selected_ids || []) {
    const date=state.visit_dates?.[id]; if(!date) continue;
    if(lastAssigned && date<lastAssigned) issues.push(date+' 的景点顺序与日期先后不一致，请调整顺序或日期。');lastAssigned=date;
    affected.add(date);dayBudget[date]=(dayBudget[date] || 0)+(state.visit_hours[id] || 6);
    if(win && isValidWindow(win) && (date<win.slice(0,10) || date>win.slice(13,23))) issues.push(date+' 的景点安排超出游玩日期范围。');
    if(bounds && (date<=bounds.earliest_arrival_day || date>=bounds.latest_return_day)) issues.push(date+' 的景点安排落在交通日或锁定期间之外。');
  }
  for(const [date,hours] of Object.entries(dayBudget)) if(hours>state.day_hours) issues.push(date+' 的游玩预留超过当天预算，请调整景点或日期。');
  for (const stay of Array.isArray(constraints.lodging_stays)?constraints.lodging_stays:[]) {
    if (!stay || !isValidWindow(stay.date+' ~ '+stay.date) || typeof stay.city!=='string') continue;
    affected.add(stay.date);
    if (bounds && (stay.date<bounds.earliest_arrival_day || stay.date>bounds.latest_return_day)) notes.push('住宿 '+stay.date+'（'+stay.city+'）在锚点日期范围之外，请核对。');
    else notes.push('已保留住宿 '+stay.date+'（'+stay.city+'）；景点至住宿地的接驳及当晚可达性待核查。');
  }
  return { status:issues.length?'window_conflict':notes.some((n)=>/信息不全|不完整|无效|缺失/.test(n))?'pending':'date_range_checked',
    full_days_bounds:bounds, issues, notes, affected_dates:[...affected].sort(),
    basis:'按伊犁当地日期检查，去程到达日和返程出发日不计完整游玩日；交通锚点保持原值。' };
}
