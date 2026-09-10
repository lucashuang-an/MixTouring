/* collect-wish.mjs · 心愿单采集执行器（Phase 3 收尾：队列的自动「生产工人」）
 * 流程：pending 心愿 → 地理候选注入 → LLM 联网检索采样真实班次/票价 → 三重守门写回 → 心愿回流 → build-mock。
 * 诚实边界：所有价格必须来自本次联网检索并带来源；检索能力不可用或产出过不了守门 → 心愿保持 pending，
 * 记录 attempts/lastError（≥3 次自动停止重试，转人工）。AI 文案默认 draft（人工 review 后改 verified）。
 * 用法：node pipeline/collect-wish.mjs [--wish <id>] [--all] [--limit N] [--dry]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getWishlist, saveWishlist } from './wishlist-store.mjs';
import { mergeGenerated } from './lib/merge-generated.mjs';
import { geoPromptBlock, loadGeo, haversineKm, candidatesBetween } from './lib/geo-skill.mjs';
import { callJson, llmConfigured, searchWeb } from '../server/lib/llm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'pipeline/data/plans.json');
const MAX_ATTEMPTS = 3;

const args = process.argv.slice(2);
const wishIdIdx = args.indexOf('--wish');
const dry = args.includes('--dry');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx > -1 ? Math.max(1, Number(args[limitIdx + 1]) || 1) : Infinity;

/* ---------- 两阶段采集 ----------
 * 实测教训：①模型自触发搜索不可靠（复杂 prompt 下常自报「无法联网检索」）；②时刻算术必错。
 * 改为：阶段①用专用 web_search API 按确定性查询词直接拿公开搜索摘要（不等模型自觉）；
 *       阶段②无检索，把搜索摘要组装成存储层结构（只准用摘要里的事实，算术由 normalizeGen 代码推导）。 */

const SEARCH_QUERIES = (w, candNames) => ([
  `${w.from} 到 ${w.to} 直飞航班 机票价格`,
  `${w.from} 到 ${w.to} 高铁 时长 票价`,
  ...candNames.slice(0, 2).flatMap((c) => [`${w.from} 到 ${c} 高铁 票价 时长`, `${c} 到 ${w.to} 航班 机票价格`])
]);

async function collectFacts(w, candNames) {
  const queries = SEARCH_QUERIES(w, candNames);
  const factParts = [];
  for (const qy of queries) {
    const results = await searchWeb(qy, { limit: 4 });
    if (results && results.length) factParts.push({ query: qy, results });
  }
  return factParts;
}

function buildStructurePrompt(w, factsJson) {
  return [
    `你是 MixTouring 的路线组装员。把下列「联网搜索摘要」组装成出行方案结构，输出一个 JSON 对象。`,
    geoPromptBlock(w.from, w.to),
    '方案结构：{"route_pair":{"route_id":"' + w.from + '-' + w.to + '","from":"' + w.from + '","to":"' + w.to + '","direct":{...}},"plans":[方案数组]}',
    'direct：{price:整数单程价, duration_min:整数分钟, source:"摘要中的平台/媒体名"}；摘要无可靠直飞价格则据实说明。',
    '方案字段：id、type:"plan"、route_id、from、to、stops、segs、risks（connection/baggage/refund/transfer 四因子）、play。',
    '规则：',
    '1. 一切价格/车次/航班号/时刻必须逐字来自搜索摘要的 title/content；摘要没给的时段就省略该方案，绝不推测。',
    '2. 中转城市必须取自地理候选；混搭优先；跨天则 arr_day 设 1。',
    '3. 不要输出 ai 字段；输出只含一个 JSON 对象。'
  ].join('\n');
}

