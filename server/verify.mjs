/* verify.mjs · Phase 1 完成标准验证
 * 「七页在真后端下行为与读 mock.js 完全一致」的可验证定义：
 * 后端与 mock.js 同源（同一 plans.json + 同一 buildServiceDB 管线），
 * 本脚本请求全部接口，与派生结果逐字段深度对比。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildServiceDB } from '../pipeline/lib/derive.mjs';
import { enrichWithGeo } from '../pipeline/lib/geo-skill.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const store = JSON.parse(readFileSync(join(root, 'pipeline/data/plans.json'), 'utf8'));
const db = enrichWithGeo(buildServiceDB(store));

/* VERIFY_BASE：对远端部署实例跑同一套验证（如 VERIFY_BASE=https://xxx.onrender.com）；
 * 缺省验本地。注意：心愿队列断言会在目标实例登记/清理一条测试心愿 */
const BASE = process.env.VERIFY_BASE || 'http://localhost:' + PORT;
let failed = 0;

function diff(label, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  if (a === e) {
    console.log('✓ ' + label);
  } else {
    failed++;
    console.error('✗ ' + label);
    console.error('  期望: ' + e.slice(0, 300));
    console.error('  实际: ' + a.slice(0, 300));
  }
}

async function getJSON(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  const body = await res.json();
  if (!body || body.code !== 0) throw new Error(path + ' → 信封异常 ' + JSON.stringify(body).slice(0, 120));
  return body.data;
}

