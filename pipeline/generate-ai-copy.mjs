/* generate-ai-copy.mjs · AI 文案工厂脚手架（离线，方案库Schema §4.5）
 * 用法：
 *   node pipeline/generate-ai-copy.mjs            → 为缺文案/非 verified 方案生成 LLM prompt（pipeline/out/ai-copy-prompts.json）
 *   node pipeline/generate-ai-copy.mjs --generate → LLM 直连逐条生成（需 LLM_API_KEY，复用 server/lib/llm.mjs），
 *                                                    产出过防幻觉守门后才写回 plans.json（status=draft）
 *   node pipeline/generate-ai-copy.mjs --apply <llm-output.json>
 *                                                 → 校验并写回 plans.json（status=draft，人工 review 后改 verified 再跑 build）
 * LLM 产出格式：[{ "id": "p-xxx", "ai": { "summary": "...", "fit": "...", "notice": "...", "play_intro": "..." } }]
 * 铁律：文案中的数字只允许以白名单占位符出现；写回前模拟插值，残留占位符即拒绝。 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateAICopy, WHITELIST_RE } from './lib/validate-ai-copy.mjs';
import { aiValues, interpolate } from './lib/derive.mjs';
import { callJson, llmConfigured, llmModel } from '../server/lib/llm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'pipeline/data/plans.json');
const store = JSON.parse(readFileSync(dataPath, 'utf8'));

const FIELDS = ['summary', 'fit', 'notice', 'play_intro'];

const PLACEHOLDER_DOC = `
可用占位符（文案中的一切数字必须来自占位符，禁止手写任何阿拉伯数字）：
  {saved} 比直飞省的钱（如 ¥1,295）  {price_min}/{price_max} 总价区间  {price_mid} 总价中值
  {total_time} 全程耗时（如 23h17m）  {direct_price} 直飞基准价  {from}/{to} 起终点城市
  {transfer_city_N} 第 N 个中转城市  {wait_min_N} 第 N 个中转停留时长（如 1h53m）
  {transfer_min_1} 首个接驳耗时（分钟，纯数字）  {transfer_km_1} 首个接驳距离（公里，纯数字）
（N 从 1 开始；没有第 2 个中转的方案不要用 _2）`.trim();

function planFacts(plan) {
  return {
    id: plan.id, from: plan.from, to: plan.to,
    stops: plan.stops, segs: plan.segs.map((s) => ({
      mode: s.mode, from_station: s.from_station, to_station: s.to_station,
      dep: s.dep, arr: s.arr, duration_min: s.duration_min,
      fixed_price: s.fixed_price, price_band: s.price_band
    })),
    risks: plan.risks, play: plan.play || null
  };
}

const SCHEMA_PROMPT = [
  '你是 MixTouring 的路线文案编辑。根据给定的方案结构化事实，输出 4 段中文文案。',
  '语气：像走过这条路的朋友，具体、克制、不夸张；禁止emoji；每段不超过 60 字。',
  '铁律：文案中禁止出现任何阿拉伯数字（占位符除外），一切数字必须用占位符表达。',
  PLACEHOLDER_DOC,
  '',
  '输出 JSON：{ "summary": "一句话卖点（列表卡片用，必带 {saved} 或 {price_mid}）",',
  '  "fit": "适合谁 / 不适合谁",',
  '  "notice": "最重要的一个衔接提醒（引用真实占位符数据）",',
  '  "play_intro": "中转城市玩法的引子（无 play 数据则围绕等候打发时间）" }'
].join('\n');

function buildPrompt(plan) {
  return {
    id: plan.id,
    prompt: SCHEMA_PROMPT + '\n\n方案事实：' + JSON.stringify(planFacts(plan), null, 2)
  };
}

/* ---------- apply：校验 LLM 产出并写回 ---------- */

function findPlan(id) {
  return store.plans.find((p) => p.id === id) || store.templates.find((t) => t.id === id && !t.ref) || null;
}

function derivedOf(plan) {
  const rp = (store.route_pairs || []).find((r) => r.route_id === plan.route_id);
  return { plan, direct: rp ? rp.direct : null };
}

