/* trip.mjs · Solo Trip v1.2 行程域模型与规则底座（G1 · 产品方案_SoloTrip_v1.2 §5）
 * 契约：TripQuery / TripDraft / Strategy / Leg / Evidence。纪律（开发流程 §G1）：
 * ① direction 必填且去返独立取证——任何「由去程反转构造返程」的输入在验证层拒绝；
 * ② 时刻计算一律走 UTC 中介（本地时间 + IANA 时区 → UTC → 时长/跨日），禁止本地钟面心算；
 * ③ 未知费用不得按 0 计入（进 unknown_costs）；不同币种不得静默换算求和；
 * ④ 「更省」表述仅在 同日期窗+同人数+同币种+同行李口径 且双方成本完整（无未知项）时成立；
 * ⑤ 证据状态机 explore→historical→dated_partial→dated_verified，另有 stale/unsupported；
 *    只有绑定指定日期（valid_for_date 命中查询窗）的段才允许 dated_*。 */

const DIRECTIONS = ['outbound', 'inbound'];
const MODES = ['plane', 'train', 'bus', 'ferry', 'transfer'];
const EVIDENCE_STATES = ['explore', 'historical', 'dated_partial', 'dated_verified', 'stale', 'unsupported'];

/* 换乘/缓冲阈值（分钟）：国际转机衔接的权威数字待 G0 缺口核验（T08），先可配置 */
export const CONNECTION_RULES = {
  same_station_min: 45,
  cross_station_min: 90,
  cross_station_buffer: 30
};

/* 证据过期阈值（天，按数据源类型配置——产品方案 §4.2：不能用一个固定值代表所有类型） */
export const STALE_AFTER_DAYS = {
  flight_price: 7,
  flight_schedule: 90,
  rail_price: 30,
  rail_schedule: 180,
  visa_rule: 30
};

/* ---------- 时区计算（Node 内置 Intl，无外部依赖） ---------- */

function tzOffsetMinutes(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(utcMs)) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - utcMs) / 60000);
}

/** 本地钟面（"2026-09-30","06:05",IANA）→ UTC Date。两轮迭代消除偏移循环。 */
export function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMinutes(guess, timeZone);
    guess = Date.UTC(y, m - 1, d, hh, mm, 0) - off * 60000;
  }
  return new Date(guess);
}

/** UTC → 某时区的本地钟面 { dateStr, timeStr, dayOffsetFromUtcDate } */
export function utcToZoned(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(utcMs)) p[part.type] = part.value;
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    timeStr: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`,
    tzDate: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timeZone}`
  };
}

/** 两段衔接（前段到达 → 后段出发）的真实间隔分钟——UTC 中介，跨日/跨时区安全 */
export function connectionGapMinutes(prevLeg, nextLeg) {
  if (!prevLeg?._utcArr || !nextLeg?._utcDep) return null;
  return Math.round((nextLeg._utcDep.getTime() - prevLeg._utcArr.getTime()) / 60000);
}

/* ---------- 验证器 ---------- */

export function validateTripQuery(q) {
  const errors = [];
  if (!q) return ['TripQuery 缺失'];
  if (!q.origin || !q.destination) errors.push('origin/destination 必填');
  if (q.origin && q.destination && q.origin === q.destination) errors.push('起终点相同');
  if (q.trip_type && !['one_way', 'round_trip', 'open_jaw', 'pending'].includes(q.trip_type)) errors.push('trip_type 非法：' + q.trip_type);
  const tc = q.traveler_count ?? 1;
  if (!Number.isInteger(tc) || tc < 1) errors.push('traveler_count 须为正整数');
  if (q.trip_type === 'round_trip' && !q.return_window && !q.outbound_window) {
    errors.push('round_trip 应给出至少一个日期窗（否则应声明 trip_type=pending）');
  }
  if (q.currency && !/^[A-Z]{3}$/.test(q.currency)) errors.push('currency 须为 ISO 4217 三字母');
  return errors;
}

/** Leg 验证：direction/mode 必填；本地起落 + IANA 时区必填（utc_instant 由内部派生，不信任外部传入） */
export function validateLeg(leg) {
  const errors = [];
  if (!leg) return ['Leg 缺失'];
  if (!DIRECTIONS.includes(leg.direction)) errors.push('direction 必填 outbound/inbound：' + leg.direction);
  if (!MODES.includes(leg.mode)) errors.push('mode 非法：' + leg.mode);
  if (!leg.origin_terminal || !leg.destination_terminal) errors.push('起终场站必填');
  if (!leg.depart_local || !leg.arrive_local) errors.push('本地起落时刻必填');
  if (!leg.time_zone || !/^[A-Za-z_]+\/[A-Za-z_+0-9\-]+$/.test(leg.time_zone)) errors.push('IANA 时区必填：' + leg.time_zone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(leg.depart_date || '')) errors.push('depart_date（YYYY-MM-DD，当地日期）必填');
  if (!leg.source_url) errors.push('source_url 必填（无来源不入库）');
  if (!leg.sampled_at) errors.push('sampled_at 必填');
  if (leg.price_sample != null) {
    const ps = leg.price_sample;
    if (typeof ps.amount !== 'number' || ps.amount <= 0) errors.push('price_sample.amount 非法');
    if (!ps.currency || !/^[A-Z]{3}$/.test(ps.currency)) errors.push('price_sample.currency 必填');
  }
  return errors;
}

