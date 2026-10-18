/* check-context.mjs · v0.60.1 M1：上下文组装、预算裁剪与增量摘要的确定性回归。
 * 无网络、无密钥、固定时钟。运行：node server/check-context.mjs */
import assert from 'node:assert/strict';
import { buildContext, cleanSummaries, summarizeBacklog, appendSummary, summaryFingerprint, isStale, RECENT_WINDOW } from './lib/context-builder.mjs';

const fingerprint = summaryFingerprint(3, JSON.stringify({ requirements: { required_stops: ['伊宁'] }, routing: { origin: '北京', destination: '阿拉木图' } }));
const msgs = n => Array.from({ length: n }, (_, i) => ({ mid: i + 1, role: i % 2 ? 'assistant' : 'user', text: '消息' + (i + 1) }));

/* 组装：分节顺序与清单（纳入/省略/来源/估算） */
{
  const { sections, manifest } = buildContext({
    rulesVersion: 'v0.60.1', coreRules: '硬要求优先于便利。', text: '国庆去阿拉木图', conversation: { revision: 3, brief: { destination: '阿拉木图' } },
    messages: msgs(20), summaries: { items: [{ id: 'sum_1', from_mid: 1, to_mid: 4, revision: 3, condition_hash: fingerprint, text: '早期：用户确定必经伊宁[2]' }] },
    fingerprint, decisionIndex: { entries: [{ id: 'mem_1', summary: '用户选择必经伊宁' }] },
    evidenceSources: [{ url: 'https://a.example/1', title: 'A', excerpt: 'x' }, { url: 'https://a.example/1', title: 'A 重复' }, { url: 'https://b.example/2', title: 'B' }]
  });
  const ids = sections.map(s => s.id);
  assert.ok(ids.indexOf('rules') < ids.indexOf('current_conditions') && ids.indexOf('current_conditions') < ids.indexOf('user_message'),
    '组装：规则→当前条件→本轮原话顺序固定');
  assert.equal(manifest.rules_version, 'v0.60.1');
  assert.equal(manifest.trip_revision, 3);
  assert.deepEqual(manifest.source_ids, ['https://a.example/1', 'https://b.example/2'], '组装：来源按 URL 去重并登记');
  assert.ok(manifest.included_ids.includes('history_summaries'), '组装：有效摘要纳入');
  const recent = sections.find(s => s.id === 'recent_messages').body;
  assert.ok(!recent.includes('[1] ') && !recent.includes('[4] '), '组装：被摘要覆盖的早期原文不重复进入近期原文');
  assert.ok(recent.includes('[5]'), '组装：近期原文带 mid 标识');
  assert.ok(manifest.estimated_chars > 0 && manifest.estimated_chars <= manifest.budget_chars, '组装：预算估算有值且不超限');
}

/* 预算：超预算时先省略历史原文，核心三节（规则/当前条件/本轮原话）不截断 */
{
  const tiny = 600;
  const { sections, manifest } = buildContext({
    rulesVersion: 'v', coreRules: '核心规则。', text: '本轮原话', conversation: { revision: 1 },
    messages: msgs(30), summaries: { items: [] }, fingerprint, decisionIndex: { entries: [] },
    evidenceSources: Array.from({ length: 6 }, (_, i) => ({ url: 'https://e.example/' + i, title: 'E' + i, excerpt: '长'.repeat(200) })),
    budgetChars: tiny
  });
  const ids = sections.map(s => s.id);
  assert.ok(ids.includes('rules') && ids.includes('current_conditions') && ids.includes('user_message'),
    '预算：核心三节不被静默截断');
  assert.ok(manifest.gaps.length > 0 && manifest.omitted_ids.length > 0, '预算：省略项与缺口如实记录在清单');
  assert.ok(manifest.estimated_chars <= tiny + sections.find(s => s.id === 'rules').body.length + 50, '预算：估算受控');
}

/* 摘要：待摘要范围=滑出窗口且未被有效摘要覆盖；失效摘要不覆盖、不进入 prompt */
{
  const summaries = cleanSummaries({ items: [] });
  const backlog1 = summarizeBacklog(msgs(20), summaries, fingerprint);
  assert.equal(backlog1.pending.length, 20 - RECENT_WINDOW, '摘要：滑出窗口的消息进入待摘要范围');
  const withSummary = appendSummary(summaries, { fromMid: 1, toMid: 4, text: '早期摘要' }, fingerprint, 3);
  const backlog2 = summarizeBacklog(msgs(20), withSummary, fingerprint);
  assert.equal(backlog2.pending.length, 20 - RECENT_WINDOW - 4, '摘要：已覆盖范围不再重复提炼');
  const stale = appendSummary(summaries, { fromMid: 1, toMid: 4, text: '旧指纹摘要' }, summaryFingerprint(9, '{}'), 9);
  assert.equal(isStale(stale.items[0], fingerprint), true, '摘要：条件指纹不匹配即失效');
  assert.equal(summarizeBacklog(msgs(20), stale, fingerprint).pending.length, 20 - RECENT_WINDOW, '摘要：失效摘要覆盖的范围视为未摘要（不复活）');
  assert.equal(summarizeBacklog(msgs(10), withSummary, fingerprint).pending.length, 0, '摘要：未超窗口时不提炼（不每轮调用）');
}

/* 摘要失败继续：不写入则范围保留，下次重试；有效摘要仍被组装使用 */
{
  const failed = cleanSummaries({ items: [] });
  const kept = appendSummary(appendSummary(failed, { fromMid: 1, toMid: 3, text: '已验证旧摘要' }, fingerprint, 3), { fromMid: 4, toMid: 6, text: '第二批' }, fingerprint, 3);
  assert.equal(kept.items.length, 2, '摘要失败继续：已验证摘要保留');
  const { sections } = buildContext({ text: 't', conversation: { revision: 3 }, messages: msgs(20), summaries: kept, fingerprint, decisionIndex: { entries: [] }, evidenceSources: [] });
  const sum = sections.find(s => s.id === 'history_summaries').body;
  assert.ok(sum.includes('已验证旧摘要') && sum.includes('[1..3]') && sum.includes('[4..6]'), '摘要失败继续：有效摘要按出处范围进入组装');
}

console.log('✓ 上下文组装与增量摘要回归通过');
