/* 在线探索预算与渐进输出；超时保留规则候选，客户端断开后停止后续调用。 */
import { planAnywhere } from './anywhere.mjs';
import { callJson, searchWeb, webSearchStatus, composeJson } from './llm.mjs';

export async function progressivePlan(input, emit, deps = {}, signal) {
  const started = Date.now(), budgetMs = deps.budgetMs ?? 25000;
  const deadline = AbortSignal.timeout(budgetMs);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const counts = { model_calls: 0, search_calls: 0 };
  let firstMs = null;
  let searchStopped = false;
  async function limited(kind, limit, fn, args) {
    if (bounded.aborted || counts[kind] >= limit) return null;
    counts[kind]++;
    let onAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn(...args)),
        new Promise((resolve) => { onAbort = () => resolve(null); bounded.addEventListener('abort', onAbort, { once: true }); })
      ]);
    } catch { return null; }
    finally { if (onAbort) bounded.removeEventListener('abort', onAbort); }
  }
  const model = deps.callJson || callJson, search = deps.searchWeb || searchWeb;
  const compose = deps.composeJson || composeJson;
  const searchStatus = deps.searchStatus || (deps.searchWeb ? null : webSearchStatus);
  const data = await planAnywhere(input, {
    ...deps,
    useDiscoveryCache: deps.useDiscoveryCache ?? (deps.callJson === undefined && deps.searchWeb === undefined),
    callJson: (opts) => limited('model_calls', 4, model, [{ ...opts, signal: bounded }]),
    composeJson: (opts) => limited('model_calls', 4, compose, [{ ...opts, signal: bounded }]),
    searchWeb: async (query, opts = {}) => {
      if (searchStopped) return null;
      const found = await limited('search_calls', 14, search,
        [query, { ...opts, signal: bounded, timeoutMs: Math.min(opts.timeoutMs || 8000, 8000) }]);
      if (!found && searchStatus?.().status === 'quota_exhausted') searchStopped = true;
      return found;
    },
    onProgress: (base) => {
      if (signal?.aborted) return;
      firstMs = Date.now() - started;
      emit(base, 'base');
    }
  });
  if (signal?.aborted) return;
  data.planning_notice = ['quota_exhausted', 'timeout', 'error'].includes(data.web_search?.status)
    ? '补充搜索暂不可用；以下走法依据现有资料，班次与衔接仍需查询。' : '';
  data.discovery_metrics = { ...counts, first_result_ms: firstMs ?? Date.now() - started, elapsed_ms: Date.now() - started, budget_exhausted: deadline.aborted };
  emit(data, 'complete');
  return data;
}
