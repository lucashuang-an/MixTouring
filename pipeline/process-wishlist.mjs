/* process-wishlist.mjs · 心愿单离线处理框架（v0.4.5）
 * 用法：node pipeline/process-wishlist.mjs [--generate]
 * 默认：列出所有 pending 心愿，输出 gen-prompts.json（供 LLM/人工生成）
 * --generate：对每条 pending 调用 generate-plan.mjs 的占位流程（目前仅打印模拟步骤，不真跑爬虫）
 * 生成后需人工 review 生成文件，再 --apply --verified 写回方案库。 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getWishlist, saveWishlist } from './wishlist-store.mjs';
import { geoPromptBlock } from './lib/geo-skill.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const store = JSON.parse(readFileSync(join(root, 'data/plans.json'), 'utf8'));

function routeExists(from, to) {
  return store.route_pairs.some((rp) => rp.route_id === `${from}-${to}`);
}

const doGenerate = process.argv.includes('--generate');
const wl = getWishlist();
const pending = wl.items.filter((w) => w.status === 'pending');

if (!pending.length) { console.log('✓ 暂无 pending 心愿'); process.exit(0); }

if (!doGenerate) {
  const prompts = pending.map((w) => ({
    wish_id: w.id, from: w.from, to: w.to, date: w.date,
    prompt: `生成 ${w.from} → ${w.to} 的火车×飞机混搭方案。要求：至少 1 个混搭 + 1 个直达火车或飞机对照；所有价格须来自真实网络采样并标注来源； stops/segs/risks 必须符合 MixTouring 方案库 Schema；AI 文案中的数字只能以 {saved}/{price_mid}/{total_time}/{wait_min_1}/{transfer_min_1}/{transfer_km_1} 等占位符出现。\n${geoPromptBlock(w.from, w.to)}`,
    route_exists_now: routeExists(w.from, w.to)
  }));
  const out = join(root, 'out/gen-prompts.json');
  writeFileSync(out, JSON.stringify(prompts, null, 2) + '\n', 'utf8');
  console.log(`✓ ${pending.length} 个 pending 心愿已输出 → ${out}`);
  console.log('  把这些 prompt 交给 LLM/人工生成后，保存为 out/gen-<route>.json，再运行：');
  console.log('  node pipeline/generate-plan.mjs --input out/gen-<route>.json --verified');
  console.log('  node pipeline/build-mock.mjs');
  process.exit(0);
}

/* --generate 模拟：不真跑爬虫，只做状态流转演示 */
console.log(`▶ 模拟处理 ${pending.length} 个 pending 心愿（不调用真实爬虫）：`);
pending.forEach((w) => {
  console.log(`  · ${w.from} → ${w.to}（${w.date}）`);
  w.status = 'generated';
  w.generatedAt = new Date().toISOString();
  w.simulated = true;
});
saveWishlist(wl.items);
console.log('✓ 已把 pending 心愿标记为 generated（模拟模式）');
console.log('  注意：实际生产环境这里应调用浏览器采集 + LLM 生成，输出 gen 文件并经人工 review 后写回。');
