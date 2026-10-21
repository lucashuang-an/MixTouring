/* 结论与证据关联（v0.60.1 R1-B）：运营类肯定结论必须挂可支持的证据——提问帖不是答案、
 * 背景介绍不证明航线、反向/旧资料不支持当期正向。与数字事实守门(numeric-grounding)同构：
 * 模型先拿证据目录，输出后由程序校验标注的真实性与支持性，不通过进入纠正重调。
 * 非运营的一般讨论、探索建议与有出处经验表述不受影响。 */
import {classifyTravelSource} from './travel-sources.mjs';
import {assessSourceTime, retrievalContext} from './source-time.mjs';
import {resolvePlace} from './anywhere.mjs';
import {loadPlaces} from './trip-service.mjs';

const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const QUESTION_LIKE = /\?|？|怎么|如何|求\s*(?:推荐|share|分享)?|请问|有人知道|有人坐过吗|求攻略/;
const OPERATIONAL = /开通|恢复(?:运行|运营)|复航|通车|直飞|(?:有|开通了?|开设了?)?(?:班车|班线)|每天发车|已运行|运营中|有(?:这|此)?(?:趟|班)(?:车|航班|列车)/;

const CITY_NAMES = loadPlaces().filter(p => p.kind === 'city').map(p => p.name);

/** 来源是否是「提问帖」——问句语义且无肯定运营陈述；提问不是已获答案。 */
export function isQuestionSource(source) {
  const text = str(source?.title, 160) + ' ' + str(source?.excerpt || source?.content, 600);
  return QUESTION_LIKE.test(text) && !/开通|恢复(?:运行|运营)|复航|已运行|运营中|直飞|时刻表如下|具体班次/.test(text);
}

/** 文本内两端方向：城市 a（含别名）与 b 的首现顺序。任一未出现 → null。 */
export function textDirection(text, a, b) {
  const t = str(text, 1400);
  const firstOf = city => {
    let best = -1;
    for (const alias of [city, ...(resolvePlace(city)?.aliases || [])]) {
      const at = t.indexOf(alias);
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    return best;
  };
  const ia = firstOf(a), ib = firstOf(b);
  if (ia < 0 || ib < 0) return null;
  return ia < ib ? 'AB' : 'BA';
}

/** 句中出现的前两个已收录城市（按首现顺序）。 */
export function statementCities(sentence) {
  const found = [];
  for (const name of CITY_NAMES) {
    const at = sentence.indexOf(name);
    if (at >= 0) found.push({name, at});
  }
  found.sort((a, b) => a.at - b.at);
  return found.slice(0, 2).map(f => f.name);
}

/** 证据目录：当期可引用来源进入（archive/背景目录不进）；问句标记供模型与校验使用。
 *  目录内 direction 为条目自身对「本旅行 OD」的方向（可能为 null——条目未同时含两端）。 */
export function buildEvidenceCatalog({sources = [], routing = {}, retrieval = {}, now = Date.now()} = {}) {
  const entries = [];
  const seen = new Set();
  const context = retrievalContext({window: retrieval.window || null, purpose: 'experience', now});
  for (const source of sources) {
    const url = source.url || source.link;
    if (!url || !/^https:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    const time = assessSourceTime({...source, published_at: source.published_at || source.date}, context);
    const meta = classifyTravelSource(url);
    const kind = source.kind || meta?.kind || 'guide';
    entries.push({
      id: 'ev_' + (entries.length + 1), url,
      title: str(source.title, 120), kind, platform: source.platform || meta?.platform || null,
      question_like: isQuestionSource(source),
      direction: routing.origin && routing.destination ? textDirection(str(source.title, 200) + ' ' + str(source.excerpt || source.content, 1200), routing.origin, routing.destination) : null,
      temporal_state: time.state, date_scope: time.date_scope,
      date_basis: source.date_basis || (source.published_at ? 'page_metadata' : 'unknown'),
      published_at: time.published_at || null, read_status: source.read_status || 'search_excerpt',
      excerpt: str(source.excerpt || source.content, 400),
      reference_catalog: true,
      allowed_use: source.kind === 'experience' ? 'travel_experience' : 'source_reference'
    });
    if (entries.length >= 12) break;
  }
  return {schema_version: 1, routing: {origin: routing.origin || null, destination: routing.destination || null}, entries};
}

/** 运营断言句校验：回复中含运营肯定词的句子必须带 [ev_N] 标注，且证据须
 *  ①存在 ②非提问帖 ③时效足以支持当期表述 ④句中两端城市在来源文本中的顺序一致。
 *  未标注的运营断言句同样拒绝——「没有对应来源则删除该结论或改为待查」。 */
export function validateEvidenceClaims(reply, catalog, {routing = {}, text = ''} = {}) {
  console.error('DBG-VALIDATE: entries=' + (catalog?.entries||[]).length + ' reply=' + String(reply||'').slice(0,30));
  const entries = catalog?.entries || [];
  const rejected = [], grounded = [];
  const sentences = String(reply || '').split(/(?<=[。！？!?；;\n])/).map(s => s.trim()).filter(s => s && OPERATIONAL.test(s));
  for (const sentence of sentences) {
    const refs = [...sentence.matchAll(/\[(ev_\d+)\]/g)].map(m => m[1]);
    if (!refs.length) { rejected.push({sentence: sentence.slice(0, 120), reason: '运营结论缺少来源标注'}); continue; }
    const cities = statementCities(sentence);
    const needDirection = cities.length === 2;
    for (const ref of refs) {
      const entry = entries.find(e => e.id === ref);
      if (!entry) { rejected.push({sentence: sentence.slice(0, 120), ref, reason: '引用不存在的证据编号'}); continue; }
      if (entry.question_like) { rejected.push({sentence: sentence.slice(0, 120), ref, reason: '提问帖不是已获答案'}); continue; }
      if (!['recent', 'window_reference'].includes(entry.temporal_state)) { rejected.push({sentence: sentence.slice(0, 120), ref, reason: '来源时效不足以支持当期运营结论'}); continue; }
      if (needDirection) {
        const sourceText = entry.title + ' ' + (entry.excerpt || '');
        const sourceDir = textDirection(sourceText, cities[0], cities[1]);
        const stmtDir = textDirection(sentence, cities[0], cities[1]);
        if (sourceDir && stmtDir && sourceDir !== stmtDir) { rejected.push({sentence: sentence.slice(0, 120), ref, reason: '反向资料不支持该方向结论'}); continue; }
      }
      grounded.push({sentence: sentence.slice(0, 160), refs: [ref]});
    }
  }
  return {rejected, grounded, sentence_count: sentences.length};
}
