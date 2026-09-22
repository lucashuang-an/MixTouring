/* trip-service.mjs · Solo Trip v1.2 行程级服务动作（G1 收尾 / 开发流程 §G1-G3 步骤 3）
 * 三个动作（产品方案 §5 建议的服务契约）：
 *   parseTripIntent        两字段/一句话 → 行程意图（OD、往返、窗口、人数）；OD/日期复用 parseTrip 的 LLM/规则降级
 *   searchTripStrategies   行程查询 → 候选策略 + 证据状态 + 下一步（探索与核验助手范围，G0 裁定；
 *                          价格只作「样本口径」展示并带状态，绝不断言当日可购/省钱）
 *   buildVerificationChecklist → 逐段核验清单（每段场站/班次/当地时刻/来源 + 待核项）
 * 诚实边界（复审两轮确认的纪律）：去返独立取证（反向查询返回探索态而非反转）；无证据段只列待查项；
 * 证据状态由 trip.mjs 门禁计算，本层不手写状态。 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTrip, parseTripRule } from './parse.mjs';
import { validateTripQuery, evidenceState, decorateLeg, buildCostBreakdown, detectReversal, checkConnections } from './trip.mjs';
import { TRIP_PLANNER_VERSION, ANYWHERE_PLANNER_VERSION } from './versions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---------- PlaceResolver 与确定性路由（v0.29.0 决策③；v0.29.1 评审②重构） ----------
 * 地点词典 = pipeline/data/places.json（country/is_mainland/tz/kind）；路由为确定性规则，不交给 LLM 猜测：
 * 两端均为「中国大陆地点」（country=CN 且 is_mainland=true）→ domestic（国内样本链路）；
 * 任一端为港澳台（is_mainland=false）或境外 → international（v1.2 行程链路）；
 * 未收录/缺国家信息 → needs_confirmation（不静默选链路）。 */

let PLACES = null;
export function loadPlaces() {
  if (!PLACES) {
    try { PLACES = JSON.parse(readFileSync(join(root, 'pipeline/data/places.json'), 'utf8')).places || []; }
    catch { PLACES = []; }
  }
  return PLACES;
}

export function findPlace(name) {
  if (!name) return null;
  const n = String(name).trim();
  return loadPlaces().find((p) => p.name === n) || null;
}

/** 确定性路由（决策③ + 评审②口径）：国内=两端均为中国大陆地点 */
export function resolveRoute(origin, destination) {
  const o = findPlace(origin);
  const d = findPlace(destination);
  if (!o || !d) return { route_type: 'needs_confirmation', origin_place: o, destination_place: d };
  const isDomestic = o.country === 'CN' && o.is_mainland === true && d.country === 'CN' && d.is_mainland === true;
  return { route_type: isDomestic ? 'domestic' : 'international', origin_place: o, destination_place: d };
}

/** web_search 能力独立推导（评审 P1-5）：searchWeb 依赖智谱独立 /web_search 端点——
 * 兼容聊天模型的 key/base 不代表该端点可用。仅当配置了 key 且 base 指向智谱（或显式 WEB_SEARCH_AVAILABLE=1）时视为已配置。
 * 返回 {configured, basis}——布尔由调用方消费，不泄露任何凭据。 */
export function webSearchConfigured(env = process.env) {
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
    trip_planner_version: TRIP_PLANNER_VERSION,
    anywhere_planner_version: ANYWHERE_PLANNER_VERSION
  };
}

/* ---------- 意图提取（纯规则，确定性可测） ---------- */

const ROUND_TRIP_RE = /来回|往返|再回|回来|返回|然后回|玩.*天.*回/;
/* v0.26.3 复审③：「直达」只说明交通偏好，不代表单程——只有明确表述才确定 one_way */
const ONE_WAY_RE = /单程|只去不回|不去别处/;
const SOLO_RE = /一个人|独自|单独|solo/i;
const PAIR_RE = /两个人|两人|双人|和朋友|和对象/;
/* v0.26.3 复审②：「国庆附近/前后/期间」保留弹性假期区间，不得收缩为 10/01 单日 */
const NEAR_HOLIDAY_RE = /国庆\s*(?:附近|前后|期间|那几天)/;

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
  if (NEAR_HOLIDAY_RE.test(t)) intent.outbound_window = nationalHolidayWindow(nowMs);
  return intent;
}

/**
 * parseTripIntent：一句话 → TripQuery 草稿（产品方案 §4.1：默认 1 人；缺字段进 needs_confirmation，不猜）。
 * @param cities 方案库城市词典（25 城）
 * @param tripCities Trip 目的地词典（pipeline/data/trips/trip-cities.json，国际/偏远目的地随边库扩展；
 *        v0.26.3 复审①：国际 OD 不在方案库词典——阿拉木图类目的地由此数据驱动，不硬编码）
 * @returns {Promise<{query, needs_confirmation[], parse_engine}>}
 */
