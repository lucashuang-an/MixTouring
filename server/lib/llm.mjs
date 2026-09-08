/* lib/llm.mjs · MixTouring Phase 2 LLM 适配层（唯一 LLM 出口）
 * 硬约束（AGENTS §6.3 Phase 2）：LLM key 只存服务端，浏览器不直连。
 * 本模块用环境变量注入 key，统一所有 LLM 调用的入口；
 * 未配置 key 时规则版闭环照常可用（callJson 返回 null 交由调用方走规则/词典实现），
 * 之后注入 key（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）即自动切真模型，契约不变。 */

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

const KEY = process.env.LLM_API_KEY || '';
const BASE = (process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || DEFAULT_MODEL;

/** 是否已配置真模型 key（未配置时走规则版，规则版不需联网） */
export function llmConfigured() {
  return !!KEY;
}

/** 当前生效的模型标识（未配置时返回 'rule'） */
export function llmModel() {
  return llmConfigured() ? MODEL : 'rule';
}

/**
 * 让 LLM 返回一个 JSON 对象（OpenAI 兼容 /chat/completions）。
 * 未配置 key 时 resolve(null)，调用方应回退到规则/词典实现（保持闭环可离线运行）。
 * @param {object} opts { system, user, schema }  schema 为期望 JSON 的结构描述（供注入 system prompt）
 * @returns {Promise<object|null>}
 */
export async function callJson(opts) {
  if (!llmConfigured()) return null;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: opts.schema_prompt || '只输出 JSON 对象。' },
          { role: 'user', content: opts.user }
        ]
      })
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status);
    const body = await res.json();
    const raw = body.choices?.[0]?.message?.content;
    if (!raw) return null;
    // 兼容模型可能在代码块里包 JSON
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (err) {
    /* 规则版兜底：LLM 调用失败不阻塞在线查询，交回规则实现 */
    console.error('✗ LLM 调用失败，回退规则版：' + err.message);
    return null;
  }
}