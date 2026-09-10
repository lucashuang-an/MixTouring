/* lib/qa.mjs · MixTouring Phase 2 · 触点③站内问答（grounded QA，基于库内方案）
 * 优先级：LLM（context 注入库内事实 + 数字锚定校验）→ 规则模板兜底（离线可跑，注入 key 前的默认路径）。
 * 硬约束（AGENTS §4.2 / §6.2）：答案中的一切数字必须逐字来自方案库数据；库里没有的如实说没有，
 * 绝不编造路线/价格/车次；LLM 输出过不了数字锚定校验就落回规则版，未锚定内容不上页。 */

import { callJson } from './llm.mjs';
import { loadGeo } from '../../pipeline/lib/geo-skill.mjs';

/* ---------- 检索：问题涉及哪些路线对 ---------- */

function mentionedCities(q, cities) {
  return cities.filter((c) => q.includes(c));
}

/* 未收录目的地/出发地探测：词典（方案库城市）外的城市名——
 * 取「去/到/飞 + 短语」「从/自/由 + 短语」，短语含地理库城市（179 城）但不被选中路线覆盖
 * → 视为无数据城市（如「北京去西双版纳」的西双版纳），答案必须显式声明 */
function unmatchedGeoCities(q, routes) {
  const covered = new Set(routes.flatMap(({ routeId }) => routeId.split('-')));
  const names = [...loadGeo().byName.keys()].sort((a, b) => b.length - a.length); /* 长名优先，防子串误配 */
  const missed = [];
  const push = (phrase) => {
    const hit = names.find((n) => phrase.includes(n));
    if (hit && !covered.has(hit) && !missed.includes(hit)) missed.push(hit);
  };
  const toRe = /(?:去|到|飞往|飞|前往)\s*([^，。？?！\s]{2,10})/g;
  const fromRe = /(?:从|自|由)\s*([^，。？?！\s去到飞]{2,10})/g;
  let m;
  while ((m = toRe.exec(q)) !== null) push(m[1]);
  while ((m = fromRe.exec(q)) !== null) push(m[1]);
  return missed;
}

/* 心愿衔接建议（Phase 3×QA）：问答缺数据时，若能识别出明确的出发地+目的地双城
 *（词典或地理库），返回 {from,to} 供上层登记心愿并触发采集；已有路线/单城/不相关返回 null */
export function suggestWish(q, db) {
  const hits = [];
  for (const c of db.cities) {
    const i = q.indexOf(c);
    if (i !== -1) hits.push({ city: c, idx: i });
  }
  for (const name of loadGeo().byName.keys()) {
    if (db.cities.includes(name)) continue;
    const i = q.indexOf(name);
    if (i !== -1) hits.push({ city: name, idx: i });
  }
  if (hits.length < 2) return null;
  hits.sort((a, b) => a.idx - b.idx);
  const from = hits[0].city;
  const to = hits[hits.length - 1].city;
  if (from === to) return null;
  if (db.routes[from + '-' + to]) return null; /* 已有数据，无需生成 */
  return { from, to };
}

/* 两端都提到的路线对优先；只提到一端则给涉及该城市的路线。最多 2 条，控 context 体积。
 * 同时返回 missed：问题中提到（含词典外地理城市）、但选中路线没有覆盖到的城市（答案必须显式声明无数据） */
export function pickRoutes(q, db) {
  const hits = mentionedCities(q, db.cities);
  const both = [];
  const single = [];
  for (const key in db.routes) {
    const [from, to] = key.split('-');
    if (hits.includes(from) && hits.includes(to)) both.push({ routeId: key, route: db.routes[key] });
    else if (hits.includes(from) || hits.includes(to)) single.push({ routeId: key, route: db.routes[key] });
  }
  const picked = (both.length ? both : single).slice(0, 2);
  const covered = new Set(picked.flatMap(({ routeId }) => routeId.split('-')));
  const missed = hits.filter((c) => !covered.has(c));
  return { picked, missed };
}

/* ---------- context 构建（全部字段来自服务层派生结果，本身就是 grounding 源） ---------- */

function planBrief(p) {
  return {
    id: p.id,
    modes: p.modes,
    total_time: p.totalTime,
    price: p.price,
    saved: p.saved,
    transfers: (p.stops || []).slice(1, -1).map((s) => s.name),
    summary: (p.ai && p.ai.status === 'verified' && p.ai.summary) || null
  };
}

function buildContext(routes) {
  return routes.map(({ routeId, route }) => ({
    route_id: routeId,
    direct_price: route.direct ? route.direct.price : null,
    plans: route.plans.map(planBrief)
  }));
}

/* ---------- 规则版答案（离线兜底；数字全部来自派生字段，模板拼接不造数） ---------- */

