/* geo-skill.mjs · 地理候选技能（AGENTS §6.2 落码 v0.2.1 决策①：AI 对起终点之间地理上的中间城市 + 交通枢纽做第一轮选择，而非 LLM 自由提名）
 * 纯函数、零依赖。数据：pipeline/data/cities-geo.json（策展公开地理事实）。
 * 三角形路线直觉的代码化：绕行比 = Σ路段大圆距离 ÷ 直线大圆距离，≤ MAX_DETOUR_RATIO 为主流（如 北京→银川→喀什 ≈1.3），
 * 超出为非主流（如 北京→上海→喀什 ≈1.8，人的惯性不会这么绕）。 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const GEO_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cities-geo.json');

/** 主流绕行比上限：超过视为非主流中转（产品口径：不让用户在非主流方案里消耗决策注意力） */
export const MAX_DETOUR_RATIO = 1.6;
/** 前进方向窗口：中转城市在起→终直线上的无裁剪投影参数 t 必须落在 [0.02, 0.98]，
 * 即「顺路」——反向城市（t<0，如北京→喀什走廊里的上海）哪怕绕行比不超标也排除，这是三角形路线直觉的核心 */
export const CORRIDOR_T_MIN = 0.02;
export const CORRIDOR_T_MAX = 0.98;
/** 保守估算时速（km/h）：用于把绕行公里数折算成估算增加时长，展示时必须带「估算」标注 */
export const TRAIN_KMH = 120;
export const PLANE_KMH = 700;
/** 非主流方案每路线最多展示条数 */
export const NON_MAINSTREAM_CAP = 2;

let cache = null;
export function loadGeo() {
  if (!cache) {
    const data = JSON.parse(readFileSync(GEO_PATH, 'utf8'));
    cache = { meta: { version: data.version, source: data.source }, byName: new Map(data.cities.map((c) => [c.name, c])) };
  }
  return cache;
}

/* ---------- 基础几何 ---------- */

/** 两点大圆距离（km），haversine */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function km(a, b) {
  return haversineKm(a.lat, a.lng, b.lat, b.lng);
}

/** A→B 直线的等距矩形投影参数（无裁剪）：t=0 在起点、1 在终点，<0 反向、>1 越过终点 */
function alongT(c, a, b) {
  const lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.57;
  const bx = (b.lng - a.lng) * kx;
  const by = (b.lat - a.lat) * ky;
  const cx = (c.lng - a.lng) * kx;
  const cy = (c.lat - a.lat) * ky;
  const len2 = bx * bx + by * by;
  return len2 ? (cx * bx + cy * by) / len2 : 0;
}

/** 城市 C 到 A→B 线段的偏离距离（km）。等距矩形投影（国内尺度误差可忽略），投影参数 t 裁剪到 [0,1] */
export function deviationKm(c, a, b) {
  const lat0 = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.57;
  const bx = (b.lng - a.lng) * kx;
  const by = (b.lat - a.lat) * ky;
  const cx = (c.lng - a.lng) * kx;
  const cy = (c.lat - a.lat) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 ? Math.max(0, Math.min(1, (cx * bx + cy * by) / len2)) : 0;
  return Math.hypot(cx - t * bx, cy - t * by);
}

/* ---------- 候选计算 ---------- */

/** from→to 沿线候选中转城市（按绕行比升序）。mode: 'plane'|'train'|null（null 不过滤设施） */
export function candidatesBetween(from, to, { mode = null, maxDetourRatio = MAX_DETOUR_RATIO } = {}) {
  const { byName } = loadGeo();
  const a = byName.get(from);
  const b = byName.get(to);
  if (!a || !b) return [];
  const direct = km(a, b);
  if (!direct) return [];
  const out = [];
  for (const city of byName.values()) {
    if (city.name === from || city.name === to) continue;
    if (mode === 'plane' && !city.has_airport) continue;
    if (mode === 'train' && !city.has_rail) continue;
    const t = alongT(city, a, b);
    if (t < CORRIDOR_T_MIN || t > CORRIDOR_T_MAX) continue; /* 顺路窗口：排除反向/越端城市 */
    const ratio = (km(a, city) + km(city, b)) / direct;
    if (ratio > maxDetourRatio) continue;
    out.push({
      name: city.name,
      detourRatio: Math.round(ratio * 100) / 100,
      deviationKm: Math.round(deviationKm(city, a, b)),
      has_airport: city.has_airport,
      has_rail: city.has_rail
    });
  }
  return out.sort((x, y) => x.detourRatio - y.detourRatio);
}

/* ---------- 路线评估（服务层派生用） ---------- */

/**
 * 评估一条方案的地理主流性。transfers 为中转城市名数组（按途经顺序）；
 * segs 用于取各中转后续段交通方式（时长折算口径）。任一中转城市不在地理库时 verdict='unknown'（不参与主流性判定）。
 * 判定：任一中转偏离顺路窗口（反向/越端）或链路绕行比超阈值 → non_mainstream。
 * @returns {{verdict:'mainstream'|'non_mainstream'|'unknown', ratio:number|null, extraKm:number|null, estExtraHours:number|null, legs:Array, reasons:string[]}}
 */
