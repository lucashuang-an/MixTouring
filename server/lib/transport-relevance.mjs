import {sourceSupportsLeg} from './route-discovery.mjs';
export function resultRelevance(r, leg) {
  const hay = (String(r.title || '') + ' ' + String(r.content || '')).toLowerCase();
  const from = String(leg.from).toLowerCase();
  const to = String(leg.to).toLowerCase();
  const modeRe = leg.mode_guess === 'rail'
    ? /列车|火车|铁路|高铁|动车|train|rail/
    : leg.mode_guess === 'plane'
      ? /航班|飞机|直飞|air\s|airline|flight|fly/
      : leg.mode_guess === 'road'
        ? /客运|班车|大巴|公路|汽车|bus|coach/
      : null;
  return {
    from_hit: !!from && hay.includes(from),
    to_hit: !!to && hay.includes(to),
    mode_hit: modeRe ? modeRe.test(hay) : true,
    connection_hit: !leg.mode_guess || leg.mode_guess === 'unknown'
      ? ['plane', 'rail', 'road'].some((mode) => sourceSupportsLeg(r, leg.from, leg.to, mode))
      : sourceSupportsLeg(r, leg.from, leg.to, leg.mode_guess)
  };
}

/** 逐段搜索线索：同查询缓存（限速纪律）；来源只保留 https 且通过相关性判定（v0.31.0 P0-2）；
 *  记录查询词与逐源相关性；不展示摘要防数字误引；无相关结果保持探索态。
 *  唯一查询并行发起（2026-09-28）：串行时每段独占一个超时窗口，25s 渐进预算内三段以上必超时。 */
