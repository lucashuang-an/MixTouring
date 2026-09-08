/* validate-ai-copy.mjs · AI 文案防幻觉校验器（方案库Schema §4.5）
 * 规则：占位符必须在白名单内；去除占位符后文案中不得出现任何阿拉伯数字。 */

export const PLACEHOLDER_RE = /\{([a-z_0-9]+)\}/g;
export const WHITELIST_RE = /^(saved|price_min|price_max|price_mid|total_time|direct_price|from|to|transfer_city_\d+|wait_min_\d+|transfer_min_\d+|transfer_km_\d+)$/;

const FIELDS = ['summary', 'fit', 'notice', 'play_intro'];

export function validateAICopy(ai, planId) {
  const errors = [];
  if (!ai) return errors;
  for (const field of FIELDS) {
    const text = ai[field];
    if (typeof text !== 'string' || !text.trim()) {
      errors.push(`${planId}.ai.${field}: 缺失或为空`);
      continue;
    }
    const stripped = text.replace(PLACEHOLDER_RE, (m, key) => {
      if (!WHITELIST_RE.test(key)) errors.push(`${planId}.ai.${field}: 占位符 {${key}} 不在白名单`);
      return '';
    });
    const digits = stripped.match(/[0-9]+/g);
    if (digits) errors.push(`${planId}.ai.${field}: 含未插值数字 ${digits.join(', ')}（数字只许来自占位符）`);
  }
  return errors;
}

export function validateStore(store) {
  const errors = [];
  const check = (plan) => { if (plan.ai) errors.push(...validateAICopy(plan.ai, plan.id)); };
  store.plans.forEach(check);
  store.templates.forEach((t) => { if (!t.ref) check(t); });
  return errors;
}
