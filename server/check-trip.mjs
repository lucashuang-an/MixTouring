/* check-trip.mjs · 行程契约确定性测试（G1 · 模式同 pipeline/check-geo.mjs，纯函数无服务依赖）
 * v0.25.2 依复审（工作记录 v0.25.1 八项发现）重写：
 *  - T07 改走 decorateLeg 真实组装路径（不再绕过入口单独调用 zonedToUtc）；
 *  - 回放固定时钟 now=2026-09-17（样本过期不再随运行日期漂移）；
 *  - 八项复审反例逐条入回归（R1–R8）。
 * v0.26.0 增补服务动作测试：extractIntentFields（T01/T02 规则部分）+ searchTripStrategies（fixture 驱动，
 * 含「反向查询不反转、返回探索态」断言——T06 的服务层回归）。LLM 路径（parseTripIntent 全量）由
 * verify.mjs 在有 key 环境冒烟，此处不测不确定性。
 * 运行：node server/check-trip.mjs */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateTripQuery, validateStrategy, validateLeg,
  decorateLeg, connectionGapMinutes, checkConnections,
  detectReversal, buildCostBreakdown, canClaimCheaper,
  evidenceState, legFreshness, nextVersion
} from './lib/trip.mjs';
import { extractIntentFields, parseTripIntent, searchTripStrategies, buildVerificationChecklist, resolveRoute, findPlace, capabilities } from './lib/trip-service.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, name) => { if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

const FIXTURE = JSON.parse(readFileSync(join(root, 'pipeline/data/trips/almaty-g0.json'), 'utf8'));
const Q = FIXTURE.query;
const NOW = new Date('2026-09-17T00:00:00+08:00').getTime(); /* 固定回放时钟（复审⑦） */

/* ---------- 日期属性（v0.24.2 教训：星期/日期一律代码验证，禁心算） ---------- */
{
  const wd = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
  ok(wd('2026-10-07') === 3 && wd('2026-09-30') === 3, '日期属性代码验证：2026-09-30 与 10-07 均为周三');
  ok(wd('2026-10-03') === 6 && wd('2026-10-05') === 1, 'K9795/K9796 班期锚点：10/3 周六、10/5 周一');
}

/* ---------- T07 走 decorateLeg 组装路径（复审①：起落分离时区） ---------- */
{
  const [outLeg, inLeg] = FIXTURE.dated_legs.map(decorateLeg);
  ok(outLeg.duration_min === 340, `R1 去程 PKX→ALA 用起落各自时区 = 340min/5h40m（复审反例：单时区误得 160min，实际 ${outLeg.duration_min}）`);
  ok(inLeg.duration_min === 275, `R1 返程 KC267 = 275min/4h35m（与阿斯塔纳官方一致，实际 ${inLeg.duration_min}）`);
  ok(outLeg._negative_duration_error === undefined && inLeg._negative_duration_error === undefined, 'T07 跨日/跨时区不出现负时长');
}

