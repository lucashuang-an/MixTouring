/* e1-review.mjs · E1 只读产品评审器：读取方案文档、PR diff、CI 结果与 Issue #3 游标，
 * 调 OpenAI 生成评审（固定标题格式 + 结论枚举 + 北京⇄阿拉木图历史/探索边界）。
 * 纪律：只读——不改代码/数据/提交/推送/合并；OPENAI_API_KEY 缺失时输出占位（不伪造通过）。 */

const { OPENAI_API_KEY, OPENAI_MODEL, GH_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, PR_NUMBER } = process.env;
const fs = require('node:fs');
const out = (k, v) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

const api = async (path) => (await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
  headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json' }
})).json();

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const clip = (s, n) => (s || '').slice(0, n);

async function main() {
  if (!OPENAI_API_KEY) {
    global.__review_text = '产品评审器未配置（缺 OPENAI_API_KEY secret）：CI 已通过，待人工产品评审；不据此放行下一卡。';
    global.__verdict = 'blocked_placeholder';
    return;
  }
  const pr = await api(`/pulls/${PR_NUMBER}`);
  const diff = clip(await (await fetch(pr.diff_url)).text(), 24000);
  const statuses = await api(`/commits/${HEAD_SHA}/status`);
  const ciSummary = (statuses.statuses || []).map((s) => `${s.context}=${s.state}`).join(', ') || '无';
  const issue = await api('/issues/3/comments');
  const comments = Array.isArray(issue) ? issue : [];
  const lastReview = [...comments].reverse().find((c) => c.body && c.body.includes('Codex 产品评审｜被审 SHA'));
  const agents = read('AGENTS.md');
  const product = read('产品方案_SoloTrip_v1.2.md');
  const devflow = read('开发流程_SoloTrip_v1.2.md');
  const worklogTail = clip(read('工作记录.md'), 6000);

  const prompt = [
    '你是 MixTouring 的产品/技术方案评审员（只读）。基于给定材料对 PR 做评审，输出中文评审，结构：',
    '第一行标题：`Codex 产品评审｜被审 SHA ' + HEAD_SHA + '`',
    '随后依次：【范围与 CI】、【结论：通过｜有条件通过｜需修复｜阻断（四选一）】、【P1/P2 修复项（依据与验收，无则写"无新增修复项"及证据缺口）】、【下一开发卡与能力边界】。',
    '铁律：北京⇄阿拉木图证据仍为历史/探索——评审中不得出现"可购买/更便宜/节省金额"等指定日可执行表述；CI 通过不等于核验了真实票价/余票；结论必须有 diff/文档依据，证据不足不写通过。',
    '',
    '【AGENTS.md】' + clip(agents, 4000),
    '【产品方案（节选）】' + clip(product, 6000),
    '【开发流程（节选）】' + clip(devflow, 4000),
    '【工作记录（尾部）】' + worklogTail,
    '【CI 状态】' + ciSummary,
    '【Issue #3 最近一次评审（游标）】' + clip(lastReview ? lastReview.body : '（无）', 2500),
    '【PR diff】' + diff,
    '【PR 描述】' + clip(pr.body || '', 1500)
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'system', content: '你是严格的产品评审员，只依据给定材料，绝不编造班期、票价或可执行性。' }, { role: 'user', content: prompt }]
    })
  });
  const body = await res.json().catch(() => ({}));
  const text = body.choices?.[0]?.message?.content;
  if (!text) {
    global.__review_text = '产品评审器调用失败（OpenAI ' + res.status + '）：CI 已通过，待人工产品评审；不据此放行下一卡。';
    global.__verdict = 'blocked_placeholder';
    return;
  }
  global.__review_text = text.trim();
  const m = text.match(/结论[:：]\s*(通过|有条件通过|需修复|阻断)/);
  const verdictRaw = m ? m[1] : '需修复'; /* 解析不出结论按需修复保守处理（证据不足不写通过） */
  global.__verdict = (verdictRaw === '通过' || verdictRaw === '有条件通过') ? 'success' : 'failure';
}

await main();
fs.writeFileSync(process.env.GITHUB_OUTPUT, `verdict=${global.__verdict}\n`);
fs.writeFileSync(process.env.RUNNER_TEMP + '/review-text.md', global.__review_text);
console.log('评审生成完毕，结论状态：' + global.__verdict);
