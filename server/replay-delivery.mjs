import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// 已确认会话的手动实网重放。显式运行才会调用外部模型及检索服务。
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const casePath = option('--case');
const outputPath = option('--out');
const mode = option('--review') || 'final';
if (!casePath || !outputPath || !['final', 'light', 'strict'].includes(mode)) {
  throw Error('用法: node --env-file=server/.env server/replay-delivery.mjs --case <result.json> --out <new.json> [--review final|light|strict]');
}
const output = resolve(outputPath);
if (existsSync(output)) throw Error('输出已存在，请指定新文件，保留之前的结果');
const history = JSON.parse(readFileSync(resolve(casePath), 'utf8').replace(/^\uFEFF/, '')).turns;
if (!Array.isArray(history)) throw Error('案例需要turns数组');
const confirmedIndex = history.findLastIndex(turn => turn.state_after?.conversation?.stage === 'ready' && turn.state_after.conversation.discussion?.authorization);
if (confirmedIndex < 0) throw Error('案例中没有已确认方案');
const turns = history.slice(0, confirmedIndex + 1);
const state = turns.at(-1).state_after;
let mid = 1;
const messages = turns.flatMap(turn => [
  { mid: mid++, role: 'user', text: turn.text || turn.input || '' },
  { mid: mid++, role: 'assistant', text: turn.result?.reply || '' }
]).filter(message => message.text);
process.env.MT_ITINERARY_REVIEW = mode;
process.env.MAP_PROVIDER = 'none';
const { conversationTurn } = await import('./lib/conversation.mjs');
const { RUNTIME_VERSION } = await import('./lib/runtime-version.mjs');
const { AGENT_RULES_VERSION } = await import('./lib/agent-prompts.mjs');
const events = [], usage = [];
const started = Date.now();
const result = await conversationTurn({ ...state, action: 'generate', text: '', messages }, null, {
  onTrace: event => events.push(event), onModelUsage: row => usage.push(row)
});
const report = { case: resolve(casePath), review_mode: mode, maps: false, runtime_version: RUNTIME_VERSION,
  agent_rules_version: AGENT_RULES_VERSION, tested_at: new Date().toISOString(), elapsed_ms: Date.now() - started, result, events, usage };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, status: result.status, task: result.task_status,
  cards: result.conversation?.draft?.cards?.length || 0, elapsed_ms: report.elapsed_ms }));
