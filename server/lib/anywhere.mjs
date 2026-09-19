/* lib/anywhere.mjs · G2.5 AI 任意地点规划（首卡，v0.30.0）
 * 评审给定边界（Issue #5 六轮复审流转决定）：
 *   PlaceResolver 扩展（城市/机场/车站/景点及别名）→ 约束化 Intent（预算/最长中转时长/夜间到达/换乘次数）
 *   → CandidateBuilder 生成直达/一次中转/混合交通三类 candidate_hypothesis → 逐段 searchWeb 取证
 *   → 无证据段保持探索态；不得提前进入 G3 的多玩一城/住宿/私人保存/社区。
 * 防幻觉契约：AI 输出只分 intent / candidate_hypothesis / explanation，绝不写入已验证事实；
 *   一切候选均为待验证假设，骨架不含未经取证的数字（用户自输的约束值除外）；
 *   中转城市可由 LLM 提名，但必须从已收录城市清单中选择（清单外一律丢弃，不造地名）。
 * 诚实边界：词典（places.json 名称+别名）与 LLM 辅助都识别不了的地点 → needs_confirmation（不猜）；
 *   web_search 不可用或调用失败 → 明确降级说明，全部段保持探索态。 */

import { callJson as callJsonDefault, searchWeb as searchWebDefault } from './llm.mjs';
import { assignFromTo } from './parse.mjs';
import { loadPlaces, resolveRoute, webSearchConfigured } from './trip-service.mjs';
import { candidatesBetween } from '../../pipeline/lib/geo-skill.mjs';

export const ANYWHERE_VERSION = 'v0.30.0';

/* ---------- PlaceResolver（词典精确名 + 别名；拉丁字母不区分大小写；返回浅拷贝防缓存污染） ---------- */

