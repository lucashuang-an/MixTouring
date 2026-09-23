/* lib/anywhere.mjs · G2.5 任意地点规划（v0.31.0 修复卡）
 * 评审驱动（Issue #5 对 8685a56 的需修复结论）：
 *   P0-1 开放地点解析（安全两阶段）：词典未命中 → LLM 只提标准化候选（不进事实层）
 *        → OpenStreetMap Nominatim 可核验来源确认（国家/类型/坐标/稳定标识/来源 URL）
 *        → 用户确认后生成「本次请求内」动态 Place（带 resolution_state/source_url/resolved_at）
 *        → 未确认前禁止生成交通候选；无法核验则诚实阻断。两字段与一句话共用同一流程。
 *   P0-2 线索与事实分层：搜索命中只升为 source_lead（搜索线索），须同时命中该段两端地点与交通方式；
 *        候选仍是假设；只有后续结构化事实才进入既有 dated_partial/dated_verified 证据链。
 *   P1-3 国际直达多交通方式：不再把 international 等同航班——直达航班假设与直达铁路假设并存，取证后再保留成立者。
 *   P1-4 能力如实化：规划响应带本次 web_search 配置与最近真实状态（configured ≠ available）。
 * 防幻觉契约（延续 v0.30.0）：候选一律 candidate_hypothesis、无未取证数字；LLM 提名只从清单选；
 *   识别不了、核验不了 → 明确阻断，不猜。 */

import { callJson as callJsonDefault, searchWeb as searchWebDefault, webSearchStatus as webSearchStatusDefault } from './llm.mjs';
import { assignFromTo } from './parse.mjs';
import { loadPlaces, webSearchConfigured, extractIntentFields } from './trip-service.mjs';
import { candidatesBetween, haversineKm } from '../../pipeline/lib/geo-skill.mjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ANYWHERE_PLANNER_VERSION } from './versions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ANYWHERE_VERSION = ANYWHERE_PLANNER_VERSION;

const PLACE_KINDS = ['city', 'airport', 'station', 'poi'];

/* ---------- PlaceResolver（词典精确名 + 别名；拉丁字母不区分大小写；返回浅拷贝防缓存污染） ---------- */

const LATIN_RE = /^[A-Za-z][A-Za-z'\- ]*$/;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 整串解析：输入即地点名或别名（两字段入口用）。命中返回 {…place, matched_via}，未命中 null。 */
export function resolvePlace(text) {
  const n = String(text || '').trim();
  if (!n) return null;
  for (const p of loadPlaces()) {
    if (p.name === n) return { ...p, matched_via: 'name' };
    for (const a of p.aliases || []) {
      if (a === n || (LATIN_RE.test(a) && a.toLowerCase() === n.toLowerCase())) {
        return { ...p, matched_via: 'alias:' + a };
      }
    }
  }
  return null;
}

let MENTION_INDEX = null;
function mentionIndex() {
  if (!MENTION_INDEX) {
    const tokens = [];
    for (const p of loadPlaces()) {
      tokens.push({ token: p.name, latin: LATIN_RE.test(p.name), place: p });
      for (const a of p.aliases || []) tokens.push({ token: a, latin: LATIN_RE.test(a), place: p });
    }
    tokens.sort((x, y) => y.token.length - x.token.length); /* 最长优先：北京南站 先于 北京 命中 */
    MENTION_INDEX = tokens;
  }
  return MENTION_INDEX;
}

/** 一句话扫描：返回按出现位置排序的地点提及 [{idx, token, place}]。
 * 最长优先 + 相邻即冲突：长词先占位，紧邻其前后的短词视为同一地点短语的一部分（「北京首都机场」
 * 由「首都机场」整段命中，「北京」不再单独成提及）；拉丁别名单词不区分大小写。 */
export function scanPlaceMentions(text) {
  const t = String(text || '');
  if (!t) return [];
  const spans = [];
  const taken = [];
  const conflicts = (i, len) => taken.some(([s, e]) => i <= e && i + len >= s);
  for (const { token, latin, place } of mentionIndex()) {
    if (latin) {
      const re = new RegExp(escapeRe(token), 'gi');
      let m;
      while ((m = re.exec(t)) !== null) {
        if (!conflicts(m.index, token.length)) {
          spans.push({ idx: m.index, token, place: { ...place, matched_via: 'alias:' + token } });
          taken.push([m.index, m.index + token.length]);
        }
      }
    } else {
      let i = t.indexOf(token);
      while (i !== -1) {
        if (!conflicts(i, token.length)) {
          spans.push({ idx: i, token, place: { ...place, matched_via: 'name' } });
          taken.push([i, i + token.length]);
        }
        i = t.indexOf(token, i + 1);
      }
    }
  }
  return spans.sort((a, b) => a.idx - b.idx);
}

/* ---------- 约束化 Intent（确定性规则提取；数字只来自用户输入） ---------- */

const NIGHT_AVOID_RE = [
  /(?:不|别|不想|拒绝|避免|不接受)[^。！？，,]{0,6}(?:半夜|凌晨|夜间|夜里|红眼)[^。！？，,]{0,4}(?:到|到达|抵达|落地|航班)/,
  /红眼(?:航班)?[^。！？，,]{0,4}(?:不|不想|拒绝)/
];
const NIGHT_ALLOW_RE = [
  /(?:可以|接受|能接受|无所谓|不介意|没关系)[^。！？，,]{0,6}(?:半夜|凌晨|夜间|夜里|红眼)/,
  /红眼(?:航班)?(?:也行|无所谓|可以|OK|ok)/
];

/** 从一句话提取四类约束（预算/最长中转时长/夜间到达/换乘次数）。确定性；识别不到的字段不出现。 */
export function extractConstraints(text) {
  const t = String(text || '');
  const c = {};
  let m;
  if ((m = t.match(/预算\s*(?:不超过|最多|约|大概|为)?\s*(\d{3,6})\s*(?:元|块|人民币|CNY)/i)) ||
      (m = t.match(/(\d{3,6})\s*(?:元|块)\s*(?:以内|之内|的?预算)/))) c.budget_max_cny = +m[1];
  if ((m = t.match(/(?:中转|转机)[^。！？，,]{0,10}?(?:不超过|最多|少于|短于)?\s*(\d{1,2}(?:\.\d)?)\s*个?小时/))) c.max_layover_hours = +m[1];
  if (NIGHT_AVOID_RE.some((re) => re.test(t))) c.night_arrival = 'avoid';
  else if (NIGHT_ALLOW_RE.some((re) => re.test(t))) c.night_arrival = 'allow';
  if ((m = t.match(/(?:换乘|转乘|中转|转机)[^。！？，,]{0,8}?(?:不超过|最多|少于)?\s*([0-2])\s*次/))) c.max_transfers = +m[1];
  else if (/不想换乘|不换乘|不转乘|拒绝换乘/.test(t)) c.max_transfers = 0;
  return c;
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
  return chips;
}

/** 显式传入的约束（UI 字段）白名单化：类型/范围不对的丢弃，不猜。 */
function sanitizeConstraints(raw) {
  const c = {};
  if (!raw || typeof raw !== 'object') return c;
  const b = Number(raw.budget_max_cny);
  if (Number.isFinite(b) && b >= 100 && b <= 1000000) c.budget_max_cny = Math.round(b);
  const l = Number(raw.max_layover_hours);
  if (Number.isFinite(l) && l > 0 && l <= 48) c.max_layover_hours = Math.round(l * 10) / 10;
  if (raw.night_arrival === 'avoid' || raw.night_arrival === 'allow') c.night_arrival = raw.night_arrival;
  const tr = Number(raw.max_transfers);
  if (Number.isInteger(tr) && tr >= 0 && tr <= 2) c.max_transfers = tr;
  return c;
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

/** 从一句话提取返程日期（M月D日 / M-D / M/D 紧跟或前接「回来/返回/回程/返程」），代码计算年份。
 *  十二轮 P1：产出日期须过真实日历校验（Date 溢出回读一致）——2月31日/4月31日等不存在日期返回 null。 */
export function extractReturnDate(text, nowMs = Date.now()) {
  const t = String(text || '');
  const m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?[^。！？，,]{0,8}?(?:回来|返回|回程|返程|回)/) ||
    t.match(/(?:回来|返回|回程|返程)[^。！？，,]{0,4}(\d{1,2})\s*月\s*(\d{1,2})\s*日?/) ||
    t.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})[^。！？，,]{0,8}?(?:回来|返回|回程|返程)/);
  if (!m) return null;
  const month = +m[1], day = +m[2];
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  /* 年份代码推算：目标日已过（当年口径）则次年（禁心算） */
  const now = new Date(nowMs);
  let year = now.getFullYear();
  const build = (y) => new Date(Date.UTC(y, month - 1, day));
  if (build(year) < new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))) year += 1;
  /* 真实日历校验：Date 会把 02-31 卷到 03-03，回读不一致即非法（十二轮 P1） */
  const built = build(year);
  if (built.getUTCMonth() !== month - 1 || built.getUTCDate() !== day) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return `${iso} ~ ${iso}`;
}

