/* 旅行决策记忆（v0.60.1 M1）：模型只返回候选增量；代码校验字段、消息引用、来源归属与
 * base_revision 后提交。决策随旅行快照保存，不复制可独立修改的权威条件值。
 * 旧快照缺少记忆字段视为空；未知更高 schema 保持空并标记降级，不猜不覆盖。 */

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_KINDS = ['choice', 'reject', 'correction', 'open_question'];
const KIND_LABEL = { choice: '选择', reject: '拒绝', correction: '纠正', open_question: '未解决问题' };
const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';

/** 旧快照/非法输入→空记忆；更高 schema 降级为空且保留提示，不覆盖原文（M07）。 */
export function cleanMemory(raw = {}, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyMemory();
  if (raw.schema_version == null) return emptyMemory();
  if (raw.schema_version !== MEMORY_SCHEMA_VERSION) {
    return { ...emptyMemory(), degraded: true, stored_schema_version: raw.schema_version,
      unrecognized:structuredClone(raw),degraded_note: '记忆数据使用了未识别的格式版本，本轮以空记忆继续；原文未覆盖。' };
  }
  if(raw.degraded)return {...emptyMemory(),degraded:true,stored_schema_version:raw.stored_schema_version,
    unrecognized:structuredClone(raw.unrecognized),degraded_note:raw.degraded_note};
  const entries = Array.isArray(raw.entries) ? raw.entries.map((e, i) => cleanEntry(e, i, now)).filter(Boolean) : [];
  return { schema_version: MEMORY_SCHEMA_VERSION, entries, next_id: validId(raw.next_id, entries) };
}
function emptyMemory() { return { schema_version: MEMORY_SCHEMA_VERSION, entries: [], next_id: 1 }; }
function validId(v, entries) {
  const fromEntries = entries.reduce((max, e) => Math.max(max, Number(String(e.id || '').replace(/^mem_/, '')) || 0), 0);
  const n = Number.isSafeInteger(v) && v > fromEntries ? v : fromEntries + 1;
  return n;
}
function cleanEntry(e, i, now) {
  if (!e || typeof e !== 'object') return null;
  if (!MEMORY_KINDS.includes(e.kind) || !str(e.summary, 400)) return null;
  return {
    id: /^mem_\d+$/.test(String(e.id)) ? e.id : 'mem_' + (i + 1),
    kind: e.kind,
    summary: str(e.summary, 300),
    message_refs: Array.isArray(e.message_refs) ? e.message_refs.filter(Number.isSafeInteger).slice(0, 8) : [],
    evidence_refs: Array.isArray(e.evidence_refs) ? e.evidence_refs.filter(u => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 4) : [],
    status: ['current', 'superseded', 'revoked'].includes(e.status) ? e.status : 'current',
    supersedes: /^mem_\d+$/.test(String(e.supersedes)) ? e.supersedes : null,
    base_revision: Number.isSafeInteger(e.base_revision) ? e.base_revision : 0,
    created_at: typeof e.created_at === 'string' ? e.created_at : new Date(now).toISOString(),
    updated_at: typeof e.updated_at === 'string' ? e.updated_at : new Date(now).toISOString()
  };
}

/** 模型候选 → 可提交增量。逐条校验：kind 枚举、摘要有内容、消息引用必须是真实 mid、
 *  来源引用必须属于本轮证据（同旅行可见来源）；不合规候选丢弃并记录原因，不阻塞其余。 */
