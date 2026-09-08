/* verify.mjs · Phase 1 完成标准验证
 * 「七页在真后端下行为与读 mock.js 完全一致」的可验证定义：
 * 后端与 mock.js 同源（同一 plans.json + 同一 buildServiceDB 管线），
 * 本脚本请求全部接口，与派生结果逐字段深度对比。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildServiceDB } from '../pipeline/lib/derive.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const store = JSON.parse(readFileSync(join(root, 'pipeline/data/plans.json'), 'utf8'));
const db = buildServiceDB(store);

const BASE = 'http://localhost:' + PORT;
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
  diff('/api/parse 去玩吧（无城市不编造）', p3, { from: null, to: null, date: null, conf: 0.4, engine: 'rule', note: '部分字段未识别，请手动补全', llm: false, model: 'rule' });

  console.log(failed ? `\n✗ ${failed} 项不一致` : '\n✓ 全部接口与 mock.js 派生结果一致');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('✗ 验证失败：' + e.message); process.exit(1); });
