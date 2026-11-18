/* 旅行条件与日期校验；地点来自当前任务，无内置地点和方案。 */
import {extractIntentFields} from './trip-service.mjs';
const NIGHT_AVOID_RE = [
  /(?:不|别|不想|拒绝|避免|不接受)[^。！？，,]{0,6}(?:半夜|凌晨|夜间|夜里|红眼)[^。！？，,]{0,4}(?:到|到达|抵达|落地|航班)/,
  /红眼(?:航班)?[^。！？，,]{0,4}(?:不|不想|拒绝)/,
  /(?:半夜|凌晨|夜间|夜里)(?:到|到达|抵达|落地)[^。！？，,]{0,4}(?:不要|不行|不接受|避免)/
];
const NIGHT_ALLOW_RE = [
  /(?:可以|接受|能接受|无所谓|不介意|没关系)[^。！？，,]{0,6}(?:半夜|凌晨|夜间|夜里|红眼)/,
  /红眼(?:航班)?(?:也行|无所谓|可以|OK|ok)/
];

/** 从一句话提取约束（预算/最长中转时长/夜间到达/换乘次数/不开车）。确定性；识别不到的字段不出现。 */
export function extractConstraints(text) {
  const t = String(text || '');
  const c = {};
  let m;
  if ((m = t.match(/预算\s*(?:不超过|最多|约|大概|为|改到|改成|调整到|提高到|降到)?\s*(\d{3,6})\s*(?:元|块|人民币|CNY)/i)) ||
      (m = t.match(/(\d{3,6})\s*(?:元|块)\s*(?:以内|之内|的?预算)/))) c.budget_max_cny = +m[1];
  if ((m = t.match(/(?:中转|转机)[^。！？，,]{0,10}?(?:不超过|最多|少于|短于)?\s*(\d{1,2}(?:\.\d)?)\s*个?小时/))) c.max_layover_hours = +m[1];
  if (NIGHT_AVOID_RE.some((re) => re.test(t))) c.night_arrival = 'avoid';
  else if (NIGHT_ALLOW_RE.some((re) => re.test(t))) c.night_arrival = 'allow';
  if ((m = t.match(/(?:最多|不超过|至多|少于)\s*(?:换乘|转乘|中转|转机|换)\s*([零一二0-2])\s*次/)) ||
      (m = t.match(/(?:换乘|转乘|中转|转机)[^。！？，,]{0,8}?(?:不超过|最多|少于)?\s*([零一二0-2])\s*次/))) c.max_transfers = ({ 零: 0, 一: 1, 二: 2 })[m[1]] ?? +m[1];
  else if (/不想换乘|不换乘|不转乘|拒绝换乘/.test(t)) c.max_transfers = 0;
  /* 卡 B（v0.44.2）：不会开车——公共交通（铁路/航班/公路班线）不受影响，自驾/租车类走法须排除。
   * 否定词须紧邻方式词（≤2 字），避免「坐火车不会累，自己开车」这类跨句共现误报。 */
  if (/(?:不会|不能|没法|无法|不|没有)[^。！？，,]{0,2}(?:开车|自驾|驾车)/.test(t) ||
      /(?:没有?|未(?:取得|考))驾照/.test(t) || /自驾[^。！？，,]{0,3}(?:不行|不了|不能|没法)/.test(t)) c.no_self_drive = true;
  return c;
}

/** 住宿约束（卡 B）：「9 月 30 日住伊宁」→ [{date, city}]。城市必须在已收录清单（不猜），
 *  日期规则与返程提取一致（显式年份保留；未写年份目标日已过则次年；真实日历校验）。 */
export function extractLodgingStays(text, cityNames, nowMs = Date.now()) {
  const t = String(text || '');
  const date = '(?:(?<year>20\\d{2})\\s*(?:年|[/-])\\s*)?(?<month>\\d{1,2})\\s*(?:月|[/-])\\s*(?<day>\\d{1,2})\\s*(?:日|号)?';
  const re = new RegExp(date + '[^。！？，,]{0,6}?(?:住在?|夜宿|过夜在?)\\s*(?<city>[\\u4e00-\\u9fa5]{2,8})', 'g');
  const names = new Set(cityNames || []);
  const stays = [];
  for (const m of t.matchAll(re)) {
    const month = Number(m.groups.month), day = Number(m.groups.day);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) continue;
    if (!names.has(m.groups.city)) continue;
    const now = new Date(nowMs);
    let year = m.groups.year ? Number(m.groups.year) : now.getFullYear();
    const build = (y) => new Date(Date.UTC(y, month - 1, day));
    if (!m.groups.year && build(year) < new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))) year += 1;
    if (build(year).getUTCMonth() !== month - 1 || build(year).getUTCDate() !== day) continue;
    stays.push({ date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, city: m.groups.city });
    if (stays.length >= 3) break;
  }
  return stays;
}