function ruleAnswer(routes, db, missed) {
  if (!routes.length) {
    const covered = Object.keys(db.routes).map((k) => k.replace('-', '→')).join(' / ');
    const missedNote = missed.length ? '其中' + missed.join('、') + '暂无数据。' : '';
    return {
      answer: '我只基于方案库里已有的路线数据回答，这句话里没认出已覆盖的路线。' + missedNote + '目前库里有：' + covered +
        '。可以问「北京去喀什哪个方案最省」，或者去搜索页登记心愿，AI 会离线探索这条线。',
      refs: []
    };
  }
  const prefix = missed.length
    ? '先说明：' + missed.join('、') + '暂无方案库数据，下面只是同出发地/同目的地的参考路线，不是到' + missed.join('、') + '的方案。\n'
    : '';
  const parts = [];
  const refs = [];
  routes.forEach(({ routeId, route }) => {
    const [from, to] = routeId.split('-');
    const sorted = route.plans.slice().sort((a, b) => (a.priceMid || 0) - (b.priceMid || 0));
    const direct = route.direct ? '直飞基准 ' + route.direct.price : '暂无直飞基准';
    parts.push(
      from + '→' + to + '（' + direct + '）共有 ' + route.plans.length + ' 个组合方案，按总价从低到高：' +
      sorted.map((p) => p.id + ' 总价 ' + p.price + ' · ' + p.totalTime + ' · ' + p.saved).join('；') + '。'
    );
    refs.push(...sorted.map((p) => p.id));
  });
  return { answer: prefix + parts.join('\n'), refs };
}

/* ---------- LLM 路径（注入 key 后自动启用） ---------- */

const QA_SCHEMA = (ctxJson, missedNote) =>
  '你是 MixTouring 的站内问答助手，只基于给定 context（方案库事实 JSON）回答用户关于省钱路线的问题。\n' +
  '铁律：\n' +
  '1. 回答中出现的任何数字必须逐字出现在 context 里，禁止心算、换算、编造新数字。\n' +
  '2. 车次/航班/价格/时刻一律以 context 为准；context 没有的信息如实说「方案库暂无该数据」。\n' +
  (missedNote
    ? '3. 特别约束：' + missedNote + '\n回答第一句必须先声明这一点，且不得把 context 中的参考路线说成到该城市的方案。\n'
    : '') +
  '4. 简体中文，不超过 160 字，语气像走过这条线的朋友，克制不夸张。\n' +
  '5. refs 给出答案引用到的方案 id 数组，必须取自 context 中的 plan.id；没有引用就给空数组。\n' +
  '输出 JSON：{"answer":"...","refs":["p-xxx"]}\n' +
  'context：' + ctxJson;

/* 数字锚定校验：答案里的每个数字串都必须在 context 原文中出现。
 * 两边统一去掉千分位逗号后比对（库内价格「¥1,753」与 LLM 输出「1753」视为同一数字） */
function normNum(s) { return String(s).replace(/,/g, ''); }

function numbersGrounded(answer, ctxJson) {
  const ctxNorm = normNum(ctxJson);
  return (answer.match(/[0-9][0-9,.]*/g) || []).every((n) => ctxNorm.includes(normNum(n)));
}

/**
 * 站内问答。
 * @param {string} q 用户问题
 * @param {{cities:string[],routes:object}} db 服务层 DB
 * @returns {Promise<{answer,refs,engine}>} engine: llm | rule | none
 */
export async function answerAsk(q, db) {
  const query = String(q || '').trim();
  if (!query) return { answer: '想问什么？比如「北京去喀什哪个方案最省」。', refs: [], engine: 'none' };
  const { picked: routes, missed: dictMissed } = pickRoutes(query, db);
  /* 词典 missed（已知城市未被覆盖）+ 地理库探测（词典外城市，如 西双版纳/绵阳/大理） */
  const missed = [...new Set([...dictMissed, ...unmatchedGeoCities(query, routes)])];
  const ctxJson = JSON.stringify(buildContext(routes));
  const missedNote = missed.length
    ? '用户问题提到的「' + missed.join('、') + '」在方案库中暂无任何数据，context 中的路线只是涉及其他城市的参考。'
    : '';

  const llmOut = await callJson({ schema_prompt: QA_SCHEMA(ctxJson, missedNote), user: '用户问题：' + query, kind: 'ask' });
  if (llmOut && typeof llmOut.answer === 'string' && llmOut.answer.trim()) {
    const answer = llmOut.answer.trim();
    const refs = Array.isArray(llmOut.refs) ? llmOut.refs.filter((id) => ctxJson.includes('"' + id + '"')) : [];
    /* grounding 校验：context 外数字、不存在引用、以及「该声明无数据却没声明」都整条丢弃落回规则版 */
    const missedDeclared = !missed.length || (missed.every((c) => answer.includes(c)) && /暂无|没有|无数据/.test(answer));
    if (numbersGrounded(answer, ctxJson) && (refs.length > 0 || routes.length === 0) && missedDeclared) {
      return { answer, refs, engine: 'llm' };
    }
  }
  const rule = ruleAnswer(routes, db, missed);
  return { answer: rule.answer, refs: rule.refs, engine: 'rule' };
}
