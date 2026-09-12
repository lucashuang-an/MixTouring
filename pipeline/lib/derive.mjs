/* derive.mjs · 存储层 → 服务层派生（方案库Schema §4.4 判级规则 + §6 映射规则的参考实现） */

const pad2 = (n) => String(n).padStart(2, '0');
const yuan = (n) => '¥' + Number(n).toLocaleString('zh-Hans-CN');
const band = (min, max) => yuan(min) + '–' + Number(max).toLocaleString('zh-Hans-CN');
const hm = (min) => Math.floor(min / 60) + 'h' + pad2(min % 60) + 'm';

/* ---------- 风险四因子判级引擎（规则表 v1，运营可调） ---------- */

const CROSS_BUFFER_MIN = 30; // 跨站衔接的进站/值机缓冲

function gradeConnection(raw) {
  const eff = raw.same_station ? raw.wait_min : raw.wait_min - raw.transfer_min - CROSS_BUFFER_MIN;
  let level;
  if (raw.same_station) level = eff >= 120 ? '低' : eff >= 60 ? '中' : '高';
  else level = eff >= 60 ? '中' : '高';
  const effText = eff >= 105 ? '2 小时' : eff >= 75 ? '1.5 小时' : eff >= 45 ? '1 小时' : '不足 1 小时';
  let ruleLine;
  if (raw.same_station) ruleLine = level === '低' ? '同站换乘，余量充足' : '同站转场，余量一般';
  else ruleLine = `原始间隔 ${hm(raw.wait_min)} − 接驳 ${raw.transfer_min}min − 缓冲 ${CROSS_BUFFER_MIN}min${eff < 60 ? '，有效不足 1 小时' : '，有效约 ' + effText}`;
  /* P1.5（v0.19.0）：标题显示有效余量而非原始间隔——原三处数字互相矛盾（评估 P0-5） */
  return { level, title: `衔接余量 · ${raw.city} 有效 ${hm(eff)}`, ruleLine };
}

function gradeBaggage(raw) {
  raw.modes = Array.isArray(raw.modes) ? raw.modes : [];
  const planeTransfers = raw.modes.filter((m, i) => m === 'plane' && i > 0).length;
  const level = planeTransfers === 0 ? '低' : planeTransfers === 1 ? '中' : '高';
  const ruleLine = level === '低' ? '全程火车，随身带上车'
    : level === '中' ? '火车转飞机需自行提取并重新托运' : '多次提取托运，周折较多';
  return { level, title: level === '低' ? '行李直挂' : '行李不直挂', ruleLine };
}

function gradeRefund(raw) {
  const level = raw.ticket_tight ? '中' : !raw.plane_fare ? '低' : raw.plane_fare === 'flexible' ? '低' : '中';
  const ruleLine = raw.ticket_tight ? '票源紧张，退票后可能买不到原班次'
    : !raw.plane_fare ? '均为火车票，开车前可退'
    : raw.plane_fare === 'flexible' ? '机票段为 4 折以上舱位，可改期' : '机票段为特价舱，改期费较高';
  return { level, title: '退改规则', ruleLine };
}

function gradeTransfer(raw) {
  const level = raw.same_station ? '低' : raw.km > 30 ? '高' : '中';
  const ruleLine = raw.same_station ? `${raw.label}，无需出站`
    : `${raw.label} ${raw.km} 公里，${raw.rail_direct ? '轨交' : '接驳'} ${raw.min} 分钟`;
  return { level, title: raw.same_station ? '接驳 · 站内换乘' : '接驳 · 跨站/机场', ruleLine };
}

const GRADERS = { connection: gradeConnection, baggage: gradeBaggage, refund: gradeRefund, transfer: gradeTransfer };

export function deriveRisks(risks) {
  return risks.map((r) => {
    if (r.factor === 'advisory') return { title: r.title, level: r.level, lines: r.lines };
    const raw = (r.raw && typeof r.raw === 'object' && !Array.isArray(r.raw)) ? r.raw : {};
    const g = GRADERS[r.factor](raw);
    return { title: g.title, level: g.level, lines: [g.ruleLine, ...(r.narrative || [])] };
  });
}

