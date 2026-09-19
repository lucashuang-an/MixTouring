/* e1-gate.mjs · E1 CI 门禁（无模型版）：轮询 verify 完成 → 输出 ready（全部成功）或 blocked（失败/超时）
 * 的结论文本；product-review status 与 PR 评论由 e1-notify.mjs 统一发布。
 * 不调用任何 LLM API、不读取任何密钥（评审 P0：本仓无 API key，产品评审走 ChatGPT Work 订阅制）。 */

import fs from 'node:fs';
const { GH_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, WR_CONCLUSION } = process.env;
const out = (k, v) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

const api = async (path, method = 'GET', body) => fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
  method,
  headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then((r) => r.json());

if (!HEAD_SHA) {
  console.log('无关联 PR/head SHA，退出。');
  out('proceed', 'false');
  process.exit(0);
}

/* 轮询等待 CI 完成（最多 ~8 分钟；PR synchronize 时 verify 刚触发） */
let combined = null;
for (let i = 0; i < 32; i++) {
  const r = await api(`/commits/${HEAD_SHA}/status`);
  const states = (r.statuses || []).map((s) => s.state);
  const hasVerify = (r.statuses || []).some((s) => s.context === 'verify');
  if (hasVerify && states.every((s) => s !== 'pending')) { combined = r; break; }
  await new Promise((r2) => setTimeout(r2, 15000));
}
if (!combined) {
  console.log('CI 未在等待期内完成：按 blocked 处理（不启动评审，重推或 CI 完成会再触发）。');
  out('ci_state', 'blocked');
  out('ci_comment', 'CI 等待超时（verify 未完成）：本次不进入产品评审，重推或 CI 完成后将自动重新判定。');
  out('proceed', 'false');
  process.exit(0);
}

const verifyState = (combined.statuses || []).find((s) => s.context === 'verify')?.state || 'unknown';
const failed = verifyState !== 'success' || WR_CONCLUSION === 'failure';
if (failed) {
  out('ci_state', 'blocked');
  out('ci_comment', `**CI 阻断**（head \`${HEAD_SHA.slice(0, 12)}\`）：verify 结论 ${verifyState}${WR_CONCLUSION === 'failure' ? ' / workflow failure' : ''}。按流程不进入产品评审，请修复后重推。`);
  console.log('CI 阻断。');
  out('proceed', 'false');
  process.exit(0);
}

out('ci_state', 'ready');
out('ci_comment', `CI ready（head \`${HEAD_SHA.slice(0, 12)}\`）：全部检查通过，等待产品评审（ChatGPT Work 事件任务）。`);
out('proceed', 'true');
console.log('CI 全部成功，CI ready。');
