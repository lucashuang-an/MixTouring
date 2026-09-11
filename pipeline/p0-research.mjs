/* p0-research.mjs · P0 前提验证研究脚本（开发计划 §2，一次性，不属产品链路）
 * 问题：在多数长线 OD 上，混搭组合是否真的比「真实可购的最低直飞价」有优势？
 * 方法：searchWeb 确定性查询词采样公开报价（淡季最低 + 国庆旺季两个口径），
 *       混搭腿用 geo-skill 候选中转城（火车腿 + 机票腿）；
 *       每个 数字都留 snippet 证据（p0-samples.json 供人工审计），
 *       采样值只做草案，G0 结论以人工在携程/天巡复核后的数字为准。
 * 运行：node --env-file-if-exists=server/.env pipeline/p0-research.mjs
 * 产出：pipeline/out/p0-validation.csv（30 条 OD 对比表草案）
 *       pipeline/out/p0-existing-recheck.csv（现有 15 方案按真实基准重算）
 *       pipeline/out/p0-samples.json（原始检索证据） */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGeo, haversineKm, candidatesBetween } from './lib/geo-skill.mjs';
import { searchWeb } from '../server/lib/llm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'pipeline/out');
const offline = process.argv.includes('--offline'); /* 只用缓存+WebSearch 基准，不打搜索 API */

/* WebSearch 人工级直飞基准（优先级高于 snippet 采样，见 out/p0-direct-web.json _meta） */
let webBench = {};
try { webBench = JSON.parse(readFileSync(join(outDir, 'p0-direct-web.json'), 'utf8')); } catch { }

/* ---------- 30 条候选长线：8 现有路线对 + 4 心愿队列 + 18 新选 ---------- */
const ODS = [
  // 现有路线对（顺手复核省额是否还成立）
  ['北京', '喀什'], ['北京', '乌鲁木齐'], ['上海', '昆明'], ['成都', '乌鲁木齐'],
  ['南京', '喀什'], ['杭州', '喀什'], ['成都', '三亚'], ['北京', '西双版纳'],
  // 心愿队列里评估过的线
  ['广州', '拉萨'], ['重庆', '厦门'], ['西安', '丽江'], ['杭州', '西双版纳'],
  // 新选：偏远长线为主，混入 2 条直飞强势对照组（北京-三亚 / 重庆-厦门 已在心愿组）
  ['北京', '拉萨'], ['上海', '拉萨'], ['广州', '喀什'], ['深圳', '乌鲁木齐'],
  ['北京', '丽江'], ['上海', '西双版纳'], ['成都', '哈尔滨'], ['杭州', '乌鲁木齐'],
  ['北京', '三亚'], ['上海', '哈尔滨'], ['广州', '西双版纳'], ['北京', '大理'],
  ['上海', '喀什'], ['西安', '喀什'], ['重庆', '拉萨'], ['广州', '乌鲁木齐'],
  ['深圳', '丽江'], ['广州', '哈尔滨']
];

const geo = loadGeo().byName;

/* ---------- 工具 ---------- */

/* 查询缓存：同 query 只打一次 API（断点续跑/调参重跑不重复消耗） */
const cachePath = join(outDir, 'p0-cache.json');
let cache = {};
try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
let cacheDirty = false;
function saveCache() { if (cacheDirty) { writeFileSync(cachePath, JSON.stringify(cache), 'utf8'); cacheDirty = false; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 429 指数退避：20s → 40s → 80s，三次失败返回空（脚本层记录证据缺口） */
async function q(query, evidence, tag) {
  if (cache[query]) {
    evidence.push({ tag, query, cached: true, results: cache[query] });
    return cache[query].map((r) => ({ text: (r.title || '') + ' ' + (r.content || ''), media: r.media || r.link || '' }));
  }
  if (offline) { evidence.push({ tag, query, results: [], skipped: 'offline' }); return []; }
  for (let attempt = 0; attempt < 3; attempt++) {
    const results = await searchWeb(query, { limit: 4 });
    if (results !== null) {
      cache[query] = results;
      cacheDirty = true;
      evidence.push({ tag, query, results });
      await sleep(700 + Math.random() * 500); /* 温和限速，防 429 */
      return results.map((r) => ({ text: (r.title || '') + ' ' + (r.content || ''), media: r.media || r.link || '' }));
    }
    await sleep(20000 * (attempt + 1)); /* searchWeb 失败（含 429）→ 退避重试 */
  }
  evidence.push({ tag, query, results: [], error: '三次重试失败(限流或网络)' });
  return [];
}

/* ---- 证据锚定抽价（第一轮审计教训：泛特价汇总/消费券/跟团游/他航线新闻都会污染 min） ----
 * 四道闸：① snippet 须同时含起终城市名（防「北京出发低至228」实为太原大连）；
 *         ② 券/跟团/套餐类文章整体剔除；③ 价格与终点城市名邻近 ≤60 字符（同句可信）；
 *         ④ 每公里合理带（航班 0.10–3.0，火车 0.05–0.8；<0.10 几乎必是券额/里程数）。
 * 0.10–0.18 ¥/km 的航班低价保留但标「极端低价待复核」（真实 1 折促销存在但稀少）。 */
const NOISE_RE = /消费券|领券|优惠券|红包|立减|满减|返现|日游|跟团|双飞|一卧|自由行|行程单|邮轮/;
function anchoredPrices(docs, from, to, km, mode) {
  const out = [];
  for (const d of docs) {
    if (!d.text.includes(from) || !d.text.includes(to)) continue;
    if (NOISE_RE.test(d.text)) continue;
    const toPos = [...d.text.matchAll(new RegExp(to, 'g'))].map((x) => x.index);
    const bands = mode === 'air' ? [0.10, 3.0] : [0.05, 0.8];
    const patterns = [/(?:¥|￥)\s*(\d{3,5})(?:\.\d+)?/g, /(\d{3,5})\s*元(?:起)?/g];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(d.text)) !== null) {
        const p = Number(m[1]);
        if (p < 100 || p > 9000) continue;
        const near = Math.min(...toPos.map((i) => Math.abs(i - m.index)));
        if (near > 60) continue;
        if (km) {
          const perKm = p / km;
          if (perKm < bands[0] || perKm > bands[1]) continue;
        }
        out.push({ price: p, media: String(d.media).slice(0, 40), extreme: mode === 'air' && km && p / km < 0.18 });
      }
      if (out.length) break; /* ¥ 前缀优先，抽到就不用「N元」退化式 */
    }
  }
  return out;
}
const pick = (hits) => {
  if (!hits.length) return null;
  const min = Math.min(...hits.map((h) => h.price));
  const hit = hits.find((h) => h.price === min);
  return { low: min, src: hit.media + (hit.extreme ? '【极端低价待复核】' : '') };
};

