/* generate-plan.mjs · 实时生成写回器：把 LLM+采集产出的新路线方案合入方案库
 * 用法：node pipeline/generate-plan.mjs --input <生成文件.json> [--verified]
 * 输入形状：{ "route_pair": { route_id, from, to, direct }, "plans": [ 存储层 Plan... ] }
 * 守门：结构一致性（validate-plan）+ AI 文案（validate-ai-copy）+ 合并后全库校验，任一不过不写回。
 * 默认 AI 文案强制 draft（人工 review 后改 verified 再上页）；--verified 表示已在会话内 review。 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateStorePlans } from './lib/validate-plan.mjs';
import { validateAICopy } from './lib/validate-ai-copy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'pipeline/data/plans.json');

const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input');
if (inputIdx < 0 || !args[inputIdx + 1]) {
  console.error('✗ 用法: node pipeline/generate-plan.mjs --input <file.json> [--verified]');
  process.exit(1);
}
const verified = args.includes('--verified');

const rawText = readFileSync(join(root, args[inputIdx + 1]), 'utf8').replace(/^﻿/, '');
let gen;
try { gen = JSON.parse(rawText); } catch { console.error('✗ 输入不是合法 JSON'); process.exit(1); }
if (!gen.route_pair || !Array.isArray(gen.plans) || !gen.plans.length) {
  console.error('✗ 输入须含 route_pair 与非空 plans[]');
  process.exit(1);
}

const store = JSON.parse(readFileSync(dataPath, 'utf8'));
const now = new Date().toISOString();

gen.plans.forEach((p) => {
  if (p.ai) {
    p.ai.status = verified ? 'verified' : 'draft';
    if (verified && !p.ai.verified_at) p.ai.verified_at = now;
    if (!p.ai.generated_at) p.ai.generated_at = now;
  }
});

/* 合并：新路线对 / 追加到既有路线对 */
const rp = gen.route_pair;
const existRp = store.route_pairs.find((x) => x.route_id === rp.route_id);
if (existRp) {
  gen.plans.forEach((p) => {
    if (store.plans.some((x) => x.id === p.id)) { console.error(`✗ ${p.id} 已存在`); process.exit(1); }
    store.plans.push(p);
    existRp.plan_ids.push(p.id);
  });
  console.log(`✓ 向既有路线 ${rp.route_id} 追加 ${gen.plans.length} 个方案`);
} else {
  if (rp.route_id !== `${rp.from}-${rp.to}`) { console.error('✗ route_id 须为 from-to'); process.exit(1); }
  store.route_pairs.push({ ...rp, plan_ids: gen.plans.map((p) => p.id) });
  gen.plans.forEach((p) => store.plans.push(p));
  console.log(`✓ 新增路线 ${rp.route_id}（${gen.plans.length} 个方案）`);
}

/* 城市覆盖补齐 */
gen.plans.forEach((p) => {
  [p.from, p.to, ...p.stops.map((s) => s.city)].forEach((c) => {
    if (!store.cities.includes(c)) { store.cities.push(c); console.log(`  + 城市列表新增「${c}」`); }
  });
});

/* 合并后全库一致性 + AI 文案 */
const errors = validateStorePlans(store);
store.plans.concat(store.templates.filter((t) => !t.ref)).forEach((p) => errors.push(...validateAICopy(p.ai, p.id)));
if (errors.length) {
  console.error('✗ 合并后校验未通过，未写回：');
  errors.forEach((e) => console.error('  ✗ ' + e));
  process.exit(1);
}

writeFileSync(dataPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
console.log(`✓ 已写回 plans.json（AI 文案 status=${verified ? 'verified' : 'draft'}）`);
console.log('  下一步：node pipeline/build-mock.mjs');
