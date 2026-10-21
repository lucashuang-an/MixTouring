/* 检索合同：平台由 URL 确认，体验与事实分开；局部失败不影响其他来源。 */
import assert from 'node:assert/strict';
import {collectTravelSources,classifyTravelSource} from './lib/travel-sources.mjs';
const now=Date.parse('2026-10-15T02:00:00Z');
const calls=[];
const search=async q=>{
  calls.push(q);
  if(q.includes('site:xiaohongshu.com'))return [
    {title:'小红书游记',link:'https://www.xiaohongshu.com/explore/abc123?utm_source=test',content:'旅行者分享湖区住宿感受',date:'2026-10-01'},
    {title:'同一笔记',link:'https://www.xiaohongshu.com/explore/abc123',content:'相同内容'},
    {title:'平台首页',link:'https://www.xiaohongshu.com/'},
    {title:'假链接',link:'javascript:alert(1)'}];
  if(q.includes('site:reddit.com'))return [{title:'无车旅行讨论',link:'https://www.reddit.com/r/travel/comments/example',content:'公共交通经验',date:'2026-10-01'}];
  return [{title:'目的地资料',link:'https://www.kazakhstan.travel/en/regions/almaty',content:'城市与景观资料',date:'2026-10-01'}];
};
const r=await collectTravelSources({destination:'阿拉木图',international:true,foreignQuery:'Almaty without car trip report'},search,{useCache:false,now});
assert.equal(calls.length,2,'R1-A:查询计划收敛到最多两次搜索(原7条固定展开)');assert.ok(calls.every(q=>q.length<=100));assert.ok(calls.some(q=>q.includes('Almaty')));
assert.equal(r.sources.length,2,'R1-A:experience 计划=中文社区+海外社区两条查询');assert.equal(r.sources[0].platform,'小红书');assert.equal(r.sources[0].kind,'experience');
assert.equal(r.sources[1].platform,'Reddit');
assert.ok(r.query_diagnostics.length===2 && r.query_diagnostics.every(q=>q.raw_count>0),'R1-A:每条查询记录相关性筛选诊断');
assert.equal(r.sources[0].url,'https://www.xiaohongshu.com/explore/abc123');
assert.ok(r.results.some(s=>s.source_kind==='experience'));
assert.equal(classifyTravelSource('https://xiaohongshu.com.evil.test/explore/1').kind,'guide');
assert.equal(classifyTravelSource('https://tripadvisor.com.evil.test/ShowTopic-1').kind,'guide');
assert.equal(classifyTravelSource('https://hk.trip.com/moments/detail/bishkek-123/').kind,'experience');
assert.equal(classifyTravelSource('https://hk.trip.com/travel-guide/').kind,'guide');
assert.equal(classifyTravelSource('https://hk.trip.com/moments/destination-issyk-kul-123/').kind,'guide');
assert.equal(classifyTravelSource('https://m.mafengwo.cn/mweng/wengdetail/?id=123').kind,'experience');
assert.equal(classifyTravelSource('https://m.mafengwo.cn/mmobile/wanfaguide/?gid=123').kind,'guide');
assert.equal(classifyTravelSource('https://www.tripadvisor.com/AttractionProductReview-g123').kind,'guide','产品售卖页不冒充旅行者原帖');
assert.equal(classifyTravelSource('https://gs.ctrip.com/html5/you/travels/21387/4169744.html').kind,'experience','携程移动游记仍按内容路径识别为经验');
assert.equal(classifyTravelSource('https://you.ctrip.com/travels/YiningCity2058/4134192.html').kind,'experience');
assert.equal(classifyTravelSource('https://gs.ctrip.com/html5/you/travels/').kind,'guide','索引页不是游记原文');
const failed=await collectTravelSources({destination:'昆明',international:false,purpose:'guide'},async q=>{
  if(q.includes('site:xiaohongshu.com'))throw Error('索引不可用');
  return [{title:'实际公开资料',link:'https://example.org/kunming',date:'2026-10-01'}];
},{useCache:false,now});
assert.equal(failed.channels.length,2,'R1-A:非国际 guide 计划=中文社区+官方两条');assert.equal(failed.sources.length,1);assert.equal(failed.sources[0].kind,'guide');
assert.equal(failed.channels[0].status,'unavailable','未命中平台不伪造 UGC');
console.log('✓ 中文与海外经验检索、来源类型、真实平台、去重及失败兼容通过');

assert.ok(r.channels.find(c=>c.channel==='中文社区').status==='found','R1-A:合并社区渠道按命中表达');
assert.ok(calls.filter(q=>q.includes('site:')).every(q=>(q.match(/site:/g)||[]).length<=3),'R1-A:合并社区查询的 site: 限定不超过计划域名数');

