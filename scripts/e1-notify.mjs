/* e1-notify.mjs · E1 无模型通知（评审 P0 重构）：只发布 CI ready/blocked 评论与 product-review 状态。
 * 不调用任何 LLM API、不读取任何密钥；产品评审由仓库负责人在 ChatGPT Work 的事件任务执行。 */

import fs from 'node:fs';
const { GH_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, PR_NUMBER, CI_STATE, CI_COMMENT } = process.env;

const api = async (path, method = 'GET', body) => fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
  method,
  headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then((r) => r.json());

if (!HEAD_SHA) {
  console.log('无 head SHA，跳过通知。');
  process.exit(0);
}

/* 幂等：同 head SHA 已有同状态 product-review status 时不再重复评论（防 synchronize 刷屏） */
const prev = await api(`/commits/${HEAD_SHA}/status`);
const dup = (prev.statuses || []).some((s) => s.context === 'product-review' && s.state === (CI_STATE === 'ready' ? 'success' : 'failure'));

const state = CI_STATE === 'ready' ? 'success' : 'failure';
const description = CI_STATE === 'ready' ? 'CI ready：等待产品评审（ChatGPT Work 事件任务）' : 'CI 阻断：verify 未通过，不进入产品评审';
await api(`/commits/${HEAD_SHA}/status`, 'POST', { state, context: 'product-review', description });

if (dup) {
  console.log('同 SHA 同状态已存在，跳过评论（幂等）。');
  process.exit(0);
}

if (PR_NUMBER) await api(`/issues/${PR_NUMBER}/comments`, 'POST', { body: CI_COMMENT });
console.log('CI 状态评论与 product-review status 已发布：' + state);
