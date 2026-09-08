/* check-pages.mjs · 原型静态自检（无浏览器）
 * 用法：node pipeline/check-pages.mjs
 * 检查：1) 每页内联脚本语法  2) getElementById 引用存在  3) use href 图标在 sprite 已定义
 *       4) 页面跳转目标文件存在  5) 硬约束红线（购买入口词） */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = join(root, 'mixtouring-hifi/pages');
const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html'));

/* 购买/交易类红线词（产品定位：纯内容方案，无购买入口） */
const FORBIDDEN = ['立即购买', '立即预订', '去支付', '下单', 'buy now', 'checkout'];

let fail = 0;
const err = (page, msg) => { fail++; console.error(`  ✗ [${page}] ${msg}`); };

for (const page of pages) {
  const html = readFileSync(join(pagesDir, page), 'utf8');

  /* 1) 内联脚本语法 */
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  scripts.forEach((code, i) => {
    if (!code.trim()) return;
    try { new Function(code); } catch (e) { err(page, `内联脚本#${i + 1} 语法错误: ${e.message}`); }
  });

  /* 2) getElementById 引用（目标须在静态 HTML 或 JS 生成的 id="..." 字符串中） */
  const staticIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const dynamicIds = new Set([...html.matchAll(/id=\\?"([A-Za-z][\w-]*)\\?"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/getElementById\('([^']+)'\)/g)) {
    const id = m[1];
    if (!staticIds.has(id) && !dynamicIds.has(id)) err(page, `getElementById('${id}') 无对应元素`);
  }

  /* 3) 图标引用 */
  const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...html.matchAll(/(?:use href="|href=\\?"|setAttribute\('href',\s*')#(hero-[\w-]+)/g)].map((m) => m[1]));
  for (const r of refs) if (!symbols.has(r)) err(page, `图标 #${r} 未在 sprite 定义`);

  /* 4) 跳转目标文件 */
  const hops = new Set([...html.matchAll(/(?:location\.href\s*=\s*'|MT\.go\('|goBack\('|replace\(')([a-z-]+\.html)/g)].map((m) => m[1]));
  for (const h of hops) if (!existsSync(join(pagesDir, h))) err(page, `跳转目标 ${h} 不存在`);

  /* 5) 红线词 */
  for (const w of FORBIDDEN) if (html.includes(w)) err(page, `出现红线词「${w}」（产品无购买入口）`);
}

/* mock.js 语法与 DB 形状 */
try {
  const mockPath = join(root, 'mixtouring-hifi/assets/mock.js');
  new Function(readFileSync(mockPath, 'utf8'));
  console.log('✓ mock.js 语法通过');
} catch (e) { fail++; console.error('  ✗ [mock.js] 语法错误: ' + e.message); }

if (fail) { console.error(`\n自检未通过：${fail} 个问题`); process.exit(1); }
console.log(`✓ ${pages.length} 个页面静态自检全部通过（脚本语法 / DOM id / 图标 / 跳转 / 红线词）`);
