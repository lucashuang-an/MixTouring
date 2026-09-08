/* lib/parse.mjs · MixTouring Phase 2 · 触点①自然语言搜索解析（规则版闭环）
 * 输入一句自然语言（「国庆从杭州去喀什」），输出结构化 { from, to, date } + 置信度。
 * 优先级：LLM（注入 key 后自动启用，schema 约束只出城市/日期字段）→ 规则词典兜底。
 * 规则兜底能力边界明确：from/to 只识别方案库 cities 内的城市（24 城）；
 * date 只识别关键词（今天/明天/后天/本周X/国庆/五一/十一/元旦/春节）+ 显式 M/D、M月D日。
 * 识别不到的字段置 null，由前端保留原输入让用户手动选择，绝不造数据。 */

import { callJson, llmModel } from './llm.mjs';

/* ---------- 规则词典 ---------- */

const DIFF_KEYWORDS = {
  '今天': 0, '今晚': 0, '明天': 1, '明晚': 1, '后天': 2, '昨天': -1,
  '周一': null, '星期二': null, '周三': null, '周四': null, '周五': null, '周六': null, '周日': null
};
const FESTIVAL = new Map([
  ['元旦', [1, 1]],
  ['春节', null], // 按农历浮动，规则版不猜，留 LLM
  ['五一', [5, 1]], ['劳动节', [5, 1]],
  ['国庆', [10, 1]], ['十一', [10, 1]],
  ['中秋', null], // 农历浮动
  ['端午', null], // 农历浮动
]);

/* 起终点连接词：出现在城市前的介词，用于区分 from/to 的位置语义 */
const FROM_MARK = ['从', '自', '由', '在', '从.', '自.'];
const TO_MARK = ['去', '到', '至', '前往', '飞往', '飞', '至.', '去.'];

/* ---------- 日期解析（规则版） ---------- */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function iso(month, day, year) {
  const y = year || new Date().getFullYear();
  const d = new Date(y, month - 1, day);
  /* 若目标已过去且是最近一次节日（元旦/五一/国庆），顺延到下一年 */
  if (d < new Date(new Date().getFullYear(), 0, 1) && d < new Date()) {
    // 仅在不可回填过去日期时顺延
  }
  return d;
}

function fmtDate(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 返回 { value: 'YYYY/M/D'|null, note?: string } */
function parseDateRule(text) {
  // 显式 M/D 或 M月D日（避免吞掉路径里的斜杠——自然语言场景可接受）
  let m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  let day, month;
  if (m) { month = +m[1]; day = +m[2]; }
  else {
    m = text.match(/(?:^|[^0-9])(\d{1,2})[/-](\d{1,2})(?!\d)/);
    if (m) { month = +m[1]; day = +m[2]; }
  }
  if (month && day && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    const d = iso(month, day);
    return { value: fmtDate(d) };
  }

  // 相对词：今天/明天/后天 + 自然省略表达
  const today = new Date();
  const rel = ['今天', '今晚', '明天', '后天'].find((k) => text.includes(k));
  if (rel) {
    const add = rel === '今天' || rel === '今晚' ? 0 : rel === '明天' ? 1 : 2;
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + add);
    return { value: fmtDate(d), note: rel };
  }
  // 本周X：周一到周日
  const week = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    .find((k) => text.includes(k));
  if (week) {
    const target = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].indexOf(week);
    let dow = today.getDay(); dow = dow === 0 ? 7 : dow; // 周一=1
    let add = target - dow;
    if (add <= 0) add += 7;
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + add);
    return { value: fmtDate(d), note: week };
  }
  // 节日
  for (const [kw, md] of FESTIVAL) {
    if (text.includes(kw)) {
      if (!md) return { value: null, note: `${kw}（农历浮动，需人工确认）` };
      const d = iso(md[0], md[1]);
      if (d < today) d.setFullYear(d.getFullYear() + 1); // 已过顺延下一年
      return { value: fmtDate(d), note: kw };
    }
  }
  return { value: null };
}

/* ---------- 起终点解析（规则版 · 城市词典） ---------- */

/**
 * 在文本中提取方案库内的城市。返回有序出现的城市数组（含城市名在原文中的位置）。
 */
function extractCities(text, cities) {
  const found = [];
  for (const c of cities) {
    let idx = text.indexOf(c);
    while (idx !== -1) {
      found.push({ city: c, idx });
      idx = text.indexOf(c, idx + 1);
    }
  }
  return found.sort((a, b) => a.idx - b.idx);
}