/* 并发受限执行 */
async function mapLimit(items, limit, fn) {
  const ret = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx).catch((e) => ({ error: e.message }));
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return ret;
}

/* ---------- 主流程 ---------- */

console.log(`▶ P0 前提验证采样：${ODS.length} 条 OD（直飞旺/淡 + 混搭腿，每数字留证据）`);
const evidence = [];

const rows = await mapLimit(ODS, 2, async ([from, to]) => {
  const ev = [];
  evidence.push({ od: `${from}-${to}`, queries: ev });
  const ga = geo.get(from), gb = geo.get(to);
  const kmOf = (a, b) => {
    const x = geo.get(a), y = geo.get(b);
    return x && y ? Math.round(haversineKm(x.lat, x.lng, y.lat, y.lng)) : null;
  };
  const km = kmOf(from, to);

  /* ① 直飞两个口径；都失守时补第三查（措辞换一种提高召回） */
  const [offDocs, peakDocs] = await Promise.all([
    q(`${from} 到 ${to} 机票 最低价 单程`, ev, 'direct_off'),
    q(`${from} 到 ${to} 国庆 机票价格`, ev, 'direct_peak')
  ]);
  let off = pick(anchoredPrices(offDocs, from, to, km, 'air'));
  let peak = pick(anchoredPrices(peakDocs, from, to, km, 'air'));
  if (!off && !peak) {
    const fb = await q(`${from} 飞往 ${to} 直飞机票 多少钱`, ev, 'direct_fb');
    off = pick(anchoredPrices(fb, from, to, km, 'air'));
  }
  const directLow0 = off?.low ?? null;
  const directPeak0 = peak?.low ?? null;
  /* WebSearch 人工级基准覆盖（口径与来源更可靠；snippet 只做兜底） */
  const web = webBench[`${from}-${to}`];
  let benchNote = '';
  let directLow = directLow0, directPeak = directPeak0, directSrc = (off?.src || peak?.src || '');
  if (web) {
    if (web.off != null) { directLow = web.off; directSrc = 'WebSearch·' + (web.off_source || '').slice(0, 60); }
    if (web.peak != null) directPeak = web.peak;
    benchNote = [web.off_source, web.peak_note].filter(Boolean).join('；').slice(0, 120);
  }

  /* ② 混搭：geo 候选中转（最多试 2 个），火车腿 + 机票腿（各按腿距做合理带） */
  const cands = candidatesBetween(from, to).slice(0, 2).map((c) => c.name);
  let hybrid = null;
  for (const c of cands) {
    const [railDocs, planeDocs] = await Promise.all([
      q(`${from} 到 ${c} 火车票 硬卧 二等座 票价`, ev, `rail_${c}`),
      q(`${c} 到 ${to} 机票 最低价`, ev, `plane_${c}`)
    ]);
    const rail = pick(anchoredPrices(railDocs, from, c, kmOf(from, c), 'rail'));
    const plane = pick(anchoredPrices(planeDocs, c, to, kmOf(c, to), 'air'));
    if (rail && plane) {
      hybrid = { city: c, rail: rail.low, plane: plane.low, total: rail.low + plane.low,
        src: rail.src + ' | ' + plane.src };
      break; /* 第一个两腿齐全的候选即用（候选已按绕行比排序） */
    }
  }

  /* ③ 判定草案：旺季口径优先（更稳），其次促销口径 */
  let verdict;
  if (directLow == null && directPeak == null) verdict = '未采到可靠直飞(待人工)';
  else if (!hybrid) verdict = '未拼出混搭(待人工)';
  else {
    const promoDelta = Math.min(...[directLow, directPeak].filter((n) => n != null)) - hybrid.total;
    const peakDelta = (directPeak ?? Infinity) - hybrid.total;
    verdict = peakDelta > 0 ? '旺季成立(草案)' : promoDelta > 0 ? '仅促销口径成立(草案)' : '不成立(草案)';
  }

  console.log(`· ${from}-${to}（${km}km）：直飞低 ¥${directLow ?? '—'} / 旺 ¥${directPeak ?? '—'}${hybrid ? ` · 混搭 ${hybrid.city} ¥${hybrid.total}` : ' · 混搭未拼出'} → ${verdict}`);
  saveCache(); /* 每个 OD 落一次缓存，崩溃可续跑 */
  return {
    od: `${from}-${to}`, km,
    direct_low: directLow, direct_peak: directPeak, direct_source: directSrc, benchmark_note: benchNote,
    transfer: hybrid ? hybrid.city : '', hybrid_rail: hybrid?.rail ?? '', hybrid_plane: hybrid?.plane ?? '',
    hybrid_low: hybrid?.total ?? '', hybrid_source: hybrid?.src ?? '',
    verdict, need_review: '是(人工携程/天巡复核)'
  };
});

