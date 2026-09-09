/* lib/llm.mjs · MixTouring Phase 2 LLM 适配层（唯一 LLM 出口）
 * 硬约束（AGENTS §6.3 Phase 2）：LLM key 只存服务端，浏览器不直连。
 * 本模块用环境变量注入 key，统一所有 LLM 调用的入口；
 * 未配置 key 时规则版闭环照常可用（callJson 返回 null 交由调用方走规则/词典实现），
 * 之后注入 key（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL）即自动切真模型，契约不变。
 * 用量记录：每次真模型调用把 token 消耗追加到 server/logs/llm-usage.jsonl（kind 区分任务），
 * 为后续算法优化（prompt 瘦身/缓存/模型选型）提供逐任务数据。 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

const KEY = process.env.LLM_API_KEY || '';
const BASE = (process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || DEFAULT_MODEL;
const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'llm-usage.jsonl');

/** 是否已配置真模型 key（未配置时走规则版，规则版不需联网） */
export function llmConfigured() {
  return !!KEY;
}

/** 当前生效的模型标识（未配置时返回 'rule'） */
export function llmModel() {
  return llmConfigured() ? MODEL : 'rule';
}

/* 逐任务用量落盘（JSONL，一行一次调用）；写失败只打日志，不影响主流程 */
function logUsage(kind, usage) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      kind: kind || 'unspecified',
      model: MODEL,
      prompt_tokens: usage?.prompt_tokens ?? null,
      completion_tokens: usage?.completion_tokens ?? null,
      total_tokens: usage?.total_tokens ?? null
    }) + '\n', 'utf8');
  } catch (err) {
    console.error('✗ LLM 用量记录失败：' + err.message);
  }
}

/**
 * 让 LLM 返回一个 JSON 对象（OpenAI 兼容 /chat/completions）。
 * 未配置 key 时 resolve(null)，调用方应回退到规则/词典实现（保持闭环可离线运行）。
 * @param {object} opts { schema_prompt, user, kind, webSearch, timeoutMs }
 *   kind 为任务标识（parse/ask/copy/collect），用于用量归因；
 *   webSearch=true 开启智谱内置联网检索（采集执行器采样用）；开检索时放弃 json_object 严格模式（二者不兼容），靠正则提取 JSON。
 * @returns {Promise<object|null>}
 */
export async function callJson(opts) {
  if (!llmConfigured()) return null;
  try {
    const body = {
      model: MODEL,
      temperature: opts.webSearch ? 0.3 : 0.2,
      messages: [
        { role: 'system', content: opts.schema_prompt || '只输出 JSON 对象。' },
        { role: 'user', content: opts.user }
      ]
    };
    if (opts.webSearch) {
      body.tools = [{ type: 'web_search', web_search: { enable: true, search_count: 8 } }];
    } else {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000)
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status);
    const resBody = await res.json();
    logUsage(opts.kind, resBody.usage);
    const raw = resBody.choices?.[0]?.message?.content;
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