const LATIN_RE = /^[A-Za-z][A-Za-z'\- ]*$/;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 整串解析：输入即地点名或别名（两字段入口用）。命中返回 {…place, matched_via}，未命中 null。 */
export function resolvePlace(text) {
  const n = String(text || '').trim();
  if (!n) return null;
  for (const p of loadPlaces()) {
    if (p.name === n) return { ...p, matched_via: 'name' };
    for (const a of p.aliases || []) {
      if (a === n || (LATIN_RE.test(a) && a.toLowerCase() === n.toLowerCase())) {
        return { ...p, matched_via: 'alias:' + a };
      }
    }
  }
  return null;
}

let MENTION_INDEX = null;
function mentionIndex() {
  if (!MENTION_INDEX) {
    const tokens = [];
    for (const p of loadPlaces()) {
      tokens.push({ token: p.name, latin: LATIN_RE.test(p.name), place: p });
      for (const a of p.aliases || []) tokens.push({ token: a, latin: LATIN_RE.test(a), place: p });
    }
    tokens.sort((x, y) => y.token.length - x.token.length); /* 最长优先：北京南站 先于 北京 命中 */
    MENTION_INDEX = tokens;
  }
  return MENTION_INDEX;
}

/** 一句话扫描：返回按出现位置排序的地点提及 [{idx, token, place}]。
 * 最长优先 + 相邻即冲突：长词先占位，紧邻其前后的短词视为同一地点短语的一部分（「北京首都机场」
 * 由「首都机场」整段命中，「北京」不再单独成提及）；拉丁别名单词不区分大小写。 */
export function scanPlaceMentions(text) {
  const t = String(text || '');
  if (!t) return [];
  const spans = [];
  const taken = [];
  const conflicts = (i, len) => taken.some(([s, e]) => i <= e && i + len >= s);
  for (const { token, latin, place } of mentionIndex()) {
    if (latin) {
      const re = new RegExp(escapeRe(token), 'gi');
      let m;
      while ((m = re.exec(t)) !== null) {
        if (!conflicts(m.index, token.length)) {
          spans.push({ idx: m.index, token, place: { ...place, matched_via: 'alias:' + token } });
          taken.push([m.index, m.index + token.length]);
        }
      }
    } else {
      let i = t.indexOf(token);
      while (i !== -1) {
        if (!conflicts(i, token.length)) {
          spans.push({ idx: i, token, place: { ...place, matched_via: 'name' } });
          taken.push([i, i + token.length]);
        }
        i = t.indexOf(token, i + 1);
      }
    }
  }
  return spans.sort((a, b) => a.idx - b.idx);
}

/* ---------- 约束化 Intent（确定性规则提取；数字只来自用户输入） ---------- */

const NIGHT_AVOID_RE = [
  /(?:不|别|不想|拒绝|避免|不接受)[^。！？，,]{0,6}(?:半夜|凌晨|夜间|夜里|红眼)[^。！？，,]{0,4}(?:到|到达|抵达|落地|航班)/,
  /红眼(?:航班)?[^。！？，,]{0,4}(?:不|不想|拒绝)/
];
const NIGHT_ALLOW_RE = [
  /(?:可以|接受|能接受|无所谓|不介意|没关系)[^。！？，,]{0,6}(?:半夜|凌晨|夜间|夜里|红眼)/,
  /红眼(?:航班)?(?:也行|无所谓|可以|OK|ok)/
];

/** 从一句话提取四类约束（预算/最长中转时长/夜间到达/换乘次数）。确定性；识别不到的字段不出现。 */
export function extractConstraints(text) {
  const t = String(text || '');
  const c = {};
  let m;
  if ((m = t.match(/预算\s*(?:不超过|最多|约|大概|为)?\s*(\d{3,6})\s*(?:元|块|人民币|CNY)/i)) ||
      (m = t.match(/(\d{3,6})\s*(?:元|块)\s*(?:以内|之内|的?预算)/))) c.budget_max_cny = +m[1];
  if ((m = t.match(/(?:中转|转机)[^。！？，,]{0,10}?(?:不超过|最多|少于|短于)?\s*(\d{1,2}(?:\.\d)?)\s*个?小时/))) c.max_layover_hours = +m[1];
  if (NIGHT_AVOID_RE.some((re) => re.test(t))) c.night_arrival = 'avoid';
  else if (NIGHT_ALLOW_RE.some((re) => re.test(t))) c.night_arrival = 'allow';
  if ((m = t.match(/(?:换乘|转乘|中转|转机)[^。！？，,]{0,8}?(?:不超过|最多|少于)?\s*([0-2])\s*次/))) c.max_transfers = +m[1];
  else if (/不想换乘|不换乘|不转乘|拒绝换乘/.test(t)) c.max_transfers = 0;
  return c;
}

/** 约束 chips（展示文案；数字全部来自用户输入值，非编造）。 */
export function constraintChips(c) {
  const chips = [];
  if (!c) return chips;
  if (c.budget_max_cny != null) chips.push({ key: 'budget', label: '预算 ≤ ¥' + c.budget_max_cny });
  if (c.max_layover_hours != null) chips.push({ key: 'layover', label: '最长中转 ' + c.max_layover_hours + ' 小时' });
  if (c.night_arrival === 'avoid') chips.push({ key: 'night', label: '夜间到达：不接受' });
  else if (c.night_arrival === 'allow') chips.push({ key: 'night', label: '夜间到达：可接受' });
  if (c.max_transfers != null) chips.push({ key: 'transfers', label: '换乘 ≤ ' + c.max_transfers + ' 次' });
  return chips;
}

/** 显式传入的约束（UI 字段）白名单化：类型/范围不对的丢弃，不猜。 */
function sanitizeConstraints(raw) {
  const c = {};
  if (!raw || typeof raw !== 'object') return c;
  const b = Number(raw.budget_max_cny);
  if (Number.isFinite(b) && b >= 100 && b <= 1000000) c.budget_max_cny = Math.round(b);
  const l = Number(raw.max_layover_hours);
  if (Number.isFinite(l) && l > 0 && l <= 48) c.max_layover_hours = Math.round(l * 10) / 10;
  if (raw.night_arrival === 'avoid' || raw.night_arrival === 'allow') c.night_arrival = raw.night_arrival;
  const tr = Number(raw.max_transfers);
  if (Number.isInteger(tr) && tr >= 0 && tr <= 2) c.max_transfers = tr;
  return c;
}

/* ---------- CandidateBuilder：三类纯交通骨架（candidate_hypothesis，无未取证数字） ---------- */

function newLeg(seq, fromPlace, toPlace, modeGuess) {
  return {
    seq,
    from: fromPlace.name, from_kind: fromPlace.kind,
    to: toPlace.name, to_kind: toPlace.kind,
    via: null,
    mode_guess: modeGuess, /* 假设的交通方式（guess：待取证确认，非事实） */
    evidence_state: 'explore',
    sources: [],
    evidence_note: null,
    manual_check: modeGuess === 'rail' ? '到 12306 核对该段车次' : modeGuess === 'plane' ? '到航司官网/平台核对该段航班' : '到平台核对该段班期'
  };
}

function isDomesticPair(o, d) {
  return o.country === 'CN' && o.is_mainland === true && d.country === 'CN' && d.is_mainland === true;
}

/** 机场/车站/景点映射到 geo 库城市名（city 字段；无归属或非城市 → null） */
function geoCityName(place) {
  if (place.kind === 'city') return place.name;
  return place.city || null;
}

const HUB_SOURCE_LABEL = { 'rule:geo': '按地理顺路筛选（确定性估算，非班期事实）', 'llm': '由 AI 从已收录城市中提名（待验证假设）' };

export const KIND_LABEL = { direct: '直达', one_transfer: '一次中转', mixed: '混合交通' };

/**
 * 生成三类骨架。hub 来源两级：geo 顺路候选（两端城市都在 geo 库，确定性）→ LLM 提名（清单内）。
 * @param {object} llmHints {one_transfer_city, mixed_rail_city}（城市清单校验在本函数消费点执行，清单外丢弃）
 * @returns {{candidates, degradations, constraint_notes}}
 */
export function buildCandidateSkeletons(o, d, constraints, llmHints = {}) {
  const degradations = [];
  const constraint_notes = [];
  const intl = !isDomesticPair(o, d);
  const fromCity = geoCityName(o);
  const toCity = geoCityName(d);

  const placeByName = (n) => loadPlaces().find((p) => p.name === n && p.kind === 'city');
  /* LLM 提名的防幻觉守门在消费点：必须已在城市词典内且不等于端点，清单外一律丢弃（不造地名）。
   * geo 顺路候选来自 cities-geo（国内 179 城地理事实库），可能不在 31 城词典内：
   * 词典外的中转城市只作为骨架节点（name/kind），不虚构词典收录 */
  const citySet = new Set(loadPlaces().filter((p) => p.kind === 'city').map((p) => p.name));
  const llmHintCity = (n) => (n && citySet.has(n) && n !== o.name && n !== d.name) ? n : null;
  const hubNode = (n) => placeByName(n) || { name: n, kind: 'city' };
  const candidates = [];

  /* hub 解析：geo 优先，LLM 提名兜底 */
  let oneHub = null, oneHubSrc = null, mixedHub = null, mixedHubSrc = null;
  if (fromCity && toCity) {
    const airHubs = candidatesBetween(fromCity, toCity, { mode: 'plane' });
    if (airHubs.length) { oneHub = airHubs[0].name; oneHubSrc = 'rule:geo'; }
    const railHubs = candidatesBetween(fromCity, toCity, { mode: 'train' }).filter((h) => h.has_airport);
    if (railHubs.length) { mixedHub = railHubs[0].name; mixedHubSrc = 'rule:geo'; }
  }
  if (!oneHub && llmHints.one_transfer_city) { oneHub = llmHintCity(llmHints.one_transfer_city); oneHubSrc = 'llm'; }
  if (!mixedHub && llmHints.mixed_rail_city) { mixedHub = llmHintCity(llmHints.mixed_rail_city); mixedHubSrc = 'llm'; }

  /* ① 直达骨架（任何 OD 都出；换乘 0 次） */
  candidates.push({
    id: 'cand-direct',
    kind: 'direct',
    hypothesis: true,
    transfers: 0,
    builder: 'rule',
    legs: [newLeg(1, o, d, intl ? 'plane' : null)],
    explanation: intl
      ? '假设存在直达航班（国际 OD 通常仅航班直连）：班期与价格待逐段取证，未取证前不做任何比较'
      : '假设存在直达航班或直达列车：具体班期待逐段取证'
  });

  /* ② 一次中转骨架 */
  if (oneHub) {
    const hubPlace = hubNode(oneHub);
    candidates.push({
      id: 'cand-one-transfer',
      kind: 'one_transfer',
      hypothesis: true,
      transfers: 1,
      builder: oneHubSrc,
      legs: [newLeg(1, o, hubPlace, null), newLeg(2, hubPlace, d, 'plane')],
      explanation: '假设经「' + oneHub + '」一次中转：中转城市' + HUB_SOURCE_LABEL[oneHubSrc] + '，衔接余量与两段班期待逐段取证'
    });
  } else {
    degradations.push('一次中转骨架需要中转城市来源（地理顺路候选或 AI 提名），当前不可用：该骨架未生成');
  }

  /* ③ 混合交通骨架（铁路段 + 航空段；出发地须为中国大陆——铁路起段假设才成立） */
  const railEligible = o.country === 'CN' && o.is_mainland === true;
  if (mixedHub && railEligible) {
    const hubPlace = hubNode(mixedHub);
    candidates.push({
      id: 'cand-mixed',
      kind: 'mixed',
      hypothesis: true,
      transfers: 1,
      builder: mixedHubSrc,
      legs: [newLeg(1, o, hubPlace, 'rail'), newLeg(2, hubPlace, d, 'plane')],
      explanation: '假设先乘铁路到「' + mixedHub + '」再飞往目的地的混合走法：中转城市' + HUB_SOURCE_LABEL[mixedHubSrc] + '，两段班期与衔接待逐段取证'
    });
  } else if (!railEligible) {
    degradations.push('混合交通骨架假设大陆铁路起段，当前出发地不适用：该骨架未生成');
  } else {
    degradations.push('混合交通骨架需要铁路中转城市来源（地理顺路候选或 AI 提名），当前不可用：该骨架未生成');
  }

  /* 约束应用：换乘次数可直接校验（结构事实）；预算/中转时长/夜间到达需取证到数字或时刻才能评估——如实说明 */
  if (constraints.max_transfers != null) {
    const kept = candidates.filter((c2) => c2.transfers <= constraints.max_transfers);
    const dropped = candidates.filter((c2) => c2.transfers > constraints.max_transfers);
    if (dropped.length) {
      constraint_notes.push('已按「换乘 ≤ ' + constraints.max_transfers + ' 次」过滤：' +
        dropped.map((c2) => KIND_LABEL[c2.kind]).join('、') + ' 骨架未展示');
    }
    candidates.length = 0;
    candidates.push(...kept);
  }
  if (constraints.budget_max_cny != null) constraint_notes.push('预算约束需取证到价格样本后才能评估，当前不做任何断言');
  if (constraints.max_layover_hours != null) constraint_notes.push('最长中转时长约束需取证到两段班期后才能校验衔接余量');
  if (constraints.night_arrival) constraint_notes.push('夜间到达约束需取证到段到达时刻后才能校验（骨架阶段无时刻）');

  return { candidates, degradations, constraint_notes };
}

/* ---------- 逐段 searchWeb 取证（有线索 ≠ 已核验；失败保持探索态） ---------- */

function searchQueryFor(leg) {
  const modeWord = leg.mode_guess === 'rail' ? '火车' : leg.mode_guess === 'plane' ? '航班' : '交通';
  return leg.from + ' 到 ' + leg.to + ' ' + modeWord + ' 怎么走';
}

/** 逐段取证：同查询缓存（限速纪律）；来源只保留 https 链接（v0.29.1 白名单教训）；不展示摘要防数字误引。 */
export async function verifyLegs(candidates, searchFn) {
  if (!searchFn) return { searched: 0 };
  const cache = new Map();
  let searched = 0;
  for (const cand of candidates) {
    for (const leg of cand.legs) {
      const q = searchQueryFor(leg);
      let res = cache.get(q);
      if (res === undefined) {
        res = await searchFn(q);
        cache.set(q, res);
      }
      const sources = (res || [])
        .filter((r) => r && typeof r.link === 'string' && /^https:/.test(r.link))
        .slice(0, 3)
        .map((r) => ({ title: String(r.title || '').slice(0, 120), link: r.link, sampled_at: new Date().toISOString() }));
      if (sources.length) {
        leg.evidence_state = 'searched';
        leg.sources = sources;
        leg.evidence_note = '已检索到公开来源线索（线索级，非班期核验）';
        searched++;
      }
    }
  }
  return { searched };
}

/* ---------- 编排：解析 → 约束 → 骨架 → 取证（web_search 可用才取证，否则明确降级） ---------- */

function llmResolvePrompt(namesJson) {
  return '你是 MixTouring 的地点解析器。从用户一句话中识别出发地与目的地，只能从下列已收录地点清单中选择' +
    '（含城市/机场/车站/景点的名称与常见别名）；识别不了就置 null，绝不编造。只输出 JSON 对象：' +
    '{"origin":"清单内地点名|null","destination":"清单内地点名|null"}。清单：' + namesJson;
}

function llmHubPrompt(citiesJson, originName, destName) {
  return '你是 MixTouring 的中转提名器。为 ' + originName + ' → ' + destName + ' 的行程提名两个中转城市：' +
    'one_transfer_city（一次航班中转的城市）与 mixed_rail_city（先铁路抵达、再飞往目的地的中转城市）。' +
    '只能从下列已收录城市清单中选择，选不了就置 null，绝不编造，理由里不得出现任何数字。只输出 JSON 对象：' +
    '{"one_transfer_city":"清单内城市|null","mixed_rail_city":"清单内城市|null","note":"一句话理由（无数字）"}。清单：' + citiesJson;
}

/**
 * G2.5 任意地点规划入口。
 * @param {object} input {text} 一句话模式，或 {origin, destination, constraints} 两字段模式（约束可显式传入覆盖文本提取）
 * @param {object} deps 测试注入 {callJson, searchWeb, env}
 */
export async function planAnywhere(input, deps = {}) {
  const callJson = deps.callJson || callJsonDefault;
  const env = deps.env || process.env;
  const degradations = [];
  const needs = [];
  const places = loadPlaces();
  const allNames = places.map((p) => p.name);
  const cityNames = places.filter((p) => p.kind === 'city').map((p) => p.name);

  let o = null, d = null;
  let parse_engine = 'none';
  const rawOrigin = input.origin != null ? String(input.origin).trim() : null;
  const rawDest = input.destination != null ? String(input.destination).trim() : null;

  if (rawOrigin || rawDest) {
    /* 两字段模式：词典精确/别名解析；未收录 → needs_confirmation（不猜，不走 LLM 猜地名） */
    o = rawOrigin ? resolvePlace(rawOrigin) : null;
    d = rawDest ? resolvePlace(rawDest) : null;
    parse_engine = (o || d) ? 'dict' : 'none';
  } else if (input.text) {
    /* 一句话模式：词典扫描 + from/to 判定 → 缺失再 LLM 辅助（清单内校验） */
    const seq = scanPlaceMentions(input.text).map((s) => ({ city: s.place.name, idx: s.idx }));
    const ft = assignFromTo(String(input.text), seq);
    const byName = new Map(places.map((p) => [p.name, p]));
    o = ft.from ? byName.get(ft.from) || null : null;
    d = ft.to ? byName.get(ft.to) || null : null;
    const dictO = !!o, dictD = !!d;
    if (!o || !d) {
      const llmOut = await callJson({
        schema_prompt: llmResolvePrompt(JSON.stringify(allNames)),
        user: '行程：' + String(input.text),
        kind: 'anywhere'
      });
      if (llmOut && typeof llmOut === 'object') {
        const lo = allNames.includes(llmOut.origin) ? byName.get(llmOut.origin) : null;
        const ld = allNames.includes(llmOut.destination) ? byName.get(llmOut.destination) : null;
        o = o || lo;
        d = d || ld;
      }
    }
    const llmFilled = (!dictO && o) || (!dictD && d);
    parse_engine = (dictO || dictD)
      ? (o && d ? (llmFilled ? 'dict+llm' : 'dict') : 'dict-partial')
      : (o || d ? 'llm' : 'none');
  }

  const constraints = { ...extractConstraints(input.text), ...sanitizeConstraints(input.constraints) };
  const chips = constraintChips(constraints);
  const intent = {
    origin: o ? o.name : (rawOrigin || null),
    destination: d ? d.name : (rawDest || null),
    origin_place: o,
    destination_place: d,
    constraints,
    constraint_chips: chips,
    parse_engine
  };

  if (!o) needs.push('出发地未识别：请用已收录的城市/机场/车站/景点名（或其常用别名）');
  if (!d) needs.push('目的地未识别：请用已收录的城市/机场/车站/景点名（或其常用别名）');
  if (o && d && o.name === d.name) needs.push('出发地与目的地相同：跨城交通规划不适用（市内接驳不在当前范围）');
  if (!o || !d || o.name === d.name) {
    return {
      intent,
      route: null,
      needs_confirmation: needs,
      candidates: [],
      constraint_notes: [],
      degradations,
      next_steps: ['补全或修正地点后重新规划；未识别的地点可登记心愿，取证收录后即可规划'],
      planner_version: ANYWHERE_VERSION
    };
  }

  const route = resolveRoute(o.name, d.name);

  /* LLM 中转提名（geo 覆盖不到时才需要；一次调用覆盖两类骨架；清单校验在 buildCandidateSkeletons 消费点） */
  const llmHints = {};
  if (!isDomesticPair(o, d) || !(geoCityName(o) && geoCityName(d))) {
    const hubOut = await callJson({
      schema_prompt: llmHubPrompt(JSON.stringify(cityNames), o.name, d.name),
      user: '为 ' + o.name + ' → ' + d.name + ' 提名中转城市',
      kind: 'anywhere'
    });
    if (hubOut && typeof hubOut === 'object') {
      if (hubOut.one_transfer_city) llmHints.one_transfer_city = hubOut.one_transfer_city;
      if (hubOut.mixed_rail_city) llmHints.mixed_rail_city = hubOut.mixed_rail_city;
    }
  }

  const built = buildCandidateSkeletons(o, d, constraints, llmHints);
  degradations.push(...built.degradations);

  /* 逐段取证：只在 web_search 真实可用时进行，否则明确降级（评审流转决定） */
  const wsReady = webSearchConfigured(env).configured;
  let searchStat = { searched: 0 };
  if (wsReady) {
    searchStat = await verifyLegs(built.candidates, deps.searchWeb !== undefined ? deps.searchWeb : searchWebDefault);
    if (!searchStat.searched) degradations.push('联网检索本次未取得任何来源线索：全部段保持探索态（未取证）');
  } else {
    degradations.push('web_search 未配置或不可用：全部候选段保持探索态（未取证），不模拟证据');
  }

  return {
    intent,
    route: { route_type: route.route_type },
    needs_confirmation: [],
    candidates: built.candidates,
    constraint_notes: built.constraint_notes,
    degradations,
    next_steps: [
      '所有候选均为待验证假设：请按每段的核对入口到原平台确认班期',
      '取证到价格/时刻后，预算、中转时长与夜间到达约束才能逐项校验',
      '把核验结果带回来（登记心愿或反馈），可帮助这条 OD 升级为已取证样本'
    ],
    planner_version: ANYWHERE_VERSION
  };
}
