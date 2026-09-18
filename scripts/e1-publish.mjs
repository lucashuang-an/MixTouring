/* e1-publish.mjs · E1 发布器：Issue #3 唯一交接评论（同 SHA 幂等）+ PR 摘要 + product-review 状态。 */

const { GH_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, PR_NUMBER, VERDICT } = process.env;
const REVIEW_TEXT = fs.readFileSync(process.env.REVIEW_TEXT || (process.env.RUNNER_TEMP + '/review-text.md'), 'utf8');

const api = async (path, method = 'GET', body) => fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
  method,
  headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
});

/* 幂等（验收 E）：同 head SHA 已有评审评论则跳过 Issue 评论（PR 摘要仍更新一次） */
const issue = await api('/issues/3/comments');
const comments = Array.isArray(issue) ? issue : [];
const dup = comments.some((c) => c.body && c.body.includes(`被审 SHA ${HEAD_SHA}`));
if (!dup) {
  await api('/issues/3/comments', 'POST', { body: REVIEW_TEXT });
  console.log('已发布 Issue #3 评审（新 SHA）。');
} else {
  console.log('同 SHA 评审已存在，跳过 Issue 评论（幂等）。');
}

if (PR_NUMBER) {
  await api(`/issues/${PR_NUMBER}/comments`, 'POST', {
    body: `**产品评审摘要**（完整版见 Issue #3，head \`${HEAD_SHA.slice(0, 12)}\`）：\n\n${REVIEW_TEXT.slice(0, 3000)}`
  });
}

const stateMap = { success: 'success', failure: 'failure' };
const state = stateMap[VERDICT] || 'error';
await api(`/commits/${HEAD_SHA}/status`, 'POST', {
  state,
  context: 'product-review',
  description: state === 'success' ? '产品评审通过/有条件通过' : state === 'failure' ? '产品评审：需修复/阻断' : '产品评审器未完成（待配置或超时）'
});
console.log('product-review 状态已写：' + state);