export async function parseTripIntent(text, cities, tripCities = [], nowMs = Date.now()) {
  const merged = [...(cities || []), ...(Array.isArray(tripCities) ? tripCities : [])];
  const intent = extractIntentFields(text, nowMs);
  const needs = [];
  /* LLM 优先，但 LLM 部分命中（如只认出出发地）会屏蔽规则兜底（parseTrip 既有行为）——
   * v0.26.3 复审①：Trip 触点对缺失字段用规则版补齐（确定性），engine 如实标注 */
  const base = await parseTrip(text, merged);
  const rule = parseTripRule(text, merged);
  const from = base.from || rule.from;
  const to = base.to || rule.to;
  const baseDate = base.date || rule.date;
  const filledByRule = base.engine === 'llm' && ((base.from && !base.to && !!to) || (!base.from && !!base.to && !!from));
  const trip_type = intent.trip_type || 'pending';
  const outboundDate = /^\d{4}\/\d{2}\/\d{2}$/.test(baseDate || '') ? baseDate.replaceAll('/', '-') : null;
  /* 弹性假期窗优先（复审②：不可静默收缩为单日）；明确单日输入保持单日窗 */
  const outbound_window = intent.outbound_window || (outboundDate ? `${outboundDate} ~ ${outboundDate}` : null);
  if (!from) needs.push('出发地未识别，请补全');
  if (!to) needs.push('目的地未识别，请补全');
  if (trip_type === 'round_trip' && !outbound_window) needs.push('往返行程请补去程日期或大致窗口');
  if (trip_type === 'round_trip') needs.push('往返行程请补返程日期或窗口');
  if (trip_type === 'pending') needs.push('没听出单程还是往返，请补充（不影响先看路线方向）');
  if (intent.outbound_window) needs.push('已按假期窗口预填出行的区间，可修改');
  return {
    query: {
      origin: from || null,
      destination: to || null,
      trip_type,
      outbound_window,
      return_window: null, /* 单日期解析无法证明返程日——返程窗进 needs_confirmation 由用户给 */
      traveler_count: intent.traveler_count ?? 1,
      currency: 'CNY'
    },
    needs_confirmation: needs,
    parse_engine: base.engine === 'llm' ? (filledByRule ? 'llm+rule' : base.engine) : 'rule'
  };
}

/* ---------- 策略检索（fixture 驱动；按 OD 严格匹配，反向查询返回探索态而非反转） ---------- */

function loadTripFixture(origin, destination) {
  try {
    const f = JSON.parse(readFileSync(join(root, 'pipeline/data/trips/almaty-g0.json'), 'utf8'));
    if (f.query.origin === origin && f.query.destination === destination) return f;
    return null; /* 反向或其他 OD：无正向取证即探索态，绝不镜像 */
  } catch {
    return null;
  }
}

/** 只把可公开的原始字段交给页面和核验清单，不返回装饰时产生的内部 UTC Date。 */
function publicLeg(leg) {
  return {
    direction: leg.direction, mode: leg.mode, service_no: leg.service_no || null,
    origin_terminal: leg.origin_terminal, destination_terminal: leg.destination_terminal,
    depart_date: leg.depart_date, depart_local: leg.depart_local,
    depart_time_zone: leg.depart_time_zone || leg.time_zone,
    arrive_date: leg.arrive_date || leg.depart_date, arrive_local: leg.arrive_local,
    arrive_time_zone: leg.arrive_time_zone || leg.time_zone || leg.depart_time_zone,
    source_url: leg.source_url || null, sampled_at: leg.sampled_at || null,
    valid_for_date: leg.valid_for_date || null,
    price_sample: leg.price_sample || null, baggage_terms: leg.baggage_terms || null,
    unknown_costs: leg.unknown_costs || []
  };
}