/* ---------- LLM 产出的结构归一化（只做形状矫正与确定性派生，不造数据） ----------
 * 分工原则：LLM 只提供检索到的事实（车次/航班号、时刻、价格带、来源）；
 * duration_min/wait_min/day_offset/total 一切算术由代码从时刻推导——不让模型做数学题（实测必错）。 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function toMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function normalizeGen(gen, wish) {
  gen.route_pair = gen.route_pair || {};
  gen.route_pair.from = wish.from;
  gen.route_pair.to = wish.to;
  gen.route_pair.route_id = `${wish.from}-${wish.to}`;
  const direct = gen.route_pair.direct || {};

  /* 直飞采样合理性护栏（地理基准，先于锚点兜底）：价格须落在航线每公里典型区间（¥0.25–1.2/km）、
   * 时长须落在速度窗口（400–900km/h 等效）；不可信的采样直接弃用，避免幻觉直飞污染对比基准 */
  const geo = loadGeo().byName;
  const ga = geo.get(wish.from);
  const gb = geo.get(wish.to);
  if (Number(direct.price) > 0 && ga && gb) {
    const dist = haversineKm(ga.lat, ga.lng, gb.lat, gb.lng);
    const perKm = direct.price / dist;
    const durOk = direct.duration_min >= (dist / 900) * 60 && direct.duration_min <= (dist / 400) * 60;
    const priceOk = perKm >= 0.25 && perKm <= 1.2;
    if (!durOk || !priceOk) {
      console.log(`  ⚠ 直飞采样未过地理合理性校验（¥${direct.price}/${Math.round(dist)}km = ${perKm.toFixed(2)}¥/km，${direct.duration_min}min），弃用采样值`);
      direct.price = 0;
      direct.duration_min = 0;
    }
  }

  /* 直飞基准兜底：检索未采到可靠直飞（或已弃用）时，取最优方案价格带下限为参照锚点（source 如实注明） */
  const planMins = (Array.isArray(gen.plans) ? gen.plans : []).map((p) =>
    Math.min(...(p.segs || []).map((s) => (s.price_band ? Number(s.price_band.min) : Number(s.fixed_price))).filter((n) => Number.isFinite(n) && n > 0)));
  const anchorPrice = Number(direct.price) > 0 ? Number(direct.price) : (planMins.length ? Math.min(...planMins) : 0);
  const anchorDur = Number(direct.duration_min) > 0
    ? Number(direct.duration_min)
    : Math.min(...(Array.isArray(gen.plans) ? gen.plans : []).map((p) => (p.segs || []).reduce((sum, s) => sum + (Number(s.duration_min) || 0), 0)).filter((n) => n > 0));
  gen.route_pair.direct = {
    price: anchorPrice,
    duration_min: anchorDur,
    sampled_at: direct.sampled_at || new Date().toISOString(),
    source: Number(direct.price) > 0
      ? (direct.source || 'auto-collector 联网检索')
      : 'auto-collector：未采到可靠直飞基准，取最优方案区间下限为参照锚点（' + (direct.source || '') + '）'
  };
  /* 方案过滤：只保留「真的比基准便宜」的省钱方案（产品定位=省钱路线规划师）；全不省则如实不写卡 */
  if (Array.isArray(gen.plans) && gen.route_pair.direct.price > 0) {
    const anchor = gen.route_pair.direct.price;
    gen.plans = gen.plans.filter((p) => {
      const mids = (p.segs || []).map((s) => (s.price_band ? (Number(s.price_band.min) + Number(s.price_band.max)) / 2 : Number(s.fixed_price)));
      const mid = mids.every((n) => Number.isFinite(n)) ? mids.reduce((a, b) => a + b, 0) : Infinity;
      return mid < anchor;
    });
  }
  gen.plans = (Array.isArray(gen.plans) ? gen.plans : []).map((p, i) => {
    const segs = (Array.isArray(p.segs) ? p.segs : []).map((s) => {
      const depOk = HHMM.test(s.dep);
      const arrOk = HHMM.test(s.arr);
      const depDay = Number(s.dep_day) || 0;
      /* 跨天推导：到达时刻 ≤ 出发时刻 → 次日到达（所有地面/空中段单程均 < 24h） */
      const arrDay = depOk && arrOk ? (toMin(s.arr) <= toMin(s.dep) ? depDay + 1 : depDay) : (Number(s.arr_day) || 0);
      const duration = depOk && arrOk
        ? (arrDay * 1440 + toMin(s.arr)) - (depDay * 1440 + toMin(s.dep))
        : (Number(s.duration_min) || 0);
      return {
        mode: s.mode === 'train' ? 'train' : 'plane',
        flight_no: s.mode === 'plane' ? (s.flight_no || s.train_no || '') : undefined,
        train_no: s.mode === 'train' ? (s.train_no || s.flight_no || '') : undefined,
        from_station: s.from_station || '',
        to_station: s.to_station || '',
        dep: depOk ? s.dep : '',
        dep_day: depDay,
        arr: arrOk ? s.arr : '',
        arr_day: arrDay,
        duration_min: duration,
        fixed_price: s.fixed_price != null ? Number(s.fixed_price) : null,
        price_band: s.price_band && Number(s.price_band.min) > 0
          ? { min: Number(s.price_band.min), max: Number(s.price_band.max) || Number(s.price_band.min), sample_count: Number(s.price_band.sample_count) || 1, sampled_at: s.price_band.sampled_at || new Date().toISOString() }
          : null,
        source: s.source || 'auto-collector 联网检索'
      };
    });
    /* 中转 wait_min：前段到达 → 后段出发的间隔（分钟） */
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i].arr && segs[i + 1].dep) {
        segs[i + 1]._wait = (segs[i + 1].dep_day * 1440 + toMin(segs[i + 1].dep)) - (segs[i].arr_day * 1440 + toMin(segs[i].arr));
      }
    }
    const waits = segs.slice(1).map((s) => s._wait);
    const stops = [];
    if (segs[0]?.dep) stops.push({ city: wish.from, kind: 'origin', depart: segs[0].dep, day_offset: segs[0].dep_day });
    waits.forEach((w, i) => {
      const city = p.stops?.[i + 1]?.city || '';
      if (city) stops.push({ city, kind: 'transfer', wait_min: w });
    });
    if (segs[segs.length - 1]?.arr) stops.push({ city: wish.to, kind: 'dest', arrive: segs[segs.length - 1].arr, day_offset: segs[segs.length - 1].arr_day });

    /* risks：LLM 常返回对象而非数组 → 归一为数组；并从已知事实（中转城市/等待分钟）确定性回填缺口 */
    let risks = p.risks;
    if (risks && !Array.isArray(risks) && typeof risks === 'object') {
      risks = Object.entries(risks).map(([factor, v]) => ({ factor, ...(v && typeof v === 'object' ? v : { raw: v, narrative: [] }) }));
    }
    const transferCities = stops.filter((s) => s.kind === 'transfer').map((s) => s.city);
    const waitList = waits.filter((w) => Number.isFinite(w));
    risks = (Array.isArray(risks) ? risks : []).map((r) => ({
      factor: r.factor,
      raw: (r.raw && typeof r.raw === 'object' && !Array.isArray(r.raw)) ? r.raw : {},
      narrative: Array.isArray(r.narrative) ? r.narrative : []
    }));
    const byFactor = new Map(risks.map((r) => [r.factor, r]));
    if (transferCities.length) {
      const conn = byFactor.get('connection') || { factor: 'connection', raw: {}, narrative: [] };
      /* 城市/等待分钟以代码推导值为准（来自真实时刻差），LLM 只补充同站与否等定性字段 */
      conn.raw = {
        city: transferCities[0],
        wait_min: waitList[0] || 0,
        same_station: conn.raw?.same_station ?? false,
        transfer_min: Number(conn.raw?.transfer_min) || 45
      };
      byFactor.set('connection', conn);
      const tr = byFactor.get('transfer') || { factor: 'transfer', raw: {}, narrative: [] };
      tr.raw = {
        label: tr.raw.label || `${transferCities.join('、')}中转`,
        km: Number(tr.raw.km) || 0,
        min: Number(tr.raw.min) || 0,
        same_station: tr.raw.same_station ?? false,
        rail_direct: tr.raw.rail_direct ?? false
      };
      byFactor.set('transfer', tr);
    }
    if (!byFactor.has('baggage')) byFactor.set('baggage', { factor: 'baggage', raw: { modes: segs.map((s) => s.mode) }, narrative: [] });
    if (!byFactor.has('refund')) byFactor.set('refund', { factor: 'refund', raw: { plane_fare: 'discounted', ticket_tight: false }, narrative: [] });
    /* 已存在的 baggage/refund 也归一 raw 形状（LLM 常缺 modes 等字段） */
    const bag = byFactor.get('baggage');
    bag.raw = { modes: Array.isArray(bag.raw?.modes) && bag.raw.modes.length ? bag.raw.modes : segs.map((s) => s.mode) };
    const ref = byFactor.get('refund');
    ref.raw = { plane_fare: ref.raw?.plane_fare || 'discounted', ticket_tight: Boolean(ref.raw?.ticket_tight) };
    byFactor.set('baggage', bag);
    byFactor.set('refund', ref);
    const needConn = transferCities.length > 0;
    risks = [...byFactor.values()].filter((r) =>
      r.factor === 'baggage' || r.factor === 'refund' || (needConn && (r.factor === 'connection' || r.factor === 'transfer')));
    return {
      ...p,
      id: p.id || `p-auto-${Date.now() % 100000}-${i}`,
      type: 'plan',
      route_id: `${wish.from}-${wish.to}`,
      from: wish.from,
      to: wish.to,
      stops,
      segs: segs.map(({ _wait, ...s }) => s),
      risks: Array.isArray(risks) ? risks : [],
      play: p.play || null,
      ai: null /* AI 文案由独立环节生成（glm-4-flash 数字纪律不达标），采集与文案解耦 */
    };
  });
  return gen;
}