/** 显式行程意图字段（UI）白名单化：枚举/真实日历/范围不对的丢弃，不猜（十一轮 P1：无效日期不得当已确认事实）。 */
function sanitizeIntentFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (['pending', 'round_trip', 'one_way'].includes(raw.trip_type)) out.trip_type = raw.trip_type;
  if (isValidWindow(raw.outbound_window)) out.outbound_window = raw.outbound_window;
  if (isValidWindow(raw.return_window)) out.return_window = raw.return_window;
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
  if (finalIntent.trip_type === 'round_trip') {
    if (!finalIntent.outbound_window) needs.push('往返行程请补去程日期或大致窗口');
    if (!finalIntent.return_window) needs.push('往返行程请补返程日期（未补前不展示返程样本）');
  }
  if (returnClearedByType) needs.push('行程类型为' + (finalIntent.trip_type === 'one_way' ? '单程' : '待确认') + '：已忽略返程日期，如需往返请把行程类型改为往返');
  if (returnDropped) needs.push('返程窗口早于去程：已忽略该返程窗口，请修正后重试');
  return { intent: finalIntent, needs };
}

/* ---------- 路由判定（词典与动态地点对象共用同一规则，与 trip-service.resolveRoute 口径一致） ---------- */

function isDomesticPair(o, d) {
  const dom = (p) => p.country === 'CN' && p.is_mainland === true;
  return !!(o && d && dom(o) && dom(d));
}

export function routeTypeOf(o, d) {
  if (!o || !d) return 'needs_confirmation';
  return isDomesticPair(o, d) ? 'domestic' : 'international';
}

/* ---------- 开放地点解析（P0-1 安全两阶段） ---------- */

function llmPlaceCandidatesPrompt() {
  return '你是 MixTouring 的开放地点候选生成器。用户给出一个未收录的地点表述，请提出最多 3 个标准化地点候选，' +
    '用于后续地理编码核验。只输出 JSON 对象：{"candidates":[{"name":"规范中文名","name_latin":"用于地理编码的拉丁字母或当地语言名",' +
    '"kind":"city|airport|station|poi","country":"ISO 3166-1 alpha-2 大写两字母（不确定置 null）",' +
    '"country_name":"中文国家/地区名（不确定置 null）","note":"一句话依据（不得出现任何数字）"}]}。' +
    '不是地点、乱码或过于含糊时返回 {"candidates":[]}。绝不编造：所有不确定字段置 null。';
}

/** OSM Nominatim 地理编码（可核验地点来源：国家/类型/坐标/稳定标识 + 来源 URL）。
 * 遵守其用量政策：低频调用 + 自识别 User-Agent；基址可用 OSM_NOMINATIM_BASE 覆盖（自建镜像/代理）。
 * 注：部分网络环境 Nominatim 不可达（如国内默认线路超时），由 geocodeDefault 落到 Photon 第二通道。 */
