/* 卡 C：景点取舍与时间预算。预算是用户预留，路上耗时、接驳和当期开放不由模型补足。 */
import { readFileSync } from 'node:fs';
const DATA = JSON.parse(readFileSync(new URL('../../pipeline/data/attractions.json', import.meta.url), 'utf8'));
const BY_ID = new Map(DATA.attractions.map((a) => [a.id, a]));
const DEFAULT_IDS = ['nalati', 'kalajun', 'xiata', 'kuerdening'];
const THEMES = new Set(['不限', ...DATA.attractions.map((a) => a.theme)]);
export function sightCatalog() { return structuredClone(DATA); }

export function normalizeSightState(raw = {}) {
  if (!raw || typeof raw !== 'object') raw = {};
  const ids = Array.isArray(raw.selected_ids) ? [...new Set(raw.selected_ids.filter((id) => BY_ID.has(id)))] : [...DEFAULT_IDS];
  const integer = (v, fallback, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : fallback;
  return { selected_ids: ids, full_days: integer(raw.full_days, 2, 1, 14),
    day_hours: integer(raw.day_hours, 8, 4, 12), preference: THEMES.has(raw.preference) ? raw.preference : '不限',
    visit_hours: Object.fromEntries(ids.map((id) => [id, integer(raw.visit_hours?.[id], 6, 1, 12)])) };
}

export function parseSightChange(text) {
  const t = String(text || '').slice(0, 500), ids = DATA.attractions.filter((a) => t.includes(a.name)).map((a) => a.id);
  const patch = {}, labels = [];
  for (const clause of t.split(/[，,。；;]|然后|(?=去掉|取消|不去|删掉|删除|只保留|只去|比较|对比|再加|加上|改去|想去|再去)/)) {
    const matches = DATA.attractions.filter((a) => clause.includes(a.name)).map((a) => a.id);
    if (!matches.length) continue;
    const key = /去掉|取消|不去|删掉|删除/.test(clause) ? 'remove_ids' : /只保留|只去|比较|对比/.test(clause) ? 'selected_ids' : 'add_ids';
    for (const id of matches) {
      for (const other of ['selected_ids','add_ids','remove_ids']) if (other !== key && patch[other]) patch[other] = patch[other].filter((v) => v !== id);
      patch[key] = [...new Set([...(patch[key] || []), id])];
    }
  }
  for (const key of ['selected_ids','add_ids','remove_ids']) if (patch[key]) {
    if (key !== 'selected_ids' && !patch[key].length) { delete patch[key]; continue; }
    labels.push((key === 'remove_ids' ? '去掉：' : key === 'selected_ids' ? '比较：' : '加入：') + (patch[key].map((id) => BY_ID.get(id).name).join('、') || '暂无景点'));
  }
  const day = t.match(/([一二两三四五六七八九十]|\d+)\s*(?:个)?\s*(?:完整)?\s*(?:游玩日|天)/);
  if (day && (ids.length || /伊犁|景点|游玩/.test(t))) {
    const n = { 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 }[day[1]] || Number(day[1]);
    if (n >= 1 && n <= 14) { patch.full_days = n; labels.push('完整游玩日：' + n); }
  }
  if (/喜欢|偏好|想看|更想|优先/.test(t)) {
    const theme = [...THEMES].filter((v) => v !== '不限').find((v) => t.includes(v));
    if (theme) { patch.preference = theme; labels.push('景观偏好：' + theme); }
  }
  return { patch, labels };
}

export function compareSights(input = {}) {
  const state = normalizeSightState(input.state), selected = state.selected_ids.map((id) => structuredClone(BY_ID.get(id)));
  const available = state.full_days * state.day_hours;
  const visitTotal = selected.reduce((sum, a) => sum + state.visit_hours[a.id], 0);
  const conflict = visitTotal > available;
  const noCar = input.constraints?.no_self_drive === true;
  const pairs = [];
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
    const a = selected[i], b = selected[j];
    pairs.push({ ids:[a.id,b.id], preferred:[a,b].filter((v) => v.theme === state.preference).length,
      diversity:a.theme !== b.theme, same_county:a.county === b.county });
  }
  pairs.sort((a,b) => b.preferred-a.preferred || Number(b.diversity)-Number(a.diversity) || Number(b.same_county)-Number(a.same_county));
  const options = pairs.slice(0,3).map((p) => ({ selected_ids:p.ids,
    names:p.ids.map((id) => BY_ID.get(id).name),
    reason:(p.preferred ? '包含你偏好的' + state.preference + '；' : '') +
      (p.diversity ? '两处主要景观不同，减少重复体验。' : '两处景观接近，适合集中比较同类景观。') +
      (p.same_county ? '同属一个县，便于从同一县城核查接驳；不代表已有直达交通。' : '分属不同地区，跨区接驳和路上耗时仍需核查。'),
    evidence_state:'explore', travel_time_hours:null }));
  return { state, evidence_state:'explore', no_self_drive:noCar,
    budget:{available_hours:available,visit_hours:visitTotal,remaining_hours:available-visitTotal,travel_hours:null,
      basis:'游玩预留时间为可调整的规划预算，默认每处预留六小时；不是实测最短游览时长。完整游玩日不包含已锁定交通日，须由你确认。'},
    status:conflict ? 'budget_conflict' : selected.length ? 'transport_pending' : 'empty',
    message:conflict ? '仅游玩预留时间已超过可用预算。请删减景点或增加时间，接驳还需额外占时。'
      : selected.length ? '游玩预算可容纳当前选择，但路上耗时、候车和景区接驳未核实，暂不能判定可完成。' : '选择想比较的景点。',
    minimum_budget_days:Math.ceil(visitTotal/state.day_hours), options,
    comparisons:selected.map((a) => ({...a,visit_hours:state.visit_hours[a.id],travel_time_hours:null,
      no_car_access:'unverified',travel_note:'道路耗时、候车与景区接驳时间未知；县区位置不能替代实际路线查询。'})),
    warnings:['资料来源只支持历史景观与位置，不代表本次日期开放或客运运营。',
      ...(noCar ? ['已保留不开车条件：只列公共交通和景区接驳待查项，不能将自驾线路视为无车可达。'] : []),
      ...(selected.some((a) => state.visit_hours[a.id] < 4) ? ['游玩预留较短，可能只能走局部范围；这仍不能证明接驳可行。'] : [])] };
}
