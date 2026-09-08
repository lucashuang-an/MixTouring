/* index.mjs · MixTouring Phase 1 薄后端（原生 Koa）
 * 架构（AGENTS §6.2）：存储层 plans.json → 双校验 → derive.buildServiceDB 服务层派生
 * 接口形状 = mixtouring-hifi/assets/mock.js 的 DB 形状（API 响应契约）
 * 与 api.js 桩注释的映射：/api/routes/:routeId ≙ /api/plans?from=&to=（route_id = `${from}-${to}`）；
 * /api/item/:id ≙ /api/items/:id；/api/cities 合并入 /api/bootstrap（search 页同步渲染约束） */
import Koa from 'koa';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { buildServiceDB } from '../pipeline/lib/derive.mjs';
import { validateStore } from '../pipeline/lib/validate-ai-copy.mjs';
import { validateStorePlans } from '../pipeline/lib/validate-plan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

/* ---------- 存储层装载 + 写入同级校验（fail fast） ---------- */
const store = JSON.parse(readFileSync(join(root, 'pipeline/data/plans.json'), 'utf8'));
const errors = [...validateStorePlans(store), ...validateStore(store)];
if (errors.length) {
  console.error('✗ 方案库校验未通过，服务拒绝启动：');
  errors.forEach((e) => console.error('  ✗ ' + e));
  process.exit(1);
}

/* ---------- 服务层派生（内存缓存；plans.json 变更需重启或接 watch） ---------- */
const db = buildServiceDB(store);
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

/* ---------- API 路由 ---------- */
app.use(async (ctx, next) => {
  if (!ctx.path.startsWith('/api/')) return next();
  ctx.type = 'application/json; charset=utf-8';
  const path = ctx.path;
  const q = ctx.query;

  /* GET /api/bootstrap → 全量服务层 DB（api.js 预取后原地改写 window.DB） */
  if (path === '/api/bootstrap') {
    ctx.body = { code: 0, data: { cities: db.cities, routes: db.routes, templates: db.templates } };
    return;
  }

  /* GET /api/plans?from&to&date → { direct, plans[] }（date 参数预留询价，Phase 1 未启用） */
  if (path === '/api/plans') {
    const route = db.routes[q.from + '-' + q.to] || { direct: null, plans: [] };
    ctx.body = { code: 0, data: route };
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
