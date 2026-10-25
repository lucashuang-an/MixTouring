/* Agent API验证；--in-process 直接驱动相同生产路由，不替代HTTP验收。 */
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
const base=process.env.VERIFY_BASE || 'http://localhost:'+(process.env.PORT || 3000);
const inProcess=process.argv.includes('--in-process');
const router=inProcess?(await import('./index.mjs')).apiRouter:null;
async function request(path,body){
  if(!inProcess){const res=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,text:await res.text()};}
  const ctx={path,method:body===undefined?'GET':'POST',req:Readable.from(body===undefined?[]:[JSON.stringify(body)]),res:new EventEmitter(),status:200,set(){}};
  await router(ctx,async()=>{});
  if(ctx.body && typeof ctx.body[Symbol.asyncIterator]==='function'){let text='';for await(const chunk of ctx.body)text+=chunk;return {status:ctx.status,text};}
  return {status:ctx.status,text:JSON.stringify(ctx.body)};
}
const json=async(path,body)=>JSON.parse((await request(path,body)).text);
assert.equal((await json('/healthz')).status,'ok');
const caps=(await json('/api/capabilities')).data;
assert.equal(caps.planning_mode,'search_first');assert.equal(caps.llm,false,'无密钥验收不能混用真实模型服务');
for(const path of ['/api/bootstrap','/api/plans','/api/templates','/api/inspirations','/api/anywhere/sights','/api/wishlist/process']){
  const result=await request(path,{});assert.equal(result.status,410);assert.equal(JSON.parse(result.text).code,1);
}
for(const path of ['/api/anywhere/plan','/api/anywhere/search-plan'])for(const progressive of [false,true]){
  const response=await request(path,{origin:'库外起点甲',destination:'库外终点乙',progressive});
  const result=progressive?response.text.trim().split('\n').map(s=>JSON.parse(s)).at(-1):JSON.parse(response.text);
  assert.equal(result.code,0);assert.equal(result.data.status,'unavailable');assert.equal(result.data.planning_mode,'search_first');
  assert.equal(result.data.intent.destination,'库外终点乙');assert.equal(result.data.candidates.length,0);assert.ok(!result.data.plan_id);
  assert.equal(result.data.discovery_metrics.model_calls,1);assert.equal(result.data.discovery_metrics.search_calls,0);
}
assert.equal((await json('/api/anywhere/plan',{})).code,1);
assert.equal((await json('/api/anywhere/compare',{plan_id:'fabricated'})).code,1);
assert.equal((await json('/api/anywhere/journey',{plan_id:'fabricated',candidate_id:'fabricated'})).code,1);
assert.equal((await json('/api/anywhere/research-loop-status',{task_id:'fabricated'})).code,1);
console.log('✓ Agent API：缺模型不伪造成功、任意端点保留、旧库接口退役、无伪造上下文与隐式搜索'+(inProcess?'（进程内）':''));
