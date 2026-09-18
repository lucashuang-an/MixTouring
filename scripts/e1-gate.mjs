/* e1-gate.mjs · E1 CI 门禁：必需 CI 未完成 → 退出（product-review=error）；任一失败 → 「CI 阻断」+ status failure；
 * 全部成功 → 放行产品评审。workflow_run 的 verify 结论也纳入。 */

const { GH_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, PR_NUMBER, WR_CONCLUSION } = process.env;
const fs = require('node:fs');
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
  const r = await (await api(`/commits/${HEAD_SHA}/status`)).json();
  const states = (r.statuses || []).map((s) => s.state);
  const hasVerify = (r.statuses || []).some((s) => s.context === 'verify');
  if (hasVerify && states.every((s) => s !== 'pending')) { combined = r; break; }
  await new Promise((r2) => setTimeout(r2, 15000));
}
if (!combined) {
  console.log('CI 未在等待期内完成：product-review 标记 error，不启动评审（不阻断，重推或 CI 完成会再触发）。');
  await api(`/commits/${HEAD_SHA}/status`, 'POST', { state: 'error', context: 'product-review', description: 'CI 等待超时，评审未启动（将在新事件后重试）' });
  out('proceed', 'false');
  process.exit(0);
}

const verifyState = (combined.statuses || []).find((s) => s.context === 'verify')?.state || 'unknown';
const failed = verifyState !== 'success' || WR_CONCLUSION === 'failure';
if (failed) {
  const body = `**CI 阻断**（head \`${HEAD_SHA.slice(0, 12)}\`）：verify 结论 ${verifyState}${WR_CONCLUSION === 'failure' ? ' / workflow failure' : ''}。按流程不启动产品评审，请修复后重推。`;
  await api(`/commits/${HEAD_SHA}/status`, 'POST', { state: 'failure', context: 'product-review', description: 'CI 阻断：verify 未通过' });
  if (PR_NUMBER) await api(`/issues/${PR_NUMBER}/comments`, 'POST', { body });
  console.log('CI 阻断，已写状态与说明。');
  out('proceed', 'false');
  process.exit(0);
}

console.log('CI 全部成功，放行产品评审。');
out('proceed', 'true');