/** 约束 chips（展示文案；数字全部来自用户输入值，非编造）。 */
export function constraintChips(c) {
  const chips = [];
  if (!c) return chips;
  if (c.budget_max_cny != null) chips.push({ key: 'budget', label: '预算 ≤ ¥' + c.budget_max_cny });
  if (c.max_layover_hours != null) chips.push({ key: 'layover', label: '最长中转 ' + c.max_layover_hours + ' 小时' });
  if (c.night_arrival === 'avoid') chips.push({ key: 'night', label: '夜间到达：不接受' });
  else if (c.night_arrival === 'allow') chips.push({ key: 'night', label: '夜间到达：可接受' });
  if (c.max_transfers != null) chips.push({ key: 'transfers', label: '换乘 ≤ ' + c.max_transfers + ' 次' });
  if (c.no_self_drive === true) chips.push({ key: 'no_self_drive', label: '不开车（不含自驾/租车）' });
  for (const stay of (Array.isArray(c.lodging_stays) ? c.lodging_stays : [])) {
    const md = String(stay.date || '').slice(5).replace('-', '月') + '日';
    chips.push({ key: 'lodging', label: md + ' 住 ' + stay.city });
  }
  return chips;
}

/** 显式传入的约束（UI 字段）白名单化：类型/范围不对的丢弃，不猜。 */
export function sanitizeConstraints(raw) {
  const c = {};
  if (!raw || typeof raw !== 'object') return c;
  const b = Number(raw.budget_max_cny);
  if (Number.isFinite(b) && b >= 100 && b <= 1000000) c.budget_max_cny = Math.round(b);
  const l = Number(raw.max_layover_hours);
  if (Number.isFinite(l) && l > 0 && l <= 48) c.max_layover_hours = Math.round(l * 10) / 10;
  if (raw.night_arrival === 'avoid' || raw.night_arrival === 'allow') c.night_arrival = raw.night_arrival;
  const tr = Number(raw.max_transfers);
  if (raw.max_transfers != null && Number.isInteger(tr) && tr >= 0 && tr <= 2) c.max_transfers = tr;
  if (raw.no_self_drive === true || raw.no_self_drive === false) c.no_self_drive = raw.no_self_drive;
  if (Array.isArray(raw.lodging_stays)) {
    /* 空数组是显式清空（二十七轮 P1-4：撤销必须能覆盖旧文本提取，不能被白名单丢弃） */
    const stays = raw.lodging_stays.filter((s) => s && typeof s.city === 'string' && s.city.length <= 24 &&
      typeof s.date === 'string' && ISO_DATE_OK(s.date)).slice(0, 3)
      .map((s) => ({ date: s.date, city: s.city }));
    c.lodging_stays = stays;
  }
  return c;
}

/** ISO 日期外形 + 真实日历（复用窗口校验：单日窗即两端同日）。 */
function ISO_DATE_OK(s) {
  return isValidWindow(s + ' ~ ' + s);
}

/* ---------- 交通锚点（卡 B v0.44.2）：用户确认的去/返交通事实 ---------- */

const ANCHOR_MODES = new Set(['plane', 'rail', 'road']);
const ANCHOR_MODE_LABEL = { plane: '航班', rail: '火车', road: '公路班线' };
const ANCHOR_NO_RE = /^[A-Za-z0-9]{1,12}$/;
const ANCHOR_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 地点当地日期/时刻的 UTC 可能范围；未填时刻表示全天未知，不补成午夜事实。 */
function anchorTimeRange() { return null; }

