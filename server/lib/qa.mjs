/* lib/qa.mjs · MixTouring Phase 2 · 触点③站内问答（grounded QA，基于库内方案）
 * 优先级：LLM（context 注入库内事实 + 数字锚定校验）→ 规则模板兜底（离线可跑，注入 key 前的默认路径）。
 * 硬约束（AGENTS §4.2 / §6.2）：答案中的一切数字必须逐字来自方案库数据；库里没有的如实说没有，
 * 绝不编造路线/价格/车次；LLM 输出过不了数字锚定校验就落回规则版，未锚定内容不上页。 */

import { callJson } from './llm.mjs';

/* ---------- 检索：问题涉及哪些路线对 ---------- */

function mentionedCities(q, cities) {
  return cities.filter((c) => q.includes(c));
}

/* 两端都提到的路线对优先；只提到一端则给涉及该城市的路线。最多 2 条，控 context 体积 */
export function pickRoutes(q, db) {
  const hits = mentionedCities(q, db.cities);
  const both = [];
  const single = [];
  for (const key in db.routes) {
    const [from, to] = key.split('-');
    if (hits.includes(from) && hits.includes(to)) both.push({ routeId: key, route: db.routes[key] });
    else if (hits.includes(from) || hits.includes(to)) single.push({ routeId: key, route: db.routes[key] });
  }
  return (both.length ? both : single).slice(0, 2);
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

function ruleAnswer(q, routes, db) {
  if (!routes.length) {
    const covered = Object.keys(db.routes).map((k) => k.replace('-', '→')).join(' / ');
    return {
      answer: '我只基于方案库里已有的路线数据回答，这句话里没认出已覆盖的路线。目前库里有：' + covered +
        '。可以问「北京去喀什哪个方案最省」，或者去搜索页登记心愿，AI 会离线探索这条线。',
      refs: []
    };
  }
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
  return { answer: parts.join('\n'), refs };
}

/* ---------- LLM 路径（注入 key 后自动启用） ---------- */

const QA_SCHEMA = (ctxJson) =>
  '你是 MixTouring 的站内问答助手，只基于给定 context（方案库事实 JSON）回答用户关于省钱路线的问题。\n' +
  '铁律：\n' +
  '1. 回答中出现的任何数字必须逐字出现在 context 里，禁止心算、换算、编造新数字。\n' +
  '2. 车次/航班/价格/时刻一律以 context 为准；context 没有的信息如实说「方案库暂无该数据」。\n' +
  '3. 简体中文，不超过 160 字，语气像走过这条线的朋友，克制不夸张。\n' +
  '4. refs 给出答案引用到的方案 id 数组，必须取自 context 中的 plan.id；没有引用就给空数组。\n' +
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
  const routes = pickRoutes(query, db);
  const ctxJson = JSON.stringify(buildContext(routes));

  const llmOut = await callJson({ schema_prompt: QA_SCHEMA(ctxJson), user: '用户问题：' + query });
  if (llmOut && typeof llmOut.answer === 'string' && llmOut.answer.trim()) {
    const answer = llmOut.answer.trim();
    const refs = Array.isArray(llmOut.refs) ? llmOut.refs.filter((id) => ctxJson.includes('"' + id + '"')) : [];
    /* grounding 不过关（出现 context 外的数字）或引用了不存在的方案 → 整条丢弃，落回规则版 */
    if (numbersGrounded(answer, ctxJson) && (refs.length > 0 || routes.length === 0)) {
      return { answer, refs, engine: 'llm' };
    }
  }
  const rule = ruleAnswer(query, routes, db);
  return { answer: rule.answer, refs: rule.refs, engine: 'rule' };
}