/* ---------- 现有 15 方案按采样基准重算 ---------- */
const store = JSON.parse(readFileSync(join(root, 'pipeline/data/plans.json'), 'utf8'));
const recheck = [];
for (const rp of store.route_pairs) {
  const sampled = rows.find((r) => r.od === rp.route_id);
  if (!sampled || sampled.direct_low == null) {
    recheck.push({ route: rp.route_id, note: 'P0 未采到直飞基准，无法重算' });
    continue;
  }
  for (const pid of rp.plan_ids) {
    const p = store.plans.find((x) => x.id === pid);
    if (!p) continue;
    const segMins = (p.segs || []).map((g) => g.price_band ? Number(g.price_band.min) : Number(g.fixed_price) || 0);
    const segMids = (p.segs || []).map((g) => g.price_band ? (Number(g.price_band.min) + Number(g.price_band.max)) / 2 : Number(g.fixed_price) || 0);
    const low = Math.round(segMins.reduce((a, b) => a + b, 0));
    const mid = Math.round(segMids.reduce((a, b) => a + b, 0));
    /* 用方案最低可执行价对比（对「不成立」最保守：连下限都赢不了才算输） */
    const vsOff = sampled.direct_low - low;
    const vsPeak = (sampled.direct_peak ?? sampled.direct_low) - low;
    recheck.push({
      route: rp.route_id, plan: pid, plan_low: low, plan_mid: mid,
      sampled_direct_low: sampled.direct_low, sampled_direct_peak: sampled.direct_peak ?? '',
      delta_low_vs_off: Math.round(vsOff), delta_low_vs_peak: Math.round(vsPeak),
      still_holds: vsOff > 0 ? '淡季也成立' : vsPeak > 0 ? '仅旺季成立' : '不成立'
    });
  }
}

/* ---------- 写盘 ---------- */
saveCache();
const csvHead = Object.keys(rows[0]).join(',');
const csv = [csvHead, ...rows.map((r) => Object.values(r).map((v) => `"${String(v ?? '')}"`).join(','))].join('\n');
writeFileSync(join(outDir, 'p0-validation.csv'), '\ufeff' + csv + '\n', 'utf8');
const rcHead = Object.keys(recheck[0] || { route: '' }).join(',');
const rcCsv = [rcHead, ...recheck.map((r) => Object.values(r).map((v) => `"${String(v ?? '')}"`).join(','))].join('\n');
writeFileSync(join(outDir, 'p0-existing-recheck.csv'), '\ufeff' + rcCsv + '\n', 'utf8');
writeFileSync(join(outDir, 'p0-samples.json'), JSON.stringify(evidence, null, 1), 'utf8');

/* 统计 */
const stat = {};
rows.forEach((r) => { stat[r.verdict] = (stat[r.verdict] || 0) + 1; });
const comparable = rows.filter((r) => /旺季成立|仅促销口径成立|不成立/.test(r.verdict)).length;
const hold = rows.filter((r) => /旺季成立|仅促销口径成立/.test(r.verdict)).length;
console.log(`\n▶ 统计草案：可比 ${comparable} 条中「成立」${hold} 条（含仅促销口径）；未拼出混搭/未采到直飞 ${rows.length - comparable} 条待人工`);
console.log(JSON.stringify(stat, null, 1));
console.log('✓ 产出：pipeline/out/p0-validation.csv / p0-existing-recheck.csv / p0-samples.json（证据留痕）');