export function validateEvidence(ev) {
  const errors = [];
  if (!ev) return ['Evidence 缺失'];
  if (!ev.field) errors.push('field 必填');
  if (!ev.source_url) errors.push('source_url 必填');
  if (!ev.sampled_at) errors.push('sampled_at 必填');
  if (ev.status && !['fresh', 'stale', 'unverified'].includes(ev.status)) errors.push('status 非法：' + ev.status);
  return errors;
}

/** Strategy 验证。核心红线：round_trip 宣称 complete 时，去返两向都不得为空（T03/T06 防线）。
 *  每个 Leg 必须自带 time_zone（去返常不同时区，如 Asia/Shanghai / Asia/Almaty）。 */
export function validateStrategy(s) {
  const errors = [];
  if (!s) return ['Strategy 缺失'];
  if (!s.kind) errors.push('kind 必填（direct/transfer/rail_hybrid/…）');
  const out = s.outbound || [], inc = s.inbound || [];
  for (const leg of out) errors.push(...validateLeg(leg));
  for (const leg of inc) errors.push(...validateLeg(leg));
  if (s.trip_type === 'round_trip' && s.complete === true) {
    if (!out.length) errors.push('round_trip complete=true 但 outbound 为空');
    if (!inc.length) errors.push('round_trip complete=true 但 inbound 为空（去返须独立取证，禁止反转充当返程）');
  }
  if (s.complete === true && (!s.cost_breakdown || s.cost_breakdown.known_total == null) && !(s.unknown_costs || []).length) {
    errors.push('complete=true 时成本拆账与未知项至少要有其一（未知项不得静默为 0）');
  }
  return errors;
}

/* ---------- 规则：衔接可行性 / 反转守卫 / 成本与同口径省钱 ---------- */

/** 逐段衔接校验（T08）：间隔 < 同站/跨站阈值 → 不可行。返回 {feasible, gaps[]} */
export function checkConnections(legs, rules = CONNECTION_RULES) {
  const gaps = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const gap = connectionGapMinutes(legs[i], legs[i + 1]);
    if (gap == null) { gaps.push({ index: i, issue: '缺少 UTC 时刻，无法校验衔接' }); continue; }
    const crossStation = legs[i].destination_terminal !== legs[i + 1].origin_terminal;
    const min = crossStation ? rules.cross_station_min : rules.same_station_min;
    if (gap < min) gaps.push({ index: i, gap, min, crossStation, issue: `衔接 ${gap}min 低于${crossStation ? '跨站' : '同站'}最短 ${min}min` });
  }
  return { feasible: gaps.length === 0, gaps };
}

/** 反转守卫（T06）：inbound 与 outbound 逐段镜像（班次号相同且场站对调）→ 疑似反转 */
export function detectReversal(strategy) {
  const out = strategy.outbound || [], inc = strategy.inbound || [];
  if (!out.length || !inc.length) return false;
  if (out.length !== inc.length) return false;
  return out.every((leg, i) => {
    const mirror = inc[inc.length - 1 - i] || {};
    return leg.service_no && leg.service_no === mirror.service_no &&
      leg.origin_terminal === mirror.destination_terminal &&
      leg.destination_terminal === mirror.origin_terminal;
  });
}

/** 成本拆账（T05）：已知项求和（币种不同不换算直接报未知）；未知项原样保留，绝不按 0 计入 */
export function buildCostBreakdown(legs, extras = []) {
  const known = [];
  const unknown_costs = [];
  let currency = null;
  let currency_mixed = false;
  for (const leg of legs) {
    if (leg.price_sample != null) {
      if (currency == null) currency = leg.price_sample.currency;
      else if (currency !== leg.price_sample.currency) currency_mixed = true;
      known.push({ item: `${leg.direction}:${leg.service_no || leg.mode}`, amount: leg.price_sample.amount, currency: leg.price_sample.currency });
    } else {
      unknown_costs.push({ item: `${leg.direction}:${leg.service_no || leg.mode}:票价`, reason: '该段无价格样本' });
    }
    if (Array.isArray(leg.unknown_costs)) unknown_costs.push(...leg.unknown_costs);
  }
  for (const e of extras) {
    if (e.amount != null) known.push(e);
    else unknown_costs.push({ item: e.item, reason: e.reason || '无金额证据' });
  }
  const sameCurrency = known.length && !currency_mixed;
  return {
    items: known,
    known_total: sameCurrency ? known.reduce((a, b) => a + b.amount, 0) : null,
    currency: sameCurrency ? currency : null,
    currency_mixed,
    unknown_costs
  };
}