/* ---------- 契约验证：direction 必填 / 反转伪造 / 完整宣称（T03/T06） ---------- */
{
  const bad = validateLeg({ mode: 'plane', origin_terminal: 'A', destination_terminal: 'B' });
  ok(bad.some((e) => e.includes('direction')), 'validateLeg：缺 direction 被拒');
  const mirrorLeg = (direction, from, to, depLocal, arrLocal, tzDep, tzArr) => ({
    direction, mode: 'plane', service_no: 'CA799', origin_terminal: from, destination_terminal: to,
    depart_date: '2026-09-30', depart_local: depLocal, depart_time_zone: tzDep,
    arrive_date: '2026-09-30', arrive_local: arrLocal, arrive_time_zone: tzArr,
    source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00',
    price_sample: { amount: 1990, currency: 'CNY', scope: 'one_way' }, baggage_terms: { cabin: 1 }
  });
  const fake = {
    kind: 'direct', trip_type: 'round_trip', complete: true,
    cost_breakdown: { known_total: 3980, currency: 'CNY', currency_mixed: false, unknown_costs: [] },
    outbound: [mirrorLeg('outbound', 'PEK', 'ALA', '17:45', '20:11', 'Asia/Shanghai', 'Asia/Almaty')],
    inbound: [mirrorLeg('inbound', 'ALA', 'PEK', '20:11', '17:45', 'Asia/Almaty', 'Asia/Shanghai')]
  };
  ok(validateStrategy(fake).some((e) => e.includes('禁止由去程反转充当返程')), 'R6 复审⑥：镜像往返在统一验证入口 validateStrategy 内被拒（不再依赖调用方记得额外调用）');
  ok(detectReversal(fake) === true, 'T06 反转守卫：inbound 为 outbound 镜像被识别');
}
{
  const incomplete = { kind: 'direct', trip_type: 'round_trip', complete: true, outbound: [{ direction: 'outbound', mode: 'plane', service_no: 'CZ', origin_terminal: 'PKX', destination_terminal: 'ALA', depart_date: '2026-09-30', depart_local: '18:30', depart_time_zone: 'Asia/Shanghai', arrive_date: '2026-09-30', arrive_local: '21:10', arrive_time_zone: 'Asia/Almaty', source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00' }], inbound: [] };
  const errs = validateStrategy(incomplete);
  ok(errs.some((e) => e.includes('inbound 为空')), 'T03 缺返程宣称完整往返被拒');
  const mixedDir = { kind: 'x', outbound: [{ direction: 'inbound', mode: 'plane' }] };
  ok(validateStrategy(mixedDir).some((e) => e.includes('outbound 数组混入')), '复审：outbound 数组方向一致性校验');
}

/* ---------- T08 衔接校验 ---------- */
{
  const mk = (no, from, to, d, t, tz, arrD, arrT, arrTz) => decorateLeg({ direction: 'outbound', mode: 'plane', service_no: no, origin_terminal: from, destination_terminal: to, depart_date: d, depart_local: t, depart_time_zone: tz, arrive_date: arrD, arrive_local: arrT, arrive_time_zone: arrTz || tz, source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00' });
  const l1 = mk('CZ', '北京大兴 PKX', '乌鲁木齐 URC', '2026-10-02', '14:00', 'Asia/Shanghai', '2026-10-02', '18:20', 'Asia/Urumqi');
  const l2 = mk('KC', '乌鲁木齐 URC', '阿拉木图 ALA', '2026-10-02', '22:30', 'Asia/Urumqi', '2026-10-02', '23:15', 'Asia/Almaty');
  const gap = connectionGapMinutes(l1, l2);
  ok(gap != null && gap > 0, 'T08 衔接间隔为正（UTC 中介跨时区）');
  const tight = checkConnections([l1, { ...l2, _utcDep: new Date(l1._utcArr.getTime() + 25 * 60000) }]);
  ok(tight.feasible === false, 'T08 衔接 25min 低于阈值 → 不可行');
  ok(checkConnections([l1, l2]).feasible === true, 'T08 充足衔接可行');
}

/* ---------- T05/T04 成本与同口径省钱（复审③④⑤反例） ---------- */
{
  /* R4 复审④：往返口径样本不得计入单段；行李未核验进 unknown */
  const rt = buildCostBreakdown([decorateLeg({ ...FIXTURE.dated_legs[0] })]);
  ok(rt.known_total === null, 'R4 往返口径样本不计入单段拆账（known_total=null）');
  ok(rt.unknown_costs.some((u) => u.reason.includes('不可拆分')) && rt.unknown_costs.some((u) => u.item.includes('行李')), 'R4 往返口径提示 + 行李未核验均进 unknown_costs');

  /* R3 复审③：extras 跨币种不求和 */
  const mixed = buildCostBreakdown(
    [{ direction: 'outbound', mode: 'plane', service_no: 'X1', price_sample: { amount: 1000, currency: 'CNY', scope: 'one_way' }, baggage_terms: { cabin: 1 } }],
    [{ item: '阿拉木图独住住宿 1 晚', amount: 20000, currency: 'KZT' }]
  );
  ok(mixed.currency_mixed === true && mixed.known_total === null, 'R3 附加费用跨币种不得直接相加');

  /* T05 基础：未知不算 0 */
  const hybrid = buildCostBreakdown(
    [{ direction: 'outbound', mode: 'plane', service_no: 'X1', price_sample: { amount: 900, currency: 'CNY', scope: 'one_way' }, baggage_terms: { cabin: 1 } },
     { direction: 'outbound', mode: 'train', service_no: 'T1', baggage_terms: { cabin: 1 } }],
    [{ item: '独住住宿', reason: '无价格证据' }]
  );
  ok(hybrid.unknown_costs.length === 2 && hybrid.known_total === 900, 'T05 无价段与住宿进 unknown_costs，已知只含带价段');

  const directCost = buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'CA799', price_sample: { amount: 1990, currency: 'CNY', scope: 'one_way' }, baggage_terms: { cabin: 1 } }]);
  const fullCtx = { outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', outbound_date: '2026-09-30', return_date: '2026-10-07', traveler_count: 1, currency: 'CNY', baggage: 'economy' };
  ok(canClaimCheaper(hybrid, directCost, fullCtx, fullCtx).cheaper === false, 'T05 票面 900<1990 但有未知费用 → 不得宣称更省');

  /* R5 复审⑤：口径缺失 ≠ 一致 */
  const a = buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'A', price_sample: { amount: 1000, currency: 'CNY', scope: 'one_way' }, baggage_terms: { cabin: 1 } }]);
  const b = buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'B', price_sample: { amount: 2000, currency: 'CNY', scope: 'one_way' }, baggage_terms: { cabin: 1 } }]);
  ok(canClaimCheaper(a, b, {}, {}).comparable === false, 'R5 双方口径都缺失 → 不可比（不得宣称更省）');
  ok(canClaimCheaper(a, b, { ...fullCtx }, { ...fullCtx, traveler_count: 2 }).comparable === false, 'T04 人数口径不一致 → 不可比');
  ok(canClaimCheaper(a, b, fullCtx, fullCtx).cheaper === true, 'T04 同口径且成本完整 → 可判更省');

  /* 二轮复审④：同宽泛窗但具体出行日不同 → 不可比 */
  const otherDates = { ...fullCtx, outbound_date: '2026-10-03', return_date: '2026-10-05' };
  ok(canClaimCheaper(a, b, fullCtx, otherDates).comparable === false, 'R13 同窗不同具体日期（9/30+10/7 vs 10/3+10/5）→ 不可比');
  const kzt = buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'K', price_sample: { amount: 100, currency: 'KZT', scope: 'one_way' }, baggage_terms: { cabin: 1 } }]);
  ok(canClaimCheaper(kzt, b, fullCtx, fullCtx).cheaper === false, '跨币种无已核验汇率 → 不得比较');
}

