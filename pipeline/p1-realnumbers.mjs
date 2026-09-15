/* p1-realnumbers.mjs · P1.3 补真实车次/航班号 + 时刻对齐公开时刻表（一次性补丁）
 * 依据（2026-09-13 核实，来源：12306/高铁网/维基/携程/飞常准/春秋官网，见各段 source）：
 *   D267  北京西 19:55 → 银川 07:00+1（动卧，二等 ¥312–363）
 *   GJ8559 银川河东 21:15 → 阿克苏 01:10+1（长龙，每日，携程 ¥1,100 起）
 *   T269  阿克苏 08:20 → 喀什 14:49（硬座 ¥69–90）
 *   Z55   北京西 14:52 → 兰州 07:43+1（硬卧 ~¥343）
 *   T269  兰州 06:03 → 喀什 13:18+1（31h35m）
 *   G321  北京西 07:00 → 西安北 11:20（二等 ¥515.5）
 *   9C6381 西安咸阳 13:50 → 喀什 18:25（春秋直飞，天巡低价 ¥661）
 *   T175  北京西 13:05 → 兰州 07:29+1（硬卧 ~¥353）
 *   D2717 兰州西 11:46 → 乌鲁木齐 22:47（二等 ¥551）
 *   GJ8667 银川河东 10:40 → 乌鲁木齐 14:05（长龙，¥450–660）
 * 待补（WebSearch 服务恢复后）：p-shkm-1/2 沪昆高铁与沪杭早班 G 车次。
 * 运行：node pipeline/p1-realnumbers.mjs（写回 plans.json 并重建 mock） */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'pipeline/data/plans.json');
const store = JSON.parse(readFileSync(dataPath, 'utf8'));
const NOW = '2026-09-13';

const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm); return Number(m[1]) * 60 + Number(m[2]); };

/* 新分段定义：mode/号/站/时刻/跨天/票价带/来源；transfer 为与下一段的接驳信息 */
const V = {
  D267: { mode: 'train', no: 'D267', from: '北京西', to: '银川', dep: '19:55', arr: '07:00', arrDay: 1, band: [312, 363], src: 'D267 动卧·高铁网/12306 2026-09-13 核实' },
  GJ8559: { mode: 'plane', no: 'GJ8559', from: '银川河东', to: '阿克苏', dep: '21:15', arr: '01:10', arrDay: 1, band: [1100, 1400], src: '长龙航空每日班·携程时刻 2026-09-13' },
  T269AKU: { mode: 'train', no: 'T269', from: '阿克苏', to: '喀什', dep: '08:20', arr: '14:49', arrDay: 0, band: [69, 90], src: '携程/高铁网 2026-09-13（硬座）' },
  Z55: { mode: 'train', no: 'Z55', from: '北京西', to: '兰州', dep: '14:52', arr: '07:43', arrDay: 1, band: [343, 360], src: 'Z55·维基/12306 2026-09-13（硬卧）' },
  T269LZH: { mode: 'train', no: 'T269', from: '兰州', to: '喀什', dep: '06:03', arr: '13:18', arrDay: 1, band: [380, 560], src: 'T269 兰州始发段·高铁网 2026-09-13（硬卧带）' },
  G321: { mode: 'train', no: 'G321', from: '北京西', to: '西安北', dep: '07:00', arr: '11:20', arrDay: 0, band: [515, 548], src: 'G321·12306/携程 2026-09-13（二等座）' },
  C96381: { mode: 'plane', no: '9C6381', from: '西安咸阳', to: '喀什', dep: '13:50', arr: '18:25', arrDay: 0, band: [661, 1200], src: '春秋直飞·春秋官网/天巡 2026-09-13' },
  T175: { mode: 'train', no: 'T175', from: '北京西', to: '兰州', dep: '13:05', arr: '07:29', arrDay: 1, band: [353, 370], src: 'T175·维基时刻 2026-09-13（硬卧）' },
  D2717: { mode: 'train', no: 'D2717', from: '兰州西', to: '乌鲁木齐', dep: '11:46', arr: '22:47', arrDay: 0, band: [551, 551], src: 'D2717·携程/新华字典列车表 2026-09-13（二等座）' },
  GJ8667: { mode: 'plane', no: 'GJ8667', from: '银川河东', to: '乌鲁木齐地窝堡', dep: '10:40', arr: '14:05', arrDay: 0, band: [450, 660], src: '长龙每日班·飞常准 2026-09-13' }
};

