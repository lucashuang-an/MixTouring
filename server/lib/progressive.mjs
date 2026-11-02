/* Agent规划共享预算；进度不伪造候选，取消后停止追加调用。 */
import {planSearchFirst} from './search-planner.mjs';
import { searchWeb, webSearchStatus, composeJson } from './llm.mjs';

export const progressivePlan=(input,emit,deps={},signal)=>boundedPlan(input,emit,deps,signal,planSearchFirst);
async function boundedPlan(input, emit, deps, signal, planner) {
  const started = Date.now(), budgetMs = deps.budgetMs ?? 60000;
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
  const search = deps.searchWeb || searchWeb;
  const compose = deps.composeJson || composeJson;
  const searchStatus = deps.searchStatus || (deps.searchWeb ? null : webSearchStatus);
  const data = await planner(input, {
    ...deps,
    signal:bounded,
    composeJson: (opts) => limited('model_calls', 4, compose, [{ ...opts, signal: bounded, canRetry:()=>!bounded.aborted&&counts.model_calls<4, reserveRetry:()=>{if(bounded.aborted||counts.model_calls>=4)return false;counts.model_calls++;return true;} }]),
    searchWeb: async (query, opts = {}) => {
      if (searchStopped) return null;
      const found = await limited('search_calls', 2, search,
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
  data.discovery_metrics = { ...counts, first_result_ms: firstMs ?? Date.now() - started, elapsed_ms: Date.now() - started, budget_exhausted: deadline.aborted };
  emit(data, 'complete');
  return data;
}
