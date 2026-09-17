/* trip.mjs · Solo Trip v1.2 行程域模型与规则底座（G1 · 产品方案_SoloTrip_v1.2 §5）
 * v0.25.2 依复审（工作记录 v0.25.1 八项发现）重构：
 * ① Leg 分离出发/抵达时区（跨境段不得用单一时区解释两端钟面）；
 * ② evidenceState 收紧：只认 valid_for_date、按方向绑定各自窗口、任一段过期即阻止 verified、
 *    dated_verified 为统一门禁（双向齐+全段绑定+无过期+衔接可行+非反转+成本完整）；
 * ③ 附加费用（extras）纳入币种一致性，无可信汇率不求和；
 * ④ price_sample.scope='round_trip' 不得计入单段拆账；行李口径未核验进 unknown_costs；
 * ⑤ canClaimCheaper 先要求口径字段存在，缺失 ≠ 一致；
 * ⑥ detectReversal 接入 validateStrategy 统一门禁；inbound/outbound 数组方向强制一致。 */

const DIRECTIONS = ['outbound', 'inbound'];
const MODES = ['plane', 'train', 'bus', 'ferry', 'transfer'];
const PRICE_SCOPES = ['one_way', 'round_trip'];

/* 换乘/缓冲阈值（分钟）：国际转机衔接的权威数字待 G0 缺口核验（T08），先可配置 */
export const CONNECTION_RULES = {
  same_station_min: 45,
  cross_station_min: 90,
  cross_station_buffer: 30
};

/* 证据过期阈值（天，按数据源类型配置——产品方案 §4.2） */
export const STALE_AFTER_DAYS = {
  flight_price: 7,
  flight_schedule: 90,
  rail_price: 30,
  rail_schedule: 180,
  visa_rule: 30
};

/* ---------- 时区计算（Node 内置 Intl，无外部依赖；一切时长经 UTC 中介） ---------- */

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