/* ---------- 证据状态机（两轮复审反例全量回归 + 固定时钟） ---------- */
const [F_OUT, F_IN] = FIXTURE.dated_legs.map((l) => ({ ...l, baggage_terms: { cabin: 1 } })); /* 行李已核验副本（隔离成本缺口） */
{
  /* G0 fixture 回放：去程往返口径不可拆分 → 重算成本含未知项 → dated_partial */
  const s = { kind: 'direct', trip_type: 'round_trip', outbound: [decorateLeg({ ...F_OUT })], inbound: [decorateLeg({ ...F_IN })] };
  ok(evidenceState(s, Q, NOW) === 'dated_partial', `G0 fixture 回放 = dated_partial（实际 ${evidenceState(s, Q, NOW)}；往返口径/行李缺口由内部重算发现）`);

  /* 旧总价掩盖反例（二轮复审③）：删去程票价 + 保留伪造高总价 → 重算权威，不得 verified */
  const masked = { kind: 'direct', trip_type: 'round_trip', outbound: [{ ...decorateLeg({ ...F_OUT }), price_sample: undefined }], inbound: [decorateLeg({ ...F_IN })], cost_breakdown: { known_total: 9999, currency: 'CNY', currency_mixed: false, unknown_costs: [] } };
  ok(evidenceState(masked, Q, NOW) !== 'dated_verified', `R11 删去程票价+伪造旧总价 → 状态判定从当前分段重算（实际 ${evidenceState(masked, Q, NOW)}）`);

  /* R9 二轮复审①：证据日期与实际出发日不符 → 视为未绑定，不得 verified */
  const misdated = {
    kind: 'direct', trip_type: 'round_trip', complete: true,
    outbound: [decorateLeg({ ...F_OUT, valid_for_date: '2026-09-29' })],
    inbound: [decorateLeg({ ...F_IN })]
  };
  misdated.cost_breakdown = { known_total: 5000, currency: 'CNY', currency_mixed: false, unknown_costs: [] };
  ok(evidenceState(misdated, Q, NOW) !== 'dated_verified', `R9 valid_for_date(9/29)≠depart_date(9/30) → 非 verified（实际 ${evidenceState(misdated, Q, NOW)}）`);

  /* R10 二轮复审①：行程时序错乱（宽窗下返程早于去程发生）→ 不得 verified */
  const wideQ = { ...Q, outbound_window: '2026-09-27 ~ 2026-10-11', return_window: '2026-09-27 ~ 2026-10-11' };
  const reversed_order = {
    kind: 'direct', trip_type: 'round_trip', complete: true,
    outbound: [decorateLeg({ ...F_OUT, depart_date: '2026-10-07', valid_for_date: '2026-10-07' })],
    inbound: [decorateLeg({ ...F_IN, depart_date: '2026-09-30', valid_for_date: '2026-09-30', arrive_date: '2026-10-01' })]
  };
  reversed_order.cost_breakdown = { known_total: 5000, currency: 'CNY', currency_mixed: false, unknown_costs: [] };
  ok(evidenceState(reversed_order, wideQ, NOW) !== 'dated_verified', `R10 返程(9/30 发)早于去程(10/7 发) → 时序门禁拦截（实际 ${evidenceState(reversed_order, wideQ, NOW)}）`);

  /* R12 二轮复审②：无效 sampled_at → stale 且验证层拒绝 */
  const badTime = { ...s, outbound: [{ ...s.outbound[0], sampled_at: 'not-a-date' }] };
  ok(legFreshness(badTime.outbound[0], NOW).stale === true, 'R12 无效取样时间 → 视为过期（不再漏过门禁）');
  ok(validateLeg({ ...F_OUT, sampled_at: 'not-a-date' }).some((e) => e.includes('sampled_at')), 'R12 validateLeg 拒绝无法解析的 sampled_at');
  ok(evidenceState(badTime, Q, NOW) !== 'dated_verified', 'R12 含无效取样时间 → 不得 dated_verified');
}
{
  /* 正例（门禁可达性）：同窗+同具体日期+双向齐+one_way 成本完整+时序正常 → dated_verified */
  const okLeg = (dir, dd, dep, arrD, arr, tzD, tzA, from, to, no, amount) => decorateLeg({ direction: dir, mode: 'plane', service_no: no, origin_terminal: from, destination_terminal: to, depart_date: dd, depart_local: dep, depart_time_zone: tzD, arrive_date: arrD, arrive_local: arr, arrive_time_zone: tzA, source_url: 'https://example.com/fixture', sampled_at: '2026-09-16T00:00:00+08:00', price_sample: { amount, currency: 'CNY', scope: 'one_way' }, baggage_terms: { cabin: 1 }, valid_for_date: dd });
  const good = {
    kind: 'direct', trip_type: 'round_trip', complete: true,
    outbound: [okLeg('outbound', '2026-09-30', '18:30', '2026-09-30', '21:10', 'Asia/Shanghai', 'Asia/Almaty', '北京大兴 PKX', '阿拉木图 ALA', 'CZ', 1990)],
    inbound: [okLeg('inbound', '2026-10-07', '21:20', '2026-10-08', '04:55', 'Asia/Almaty', 'Asia/Shanghai', '阿拉木图 T2', '北京首都 T2', 'KC267', 2300)]
  };
  ok(evidenceState(good, Q, NOW) === 'dated_verified', '门禁可达性：绑定一致+同窗+时序正常+重算成本完整 → dated_verified');
  const missingSource = { ...good, outbound: [{ ...good.outbound[0], source_url: undefined }] };
  ok(validateStrategy(missingSource).some((e) => e.includes('source_url')) && evidenceState(missingSource, Q, NOW) !== 'dated_verified', 'R14 缺段来源：结构校验与状态判定同时拒绝');
  ok(evidenceState({ ...good, outbound: [null] }, Q, NOW) !== 'dated_verified', 'R14 非法分段按不可信降级，不抛异常');
  const missingService = { ...good, outbound: [{ ...good.outbound[0], service_no: null }] };
  ok(evidenceState(missingService, Q, NOW) !== 'dated_verified', 'R14 无航班号不得出可核验卡');
  const unknownStay = { ...good, unknown_costs: [{ item: '独住住宿', reason: '未采到报价' }] };
  ok(validateStrategy(unknownStay).length === 0 && evidenceState(unknownStay, Q, NOW) !== 'dated_verified', 'R15 行程级独住费用未知阻止可核验');
  const unknownTransfer = { ...good, extras: [{ item: '机场接驳', reason: '未采到报价' }] };
  ok(evidenceState(unknownTransfer, Q, NOW) !== 'dated_verified', 'R15 附加接驳费用未知阻止可核验');
  const oldUnknown = { ...good, cost_breakdown: { known_total: 4300, unknown_costs: [{ item: '机场接驳', reason: '待核' }] } };
  ok(evidenceState(oldUnknown, Q, NOW) !== 'dated_verified', 'R15 既有拆账中的未知项不得被重算遗漏');
  const infinityPrice = { ...good, outbound: [{ ...good.outbound[0], price_sample: { amount: Infinity, currency: 'CNY', scope: 'one_way' } }] };
  ok(validateStrategy(infinityPrice).some((e) => e.includes('有限正数')) && evidenceState(infinityPrice, Q, NOW) !== 'dated_verified', 'R16 非有限票价在验证与状态门禁均拒绝');
  const negativeExtra = buildCostBreakdown([...good.outbound, ...good.inbound], [{ item: '住宿', amount: -3000, currency: 'CNY' }]);
  ok(negativeExtra.unknown_costs.some((u) => u.reason === '金额无效'), 'R16 负附加费用不得降低完整总成本');
  ok(evidenceState({ ...good, outbound: [] }, Q, NOW) !== 'dated_verified', 'T03 缺返程方向 → 不得 verified');
  ok(evidenceState({ ...good, outbound: [{ ...good.outbound[0], valid_for_date: '2026-09-29' }] }, Q, NOW) !== 'dated_verified', 'R9 对偶：正例中篡改证据日期即掉出门禁');

  /* T11 stale */
  const old = legFreshness({ ...F_OUT, sampled_at: '2026-06-01T00:00:00+08:00' }, NOW);
  ok(old.stale === true, 'T11 超过 flight_price 阈值(7天) → stale');
  const allOld = { ...good, outbound: [{ ...good.outbound[0], sampled_at: '2026-01-01T00:00:00+08:00' }], inbound: [{ ...good.inbound[0], sampled_at: '2026-01-01T00:00:00+08:00' }] };
  ok(evidenceState(allOld, Q, NOW) === 'stale', 'T11 全段过期 → stale');
}