/** 把 fixture dated_legs 组装成探索态策略卡（含证据状态与未知项，不出可执行卡） */
function strategyFromFixture(fx, query, nowMs) {
  const out = (fx.dated_legs || []).filter((l) => l.direction === 'outbound').map(decorateLeg);
  const inc = query.trip_type === 'round_trip'
    ? (fx.dated_legs || []).filter((l) => l.direction === 'inbound').map(decorateLeg)
    : [];
  const strategy = { kind: 'direct', trip_type: query.trip_type, outbound: out, inbound: inc };
  const state = evidenceState(strategy, query, nowMs);
  const cost = buildCostBreakdown([...out, ...inc]);
  const conn = { out: checkConnections(out), in: inc.length ? checkConnections(inc) : { feasible: true } };
  const publicOut = out.map(publicLeg), publicInc = inc.map(publicLeg);
  return {
    id: 'strategy-' + (fx.query.origin + '-' + fx.query.destination).replace(/\s/g, '') + '-g0-' + query.trip_type,
    kind: 'direct',
    trip_type: query.trip_type,
    outbound: publicOut, inbound: publicInc,
    structure: [...publicOut, ...publicInc],
    evidence_state: state,
    price_samples: [...out, ...inc].filter((l) => l.price_sample).map((l) => ({
      direction: l.direction, service_no: l.service_no || null,
      scope: l.price_sample.scope, amount: l.price_sample.amount, currency: l.price_sample.currency,
      valid_for_date: l.valid_for_date, sampled_at: l.sampled_at, source_url: l.source_url,
      note: '价格样本口径，非当日可购报价'
    })),
    cost_breakdown: { known_total: cost.known_total, currency: cost.currency, unknown_costs: cost.unknown_costs },
    warnings: [
      ...(detectReversal(strategy) ? ['疑似反转路线'] : []),
      ...(!conn.out.feasible ? conn.out.gaps.map((g) => g.issue) : []),
      ...(inc.length && !conn.in.feasible ? conn.in.gaps.map((g) => g.issue) : [])
    ]
  };
}

/** 探索态的下一步建议（产品方案 §4.2：每个状态给真实的下一步） */
function nextSteps(state, hasFixture) {
  if (!hasFixture) return ['这条路线暂无已取证样本：可登记心愿进入核验队列', '可先自行分段查询直达/直飞班期，把结果带回来共建证据'];
  if (state === 'dated_partial') return ['补齐同日期窗/同人数/同行李口径的双向报价后可升级为可比较', '按分段核验清单逐段到原平台查当日余票与退改'];
  if (state === 'historical') return ['当前仅有历史参考：指定出行日期后重新核验'];
  if (state === 'stale') return ['样本已过期：请到原平台重新查询去返班期与价格'];
  return ['补充出行日期以进入核验'];
}

/**
 * searchTripStrategies：行程查询入口（探索与核验助手范围）。
 * @returns {{query, strategies[], evidence_state, next_steps[]}}
 */
export function searchTripStrategies(query, nowMs = Date.now()) {
  const errors = validateTripQuery(query);
  if (errors.length) return { query, strategies: [], evidence_state: 'unsupported', next_steps: errors, error: '查询不合法' };
  if (query.trip_type === 'open_jaw') return {
    query, strategies: [], evidence_state: 'explore',
    next_steps: ['多目的地行程尚无独立证据，请先补全各段目的地与日期']
  };
  const fx = loadTripFixture(query.origin, query.destination);
  if (!fx) {
    return {
      query,
      strategies: [],
      evidence_state: 'explore',
      next_steps: nextSteps('explore', false)
    };
  }
  const strat = strategyFromFixture(fx, query, nowMs);
  return {
    query,
    strategies: [strat],
    evidence_state: strat.evidence_state,
    next_steps: nextSteps(strat.evidence_state, true)
  };
}

/** 逐段核验清单（产品方案 P0「分段核验与私人保存」）：每段给查询入口与待核项，不宣称掌握余票 */
export function buildVerificationChecklist(strategy) {
  const rows = [];
  const legs = [...(strategy.outbound || []), ...(strategy.inbound || [])];
  for (const leg of legs) {
    const missing = [];
    if (!leg.service_no) missing.push('班次/航班号未核验');
    if (!leg.price_sample) missing.push('价格未采样');
    if (!leg.baggage_terms) missing.push('行李口径未核验');
    if (!leg.source_url) missing.push('来源链接未核验');
    if (!leg.sampled_at) missing.push('来源取样时间未核验');
    rows.push({
      direction: leg.direction,
      service_no: leg.service_no || null,
      segment: `${leg.origin_terminal} → ${leg.destination_terminal}`,
      local_times: `${leg.depart_date} ${leg.depart_local} (${leg.depart_time_zone || leg.time_zone}) → ${leg.arrive_date || leg.depart_date} ${leg.arrive_local} (${leg.arrive_time_zone || leg.time_zone || leg.depart_time_zone})`,
      query_entry: leg.mode === 'plane'
        ? '航司官网/携程查询当日航班'
        : '12306 查询当日车次',
      source_url: leg.source_url || null,
      sampled_at: leg.sampled_at || null,
      valid_for_date: leg.valid_for_date || null,
      missing
    });
  }
  return {
    checklist: rows,
    note: '价格为估算样本时请以平台当日报价为准；本清单不掌握余票，不提供购票服务。'
  };
}