export function extractMemoryCandidates(rawPatch, { userMessages = [], currentMessageId = null, allowedEvidenceRefs = [] } = {}) {
  const list = Array.isArray(rawPatch?.decisions) ? rawPatch.decisions : [];
  const accepted = [], rejected = [];
  const messages = new Set(userMessages.filter(m=>m?.role==='user' && Number.isSafeInteger(m.mid)).map(m=>m.mid)), evidence = new Set(allowedEvidenceRefs);
  for (const raw of list.slice(0, 4)) {
    const kind = raw?.kind;
    const summary = str(raw?.summary, 300);
    if (!MEMORY_KINDS.includes(kind)) { rejected.push({ reason: 'kind 无效', summary }); continue; }
    if (!summary) { rejected.push({ reason: '摘要为空', summary }); continue; }
    const message_refs = (Array.isArray(raw.message_refs) ? raw.message_refs : []).filter(id => messages.has(id)).slice(0, 8);
    if (!message_refs.length || currentMessageId!==null && !message_refs.includes(currentMessageId)) { rejected.push({ reason: '缺少本次用户明确表达的消息出处', summary }); continue; }
    const evidence_refs = (Array.isArray(raw.evidence_refs) ? raw.evidence_refs : []).filter(u => evidence.has(u)).slice(0, 4);
    if (Array.isArray(raw.evidence_refs) && raw.evidence_refs.length && !evidence_refs.length) { rejected.push({ reason: '来源引用不属于本次旅行的可见证据', summary }); continue; }
    accepted.push({ kind, summary, message_refs, evidence_refs, supersedes: /^mem_\d+$/.test(String(raw.supersedes)) ? raw.supersedes : null });
  }
  return { accepted, rejected };
}

/** 提交候选增量：分配 id、记录 base_revision；supersedes 指向的条目置为被替代。
 *  旅行状态与记忆增量在同一状态转换中生效——调用方在成功路径一次性写入 next.memory。 */
export function commitMemoryDecisions(memory, candidates, { baseRevision = 0, now = Date.now() } = {}) {
  const next = cleanMemory(memory, { now });
  if(next.degraded)return next;
  const byId = new Map(next.entries.map(e => [e.id, e]));
  for (const c of candidates) {
    // 重试同一用户消息不重复建立决策，已撤销条目也不能被重发复活。
    if(next.entries.some(e=>e.kind===c.kind && e.summary===c.summary && JSON.stringify(e.message_refs)===JSON.stringify(c.message_refs)))continue;
    if (c.supersedes && byId.has(c.supersedes)) {
      const old = byId.get(c.supersedes);
      if (old.status === 'current') { old.status = 'superseded'; old.updated_at = new Date(now).toISOString(); }
    }
    const entry = {
      id: 'mem_' + next.next_id, kind: c.kind, summary: c.summary,
      message_refs: c.message_refs, evidence_refs: c.evidence_refs,
      status: 'current', supersedes: c.supersedes || null,
      base_revision: baseRevision, evidence_use:'decision_reference_only',created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString()
    };
    byId.set(entry.id, entry); next.entries.push(entry); next.next_id += 1;
  }
  return next;
}

/** 供模型引用的当前决策索引（只含 current；摘要/理由可指向 id，不复制权威条件值）。 */
export function decisionIndexForPrompt(memory, userMessages) {
  const userIds=userMessages && new Set(userMessages.filter(m=>m.role==='user').map(m=>m.mid));
  const entries = (memory?.entries || []).filter(e => e.status === 'current')
    .filter(e=>!userIds || e.message_refs.some(id=>userIds.has(id)))
    .map(e => ({ id: e.id, kind: KIND_LABEL[e.kind] || e.kind, summary: e.summary,
      message_refs: e.message_refs, evidence_refs: e.evidence_refs, evidence_use:'decision_reference_only',base_revision: e.base_revision }));
  return { count: entries.length, entries };
}

/** 撤销/恢复：条目 id 显式置为已撤销（用户明确撤销某决策时使用；随旅行快照保存）。 */
export function revokeMemoryEntry(memory, id, { now = Date.now() } = {}) {
  const next = cleanMemory(memory, { now });
  const entry = next.entries.find(e => e.id === id);
  if (entry && entry.status === 'current') { entry.status = 'revoked'; entry.updated_at = new Date(now).toISOString(); }
  return next;
}