/* ---------- T12 版本化保存 ---------- */
{
  const v1 = nextVersion(null);
  const v2 = nextVersion({ ...v1, strategies: [] });
  ok(v2.version === 2 && v1.version === 1, 'T12 版本递增且不静默覆盖');
}

/* ---------- TripQuery 验证 ---------- */
{
  ok(validateTripQuery({ origin: '北京', destination: '喀什', trip_type: 'round_trip' }).length > 0, 'round_trip 无日期窗被要求降级 pending');
  ok(validateTripQuery({ origin: '北京', destination: '北京' }).some((e) => e.includes('相同')), '起终点相同被拒');
  ok(validateTripQuery(Q).length === 0, 'G0 基线查询合法');
}

/* ---------- v0.29.3 时区转义回归（三轮评审 P2 收尾：恶意时区字符串不得进入 HTML） ---------- */
{
  /* 静态断言：trip.html 段卡时区渲染必须走 MT.esc（防止未来改动回退） */
  const tripSrc = readFileSync(join(root, 'mixtouring-hifi/pages/trip.html'), 'utf8');
  ok(tripSrc.includes('depTz = seg.depart_time_zone ? MT.esc(seg.depart_time_zone)'), '转义回归：出发时区渲染走 MT.esc');
  ok(tripSrc.includes('arrTz = seg.arrive_time_zone ? MT.esc(seg.arrive_time_zone)'), '转义回归：抵达时区渲染走 MT.esc');
  /* 行为断言：与 app.js 的 MT.esc 同逻辑（转义后不含原始 payload） */
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const evil = '<img src=x onerror=alert(1)>';
  ok(!esc(evil).includes('<img') && esc(evil).includes('&lt;img'), '转义行为：恶意时区字符串被转义');
  ok(esc(null) === '' && esc(undefined) === '' && esc('') === '', '转义鲁棒性：空值输入返回空串（不抛错）');
}

