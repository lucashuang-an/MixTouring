import {runMapTool} from './lib/map-tool.mjs';
import assert from 'node:assert/strict';
import {createAgentRuntime} from './lib/agent-runtime.mjs';
import {checkTravelDelivery,nextConversationAction,researchTaskSatisfied,taskOutcome} from './lib/travel-completion.mjs';
import {conversationTurn} from './lib/conversation.mjs';
const events=[],rt=createAgentRuntime({onEvent:e=>events.push(e)});let calls=0;
rt.register('search',{readOnly:true,validate:a=>typeof a?.query==='string',execute:async()=>{calls++;return [{url:'https://example.org',title:'资料'}];}});
const [a,b]=await Promise.all([rt.call('search',{query:'景点'},{scope:{date:'2027'}}),rt.call('search',{query:'景点'},{scope:{date:'2027'}})]);
assert.equal(calls,1);assert.equal(a.status,'success');assert.equal(b.reused,true);assert.notEqual(a.call_id,b.call_id);
a.data[0].title='被修改';const c=await rt.call('search',{query:'景点'},{scope:{date:'2027'}});assert.equal(c.data[0].title,'资料');
await rt.call('search',{query:'景点'},{scope:{date:'2028'}});assert.equal(calls,2,'日期改变不能复用旧结果');
assert.equal((await rt.call('unknown',{})).status,'error');assert.equal((await rt.call('search',{query:1})).reason,'invalid_arguments');
rt.register('empty',{validate:()=>true,execute:async()=>[],classify:v=>v.length?'success':'empty'});assert.equal((await rt.call('empty',{})).status,'empty');
rt.register('fail',{validate:()=>true,execute:async()=>{throw Error('secret-test-value');}});assert.equal((await rt.call('fail',{})).reason,'tool_failed');assert.ok(!JSON.stringify(events).includes('secret-test-value'));
let state={requirements:{trip_days:3}};const request=rt.prepareRequest({current:{requirements:{trip_days:10}}},{current:state});state.requirements.trip_days=5;
assert.equal(request.current.requirements.trip_days,3);assert.equal(rt.prepareRequest({current:{}},{current:state}).current.requirements.trip_days,5);
assert.ok(request.execution_observations.every(o=>!Object.hasOwn(o,'data')),'原始外部数据不直接混入权威状态');
const cancelled=createAgentRuntime(),ac=new AbortController();cancelled.register('late',{validate:()=>true,execute:async()=>{ac.abort();return ['late'];}});
await assert.rejects(cancelled.call('late',{}, {signal:ac.signal}),e=>e.code==='RUN_INTERRUPTED');
const stopped=cancelled.finish({taskState:'satisfied'});assert.equal(stopped.run.status,'interrupted');assert.equal(stopped.task.state,'active');assert.equal(cancelled.observations[0].status,'interrupted');
const draft={title:'三天',route:['甲','乙'],cards:[{id:'card-day-1',label:'第1天',title:'出发',content:'出发。'}]};
const checked=checkTravelDelivery({draft,routing:{origin:'甲',destination:'乙'},requirements:{trip_days:3,required_stops:['丙']},numeric:{rejected:[]}});
assert.equal(checked.passed,false);assert.ok(checked.checks.some(c=>c.name==='required_stops'&&c.status==='failed'));assert.ok(checked.checks.some(c=>c.name==='day_coverage'&&c.status==='failed'));
const brief={origin:'上海',destination:'济州岛',summary:'三天',wishes:[],open_questions:[]},seen=[];
const out=await conversationTurn({text:'查询济州岛资料'},null,{onTrace:e=>seen.push(e),search:async()=>[],model:async o=>{
 const p=JSON.parse(o.user);
 if(o.instruction_phase==='answer')assert.ok(p.execution_observations.some(x=>x.status==='empty'));
 return {intent_action:'question',reply:'尚未找到匹配资料。',brief,ready:true,search_query:'济州岛 资料',preferences:{},travel:{},constraints:{},requirements_patch:{},sights:{}};
}});
assert.equal(out.status,'ok');assert.equal(out.run.status,'completed');assert.notEqual(out.task.state,'satisfied');assert.ok(seen.some(e=>e.stage==='tool_result'));assert.ok(seen.some(e=>e.stage==='context_prepared'));
const interrupted=await conversationTurn({text:'三天',conversation:{stage:'ready',brief}},null,{budgetMs:10,model:async()=>{await new Promise(r=>setTimeout(r,25));return {reply:'晚到的结果'};}});
assert.equal(interrupted.run.status,'interrupted');assert.equal(interrupted.task.state,'active');assert.equal(interrupted.conversation.brief.summary,'三天');
console.log('✓ 通用运行层：工具协议、并发去重、条件隔离、上下文重建、迟到结果丢弃、交付检查与任务状态分离');

const map=await runMapTool('map_day',{city:'甲',places:['公园']},{resolveDay:async()=>({points:[{name:'公园',lat:1,lon:2}],status:'complete',attribution:'test'})});
assert.equal(map.run.status,'completed');assert.equal(map.task.state,'satisfied');assert.equal(map.attribution,'test');

assert.equal(checkTravelDelivery({draft:{...draft,route:[]},routing:{origin:'甲',destination:'乙'},requirements:{trip_days:1}}).passed,false,'正式日卡不能遗漏路线端点');

const stalled=createAgentRuntime();let attempts=0;stalled.register('read',{readOnly:true,validate:()=>true,execute:async()=>{attempts++;throw Error('network');}});
await stalled.call('read',{url:'x'});await stalled.call('read',{url:'x'});
assert.equal((await stalled.call('read',{url:'x'})).reason,'repeated_failure');assert.equal(attempts,2);assert.equal(stalled.interruption,null,'重复失败只拦工具，不结束用户任务');
await stalled.call('read',{url:'x'},{scope:{changed:true}});assert.equal(attempts,3,'新条件允许重新尝试');
assert.equal(nextConversationAction({status:'ok',conversation:{stage:'ready',revision:1}}).type,'none');
assert.equal(nextConversationAction({status:'ok',request_route_discovery:true,conversation:{stage:'ready',revision:1}}).type,'discover_routes');
assert.equal(researchTaskSatisfied({resolution:'partial',verifyStatus:'complete',claims:[{}]}),false);
assert.equal(researchTaskSatisfied({verifyStatus:'complete',claims:[{}]}),false,'规划器done不能替代解决判断');
assert.equal(researchTaskSatisfied({resolution:'answered',verifyStatus:'complete',claims:[{}]}),true);
assert.equal(researchTaskSatisfied({resolution:'answered',verifyStatus:'partial',claims:[{}]}),false);
assert.equal(researchTaskSatisfied({resolution:'answered',verifyStatus:'complete',claims:[{}],interrupted:true}),false);

assert.equal(taskOutcome({status:'ok',task_status:'discussed',delivery_validation:{passed:true},conversation:{draft:{},preview:{draft:{}}}}),'active','旧稿和旧预览存在不表示当前问题完成');
assert.equal(taskOutcome({status:'ok',task_status:'answered',delivery_validation:{passed:true},conversation:{}}),'satisfied');

const {validationModelCapacity}=await import('./lib/agent-runtime.mjs');
assert.equal(validationModelCapacity(0),20);assert(validationModelCapacity(80)>validationModelCapacity(20));assert.equal(validationModelCapacity(10000),80);