/* ---------- 时间与价格派生 ---------- */

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function deriveTimes(plan) {
  const first = plan.segs[0], last = plan.segs[plan.segs.length - 1];
  const start = first.dep_day * 1440 + toMin(first.dep);
  const end = last.arr_day * 1440 + toMin(last.arr);
  return { total_min: end - start };
}

function derivePrice(plan, direct) {
  let min = 0, max = 0;
  plan.segs.forEach((s) => {
    if (s.fixed_price != null) { min += s.fixed_price; max += s.fixed_price; }
    else { min += s.price_band.min; max += s.price_band.max; }
  });
  const mid = Math.round((min + max) / 2);
  const saved = plan.saved != null ? plan.saved : direct ? direct.price - mid : null;
  return { min, max, mid, saved };
}

/* ---------- 服务层格式化（§6 映射规则） ---------- */

function fmtStop(stop) {
  if (stop.kind === 'origin') return { name: stop.city, sub: stop.depart };
  if (stop.kind === 'transfer') return { name: stop.city, sub: '停 ' + hm(stop.wait_min) };
  const sub = stop.day_offset === 0 ? stop.arrive : `D${stop.day_offset + 1} ${stop.arrive}`;
  return { name: stop.city, sub };
}

function fmtSeg(seg) {
  const price = seg.fixed_price != null ? yuan(seg.fixed_price) : `${yuan(seg.price_band.min)}–${yuan(seg.price_band.max)}`;
  return {
    mode: seg.mode, dur: hm(seg.duration_min),
    fromStation: seg.from_station, toStation: seg.to_station,
    dep: seg.dep, arr: seg.arr,
    arrNote: seg.arr_day > seg.dep_day ? '次日' : undefined,
    price
  };
}

/* ---------- AI 文案插值（占位符白名单） ---------- */

/* P1.1（v0.19.0）省额下线：{saved} 从「¥X」改为区间关系叙述（产品定义 §4.2 铁律：
 * 禁精确省额——基准虚高 1.5–3 倍已由 P0 证实，方向都可能是反的）。
 * 关系等级按方案中值 vs 直飞参考：低三成以上 / 略低 / 相当 / 不优。 */
export function savedRelation(price, direct) {
  const d = direct ? direct.price : null;
  if (!d || d <= 0) return '暂无直飞参考';
  const ratio = price.mid / d;
  if (ratio <= 0.7) return '比直飞参考低约三成以上';
  if (ratio <= 0.9) return '比直飞参考略低';
  if (ratio <= 1.1) return '与直飞参考相当';
  return '暂不优于直飞参考';
}

export function aiValues(plan, derived) {
  const transfers = plan.stops.filter((s) => s.kind === 'transfer');
  const conn = plan.risks.find((r) => r.factor === 'connection');
  const trf = plan.risks.find((r) => r.factor === 'transfer');
  const v = {
    saved: savedRelation(derived.price, derived.direct),
    price_min: yuan(derived.price.min),
    price_max: yuan(derived.price.max),
    price_mid: yuan(derived.price.mid),
    total_time: hm(derived.total_min),
    direct_price: derived.direct ? yuan(derived.direct.price) : '',
    from: plan.from,
    to: plan.to
  };
  transfers.forEach((t, i) => {
    v[`transfer_city_${i + 1}`] = t.city;
    v[`wait_min_${i + 1}`] = hm(t.wait_min);
  });
  if (conn && conn.raw.transfer_min) v['transfer_min_1'] = String(conn.raw.transfer_min);
  if (trf && trf.raw.min) v['transfer_min_1'] = String(trf.raw.min);
  if (trf && trf.raw.km) v['transfer_km_1'] = String(trf.raw.km);
  return v;
}

export function interpolate(text, values) {
  return text.replace(/\{([a-z_0-9]+)\}/g, (m, k) => (k in values ? values[k] : m));
}

/* ---------- 服务层 Plan 组装 ---------- */