/* ---------- R8 复审⑧：fixture 星期残留清理 ---------- */
{
  ok(!JSON.stringify(FIXTURE).includes('周二'), 'R8 fixture 无「周二」残留（CA799 note 已更正为周三）');
}

/* ---------- v0.26.0 服务动作：意图提取（T01/T02 规则部分，确定性） ---------- */
{
  const i1 = extractIntentFields('国庆附近一个人从北京去阿拉木图，玩几天后回来', NOW);
  ok(i1.trip_type === 'round_trip' && i1.traveler_count === 1, 'T02 意图：往返 + 一人（solo）识别');
  const i2 = extractIntentFields('北京到乌鲁木齐 单程');
  ok(i2.trip_type === 'one_way', '意图：单程关键词');
  const i3 = extractIntentFields('北京到喀什');
  ok(i3.trip_type === undefined, '无往返/单程线索 → 不猜 trip_type（交给 parseTrip 默认）');
}

/* ---------- v0.26.3 复审①②③回归（解析层三缺口） ---------- */
{
  /* R14 复审③：「直达」是交通偏好不是行程类型 */
  ok(extractIntentFields('北京直达阿拉木图').trip_type === undefined, 'C3 「直达」不再误判 one_way → 维持待确认');
  ok(extractIntentFields('北京到乌鲁木齐 单程').trip_type === 'one_way', 'C3 明确「单程」仍识别');

  /* R15 复审②：「国庆附近」保留弹性假期区间（固定时钟 2026-09-17 → 当年窗口） */
  const near = extractIntentFields('国庆附近一个人从北京去阿拉木图', NOW);
  ok(near.outbound_window === '2026-09-27 ~ 2026-10-07', `C2 国庆附近 → 假期宽窗（实际 ${near.outbound_window}），不收缩为 10/01`);
  const nearNextYear = extractIntentFields('国庆附近出发', new Date('2026-10-20').getTime());
  ok(nearNextYear.outbound_window === '2027-09-27 ~ 2027-10-07', 'C2 已过 10/7 → 次年窗口');

  /* R16 复审①：parseTripIntent 合并 Trip 城市词典——真实城市源识别阿拉木图（规则版确定性） */
  const tripCities = JSON.parse(readFileSync(join(root, 'pipeline/data/trips/trip-cities.json'), 'utf8')).cities;
  const r = await parseTripIntent('国庆附近一个人从北京去阿拉木图，玩几天后回来', ['北京', '上海'], tripCities, NOW);
  ok(r.query.origin === '北京' && r.query.destination === '阿拉木图', `C1 真实词典解析国际 OD（实际 ${r.query.origin}→${r.query.destination}）`);
  ok(r.query.trip_type === 'round_trip' && r.query.traveler_count === 1, 'C1 往返 + 1 人');
  ok(r.query.outbound_window === '2026-09-27 ~ 2026-10-07', 'C1 假期宽窗（不收缩为单日）');
  ok(r.needs_confirmation.some((n) => n.includes('返程')), 'C1 返程窗仍要求用户补全（不推断）');
  /* 明确「10 月 1 日」输入 → 单日窗（不误伤精确意图） */
  const exact = await parseTripIntent('10月1日从北京去阿拉木图', ['北京'], tripCities, NOW);
  ok(exact.query.outbound_window === '2026-10-01 ~ 2026-10-01', `C1 明确日期 → 单日窗（实际 ${exact.query.outbound_window}）`);
  /* 未知城市仍待确认（不编造） */
  const unknownCity = await parseTripIntent('从北京去乌兰巴托', ['北京'], tripCities, NOW);
  ok(unknownCity.query.destination === null && unknownCity.needs_confirmation.some((n) => n.includes('目的地')), 'C1 未知城市保持待确认（trip 词典外不编造）');
}

