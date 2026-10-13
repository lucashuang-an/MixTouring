/* 检索合同：平台由 URL 确认，体验与事实分开；局部失败不影响其他来源。 */
import assert from 'node:assert/strict';
import {collectTravelSources,classifyTravelSource} from './lib/travel-sources.mjs';
const calls=[];
const search=async q=>{
  calls.push(q);
  if(q.includes('小红书'))return [
    {title:'小红书游记',link:'https://www.xiaohongshu.com/explore/abc123?utm_source=test',content:'旅行者分享湖区住宿感受'},
    {title:'同一笔记',link:'https://www.xiaohongshu.com/explore/abc123',content:'相同内容'},
    {title:'平台首页',link:'https://www.xiaohongshu.com/'},
    {title:'假链接',link:'javascript:alert(1)'}];
  if(q.includes('Reddit'))return [{title:'无车旅行讨论',link:'https://www.reddit.com/r/travel/comments/example',content:'公共交通经验'}];
  return [{title:'目的地资料',link:'https://www.kazakhstan.travel/en/regions/almaty',content:'城市与景观资料'}];
};
const r=await collectTravelSources({destination:'阿拉木图',international:true,foreignQuery:'Almaty without car trip report'},search,{useCache:false});
assert.equal(calls.length,3);assert.ok(calls.every(q=>q.length<=100));assert.ok(calls.some(q=>q.includes('Almaty')));
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
const failed=await collectTravelSources({destination:'昆明',international:false},async q=>{
  if(q.includes('小红书'))throw Error('索引不可用');
  return [{title:'实际公开资料',link:'https://example.org/kunming'}];
},{useCache:false});
assert.equal(failed.channels.length,2);assert.equal(failed.sources.length,1);assert.equal(failed.sources[0].kind,'guide');
assert.equal(failed.channels[0].status,'unavailable','未命中平台不伪造 UGC');
console.log('✓ 中文与海外经验检索、来源类型、真实平台、去重及失败兼容通过');
