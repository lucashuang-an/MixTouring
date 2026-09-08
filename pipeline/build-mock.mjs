/* build-mock.mjs · 方案库 → 浏览器 mock.js（服务层）
 * 用法：node pipeline/build-mock.mjs
 * 产物：mixtouring-hifi/assets/mock.js（生成文件，勿手改） */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildServiceDB } from './lib/derive.mjs';
import { validateStore } from './lib/validate-ai-copy.mjs';
import { validateStorePlans } from './lib/validate-plan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = JSON.parse(readFileSync(join(root, 'pipeline/data/plans.json'), 'utf8'));

const errors = [...validateStorePlans(store), ...validateStore(store)];
if (errors.length) {
  console.error('方案库校验未通过：');
  errors.forEach((e) => console.error('  ✗ ' + e));
  process.exit(1);
}

const db = buildServiceDB(store);

function findPlanSource(id) {
  return store.plans.find((p) => p.id === id) || store.templates.find((t) => t.id === id) || null;
}

const body = `/* MixTouring HIFI — mock.js · 全链路单一数据源
 * ⚠️ 本文件由 pipeline/build-mock.mjs 生成，请勿手改；数据维护在 pipeline/data/plans.json
 * 生成时间：${new Date().toISOString()} · 数据版本：${store.meta.version} */
(function () {
  'use strict';

  var CITIES = ${JSON.stringify(db.cities)};

  var ROUTES = ${JSON.stringify(db.routes, null, 2)};

  var TEMPLATES = ${JSON.stringify(db.templates, null, 2)};

  /* ---------- 查找辅助 ---------- */

  function findPlan(id) {
    for (var key in ROUTES) {
      var plans = ROUTES[key].plans;
      for (var i = 0; i < plans.length; i++) {
        if (plans[i].id === id) return plans[i];
      }
    }
    return null;
  }

  function findTemplate(id) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return null;
  }

  window.DB = {
    cities: CITIES,
    routes: ROUTES,
    templates: TEMPLATES,
    findPlan: findPlan,
    findTemplate: findTemplate,
    findItem: function (id) { return findPlan(id) || findTemplate(id); }
  };
})();
`;

const out = join(root, 'mixtouring-hifi/assets/mock.js');
writeFileSync(out, body, 'utf8');

const planCount = Object.values(db.routes).reduce((n, r) => n + r.plans.length, 0);
console.log(`✓ AI 文案校验通过（${store.plans.length + store.templates.filter((t) => !t.ref).length} 份）`);
console.log(`✓ 已生成 ${out}`);
console.log(`  ${db.cities.length} 城市 · ${Object.keys(db.routes).length} 路线对 · ${planCount} 方案 · ${db.templates.length} 模板`);
