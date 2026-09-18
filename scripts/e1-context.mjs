/* e1-context.mjs · E1 上下文解析：PR 事件直取；workflow_run 场景按 head SHA 反查同仓库 PR。 */
const { EVENT_NAME, PR_NUMBER, PR_HEAD, WR_HEAD } = process.env;

if (EVENT_NAME === 'pull_request') {
  const fs = require('node:fs');
  fs.writeFileSync(process.env.GITHUB_OUTPUT, `head_sha=${PR_HEAD}\npr_number=${PR_NUMBER}\n`);
  process.exit(0);
}

// workflow_run：按 head SHA 反查同仓库开放 PR（排除 fork——workflow_run 场景已由 workflow if 过滤同仓库）
const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls?state=open&per_page=100`, {
  headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' }
});
const prs = await res.json();
const hit = Array.isArray(prs) ? prs.find((p) => p.head.sha === WR_HEAD) : null;
const fs = require('node:fs');
if (hit) {
  fs.writeFileSync(process.env.GITHUB_OUTPUT, `head_sha=${WR_HEAD}\npr_number=${hit.number}\n`);
} else {
  // 无关联 PR 的 push（理论不触发本 workflow）——输出空 SHA 让后续步骤退出
  fs.writeFileSync(process.env.GITHUB_OUTPUT, 'head_sha=\npr_number=\n');
}