/* 每方案：分段序列 + 段间接驳（city/same_station/接驳分钟/标签） */
const PATCH = {
  'p-bjks-1': { segs: [V.D267, V.GJ8559, V.T269AKU], transfers: [
    { city: '银川', same_station: false, transfer_min: 40, label: '银川站 → 河东机场 40 分钟' },
    { city: '阿克苏', same_station: false, transfer_min: 30, label: '红旗坡机场 → 阿克苏站 30 分钟' } ] },
  'p-bjks-2': { segs: [V.Z55, V.T269LZH], transfers: [
    { city: '兰州', same_station: true, transfer_min: 0, label: '兰州站站内等待' } ] },
  'p-bjks-3': { segs: [V.G321, V.C96381], transfers: [
    { city: '西安', same_station: false, transfer_min: 60, label: '西安北站 → 咸阳机场 60 分钟' } ] },
  'p-bjwl-1': { segs: [V.T175, V.D2717], transfers: [
    { city: '兰州', same_station: false, transfer_min: 30, label: '兰州站 → 兰州西站 30 分钟' } ] },
  'p-bjwl-2': { segs: [V.D267, V.GJ8667], transfers: [
    { city: '银川', same_station: false, transfer_min: 40, label: '银川站 → 河东机场 40 分钟' } ] }
};

let changed = 0;
for (const [pid, patch] of Object.entries(PATCH)) {
  const p = store.plans.find((x) => x.id === pid);
  if (!p) throw new Error('找不到方案 ' + pid);

  /* 分段重写：号/时刻/票价带来自核实数据；_relDay 为相对跨天（0=当日到，1=次日到，>24h 长途车以此显式给出） */
  const segs = patch.segs.map((s) => {
    return {
      mode: s.mode,
      train_no: s.mode === 'train' ? s.no : undefined,
      flight_no: s.mode === 'plane' ? s.no : undefined,
      from_station: s.from,
      to_station: s.to,
      dep: s.dep, dep_day: 0, arr: s.arr, arr_day: 0, _relDay: s.arrDay,
      duration_min: 0,
      fixed_price: null,
      price_band: { min: s.band[0], max: s.band[1], sample_count: 1, sampled_at: NOW + 'T00:00:00+08:00' },
      source: s.src
    };
  });

  /* 跨天链式：后段出发日 = 前段到达日（若当日发车时刻 ≤ 前段到达时刻则再顺延一天）；到达日 = 出发日 + 相对跨天 */
  segs.forEach((s, i) => {
    if (i === 0) {
      s.dep_day = 0;
    } else {
      const prev = segs[i - 1];
      const prevArrAbs = prev.arr_day * 1440 + toMin(prev.arr);
      let d = prev.arr_day;
      if (d * 1440 + toMin(s.dep) <= prevArrAbs) d = prev.arr_day + 1;
      s.dep_day = d;
    }
    s.arr_day = s.dep_day + s._relDay;
    s.duration_min = (s.arr_day * 1440 + toMin(s.arr)) - (s.dep_day * 1440 + toMin(s.dep));
  });

  /* stops 重建：起终 + transfer（wait 为上一段到达 → 本段出发的真实间隔） */
  const waits = [];
  for (let i = 0; i < segs.length - 1; i++) {
    waits.push((segs[i + 1].dep_day * 1440 + toMin(segs[i + 1].dep)) - (segs[i].arr_day * 1440 + toMin(segs[i].arr)));
  }
  const stops = [{ city: p.from, kind: 'origin', depart: segs[0].dep, day_offset: 0 }];
  waits.forEach((w, i) => stops.push({ city: patch.transfers[i].city, kind: 'transfer', wait_min: w }));
  stops.push({ city: p.to, kind: 'dest', arrive: segs[segs.length - 1].arr, day_offset: segs[segs.length - 1].arr_day });

  p.segs = segs.map(({ _relDay, ...clean }) => clean);
  p.stops = stops;

  /* risks：connection/transfer 的 raw 按新间隔与接驳事实重写，其余因子保持 */
  const conn = p.risks.find((r) => r.factor === 'connection');
  const trf = p.risks.find((r) => r.factor === 'transfer');
  if (conn) {
    conn.raw = { city: patch.transfers[0].city, wait_min: waits[0], same_station: patch.transfers[0].same_station, transfer_min: patch.transfers[0].transfer_min };
    conn.narrative = (conn.narrative || []).filter((l) => !/[0-9]/.test(l.replace(/\{[^}]+\}/g, '')));
  }
  if (trf) {
    trf.raw = { label: patch.transfers[0].label, km: trf.raw?.km || 20, min: patch.transfers[0].transfer_min, same_station: patch.transfers[0].same_station, rail_direct: trf.raw?.rail_direct ?? false };
  }
  changed++;
  console.log(`✓ ${pid}：${p.from}→${p.to} 重写为 ${segs.map((s) => (s.train_no || s.flight_no)).join(' + ')}，总时长 ${Math.floor(((segs[segs.length - 1].arr_day * 1440 + toMin(segs[segs.length - 1].arr)) - toMin(segs[0].dep)) / 60)}h${((segs[segs.length - 1].arr_day * 1440 + toMin(segs[segs.length - 1].arr)) - toMin(segs[0].dep)) % 60}m`);
}

writeFileSync(dataPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
console.log(`\n✓ ${changed} 个方案已按真实时刻表重写，plans.json 落盘`);
execSync('node ' + join(root, 'pipeline/build-mock.mjs'), { stdio: 'inherit' });