export function assessRoute(from, to, transfers, segs = []) {
  const { byName } = loadGeo();
  const a = byName.get(from);
  const b = byName.get(to);
  const resolved = transfers.map((n) => byName.get(n));
  if (!a || !b || resolved.some((s) => !s)) {
    return { verdict: 'unknown', ratio: null, extraKm: null, estExtraHours: null, legs: [], reasons: [] };
  }
  const reasons = [];
  const stops = [a, ...resolved, b];
  /* 顺路窗口：任一中转在起→终直线上反向（t<min）或越过终点（t>max）→ 非主流（三角形路线直觉的核心排除项） */
  transfers.forEach((name, i) => {
    const t = alongT(resolved[i], a, b);
    if (t < CORRIDOR_T_MIN) reasons.push(`${name}位于起点反方向（偏离走廊）`);
    else if (t > CORRIDOR_T_MAX) reasons.push(`${name}已越过终点方向（顺路过头再折返）`);
  });
  const direct = km(a, b);
  let chain = 0;
  const legs = stops.slice(0, -1).map((s, i) => {
    const d = km(s, stops[i + 1]);
    chain += d;
    const mode = segs[i]?.mode || 'plane';
    return { from: s.name, to: stops[i + 1].name, km: Math.round(d), mode };
  });
  const ratio = chain / direct;
  const extraKm = Math.max(0, chain - direct);
  /* 时长估算：各段按其交通方式时速算链路时长，减「直线基准时长」（若链路含飞机则基准按直飞时速，
   * 纯铁路才按铁路时速——混合方案按慢速算基准会系统性低估绕行代价） */
  const chainHours = legs.reduce((sum, l) => sum + l.km / (l.mode === 'train' ? TRAIN_KMH : PLANE_KMH), 0);
  const baseSpeed = legs.some((l) => l.mode === 'plane') ? PLANE_KMH : TRAIN_KMH;
  const estExtraHours = Math.max(0, chainHours - direct / baseSpeed);
  if (ratio > MAX_DETOUR_RATIO) reasons.push(`链路绕行比 ${Math.round(ratio * 100) / 100} 超出主流范围（≤${MAX_DETOUR_RATIO}）`);
  const verdict = reasons.length ? 'non_mainstream' : 'mainstream';
  return {
    verdict,
    ratio: Math.round(ratio * 100) / 100,
    extraKm: Math.round(extraKm),
    estExtraHours: Math.round(estExtraHours * 10) / 10,
    legs,
    reasons
  };
}

/* ---------- Prompt 注入段（省 token：候选以确定性计算给出，LLM 只做选择与叙述） ---------- */

/** 生成用候选文本块（中文、紧凑）。综合榜 + 铁路榜合并：纯绕行比会把「铁路可达的远侧走廊城市」挤出列表。 */
export function geoPromptBlock(from, to, { maxDetourRatio = MAX_DETOUR_RATIO, limit = 8, railLimit = 4 } = {}) {
  const overall = candidatesBetween(from, to, { maxDetourRatio }).slice(0, limit);
  const rail = candidatesBetween(from, to, { mode: 'train', maxDetourRatio }).slice(0, railLimit);
  const seen = new Set(overall.map((c) => c.name));
  const merged = [...overall, ...rail.filter((c) => !seen.has(c.name))];
  if (!merged.length) {
    return `地理候选：方案库地理数据中没有 ${from}→${to} 沿线候选中转城市（顺路窗口内且绕行比 ≤${maxDetourRatio}），请优先考虑直达方案，或明确论证任何中转的必要性。`;
  }
  const lines = merged.map((c) => {
    const g = loadGeo().byName.get(c.name);
    const tags = [c.has_airport ? '机场' : null, c.has_rail ? (g?.highspeed ? '高铁' : '铁路') : null].filter(Boolean).join('+');
    return `${c.name}(绕行${c.detourRatio.toFixed(2)},${tags})`;
  });
  return `地理候选中转城市（按绕行比升序，绕行比 ≤${maxDetourRatio} 视为主流路线）：${lines.join('、')}。中转城市必须取自该列表；若确需超出，必须附明确地理论证并在方案中标注「非主流」。`;
}

/* ---------- 服务层增强（build-mock 与 server 共用，保证 mock 与 API 逐字节一致） ---------- */

/**
 * 对服务层 DB 做地理增强：每条 plan 派生 plan.geo（主流性 + 客观评估结论）；
 * 每条路线方案重排：主流在前保持原序，非主流垫底且最多 NON_MAINSTREAM_CAP 条。
 * 中转城市不在地理库时 verdict='unknown'，按主流位置对待（不误杀）。
 */
export function enrichWithGeo(db) {
  for (const routeId of Object.keys(db.routes)) {
    const route = db.routes[routeId];
    route.plans = route.plans.map((p) => {
      const transfers = (p.stops || []).slice(1, -1).map((s) => s.name);
      if (!transfers.length) return { ...p, geo: { verdict: 'mainstream', ratio: 1, extraKm: 0, estExtraHours: 0, conclusion: null } };
      const a = assessRoute(p.from, p.to, transfers, p.segs || []);
      const conclusion = a.verdict === 'non_mainstream'
        ? `${a.reasons.join('；')}，较直线多约 ${a.extraKm}km、估算多耗 ${a.estExtraHours}h`
        : null;
      return { ...p, geo: { verdict: a.verdict, ratio: a.ratio, extraKm: a.extraKm, estExtraHours: a.estExtraHours, conclusion } };
    });
    const main = route.plans.filter((p) => p.geo.verdict !== 'non_mainstream');
    const non = route.plans.filter((p) => p.geo.verdict === 'non_mainstream').slice(0, NON_MAINSTREAM_CAP);
    route.plans = [...main, ...non];
  }
  return db;
}
