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
assert.equal(calls.length,7);assert.ok(calls.every(q=>q.length<=100));assert.ok(calls.some(q=>q.includes('Almaty')));
assert.equal(r.sources.length,3);assert.equal(r.sources[0].platform,'小红书');assert.equal(r.sources[0].kind,'experience');
assert.equal(r.sources[1].platform,'Reddit');assert.equal(r.sources[2].kind,'official');
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
const failed=await collectTravelSources({destination:'昆明',international:false},async q=>{
  if(q.includes('site:xiaohongshu.com'))throw Error('索引不可用');
  return [{title:'实际公开资料',link:'https://example.org/kunming',date:'2026-10-01'}];
},{useCache:false,now});
assert.equal(failed.channels.length,4);assert.equal(failed.sources.length,1);assert.equal(failed.sources[0].kind,'guide');
assert.equal(failed.channels[0].status,'unavailable','未命中平台不伪造 UGC');
console.log('✓ 中文与海外经验检索、来源类型、真实平台、去重及失败兼容通过');

assert.ok(r.channels.find(c=>c.channel==='马蜂窝').status==='empty','别站结果不能冒充平台命中');
assert.ok(calls.filter(q=>q.includes('site:')).every(q=>(q.match(/site:/g)||[]).length===1),'每个平台独立检索');

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

/* #32：取消信号贯穿检索与原文读取——预取消不启动读取，搜索桩收到 signal */
{
  const seen = [];
  const aborted = AbortSignal.abort('pre');
  const out = await collectTravelSources({ destination: '阿拉木图', international: false },
    async (q, opts) => { seen.push(opts && opts.signal); return [{ title: '小红书帖', link: 'https://www.xiaohongshu.com/explore/x1', content: 'c', date: '2026-10-01' }]; },
    { useCache: false, now, readPage: async () => { throw Error('取消后不应读取原文'); }, signal: aborted });
  assert.equal(seen.length > 0 && seen.every((s) => s === aborted), true, '#32 搜索调用收到请求取消信号');
  assert.equal(out.reader.available, 0, '#32 预取消：不读取原文');
  assert.equal(out.status, 'available', '#32 搜索本身可完成，仅读取被跳过（不缓存成功与本轮无关）');
}
