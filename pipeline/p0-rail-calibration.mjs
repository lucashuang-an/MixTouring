/* p0-rail-calibration.mjs · rail-fare.mjs 校准报告（一次性研究工具）
 * 用 plans.json 已知真实铁路票价（14 条样本，含高铁/动车/普速全谱）
 * 验证估算区间命中率；偏差大的样本会显式列出（费率带调参依据）。
 * 运行：node pipeline/p0-rail-calibration.mjs */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { railFare } from './lib/rail-fare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = JSON.parse(readFileSync(join(root, 'pipeline/data/plans.json'), 'utf8'));

/* 站名 → 城市名（geo 库按城市索引；站名取前两字退化匹配，特殊站手工映射） */
const stationCity = {
  北京西: '北京', 北京大兴: '北京', 上海虹桥: '上海', 上海南: '上海',
  兰州西: '兰州', 贵阳北: '贵阳', 昆明南: '昆明', 杭州东: '杭州',
  西安北: '西安', 乌鲁木齐: '乌鲁木齐', 成都西: '成都', 成都南: '成都',
  美兰机场站: '海口', 三亚站: '三亚', 昆明站: '昆明', 昆明南站: '昆明',
  西双版纳站: '西双版纳', 银川: '银川', 喀什: '喀什', 兰州: '兰州', 西安: '西安',
  阿克苏: '阿克苏', 南京: '南京', 贵阳: '贵阳', 杭州东: '杭州', 三亚: '三亚'
};

const samples = [];
const seen = new Set();
for (const p of store.plans) {
  for (const g of p.segs || []) {
    if (g.mode !== 'train') continue;
    const key = g.train_no + '|' + g.from_station + '|' + g.to_station;
    if (seen.has(key)) continue;
    seen.add(key);
    const real = g.fixed_price ?? (g.price_band ? (g.price_band.min + g.price_band.max) / 2 : null);
    const fromCity = stationCity[g.from_station] || (g.from_station || '').slice(0, 2);
    const toCity = stationCity[g.to_station] || (g.to_station || '').slice(0, 2);
    const est = railFare({ fromCity, toCity, durationMin: g.duration_min });
    if (!est || !real) continue;
    const hit = real >= est.low && real <= est.high;
    const err = Math.round(((real - est.mid) / est.mid) * 100);
    samples.push({ seg: `${g.from_station}→${g.to_station}`, real, est_low: est.low, est_high: est.high, hit, errPct: err, cls: est.speedClass });
  }
}

console.log('区段'.padEnd(24), '真实价'.padStart(5), '估低'.padStart(6), '估高'.padStart(6), '命中', '偏差');
for (const s of samples) {
  console.log(s.seg.padEnd(24), String(s.real).padStart(5), String(s.est_low).padStart(6), String(s.est_high).padStart(6), s.hit ? '✓' : '✗', (s.errPct > 0 ? '+' : '') + s.errPct + '%', s.cls);
}
const hit = samples.filter((s) => s.hit).length;
const errs = samples.map((s) => Math.abs(s.errPct)).sort((a, b) => a - b);
console.log(`\n命中率：${hit}/${samples.length}；|偏差|中位 ${errs[Math.floor(errs.length / 2)]}%（相对区间中值）`);