/* #30：网页跳转后的身份、日期与渠道归属——确定性回归（注入读取桩，不访问外站）。 */
{
  const mkSearch = link => async q => q.includes('site:xiaohongshu.com')
    ? [{ title: '小红书原帖', link, content: '原始摘要内容', date: '2026-10-01' }] : [];
  const base = { read_status: 'page_excerpt', title: '读取到的标题', excerpt: '读取正文' };
  const run = async (page) => (await collectTravelSources(
    { destination: '阿拉木图', international: false },
    mkSearch('https://www.xiaohongshu.com/explore/abc123'),
    { useCache: false, now, readPage: async () => page })).sources[0];

  /* 跨域不同文章 + 日期缺失：不合并，保留原平台与索引日期，读取缺口如实标注 */
  const cross = await run({ ...base, url: 'https://example.org/different-article', published_at: null });
  assert.equal(cross.platform, '小红书', '跳转别站不改变平台归属');
  assert.equal(cross.url, 'https://www.xiaohongshu.com/explore/abc123', '不替换为别站 URL');
  assert.equal(cross.published_at, '2026-10-01', '保留原索引记录');
  assert.equal(cross.date_basis, 'search_index', '不把别站文章冒充原帖却不给日期来源');
  assert.equal(cross.read_status, 'search_excerpt', '未采用跳转正文，不算原文读取成功');
  assert.ok(cross.read_note.includes('跳转'), '读取缺口如实标注');
  assert.equal(cross.excerpt, '原始摘要内容', '不混入别站正文');

  /* 同篇 canonical（同 host 同 path、带跟踪参数与 https 差异）：正常合并，原文日期生效 */
  const canonical = await run({ ...base, url: 'https://xiaohongshu.com/explore/abc123?utm_source=x', published_at: '2026-09-20' });
  assert.equal(canonical.read_status, 'page_excerpt', '同篇 canonical 正常合并');
  assert.equal(canonical.platform, '小红书');
  assert.equal(canonical.published_at, '2026-09-20', '同一文章的原文日期替代索引日期');
  assert.equal(canonical.date_basis, 'page_metadata');
  assert.equal(canonical.original_url, 'https://www.xiaohongshu.com/explore/abc123', '保留检索入口溯源');

  /* 同域不同文章：拒绝合并 */
  const sameDomain = await run({ ...base, url: 'https://www.xiaohongshu.com/explore/other999', published_at: null });
  assert.equal(sameDomain.read_status, 'search_excerpt', '同域不同 path 视为不同文章');
  assert.equal(sameDomain.platform, '小红书');

  /* 多入口汇入同一篇：各自保留索引身份，均不合并 */
  const multi = await collectTravelSources({ destination: '阿拉木图', international: false },
    async q => q.includes('site:xiaohongshu.com') ? [
      { title: '入口一', link: 'https://www.xiaohongshu.com/explore/a1', content: 's1', date: '2026-10-01' },
      { title: '入口二', link: 'https://www.xiaohongshu.com/explore/a2', content: 's2', date: '2026-10-01' }] : [],
    { useCache: false, now, readPage: async () => ({ ...base, url: 'https://example.org/same-post', published_at: null }) });
  assert.ok(multi.sources.every(s => s.platform === '小红书' && s.read_status === 'search_excerpt'),
    '多入口跳转同一别站文章时全部不合并');
}

/* #32（复审修订）：预取消不发起搜索、不读原文、不产出来源；部分成功后取消不写缓存 */
{
  const seen = [];
  const aborted = AbortSignal.abort('pre');
  const out = await collectTravelSources({ destination: '阿拉木图', international: false },
    async (q, opts) => { seen.push(opts && opts.signal); return [{ title: '小红书帖', link: 'https://www.xiaohongshu.com/explore/x1', content: 'c', date: '2026-10-01' }]; },
    { useCache: false, now, readPage: async () => { throw Error('取消后不应读取原文'); }, signal: aborted });
  assert.equal(seen.length, 0, '#32 预取消：不发起搜索');
  assert.equal(out.cancelled, true, '#32 预取消：本轮如实标记取消');
  assert.equal(out.status, 'unavailable', '#32 预取消：不产出可用结果');
}
{
  const controller = new AbortController();
  let partialCalls = 0;
  const partial = await collectTravelSources({ destination: '阿拉木图', international: false },
    async () => { if (++partialCalls >= 1) controller.abort(); return [{ title: '小红书帖', link: 'https://www.xiaohongshu.com/explore/p1', content: 'c', date: '2026-10-01' }]; },
    { useCache: true, now, readPage: null, signal: controller.signal });
  assert.equal(partial.cancelled, true, '#32 部分成功后取消：本轮不产出可用结果');
  assert.equal(partial.status, 'unavailable', '#32 部分成功后取消：不返回 partial 可用态');
  let retryCalls = 0;
  await collectTravelSources({ destination: '阿拉木图', international: false },
    async () => { retryCalls++; return [{ title: '小红书帖', link: 'https://www.xiaohongshu.com/explore/p2', content: 'c', date: '2026-10-01' }]; },
    { useCache: true, now, readPage: null });
  assert.ok(retryCalls >= 1, '#32 重试重新发起检索（未命中被取消轮次的缓存）');
}