/* ---------- v0.29.0 决策③：确定性国内/国际路由（v0.29.1 评审二轮 P0-2 更新：港澳台进国际） ---------- */
{
  ok(resolveRoute('北京', '喀什').route_type === 'domestic', '决策③验收：北京→喀什 → 国内链路');
  ok(resolveRoute('北京', '阿拉木图').route_type === 'international', '决策③验收：北京→阿拉木图 → 国际链路');
  /* 评审二轮 P0-2 更正：港澳台按既定规则进入国际链路（is_mainland=false），不再是 needs_confirmation */
  ok(resolveRoute('北京', '香港').route_type === 'international', '二轮 P0-2：北京→香港 → international');
  ok(resolveRoute('香港', '北京').route_type === 'international', '二轮 P0-2：香港→北京（反向）→ international');
  ok(resolveRoute('北京', '澳门').route_type === 'international', '二轮 P0-2：北京→澳门 → international');
  ok(resolveRoute('北京', '台北').route_type === 'international', '二轮 P0-2：北京→台北 → international');
  ok(resolveRoute('香港', '台北').route_type === 'international', '港澳台互往 → international（不建第三套链路）');
  ok(resolveRoute('阿拉木图', '北京').route_type === 'international', '反向国际 OD 同样走国际链路（仍不做反转构造返程）');
  ok(findPlace('阿拉木图').tz === 'Asia/Almaty' && findPlace('北京').tz === 'Asia/Shanghai', '地点词典含国家与时区（PlaceResolver 底座）');
  ok(findPlace('香港').is_mainland === false && findPlace('北京').is_mainland === true, 'is_mainland 口径：港澳台非大陆');
  /* 评审二轮 P1-5 + v0.31.0 P1-4：capabilities 配置与最近真实状态分开、版本拆分 */
  ok(capabilities(false, false).llm === false && capabilities(false, false).web_search_configured === false, 'P1-5 组合1：均关');
  ok(capabilities(true, false).llm === true && capabilities(true, false).web_search_configured === false, 'P1-5 组合2：仅 LLM → web_search_configured=false');
  ok(capabilities(false, true).web_search_configured === true && capabilities(false, true).llm === false, 'P1-5 组合3：仅 web_search 配置');
  ok(capabilities(true, true).llm === true && capabilities(true, true).web_search_configured === true, 'P1-5 组合4：均开');
  ok(capabilities(true, true, 'quota_exhausted').web_search_status === 'quota_exhausted' &&
    capabilities(true, true, 'quota_exhausted').web_search_configured === true, 'P1-4：配置成功但状态如实为 quota_exhausted');
  ok(capabilities(true, true).trip_planner_version === 'v0.29.1' &&
    capabilities(true, true).anywhere_planner_version === 'v0.40.2', 'P1-4：版本拆分（trip/anywhere 各自对齐）');
}