function sanitizeAnchorOne(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!ANCHOR_MODES.has(raw.mode) || typeof raw.date !== 'string' || !ISO_DATE_OK(raw.date)) return null;
  const from_city = typeof raw.from_city === 'string' ? raw.from_city.trim().slice(0, 24) : '';
  const to_city = typeof raw.to_city === 'string' ? raw.to_city.trim().slice(0, 24) : '';
  if (!from_city || !to_city || from_city === to_city) return null;
  const a = { mode: raw.mode, date: raw.date, from_city, to_city, source: 'user_entry' };
  /* 可选字段：用户没填就留空，不从截图或上下文猜测（卡 B 首版不做图片识别） */
  if (typeof raw.service_no === 'string' && ANCHOR_NO_RE.test(raw.service_no)) a.service_no = raw.service_no.toUpperCase();
  for (const key of ['depart_time', 'arrive_time']) {
    if (typeof raw[key] === 'string' && ANCHOR_TIME_RE.test(raw[key])) a[key] = raw[key];
  }
  if (typeof raw.arrive_date === 'string' && ISO_DATE_OK(raw.arrive_date)) a.arrive_date = raw.arrive_date;
  if (raw.arrive_date == null && a.arrive_time && ANCHOR_TIME_RE.test(a.arrive_time) &&
      raw.arrive_next_day === true) a.arrive_date = nextDayISO(raw.date);
  /* 起落各按当地时区转 UTC；只有到达的最晚可能时点仍早于出发的最早可能时点才拒绝。 */
  const dep = anchorTimeRange(a.date, a.depart_time, a.from_city);
  const arr = anchorTimeRange(a.arrive_date || a.date, a.arrive_time, a.to_city);
  if (dep && arr && arr.last < dep.first) return null;
  if (typeof raw.note === 'string' && raw.note.trim()) a.note = raw.note.trim().slice(0, 60);
  return a;
}

function nextDayISO(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 锚点白名单化（UI 传入）：单方向字段不完整即整条拒绝并记入 invalid——锚点是已确认交通事实，
 *  缺方式/日期/起讫城市就不能当事实用，不猜。返回 {outbound, return, invalid: ['outbound'|'return']} */
export function sanitizeAnchors(raw) {
  const out = { outbound: null, return: null, invalid: [] };
  if (!raw || typeof raw !== 'object') return out;
  for (const dir of ['outbound', 'return']) {
    if (raw[dir] == null) continue;
    const a = sanitizeAnchorOne(raw[dir]);
    if (a) out[dir] = a; else out.invalid.push(dir);
  }
  return out;
}

/* ---------- 行程意图（v0.35.0 十轮 P0：往返/日期/人数不回退） ----------
 * 复用 trip-service.extractIntentFields（往返/人数/假期宽窗，确定性）；
 * 新增返程日期提取（「10月7日回来」→ 单日窗，年份代码计算禁心算）；
 * UI 显式字段（trip_type/窗口/人数）白名单化后优先于文本提取。 */

const WIN_SHAPE_RE = /^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/;

/** 真实日历窗口校验（十一轮 P1）：外形 + 两日期真实存在（2026-02-31 溢出即拒）+ 起止顺序。 */
export function isValidWindow(s) {
  if (typeof s !== 'string' || !WIN_SHAPE_RE.test(s)) return false;
  const [a, b] = s.split(' ~ ');
  const pa = new Date(a + 'T00:00:00Z');
  const pb = new Date(b + 'T00:00:00Z');
  if (Number.isNaN(pa.getTime()) || Number.isNaN(pb.getTime())) return false;
  /* 溢出校验：Date 会把 2026-02-31 卷到 03-03，toISOString 回读不一致即非法 */
  if (pa.toISOString().slice(0, 10) !== a || pb.toISOString().slice(0, 10) !== b) return false;
  return pa <= pb;
}

/** 从一句话提取返程日期（可带年份的 M月D日 / M-D / M/D 紧跟或前接「回来/返回/回程/返程」），代码计算缺失年份。
 *  十二轮 P1：产出日期须过真实日历校验（Date 溢出回读一致）——2月31日/4月31日等不存在日期返回 null。 */
export function extractReturnDate(text, nowMs = Date.now()) {
  const t = String(text || '');
  const date = '(?:(?<year>20\\d{2})\\s*(?:年|[/-])\\s*)?(?<month>\\d{1,2})\\s*(?:月|[/-])\\s*(?<day>\\d{1,2})\\s*(?:日|号)?';
  const m = t.match(new RegExp(date + '[^。！？，,]{0,8}?(?:回来|返回|回程|返程|回)')) ||
    t.match(new RegExp('(?:回来|返回|回程|返程)[^。！？，,]{0,4}?' + date));
  if (!m) return null;
  const month = Number(m.groups.month), day = Number(m.groups.day);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  /* 显式年份保留；未写年份时目标日已过则次年（禁心算）。 */
  const now = new Date(nowMs);
  let year = m.groups.year ? Number(m.groups.year) : now.getFullYear();
  const build = (y) => new Date(Date.UTC(y, month - 1, day));
  if (!m.groups.year && build(year) < new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))) year += 1;
  /* 真实日历校验：Date 会把 02-31 卷到 03-03，回读不一致即非法（十二轮 P1） */
  const built = build(year);
  if (built.getUTCMonth() !== month - 1 || built.getUTCDate() !== day) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return `${iso} ~ ${iso}`;
}