/* 复审二轮：缓存命中前、读取阶段取消——均不产出来源、不登记 */
{
  /* 先成功一轮写入缓存（key 由 queries+temporal 决定，同参数重查命中） */
  const warm = await collectTravelSources({ destination: '阿拉木图', international: false },
    async () => [{ title: '小红书帖', link: 'https://www.xiaohongshu.com/explore/w1', content: 'c', date: '2026-10-01' }],
    { useCache: true, now, readPage: null });
  assert.equal(warm.sources.length >= 1, true, '预热：正常轮产出来源并写缓存');
  /* 预取消 + 缓存命中：不放行缓存，返回 cancelled */
  const hitCancelled = await collectTravelSources({ destination: '阿拉木图', international: false },
    async () => { throw Error('取消后不应搜索'); },
    { useCache: true, now, readPage: null, signal: AbortSignal.abort('pre') });
  assert.equal(hitCancelled.cancelled, true, '#32 缓存命中前取消：不放行缓存值');
  assert.equal(hitCancelled.sources.length, 0, '#32 缓存命中前取消：不产出可用来源');
  /* 读取阶段中途取消：读取桩返回成功但信号已断——不产出 */
  const readController = new AbortController();
  const readCancelled = await collectTravelSources({ destination: '阿勒泰', international: false },
    async () => [{ title: '小红书帖', link: 'https://www.xiaohongshu.com/explore/r1', content: 'c', date: '2026-10-01' }],
    { useCache: true, now, readPage: async () => { readController.abort(); return { read_status: 'page_excerpt', excerpt: '正文' }; }, signal: readController.signal });
  assert.equal(readCancelled.cancelled, true, '#32 读取阶段取消：本轮不产出可用结果');
  assert.equal(readCancelled.sources.length, 0, '#32 读取阶段取消：不登记来源');
}

/* ---------- R1-A:任务查询计划、多域传递、预算与任务相关性反例 ---------- */
{
  /* 多域 include 传递:国际 experience 计划两条查询分别带中文社区与海外社区域名 */
  const seenDomains = [];
  await collectTravelSources({ destination: '阿拉木图', international: true, foreignQuery: 'Almaty trip' },
    async (q, opts) => { seenDomains.push((opts && opts.domains) || null); return []; },
    { useCache: false, now, readPage: null });
  assert.deepEqual(seenDomains[0], ['xiaohongshu.com', 'mafengwo.cn', 'qyer.com'], 'R1-A:中文社区多域名显式传递');
  assert.deepEqual(seenDomains[1], ['reddit.com', 'caravanistan.com', 'backpackers.com.tw'], 'R1-A:海外社区多域名显式传递');

  /* 任务相关性:越南主题游记剔除;伊宁真实游记保留;应用推广不冒充经验(官方/guide 不受影响) */
  const yili = await collectTravelSources({ destination: '伊宁', international: false },
    async () => [
      { title: '伊宁公共交通游记', link: 'https://www.xiaohongshu.com/explore/yili1', content: '伊宁市区公交与打车体验分享', date: '2026-10-01' },
      { title: '越南下龙湾自由行攻略', link: 'https://www.xiaohongshu.com/explore/vn1', content: '越南签证与下龙湾玩法', date: '2026-10-01' },
      { title: '旅行App下载推荐排行', link: 'https://www.xiaohongshu.com/explore/app1', content: '五个旅行App下载安装推荐', date: '2026-10-01' }
    ], { useCache: false, now, readPage: null, purpose: 'experience' });
  const urls = yili.sources.map((s) => s.url);
  assert.ok(urls.some((u) => u.includes('yili1')), 'R1-A:伊宁真实游记保留');
  assert.ok(!urls.some((u) => u.includes('vn1')), 'R1-A:越南主题游记被任务相关性剔除');
  assert.ok(!urls.some((u) => u.includes('app1')), 'R1-A:应用推广不冒充旅行者经验');
  assert.ok((yili.query_diagnostics || []).some((q) => (q.task_filtered || []).length >= 2), 'R1-A:剔除原因可审计(off_topic/app_promotion)');

  /* guide 用途不受应用推广剔除影响(单纯应用询问不误删软件介绍) */
  const guideUse = await collectTravelSources({ destination: '伊宁', international: false, purpose: 'guide' },
    async () => [{ title: '旅行App推荐与下载', link: 'https://www.xiaohongshu.com/explore/app2', content: '常用旅行应用介绍', date: '2026-10-01' }],
    { useCache: false, now, readPage: null });
  assert.equal(guideUse.sources.length >= 1, true, 'R1-A:guide 用途保留应用类介绍(不误删)');

  /* 原文读取预算:普通资料补充最多两次读取 */
  let readCalls = 0;
  await collectTravelSources({ destination: '阿勒泰', international: false },
    async () => Array.from({ length: 5 }, (_, i) => ({ title: '帖' + i, link: 'https://www.xiaohongshu.com/explore/r' + i, content: 'c', date: '2026-10-01' })),
    { useCache: false, now, readPage: async () => { readCalls++; return { read_status: 'page_excerpt', excerpt: 'x' }; } });
  assert.equal(readCalls <= 2, true, 'R1-A:普通补充原文读取不超过两次');
}
