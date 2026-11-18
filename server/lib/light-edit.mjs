import { agentPrompt } from './agent-prompts.mjs';
import { buildContext } from './context-builder.mjs';

export const ITINERARY_REVIEW_MODE = ['strict','light'].includes(process.env.MT_ITINERARY_REVIEW)?process.env.MT_ITINERARY_REVIEW:'final';

export function deliveryReviewMode({ action, requiresDatedEvidence, mode = ITINERARY_REVIEW_MODE }) {
  if(mode==='final')return 'final';
  return action === 'generate' && !requiresDatedEvidence && mode === 'light' ? 'light' : 'strict';
}

function editableFields(draft) {
  return [
    { key: 'overview', owner: draft, field: 'overview' },
    ...(draft.sections || []).map((owner, index) => ({ key: `section.${index}.content`, owner, field: 'content' })),
    ...draft.cards.flatMap(owner => ['title', 'content'].map(field => ({ key: owner.id + '.' + field, owner, field, cardId: owner.id })))
  ].map(target => ({ ...target, original: target.owner[target.field], patches: [] }));
}

// 位置始终相对于原稿，避免补丁命中刚生成的文字。检查失败只撤销当前补丁。
function applyPatch(target, patch, draft, validate) {
  const previous = target.owner[target.field];
  const patches = [...target.patches, patch].sort((a, b) => b.start - a.start);
  let text = target.original;
  for (const change of patches) text = text.slice(0, change.start) + change.text + text.slice(change.end);
  target.owner[target.field] = text;
  try {
    if (!validate(draft)) { target.owner[target.field] = previous; return false; }
  } catch (error) {
    target.owner[target.field] = previous;
    if (error.code === 'RUN_INTERRUPTED' || error.name === 'AbortError') throw error;
    return false;
  }
  target.patches.push(patch);
  return true;
}

export async function editItinerary({ draft, current, messages = [], catalog, model, validate, signal, budgetChars }) {
  const original = structuredClone(draft);
  const fallback = reason => ({ draft: structuredClone(draft), status: 'unreviewed', issues: [], reason, applied: 0, skipped: 0 });
  const fields = editableFields(original);
  const userMessages = messages.filter(message => message.role === 'user');
  const schema_prompt = agentPrompt('conversation.light_edit');
  try {
    if (signal?.aborted) throw signal.reason;
    const built = buildContext({
      payload: {
        current, user_messages: userMessages,
        days: original.cards.map(({ id, place, label }) => ({ id, place, label })),
        fields: fields.map(target => ({ key: target.key, text: target.original, ...(target.cardId ? { city: target.owner.place, day: target.owner.label } : {}) })),
        evidence_catalog: { entries: (catalog?.entries || []).map(({ id, title, excerpt }) => ({ id, title, excerpt })) }
      },
      coreRules: schema_prompt, budgetChars
    });
    const request = { kind: 'conversation_light_edit', schema_prompt, user: JSON.stringify(built.value), timeoutMs: 20000, signal };
    let raw = await model(request);
    if (raw && (!Array.isArray(raw.edits) || !Array.isArray(raw.unresolved))) {
      raw = await model({ ...request, user: JSON.stringify({ ...built.value, validation_error: {
        expected_fields: ['edits', 'unresolved'], received_fields: Object.keys(raw)
      } }) });
    }
    if (signal?.aborted) throw signal.reason;
    if (!Array.isArray(raw?.edits) || !Array.isArray(raw?.unresolved)) return fallback('invalid_response');
    const cardIds = new Set(original.cards.map(card => card.id));
    if (raw.unresolved.some(item => !item || typeof item.reason !== 'string' || !item.reason.trim() ||
      !Array.isArray(item.card_ids) || item.card_ids.some(id => !cardIds.has(id)))) return fallback('invalid_issues');

    const visibleSources = new Set((built.value.evidence_catalog?.entries || []).map(entry => entry.id));
    const rejected = [];
    let applied = 0;
    for (const edit of raw.edits) {
      if (signal?.aborted) throw signal.reason;
      if (edit && typeof edit.old === 'string' && typeof edit.new === 'string' && edit.old.trim() === edit.new.trim()) continue;
      const target = fields.find(field => field.key === edit?.key);
      let reason = null;
      if (!target || typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string' || !edit.new.trim() || edit.new.length > 2000) reason = 'invalid_field';
      else if (!['interest', 'correction'].includes(edit.kind)) reason = 'invalid_kind';
      else if (!Array.isArray(edit.source_ids) || edit.source_ids.some(id => !visibleSources.has(id))) reason = 'invalid_source';
      else if (edit.kind === 'interest') {
        const quoted = typeof edit.interest_quote === 'string' && edit.interest_quote.trim() &&
          userMessages.some(message => message.text.includes(edit.interest_quote));
        const referenced = Number.isSafeInteger(edit.interest_message_id) &&
          userMessages.some(message => message.mid === edit.interest_message_id);
        if (!edit.source_ids.length) reason = 'missing_interest_source';
        else if (!quoted && !referenced) reason = 'missing_interest_reference';
      }
      if (reason) { rejected.push({ key: edit?.key, reason }); continue; }

      const start = target.original.indexOf(edit.old);
      const end = start + edit.old.length;
      if (start < 0 || target.original.indexOf(edit.old, start + 1) >= 0) reason = 'ambiguous_original';
      else if (target.patches.some(patch => start < patch.end && end > patch.start)) reason = 'overlapping_edit';
      else if (!applyPatch(target, { start, end, text: edit.new }, original, validate)) reason = 'validation_failed';
      if (reason) rejected.push({ key: edit.key, reason });
      else applied++;
    }
    const issues = raw.unresolved.map(item => ({ code: 'editorial_gap', card_ids: item.card_ids, reason: item.reason }));
    return { draft: original, status: issues.length || rejected.length ? 'needs_repair' : 'passed', issues,
      applied, skipped: rejected.length, rejected, reason: null };
  } catch (error) {
    if (signal?.aborted || error.code === 'RUN_INTERRUPTED') throw error;
    return fallback(error.code === 'CONTEXT_BUDGET_EXCEEDED' ? 'context_limit' : 'editor_unavailable');
  }
}
