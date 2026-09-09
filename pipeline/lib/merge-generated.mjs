/* merge-generated.mjs · 生成写回三重守门（从 generate-plan.mjs 抽出，供 CLI 与采集执行器共用）
 * 结构一致性（validate-plan）→ AI 文案（validate-ai-copy）→ 合并后全库校验，任一不过不写盘。
 * 纯内存操作：调用方自行决定是否落盘（CLI / collect-wish.mjs）。 */

import { validateStorePlans } from './validate-plan.mjs';
import { validateAICopy } from './validate-ai-copy.mjs';

/**
 * 三重守门合并（不写盘）。
 * @returns {{ok:boolean, errors:string[], log:string[]}} ok=false 时 store 可能已被部分合并，调用方应弃用
 */
export function mergeGenerated(store, gen, { verified = false } = {}) {
  const errors = [];
  const log = [];
  if (!gen || !gen.route_pair || !Array.isArray(gen.plans) || !gen.plans.length) {
    return { ok: false, errors: ['输入须含 route_pair 与非空 plans[]'], log };
  }
  const now = new Date().toISOString();
  gen.plans.forEach((p) => {
    if (p.ai) {
      p.ai.status = verified ? 'verified' : 'draft';
      if (verified && !p.ai.verified_at) p.ai.verified_at = now;
      if (!p.ai.generated_at) p.ai.generated_at = now;
    }
  });

  /* 合并：新路线对 / 追加到既有路线对 */
  const rp = gen.route_pair;
  const existRp = store.route_pairs.find((x) => x.route_id === rp.route_id);
  if (existRp) {
    for (const p of gen.plans) {
      if (store.plans.some((x) => x.id === p.id)) return { ok: false, errors: [`${p.id} 已存在`], log };
      store.plans.push(p);
      existRp.plan_ids.push(p.id);
    }
    log.push(`向既有路线 ${rp.route_id} 追加 ${gen.plans.length} 个方案`);
  } else {
    if (rp.route_id !== `${rp.from}-${rp.to}`) return { ok: false, errors: ['route_id 须为 from-to'], log };
    store.route_pairs.push({ ...rp, plan_ids: gen.plans.map((p) => p.id) });
    gen.plans.forEach((p) => store.plans.push(p));
    log.push(`新增路线 ${rp.route_id}（${gen.plans.length} 个方案）`);
  }

  /* 城市覆盖补齐 */
  gen.plans.forEach((p) => {
    [p.from, p.to, ...p.stops.map((s) => s.city)].forEach((c) => {
      if (!store.cities.includes(c)) { store.cities.push(c); log.push(`城市列表新增「${c}」`); }
    });
  });

  /* 合并后全库一致性 + AI 文案（三重守门最后一道） */
  errors.push(...validateStorePlans(store));
  store.plans.concat(store.templates.filter((t) => !t.ref)).forEach((p) => errors.push(...validateAICopy(p.ai, p.id)));
  return { ok: errors.length === 0, errors, log };
}