export function derivePlan(plan, direct, isTpl) {
  const times = deriveTimes(plan);
  const price = derivePrice(plan, direct);
  const derived = { ...times, price, direct };
  const values = aiValues(plan, derived);
  /* 样本新鲜度：取各段价格带与直飞基准中最新的 sampled_at（前端据此显示「更新于 X 前」） */
  const sampled = plan.segs
    .map((s) => s.price_band && s.price_band.sampled_at)
    .concat(direct && direct.sampled_at ? [direct.sampled_at] : [])
    .filter(Boolean)
    .sort();
  const svc = {
    id: plan.id,
    type: isTpl ? 'tpl' : 'plan',
    from: plan.from,
    to: plan.to,
    totalTime: '总 ' + hm(times.total_min),
    price: price.min === price.max ? yuan(price.min) : band(price.min, price.max),
    priceMid: price.mid,
    saved: savedRelation(price, direct),
    modes: [...new Set(plan.segs.map((s) => s.mode))],
    stops: plan.stops.map(fmtStop),
    segs: plan.segs.map(fmtSeg),
    risks: deriveRisks(plan.risks),
    play: plan.play || null,
    sampledAt: sampled.length ? sampled[sampled.length - 1] : null
  };
  if (plan.ai && plan.ai.status !== 'draft') {
    svc.ai = {
      summary: interpolate(plan.ai.summary, values),
      fit: interpolate(plan.ai.fit, values),
      notice: interpolate(plan.ai.notice, values),
      play_intro: interpolate(plan.ai.play_intro, values)
    };
  }
  if (isTpl) {
    svc.price = yuan(price.mid); // 模板卡展示中值单价
    ['badge', 'region', 'contributor', 'rating', 'walkers', 'img', 'desc'].forEach((k) => {
      if (plan[k] != null) svc[k] = plan[k];
    });
  }
  return svc;
}

/* ---------- 全库组装：输出与现前端消费形状一致的 DB ---------- */

export function buildServiceDB(store) {
  const directByRoute = {};
  store.route_pairs.forEach((rp) => { directByRoute[rp.route_id] = rp.direct; });

  const plansById = {};
  store.plans.forEach((p) => { plansById[p.id] = p; });

  const routes = {};
  store.route_pairs.forEach((rp) => {
    routes[rp.route_id] = {
      direct: {
        price: yuan(rp.direct.price),
        time: hm(rp.direct.duration_min),
        note: `直飞基准 · ${rp.from} ⇄ ${rp.to}`
      },
      plans: rp.plan_ids.map((id) => derivePlan(plansById[id], rp.direct, false))
    };
  });

  const templates = store.templates.map((t) => {
    if (t.ref) {
      const base = plansById[t.ref];
      const merged = { ...base, id: t.id, ...t, ref: undefined };
      return derivePlan(merged, directByRoute[base.route_id], true);
    }
    return derivePlan(t, null, true);
  });

  return { cities: store.cities, routes, templates };
}

/* ---------- P1.7（v0.19.0）双向路由：A-B 查询回落 B-A 并反转展示 ----------
 * 反转规则：stops/segs 序列倒序 + 起终互换 + 站点互换 + day_offset 语义保持
 * （原到达日变出发日，恒非负）；wait_min/risks/价格不变。直飞基准如实标注「反向基准」。 */
export function reverseRoute(route, from, to) {
  const reversePlan = (p) => {
    const stops = p.stops.slice().reverse();
    const rekind = { origin: 'dest', dest: 'origin', transfer: 'transfer' };
    const newStops = stops.map((s) => ({ ...s, kind: rekind[s.kind] || s.kind }));
    const newSegs = p.segs.slice().reverse().map((s) => ({
      ...s,
      from_station: s.to_station,
      to_station: s.from_station,
      dep: s.arr,
      dep_day: s.arr_day,
      arr: s.dep,
      arr_day: s.dep_day
    }));
    return {
      ...p,
      from: from, to: to,
      stops: newStops,
      segs: newSegs,
      risks: p.risks
    };
  };
  return {
    direct: route.direct
      ? { ...route.direct, note: (route.direct.note || '') + '（反向查询 · 以对向直飞基准为参考）' }
      : null,
    plans: route.plans.map(reversePlan),
    reversed: true
  };
}