/* ---------- 单个心愿处理 ---------- */

async function collectOne(wish, store) {
  /* 已有数据的路线直接回流（可能是别的途径生成的） */
  if (store.route_pairs.some((rp) => rp.route_id === `${wish.from}-${wish.to}`)) {
    return { outcome: 'generated', note: '方案库已有此路线' };
  }
  if (!llmConfigured()) {
    return { outcome: 'failed', note: 'LLM_API_KEY 未配置，无法联网采样' };
  }

  console.log(`· 采集 ${wish.from} → ${wish.to}（web_search API 确定性检索 + ${process.env.LLM_MODEL_COLLECT || '默认'} 组装）…`);
  const collectModel = process.env.LLM_MODEL_COLLECT;
  /* 阶段①：确定性联网检索（专用 web_search API，不依赖模型触发） */
  const candNames = candidatesBetween(wish.from, wish.to).slice(0, 2).map((c) => c.name);
  const factParts = await collectFacts(wish, candNames);
  if (!factParts.length) {
    return { outcome: 'failed', note: '阶段①联网检索（web_search API）无结果或不可用' };
  }
  /* 阶段②：无检索，搜索摘要 → 存储层结构（算术字段由 normalizeGen 代码推导） */
  const raw = await callJson({
    schema_prompt: buildStructurePrompt(wish, JSON.stringify(factParts)),
    user: '联网搜索摘要 JSON：' + JSON.stringify(factParts),
    kind: 'collect',
    model: collectModel,
    timeoutMs: 120000
  });
  if (!raw || !raw.route_pair || !Array.isArray(raw.plans) || !raw.plans.length) {
    return { outcome: 'failed', note: '摘要不足以组装出含时刻的合格方案（LLM 未返回有效结构或如实放弃）' };
  }
  let gen;
  try {
    gen = normalizeGen(raw, wish);
  } catch (err) {
    return { outcome: 'failed', note: '结构归一化失败：' + err.message };
  }

  try {
    const fresh = JSON.parse(readFileSync(dataPath, 'utf8'));
    const result = mergeGenerated(fresh, gen, { verified: false });
    result.log.forEach((l) => console.log('  ✓ ' + l));
    if (!result.ok) {
      return { outcome: 'failed', note: '守门未过：' + result.errors[0] };
    }
    if (!dry) {
      writeFileSync(dataPath, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
      spawnSync('node', [join(root, 'pipeline/build-mock.mjs')], { stdio: 'inherit' });
    }
    return { outcome: 'generated', note: result.log.join('；') };
  } catch (err) {
    return { outcome: 'failed', note: '写回异常：' + err.message };
  }
}

/* ---------- 主流程 ---------- */

const wl = getWishlist();
/* pending 可处理；processing 超 10 分钟视为上次执行中断，重新纳入（自愈） */
const STALE_MS = 10 * 60 * 1000;
const pending = wl.items.filter((w) =>
  (w.status === 'pending' || (w.status === 'processing' && Date.now() - new Date(w.processingAt || 0).getTime() > STALE_MS)) &&
  (w.attempts || 0) < MAX_ATTEMPTS);
const targets = wishIdIdx > -1
  ? pending.filter((w) => w.id === args[wishIdIdx + 1])
  : pending.slice(0, limit === Infinity ? undefined : limit);

if (!targets.length) {
  console.log(pending.length
    ? `✓ ${pending.length} 个 pending 心愿均已达到重试上限（${MAX_ATTEMPTS}），转人工处理`
    : '✓ 暂无可处理的 pending 心愿');
  process.exit(0);
}

console.log(`▶ 采集执行器启动：${targets.length} 个心愿${dry ? '（dry 模式，不写盘）' : ''}`);
let ok = 0;
for (const w of targets) {
  /* 处理中状态先行落盘：前端「我的」页实时显示「生成中」（而非一直探索中） */
  const marking = getWishlist().items;
  const mk = marking.find((x) => x.id === w.id);
  if (mk && mk.status === 'pending') { mk.status = 'processing'; mk.processingAt = new Date().toISOString(); saveWishlist(marking); }
  let outcome, note;
  try {
    ({ outcome, note } = await collectOne(w, JSON.parse(readFileSync(dataPath, 'utf8'))));
  } catch (err) {
    outcome = 'failed';
    note = '执行器异常：' + err.message;
  }
  /* 重新读队列（collectOne 写盘后 build-mock 不动 wishlist，但保持一致性） */
  const items = getWishlist().items;
  const cur = items.find((x) => x.id === w.id);
  if (cur) {
    if (outcome === 'generated') {
      cur.status = 'generated';
      cur.generatedAt = new Date().toISOString();
      cur.collectedBy = 'auto-collector';
      delete cur.lastError;
      ok++;
    } else {
      cur.status = 'pending'; /* 失败退回 pending，等待下次重试 */
      cur.attempts = (cur.attempts || 0) + 1;
      cur.lastError = note;
      cur.lastAttemptAt = new Date().toISOString();
    }
    saveWishlist(items);
  }
  console.log(`${outcome === 'generated' ? '✓' : '✗'} ${w.from} → ${w.to}：${note}`);
}
console.log(`\n${ok ? '✓' : '○'} 完成：${ok}/${targets.length} 条心愿生成成功；失败者保留 pending（重试上限 ${MAX_ATTEMPTS} 次）`);