/** UTC → 某时区本地钟面 { dateStr, timeStr } */
export function utcToZoned(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(utcMs)) p[part.type] = part.value;
  return { dateStr: `${p.year}-${p.month}-${p.day}`, timeStr: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

/** 两段衔接（前段到达 → 后段出发）真实间隔分钟——UTC 中介，跨日/跨时区安全 */
export function connectionGapMinutes(prevLeg, nextLeg) {
  if (!prevLeg?._utcArr || !nextLeg?._utcDep) return null;
  return Math.round((nextLeg._utcDep.getTime() - prevLeg._utcArr.getTime()) / 60000);
}

/* ---------- Leg 时区归一与装饰 ---------- */

/** 起落时区分离（复审①）：depart_time_zone / arrive_time_zone；提供单一 time_zone 时视为两端相同 */
function legTimeZones(leg) {
  const depTz = leg.depart_time_zone || leg.time_zone;
  const arrTz = leg.arrive_time_zone || leg.time_zone || leg.depart_time_zone;
  return { depTz, arrTz };
}

/** 装饰 Leg：派生 _utcDep/_utcArr（各自时区独立解释）与 duration_min；跨日漏标立刻暴露 */
export function decorateLeg(leg) {
  const out = { ...leg };
  const { depTz, arrTz } = legTimeZones(leg);
  if (!depTz || !arrTz) return { ...out, _negative_duration_error: true, _tz_error: '缺少时区' };
  out._utcDep = zonedToUtc(leg.depart_date, leg.depart_local, depTz);
  const arrDate = leg.arrive_date || leg.depart_date;
  out._utcArr = zonedToUtc(arrDate, leg.arrive_local, arrTz);
  out.duration_min = Math.round((out._utcArr.getTime() - out._utcDep.getTime()) / 60000);
  if (out.duration_min < 0) out._negative_duration_error = true;
  return out;
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

function badTz(tz) { return !tz || !/^[A-Za-z_]+\/[A-Za-z_+0-9\-]+$/.test(tz); }

export function validateLeg(leg) {
  const errors = [];
  if (!leg) return ['Leg 缺失'];
  if (!DIRECTIONS.includes(leg.direction)) errors.push('direction 必填 outbound/inbound：' + leg.direction);
  if (!MODES.includes(leg.mode)) errors.push('mode 非法：' + leg.mode);
  if (!leg.origin_terminal || !leg.destination_terminal) errors.push('起终场站必填');
  if (!leg.depart_local || !leg.arrive_local) errors.push('本地起落时刻必填');
  const { depTz, arrTz } = legTimeZones(leg);
  if (badTz(depTz)) errors.push('depart_time_zone（IANA）必填');
  if (badTz(arrTz)) errors.push('arrive_time_zone（IANA）必填');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(leg.depart_date || '')) errors.push('depart_date（YYYY-MM-DD，当地日期）必填');
  if (!leg.source_url) errors.push('source_url 必填（无来源不入库）');
  if (!leg.sampled_at) errors.push('sampled_at 必填');
  else if (Number.isNaN(new Date(leg.sampled_at).getTime())) errors.push('sampled_at 无法解析为有效时间：' + leg.sampled_at);
  if (leg.price_sample != null) {
    const ps = leg.price_sample;
    if (typeof ps.amount !== 'number' || ps.amount <= 0) errors.push('price_sample.amount 非法');
    if (!ps.currency || !/^[A-Z]{3}$/.test(ps.currency)) errors.push('price_sample.currency 必填');
    if (ps.scope != null && !PRICE_SCOPES.includes(ps.scope)) errors.push('price_sample.scope 非法：' + ps.scope);
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

/** Strategy 统一验证入口（复审⑥）：结构 + 方向一致性 + 反转守卫 + 完整宣称门禁。 */
export function validateStrategy(s) {
  const errors = [];
  if (!s) return ['Strategy 缺失'];
  if (!s.kind) errors.push('kind 必填（direct/transfer/rail_hybrid/…）');
  const out = s.outbound || [], inc = s.inbound || [];
  for (const leg of out) {
    if (leg.direction !== 'outbound') errors.push('outbound 数组混入 direction=' + leg.direction);
    errors.push(...validateLeg(leg));
  }
  for (const leg of inc) {
    if (leg.direction !== 'inbound') errors.push('inbound 数组混入 direction=' + leg.direction);
    errors.push(...validateLeg(leg));
  }
  if (detectReversal(s)) errors.push('inbound 与 outbound 逐段镜像（同班次+场站对调）——禁止由去程反转充当返程（T06）');
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

/**
 * 成本拆账（复审③④）：已知项求和前统一验证币种（extras 在内）；无可信汇率不求和。
 * price_sample.scope='round_trip' 的段不得计入单段（往返口径不可拆分）→ 进 unknown_costs；
 * baggage_terms 为 null/undefined 的段 → 行李口径未核验进 unknown_costs。
 */
export function buildCostBreakdown(legs, extras = []) {
  const known = [];
  const unknown_costs = [];
  let currency = null;
  let currency_mixed = false;
  const accept = (item, amount, cur) => {
    if (amount == null || !cur) {
      unknown_costs.push({ item, reason: cur ? '无金额证据' : '无币种证据' });
      return;
    }
    if (currency == null) currency = cur;
    else if (currency !== cur) { currency_mixed = true; unknown_costs.push({ item, reason: `币种 ${cur} 与已计 ${currency} 不同且无可信汇率，不入和` }); return; }
    known.push({ item, amount, currency: cur });
  };
  for (const leg of legs) {
    const label = `${leg.direction}:${leg.service_no || leg.mode}`;
    const ps = leg.price_sample;
    if (ps == null) {
      unknown_costs.push({ item: label + ':票价', reason: '该段无价格样本' });
    } else if (ps.scope === 'round_trip') {
      unknown_costs.push({ item: label + ':票价', reason: `往返口径样本（¥/原币覆盖多段与日期，不可拆分计入单段；scope=${ps.scope}）` });
    } else {
      accept(label + ':票价', ps.amount, ps.currency);
    }
    if (leg.baggage_terms == null) unknown_costs.push({ item: label + ':行李', reason: '行李口径未核验' });
    if (Array.isArray(leg.unknown_costs)) unknown_costs.push(...leg.unknown_costs);
  }
  for (const e of extras) {
    if (e.amount != null) accept(e.item, e.amount, e.currency);
    else unknown_costs.push({ item: e.item, reason: e.reason || '无金额证据' });
  }
  return {
    items: known,
    known_total: known.length && !currency_mixed ? known.reduce((a, b) => a + b.amount, 0) : null,
    currency: known.length && !currency_mixed ? currency : null,
    currency_mixed,
    unknown_costs
  };
}

/**
 * 同口径省钱判定（复审⑤+第二轮④）：口径字段必须【存在】且【相等】——缺失 ≠ 一致；
 * 日期除宽泛窗外还须绑定【具体出行日】（同窗不同日不得比较，如 9/30 去 10/7 返 vs 10/3 去 10/5 返）。
 * 策略或基准存在未知费用、混合币种、跨币种、成本不完整 → 一律不得宣称更省。
 */
export function canClaimCheaper(strategyCost, baselineCost, strategyCtx, baselineCtx) {
  const ctxKeys = ['outbound_window', 'return_window', 'outbound_date', 'return_date', 'traveler_count', 'currency', 'baggage'];
  for (const k of ctxKeys) {
    const a = strategyCtx?.[k], b = baselineCtx?.[k];
    if (a == null || a === '' || b == null || b === '') return { comparable: false, reason: '比较口径不完整：' + k };
    if (a !== b) return { comparable: false, reason: '口径不一致：' + k };
  }
  if ((strategyCost.unknown_costs || []).length) return { comparable: true, cheaper: false, reason: '策略存在未知费用，不得宣称更省' };
  if ((baselineCost.unknown_costs || []).length) return { comparable: true, cheaper: false, reason: '基准存在未知费用' };
  if (strategyCost.currency_mixed || baselineCost.currency_mixed) return { comparable: true, cheaper: false, reason: '混合币种未换算' };
  if (strategyCost.known_total == null || baselineCost.known_total == null) return { comparable: true, cheaper: false, reason: '成本不完整' };
  if (strategyCost.currency !== baselineCost.currency) return { comparable: true, cheaper: false, reason: '跨币种无已核验汇率，不得比较' };
  return { comparable: true, cheaper: strategyCost.known_total < baselineCost.known_total };
}

/* ---------- 证据状态机 ---------- */

function staleDaysFor(leg) {
  const kind = leg.mode === 'plane' ? (leg.price_sample ? 'flight_price' : 'flight_schedule') : (leg.price_sample ? 'rail_price' : 'rail_schedule');
  return STALE_AFTER_DAYS[kind] ?? 30;
}

/** 逐段新鲜度：sampled_at 超过该类型阈值 → stale（T11）；无效取样时间按不可信处理（复审：not-a-date 曾不触发过期） */
export function legFreshness(leg, nowMs = Date.now()) {
  const days = staleDaysFor(leg);
  const sampled = new Date(leg.sampled_at).getTime();
  if (!Number.isFinite(sampled)) return { stale: true, ageDays: null, thresholdDays: days, invalid_sampled_at: true };
  const age = (nowMs - sampled) / 86400000;
  return { stale: age > days, ageDays: Math.round(age * 10) / 10, thresholdDays: days };
}

function parseWindow(w) {
  if (!w) return null;
  const m = String(w).match(/^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/);
  return m ? [m[1], m[2]] : null;
}

/**
 * 行程证据状态（v0.25.3 二轮复审收紧）：
 * - 指定日绑定只认 valid_for_date，且必须与该段实际出发日一致（证据日期 ≠ 出发日 → 视为未绑定），
 *   并按方向命中各自窗口（outbound→outbound_window、inbound→return_window）；
 * - 任一段过期 → 不得 dated_verified（全部过期 → stale）；无效 sampled_at 视为过期；
 * - 行程时序：双向齐时，去程全部抵达必须早于返程最早出发（返程不得早于/交织于去程）；
 *   任一段钟面倒挂（跨日漏标）→ 不得 verified；
 * - 成本一律从【当前分段】重算（buildCostBreakdown），不信外部传入的 cost_breakdown——
 *   旧总价不得掩盖缺失票价；无价段/往返口径段/行李未核验自然构成未知项；
 * - dated_verified = 双向齐 + 全段绑定一致命中 + 无过期 + 时序成立 + 衔接可行 + 非反转 + 重算成本完整。
 */
export function evidenceState(strategy, query, nowMs = Date.now()) {
  const rawOut = strategy.outbound || [], rawInc = strategy.inbound || [];
  const rawLegs = [...rawOut, ...rawInc];
  if (!rawLegs.length) return 'explore';
  const out = rawOut.map(decorateLeg), inc = rawInc.map(decorateLeg);
  const legs = [...out, ...inc];

  /* 逐段钟面自洽：跨日漏标导致的倒挂立刻暴露 */
  if (legs.some((l) => l._negative_duration_error)) return 'historical';

  /* 新鲜度（含无效 sampled_at 视为过期） */
  const fresh = legs.map((l) => legFreshness(l, nowMs));
  if (fresh.every((f) => f.stale)) return 'stale';
  const anyStale = fresh.some((f) => f.stale);

  /* 指定日绑定：valid_for_date 与实际出发日一致 + 命中本方向窗口 */
  const inWin = (leg) => {
    const w = parseWindow(leg.direction === 'outbound' ? query?.outbound_window : query?.return_window);
    const d = leg.valid_for_date;
    return !!(w && d && d === leg.depart_date && d >= w[0] && d <= w[1]);
  };
  const datedCount = legs.filter(inWin).length;
  const allDated = datedCount === legs.length;

  /* 行程时序：去程最后抵达 < 返程最早出发（返程早于/交织于去程即门禁不过） */
  let orderOk = true;
  if (out.length && inc.length) {
    const lastOutArr = Math.max(...out.map((l) => l._utcArr.getTime()));
    const firstIncDep = Math.min(...inc.map((l) => l._utcDep.getTime()));
    orderOk = lastOutArr < firstIncDep;
  }

  /* 成本从当前分段重算——外部 cost_breakdown 不作为状态判定依据（旧总价不得掩盖缺失票价） */
  const cost = buildCostBreakdown(legs);
  const costComplete = cost.known_total != null && !cost.currency_mixed && cost.unknown_costs.length === 0;

  const hasBoth = out.length > 0 && inc.length > 0;
  const connOk = checkConnections(out).feasible && (inc.length ? checkConnections(inc).feasible : true);
  if (!anyStale && allDated && hasBoth && orderOk && costComplete && connOk && !detectReversal(strategy)) return 'dated_verified';
  if (datedCount > 0 && !anyStale) return 'dated_partial';
  return 'historical';
}

/* ---------- 组装：TripDraft 版本化（T12） ---------- */

export function nextVersion(draft) {
  if (!draft) return { id: 'trip-' + Date.now(), version: 1 };
  return { ...draft, version: (draft.version || 1) + 1, saved_at: new Date().toISOString() };
}