/* ---------- v0.26.0 服务动作：策略检索（fixture 驱动 + 反向不反转） ---------- */
{
  const hit = searchTripStrategies({ origin: '北京', destination: '阿拉木图', trip_type: 'round_trip', outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1, currency: 'CNY' }, NOW);
  ok(hit.strategies.length === 1 && hit.evidence_state === 'dated_partial', `检索命中 G0 样本 → dated_partial（实际 ${hit.evidence_state}）`);
  const st = hit.strategies[0];
  ok(st.structure.length === 2 && st.structure.every((s) => s.source_url), '策略卡结构：双向段齐 + 每段带来源');
  ok(st.price_samples.every((p) => /非当日可购/.test(p.note)), '价格样本标注「非当日可购」（探索与核验助手边界）');
  ok(st.cost_breakdown.unknown_costs.length > 0, '成本未知项如实列出（往返口径不可拆分/行李未核）');
  ok(hit.next_steps.length > 0, '给出真实下一步');

  /* T06 服务层回归：反向查询不做反转，返回探索态 + 心愿引导 */
  const rev = searchTripStrategies({ origin: '阿拉木图', destination: '北京', trip_type: 'round_trip', outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1, currency: 'CNY' }, NOW);
  ok(rev.evidence_state === 'explore' && rev.strategies.length === 0, '反向查询（阿拉木图→北京）→ 探索态，不由 B–A 反转构造');
  ok(rev.next_steps.some((s) => s.includes('登记')), '反向查询给登记心愿引导');

  const unknown = searchTripStrategies({ origin: '北京', destination: '亚的斯亚贝巴', trip_type: 'pending', traveler_count: 1, currency: 'CNY' }, NOW);
  ok(unknown.evidence_state === 'explore', '未覆盖 OD → explore');
}

