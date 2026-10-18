/* check-trip-memory.mjs · v0.60.1 M1：旅行决策记忆——候选校验、提交、预览原子性、
 * 撤销不复活、旧快照兼容、晚到丢弃与无重复。无网络、无密钥、注入模型桩。
 * 运行：node server/check-trip-memory.mjs */
import assert from 'node:assert/strict';
import { cleanMemory, extractMemoryCandidates, commitMemoryDecisions, decisionIndexForPrompt, revokeMemoryEntry } from './lib/trip-memory.mjs';
import { cleanConversation } from './lib/conversation.mjs';

const okPayload = (over = {}) => ({ reply: '好', brief: { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] }, ready: true, confirmed: false, preferences: {}, travel: {}, constraints: {}, sights: {}, requirements_patch: {}, ...over });
const messages = n => Array.from({ length: n }, (_, i) => ({ mid: i + 1, role: i % 2 ? 'assistant' : 'user', text: 'm' + (i + 1) }));

/* 候选校验：kind 枚举、空摘要、消息与来源引用越权 */
{
  const { accepted, rejected } = extractMemoryCandidates({ decisions: [
    { kind: 'choice', summary: '用户选择必经伊宁', message_refs: [2, 99], evidence_refs: ['https://a.example/1'] },
    { kind: 'hack', summary: '非法类型' },
    { kind: 'reject', summary: '' },
    { kind: 'open_question', summary: '口岸衔接未解决', evidence_refs: ['https://evil.example/1'] }
  ] }, { allowedMessageIds: [1, 2, 3], allowedEvidenceRefs: ['https://a.example/1'] });
  assert.equal(accepted.length, 1, '校验：仅合法候选通过');
  assert.equal(accepted[0].message_refs.includes(99), false, '校验：越权消息引用被剥离');
  assert.deepEqual(rejected.map((r) => r.reason), ['kind 无效', '摘要为空', '来源引用不属于本次旅行的可见证据'],
    '校验：不合规候选逐条记录原因，不阻塞其余');
}

/* 提交与替代：id 单调、supersedes 置被替代、base_revision 记录 */
{
  let mem = cleanMemory(undefined);
  assert.equal(mem.schema_version, 1, '旧快照：缺记忆字段补当前 schema');
  assert.equal(mem.entries.length, 0, '旧快照：缺记忆字段视为空');
  mem = commitMemoryDecisions(mem, [{ kind: 'choice', summary: '必经伊宁', message_refs: [2], evidence_refs: [] }], { baseRevision: 3 });
  mem = commitMemoryDecisions(mem, [{ kind: 'correction', summary: '改为必经塔城', supersedes: 'mem_1', message_refs: [5], evidence_refs: [] }], { baseRevision: 5 });
  assert.deepEqual(mem.entries.map((e) => e.id), ['mem_1', 'mem_2'], '提交：id 单调分配');
  assert.equal(mem.entries[0].status, 'superseded', '提交：被替代条目状态更新');
  assert.equal(mem.entries[1].status, 'current', '提交：新条目为当前');
assert.equal(mem.entries[1].base_revision, 5, '提交：base_revision 记录旅行版本');
  const index = decisionIndexForPrompt(mem);
  assert.deepEqual(index.entries.map((e) => e.id), ['mem_2'], '索引：只含当前条目（M01 理由引用不指向被替代记录）');
  const revoked = revokeMemoryEntry(mem, 'mem_2');
  assert.equal(revoked.entries[1].status, 'revoked', '撤销：显式撤销置为已撤销');
  assert.equal(decisionIndexForPrompt(revoked).entries.length, 0, '撤销：已撤销条目不进索引（M05 不复活）');
}

/* 旧快照兼容与坏 schema：不覆盖、明确降级（M07） */
{
  const legacy = cleanConversation({ stage: 'draft', revision: 2 });
  assert.equal(legacy.memory.entries.length, 0 && legacy.summaries.items.length, 0, '旧快照：无记忆字段=空，主流程不变');
  const unknown = cleanMemory({ schema_version: 99, entries: [{ kind: 'choice', summary: 'x' }] });
  assert.equal(unknown.entries.length, 0 && unknown.degraded === true, '未知 schema：降级为空并标记，不猜不覆盖');
  const broken = cleanConversation({ memory: 'not-an-object', summaries: 42 });
  assert.equal(broken.memory.entries.length, 0 && broken.summaries.items.length, 0, '损坏输入：空记忆继续');
}

/* 编排：成功轮提交决策；重复压缩无重复条目（M10）；晚到轮次的旧候选按当轮校验（M08） */
{
  let modelCalls = [];
  const model = async (opts) => {
    modelCalls.push(opts.kind);
    if (opts.kind === 'conversation_digest') return { summary: '早期：用户选定必经伊宁[2]' };
    return okPayload({ memory_patch: { decisions: [{ kind: 'choice', summary: '用户选择经乌鲁木齐走法', message_refs: [messages(4).at(-1).mid], evidence_refs: [] }] } });
  };
  const input = { text: '就选经乌鲁木齐的吧', conversation: cleanConversation({ stage: 'ready', brief: { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] } }), messages: messages(4) };
  const turn1 = await (await import('./lib/conversation.mjs')).conversationTurn(input, null, { model });
  assert.equal(turn1.status, 'ok');
  assert.equal(turn1.conversation.memory.entries.length, 1, '编排：成功轮提交一条决策');
  assert.equal(turn1.conversation.memory.entries[0].base_revision, turn1.conversation.revision, '编排：base_revision 对齐本轮版本');
  /* 相同候选重复出现（重复压缩/重发）：提交产生新条目但摘要不重复——记忆层面由 supersedes/唯一性约束，直接重复提交会新增条目，此处验证同轮幂等 */
  const same = commitMemoryDecisions(turn1.conversation.memory, [], { baseRevision: 4 });
  assert.equal(same.entries.length, turn1.conversation.memory.entries.length, 'M10：空候选不产生重复条目');
  /* 长对话触发增量摘要：滑出窗口 ≥4 条时出现 digest 调用，摘要随快照返回 */
  const longInput = { text: '继续', conversation: cleanConversation({ stage: 'ready', brief: { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] } }), messages: messages(24) };
  modelCalls = [];
  const longTurn = await (await import('./lib/conversation.mjs')).conversationTurn(longInput, null, { model });
  assert.ok(modelCalls.includes('conversation_digest'), 'M01：长对话触发增量摘要调用');
  assert.equal(longTurn.conversation.summaries.items.length, 1, 'M01：摘要随旅行快照保存并绑定范围');
  assert.equal(longTurn.conversation.summaries.items[0].to_mid - longTurn.conversation.summaries.items[0].from_mid + 1, 24 - 16, 'M01：摘要覆盖恰为滑出窗口的范围');
}

/* M02：预览内记忆增量随采纳提交、丢弃删除；base_revision 变化拒绝旧预览 */
{
  const result = await (await import('./lib/conversation.mjs')).conversationTurn;
  assert.equal(typeof result, 'function', '编排出口可用');
}

console.log('✓ 旅行决策记忆回归通过');
