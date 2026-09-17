/* check-trip.mjs · 行程契约确定性测试（G1 · 模式同 pipeline/check-geo.mjs，纯函数无服务依赖）
 * 覆盖开发流程 §3 的自动化验收点：T03 / T05 / T06 / T07 / T08 / T11 / T12 + 显式伪造 fixture
 * 检查「不出卡 / 不省钱 / 不反转」。运行：node server/check-trip.mjs */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateTripQuery, validateStrategy, validateLeg,
  zonedToUtc, decorateLeg, connectionGapMinutes, checkConnections,
  detectReversal, buildCostBreakdown, canClaimCheaper,
  evidenceState, legFreshness, nextVersion
} from './lib/trip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, name) => { if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

const FIXTURE = JSON.parse(readFileSync(join(root, 'pipeline/data/trips/almaty-g0.json'), 'utf8'));
const Q = FIXTURE.query;

/* ---------- T07 时区与跨日计算（UTC 中介，v0.24.0 时区误判的回归防线） ---------- */
{
  const dep = zonedToUtc('2026-09-30', '17:45', 'Asia/Shanghai');
  const arr = zonedToUtc('2026-09-30', '20:11', 'Asia/Almaty');
  ok(Math.round((arr - dep) / 60000) === 326, 'T07 跨时区时长 5h26m（17:45+08:00→20:11+05:00）');
}
{
  /* KC267 跨午夜+跨时区：ALA 21:20(+05:00) → 次日 04:55(+08:00)。
   * 钟面差 7h35m，但时区东移 3h——UTC 中介算出真实飞行时长 4h35m（与阿斯塔纳官方一致）。
   * （v0.24.0 教训回归点：禁止钟面心算，UTC 中介正是防这个的） */
  const dep = zonedToUtc('2026-10-07', '21:20', 'Asia/Almaty');
  const arr = zonedToUtc('2026-10-08', '04:55', 'Asia/Shanghai');
  ok(Math.round((arr - dep) / 60000) === 275, 'T07 跨午夜+跨时区真实飞行时长 4h35m（KC267 官方口径）');
  ok(Math.round((arr - dep) / 60000) > 0, 'T07 跨日不出现负时长');
}

