/* index.mjs · MixTouring Phase 1 薄后端（原生 Koa）
 * 架构（AGENTS §6.2）：存储层 plans.json → 双校验 → derive.buildServiceDB 服务层派生
 * 接口形状 = mixtouring-hifi/assets/mock.js 的 DB 形状（API 响应契约）
 * 与 api.js 桩注释的映射：/api/routes/:routeId ≙ /api/plans?from=&to=（route_id = `${from}-${to}`）；
 * /api/item/:id ≙ /api/items/:id；/api/cities 合并入 /api/bootstrap（search 页同步渲染约束） */
import Koa from 'koa';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { buildServiceDB, reverseRoute } from '../pipeline/lib/derive.mjs';
import { enrichWithGeo } from '../pipeline/lib/geo-skill.mjs';
import { validateStore } from '../pipeline/lib/validate-ai-copy.mjs';
import { validateStorePlans } from '../pipeline/lib/validate-plan.mjs';
import { parseTrip } from './lib/parse.mjs';
import { answerAsk, suggestWish } from './lib/qa.mjs';
import { addWish, listWishes, removeWish } from './lib/wishlist.mjs';
import { llmConfigured, llmModel } from './lib/llm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

/* ---------- 存储层装载 + 双校验（fail fast）+ 热重载（离线管道写回后无需重启） ---------- */
const PLANS_PATH = join(root, 'pipeline/data/plans.json');
let plansMtime = 0;

function loadDB() {
  const store = JSON.parse(readFileSync(PLANS_PATH, 'utf8'));
  const errors = [...validateStorePlans(store), ...validateStore(store)];
  if (errors.length) throw new Error('方案库校验未通过：' + errors[0]);
  plansMtime = statSync(PLANS_PATH).mtimeMs;
  return enrichWithGeo(buildServiceDB(store));
}

let db;
try {
  db = loadDB();
} catch (err) {
  console.error('✗ ' + err.message + '，服务拒绝启动');
  process.exit(1);
}

/* mtime 变化即整库重载（装载 + 双校验 + 派生）；新库校验不过时沿用旧库并跳过该版本 */
function maybeReload() {
  let mtime;
  try { mtime = statSync(PLANS_PATH).mtimeMs; } catch { return; }
  if (mtime === plansMtime) return;
  try {
    db = loadDB();
    console.log('✓ plans.json 变更，方案库已热重载');
  } catch (err) {
    console.error('✗ 热重载失败，沿用旧库：' + err.message);
    plansMtime = mtime;
  }
}

const planCount = Object.values(db.routes).reduce((n, r) => n + r.plans.length, 0);
console.log(`✓ 方案库已装载：${db.cities.length} 城市 · ${Object.keys(db.routes).length} 路线对 · ${planCount} 方案 · ${db.templates.length} 模板`);

function findItem(id) {
  for (const key in db.routes) {
    const hit = db.routes[key].plans.find((p) => p.id === id);
    if (hit) return hit;
  }
  return db.templates.find((t) => t.id === id) || null;
}

/* Phase 1 反馈仅内存接收（无账号体系，前端以 localStorage 为准），落盘后置 */
const feedbackInbox = [];

const app = new Koa();

/* 统一错误兜底：任何异常都以 {code:1} 信封返回，不让前端拿到 HTML 错误页 */
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('✗ ' + ctx.method + ' ' + ctx.path + '：', err.message);
    ctx.status = 500;
    ctx.body = { code: 1, msg: '服务内部错误' };
  }
});

