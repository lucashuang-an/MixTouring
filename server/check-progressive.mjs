/* 验证慢搜索、取消和预算不会让首批走法失效。 */
import assert from 'node:assert/strict';
import { progressivePlan } from './lib/progressive.mjs';
import { buildJourneyDetail } from './lib/journey.mjs';
const events = [];
let searches = 0;
const result = await progressivePlan({ origin: '北京', destination: '阿拉木图' }, (data, phase) => {
  events.push({ data, phase });
  if (phase === 'base') assert.equal(searches, 0, '搜索前已有首批结果');
}, {
  env: { LLM_API_KEY: 'test', WEB_SEARCH_AVAILABLE: '1' },
  searchWeb: async () => { searches++; return null; }, callJson: async () => null
});
assert.deepEqual(events.map((e) => e.phase), ['base', 'complete']);
const key = (c) => JSON.stringify(c.legs.map((l) => [l.from, l.to, l.mode_guess, l.via || '']));
for (const initial of events[0].data.candidates) {
  const retained = result.candidates.find((c) => key(c) === key(initial));
  assert.ok(retained, '已展示的规则候选仍可选择');
  assert.equal(buildJourneyDetail(result, retained.id).evidence_state, 'explore');
}
assert.ok(result.discovery_metrics.search_calls <= 14);
assert.equal(new Set(result.candidates.map((c) => c.id)).size, result.candidates.length);
const timed = await progressivePlan({ origin: '北京', destination: '喀什' }, () => {}, {
  budgetMs: 20, env: { LLM_API_KEY: 'test', WEB_SEARCH_AVAILABLE: '1' },
  searchWeb: async () => new Promise((r) => setTimeout(() => r(null), 60)), callJson: async () => null
});
assert.equal(timed.discovery_metrics.budget_exhausted, true);
assert.ok(timed.candidates.length);
const controller = new AbortController(), cancelled = [];
await progressivePlan({ origin: '北京', destination: '喀什' }, (_, phase) => { cancelled.push(phase); controller.abort(); }, {
  env: { LLM_API_KEY: 'test', WEB_SEARCH_AVAILABLE: '1' },
  searchWeb: async () => { throw new Error('取消后不应调用搜索'); }, callJson: async () => null
}, controller.signal);
assert.deepEqual(cancelled, ['base']);
let quotaCalls = 0;
const quota = await progressivePlan({ origin: '北京', destination: '阿拉木图' }, () => {}, {
  env: { LLM_API_KEY: 'test', WEB_SEARCH_AVAILABLE: '1' },
  searchWeb: async () => { quotaCalls++; return null; },
  searchStatus: () => ({ status: 'quota_exhausted' }), callJson: async () => null
});
/* 额度不足：骨架段与发现搜索并行发出（v0.44.0），quota 状态确认后不再追加新查询；
 * 上界=首轮并行窗口（骨架段 ≤5 + 发现 2 + 余量），第二轮（合并后新段）必须为 0。 */
assert.ok(quotaCalls <= 8, '额度不足后应停止本轮追加搜索（首轮并行窗口除外）');
assert.ok(quota.candidates.length, '额度不足后仍保留探索结果');
console.log('✓ 渐进规划：首批结果、候选保留、详情、调用预算、超时与取消通过');