async function main() {
  /* 地理增强（geo-skill）：每条方案有 geo 字段；非主流方案垫底且 ≤2 条 */
  for (const [routeId, route] of Object.entries(db.routes)) {
    const nonIdx = route.plans.map((p) => p.geo?.verdict).indexOf('non_mainstream');
    const nonCount = route.plans.filter((p) => p.geo?.verdict === 'non_mainstream').length;
    if (nonCount <= 2 && (nonIdx === -1 || route.plans.slice(nonIdx).every((p) => p.geo.verdict === 'non_mainstream'))) {
      console.log(`✓ geo 增强 ${routeId}（非主流 ${nonCount} 条，垫底且 ≤2）`);
    } else {
      failed++;
      console.error(`✗ geo 增强 ${routeId} 异常：非主流 ${nonCount} 条，垫底顺序错误`);
    }
  }

  /* bootstrap 全量 DB */
  diff('/api/bootstrap', await getJSON('/api/bootstrap'), { cities: db.cities, routes: db.routes, templates: db.templates });

  /* /api/plans：每条路线对 + 未知路线兜底 */
  for (const routeId of Object.keys(db.routes)) {
    const [from, to] = routeId.split('-');
    diff('/api/plans?from=' + from + '&to=' + to, await getJSON('/api/plans?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)), db.routes[routeId]);
  }
  diff('/api/plans?from=不存在&to=路线', await getJSON('/api/plans?from=%E4%B8%8D%E5%AD%98%E5%9C%A8&to=%E8%B7%AF%E7%BA%BF'), { direct: null, plans: [] });

  /* /api/templates：全部 + 每个地区 + 未知地区 */
  diff('/api/templates', await getJSON('/api/templates'), db.templates);
  diff('/api/templates?region=全部', await getJSON('/api/templates?region=' + encodeURIComponent('全部')), db.templates);
  const regions = [...new Set(db.templates.map((t) => t.region))];
  for (const region of regions) {
    diff('/api/templates?region=' + region, await getJSON('/api/templates?region=' + encodeURIComponent(region)), db.templates.filter((t) => t.region === region));
  }
  diff('/api/templates?region=未知', await getJSON('/api/templates?region=' + encodeURIComponent('未知')), []);

  /* /api/items：全部方案 + 全部模板 + 未命中 */
  const allIds = [...db.templates.map((t) => t.id), ...Object.values(db.routes).flatMap((r) => r.plans.map((p) => p.id))];
  const byId = {};
  db.templates.forEach((t) => { byId[t.id] = t; });
  Object.values(db.routes).forEach((r) => r.plans.forEach((p) => { byId[p.id] = p; }));
  for (const id of allIds) {
    diff('/api/items/' + id, await getJSON('/api/items/' + encodeURIComponent(id)), byId[id]);
  }
  diff('/api/items/no-such', await getJSON('/api/items/no-such'), null);

  /* POST /api/feedback */
  const fb = await fetch(BASE + '/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p-bjks-1', cost: '太贵', time: '刚好', note: '验证脚本' }) });
  const fbBody = await fb.json();
  diff('POST /api/feedback', fbBody, { code: 0 });

  /* GET /api/parse · Phase 2 触点①规则版（无 LLM key 时应为 rule 引擎） */
  const p1 = await getJSON('/api/parse?q=' + encodeURIComponent('国庆从杭州去喀什'));
  diff('/api/parse 国庆从杭州去喀什.from', p1.from, '杭州');
  diff('/api/parse 国庆从杭州去喀什.to', p1.to, '喀什');
  diff('/api/parse 国庆从杭州去喀什.date', p1.date, new Date().getFullYear() + '/10/01');

  const p2 = await getJSON('/api/parse?q=' + encodeURIComponent('上海到昆明明天'));
  diff('/api/parse 上海到昆明明天.from', p2.from, '上海');
  diff('/api/parse 上海到昆明明天.to', p2.to, '昆明');
  diff('/api/parse 上海到昆明明天.date', p2.date, (() => {
    const d = new Date(); const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const p = (n) => n < 10 ? '0' + n : '' + n;
    return `${t.getFullYear()}/${p(t.getMonth() + 1)}/${p(t.getDate())}`;
  })());

  const p3 = await getJSON('/api/parse?q=' + encodeURIComponent('去玩吧'));
  /* llm/model 为环境相关字段（是否注入 key），期望值从同环境 p1 响应动态取 */
  diff('/api/parse 去玩吧（无城市不编造）', p3, { from: null, to: null, date: null, conf: 0.4, engine: 'rule', note: '部分字段未识别，请手动补全', llm: p1.llm, model: p1.model });

  /* GET /api/ask · Phase 2 触点③ grounded 问答：库内路线必须锚定真实方案 id；库外问题如实说没有 */
  const askRoute = await getJSON('/api/ask?q=' + encodeURIComponent('北京去喀什哪个方案最省钱'));
  if (askRoute && typeof askRoute.answer === 'string' && askRoute.answer.trim() &&
      Array.isArray(askRoute.refs) && askRoute.refs.length > 0 &&
      askRoute.refs.every((id) => id.startsWith('p-bjks-'))) {
    console.log('✓ /api/ask 库内路线（refs 锚定方案 id，engine=' + askRoute.engine + '）');
  } else {
    failed++;
    console.error('✗ /api/ask 库内路线异常：' + JSON.stringify(askRoute).slice(0, 200));
  }
  const askNone = await getJSON('/api/ask?q=' + encodeURIComponent('附近有什么好吃的'));
  if (askNone && typeof askNone.answer === 'string' && askNone.answer.trim() &&
      Array.isArray(askNone.refs) && askNone.refs.length === 0) {
    console.log('✓ /api/ask 库外问题如实兜底（refs 为空，engine=' + askNone.engine + '）');
  } else {
    failed++;
    console.error('✗ /api/ask 库外问题应无 refs：' + JSON.stringify(askNone).slice(0, 200));
  }
  /* 词典外目的地：已入库路线正常应答（回归：北京-西双版纳已生成） */
  const askXSB = await getJSON('/api/ask?q=' + encodeURIComponent('北京去西双版纳有什么方案'));
  if (typeof askXSB.answer === 'string' && Array.isArray(askXSB.refs) && askXSB.refs.every((id) => id.startsWith('p-bjxbn-'))) {
    console.log('✓ /api/ask 词典外已入库路线正常应答（refs 锚定 p-bjxbn-*）');
  } else {
    failed++;
    console.error('✗ /api/ask 西双版纳应答异常：' + JSON.stringify(askXSB).slice(0, 200));
  }
  /* 词典外且未入库的目的地必须声明无数据（回归：北京去西双版纳曾答非所问；现用大理看守） */
  const askDali = await getJSON('/api/ask?q=' + encodeURIComponent('北京去大理有什么方案'));
  if (typeof askDali.answer === 'string' && askDali.answer.includes('大理') && /暂无|没有|无数据/.test(askDali.answer)) {
    console.log('✓ /api/ask 词典外目的地声明无数据（大理，engine=' + askDali.engine + '）');
  } else {
    failed++;
    console.error('✗ /api/ask 词典外目的地未声明：' + JSON.stringify(askDali).slice(0, 200));
  }

  /* ---------- Phase 3 心愿队列：登记（幂等去重）→ 查询 → 清理（测试数据不入库） ---------- */
  const TEST_WISH = { from: '测甲城', to: '测乙城', date: '2026/10/01' };
  const wishAddRes = await (await fetch(BASE + '/api/wishlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(TEST_WISH) })).json();
  if (wishAddRes.code === 0 && wishAddRes.data && wishAddRes.data.id && wishAddRes.data.status === 'pending' && !wishAddRes.data.deduped) {
    console.log('✓ /api/wishlist 登记新心愿');
  } else { failed++; console.error('✗ /api/wishlist 登记异常：' + JSON.stringify(wishAddRes).slice(0, 200)); }

  const wishDup = await (await fetch(BASE + '/api/wishlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(TEST_WISH) })).json();
  if (wishDup.code === 0 && wishDup.data.deduped && wishDup.data.id === wishAddRes.data.id) {
    console.log('✓ /api/wishlist 同路线幂等去重');
  } else { failed++; console.error('✗ /api/wishlist 去重异常：' + JSON.stringify(wishDup).slice(0, 200)); }

  const wishBad = await (await fetch(BASE + '/api/wishlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '测甲城' }) })).json();
  diff('/api/wishlist 缺目的地拒绝', wishBad, { code: 1, msg: '缺少出发地或目的地' });

  const wishSame = await (await fetch(BASE + '/api/wishlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '测甲城', to: '测甲城' }) })).json();
  diff('/api/wishlist 起终点相同拒绝', wishSame, { code: 1, msg: '出发地和目的地不能相同' });

  const wishList = await getJSON('/api/wishlist');
  if (Array.isArray(wishList) && wishList.some((w) => w.id === wishAddRes.data.id)) {
    console.log('✓ /api/wishlist GET 含新登记心愿');
  } else { failed++; console.error('✗ /api/wishlist GET 未包含新登记心愿'); }

  const wishDel = await (await fetch(BASE + '/api/wishlist/' + wishAddRes.data.id, { method: 'DELETE' })).json();
  diff('DELETE /api/wishlist/:id', wishDel, { code: 0 });
  const wishListAfter = await getJSON('/api/wishlist');
  if (!wishListAfter.some((w) => w.id === wishAddRes.data.id)) {
    console.log('✓ 清理后队列不含测试心愿');
  } else { failed++; console.error('✗ 测试心愿未清理干净'); }

  /* POST /api/wishlist/process（不显式 run：只报数不触发 LLM，CI 安全） */
  const procRes = await (await fetch(BASE + '/api/wishlist/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })).json();
  if (procRes.code === 0 && procRes.data && procRes.data.accepted === false && typeof procRes.data.pending === 'number') {
    console.log('✓ /api/wishlist/process 探测模式（accepted:false，pending ' + procRes.data.pending + '）');
  } else { failed++; console.error('✗ /api/wishlist/process 探测异常：' + JSON.stringify(procRes).slice(0, 200)); }

  /* ---------- Solo Trip 行程契约冒烟（v0.26.0；LLM 路径仅在 parse 走，CI 无 key 自动规则版） ---------- */
  const tripSearch = await (await fetch(BASE + '/api/trip/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: '北京', destination: '阿拉木图', trip_type: 'round_trip', outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1, currency: 'CNY' }) })).json();
  if (tripSearch.code === 0 && tripSearch.data.strategies.length === 1 && ['dated_partial', 'historical', 'stale'].includes(tripSearch.data.evidence_state)) {
    console.log('✓ /api/trip/search 北京⇄阿拉木图（证据状态 ' + tripSearch.data.evidence_state + '）');
  } else { failed++; console.error('✗ /api/trip/search 异常：' + JSON.stringify(tripSearch).slice(0, 200)); }

  const tripReverse = await (await fetch(BASE + '/api/trip/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: '阿拉木图', destination: '北京', trip_type: 'round_trip', outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1, currency: 'CNY' }) })).json();
  if (tripReverse.code === 0 && tripReverse.data.strategies.length === 0 && tripReverse.data.evidence_state === 'explore') {
    console.log('✓ /api/trip/search 反向查询 → 探索态（不由 B–A 反转构造）');
  } else { failed++; console.error('✗ /api/trip/search 反向未返回探索态：' + JSON.stringify(tripReverse).slice(0, 200)); }

  /* v0.26.3 复审①验收：真实路由 + 真实城市源（含 Trip 词典）跑产品方案 §6 原句——国际 OD 必须可识别 */
  const tripParse = await (await fetch(BASE + '/api/trip/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '国庆附近一个人从北京去阿拉木图，玩几天后回来' }) })).json();
  const pq = tripParse.data?.query;
  if (tripParse.code === 0 && pq && pq.origin === '北京' && pq.destination === '阿拉木图' && pq.trip_type === 'round_trip' && pq.traveler_count === 1) {
    console.log('✓ /api/trip/parse §6 原句：北京→阿拉木图 国际 OD + 往返 + 一人（engine ' + tripParse.data.parse_engine + '）');
  } else { failed++; console.error('✗ /api/trip/parse 国际 OD 解析失败：' + JSON.stringify(tripParse).slice(0, 200)); }

  /* v0.26.3 复审②验收：「国庆附近」保留弹性假期区间，不收缩为 10/01 单日 */
  if (pq && /^\d{4}-09-27 ~ \d{4}-10-07$/.test(pq.outbound_window || '')) {
    console.log('✓ /api/trip/parse 国庆附近 → 假期宽窗 ' + pq.outbound_window);
  } else { failed++; console.error('✗ /api/trip/parse 假期窗收缩异常：' + JSON.stringify(pq?.outbound_window)); }

  if (pq?.return_window === null && tripParse.data.needs_confirmation?.some((s) => s.includes('返程'))) {
    console.log('✓ /api/trip/parse 缺返程窗要求用户补全');
  } else { failed++; console.error('✗ /api/trip/parse 缺返程窗未提示补全'); }

  /* v0.26.3 复审③验收：明确「10 月 1 日」→ 单日窗；「直达」→ 不猜单程 */
  const tripExact = await (await fetch(BASE + '/api/trip/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '10月1日从北京去阿拉木图' }) })).json();
  if (tripExact.code === 0 && tripExact.data.query.outbound_window === '2026-10-01 ~ 2026-10-01') {
    console.log('✓ /api/trip/parse 明确 10/01 → 单日窗');
  } else { failed++; console.error('✗ /api/trip/parse 明确日期窗异常：' + JSON.stringify(tripExact.data?.query?.outbound_window)); }

  const tripDirect = await (await fetch(BASE + '/api/trip/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '北京直达阿拉木图' }) })).json();
  if (tripDirect.code === 0 && tripDirect.data.query.trip_type === 'pending') {
    console.log('✓ /api/trip/parse 「直达」→ 不猜单程（pending 待确认）');
  } else { failed++; console.error('✗ /api/trip/parse 「直达」误判：' + JSON.stringify(tripDirect.data?.query?.trip_type)); }

  const tripOneWay = await (await fetch(BASE + '/api/trip/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...tripSearch.data.query, trip_type: 'one_way', return_window: null }) })).json();
  if (tripOneWay.code === 0 && tripOneWay.data.strategies.length === 1 && tripOneWay.data.strategies[0].inbound.length === 0 && tripOneWay.data.strategies[0].structure.length === 1) {
    console.log('✓ /api/trip/search 单程不混入返程');
  } else { failed++; console.error('✗ /api/trip/search 单程混入返程：' + JSON.stringify(tripOneWay).slice(0, 200)); }

  const tripCl = await (await fetch(BASE + '/api/trip/checklist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: tripSearch.data.query, strategy_id: tripSearch.data.strategies[0].id }) })).json();
  if (tripCl.code === 0 && tripCl.data.checklist.length === 2 && tripCl.data.checklist[0].missing.includes('班次/航班号未核验') && tripCl.data.checklist[0].sampled_at && tripCl.data.checklist[0].local_times.includes('Asia/Almaty')) {
    console.log('✓ /api/trip/checklist 从检索策略生成双向清单，保留取样时间与起落时区');
  } else { failed++; console.error('✗ /api/trip/checklist 异常：' + JSON.stringify(tripCl).slice(0, 200)); }

  const forgedCl = await (await fetch(BASE + '/api/trip/checklist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ strategy: { outbound: [{ service_no: '伪造班次' }] } }) })).json();
  if (forgedCl.code === 1) {
    console.log('✓ /api/trip/checklist 不接受客户端伪造策略');
  } else { failed++; console.error('✗ /api/trip/checklist 接受了伪造策略：' + JSON.stringify(forgedCl).slice(0, 200)); }

  /* ---------- G2.5 任意地点规划（v0.31.0；规则路径断言，LLM/OSM/搜索路径由 check-anywhere 注入桩覆盖） ---------- */
  const anyPlan = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: '北京', destination: '喀什' }) })).json();
  const apOk = anyPlan.code === 0 && anyPlan.data.route.route_type === 'domestic' &&
    anyPlan.data.candidates.length >= 1 && anyPlan.data.candidates.every((c) => c.hypothesis === true) &&
    anyPlan.data.candidates.every((c) => c.legs.every((l) => l.evidence_state === 'explore')) &&
    !JSON.stringify(anyPlan.data.candidates).includes('"price"');
  if (apOk) {
    console.log('✓ /api/anywhere/plan 北京→喀什：假设骨架（' + anyPlan.data.candidates.length + ' 类）全探索态零价格字段');
  } else { failed++; console.error('✗ /api/anywhere/plan 异常：' + JSON.stringify(anyPlan).slice(0, 200)); }

  const journey = await (await fetch(BASE + '/api/anywhere/journey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: anyPlan.data.plan_id, candidate_id: anyPlan.data.candidates[0].id, stopover_nights: 0 }) })).json();
  if (journey.code === 0 && journey.data.evidence_state === 'explore' && journey.data.outbound.length === 1 && journey.data.inbound.length === 0 && journey.data.cost.known_total === null) {
    console.log('✓ /api/anywhere/journey：服务端候选生成单程探索详情，费用未知');
  } else { failed++; console.error('✗ /api/anywhere/journey 单程详情异常：' + JSON.stringify(journey).slice(0, 200)); }
  const forgedJourney = await (await fetch(BASE + '/api/anywhere/journey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: anyPlan.data.plan_id, candidate_id: '伪造', stopover_nights: 2 }) })).json();
  if (forgedJourney.code === 1) console.log('✓ /api/anywhere/journey：拒绝伪造候选');
  else { failed++; console.error('✗ /api/anywhere/journey 未拒绝伪造候选'); }

  const anyHkg = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: '北京', destination: '香港' }) })).json();
  const hkgDirects = (anyHkg.data && anyHkg.data.candidates || []).filter((c) => c.kind === 'direct');
  if (anyHkg.code === 0 && anyHkg.data.route.route_type === 'international' &&
    hkgDirects.length === 2 && hkgDirects.some((c) => c.variant === 'plane') && hkgDirects.some((c) => c.variant === 'rail')) {
    console.log('✓ /api/anywhere/plan P1-3：北京→香港 直达航班假设与直达铁路假设并存');
  } else { failed++; console.error('✗ /api/anywhere/plan 国际直达未出双方式：' + JSON.stringify(anyHkg).slice(0, 200)); }

  const anyAlias = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'PEK', destination: 'ALA' }) })).json();
  if (anyAlias.code === 0 && anyAlias.data.intent.origin === '北京首都国际机场' && anyAlias.data.intent.destination === '阿拉木图国际机场' && anyAlias.data.route.route_type === 'international') {
    console.log('✓ /api/anywhere/plan 别名解析：PEK/ALA → 规范机场名 + 国际路由');
  } else { failed++; console.error('✗ /api/anywhere/plan 别名解析异常：' + JSON.stringify(anyAlias).slice(0, 200)); }

  const anyText = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京首都机场去喀纳斯，预算5000元，不接受夜间到达' }) })).json();
  if (anyText.code === 0 && anyText.data.intent.origin === '北京首都国际机场' && anyText.data.intent.destination === '喀纳斯' &&
    anyText.data.intent.constraints.budget_max_cny === 5000 && anyText.data.intent.constraints.night_arrival === 'avoid' &&
    anyText.data.intent.constraint_chips.length === 2) {
    console.log('✓ /api/anywhere/plan 一句话模式：机场别名 + 景点 + 约束 chips 同句提取');
  } else { failed++; console.error('✗ /api/anywhere/plan 一句话模式异常：' + JSON.stringify(anyText).slice(0, 200)); }

  /* P0-1：未收录地点（开放解析，结果随核验通道可用性变化——两者均为诚实行为）；
   * 确认流只回传服务端签发的 candidate_id（P0-1 信任边界） */
  const anyUnknown = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: '北京', destination: '塔什干' }) })).json();
  const au = anyUnknown.data || {};
  const destCand = (au.place_candidates && au.place_candidates.destination || []).find((c) => c.candidate_id);
  if (anyUnknown.code === 0 && au.candidates.length === 0 && au.needs_confirmation.length >= 1 &&
    (destCand || au.needs_confirmation.some((n) => n.includes('核验') || n.includes('未识别')))) {
    console.log('✓ /api/anywhere/plan P0-1：未收录地点 → 已核验候选待确认或诚实阻断（候选数 ' +
      ((au.place_candidates && au.place_candidates.destination.length) || 0) + '，不预写词典）');
  } else { failed++; console.error('✗ /api/anywhere/plan 未收录地点行为异常：' + JSON.stringify(anyUnknown).slice(0, 200)); }

  if (destCand) {
    const anyConfirmed = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: '北京', destination: '塔什干', confirmed_places: { destination: destCand.candidate_id } }) })).json();
    const ac = anyConfirmed.data || {};
    /* 外部地点源可能返回同名国内地点；此处验证存证事实一致性，国际语义由用户消歧选择决定。 */
    if (anyConfirmed.code === 0 && ac.route && ac.route.route_type === (destCand.country === 'CN' ? 'domestic' : 'international') &&
      ac.intent && ac.intent.destination_place && ac.intent.destination_place.dynamic === true &&
      ac.intent.destination_place.country === destCand.country &&
      ac.intent.destination_place.source_url === destCand.source_url) {
      console.log('✓ /api/anywhere/plan P0-1：candidate_id 确认 → 服务端存证恢复动态 Place（事实与首轮核验一致）');
    } else { failed++; console.error('✗ /api/anywhere/plan 确认流异常：' + JSON.stringify(anyConfirmed).slice(0, 200)); }
  }

  const anyForged = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: '北京', destination: '塔什干', confirmed_places: { destination: { name: '伪造地', kind: 'city', country: 'US', source_url: 'https://evil.example/x', resolution_state: 'verified', lat: '1', lon: '1' } } }) })).json();
  if (anyForged.code === 0 && (anyForged.data.candidates || []).length === 0 && anyForged.data.route === null &&
    anyForged.data.needs_confirmation.some((n) => n.includes('不接受自行拼装的地点数据'))) {
    console.log('✓ /api/anywhere/plan P0-1：浏览器自报完整地点对象被拒（不接受自行拼装数据）');
  } else { failed++; console.error('✗ /api/anywhere/plan 伪造对象未被拒：' + JSON.stringify(anyForged).slice(0, 200)); }

  const anyEmpty = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })).json();
  if (anyEmpty.code === 1) {
    console.log('✓ /api/anywhere/plan 空请求被拒');
  } else { failed++; console.error('✗ /api/anywhere/plan 空请求未拒：' + JSON.stringify(anyEmpty).slice(0, 200)); }

  /* P1-4：capabilities 配置与真实状态分开、版本拆分 */
  const caps = await (await fetch(BASE + '/api/capabilities')).json();
  if (caps.code === 0 && typeof caps.data.web_search_configured === 'boolean' &&
    ['available', 'quota_exhausted', 'timeout', 'error', 'unknown'].includes(caps.data.web_search_status) &&
    caps.data.trip_planner_version === 'v0.29.1' && caps.data.anywhere_planner_version === 'v0.41.0') {
    console.log('✓ /api/capabilities P1-4：configured 与最近真实状态分开（web_search_configured=' +
      caps.data.web_search_configured + ', status=' + caps.data.web_search_status + '），版本拆分对齐');
  } else { failed++; console.error('✗ /api/capabilities 形状异常：' + JSON.stringify(caps).slice(0, 200)); }

  /* ---------- 十一轮：意图合并顺序 / 无效窗口（真实 API 定向反例） ---------- */
  const ivA = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京去阿拉木图往返' }) })).json();
  if (ivA.code === 0 && ivA.data.plan_id && ivA.data.candidates.length) {
    const rtDetail = await (await fetch(BASE + '/api/anywhere/journey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: ivA.data.plan_id, candidate_id: ivA.data.candidates[0].id, stopover_nights: 0 }) })).json();
    if (rtDetail.code === 0 && rtDetail.data.inbound.length === 1 && rtDetail.data.inbound[0].from === '阿拉木图' && rtDetail.data.inbound[0].evidence_state === 'explore') console.log('✓ /api/anywhere/journey：往返方向独立探索，不继承去程证据');
    else { failed++; console.error('✗ /api/anywhere/journey 往返详情异常：' + JSON.stringify(rtDetail).slice(0, 200)); }
  }
  if (ivA.code === 0 && ivA.data.intent.trip_type === 'round_trip' &&
    ivA.data.needs_confirmation.filter((n) => n.includes('日期')).length === 2) {
    console.log('✓ /api/anywhere/plan 无 travel 往返请求不 500：round_trip + 补去返日期两条提示');
  } else { failed++; console.error('✗ /api/anywhere/plan 无 travel 往返异常：' + JSON.stringify(ivA).slice(0, 200)); }

  const ivB = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京去喀什', travel: { trip_type: 'round_trip' } }) })).json();
  if (ivB.code === 0 && ivB.data.intent.trip_type === 'round_trip' &&
    ivB.data.needs_confirmation.filter((n) => n.includes('日期')).length === 2) {
    console.log('✓ /api/anywhere/plan 显式 round_trip 日期空 → 两条日期补全提示');
  } else { failed++; console.error('✗ /api/anywhere/plan 显式往返缺日期异常：' + JSON.stringify(ivB).slice(0, 200)); }

  const ivC = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京去阿拉木图往返', travel: { trip_type: 'one_way' } }) })).json();
  if (ivC.code === 0 && ivC.data.intent.trip_type === 'one_way' &&
    ivC.data.needs_confirmation.every((n) => !n.includes('往返行程请补'))) {
    console.log('✓ /api/anywhere/plan 文本往返 + 显式 one_way → 单程且无残留往返提示');
  } else { failed++; console.error('✗ /api/anywhere/plan 显式覆盖异常：' + JSON.stringify(ivC).slice(0, 200)); }

  const ivD = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-02-31 ~ 2026-02-31', return_window: '2026-99-99 ~ 2026-99-99' } }) })).json();
  if (ivD.code === 0 && ivD.data.intent.outbound_window == null && ivD.data.intent.return_window == null &&
    ivD.data.needs_confirmation.filter((n) => n.includes('日期')).length === 2) {
    console.log('✓ /api/anywhere/plan 无效日期窗口（02-31/99-99）被日历校验丢弃 → 补全提示');
  } else { failed++; console.error('✗ /api/anywhere/plan 无效窗口未拒：' + JSON.stringify(ivD).slice(0, 200)); }

  /* ---------- 十二轮：文本非法返程日期 + 时序完全倒序才拒（真实 POST 反例） ---------- */
  const twA = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '国庆附近从北京去阿拉木图，2月31日回来' }) })).json();
  if (twA.code === 0 && twA.data.intent.return_window == null &&
    twA.data.needs_confirmation.some((n) => n.includes('返程日期'))) {
    console.log('✓ /api/anywhere/plan 文本「2月31日回来」非法日期 → null + 补全提示');
  } else { failed++; console.error('✗ /api/anywhere/plan 非法返程日期未拒：' + JSON.stringify(twA).slice(0, 200)); }

  const twB = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-10-03 ~ 2026-10-05', return_window: '2026-10-01 ~ 2026-10-07' } }) })).json();
  if (twB.code === 0 && twB.data.intent.outbound_window === '2026-10-03 ~ 2026-10-05' &&
    twB.data.intent.return_window === '2026-10-01 ~ 2026-10-07') {
    console.log('✓ /api/anywhere/plan 重叠窗口（去 10-03~05 / 返 10-01~07）保留');
  } else { failed++; console.error('✗ /api/anywhere/plan 重叠窗口被误拒：' + JSON.stringify(twB).slice(0, 200)); }

  const twC = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-10-03 ~ 2026-10-05', return_window: '2026-10-01 ~ 2026-10-02' } }) })).json();
  if (twC.code === 0 && twC.data.intent.return_window == null &&
    twC.data.needs_confirmation.some((n) => n.includes('返程窗口早于去程'))) {
    console.log('✓ /api/anywhere/plan 完全倒序（返程结束早于去程开始）拒绝并提示');
  } else { failed++; console.error('✗ /api/anywhere/plan 完全倒序未拒：' + JSON.stringify(twC).slice(0, 200)); }

  /* ---------- 十三轮：单程不保留返程窗口（真实 POST 反例，评审原载荷） ---------- */
  const ttA = await (await fetch(BASE + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '从北京去阿拉木图往返', travel: { trip_type: 'one_way', outbound_window: '2026-10-03 ~ 2026-10-03', return_window: '2026-10-07 ~ 2026-10-07' } }) })).json();
  if (ttA.code === 0 && ttA.data.intent.trip_type === 'one_way' && ttA.data.intent.return_window == null &&
    ttA.data.intent.outbound_window === '2026-10-03 ~ 2026-10-03' &&
    ttA.data.needs_confirmation.some((n) => n.includes('已忽略返程日期'))) {
    console.log('✓ /api/anywhere/plan one_way + 返程窗 → 返程清空 + 纠正提示（无「单程＋返程日期」矛盾）');
  } else { failed++; console.error('✗ /api/anywhere/plan 单程仍带返程窗：' + JSON.stringify(ttA).slice(0, 200)); }

  console.log(failed ? `\n✗ ${failed} 项不一致` : '\n✓ 全部接口与 mock.js 派生结果一致');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('✗ 验证失败：' + e.message); process.exit(1); });
