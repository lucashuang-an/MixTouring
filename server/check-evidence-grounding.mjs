/* check-evidence-grounding.mjs · v0.60.1 R1-B：结论与证据关联——提问帖不是答案、背景介绍
 * 不证明航线、反向/旧资料不支持当期正向；合法探索与有出处经验仍可输出。
 * 无网络、无密钥、注入模型桩。运行：node server/check-evidence-grounding.mjs */
import assert from 'node:assert/strict';
import { conversationTurn, cleanConversation } from './lib/conversation.mjs';
import { buildEvidenceCatalog, validateEvidenceClaims, isQuestionSource, textDirection } from './lib/evidence-grounding.mjs';

const brief = { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] };
const routing = { origin: '北京', destination: '阿拉木图' };
const messages = n => Array.from({ length: 4 }, (_, i) => ({ mid: i + 1, role: i % 2 ? 'assistant' : 'user', text: 'm' + (i + 1) }));
const payload = over => ({ reply: '继续保留条件。', brief, ready: true, confirmed: false, requirements_patch: {}, ...over });

/* 纯函数层:问句判定/方向判定 */
assert.equal(isQuestionSource({ title: '有人问伊宁到阿拉木图怎么坐车吗', excerpt: '求攻略' }), true, '问句帖判定');
assert.equal(isQuestionSource({ title: '伊宁到阿拉木图国际客运班车恢复运行', excerpt: '班车恢复运行' }), false, '肯定运营陈述不判为问句');
assert.equal(textDirection('伊宁出发，抵达阿拉木图', '伊宁', '阿拉木图'), 'AB', '正向方向判定');
assert.equal(textDirection('阿拉木图出发，抵达伊宁', '伊宁', '阿拉木图'), 'BA', '反向方向判定');
assert.equal(textDirection('无关内容', '伊宁', '阿拉木图'), null, '无两端不判方向');

/* R1-B 合法放行(纯函数层):近期非问句正向来源+合法标注 → grounded,不进纠正 */
{
  const cat = buildEvidenceCatalog({ sources: [{ title: '伊宁到阿拉木图国际客运班车恢复运行', url: 'https://www.xiaohongshu.com/explore/ok1', content: '伊宁到阿拉木图国际客运班车恢复运行，具体班次待确认', date: '2026-10-15', kind: 'experience', platform: '小红书', read_status: 'page_excerpt' }], routing, now: Date.parse('2026-10-20T00:00:00Z') });
  const v = validateEvidenceClaims('来源显示伊宁到阿拉木图国际客运班车恢复运行 [ev_1]，班次仍需按日期确认。', cat, { routing, text: '伊宁到阿拉木图现在有班车吗' });
  assert.equal(v.rejected.length, 0, 'R1-B:合法标注零拒绝');
  assert.equal(v.grounded.length, 1, 'R1-B:合法标注进入 grounded');
  const undated = buildEvidenceCatalog({ sources: [{ title: '伊宁到阿拉木图班车', url: 'https://www.xiaohongshu.com/explore/u1', content: '伊宁到阿拉木图班车', kind: 'experience', platform: '小红书', read_status: 'search_excerpt' }], routing, now: Date.parse('2026-10-20T00:00:00Z') });
  assert.equal(undated.entries[0].temporal_state, 'undated', 'R1-B:无日期来源标记 undated');
}

/* 纯函数层:validateEvidenceClaims 直接断言四类拒绝原因 */
{
  const mk = (url, title, excerpt, date, state) => ({ id: 'ev_1', url, title, kind: 'guide', question_like: isQuestionSource({ title, excerpt }), direction: null, temporal_state: state || 'recent', date_scope: 'unverified', read_status: 'page_excerpt', allowed_use: 'source_reference', excerpt });
  const cat = entries => ({ entries });
  const v1 = validateEvidenceClaims('有人问过怎么坐车，班车是有的 [ev_1]。', cat([mk('u', '有人问怎么坐车', '求攻略')]), { routing, text: 'x' });
  assert.ok(v1.rejected.some((r) => r.reason === '提问帖不是已获答案'), 'R1-B:提问帖不能支持运营结论');
  const v2 = validateEvidenceClaims('北京到阿拉木图有直飞航班。', cat([mk('u', '阿拉木图国际机场介绍', '阿拉木图国际机场是哈萨克斯坦最大机场')]), { routing, text: 'x' });
  assert.ok(v2.rejected.some((r) => r.reason === '反向资料不支持该方向结论' || r.reason === '提问帖不是已获答案' || r.reason === '来源时效不足以支持当期运营结论' || r.reason.includes('来源')), 'R1-B:背景/方向不符的机场介绍不支持航线结论');
  const v3 = validateEvidenceClaims('伊宁到阿拉木图有班车 [ev_1]。', cat([mk('u', '阿拉木图到伊宁班车', '阿拉木图发车抵达伊宁')]), { routing, text: 'x' });
  assert.ok(v3.rejected.some((r) => r.reason === '反向资料不支持该方向结论'), 'R1-B:反向资料不支持正向结论');
  const v4 = validateEvidenceClaims('伊宁到阿拉木图目前有班车 [ev_1]。', cat([mk('u', '旧帖', '伊宁到阿拉木图班车', '2023-01-01', 'historical')]), { routing, text: 'x' });
  assert.ok(v4.rejected.some((r) => r.reason === '来源时效不足以支持当期运营结论'), 'R1-B:旧资料不支持当期结论');
  const v0 = validateEvidenceClaims('伊宁到阿拉木图有班车。', cat([]), { routing, text: 'x' });
  assert.ok(v0.rejected.some((r) => r.reason === '运营结论缺少来源标注'), 'R1-B:未标注的运营断言拒绝');
}

/* 一般讨论不误拦 */
{
  const r = await conversationTurn({ text: '伊宁有什么好玩的', action: 'chat',
    conversation: cleanConversation({ stage: 'draft', brief, routing, draft: { title: 't', overview: 'o', route: ['北京', '阿拉木图'], cards: [{ id: 'card-x', place: '阿拉木图', label: '第1天', title: '城区', content: 'x' }], sections: [], pending: [] } }), messages: messages(4) }, null,
    { now: Date.parse('2026-10-20T00:00:00Z'), search: async () => [], model: async () => payload({ reply: '喀赞其和六星街适合慢逛，草原建议单独安排一天。' }) });
  assert.equal(r.status, 'ok', 'R1-B:一般讨论正常完成');
  assert.ok(r.reply.includes('喀赞其'), 'R1-B:玩法建议保留');
}

console.log('✓ 结论与证据关联回归通过');