export async function osmSearch(query, { limit = 3, timeoutMs = 8000 } = {}) {
  const base = (process.env.OSM_NOMINATIM_BASE || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
  const url = base + '/search?' + new URLSearchParams({
    q: String(query).slice(0, 120), format: 'jsonv2', addressdetails: '1',
    limit: String(limit), accept_language: 'zh'
  });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MixTouring/dev (+https://github.com/lucashuang-an/MixTouring; place verification)' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error('OSM HTTP ' + res.status);
  const arr = await res.json();
  return (Array.isArray(arr) ? arr : []).map((r) => ({
    display_name: r.display_name || '',
    country: String((r.address && r.address.country_code) || '').toUpperCase(),
    lat: r.lat != null ? String(r.lat) : null,
    lon: r.lon != null ? String(r.lon) : null,
    type: r.type || null,
    category: r.category || r.class || null,
    osm_type: r.osm_type || null,
    osm_id: r.osm_id != null ? String(r.osm_id) : null,
    url: r.osm_type && r.osm_id != null ? 'https://www.openstreetmap.org/' + r.osm_type + '/' + r.osm_id : null,
    source_name: 'OpenStreetMap (Nominatim)'
  }));
}

/** Photon（Komoot 的 OSM 地理编码服务）：Nominatim 不可达时的第二核验通道，同样返回稳定 OSM 标识。 */
export async function photonSearch(query, { limit = 3, timeoutMs = 8000 } = {}) {
  const url = 'https://photon.komoot.io/api?' + new URLSearchParams({ q: String(query).slice(0, 120), limit: String(limit) });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MixTouring/dev (+https://github.com/lucashuang-an/MixTouring; place verification)' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error('Photon HTTP ' + res.status);
  const body = await res.json();
  const osmTypeMap = { R: 'relation', N: 'node', W: 'way' };
  return (body.features || []).map((f) => {
    const p = f.properties || {};
    const osmType = osmTypeMap[p.osm_type] || null;
    const osmId = p.osm_id != null ? String(p.osm_id) : null;
    const coords = f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
    return {
      display_name: [p.name, p.city, p.state, p.country].filter(Boolean).join(', '),
      country: String(p.countrycode || '').toUpperCase(),
      lat: coords ? String(coords[1]) : null,
      lon: coords ? String(coords[0]) : null,
      type: p.osm_value || p.type || null,
      category: p.osm_key || null,
      osm_type: osmType, osm_id: osmId,
      url: osmType && osmId ? 'https://www.openstreetmap.org/' + osmType + '/' + osmId : null,
      source_name: 'OpenStreetMap (Photon)'
    };
  });
}

/** 地点核验默认通道：Nominatim 优先，超时/失败落到 Photon；两者都失败才判定通道不可用。 */
export async function geocodePlace(query, opts) {
  try {
    const r = await osmSearch(query, opts);
    if (r.length) return r;
  } catch { /* 落第二通道 */ }
  return await photonSearch(query, opts);
}

export function osmKind(r) {
  const t = [r.type, r.category].filter(Boolean).join(' ').toLowerCase();
  if (/station|halt|tram_stop|railway/.test(t)) return 'station';
  if (/aerodrome|airport/.test(t)) return 'airport';
  if (/city|town|village|municipality|suburb|administrative|county|state|province/.test(t)) return 'city';
  return 'poi';
}

/**
 * 开放地点解析：LLM 候选（或无 LLM 时按原始表述）→ OSM 核验。
 * @returns {Promise<{candidates, blocked_reason?}>} candidates 为已核验（resolution_state='verified'）；
 *   blocked_reason: 'source_unavailable'（核验通道故障）| 'no_match'（无候选且无核验结果）——都诚实阻断。
 */
async function openResolvePlace(rawName, contextText, deps, degradations) {
  const callJson = deps.callJson || callJsonDefault;
  const osm = deps.osmSearch || geocodePlace;
  const raw = String(rawName || '').trim();
  if (!raw) return { candidates: [], blocked_reason: 'no_match' };

  let llmCands = [];
  if (callJson) {
    const out = await callJson({
      schema_prompt: llmPlaceCandidatesPrompt(),
      user: '地点表述：「' + raw + '」' + (contextText ? '（出行上下文：' + String(contextText).slice(0, 120) + '）' : ''),
      kind: 'anywhere'
    });
    if (out && Array.isArray(out.candidates)) {
      llmCands = out.candidates.filter((c) => c && typeof c.name === 'string' && c.name.trim());
    }
  }
  /* 无 LLM（未配 key）也能走核验：按原始表述直接地理编码 */
  const primary = (llmCands[0] && (llmCands[0].name_latin || llmCands[0].name)) || raw;

  let osmResults = null;
  try {
    osmResults = await osm(primary);
  } catch {
    osmResults = null;
  }
  if (osmResults === null) {
    degradations.push('地点「' + raw + '」的外部来源核验通道不可用（OSM Nominatim/Photon 均失败）：候选未核验，暂不能确认（诚实阻断，不猜）');
    return { candidates: [], blocked_reason: 'source_unavailable' };
  }
  if (!osmResults.length) {
    degradations.push('地点「' + raw + '」未找到可核验的外部来源：无法生成可确认候选（不猜）');
    return { candidates: [], blocked_reason: 'no_match' };
  }
  const seen = new Set();
  const candidates = [];
  const usedLlm = llmCands.length > 0;
  const storeOpts = deps.candidateStore ? { store: deps.candidateStore } : {};
  for (const r of osmResults) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const llmHit = usedLlm ? (llmCands.find((c) => c.country == null || c.country === r.country) || null) : null;
    const cand = {
      name: (llmHit && llmHit.name) || r.display_name.split(',')[0].trim() || raw,
      name_latin: (llmHit && llmHit.name_latin) || null,
      kind: (llmHit && PLACE_KINDS.includes(llmHit.kind) ? llmHit.kind : osmKind(r)),
      country: r.country || null,
      country_name: (llmHit && llmHit.country_name) || null,
      lat: r.lat, lon: r.lon,
      /* P1（十轮）：重名候选区分——完整行政层级描述 + 稳定标识，页面逐候选展示 */
      detail: r.display_name || null,
      osm_type: r.osm_type || null, osm_id: r.osm_id || null,
      no_direct_rail: false,
      source_url: r.url,
      source_name: r.source_name || 'OpenStreetMap',
      resolution_state: 'verified',
      note: (llmHit && llmHit.note) ||
        (usedLlm
          ? '由 OpenStreetMap 地理编码核验（国家/类型/坐标与稳定标识）'
          : '按原始表述直接核验（AI 候选不可用）：名称为字面匹配，请核对国家与类型后再确认'),
      resolved_at: new Date().toISOString()
    };
    cand.candidate_id = registerPlaceCandidate(cand, storeOpts); /* 事实只存服务端（P0-1） */
    candidates.push(cand);
  }
  return { candidates };
}

/* ---------- 候选存证（v0.32.0 P0-1：确认信任边界闭合） ----------
 * 服务端为每个已核验候选签发短时 candidate_id（随机不可猜），完整事实只存服务端；
 * 确认请求只提交标识，服务端从存证恢复 name/kind/country/lat/lon/source——
 * 浏览器回传的任何地点事实字段一律不采信（与 /api/trip/checklist 拒绝伪造策略同一原则）。
 * 未知 / 过期（30 分钟 TTL）/ 篡改均取不到存证 → 诚实拒绝。进程重启即失效（宁拒绝不降信任）。 */

const CANDIDATE_STORE = new Map(); /* id -> { cand, expires_at } */
const CANDIDATE_TTL_MS = 30 * 60 * 1000;
const CANDIDATE_STORE_MAX = 500;

function pruneCandidateStore(store, now) {
  for (const [id, v] of store) if (v.expires_at <= now) store.delete(id);
  while (store.size >= CANDIDATE_STORE_MAX) store.delete(store.keys().next().value);
}

/** 登记一个已核验候选，返回签发的 candidate_id。store/ttlMs/now 可注入（测试用）。 */
export function registerPlaceCandidate(cand, { store = CANDIDATE_STORE, ttlMs = CANDIDATE_TTL_MS, now = Date.now() } = {}) {
  pruneCandidateStore(store, now);
  const id = 'plc_' + randomBytes(9).toString('hex');
  store.set(id, { cand: { ...cand }, expires_at: now + ttlMs });
  return id;
}

/** 按 id 取存证候选（浅拷贝）；未知/过期返回 null。过期即删，不降级采信。 */
export function takePlaceCandidate(id, { store = CANDIDATE_STORE, now = Date.now() } = {}) {
  if (!id || typeof id !== 'string') return null;
  const v = store.get(id);
  if (!v) return null;
  if (v.expires_at <= now) { store.delete(id); return null; }
  return { ...v.cand, candidate_id: id };
}

/** 存证候选 → 本次请求内动态 Place（数据来自服务端存证，仅做形状兜底）。 */
function candidateToDynamic(cand) {
  if (!cand || typeof cand !== 'object') return null;
  const name = typeof cand.name === 'string' && cand.name.trim() ? cand.name.trim() : null;
  const kind = PLACE_KINDS.includes(cand.kind) ? cand.kind : null;
  const country = typeof cand.country === 'string' && /^[A-Z]{2}$/.test(cand.country) ? cand.country : null;
  const source = typeof cand.source_url === 'string' && /^https:/.test(cand.source_url) ? cand.source_url : null;
  if (!name || !kind || !country || !source) return null;
  return {
    name, kind, country,
    is_mainland: country === 'CN', /* 港澳台在 OSM/LLM 侧为独立国家/地区码，不会误落 CN */
    tz: null, city: null, aliases: [],
    lat: cand.lat != null ? String(cand.lat) : null,
    lon: cand.lon != null ? String(cand.lon) : null,
    detail: cand.detail || null,
    osm_type: cand.osm_type || null, osm_id: cand.osm_id || null,
    no_direct_rail: cand.no_direct_rail === true,
    resolution_state: 'user_confirmed',
    source_url: source, source_name: cand.source_name || 'OpenStreetMap',
    resolved_at: cand.resolved_at || new Date().toISOString(),
    dynamic: true,
    matched_via: 'confirmed'
  };
}

/** 从确认输入提取 candidate_id：只接受标识字符串或 {candidate_id}（其余字段无视）；
 *  浏览器自报的完整地点对象一律不采信（P0-1）。 */
function extractCandidateId(input) {
  if (typeof input === 'string') return input.trim() || null;
  if (input && typeof input === 'object' && typeof input.candidate_id === 'string') return input.candidate_id.trim() || null;
  return null;
}

/* ---------- CandidateBuilder：三类纯交通骨架（candidate_hypothesis，无未取证数字） ---------- */

/* ---------- P2：铁路核对入口按地区适配（中国大陆段 12306；其余指向当地运营方/官方渠道） ---------- */

const RAIL_CHANNEL_HINTS = {
  KZ: '到哈萨克斯坦国家铁路（KTZ）官方售票渠道核对该段车次',
  HK: '到港铁（MTR）高速铁路官方渠道或 12306 跨境票务核对该段车次',
  TW: '到台铁及台湾高速铁路官方渠道核对该段班次',
  MN: '到蒙古铁路官方渠道核对该段车次',
  RU: '到俄罗斯铁路（РЖД）官方渠道核对该段车次',
  VN: '到越南铁路官方渠道核对该段车次',
  DE: '到德国铁路（DB）官方渠道核对该段车次',
  FR: '到法国国家铁路（SNCF）官方渠道核对该段车次',
  CZ: '到捷克铁路（ČD）官方渠道核对该段车次',
  PL: '到波兰国营铁路（PKP）官方渠道核对该段车次',
  US: '到美国国家铁路（Amtrak）官方渠道核对该段班次',
  JP: '到日本 JR 官方渠道核对该段班次',
  KR: '到韩国铁道公社（KORAIL）官方渠道核对该段班次'
};

function railManualCheck(fromCountry, toCountry) {
  if (fromCountry === 'CN' && toCountry === 'CN') return '到 12306 核对该段车次';
  return RAIL_CHANNEL_HINTS[toCountry] || RAIL_CHANNEL_HINTS[fromCountry] ||
    '到当地铁路运营方/官方售票渠道核对该段班次（12306 仅适用中国大陆区段）';
}

function newLeg(seq, fromPlace, toPlace, modeGuess) {
  return {
    seq,
    from: fromPlace.name, from_kind: fromPlace.kind,
    to: toPlace.name, to_kind: toPlace.kind,
    via: null,
    mode_guess: modeGuess, /* 假设的交通方式（guess：待取证确认，非事实） */
    evidence_state: 'explore', /* explore | source_lead（P0-2：搜索线索，非取证） */
    sources: [],
    evidence_note: null,
    lead_query: null,
    manual_check: modeGuess === 'rail'
      ? railManualCheck(fromPlace.country, toPlace.country)
      : modeGuess === 'plane'
        ? '到航司官网/平台核对该段航班'
        : '到平台核对该段班期'
  };
}

/** 机场/车站/景点映射到 geo 库城市名（city 字段；无归属或非城市 → null） */
function geoCityName(place) {
  if (place.kind === 'city') return place.name;
  return place.city || null;
}

const HUB_SOURCE_LABEL = { 'rule:geo': '按地理顺路筛选（确定性估算，非班期事实）', 'llm': '由 AI 从已收录城市中提名（待验证假设）' };

export const KIND_LABEL = { direct: '直达', one_transfer: '一次中转', mixed: '混合交通' };
export const DIRECT_VARIANT_LABEL = { plane: '直达航班假设', rail: '直达铁路假设' };

/* ---------- v0.33.0（八轮评审）：直达铁路判定 = 负向粗筛 + 正向依据 ----------
 * 距离/旗标只做负向粗筛（veto），不构成生成依据；「直达铁路假设」必须有正向依据：
 * 已知线路走廊（rail-corridors.json：公开常识线路或项目结构化班期证据）。
 * 只有地理可能性（距离在量级内、无旗标拦截、无走廊依据）时不出卡，
 * 降为 explorations 的「铁路/陆路方向探索」提示。旗标仅约束跨境/跨区场景——
 * 区域内部线路（如台北—高雄）由走廊数据判定，不受旗标误伤（八轮评审反例）。 */
export const RAIL_DIRECT_MAX_KM = 4500;

let CORRIDORS = null;
function loadRailCorridors() {
  if (!CORRIDORS) {
    try { CORRIDORS = JSON.parse(readFileSync(join(ROOT, 'pipeline/data/rail-corridors.json'), 'utf8')).corridors || []; }
    catch { CORRIDORS = []; }
  }
  return CORRIDORS;
}

/** 铁路侧城市名（机场/车站/景点取就近已收录城市近似；无归属 → null） */
function railSideName(place) {
  if (place.kind === 'city') return place.name;
  return place.city || null;
}

function findCorridor(oa, da, list) {
  if (!oa || !da) return null;
  return (list || loadRailCorridors()).find((c) => (c.a === oa && c.b === da) || (c.a === da && c.b === oa)) || null;
}

/** 走廊有效性：status≠verified_knowledge 或 review_by（项目来源复核期限）已过 → 过期/异常（只降为探索，不出直达卡）。 */
export function corridorEffectiveStatus(c, nowMs = Date.now()) {
  if (c.status && c.status !== 'verified_knowledge') return String(c.status);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (c.review_by && c.review_by < today) return 'expired';
  return 'verified_knowledge';
}

/**
 * @param {object} opts { nowMs, corridors }（测试注入时钟与走廊清单）
 * @returns {{eligible, explore_hint, basis, reason?}}
 *   eligible=true  命中有效走廊（known-corridor，含结构化来源字段），可生成直达铁路卡（仍只是假设）
 *   explore_hint=true  仅地理可能或走廊过期 → 铁路/陆路方向探索（不出卡）
 *   两者皆 false  负向粗筛 veto（距离/旗标跨境/坐标缺失），连探索提示也不给
 */
export function railDirectEligibility(o, d, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const veto = (reason) => ({ eligible: false, explore_hint: false, basis: { rule: 'geo-veto', reason } });
  /* 旗标只在两端属不同国家/地区（跨境/跨海场景）时拦截；同区域内线路交给走廊数据判定 */
  if (o.no_direct_rail === true && o.country !== d.country) return veto('出发地为无跨境陆路铁路连接的地区（岛屿/无铁路口岸）');
  if (d.no_direct_rail === true && o.country !== d.country) return veto('目的地为无跨境陆路铁路连接的地区（岛屿/无铁路口岸）');
  if ([o.lat, o.lon, d.lat, d.lon].some((x) => x == null || Number.isNaN(Number(x)))) {
    return veto('端点坐标缺失，无法做距离负向粗筛（宁缺勿凑）');
  }
  const km = Math.round(haversineKm(Number(o.lat), Number(o.lon), Number(d.lat), Number(d.lon)));
  if (km > RAIL_DIRECT_MAX_KM) {
    return veto('两端大圆距离约 ' + km + 'km，超过 ' + RAIL_DIRECT_MAX_KM + 'km 陆路负向粗筛门槛');
  }
  const corridor = findCorridor(railSideName(o), railSideName(d), opts.corridors);
  if (corridor) {
    const st = corridorEffectiveStatus(corridor, nowMs);
    if (st === 'verified_knowledge') {
      return {
        eligible: true, explore_hint: false,
        basis: {
          rule: 'known-corridor', corridor: corridor.note,
          evidence: corridor.evidence, evidence_grade: corridor.evidence_grade || null,
          source_url: typeof corridor.source_url === 'string' && /^https:/.test(corridor.source_url) ? corridor.source_url : null,
          sampled_at: corridor.sampled_at || null, review_by: corridor.review_by || null,
          corridor_status: st, within_km: km, threshold_km: RAIL_DIRECT_MAX_KM
        }
      };
    }
    return {
      eligible: false, explore_hint: true,
      basis: { rule: 'corridor-expired', corridor_status: st, review_by: corridor.review_by || null },
      reason: '走廊证据已过期或状态异常（' + st + '）：只降为铁路/陆路方向探索，待重新核对来源后恢复'
    };
  }
  return {
    eligible: false, explore_hint: true,
    basis: { rule: 'geo-plausible-only', within_km: km, threshold_km: RAIL_DIRECT_MAX_KM },
    reason: '距离在陆路量级但无已知直达铁路线路/班期依据：不生成直达铁路假设，转为铁路/陆路方向探索'
  };
}

/**
 * 生成三类骨架。hub 来源两级：geo 顺路候选（两端城市都在 geo 库，确定性）→ LLM 提名（清单内）。
 * P1-3：国际直达不再等同于航班——直达航班假设与直达铁路假设并存（如北京→香港跨境高铁），取证后再保留成立者。
 * @param {object} llmHints {one_transfer_city, mixed_rail_city}（城市清单校验在本函数消费点执行，清单外丢弃）
 * @returns {{candidates, degradations, constraint_notes}}
 */
/* ---------- G2.6（十四轮流转）：枢纽作用与已知连接 + 推荐三件套 + 直达合适判定 ---------- */

const HUB_DETOUR_MAX = 1.6; /* 与 geo-skill MAX_DETOUR_RATIO 同口径 */
export const DIRECT_OK_KM = 1300; /* 国内短距：直达航空/高铁通常已合适，不生成中转方向（不凑候选） */

let HUBS = null;
function loadTransferHubs() {
  if (!HUBS) {
    try { HUBS = JSON.parse(readFileSync(join(ROOT, 'pipeline/data/transfer-hubs.json'), 'utf8')).hubs || []; }
    catch { HUBS = []; }
  }
  return HUBS;
}

function hubInfo(name) {
  return loadTransferHubs().find((h) => h.name === name) || null;
}

/** 枢纽绕行比（防明显反向绕行）：(o→hub + hub→d) / o→d；任一坐标缺失 → null（无法校验）。 */
function hubDetourRatio(o, d, hubName) {
  const h = loadPlaces().find((p) => p.name === hubName && p.kind === 'city');
  if (!h || [o.lat, o.lon, d.lat, d.lon, h.lat, h.lon].some((x) => x == null || Number.isNaN(Number(x)))) return null;
  const direct = haversineKm(Number(o.lat), Number(o.lon), Number(d.lat), Number(d.lon));
  if (!direct) return null;
  const via = haversineKm(Number(o.lat), Number(o.lon), Number(h.lat), Number(h.lon)) +
    haversineKm(Number(h.lat), Number(h.lon), Number(d.lat), Number(d.lon));
  return Math.round((via / direct) * 100) / 100;
}

/**
 * 中转点选择（G2.6）：①国内双端在 geo 库 → 顺路候选（首位命中枢纽表时附枢纽依据）；
 * ②国际 OD → 枢纽表 gateway_for 匹配目的地方向 + 绕行比校验；③LLM 提名兜底（同样过绕行比）。
 * 返回 { one, mixed, degradations }——one/mixed 形如 { name, source, whys[] }。
 */
function pickTransferHubs(o, d, llmHints, degradations) {
  const one = { name: null, source: null, whys: [] };
  const mixed = { name: null, source: null, whys: [] };
  const fromCity = geoCityName(o);
  const toCity = geoCityName(d);
  const domesticGeo = isDomesticPair(o, d) && fromCity && toCity;

  if (domesticGeo) {
    const airHubs = candidatesBetween(fromCity, toCity, { mode: 'plane' });
    if (airHubs.length) {
      one.name = airHubs[0].name; one.source = 'rule:geo';
      one.whys.push('地理顺路窗口内绕行比最低的航空可达城市（确定性估算）');
      const hi = hubInfo(one.name);
      if (hi) one.whys.push(...hi.connection_notes.slice(0, 1));
    }
    const railHubs = candidatesBetween(fromCity, toCity, { mode: 'train' }).filter((h) => h.has_airport);
    if (railHubs.length) {
      mixed.name = railHubs[0].name; mixed.source = 'rule:geo';
      mixed.whys.push('铁路可达且具备机场的顺路城市，支撑「铁路+航空」组合（确定性估算）');
      const hi2 = hubInfo(mixed.name);
      if (hi2) mixed.whys.push(...hi2.connection_notes.slice(0, 1));
    }
  }

  /* 国际：枢纽表按目的地方向匹配（服务 dest 国家或方向），绕行比防反向 */
  if (!one.name || !mixed.name) {
    const destKey = d.country || '';
    const cands = loadTransferHubs()
      .filter((h) => h.gateway_for.some((g) => g === destKey || (d.country_name && d.country_name.includes(g))))
      .map((h) => ({ h, ratio: hubDetourRatio(o, d, h.name) }))
      .filter((x) => x.ratio != null && x.ratio <= HUB_DETOUR_MAX)
      .sort((a, b) => a.ratio - b.ratio);
    if (cands.length) {
      const best = cands[0];
      if (!one.name) {
        one.name = best.h.name; one.source = 'rule:hub';
        one.whys.push(...best.h.connection_notes);
      }
      /* mixed 需要 hub 在中国大陆（铁路起段假设），且出发地大陆 */
      const railEligible = o.country === 'CN' && o.is_mainland === true &&
        loadPlaces().some((p) => p.name === best.h.name && p.country === 'CN' && p.is_mainland === true);
      if (!mixed.name && railEligible) {
        mixed.name = best.h.name; mixed.source = 'rule:hub';
        mixed.whys.push(...best.h.connection_notes);
        mixed.whys.push('枢纽在中国大陆铁路网内，支撑铁路起段组合');
      }
    }
  }

  /* LLM 提名兜底（清单校验 + 绕行比校验在消费点） */
  const citySet = new Set(loadPlaces().filter((p) => p.kind === 'city').map((p) => p.name));
  const llmOk = (n) => n && citySet.has(n) && n !== o.name && n !== d.name;
  if (!one.name && llmOk(llmHints.one_transfer_city)) { one.name = llmHints.one_transfer_city; one.source = 'llm'; one.whys.push('由 AI 从已收录城市中提名（待验证假设）'); }
  if (!mixed.name && llmOk(llmHints.mixed_rail_city)) { mixed.name = llmHints.mixed_rail_city; mixed.source = 'llm'; mixed.whys.push('由 AI 从已收录城市中提名（待验证假设）'); }

  /* 防反向：任何来源的枢纽都过绕行比（能算则算） */
  for (const slot of [one, mixed]) {
    if (!slot.name) continue;
    const ratio = hubDetourRatio(o, d, slot.name);
    if (ratio != null && ratio > HUB_DETOUR_MAX) {
      degradations.push('中转城市「' + slot.name + '」绕行比 ' + ratio + ' 超过 ' + HUB_DETOUR_MAX + '（明显反向绕行）：该骨架未生成');
      slot.name = null; slot.source = null; slot.whys = [];
    }
  }
  return { one, mixed };
}

function legUncertain(fromName, toName, crossBorder) {
  if (crossBorder) return fromName + ' → ' + toName + ' 段：跨境班期、口岸/签证衔接未核验，是最不确定的一段';
  return fromName + ' → ' + toName + ' 段：具体班期与当日衔接未核验';
}

export function buildCandidateSkeletons(o, d, constraints, llmHints = {}) {
  const degradations = [];
  const constraint_notes = [];
  const explorations = [];
  const intl = !isDomesticPair(o, d);
  const fromCity = geoCityName(o);
  const toCity = geoCityName(d);

  const placeByName = (n) => loadPlaces().find((p) => p.name === n && p.kind === 'city');
  /* cities-geo 词典外顺路城市均为国内城市（geo-skill 为国内 179 城库）——骨架节点补国内属性，防误判跨境段 */
  const hubNode = (n) => placeByName(n) || { name: n, kind: 'city', country: 'CN', is_mainland: true };
  const candidates = [];

  /* 直达合适判定（G2.6）：国内短距直达航空/高铁通常已最优 → 只出直达，不生成中转方向（不凑候选） */
  const oDist = [o.lat, o.lon, d.lat, d.lon].every((x) => x != null && !Number.isNaN(Number(x)))
    ? haversineKm(Number(o.lat), Number(o.lon), Number(d.lat), Number(d.lon)) : null;
  const directSufficient = !intl && oDist != null && oDist <= DIRECT_OK_KM;

  /* ① 直达骨架：国内一张卡（方式未知待取证）；国际航班方向默认，铁路方向需正向依据（负向粗筛+走廊） */
  if (intl) {
    candidates.push({
      id: 'cand-direct-plane', kind: 'direct', variant: 'plane', hypothesis: true, transfers: 0, builder: 'rule',
      basis: { mode: 'plane', rule: 'intl-default', reason: '国际 OD 默认航班方向假设（是否成立待取证）' },
      legs: [newLeg(1, o, d, 'plane')],
      explanation: '假设存在直达航班：班期与价格待逐段取证，未取证前不做任何比较',
      why_explore: '直达航班是国际出行最直接的参照方案，先确认有无与大致价位，再判断中转是否值得',
      uncertain_leg: legUncertain(o.name, d.name, true),
      next_checks: ['查航司官网/平台该方向直达航班与当期价位', '若直达价位可接受，中转方案只在其明显更优时才值得继续查']
    });
    const rb = railDirectEligibility(o, d);
    if (rb.eligible) {
      candidates.push({
        id: 'cand-direct-rail', kind: 'direct', variant: 'rail', hypothesis: true, transfers: 0, builder: 'rule',
        basis: rb.basis,
        legs: [newLeg(1, o, d, 'rail')],
        explanation: '假设存在直达铁路方案：已有已知线路依据（详见 basis），班期、口岸衔接与是否直达待逐段取证，与航班假设并存供核验',
        why_explore: '该方向有已知铁路线路依据（见卡面来源），直达铁路在时间充裕时可能更省或体验不同',
        uncertain_leg: legUncertain(o.name, d.name, true),
        next_checks: ['核对该线路当期班期与购票渠道（见下方分地区入口）', '确认口岸/签证衔接要求']
      });
    } else if (rb.explore_hint) {
      explorations.push({
        type: 'land_rail',
        from: o.name, to: d.name,
        note: '地理距离在陆路可达量级，但无已知直达铁路线路或班期依据：可按「铁路/陆路方向」分段探索（例如先到铁路枢纽，再经陆路口岸或航班接驳）；取证到线路或班期后再生成直达假设',
        basis: rb.basis
      });
    } else {
      degradations.push('直达铁路假设未生成（负向粗筛，不凑固定卡数）：' + rb.basis.reason);
    }
  } else {
    candidates.push({
      id: 'cand-direct', kind: 'direct', hypothesis: true, transfers: 0, builder: 'rule',
      basis: { mode: 'unknown', rule: 'domestic-default', reason: '国内 OD 航空/铁路均可能，方式待取证确认' },
      legs: [newLeg(1, o, d, null)],
      explanation: '假设存在直达航班或直达列车：具体班期待逐段取证',
      why_explore: directSufficient
        ? '该距离直达航空/高铁通常已是最优选择，先按直达查证；中转方向一般不带来本质收益'
        : '直达是最直接的参照方案，先确认直达供给与价位，再判断中转/混合是否值得',
      uncertain_leg: legUncertain(o.name, d.name, false),
      next_checks: ['查直达航班与高铁班次供给', '记录直达价位作为比较基准']
    });
  }

  /* ②③ 中转/混合骨架：直达足够合适（国内短距）时不生成（不凑候选）；枢纽经 pickTransferHubs（顺路/枢纽/LLM 三级，防反向） */
  if (directSufficient) {
    constraint_notes.push('该国内 OD 距离在直达优势区间：未生成中转/混合方向（直达通常已合适，不凑候选数）');
  } else {
    const picked = pickTransferHubs(o, d, llmHints, degradations);
    if (picked.one.name) {
      const hubPlace = hubNode(picked.one.name);
      const crossBorder = o.country !== hubPlace.country || hubPlace.country !== d.country;
      candidates.push({
        id: 'cand-one-transfer',
        kind: 'one_transfer',
        hypothesis: true,
        transfers: 1,
        builder: picked.one.source,
        basis: { rule: picked.one.source === 'rule:hub' ? 'hub-network' : picked.one.source, whys: picked.one.whys },
        legs: [newLeg(1, o, hubPlace, null), newLeg(2, hubPlace, d, 'plane')],
        explanation: '假设经「' + picked.one.name + '」一次中转：' + (picked.one.source === 'rule:geo'
          ? '中转城市按地理顺路筛选（确定性估算，非班期事实）'
          : picked.one.source === 'rule:hub'
            ? '中转城市按枢纽作用与已知连接筛选（依据见下）'
            : '中转城市由 AI 从已收录城市中提名（待验证假设）') + '，衔接余量与两段班期待逐段取证',
        why_explore: picked.one.whys.join('；'),
        uncertain_leg: legUncertain(crossBorder ? hubPlace.name : o.name, crossBorder ? d.name : hubPlace.name, crossBorder),
        next_checks: crossBorder
          ? ['先核「' + hubPlace.name + ' → ' + d.name + '」段当期班期（最不确定段）', '再核起段班期与两段衔接余量', '跨境段另查口岸/签证要求']
          : ['核两段班期与衔接余量', '与直达价位对比后再决定是否值得']
      });
    } else {
      degradations.push('一次中转骨架需要中转城市来源（地理顺路/枢纽匹配/AI 提名），当前不可用：该骨架未生成');
    }
    const railEligible = o.country === 'CN' && o.is_mainland === true;
    if (picked.mixed.name && railEligible) {
      const hubPlace = hubNode(picked.mixed.name);
      const crossBorder = hubPlace.country !== d.country;
      candidates.push({
        id: 'cand-mixed',
        kind: 'mixed',
        hypothesis: true,
        transfers: 1,
        builder: picked.mixed.source,
        basis: { rule: picked.mixed.source === 'rule:hub' ? 'hub-network' : picked.mixed.source, whys: picked.mixed.whys },
        legs: [newLeg(1, o, hubPlace, 'rail'), newLeg(2, hubPlace, d, 'plane')],
        explanation: '假设先乘铁路到「' + picked.mixed.name + '」再飞往目的地的混合走法：' + (picked.mixed.source === 'rule:hub'
          ? '枢纽兼具铁路可达与航空衔接（依据见下）'
          : picked.mixed.source === 'rule:geo'
            ? '中转城市铁路与航空双可达（确定性估算）'
            : '由 AI 从已收录城市中提名（待验证假设）') + '，两段班期与衔接待逐段取证',
        why_explore: picked.mixed.whys.join('；'),
        uncertain_leg: legUncertain(hubPlace.name, d.name, crossBorder),
        next_checks: crossBorder
          ? ['核「' + hubPlace.name + ' → ' + d.name + '」航班/班期（最不确定段）', '铁路段到「' + hubPlace.name + '」的班次与耗时', '两段衔接预留时间']
          : ['铁路段班次与耗时', '航空段班期', '两段衔接预留时间']
      });
    } else if (!railEligible) {
      degradations.push('混合交通骨架假设大陆铁路起段，当前出发地不适用：该骨架未生成');
    } else {
      degradations.push('混合交通骨架需要铁路+航空双可达的中转城市来源，当前不可用：该骨架未生成');
    }
  }

  /* 约束应用：换乘次数可直接校验（结构事实）；预算/中转时长/夜间到达需取证到数字或时刻才能评估——如实说明 */
  if (constraints.max_transfers != null) {
    const kept = candidates.filter((c2) => c2.transfers <= constraints.max_transfers);
    const dropped = candidates.filter((c2) => c2.transfers > constraints.max_transfers);
    if (dropped.length) {
      constraint_notes.push('已按「换乘 ≤ ' + constraints.max_transfers + ' 次」过滤：' +
        dropped.map((c2) => candidateTitle(c2)).join('、') + ' 骨架未展示');
    }
    candidates.length = 0;
    candidates.push(...kept);
  }
  if (constraints.budget_max_cny != null) constraint_notes.push('预算约束需取证到价格样本后才能评估，当前不做任何断言');
  if (constraints.max_layover_hours != null) constraint_notes.push('最长中转时长约束需取证到两段班期后才能校验衔接余量');
  if (constraints.night_arrival) constraint_notes.push('夜间到达约束需取证到段到达时刻后才能校验（骨架阶段无时刻）');

  return { candidates, degradations, constraint_notes, explorations };
}

function candidateTitle(c) {
  return c.variant ? DIRECT_VARIANT_LABEL[c.variant] : KIND_LABEL[c.kind];
}

/* ---------- 逐段搜索线索（P0-2：source_lead ≠ 取证；相关性门槛；失败保持探索态） ---------- */

function searchQueryFor(leg) {
  const modeWord = leg.mode_guess === 'rail' ? '火车' : leg.mode_guess === 'plane' ? '航班' : '交通';
  return leg.from + ' 到 ' + leg.to + ' ' + modeWord + ' 怎么走';
}

/** 相关性判定：来源文本须同时命中该段两端地点名与交通方式词（大小写不敏感）。 */
export function resultRelevance(r, leg) {
  const hay = (String(r.title || '') + ' ' + String(r.content || '')).toLowerCase();
  const from = String(leg.from).toLowerCase();
  const to = String(leg.to).toLowerCase();
  const modeRe = leg.mode_guess === 'rail'
    ? /火车|铁路|高铁|动车|train|rail/
    : leg.mode_guess === 'plane'
      ? /航班|飞机|直飞|air\s|airline|flight|fly/
      : null;
  return {
    from_hit: !!from && hay.includes(from),
    to_hit: !!to && hay.includes(to),
    mode_hit: modeRe ? modeRe.test(hay) : true
  };
}

/** 逐段搜索线索：同查询缓存（限速纪律）；来源只保留 https 且通过相关性判定（v0.31.0 P0-2）；
 *  记录查询词与逐源相关性；不展示摘要防数字误引；无相关结果保持探索态。 */
export async function verifyLegs(candidates, searchFn) {
  if (!searchFn) return { leads: 0 };
  const cache = new Map();
  let leads = 0;
  for (const cand of candidates) {
    for (const leg of cand.legs) {
      const q = searchQueryFor(leg);
      leg.lead_query = q;
      let res = cache.get(q);
      if (res === undefined) {
        res = await searchFn(q);
        cache.set(q, res);
      }
      const relevant = [];
      for (const r of (res || [])) {
        if (!(r && typeof r.link === 'string' && /^https:/.test(r.link))) continue;
        const rel = resultRelevance(r, leg);
        if (rel.from_hit && rel.to_hit && rel.mode_hit) {
          relevant.push({ title: String(r.title || '').slice(0, 120), link: r.link, sampled_at: new Date().toISOString(), relevance: rel });
        }
      }
      if (relevant.length) {
        leg.evidence_state = 'source_lead';
        leg.sources = relevant.slice(0, 3);
        leg.evidence_note = '搜索线索（命中该段两端与方式；非班期核验）';
        leads++;
      }
    }
  }
  return { leads };
}

/* ---------- 编排：解析（词典 → 开放两阶段 → 确认） → 约束 → 骨架 → 线索检索（可用才检索，否则明确降级） ---------- */

function llmResolvePrompt(namesJson) {
  return '你是 MixTouring 的地点解析器。从用户一句话中识别出发地与目的地，只能从下列已收录地点清单中选择' +
    '（含城市/机场/车站/景点的名称与常见别名）；识别不了就置 null，绝不编造。只输出 JSON 对象：' +
    '{"origin":"清单内地点名|null","destination":"清单内地点名|null"}。清单：' + namesJson;
}

function llmExtractRawPrompt() {
  return '从用户的一句出行描述中提取「出发地」与「目的地」的原文子串：逐字照抄、不改写、不翻译、不补全；' +
    '提取不出就置 null。只输出 JSON 对象：{"origin_raw":"原文子串|null","destination_raw":"原文子串|null"}。';
}

function llmHubPrompt(citiesJson, originName, destName) {
  return '你是 MixTouring 的中转提名器。为 ' + originName + ' → ' + destName + ' 的行程提名两个中转城市：' +
    'one_transfer_city（一次航班中转的城市）与 mixed_rail_city（先铁路抵达、再飞往目的地的中转城市）。' +
    '只能从下列已收录城市清单中选择，选不了就置 null，绝不编造，理由里不得出现任何数字。只输出 JSON 对象：' +
    '{"one_transfer_city":"清单内城市|null","mixed_rail_city":"清单内城市|null","note":"一句话理由（无数字）"}。清单：' + citiesJson;
}

/**
 * G2.5 任意地点规划入口。
 * @param {object} input {text} 一句话模式，或 {origin, destination, constraints} 两字段模式（约束可显式传入覆盖文本提取）；
 *   confirmed_places {origin, destination}：用户在确认卡选择的已核验候选（上一次响应 place_candidates 中的一项）。
 * @param {object} deps 测试注入 {callJson, searchWeb, osmSearch, env, webSearchStatus}
 */
export async function planAnywhere(input, deps = {}) {
  const callJson = deps.callJson || callJsonDefault;
  const env = deps.env || process.env;
  const degradations = [];
  const needs = [];
  const places = loadPlaces();
  const allNames = places.map((p) => p.name);
  const cityNames = places.filter((p) => p.kind === 'city').map((p) => p.name);
  const place_candidates = { origin: [], destination: [] };

  let o = null, d = null;
  let parse_engine = 'none';
  let confirmedUsed = false;
  const rawOrigin = input.origin != null ? String(input.origin).trim() : null;
  const rawDest = input.destination != null ? String(input.destination).trim() : null;
  const text = input.text != null ? String(input.text) : null;

  /* 词典解析（两字段 = 精确/别名；一句话 = 扫描 + from/to 判定 → LLM 65 词表兜底） */
  if (rawOrigin || rawDest) {
    o = rawOrigin ? resolvePlace(rawOrigin) : null;
    d = rawDest ? resolvePlace(rawDest) : null;
    parse_engine = (o || d) ? 'dict' : 'none';
  } else if (text) {
    const seq = scanPlaceMentions(text).map((s) => ({ city: s.place.name, idx: s.idx }));
    const ft = assignFromTo(text, seq);
    const byName = new Map(places.map((p) => [p.name, p]));
    o = ft.from ? byName.get(ft.from) || null : null;
    d = ft.to ? byName.get(ft.to) || null : null;
    const dictO = !!o, dictD = !!d;
    if (!o || !d) {
      const llmOut = await callJson({
        schema_prompt: llmResolvePrompt(JSON.stringify(allNames)),
        user: '行程：' + text,
        kind: 'anywhere'
      });
      if (llmOut && typeof llmOut === 'object') {
        const lo = allNames.includes(llmOut.origin) ? byName.get(llmOut.origin) : null;
        const ld = allNames.includes(llmOut.destination) ? byName.get(llmOut.destination) : null;
        o = o || lo;
        d = d || ld;
      }
    }
    const llmFilled = (!dictO && o) || (!dictD && d);
    parse_engine = (dictO || dictD)
      ? (o && d ? (llmFilled ? 'dict+llm' : 'dict') : 'dict-partial')
      : (o || d ? 'llm' : 'none');
  }

  /* 用户确认（P0-1）：只接受服务端签发的 candidate_id，事实从存证恢复；
   * 完整对象/伪造字段/未知/过期一律拒绝，不采信浏览器自报数据 */
  const storeOpts = deps.candidateStore ? { store: deps.candidateStore } : {};
  const conf = input.confirmed_places || {};
  if (!o && conf.origin != null) {
    const stored = takePlaceCandidate(extractCandidateId(conf.origin), storeOpts);
    if (stored) { o = candidateToDynamic(stored); confirmedUsed = true; }
    else needs.push('出发地确认候选无效或已过期（确认卡候选 30 分钟内有效）：请重新规划再选择；不接受自行拼装的地点数据');
  }
  if (!d && conf.destination != null) {
    const stored = takePlaceCandidate(extractCandidateId(conf.destination), storeOpts);
    if (stored) { d = candidateToDynamic(stored); confirmedUsed = true; }
    else needs.push('目的地确认候选无效或已过期（确认卡候选 30 分钟内有效）：请重新规划再选择；不接受自行拼装的地点数据');
  }
  if (confirmedUsed) parse_engine = parse_engine === 'none' ? 'confirmed' : parse_engine + '+confirmed';

  /* 开放地点解析（P0-1）：未识别端点 → LLM 候选 + OSM 核验 → place_candidates 待用户确认 */
  const openResolve = async (endpoint, rawLabel) => {
    const res = await openResolvePlace(rawLabel, text, { callJson, osmSearch: deps.osmSearch }, degradations);
    place_candidates[endpoint] = res.candidates;
    if (res.candidates.length) {
      needs.push((endpoint === 'origin' ? '出发地' : '目的地') + '「' + rawLabel + '」为新地点，已生成 ' +
        res.candidates.length + ' 个已核验候选：请在确认卡中选择后继续（未确认前不生成交通候选；候选 30 分钟内有效）');
    } else if (res.blocked_reason === 'source_unavailable') {
      needs.push((endpoint === 'origin' ? '出发地' : '目的地') + '「' + rawLabel + '」外部核验通道不可用，暂不能确认新地点');
    } else {
      needs.push((endpoint === 'origin' ? '出发地' : '目的地') + '「' + rawLabel + '」无法核验：请换一个表述或使用已收录地点');
    }
  };
  if (!o || !d) {
    let originRaw = rawOrigin, destRaw = rawDest;
    if (text) {
      /* 一句话模式：先提取未识别端点的原文子串（逐字照抄），再进开放解析 */
      const ex = await callJson({ schema_prompt: llmExtractRawPrompt(), user: text, kind: 'anywhere' });
      if (ex && typeof ex === 'object') {
        if (!o && !originRaw && typeof ex.origin_raw === 'string' && ex.origin_raw.trim()) originRaw = ex.origin_raw.trim();
        if (!d && !destRaw && typeof ex.destination_raw === 'string' && ex.destination_raw.trim()) destRaw = ex.destination_raw.trim();
      }
    }
    if (!o && originRaw) await openResolve('origin', originRaw);
    if (!d && destRaw) await openResolve('destination', destRaw);
  }

  const constraints = { ...extractConstraints(text), ...sanitizeConstraints(input.constraints) };
  const chips = constraintChips(constraints);
  /* P0（十轮）：往返/日期/人数意图——文本确定性提取 + UI 显式字段覆盖，经消歧/重新规划不回退 */
  const travel = buildTravelIntent(text || '', input.travel || null);
  const intent = {
    origin: o ? o.name : (rawOrigin || null),
    destination: d ? d.name : (rawDest || null),
    origin_place: o,
    destination_place: d,
    constraints,
    constraint_chips: chips,
    parse_engine,
    trip_type: travel.intent.trip_type,
    outbound_window: travel.intent.outbound_window,
    return_window: travel.intent.return_window,
    traveler_count: travel.intent.traveler_count
  };

  if (!o && !place_candidates.origin.length && !needs.some((n) => n.startsWith('出发地'))) needs.push('出发地未识别');
  if (!d && !place_candidates.destination.length && !needs.some((n) => n.startsWith('目的地'))) needs.push('目的地未识别');
  needs.push(...travel.needs);
  if (o && d && o.name === d.name) needs.push('出发地与目的地相同：跨城交通规划不适用（市内接驳不在当前范围）');
  if (!o || !d || o.name === d.name) {
    return {
      intent,
      route: null,
      needs_confirmation: needs,
      place_candidates,
      candidates: [],
      constraint_notes: [],
      degradations,
      explorations: [],
      next_steps: place_candidates.origin.length || place_candidates.destination.length
        ? ['在确认卡中选择正确地点（含重名消歧）后重新生成', '候选均来自 OpenStreetMap 核验，可点击来源核对']
        : ['补全或修正地点后重新规划', '识别不了的地点待核验通道可用后再试，或使用已收录地点'],
      planner_version: ANYWHERE_VERSION
    };
  }

  const route = { route_type: routeTypeOf(o, d) };

  /* LLM 中转提名（geo 覆盖不到时才需要；一次调用覆盖两类骨架；清单校验在 buildCandidateSkeletons 消费点） */
  const llmHints = {};
  if (!isDomesticPair(o, d) || !(geoCityName(o) && geoCityName(d))) {
    const hubOut = await callJson({
      schema_prompt: llmHubPrompt(JSON.stringify(cityNames), o.name, d.name),
      user: '为 ' + o.name + ' → ' + d.name + ' 提名中转城市',
      kind: 'anywhere'
    });
    if (hubOut && typeof hubOut === 'object') {
      if (hubOut.one_transfer_city) llmHints.one_transfer_city = hubOut.one_transfer_city;
      if (hubOut.mixed_rail_city) llmHints.mixed_rail_city = hubOut.mixed_rail_city;
    }
  }

  const built = buildCandidateSkeletons(o, d, constraints, llmHints);
  degradations.push(...built.degradations);

  /* 逐段搜索线索：只在 web_search 已配置时进行；状态在取证后读取（如实反映本次调用结果，P1-4） */
  const wsReady = webSearchConfigured(env).configured;
  let leadStat = { leads: 0 };
  if (wsReady) {
    leadStat = await verifyLegs(built.candidates, deps.searchWeb !== undefined ? deps.searchWeb : searchWebDefault);
    if (!leadStat.leads) {
      const wsStateNow = deps.webSearchStatus ? deps.webSearchStatus() : webSearchStatusDefault();
      degradations.push('联网检索未取得相关线索（web_search 最近状态：' + (wsStateNow.status || 'unknown') +
        '）：全部段保持探索态（未取证，不模拟证据）');
    }
  } else {
    degradations.push('web_search 未配置：全部候选段保持探索态（未取证），不模拟证据');
  }
  const wsState = deps.webSearchStatus ? deps.webSearchStatus() : webSearchStatusDefault();

  return {
    intent,
    route,
    needs_confirmation: travel.needs,
    place_candidates,
    candidates: built.candidates,
    constraint_notes: built.constraint_notes,
    degradations,
    explorations: built.explorations,
    web_search: { configured: wsReady, status: wsState.status || 'unknown' },
    next_steps: [
      '所有候选均为待验证假设：请按每段的核对入口到原平台确认班期',
      '段的「搜索线索」只说明找到相关来源，不是班期核验；取得班次/适用日期等结构化事实后才进入既有证据链',
      '取证到价格/时刻后，预算、中转时长与夜间到达约束才能逐项校验'
    ],
    planner_version: ANYWHERE_VERSION
  };
}