/* ---------- v0.26.0 服务动作：核验清单 ---------- */
{
  const legs = FIXTURE.dated_legs.map(decorateLeg);
  const cl = buildVerificationChecklist({ outbound: [legs[0]], inbound: [legs[1]] });
  ok(cl.checklist.length === 2, '核验清单：双向逐段');
  ok(cl.checklist.every((r) => r.query_entry && r.local_times && Array.isArray(r.missing)), '每段含查询入口/当地时刻/待核项');
  ok(cl.checklist.some((r) => r.missing.includes('班次/航班号未核验')), 'G0 去程 price-only（无航班号）如实列为待核项');
  ok(!cl.note.includes('余票掌握'), '清单声明不掌握余票（交易边界）');
}

/* ---------- v0.26.1 四项接口契约回归：解析 → 检索 → 清单 ---------- */
{
  const parsed = await parseTripIntent('9月30日从北京去阿拉木图往返', ['北京', '阿拉木图']);
  ok(parsed.query.trip_type === 'round_trip' && /^\d{4}-09-30 ~ \d{4}-09-30$/.test(parsed.query.outbound_window || ''), '往返意图日期统一为查询契约 YYYY-MM-DD');
  ok(parsed.needs_confirmation.some((s) => s.includes('返程')), '已识别去程日期但缺返程窗时要求补全');
  const ambiguous = await parseTripIntent('国庆从北京去阿拉木图', ['北京', '阿拉木图']);
  ok(ambiguous.query.trip_type === 'pending' && ambiguous.needs_confirmation.some((s) => s.includes('单程还是往返')), '未明说单/往返时不根据日期猜单程');

  const parsedSearch = searchTripStrategies({ ...parsed.query, outbound_window: '2026-09-30 ~ 2026-09-30' }, NOW);
  ok(parsedSearch.evidence_state === 'dated_partial', '解析的行程意图配合固定日期回放可命中指定日部分证据');
  const card = parsedSearch.strategies[0];
  const cardChecklist = buildVerificationChecklist(card);
  ok(cardChecklist.checklist.length === card.structure.length && cardChecklist.checklist.length === 2, '检索卡直接生成双向逐段清单');
  ok(card.outbound[0].sampled_at && card.inbound[0].sampled_at && card.structure.every((l) => l.sampled_at && l.valid_for_date), '检索响应逐段保留来源取样时间与有效日期');
  ok(cardChecklist.checklist[0].sampled_at && cardChecklist.checklist[0].local_times.includes('Asia/Shanghai') && cardChecklist.checklist[0].local_times.includes('Asia/Almaty'), '清单保留取样时间与起落各自时区');

  const oneWay = searchTripStrategies({ ...Q, trip_type: 'one_way', return_window: null }, NOW);
  ok(oneWay.strategies.length === 1 && oneWay.strategies[0].outbound.length === 1 && oneWay.strategies[0].inbound.length === 0 && oneWay.strategies[0].structure.every((l) => l.direction === 'outbound'), '单程查询只返回去程，不混入返程成本与班次');
  ok(oneWay.strategies[0].cost_breakdown.known_total === null, '单程不能把往返口径样本价计为已知票价');
  const pending = searchTripStrategies({ ...Q, trip_type: 'pending', outbound_window: null, return_window: null }, NOW);
  ok(pending.strategies[0].inbound.length === 0 && pending.evidence_state === 'historical', '待确认行程只展示起终点方向历史参考');
}

console.log(fail ? `\n✗ ${fail} 项未通过` : '\n✓ 行程契约确定性测试全部通过');
process.exit(fail ? 1 : 0);
