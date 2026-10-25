/* Agent服务配置及日期字段；不装载任何地点、交通或路线库。 */
import {SEARCH_PLANNER_VERSION} from './versions.mjs';
export function webSearchConfigured(env = process.env) {
  if(env.TRAVEL_SEARCH_PROVIDER==='tavily')return {configured:!!env.TAVILY_API_KEY,basis:'tavily'};
  if(env.TRAVEL_SEARCH_PROVIDER && env.TRAVEL_SEARCH_PROVIDER!=='current')return {configured:false,basis:'unsupported-provider'};
  if (env.VOLC_SEARCH_API_KEY) return { configured: true, basis: 'volc-search' };
  const key = !!env.LLM_API_KEY;
  const base = env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const zhipuBase = base.includes('bigmodel.cn');
  if (env.WEB_SEARCH_AVAILABLE === '1') return { configured: key, basis: 'explicit' };
  return { configured: key && zhipuBase, basis: zhipuBase ? 'zhipu-endpoint' : 'non-zhipu-base' };
}

/** 能力声明（决策⑤ + v0.31.0 评审 P1-4）：配置与可用分开、版本拆分，不泄露任何凭据。
 * @param {string|null} searchStatus 最近一次 searchWeb 真实调用状态（available/quota_exhausted/timeout/error/unknown） */
export function capabilities(llmReady, webSearchReady, searchStatus = 'unknown') {
  return {
    llm: !!llmReady,
    web_search_configured: !!webSearchReady,
    web_search_status: searchStatus,
    trip_planner_version: 'retired',
    anywhere_planner_version: SEARCH_PLANNER_VERSION,
    planning_mode:'search_first',search_planner_version:SEARCH_PLANNER_VERSION
  };
}