/**
 * 同口径省钱判定（T04/T05 铁律）：仅当 日期窗/人数/币种/行李口径 与基准全等，
 * 且策略与基准成本均完整（无 unknown_costs、非混合币种）时才允许「更省」。
 * 口径不一致 → { comparable:false }；可比 → comparable:true + cheaper 布尔。
 */
export function canClaimCheaper(strategyCost, baselineCost, strategyCtx, baselineCtx) {
  const ctxKeys = ['outbound_window', 'return_window', 'traveler_count', 'currency', 'baggage'];
  for (const k of ctxKeys) {
    if ((strategyCtx?.[k] ?? null) !== (baselineCtx?.[k] ?? null)) return { comparable: false, reason: '口径不一致：' + k };
  }
  if ((strategyCost.unknown_costs || []).length) return { comparable: true, cheaper: false, reason: '策略存在未知费用，不得宣称更省' };
  if ((baselineCost.unknown_costs || []).length) return { comparable: true, cheaper: false, reason: '基准存在未知费用' };
  if (strategyCost.currency_mixed || baselineCost.currency_mixed) return { comparable: true, cheaper: false, reason: '混合币种未换算' };
  if (strategyCost.known_total == null || baselineCost.known_total == null) return { comparable: true, cheaper: false, reason: '成本不完整' };
  /* 策略与基准币种不同 → 无已核验汇率不得比较（产品方案 §5：汇率来源与取样时间须单独记录） */
  if (strategyCost.currency !== baselineCost.currency) return { comparable: true, cheaper: false, reason: '跨币种无已核验汇率，不得比较' };
  return { comparable: true, cheaper: strategyCost.known_total < baselineCost.known_total };
}

/* ---------- 证据状态机 ---------- */

function staleDaysFor(leg) {
  const kind = leg.mode === 'plane' ? (leg.price_sample ? 'flight_price' : 'flight_schedule') : (leg.price_sample ? 'rail_price' : 'rail_schedule');
  return STALE_AFTER_DAYS[kind] ?? 30;
}

/** 逐段新鲜度：sampled_at 超过该类型阈值 → stale（T11） */
export function legFreshness(leg, nowMs = Date.now()) {
  const days = staleDaysFor(leg);
  const age = (nowMs - new Date(leg.sampled_at).getTime()) / 86400000;
  return { stale: age > days, ageDays: Math.round(age * 10) / 10, thresholdDays: days };
}

/** 行程证据状态（T03/T11）：绑定指定日期（valid_for_date 命中查询窗）的段占比决定 dated_*；
 *  全部段 stale → stale；无段 → explore；有段无绑定 → historical。 */
export function evidenceState(strategy, query, nowMs = Date.now()) {
  const legs = [...(strategy.outbound || []), ...(strategy.inbound || [])];
  if (!legs.length) return 'explore';
  const allStale = legs.every((l) => legFreshness(l, nowMs).stale);
  if (allStale) return 'stale';
  const inWindow = (d) => {
    if (!d) return false;
    const ow = parseWindow(query?.outbound_window), rw = parseWindow(query?.return_window);
    if (legs.some((l) => l.direction === 'outbound') && ow && d >= ow[0] && d <= ow[1]) return true;
    if (legs.some((l) => l.direction === 'inbound') && rw && d >= rw[0] && d <= rw[1]) return true;
    return false;
  };
  const datedLegs = legs.filter((l) => inWindow(l.valid_for_date || l.depart_date));
  const costComplete = strategy.cost_breakdown && strategy.cost_breakdown.known_total != null && !(strategy.cost_breakdown.unknown_costs || []).length;
  if (datedLegs.length === legs.length && legs.some((l) => l.direction === 'inbound') && legs.some((l) => l.direction === 'outbound') && costComplete) return 'dated_verified';
  if (datedLegs.length > 0) return 'dated_partial';
  return 'historical';
}

function parseWindow(w) {
  if (!w) return null;
  const m = String(w).match(/^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/);
  return m ? [m[1], m[2]] : null;
}

/* ---------- 组装：装饰 UTC 时刻 + 行程草稿 ---------- */

/** 给 Leg 派生 _utcDep/_utcArr（内部字段）与 arrive_utc_date（当地到达日） */
export function decorateLeg(leg) {
  const out = { ...leg };
  out._utcDep = zonedToUtc(leg.depart_date, leg.depart_local, leg.time_zone);
  const arrDate = leg.arrive_date || leg.depart_date; /* 跨日由 arrive_date 显式给出（当地日） */
  out._utcArr = zonedToUtc(arrDate, leg.arrive_local, leg.time_zone);
  out.duration_min = Math.round((out._utcArr.getTime() - out._utcDep.getTime()) / 60000);
  if (out.duration_min < 0) out._negative_duration_error = true; /* 跨日漏标会被立刻暴露（T07） */
  return out;
}

/** TripDraft 版本化保存（T12）：不静默覆盖——每次返回新对象，version 递增 */
export function nextVersion(draft) {
  if (!draft) return { id: 'trip-' + Date.now(), version: 1 };
  return { ...draft, version: (draft.version || 1) + 1, saved_at: new Date().toISOString() };
}
