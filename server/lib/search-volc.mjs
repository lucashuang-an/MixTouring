/* 火山方舟普通推理接口的联网搜索适配。与 Coding Plan 分开鉴权和计费。 */
const ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/responses';

export function parseVolcSearch(body, limit = 5) {
  if (body?.status !== 'completed') return null;
  const calls = (body.output || []).filter((item) => item.type === 'web_search_call' && item.status === 'completed');
  if (!calls.length || !(body.usage?.tool_usage?.web_search > 0)) return null;
  const seen = new Set();
  const results = [];
  for (const item of body.output || []) {
    for (const content of item.content || []) {
      for (const source of content.annotations || []) {
        if (source.type !== 'url_citation') continue;
        let link;
        try {
          const parsed = new URL(source.url);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
          link = parsed.href;
        } catch { continue; }
        if (seen.has(link)) continue;
        seen.add(link);
        results.push({
          title: String(source.title || source.site_name || '').slice(0, 120),
          link,
          content: String(source.summary || '').slice(0, 300),
          media: source.site_name || 'volc-search',
          date: source.publish_time || null
        });
      }
    }
  }
  return results.slice(0, limit).length ? results.slice(0, limit) : null;
}

export async function searchVolc(query, { key, model = 'doubao-seed-2-1-lite-260915', limit = 5, timeoutMs = 30000, signal } = {}) {
  if (!key) return { status: 'unconfigured', results: null };
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        input: `请联网搜索下面的查询词，仅列出最相关的来源，每条用一句话概括。查询词：${String(query).slice(0, 100)}`,
        tools: [{ type: 'web_search', sources: ['search_engine'], limit: Math.max(1, Math.min(limit, 10)), max_keyword: 1 }],
        tool_choice: { type: 'web_search' },
        thinking: { type: 'disabled' },
        max_output_tokens: 3072
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!res.ok) {
      /* 2026-09-28 实测：429 可能是账号「安全体验模式」用量上限（SetLimitExceeded，模型暂停，
       * 需控制台调整）而非速率限流——记录错误码便于区分，两种都按额度类诚实降级（本轮停止重试）。 */
      let code=null;try{const raw=(await res.json())?.error?.code;if(typeof raw==='string' && /^[A-Za-z0-9_.-]{1,80}$/.test(raw))code=raw;}catch{}
      if(res.status===429)console.error('✗ 火山搜索 429：'+(code || ''));
      return { status: res.status === 429 ? 'quota_exhausted' : 'error', results: null,http_status:res.status,reason_code:code || 'http_error' };
    }
    const body=await res.json(),results = parseVolcSearch(body, limit),safe=v=>Number.isFinite(v) && v>=0?v:null;
    const usage={input_tokens:safe(body.usage?.input_tokens ?? body.usage?.prompt_tokens),output_tokens:safe(body.usage?.output_tokens ?? body.usage?.completion_tokens),total_tokens:safe(body.usage?.total_tokens),web_search_calls:safe(body.usage?.tool_usage?.web_search)};
    return { status: results ? 'available' : 'error', results,http_status:res.status,reason_code:results?null:body.status!=='completed'?'incomplete_response':'missing_search_citations',usage };
  } catch (err) {
    return { status: signal?.aborted?'cancelled':err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'error', results: null,reason_code:signal?.aborted?'cancelled':err?.name === 'TimeoutError' || err?.name === 'AbortError'?'timeout':'network_or_invalid_response' };
  }
}