const ROUND_TRIP_RE = /来回|往返|再回|回来|返回|然后回|玩.*天.*回/;
/* v0.26.3 复审③：「直达」只说明交通偏好，不代表单程——只有明确表述才确定 one_way */
const ONE_WAY_RE = /单程|只去不回|不去别处/;
const SOLO_RE = /一个人|独自|单独|solo/i;
const PAIR_RE = /两个人|两人|双人|和朋友|和对象/;
/* v0.26.3 复审②：「国庆附近/前后/期间」保留弹性假期区间，不得收缩为 10/01 单日 */
const NEAR_HOLIDAY_RE = /国庆\s*(?:附近|前后|期间|那几天)/;
const EXPLICIT_DATE_RE = /(?:(20\d{2})\s*(?:年|[/-])\s*)?(\d{1,2})\s*(?:月|[/-])\s*(\d{1,2})\s*(?:日|号)?/g;
const HOLIDAY_RANGE_RE = /(?:(20\d{2})\s*年\s*)?国庆(?:节)?\s*(\d{1,2})\s*(?:日|号)?\s*[-~～—至到]\s*(\d{1,2})\s*(?:日|号)/g;
const MONTH_RANGE_RE = /(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?\s*[-~～—至到]\s*(\d{1,2})\s*(?:日|号)/g;

function dateWindow(year, month, start, end) {
  const valid = (day) => {
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  };
  if (month < 1 || month > 12 || start < 1 || end < start || !valid(start) || !valid(end)) return null;
  const iso = (day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return `${iso(start)} ~ ${iso(end)}`;
}

function dateRole(after) {
  if (/^\s*(?:回来|返回|返程|回程|回国|回家)/.test(after)) return 'return';
  if (/^\s*(?:之间|之前|前|左右)?\s*(?:到达|抵达|落地|到(?!\s*\d))/.test(after)) return 'arrival';
  if (/^\s*(?:之间|左右)?\s*(?:出发|启程|动身)/.test(after)) return 'outbound';
  return 'unmarked';
}

/** 一句话中的明确日期；到达窗不冒充去程出发窗，返程日也不冒充去程。 */
export function extractExplicitOutboundDate(text, nowMs = Date.now()) {
  const t = String(text || '');
  const now = new Date(nowMs);
  let sawDate = false;
  let firstUnmarked = null;
  let markedOutbound = null;
  let arrivalWindow = null;
  const spans = [];
  for (const [re, holiday] of [[HOLIDAY_RANGE_RE, true], [MONTH_RANGE_RE, false]]) {
    for (const m of t.matchAll(re)) {
      sawDate = true;
      spans.push([m.index, m.index + m[0].length]);
      const month = holiday ? 10 : Number(m[2]);
      const start = Number(holiday ? m[2] : m[3]);
      const end = Number(holiday ? m[3] : m[4]);
      let year = m[1] ? Number(m[1]) : holiday ? Number(nationalHolidayWindow(nowMs).slice(0, 4)) : now.getFullYear();
      if (!m[1] && !holiday && Date.UTC(year, month - 1, end) < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
      const window = dateWindow(year, month, start, end);
      if (!window) continue;
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12).split(/[，,。！？；;]/)[0];
      const role = dateRole(after);
      if (role === 'arrival' && !arrivalWindow) arrivalWindow = window;
      else if (role === 'outbound' && !markedOutbound) markedOutbound = window;
      else if (role === 'unmarked' && !firstUnmarked) firstUnmarked = window;
    }
  }
  for (const m of t.matchAll(EXPLICIT_DATE_RE)) {
    if (spans.some(([start, end]) => m.index < end && m.index + m[0].length > start)) continue;
    /* 「1-3号」缺月份时是日期范围，不是 1 月 3 日。 */
    if (!m[1] && !m[0].includes('月') && m[0].endsWith('号')) { sawDate = true; continue; }
    sawDate = true;
    const before = t.slice(Math.max(0, m.index - 12), m.index).split(/[，,。！？；;]/).pop();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12).split(/[，,。！？；;]/)[0];
    if (/(?:返程|回程|回来|返回|回国|回家|回)\s*$/.test(before) || /^\s*(?:返程|回程|回来|返回|回国|回家|回)/.test(after)) continue;
    const month = Number(m[2]), day = Number(m[3]);
    let year = m[1] ? Number(m[1]) : now.getFullYear();
    if (!dateWindow(year, month, day, day)) continue;
    if (!m[1] && Date.UTC(year, month - 1, day) < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
    const window = dateWindow(year, month, day, day);
    if (!window) continue;
    const role = dateRole(after);
    if (role === 'arrival') { if (!arrivalWindow) arrivalWindow = window; continue; }
    if (/(?:去程|出发|启程|动身)\s*$/.test(before) || role === 'outbound') { if (!markedOutbound) markedOutbound = window; continue; }
    if (!firstUnmarked) firstUnmarked = window;
  }
  return { window: markedOutbound || firstUnmarked, arrival_window: arrivalWindow, sawDate };
}

/** 当年（已过 10/7 则次年）国庆假期宽窗——2026 为中秋 9/25-27 + 国庆 10/1-7 连休 */
export function nationalHolidayWindow(nowMs = Date.now()) {
  const now = new Date(nowMs);
  let year = now.getFullYear();
  if (now > new Date(year, 9, 7, 23, 59, 59)) year += 1;
  return `${year}-09-27 ~ ${year}-10-07`;
}

/** 从一句话里提取非 OD 意图字段（往返/人数/弹性假期窗）。确定性，不依赖 LLM。 */
export function extractIntentFields(text, nowMs = Date.now()) {
  const t = String(text || '');
  const intent = {};
  if (ROUND_TRIP_RE.test(t)) intent.trip_type = 'round_trip';
  else if (ONE_WAY_RE.test(t)) intent.trip_type = 'one_way';
  if (SOLO_RE.test(t)) intent.traveler_count = 1;
  else if (PAIR_RE.test(t)) intent.traveler_count = 2;
  const explicit = extractExplicitOutboundDate(t, nowMs);
  if (explicit.window) intent.outbound_window = explicit.window;
  else if (!explicit.arrival_window && NEAR_HOLIDAY_RE.test(t)) intent.outbound_window = nationalHolidayWindow(nowMs);
  if (explicit.arrival_window) intent.arrival_window = explicit.arrival_window;
  return intent;
}
