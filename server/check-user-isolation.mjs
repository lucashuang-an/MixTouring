/* 两位受邀者驱动正式HTTP路由；资料fixture和无密钥失败记录均不访问供应商。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'mt-isolation-'));
for(const key of Object.keys(process.env))if(/KEY|TOKEN|SECRET|PASSWORD/.test(key))delete process.env[key];
process.env.MT_PUBLIC='1';process.env.MT_PUBLIC_ORIGIN='https://example.test';
process.env.MT_ACCESS_USERS=JSON.stringify(Object.fromEntries(['alice','bob'].map(name=>[name,createHash('sha256').update('fixture-'+name).digest('hex')])));
process.env.MT_API_PER_MINUTE='200';process.env.MT_BUDGET_FILE=join(directory,'budget.json');
process.env.MT_LLM_USAGE_LOG=join(directory,'usage.jsonl');
const {app}=await import('./index.mjs');
const {withRequestOwner,requestOwner}=await import('./lib/request-owner.mjs');
const {registerJourneyPlan,guidePlanFromId}=await import('./lib/journey.mjs');
const {resolveResearchLoop,discardResearchLoop}=await import('./lib/research-loop.mjs');
const {searchTransportSources,transportSearchCovered,transportSearchEvidence,discardTransportSearch}=await import('./lib/transport-search.mjs');
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port;
async function post(user,path,body){
 const r=await fetch(base+'/api/anywhere/'+path,{method:'POST',headers:{authorization:'Basic '+Buffer.from(user+':fixture-'+user).toString('base64'),'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal(r.status,200);return r.json();
}
try{
 const task={question:'成都茶馆有哪些体验资料',gap:'核对茶馆公开信息',task_type:'experience',destination:'成都'};
 const a=(await post('alice','research-loop',{...task,_access_user:'bob',owner:'bob'})).data;
 assert.ok(a.task.id);
 assert.equal((await post('alice','research-loop-status',{task_id:a.task.id})).data.record.task.id,a.task.id);
 for(const input of [{task_id:a.task.id},{task},{task_id:a.task.id,task,_access_user:'alice',owner:'alice'}]){
  assert.equal((await post('bob','research-loop-status',input)).data.record,null,'其他邀请身份不能按编号、任务内容或伪造身份恢复');
 }
 // 同任务并发执行后各自恢复，不以相同内容合并用户记录。
 const both=await Promise.all(['alice','bob'].map(user=>post(user,'research-loop',task)));
 assert.notEqual(both[0].data.task.id,both[1].data.task.id);
 for(const [i,user] of ['alice','bob'].entries()){
  assert.equal((await post(user,'research-loop-status',{task})).data.record.task.id,both[i].data.task.id);
 }
 assert.equal((await post('bob','research-loop-status',{task_id:a.task.id,task:{...task,destination:'上海'}})).data.mismatch,undefined,'不泄露其他用户记录是否匹配');
 assert.equal(resolveResearchLoop({task_id:a.task.id}).record,null,'本机无身份上下文不能读取邀请用户记录');
 withRequestOwner('bob',()=>discardResearchLoop([a.task.id]));
 assert.ok((await post('alice','research-loop-status',{task_id:a.task.id})).data.record,'其他用户不能删除记录');
 assert.equal(withRequestOwner('alice',()=>resolveResearchLoop({task_id:a.task.id},{now:Date.now()+900001})).record,null,'身份绑定不延长时效');
 withRequestOwner('alice',()=>discardResearchLoop([a.task.id]));
 assert.equal((await post('alice','research-loop-status',{task_id:a.task.id})).data.record,null);

 const plan={planning_mode:'search_first',places:[],intent:{origin_place:{name:'北京',kind:'city',country:'CN'},destination_place:{name:'上海',kind:'city',country:'CN'},trip_type:'one_way'},candidates:[{id:'direct',kind:'direct',legs:[{from:'北京',to:'上海',mode_guess:'plane'}]}]};
 const planId=withRequestOwner('alice',()=>registerJourneyPlan(plan));
 for(const endpoint of ['journey','compare','route-research']){
  const input={plan_id:planId,candidate_id:'direct',_access_user:'alice',owner:'alice'};
  assert.equal((await post('bob',endpoint,input)).code,1,endpoint+'拒绝他人规划编号');
 }
 assert.equal((await post('alice','journey',{plan_id:planId,candidate_id:'direct'})).code,0,'被他人读取不会删除自己的规划');
 assert.equal(guidePlanFromId(planId),null);

 const leg={from:'北京',to:'上海',mode:'plane'},now=Date.now();
 const result=await withRequestOwner('alice',()=>searchTransportSources(leg,async()=>[{title:'北京到上海开通直飞航班',link:'https://fixture.gov.cn/notice',content:'北京到上海开通直飞航班。',date:new Date(now).toISOString().slice(0,10)}],{now,useCache:false,readPage:null,mapTools:{enabled:false}}));
 const lookup={ids:[result.retrieval_id],legs:[leg]};
 assert.equal((await post('alice','transport-search-status',lookup)).data.records.length,1);
 assert.equal((await post('bob','transport-search-status',{...lookup,_access_user:'alice'})).data.records.length,0);
 assert.equal(withRequestOwner('alice',()=>transportSearchCovered(lookup.ids,leg)),true);
 assert.equal(withRequestOwner('bob',()=>transportSearchCovered(lookup.ids,leg)),false,'他人记录不能使本人的补查被跳过');
 assert.ok(withRequestOwner('alice',()=>transportSearchEvidence(lookup.ids,{route:['北京','上海']})).length);
 assert.deepEqual(withRequestOwner('bob',()=>transportSearchEvidence(lookup.ids,{route:['北京','上海']})),[],'他人资料不进入主对话证据');
 withRequestOwner('bob',()=>discardTransportSearch(lookup.ids));
 assert.equal((await post('alice','transport-search-status',lookup)).data.records.length,1);
 withRequestOwner('alice',()=>discardTransportSearch(lookup.ids));
 assert.equal((await post('alice','transport-search-status',lookup)).data.records.length,0);
 await Promise.all(['alice','bob'].map(user=>withRequestOwner(user,async()=>{await new Promise(r=>setTimeout(r,5));assert.equal(requestOwner(),user);})));assert.equal(requestOwner(),null);
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log('✓ 受邀身份隔离：正式HTTP补查、路线与交通恢复，伪造身份、同任务并发、内部证据、删除及过期');