/* ---------- API 路由（含 /healthz 健康检查） ---------- */
app.use(async (ctx, next) => {
  if (!ctx.path.startsWith('/api/') && ctx.path !== '/healthz') return next();
  ctx.type = 'application/json; charset=utf-8';
  const path = ctx.path;
  const q = ctx.query;

  /* GET /healthz → 部署平台健康检查（不触发重载，只探活） */
  if (path === '/healthz') {
    ctx.body = { status: 'ok', wishes: listWishes().length };
    return;
  }

  /* GET /api/bootstrap → 全量服务层 DB（api.js 预取后原地改写 window.DB） */
  if (path === '/api/bootstrap') {
    maybeReload();
    ctx.body = { code: 0, data: { cities: db.cities, routes: db.routes, templates: db.templates } };
    return;
  }

  /* ---------- 心愿队列（Phase 3）：登记 → 离线管道生成 → 三重守门写回 → 状态回流 ---------- */

  /* GET /api/wishlist → 服务端心愿队列状态 */
  if (path === '/api/wishlist' && ctx.method === 'GET') {
    maybeReload();
    ctx.body = { code: 0, data: listWishes() };
    return;
  }

  /* POST /api/wishlist { from, to, date? } → 登记心愿（同路线未完成登记幂等去重）。
   * 采集执行走离线 AI 工厂（§6.2），此处只入队不做在线生成 */
  if (path === '/api/wishlist' && ctx.method === 'POST') {
    const body = await readBody(ctx);
    const out = addWish({ from: body.from, to: body.to, date: body.date });
    if (out.error) { ctx.body = { code: 1, msg: out.error }; return; }
    ctx.body = { code: 0, data: { ...out.item, deduped: !!out.deduped } };
    return;
  }

  /* DELETE /api/wishlist/:id → 移除心愿（队列管理：清理误登记） */
  if (path.startsWith('/api/wishlist/') && ctx.method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/wishlist/'.length));
    ctx.body = removeWish(id) ? { code: 0 } : { code: 1, msg: '心愿不存在：' + id };
    return;
  }

  /* POST /api/wishlist/process → 触发采集执行器（后台 detached 子进程，不阻塞服务）
   * body { run:true } 全量执行；{ run:true, id } 只处理指定心愿（搜索页/结果页「无数据即起采集」用）；
   * 缺省只报数（verify/前端探测用，避免误触发 LLM 消耗） */
  if (path === '/api/wishlist/process' && ctx.method === 'POST') {
    const pendingCount = listWishes().filter((w) => w.status === 'pending' && (w.attempts || 0) < 3).length;
    const body = await readBody(ctx);
    if (body.run !== true) {
      ctx.body = { code: 0, data: { accepted: false, pending: pendingCount } };
      return;
    }
    if (!llmConfigured()) { ctx.body = { code: 1, msg: 'LLM_API_KEY 未配置，采集执行器不可用' }; return; }
    const targetId = typeof body.id === 'string' ? body.id : null;
    if (targetId) {
      const w = listWishes().find((x) => x.id === targetId);
      if (!w) { ctx.body = { code: 1, msg: '心愿不存在：' + targetId }; return; }
      if ((w.attempts || 0) >= 3) {
        ctx.body = { code: 0, data: { accepted: false, note: '该路线此前多次采集未获合格方案，已转人工评估' } };
        return;
      }
      if (w.status === 'processing') {
        ctx.body = { code: 0, data: { accepted: false, collecting: true, note: '该心愿正在采集中' } };
        return;
      }
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [join(root, 'pipeline/collect-wish.mjs'), '--wish', targetId], {
        cwd: root, detached: true, stdio: 'ignore'
      });
      child.unref();
      console.log(`▶ 采集执行器已后台启动（PID ${child.pid}，指定心愿 ${w.from} → ${w.to}）`);
      ctx.body = { code: 0, data: { accepted: true, pending: 1 } };
      return;
    }
    if (!pendingCount) { ctx.body = { code: 0, data: { accepted: false, pending: 0, note: '无可处理心愿' } }; return; }
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [join(root, 'pipeline/collect-wish.mjs'), '--all'], {
      cwd: root, detached: true, stdio: 'ignore'
    });
    child.unref();
    console.log(`▶ 采集执行器已后台启动（PID ${child.pid}，pending ${pendingCount}）`);
    ctx.body = { code: 0, data: { accepted: true, pending: pendingCount } };
    return;
  }

  /* GET /api/parse?q= → 自然语言行程解析（Phase 2 · 触点①，规则版闭环，注入 key 后切 LLM）
   * 返回 { from, to, date, conf, engine, note }；识别不到的字段为 null，绝不编造 */
  if (path === '/api/parse') {
    const query = qstr(q.q);
    if (!query) { ctx.body = { code: 1, msg: '缺少 q 参数' }; return; }
    const parsed = await parseTrip(query, db.cities);
    ctx.body = { code: 0, data: { ...parsed, llm: llmConfigured(), model: llmModel() } };
    return;
  }

  /* GET /api/ask?q=&collect=1 → 站内问答（Phase 2 · 触点③，grounded：答案数字必须来自库内数据）
   * 返回 { answer, refs, engine, model, followUp? }；refs 为引用的方案 id，前端渲染成详情跳转。
   * collect=1（前端问答带此参）：缺数据且能识别双城时，自动登记心愿并后台触发采集执行器
   * （两步流：①查库 ②缺→进 AI 生成环节）；verify/CI 不带此参，零副作用 */
  if (path === '/api/ask') {
    const query = qstr(q.q);
    if (!query) { ctx.body = { code: 1, msg: '缺少 q 参数' }; return; }
    try {
      const out = await answerAsk(query, db);
      let followUp = null;
      if (q.collect === '1') {
        const sug = suggestWish(query, db);
        if (sug) {
          const added = addWish({ from: sug.from, to: sug.to, date: '' });
          if (added.item) {
            const w = listWishes().find((x) => x.id === added.item.id);
            followUp = {
              wishRegistered: true, wishId: w.id, from: sug.from, to: sug.to,
              deduped: !!added.deduped, collecting: false
            };
            const exhausted = (w.attempts || 0) >= 3;
            if (exhausted) {
              followUp.note = '该路线此前多次采集未获合格方案，已转人工评估';
            } else if (w.status === 'processing') {
              followUp.collecting = true; /* 已在采集（重复问同一路线），前端直接附实时进度 */
            } else if (llmConfigured()) {
              const { spawn } = await import('node:child_process');
              const child = spawn(process.execPath, [join(root, 'pipeline/collect-wish.mjs'), '--wish', w.id], {
                cwd: root, detached: true, stdio: 'ignore'
              });
              child.unref();
              followUp.collecting = true;
              console.log(`▶ 问答衔接采集：${sug.from} → ${sug.to}（${w.id}，PID ${child.pid}）`);
            } else {
              followUp.note = '已登记，采集服务未配置（LLM_API_KEY 缺失）';
            }
          }
        }
      }
      ctx.body = { code: 0, data: { ...out, followUp, model: out.engine === 'llm' ? llmModel() : 'rule' } };
    } catch (err) {
      console.error('✗ /api/ask：' + err.message);
      ctx.body = { code: 0, data: { answer: '问答服务出了点问题，请稍后再试。', refs: [], engine: 'rule', model: 'rule' } };
    }
    return;
  }

  /* GET /api/plans?from&to&date → { direct, plans[] }（date 参数预留询价，Phase 1 未启用）
   * P1.7（v0.19.0）：A-B 无数据时回落 B-A 并反转展示（喀什→北京不再返回空） */
  if (path === '/api/plans') {
    let route = db.routes[q.from + '-' + q.to];
    if (!route && q.from && q.to) {
      const rev = db.routes[q.to + '-' + q.from];
      if (rev) route = reverseRoute(rev, q.from, q.to);
    }
    ctx.body = { code: 0, data: route || { direct: null, plans: [] } };
    return;
  }

  /* GET /api/templates?region → Template[]（region 为空或「全部」时不过滤） */
  if (path === '/api/templates') {
    const region = q.region;
    const list = (!region || region === '全部')
      ? db.templates.slice()
      : db.templates.filter((t) => t.region === region);
    ctx.body = { code: 0, data: list };
    return;
  }

  /* GET /api/items/:id → Plan|Template|null */
  if (path.startsWith('/api/items/')) {
    const id = decodeURIComponent(path.slice('/api/items/'.length));
    ctx.body = { code: 0, data: findItem(id) };
    return;
  }

  /* POST /api/feedback { id, cost, time, note } → { code } */
  if (path === '/api/feedback' && ctx.method === 'POST') {
    const chunk = await readBody(ctx);
    feedbackInbox.push({ received_at: new Date().toISOString(), ...chunk });
    ctx.body = { code: 0 };
    return;
  }

  ctx.status = 404;
  ctx.body = { code: 1, msg: '接口不存在：' + path };
});

