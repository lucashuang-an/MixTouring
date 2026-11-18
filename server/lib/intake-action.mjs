import { agentPrompt } from './agent-prompts.mjs';

// 暂缓推荐单独持久化；偏好更新不能解除，只有本轮明确授权可以解除。
export async function reviewIntakeAction(result, { text, messages = [], conversation, current, model }) {
  const decision = result.planning;
  if (!['ask', 'propose'].includes(decision?.action)) return result;
  const prior = conversation?.discussion?.recommendation_hold || null;
  const validUpdate = ['keep', 'set', 'clear'].includes(decision.hold_update);
  const validQuote = decision.hold_update === 'keep' ||
    typeof decision.hold_quote === 'string' && !!decision.hold_quote.trim() && text.includes(decision.hold_quote);
  const active = decision.hold_update === 'set' || prior && decision.hold_update !== 'clear';

  // 合同完整且无执行冲突时直接采用主模型决策。
  if (validUpdate && validQuote && !(active && decision.action === 'propose')) {
    let hold = prior;
    if (decision.hold_update === 'set') hold = { quote: decision.hold_quote };
    if (decision.hold_update === 'clear') hold = null;
    return { ...result, planning: { ...decision, recommendation_hold: hold }, confirmed: false, ready: false };
  }
  const checked = await model({
    kind: 'planning_intake_review', timeoutMs: 12000,
    schema_prompt: agentPrompt('planning.intake_review'),
    user: JSON.stringify({ text, messages, conversation, current, recommendation_hold: prior,
      proposed: { action: decision.action, reply: result.reply } })
  });
  if (!checked || !['ask', 'propose'].includes(checked.action)) throw Error('初始讨论动作核对未完成');

  let hold = prior;
  if (['set', 'clear'].includes(checked.hold_update)) {
    if (typeof checked.hold_quote !== 'string' || !checked.hold_quote.trim() || !text.includes(checked.hold_quote)) {
      throw Error('推荐授权出处无效');
    }
    hold = checked.hold_update === 'set' ? { quote: checked.hold_quote } : null;
  }
  const action = hold ? 'ask' : checked.action;
  if (action === 'propose') {
    const userTexts = [text, ...messages.filter(message => message.role === 'user').map(message => message.text)]
      .filter(value => typeof value === 'string');
    if (typeof checked.quote !== 'string' || !checked.quote.trim() || !userTexts.some(value => value.includes(checked.quote))) {
      throw Error('初始讨论动作依据无效');
    }
  }
  if (action === 'ask' && decision.action === 'propose' && !checked.reply?.trim()) throw Error('暂缓推荐回复缺失');
  return { ...result, reply: action === 'ask' && checked.reply?.trim() ? checked.reply : result.reply,
    planning: { ...decision, action, recommendation_hold: hold }, confirmed: false, ready: false };
}
