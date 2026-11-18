import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccessPolicy} from './lib/access-policy.mjs';
import {createUpstreamBudget,upstreamBudgetConfig} from './lib/upstream-budget.mjs';
import {classifyModelFailure} from './lib/model-retry.mjs';
const hash=createHash('sha256').update('fixture-password').digest('hex');
const env={MT_PUBLIC:'1',MT_ACCESS_USERS:JSON.stringify({tester:hash}),MT_PUBLIC_ORIGIN:'https://example.test',MT_MAX_CONCURRENT:'1',MT_API_PER_MINUTE:'3'};
const auth='Basic '+Buffer.from('tester:fixture-password').toString('base64');
function context(headers={},path='/api/anywhere/conversation',peer='127.0.0.1'){
 return {path,req:{socket:{remoteAddress:peer}},state:{},get:name=>headers[name]||'',set(name,value){this.headers[name]=value;},headers:{}};
}
assert.throws(()=>createAccessPolicy({MT_PUBLIC:'1'}));
assert.throws(()=>createAccessPolicy({...env,MT_PUBLIC_ORIGIN:'http://example.test'}));
let now=0;const gate=createAccessPolicy(env,()=>now);let calls=0;
let ctx=context();await gate(ctx,()=>calls++);assert.equal(ctx.status,401);assert.equal(calls,0);
ctx=context({'authorization':auth,'origin':'https://evil.test'});await gate(ctx,()=>calls++);assert.equal(ctx.status,403);
let finish;const work=new Promise(resolve=>finish=resolve);
ctx=context({'authorization':auth});await gate(ctx,async()=>{calls++;ctx.body={completion:work};});
let second=context({'authorization':auth});await gate(second,()=>calls++);assert.equal(second.status,429);assert.equal(calls,1);
finish();await work;await Promise.resolve();
second=context({'authorization':auth});await gate(second,async()=>{calls++;});assert.equal(calls,2);assert.equal(second.state.accessUser,'tester');
second=context({'authorization':auth,'x-real-ip':'10.0.0.3'});await gate(second,()=>calls++);assert.equal(second.status,429,'不信任客户端伪造代理头');
now=61000;second=context({'authorization':auth});await gate(second,()=>calls++);assert.equal(calls,3);
ctx=context({},'/healthz');await gate(ctx,()=>calls++);assert.equal(calls,4);
const directory=mkdtempSync(join(tmpdir(),'mt-quota-'));
try{
 const {createPlanningSessions}=await import('./lib/planning-session.mjs');
 const sessions=createPlanningSessions({directory:join(directory,'sessions'),rulesVersion:'fixture'});
 const request={planning_session_id:randomUUID(),request_id:randomUUID(),resume_token:randomUUID(),conversation:{revision:0}};
 const alice=await sessions.run({...request,_access_user:'alice'},{execute:async()=>({status:'ok',conversation:{revision:1,owner:'alice'}})});
 const bob=await sessions.run({...request,_access_user:'bob'},{execute:async()=>({status:'ok',conversation:{revision:1,owner:'bob'}})});
 assert.equal(alice.conversation.owner,'alice');assert.equal(bob.conversation.owner,'bob');
 let release,entered=0;const barrier=new Promise(resolve=>release=resolve);
 const shared={...request,planning_session_id:randomUUID(),request_id:randomUUID(),resume_token:randomUUID()};
 await Promise.all(['alice','bob'].map(owner=>sessions.run({...shared,_access_user:owner},{execute:async()=>{if(++entered===2)release();await barrier;return {status:'ok',conversation:{revision:1,owner}};}})));
 for(const owner of ['alice','bob']){
  const restarted=createPlanningSessions({directory:join(directory,'sessions'),rulesVersion:'fixture'});
  const restored=await restarted.run({...shared,_access_user:owner},{execute:()=>{throw Error('并发同编号记录不能被另一用户覆盖');}});
  assert.equal(restored.engine,'checkpoint');assert.equal(restored.conversation.owner,owner);
 }
 const cleaned=createPlanningSessions({directory:join(directory,'sessions'),rulesVersion:'fixture',clock:()=>Date.now()+86400001});await cleaned.prune();
 for(const owner of ['alice','bob'])assert.equal(await cleaned.load(shared.resume_token,owner),null,'带身份的过期检查点正常清理');
 const path=join(directory,'quota.json'),config={path,limit:2,dailyAmount:1,rates:{model:0.5,search:0.5,map:0.5},clock:()=>now};
 let quota=createUpstreamBudget(config);quota.reserve('model');quota=createUpstreamBudget(config);quota.reserve('search');assert.throws(()=>quota.reserve('map'),e=>e.code==='UPSTREAM_BUDGET_EXCEEDED');
 now+=86400000;const simultaneous=createUpstreamBudget(config);quota.reserve('model');simultaneous.reserve('search');assert.throws(()=>quota.reserve('map'));assert.equal(simultaneous.snapshot().calls,2);
 const cost=createUpstreamBudget({...config,path:join(directory,'cost.json'),limit:100,dailyAmount:0.5});cost.reserve('model');assert.throws(()=>cost.reserve('search'));
 for(const invalid of ['{}','null','false','0','""','[]',JSON.stringify({version:1,day:'2026-02-30',calls:1,reserved:0})]){
  writeFileSync(path,invalid);assert.throws(()=>createUpstreamBudget(config));
  assert.throws(()=>quota.reserve('model'),'运行中账本损坏也不能重置额度');
  assert.equal(readFileSync(path,'utf8'),invalid,'损坏账本保持原样供恢复');
 }
 assert.throws(()=>upstreamBudgetConfig({MT_DAILY_BUDGET_CNY:'10'}));
 assert.equal(classifyModelFailure({error:{code:'UPSTREAM_BUDGET_EXCEEDED'}}).retryable,false);
}finally{rmSync(directory,{recursive:true,force:true});}
console.log('✓ 访问门禁、跨站拒绝、频率、流式并发、预算持久化／换日／损坏及不重试');