function readBody(ctx) {
  return new Promise((resolve) => {
    let raw = '';
    ctx.req.on('data', (c) => { raw += c; });
    ctx.req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ raw }); }
    });
  });
}

/* query 字符串容错：koa 在无该 key 时返回空字符串优先，兼容 |undefined */
function qstr(v) { return v == null ? '' : String(v).trim(); }

/* ---------- 静态服务：七页原型（让前端以 http 源访问，fetch 可用；轻量实现，零额外依赖） ---------- */

const HIFI_DIR = join(root, 'mixtouring-hifi');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

app.use(async (ctx, next) => {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return next();
  const rel = ctx.path === '/' ? '/index.html' : ctx.path;
  const file = normalize(join(HIFI_DIR, decodeURIComponent(rel)));
  if (!file.startsWith(HIFI_DIR + sep)) { ctx.status = 403; return; } /* 防目录穿越 */
  if (!existsSync(file) || !statSync(file).isFile()) { ctx.status = 404; ctx.type = 'text/plain; charset=utf-8'; ctx.body = 'Not Found'; return; }
  ctx.type = MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
  ctx.body = readFileSync(file);
});

app.listen(PORT, () => {
  console.log(`✓ MixTouring Phase 1 后端已启动：http://localhost:${PORT}`);
  console.log('  七页入口：http://localhost:' + PORT + '/index.html');
});
