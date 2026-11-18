import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {reasoningEffort,withModelSettings,reasoningBudget,modelStageTimeout} from './lib/model-settings.mjs';
import {composeJson,composeModelInfo} from './lib/llm.mjs';
import {relevanceReviewer} from './lib/source-relevance.mjs';
import {conversationTurn} from './lib/conversation.mjs';
process.env.MT_LLM_USAGE_LOG=new URL('./logs/tests/model-settings.jsonl',import.meta.url).pathname.replace(/^\/(\w:)/,'$1');
process.env.OPENAI_KEY='fixture-openai';delete process.env.OPENAI_API_KEY;delete process.env.MT_COMPOSE_PROVIDER;delete process.env.OPENAI_PROXY_URL;
assert.equal(composeModelInfo().provider,'openai');
assert.throws(()=>reasoningEffort('none'),e=>e.status===400);
assert.throws(()=>reasoningEffort({effort:'high'}));
assert(modelStageTimeout({timeoutMs:12000},'low',100000)>12000);
assert.equal(modelStageTimeout({instruction_phase:'compose'},'max',1234),1234);
assert(reasoningBudget('max').turnMs<840000);
const originalFetch=globalThis.fetch,seen=[],usage=[];
try{
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);await wait(body.reasoning_effort==='high'?8:1);seen.push(body.reasoning_effort);return {ok:true,json:async()=>({model:body.model,choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};};
 await Promise.all(['high','low'].map(effort=>withModelSettings({effort,deadlineAt:Date.now()+10000},async()=>{await wait(effort==='high'?1:3);await composeJson({user:'JSON',onUsage:u=>usage.push(u)});} )));
 assert.deepEqual(seen.sort(),['high','low']);assert.deepEqual(usage.map(u=>u.reasoning_effort).sort(),['high','low']);
 const cancelled=new AbortController();cancelled.abort();assert.equal(await composeJson({user:'JSON',signal:cancelled.signal}),null);assert.equal(seen.length,2);
}finally{globalThis.fetch=originalFetch;}
let calls=0;
const reviewed=await relevanceReviewer(async o=>{calls++;o.onFailure({reason_code:'timeout',retryable:true,retry_handled:true});return null;})({},[{url:'https://example.org',title:'游览',excerpt:'游览资料'}]);assert.equal(calls,1);assert.equal(reviewed.status,'unavailable');
const previous={brief:{origin:'北京',destination:'河内'},stage:'ready',requirements:{trip_days:7,required_stops:['河内']}};
let failedCalls=0;
const result=await conversationTurn({text:'想去河内',conversation:previous},{},{model:async o=>{failedCalls++;o.onFailure?.({reason_code:'timeout',retryable:true,retry_handled:true});return null;}});
assert.equal(result.status,'unavailable');assert.equal(failedCalls,1);assert.equal(result.conversation.brief.destination,'河内');
await assert.rejects(conversationTurn({text:'hello',reasoning_effort:'invalid'},null,{model:()=>assert.fail('不能发起模型请求')}),e=>e.status===400);
console.log('✓ GPT默认选择、推理白名单与并发隔离、阶段与整轮上限、取消、来源不重复重试、失败保留通过');
// 成稿失败必须在原始调用处终止，不能把null当成缺少日卡再发起整稿。
const {conversationTurn:confirmedTurn}=await import('./fixtures/confirmed-conversation.mjs');
let composeCalls=0;
const failed=await confirmedTurn({action:'generate',conversation:{stage:'ready',brief:{origin:'A',destination:'B'},requirements:{trip_days:2}},travel:{trip_type:'round_trip'}},null,{search:async()=>[],model:async o=>{composeCalls++;o.onFailure?.({reason_code:'timeout',retryable:true,retry_handled:true});return null;}});
assert.equal(composeCalls,1);assert.equal(failed.status,'unavailable');assert.equal(failed.conversation.draft,null);
