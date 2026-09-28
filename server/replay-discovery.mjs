/* 真实运行服务回放；耗时与候选供人工检查，不把返回数量当成质量通过。 */
import { writeFileSync } from 'node:fs';
const base = process.env.VERIFY_BASE || 'http://localhost:3014';
const report = { sampled_at: new Date().toISOString(), note: '真实通道回放，非班期核验；调用次数不等于费用，金额须结合供应商账单。', cases: [] };
/* v0.44.0 卡 A：前四组为历史对照组（北京→阿拉木图为调优 case，另三组曾回放）；
 * 后三组为未调优、地理类型分散的新增 OD（国内南北超长 / 南下口岸跨境 / 海峡跨境）。 */
for (const [origin, destination] of [['北京', '阿拉木图'], ['上海', '昆明'], ['广州', '比什凯克'], ['成都', '拉萨'],
  ['哈尔滨', '三亚'], ['北京', '香港'], ['上海', '台北']]) {
  const started = Date.now(), events = [];
  const response = await fetch(base + '/api/anywhere/plan', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin, destination, progressive: true }), signal: AbortSignal.timeout(60000) });
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) events.push({ ms: Date.now() - started, ...JSON.parse(line) });
  }
  const final = events.find((e) => e.phase === 'complete');
  if (!final || final.code !== 0) throw new Error(origin + '→' + destination + '回放未完成');
  report.cases.push({ origin, destination, first_result_ms: events[0].ms, complete_ms: final.ms,
    metrics: final.data.discovery_metrics, search: final.data.web_search, cost_cny: null,
    candidates: final.data.candidates.map((c) => ({ kind: c.kind, legs: c.legs.map((l) => ({ from: l.from, to: l.to, mode: l.mode_guess, via: l.via })),
      reason: c.explanation, basis: c.basis })) });
  console.log(origin + '→' + destination + '：首批 ' + events[0].ms + 'ms，完成 ' + final.ms + 'ms，搜索状态 ' + final.data.web_search?.status);
}
writeFileSync(new URL('../pipeline/out/discovery-replay.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