function applyItems(items) {
  const errors = [];
  const now = new Date().toISOString();
  items.forEach((item) => {
    const plan = findPlan(item.id);
    if (!plan) { errors.push(`${item.id}: 方案不存在`); return; }
    errors.push(...validateAICopy(item.ai, item.id));
    /* 模拟插值：残留占位符 / 无值占位符都拒绝 */
    const rp = derivedOf(plan);
    const values = aiValues(rp.plan, {
      total_min: 0,
      price: { min: 0, max: 0, mid: 0, saved: 0 },
      direct: rp.direct
    });
    for (const f of FIELDS) {
      const text = item.ai && item.ai[f];
      if (typeof text !== 'string') continue;
      const out = interpolate(text, values);
      const left = out.match(/\{[a-z_0-9]+\}/g);
      if (left) errors.push(`${item.id}.ai.${f}: 占位符 ${left.join(',')} 无对应数据值`);
    }
  });
  if (errors.length) return errors;

  items.forEach((item) => {
    const plan = findPlan(item.id);
    plan.ai = {
      summary: item.ai.summary, fit: item.ai.fit, notice: item.ai.notice, play_intro: item.ai.play_intro,
      status: 'draft', model: item.model || 'unknown', generated_at: now, verified_at: null
    };
  });
  writeFileSync(dataPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return [];
}

/* ---------- 主流程 ---------- */

const applyIdx = process.argv.indexOf('--apply');
if (applyIdx > -1) {
  const file = process.argv[applyIdx + 1];
  if (!file) { console.error('✗ --apply 需要文件路径'); process.exit(1); }
  const rawText = readFileSync(resolve(root, file), 'utf8').replace(/^\uFEFF/, '');
  let items;
  try { items = JSON.parse(rawText); } catch { console.error('✗ LLM 产出不是合法 JSON'); process.exit(1); }
  if (!Array.isArray(items)) { console.error('✗ LLM 产出须为数组'); process.exit(1); }
  const errors = applyItems(items);
  if (errors.length) {
    console.error('✗ 校验未通过，未写回：');
    errors.forEach((e) => console.error('  ✗ ' + e));
    process.exit(1);
  }
  console.log(`✓ 已写回 ${items.length} 份文案（status=draft）。人工 review 后将 status 改为 verified，再跑 node pipeline/build-mock.mjs`);
  process.exit(0);
}

const pending = [...store.plans, ...store.templates.filter((t) => !t.ref)]
  .filter((p) => !p.ai || p.ai.status !== 'verified');

/* ---------- --generate：LLM 直连生成（Phase 2 触点②，逐条过防幻觉守门后才写回） ---------- */

const genIdx = process.argv.indexOf('--generate');
if (genIdx > -1) {
  if (!pending.length) { console.log('✓ 全部方案均有 verified 文案，无需生成'); process.exit(0); }
  if (!llmConfigured()) { console.error('✗ LLM_API_KEY 未配置，无法在线生成（离线守门校验仍可用：--apply）'); process.exit(1); }
  const items = [];
  for (const plan of pending) {
    console.log('· 生成 ' + plan.id + ' …');
    const out = await callJson({ schema_prompt: SCHEMA_PROMPT, user: '方案事实：' + JSON.stringify(planFacts(plan)) });
    if (!out || typeof out !== 'object') {
      console.error('✗ LLM 未返回有效 JSON，中止；已生成 ' + items.length + ' 份未写盘');
      process.exit(1);
    }
    items.push({ id: plan.id, ai: out, model: llmModel() });
  }
  const errors = applyItems(items);
  if (errors.length) {
    console.error('✗ 防幻觉守门未通过，全部未写盘：');
    errors.forEach((e) => console.error('  ✗ ' + e));
    process.exit(1);
  }
  console.log(`✓ 已生成并写回 ${items.length} 份（status=draft）。人工 review 后改 verified，再跑 node pipeline/build-mock.mjs`);
  process.exit(0);
}

if (!pending.length) {
  console.log('✓ 全部方案均有 verified 文案，无需生成');
  process.exit(0);
}

const outDir = join(root, 'pipeline/out');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'ai-copy-prompts.json');
writeFileSync(outFile, JSON.stringify(pending.map(buildPrompt), null, 2) + '\n', 'utf8');
console.log(`✓ 已生成 ${pending.length} 份 prompt → ${outFile}`);
console.log('  逐条喂给 LLM，收集产出后：node pipeline/generate-ai-copy.mjs --apply <产出.json>');
