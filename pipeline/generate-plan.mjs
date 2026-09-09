/* generate-plan.mjs · 实时生成写回器：把 LLM+采集产出的新路线方案合入方案库
 * 用法：node pipeline/generate-plan.mjs --input <生成文件.json> [--verified]
 * 输入形状：{ "route_pair": { route_id, from, to, direct }, "plans": [ 存储层 Plan... ] }
 * 守门：结构一致性（validate-plan）+ AI 文案（validate-ai-copy）+ 合并后全库校验，任一不过不写回。
 * 默认 AI 文案强制 draft（人工 review 后改 verified 再上页）；--verified 表示已在会话内 review。
 * 写回成功后自动把心愿队列（wishlist.json）中对应的 pending 心愿回流为 generated（Phase 3 闭环）。
 * 核心守门在 pipeline/lib/merge-generated.mjs（collect-wish 采集执行器复用同一实现）。 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mergeGenerated } from './lib/merge-generated.mjs';
import { getWishlist, saveWishlist } from './wishlist-store.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'pipeline/data/plans.json');

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
