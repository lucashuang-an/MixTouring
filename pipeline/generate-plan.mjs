/* generate-plan.mjs · 实时生成写回器：把 LLM+采集产出的新路线方案合入方案库
 * 用法：node pipeline/generate-plan.mjs --input <生成文件.json> [--verified]
 * 输入形状：{ "route_pair": { route_id, from, to, direct }, "plans": [ 存储层 Plan... ] }
 * 守门：结构一致性（validate-plan）+ AI 文案（validate-ai-copy）+ 合并后全库校验，任一不过不写回。
 * 默认 AI 文案强制 draft（人工 review 后改 verified 再上页）；--verified 表示已在会话内 review。
 * 写回成功后自动把心愿队列（wishlist.json）中对应的 pending 心愿回流为 generated（Phase 3 闭环）。
 * 核心写回逻辑导出为 mergeGenerated（server 侧复用同一守门）。 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateStorePlans } from './lib/validate-plan.mjs';
import { validateAICopy } from './lib/validate-ai-copy.mjs';
import { getWishlist, saveWishlist } from './wishlist-store.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'pipeline/data/plans.json');

/* 三重守门合并（不写盘）：结构校验 → AI 文案校验 → 合并后全库校验。
 * @returns {{ok:boolean, errors:string[], log:string[]}} ok=false 时 store 可能已被部分合并，调用方应弃用 */
export function mergeGenerated(store, gen, { verified = false } = {}) {
  const errors = [];
  const log = [];
  if (!gen || !gen.route_pair || !Array.isArray(gen.plans) || !gen.plans.length) {
    return { ok: false, errors: ['输入须含 route_pair 与非空 plans[]'], log };
  }
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
    for (const p of gen.plans) {
      if (store.plans.some((x) => x.id === p.id)) return { ok: false, errors: [`${p.id} 已存在`], log };
      store.plans.push(p);
      existRp.plan_ids.push(p.id);
    }
    log.push(`向既有路线 ${rp.route_id} 追加 ${gen.plans.length} 个方案`);
  } else {
    if (rp.route_id !== `${rp.from}-${rp.to}`) return { ok: false, errors: ['route_id 须为 from-to'], log };
    store.route_pairs.push({ ...rp, plan_ids: gen.plans.map((p) => p.id) });
    gen.plans.forEach((p) => store.plans.push(p));
    log.push(`新增路线 ${rp.route_id}（${gen.plans.length} 个方案）`);
  }

  /* 城市覆盖补齐 */
  gen.plans.forEach((p) => {
    [p.from, p.to, ...p.stops.map((s) => s.city)].forEach((c) => {
      if (!store.cities.includes(c)) { store.cities.push(c); log.push(`城市列表新增「${c}」`); }
    });
  });

  /* 合并后全库一致性 + AI 文案（三重守门最后一道） */
  errors.push(...validateStorePlans(store));
  store.plans.concat(store.templates.filter((t) => !t.ref)).forEach((p) => errors.push(...validateAICopy(p.ai, p.id)));
  return { ok: errors.length === 0, errors, log };
}

/* CLI 入口 */
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

const store = JSON.parse(readFileSync(dataPath, 'utf8'));
const result = mergeGenerated(store, gen, { verified });
result.log.forEach((l) => console.log('✓ ' + l));
if (!result.ok) {
  console.error('✗ 合并后校验未通过，未写回：');
  result.errors.forEach((e) => console.error('  ✗ ' + e));
  process.exit(1);
}

writeFileSync(dataPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
console.log(`✓ 已写回 plans.json（AI 文案 status=${verified ? 'verified' : 'draft'}）`);

/* 心愿状态回流：队列中同路线的 pending 心愿 → generated（Phase 3 闭环） */
const rp = gen.route_pair;
const wl = getWishlist();
const hit = wl.items.find((w) => w.from === rp.from && w.to === rp.to && w.status === 'pending');
if (hit) {
  hit.status = 'generated';
  hit.generatedAt = new Date().toISOString();
  saveWishlist(wl.items);
  console.log(`✓ 心愿 ${hit.id}（${rp.from}→${rp.to}）已回流为 generated`);
}
console.log('  下一步：node pipeline/build-mock.mjs（后端模式下 plans.json 会被服务端热重载，无需重启）');