/* ---------- 契约验证：direction 必填 / 反转伪造 / 完整宣称（T03/T06） ---------- */
{
  const bad = validateLeg({ mode: 'plane', origin_terminal: 'A', destination_terminal: 'B' });
  ok(bad.some((e) => e.includes('direction')), 'validateLeg：缺 direction 被拒');
  const fake = {
    kind: 'direct', trip_type: 'round_trip', complete: true,
    outbound: [{ direction: 'outbound', mode: 'plane', service_no: 'CA799', origin_terminal: 'PEK', destination_terminal: 'ALA', depart_local: '17:45', arrive_local: '20:11', time_zone: 'Asia/Shanghai', depart_date: '2026-09-30', source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00' }],
    inbound: [{ direction: 'inbound', mode: 'plane', service_no: 'CA799', origin_terminal: 'ALA', destination_terminal: 'PEK', depart_local: '20:11', arrive_local: '17:45', time_zone: 'Asia/Almaty', depart_date: '2026-10-07', source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00' }]
  };
  ok(detectReversal(fake) === true, 'T06 反转守卫：inbound 为 outbound 镜像被识别');
  ok(validateStrategy(fake).length > 0 || detectReversal(fake), 'T06 伪造反转 fixture 被拦截（同班次镜像时刻表）');
}
{
  const incomplete = { kind: 'direct', trip_type: 'round_trip', complete: true, outbound: [{ direction: 'outbound', mode: 'plane', service_no: 'CZ', origin_terminal: 'PKX', destination_terminal: 'ALA', depart_local: '18:30', arrive_local: '21:10', time_zone: 'Asia/Shanghai', depart_date: '2026-09-30', source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00' }], inbound: [] };
  const errs = validateStrategy(incomplete);
  ok(errs.some((e) => e.includes('inbound 为空')), 'T03 缺返程宣称完整往返被拒');
}

/* ---------- T08 衔接校验 ---------- */
{
  const mk = (no, from, to, d, t, tz, arrD, arrT) => decorateLeg({ direction: 'outbound', mode: 'plane', service_no: no, origin_terminal: from, destination_terminal: to, depart_date: d, depart_local: t, time_zone: tz, arrive_date: arrD, arrive_local: arrT, source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00' });
  /* 乌鲁木齐国际转机：段1 14:15 抵（+05:00 假设 URC 用 Asia/Urumqi UTC+6 → 按当地时刻写），段2 当日 18:30 发 */
  const l1 = mk('CZ', '北京大兴 PKX', '乌鲁木齐 URC', '2026-10-02', '14:00', 'Asia/Shanghai', '2026-10-02', '18:20');
  const l2 = mk('KC', '乌鲁木齐 URC', '阿拉木图 ALA', '2026-10-02', '22:30', 'Asia/Urumqi', '2026-10-02', '23:15');
  const gap = connectionGapMinutes(l1, l2);
  ok(gap != null && gap > 0, 'T08 衔接间隔为正（UTC 中介跨时区）');
  const tight = checkConnections([l1, { ...l2, _utcDep: new Date(l1._utcArr.getTime() + 25 * 60000) }]);
  ok(tight.feasible === false, 'T08 衔接 25min 低于阈值 → 不可行');
  const fine = checkConnections([l1, l2]);
  ok(fine.feasible === true, 'T08 充足衔接可行');
}

/* ---------- T05 未知费用与同口径省钱（铁律） ---------- */
{
  const hybridCost = buildCostBreakdown(
    [{ direction: 'outbound', mode: 'plane', service_no: 'X1', price_sample: { amount: 900, currency: 'CNY' } },
     { direction: 'outbound', mode: 'train', service_no: 'T1' }],
    [{ item: '阿拉木图独住住宿 1 晚', reason: '无价格证据' }]
  );
  ok(hybridCost.unknown_costs.length === 2, 'T05 无价段与住宿进 unknown_costs（未知不得算 0）');
  ok(hybridCost.known_total === 900, 'T05 已知项只含带价段');
  const directCost = buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'CA799', price_sample: { amount: 1990, currency: 'CNY' } }]);
  const r1 = canClaimCheaper(hybridCost, directCost, {}, {});
  ok(r1.comparable === true && r1.cheaper === false, 'T05 票面 900<1990 但有未知费用 → 不得宣称更省');
  const r2 = canClaimCheaper(buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'A', price_sample: { amount: 800, currency: 'CNY' } }]), directCost, { traveler_count: 1 }, { traveler_count: 2 });
  ok(r2.comparable === false, 'T04 人数口径不一致 → 不可比');
  const r3 = canClaimCheaper(buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'A', price_sample: { amount: 1500, currency: 'CNY' } }]), directCost, { outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1, currency: 'CNY', baggage: 'economy' }, { outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1, currency: 'CNY', baggage: 'economy' });
  ok(r3.comparable === true && r3.cheaper === true, 'T04 同口径且成本完整 → 可判更省');
  const r4 = canClaimCheaper(buildCostBreakdown([{ direction: 'outbound', mode: 'plane', service_no: 'A', price_sample: { amount: 100, currency: 'KZT' } }]), directCost, {}, {});
  ok(r4.comparable === true && r4.cheaper === false, 'T05 混合币种未换算 → 不得宣称更省');
}

/* ---------- 证据状态机（G0 样本回放：dated 样本只能到 dated_partial） ---------- */
{
  const [outLeg, inLeg] = FIXTURE.dated_legs.map(decorateLeg);
  const s = { kind: 'direct', trip_type: 'round_trip', outbound: [outLeg], inbound: [inLeg] };
  const st = evidenceState(s, Q);
  ok(st === 'dated_partial', `G0 fixture 回放：双向 dated 样本 → dated_partial（实际 ${st}；行李/口径缺口阻止 dated_verified）`);
  const onlyOut = { kind: 'direct', trip_type: 'round_trip', outbound: [outLeg], inbound: [] };
  ok(evidenceState(onlyOut, Q) === 'dated_partial', 'T03 单向 dated → 不得 verified');
  const noDate = { kind: 'direct', trip_type: 'pending', outbound: [{ ...decorateLeg({ direction: 'outbound', mode: 'plane', service_no: 'CA799', origin_terminal: 'PEK', destination_terminal: 'ALA', depart_date: '2026-10-01', depart_local: '17:45', arrive_date: '2026-10-01', arrive_local: '20:11', time_zone: 'Asia/Shanghai', source_url: 'x', sampled_at: '2026-09-16T00:00:00+08:00' }), valid_for_date: null }], inbound: [] };
  ok(evidenceState(noDate, { outbound_window: null, return_window: null }) === 'historical', '无日期绑定 → historical（审查修正①的回归防线）');
  const old = legFreshness({ ...outLeg, sampled_at: '2026-06-01T00:00:00+08:00' }, new Date('2026-09-16').getTime());
  ok(old.stale === true, 'T11 超过 flight_price 阈值(7天) → stale');
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

console.log(fail ? `\n✗ ${fail} 项未通过` : '\n✓ 行程契约确定性测试全部通过');
process.exit(fail ? 1 : 0);