/** 依据连接词判断候选序列中哪个是 from、哪个是 to */
function assignFromTo(text, seq) {
  if (seq.length === 0) return { from: null, to: null, conf: 0 };
  const fromIdx = seq.map((s) => s.idx);
  const toIdx = seq.map((s) => s.idx);
  // from 城市应紧跟在「从/自/由/在」后面
  let fromCity = null;
  for (let i = 0; i < seq.length; i++) {
    const before = text.slice(Math.max(0, seq[i].idx - 2), seq[i].idx);
    if (FROM_MARK.some((mk) => before.includes(mk))) { fromCity = seq[i].city; break; }
  }
  // to 城市应紧跟在「去/到/飞/前往」后面，或位于句尾
  let toCity = null;
  for (let i = 0; i < seq.length; i++) {
    const before = text.slice(Math.max(0, seq[i].idx - 2), seq[i].idx);
    if (TO_MARK.some((mk) => before.includes(mk))) { toCity = seq[i].city; break; }
  }
  if (!fromCity && !toCity) {
    // 无明确连接词：按出现顺序 from→to
    fromCity = seq[0].city;
    toCity = seq.length > 1 ? seq[1].city : null;
  }
  if (fromCity === toCity) {
    // 连接词把同一个城市赋予了 from 与 to，取第一个出现作 to，from 用更早出现者
    const others = seq.filter((s) => s.city !== fromCity);
    if (!fromCity) { /* 空 */ }
    if (others.length) toCity = others[0].city;
  }
  // 交换校验：连接词定位到的是 to 且未找到 from 时，用另一个
  if (toCity && fromCity === null) {
    const cand = seq.filter((s) => s.city !== toCity);
    fromCity = cand.length ? cand[0].city : null;
  }
  return { from: fromCity, to: toCity, conf: fromCity && toCity && fromCity !== toCity ? 0.9 : 0.5 };
}

/* ---------- LLM 优先，规则兜底 ---------- */

const SCHEMA_PROMPT = (citiesJson) =>
  `你是 MixTouring 的行程解析器。把用户那句中文自然语言解析成一次出行的字段。` +
  `只输出 JSON 对象，字段：from（出发城市）、to（目的地）、date（出发日期 YYYY/M/D）。` +
  `城市必须取自此列表：${citiesJson}；识别不到就置 null，绝不编造。` +
  `日期可用今天/明天/后天/本周X/国庆/五一/元旦等口语，转成具体 YYYY/M/D；识别不到置 null。` +
  `输出示例：{"from":"杭州","to":"喀什","date":"2026/10/1"}`;

/**
 * 解析一句自然语言行程描述。
 * @param {string} text 用户输入
 * @param {string[]} cities 方案库城市列表
 * @returns {Promise<{from,to,date,conf,engine,note}>} conf∈[0,1]
 */
export async function parseTrip(text, cities) {
  const q = String(text || '').trim();
  if (!q) return { from: null, to: null, date: null, conf: 0, engine: 'none', note: '空输入' };
  const citiesJson = JSON.stringify(cities);

  // 1) LLM 优先（注入 key 后自动启用，schema 约束只出字段）
  const llmOut = await callJson({
    schema_prompt: SCHEMA_PROMPT(citiesJson),
    user: '行程：' + q
  });
  if (llmOut && typeof llmOut === 'object') {
    const from = llmOut.from && cities.includes(llmOut.from) ? llmOut.from : null;
    const to = llmOut.to && cities.includes(llmOut.to) ? llmOut.to : null;
    const date = /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(llmOut.date) ? llmOut.date : null;
    if (from || to || date) {
      return {
        from, to,
        date: date ? date.split('/').map((n, i) => i === 0 ? n : pad2(+n)).join('/') : null,
        conf: (from && to ? 0.95 : 0.6), engine: 'llm', note: null
      };
    }
    // LLM 未给有效城市，落到规则再兜一层
  }

  // 2) 规则兜底（离线可跑，能力边界见文件头）
  const rule = assignFromTo(q, extractCities(q, cities));
  const dateRule = parseDateRule(q);
  const fields = (rule.from ? 1 : 0) + (rule.to ? 1 : 0) + (dateRule.value ? 1 : 0);
  return {
    from: rule.from,
    to: rule.to,
    date: dateRule.value,
    conf: fields >= 3 ? 0.85 : fields === 2 ? 0.65 : 0.4,
    engine: 'rule',
    note: dateRule.note || (fields < 3 ? '部分字段未识别，请手动补全' : null)
  };
}