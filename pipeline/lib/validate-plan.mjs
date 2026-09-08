/* validate-plan.mjs · 方案结构一致性校验（存储层）
 * 拦截：stops/segs 数量不齐、时刻与时长矛盾、衔接 wait_min 与班次不符、
 *      价格缺失、四因子缺项、connection 原始值与实际停留不符。
 * 旧 mock 三处内部矛盾（p-bjks-3/p-bjwl-2/p-shkm-2）即此类问题，现由构建前置拦截。 */

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const CORE_FACTORS = ['baggage', 'refund'];
const TRANSFER_FACTORS = ['connection', 'transfer']; // 仅有中转站时才要求

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const absMin = (day, hhmm) => day * 1440 + toMin(hhmm);

export function validatePlan(plan) {
  const errors = [];
  const id = plan.id || '(无 id)';
  const err = (m) => errors.push(`${id}: ${m}`);

  if (!plan.id || !plan.from || !plan.to) err('缺 id/from/to');
  if (!Array.isArray(plan.stops) || !Array.isArray(plan.segs)) { err('缺 stops/segs'); return errors; }
  if (plan.stops.length !== plan.segs.length + 1) err(`stops(${plan.stops.length}) 应等于 segs(${plan.segs.length}) + 1`);
  if (plan.stops.length < 2) return errors;

  plan.stops.forEach((s, i) => {
    const expect = i === 0 ? 'origin' : i === plan.stops.length - 1 ? 'dest' : 'transfer';
    if (s.kind !== expect) err(`stops[${i}] kind 应为 ${expect}，实为 ${s.kind}`);
  });
  if (plan.stops[0].city !== plan.from) err(`from(${plan.from}) 与首站(${plan.stops[0].city}) 不符`);
  const last = plan.stops[plan.stops.length - 1];
  if (last.city !== plan.to) err(`to(${plan.to}) 与末站(${last.city}) 不符`);

  plan.segs.forEach((seg, i) => {
    if (!['train', 'plane'].includes(seg.mode)) err(`segs[${i}] mode 非法: ${seg.mode}`);
    if (!TIME_RE.test(seg.dep) || !TIME_RE.test(seg.arr)) err(`segs[${i}] 时刻格式非法: ${seg.dep}/${seg.arr}`);
    if (!Number.isInteger(seg.dep_day) || !Number.isInteger(seg.arr_day) || seg.arr_day < seg.dep_day) err(`segs[${i}] day 偏移非法`);
    const dur = absMin(seg.arr_day, seg.arr) - absMin(seg.dep_day, seg.dep);
    if (dur !== seg.duration_min) err(`segs[${i}] duration_min(${seg.duration_min}) 与时刻差(${dur}) 不符`);
    const hasFixed = seg.fixed_price != null;
    const hasBand = seg.price_band != null;
    if (hasFixed === hasBand) err(`segs[${i}] 须且只须有 fixed_price 或 price_band`);
    if (hasBand && !(seg.price_band.min > 0 && seg.price_band.max >= seg.price_band.min && seg.price_band.sampled_at)) err(`segs[${i}] price_band 字段不完整（min/max/sampled_at）`);
  });

  /* stops 与 segs 时刻互锁 */
  if (plan.segs.length) {
    const o = plan.stops[0];
    if (o.depart !== plan.segs[0].dep) err(`首站 depart(${o.depart}) ≠ segs[0].dep(${plan.segs[0].dep})`);
    if (o.day_offset !== plan.segs[0].dep_day) err(`首站 day_offset(${o.day_offset}) ≠ segs[0].dep_day(${plan.segs[0].dep_day})`);
    if (last.arrive !== plan.segs[plan.segs.length - 1].arr) err(`末站 arrive(${last.arrive}) ≠ 末段 arr(${plan.segs[plan.segs.length - 1].arr})`);
    if (last.day_offset !== plan.segs[plan.segs.length - 1].arr_day) err(`末站 day_offset ≠ 末段 arr_day`);
  }
  plan.stops.forEach((s, i) => {
    if (s.kind !== 'transfer') return;
    const prev = plan.segs[i - 1], next = plan.segs[i];
    if (!prev || !next) return;
    const wait = absMin(next.dep_day, next.dep) - absMin(prev.arr_day, prev.arr);
    if (wait !== s.wait_min) err(`${s.city} 停留 wait_min(${s.wait_min}) 与班次衔接(${wait}min) 不符`);
  });

  /* 风险因子：直达方案无中转站，不要求 connection/transfer */
  const factors = (plan.risks || []).map((r) => r.factor);
  const hasTransfer = plan.stops.some((s) => s.kind === 'transfer');
  CORE_FACTORS.forEach((f) => { if (!factors.includes(f)) err(`缺核心风险因子 ${f}`); });
  if (hasTransfer) TRANSFER_FACTORS.forEach((f) => { if (!factors.includes(f)) err(`缺核心风险因子 ${f}`); });
  const conn = (plan.risks || []).find((r) => r.factor === 'connection');
  if (conn && conn.raw) {
    const stop = plan.stops.find((s) => s.kind === 'transfer' && s.city === conn.raw.city);
    if (!stop) err(`connection 城市 ${conn.raw.city} 不是中转站`);
    else if (conn.raw.wait_min !== stop.wait_min) err(`connection.wait_min(${conn.raw.wait_min}) 与 ${stop.city} 停留(${stop.wait_min}) 不符`);
  }

  return errors;
}

export function validateStorePlans(store) {
  const errors = [];
  const ids = new Set();
  const checkId = (p) => {
    if (ids.has(p.id)) errors.push(`${p.id}: id 重复`);
    ids.add(p.id);
  };
  store.plans.forEach((p) => { checkId(p); errors.push(...validatePlan(p)); });
  store.templates.forEach((t) => {
    checkId(t);
    if (t.ref) {
      if (!store.plans.some((p) => p.id === t.ref)) errors.push(`${t.id}: ref ${t.ref} 不存在`);
    } else {
      errors.push(...validatePlan(t));
    }
  });
  store.route_pairs.forEach((rp) => {
    if (rp.route_id !== `${rp.from}-${rp.to}`) errors.push(`${rp.route_id}: route_id 应为 from-to`);
    if (!rp.direct || !(rp.direct.price > 0) || !(rp.direct.duration_min > 0)) errors.push(`${rp.route_id}: direct 基准缺失`);
    rp.plan_ids.forEach((pid) => {
      const p = store.plans.find((x) => x.id === pid);
      if (!p) errors.push(`${rp.route_id}: plan_ids 引用了不存在的 ${pid}`);
      else if (p.route_id !== rp.route_id) errors.push(`${pid}: route_id(${p.route_id}) 与所属路线对(${rp.route_id}) 不符`);
    });
  });
  return errors;
}
