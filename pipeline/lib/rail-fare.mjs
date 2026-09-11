/* rail-fare.mjs · 铁路票价规则估算器（开发计划 Sprint 2.2 预演版 / P0 混搭腿支撑）
 * 原理：中国铁路公布票价 = f(里程, 席别, 车型)。完整规则需要铁路里程表（暂缺），
 * 本版用「大地距离 × 铁路绕行系数」估计里程、按速度分档套每公里费率带，
 * 费率带用 plans.json 已知 14 条真实票价校准（见 calibrate()）。
 * 诚实边界：输出是【区间】不是精确值（里程估计 ±15%、费率带 ±15%）；
 * 精确化路径 = 接入铁路里程表 + 各线基价（P2 Sprint 2.2 正式版）。
 * 用法：import { railFare, calibrate } from './rail-fare.mjs' */

import { loadGeo, haversineKm } from './geo-skill.mjs';

/* 每公里费率带（元/人公里，含空调；校准样本见 calibrate()）
 * [低, 高]：费率受线路等级（350/250/200 km/h 客专、普速）、调价浮动影响 */
const RATES = {
  highspeed: { label: '高铁 G/C', seats: { 二等座: [0.38, 0.50], 一等座: [0.62, 0.80] } },
  bullet: { label: '动车 D', seats: { 二等座: [0.26, 0.34], 一等座: [0.42, 0.55] } },
  express: { label: '普速快车 K/T/Z', seats: { 硬座: [0.13, 0.19], 硬卧: [0.20, 0.28], 软卧: [0.30, 0.42] } },
  slow: { label: '普速慢车', seats: { 硬座: [0.09, 0.14], 硬卧: [0.16, 0.24] } }
};

/* 铁路绕行系数：铁路里程 ≈ 大地距离 × 系数（山区/枢纽绕行更高）。
 * 用已知样本反推：样本中位 ≈1.22，取 1.15–1.35 为常见带 */
const DETOUR = { low: 1.15, mid: 1.22, high: 1.35 };

/* 校准结论（14 样本，见 p0-rail-calibration.mjs）：命中率 10/14、|偏差|中位 14%。
 * 已知误差模式（如实声明，暂不过度调参防过拟合）：
 * ① 南疆等无空调普速绿皮费率远低于带（阿克苏-喀什 -42%）；
 * ② 山区新线（中老铁路昆明-西双版纳）绕行系数 >1.35 且费率上浮（+44%）；
 * ③ 个别库存样本疑似折扣价（虹桥-贵阳北 -32%）；
 * ④ 速度分档在 90km/h 边界会误档（兰州-喀什普速被判动车）。
 * 精确化路径（P2 Sprint 2.2 正式版）：接铁路里程表 + 分线基价表 + 席别元数据。 */

/* 按运行速度分档（km/h，含停站摊薄） */
function speedClass(durationMin, km) {
  if (!durationMin || !km) return null;
  const v = km / (durationMin / 60);
  if (v >= 140) return 'highspeed';
  if (v >= 90) return 'bullet';
  if (v >= 45) return 'express';
  return 'slow';
}

/**
 * 铁路票价估算（区间）。
 * @param {object} o { fromCity, toCity, durationMin?, seat?, classOverride? }
 *   durationMin 提供时按实际速度分档；不提供时输出普速+动车双档区间（保守）。
 *   seat 指定席别（硬座/硬卧/软卧/二等座/一等座）；缺省取该档最低席别（背包客视角）。
 * @returns {{low,mid,high,speedClass,seat,assumptions:string[]}|null}
 */
export function railFare(o) {
  const geo = loadGeo().byName;
  const ga = geo.get(o.fromCity), gb = geo.get(o.toCity);
  if (!ga || !gb) return null;
  const km = haversineKm(ga.lat, ga.lng, gb.lat, gb.lng);
  const assumptions = [`里程估计 ${Math.round(km * DETOUR.mid)}km（大地 ${Math.round(km)}km × 绕行 1.15–1.35）`];

  let cls = o.classOverride || speedClass(o.durationMin, km);
  if (!o.durationMin) {
    assumptions.push('未提供时长：同时给出高铁二等与普速硬卧两档区间');
    const hs = RATES.highspeed.seats.二等座, ex = RATES.express.seats.硬卧;
    const calc = (rate, det) => {
      const d = km * det;
      return [Math.round(d * rate[0]), Math.round(d * rate[1])];
    };
    const [hsLow, hsHigh] = calc(hs, DETOUR.low);
    const [exLow, exHigh] = calc(ex, DETOUR.low);
    return {
      low: Math.min(exLow, hsLow), high: Math.max(exHigh, hsHigh),
      mid: Math.round((Math.min(exLow, hsLow) + Math.max(exHigh, hsHigh)) / 2),
      speedClass: 'unknown', seat: '二等座/硬卧', assumptions
    };
  }
  cls = cls || 'express';
  const rates = RATES[cls];
  const seat = o.seat || Object.keys(rates.seats)[cls === 'highspeed' || cls === 'bullet' ? 0 : 1] || Object.keys(rates.seats)[0];
  const rate = rates.seats[seat];
  if (!rate) return null;
  const dLow = km * DETOUR.low, dHigh = km * DETOUR.high;
  const low = Math.round(dLow * rate[0] / 5) * 5;
  const high = Math.round(dHigh * rate[1] / 5) * 5;
  assumptions.push(`分档 ${rates.label}（按运行速度），席别 ${seat}，费率 ¥${rate[0]}–${rate[1]}/km`);
  return { low, high, mid: Math.round((low + high) / 2), speedClass: cls, seat, assumptions };
}