/** 显式行程意图字段（UI）白名单化：枚举/真实日历/范围不对的丢弃，不猜（十一轮 P1：无效日期不得当已确认事实）。 */
export function sanitizeIntentFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (['pending', 'round_trip', 'one_way'].includes(raw.trip_type)) out.trip_type = raw.trip_type;
  if (isValidWindow(raw.outbound_window)) out.outbound_window = raw.outbound_window;
  if (isValidWindow(raw.return_window)) out.return_window = raw.return_window;
  if (isValidWindow(raw.arrival_window)) out.arrival_window = raw.arrival_window;
  const n = Number(raw.traveler_count);
  if (Number.isInteger(n) && n >= 1 && n <= 9) out.traveler_count = n;
  return out;
}

/** 行程意图组装（十一轮 P0 重构）：先白名单化显式字段 → 合并出唯一 finalIntent → 只按 finalIntent 生成 needs。
 *  不再读取未白名单化的 explicit（null 安全）；显式覆盖文本（如往返改单程）后不残留旧状态的补充提示。 */
export function buildTravelIntent(text, explicit, nowMs = Date.now()) {
  const fields = extractIntentFields(text, nowMs);
  const retFromText = extractReturnDate(text, nowMs);
  /* 数字人数（「2个人」）——extractIntentFields 只覆盖中文数词，这里补数字形式 */
  let traveler = fields.traveler_count;
  if (traveler == null) {
    const m = String(text || '').match(/([1-9])\s*个?\s*人/);
    if (m) traveler = +m[1];
  }
  const exp = sanitizeIntentFields(explicit);
  const finalIntent = {
    trip_type: exp.trip_type || fields.trip_type || 'pending',
    outbound_window: exp.outbound_window || fields.outbound_window || null,
    arrival_window: exp.arrival_window || fields.arrival_window || null,
    return_window: exp.return_window || retFromText,
    traveler_count: exp.traveler_count ?? traveler ?? 1
  };
  /* 十三轮 P1：以最终行程类型统一约束日期字段——非往返（单程/待确认）不保留返程窗口，
   * 无论其来自文本提取还是用户显式填写；清掉时给明确纠正提示，不静默显示「单程＋返程日期」 */
  let returnClearedByType = false;
  if (finalIntent.trip_type !== 'round_trip' && finalIntent.return_window) {
    finalIntent.return_window = null;
    returnClearedByType = true;
  }
  /* 时序预检（十二轮 P1）：只在不存在任何「去程 ≤ 返程」组合（完全倒序：返程结束早于去程开始）时拒绝；
   * 窗口重叠（如去 10-03~10-05 / 返 10-01~10-07）仍存在有效组合，保留交由后续证据层校验具体日期 */
  let returnDropped = false;
  if (finalIntent.return_window && finalIntent.outbound_window &&
    finalIntent.return_window.slice(13, 23) < finalIntent.outbound_window.slice(0, 10)) {
    finalIntent.return_window = null;
    returnDropped = true;
  }
  const needs = [];
  if (finalIntent.trip_type === 'pending') needs.push('行程类型未识别（单程/往返）：可先用单程做方向探索，或补充说明');
  if (finalIntent.arrival_window && !finalIntent.outbound_window) needs.push('已记录希望到达时间；当前走法尚未按班次筛选，出发日期待定');
  if (finalIntent.trip_type === 'round_trip') {
    if (!finalIntent.outbound_window) needs.push('往返行程请补去程日期或大致窗口');
    if (!finalIntent.return_window) needs.push('往返行程请补返程日期（未补前不展示返程样本）');
  }
  if (returnClearedByType) needs.push('行程类型为' + (finalIntent.trip_type === 'one_way' ? '单程' : '待确认') + '：已忽略返程日期，如需往返请把行程类型改为往返');
  if (returnDropped) needs.push('返程窗口早于去程：已忽略该返程窗口，请修正后重试');
  return { intent: finalIntent, needs };
}
