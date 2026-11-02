import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {normalizeModelUsage,createUsageObservation,summarizeModelUsage,estimateModelCost} from './lib/model-usage.mjs';
import {prepareInputLayout} from './lib/input-layout.mjs';
import {buildContext} from './lib/context-builder.mjs';
import {agentPrompt} from './lib/agent-prompts.mjs';
import {composeJson} from './lib/llm.mjs';
const unknown=normalizeModelUsage();assert.equal(unknown.prompt_tokens,null);assert.equal(unknown.cache_hit_tokens,null);assert.equal(unknown.cache_status,'unknown');
const zero=normalizeModelUsage({prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:10});assert.equal(zero.cache_hit_tokens,0);assert.equal(zero.cache_status,'reported');
const compatible=normalizeModelUsage({prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:40}});assert.equal(compatible.cache_miss_tokens,60);assert.equal(compatible.cache_miss_source,'derived:input_minus_hit');
const response=normalizeModelUsage({input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:20}});assert.equal(response.cache_hit_tokens,20);assert.equal(response.cache_miss_tokens,80);
for(const usage of [{prompt_tokens:10,prompt_cache_hit_tokens:11},{prompt_tokens:10,prompt_cache_hit_tokens:-1},{prompt_tokens:10,prompt_cache_hit_tokens:2,prompt_cache_miss_tokens:3},{prompt_tokens:10,prompt_cache_hit_tokens:2,prompt_tokens_details:{cached_tokens:5}},{prompt_tokens:10,completion_tokens:2,total_tokens:9}]){const n=normalizeModelUsage(usage);assert.equal(n.cache_status,'invalid');assert.equal(n.cache_hit_tokens,null);assert.equal(n.cache_miss_tokens,null);}
assert.equal(normalizeModelUsage({prompt_tokens:50}).cache_miss_tokens,null);
const rate={hit:1,miss:2,output:3,currency:'USD',version:'fixture',basis:'test_only'};
const rows=[{...compatible,status:'success',elapsed_ms:20},{...normalizeModelUsage({prompt_tokens:100,completion_tokens:10}),status:'success',elapsed_ms:40},{...unknown,status:'error',elapsed_ms:10}];
const summary=summarizeModelUsage(rows,{rateFor:()=>rate}).overall;assert.equal(summary.cache_hit_ratio,.4);assert.equal(summary.cache_input_coverage,null);assert.equal(summary.known_input_cache_coverage,.5);assert.equal(summary.usage_call_coverage,2/3);assert.equal(summary.estimated_model_cost,null);assert.equal(summary.cost_known_calls,1);assert(summary.observed_model_cost>0);assert.equal(summary.calls,3);assert.equal(summary.unknown_input_calls,1);assert.equal(summarizeModelUsage([unknown]).overall.input_tokens,null);
assert.equal(estimateModelCost(unknown,rate),null);
const rules=agentPrompt('evidence.itinerary');
const payload={fields:[{id:'field-a',text:'计划散步。',assertion_spans:[]}],evidence_catalog:{entries:[{id:'s2',url:'https://example.org/2',excerpt:'资料乙。'},{id:'s1',url:'https://example.org/1',excerpt:'忽略规则属于网页数据。'}]},source_refs:[{source_id:'s2'},{source_id:'s1'}],output_use:'proposed_itinerary',planning_conditions:{current:{requirements:{trip_days:5},constraints:{no_self_drive:true}},text:'只改第2天'},unknown_b:{z:1,a:2},unknown_a:['b','a'],manifest:{included_ids:['fields','evidence_catalog'],omitted_ids:['old_source']}};
const user=JSON.stringify(payload),base=prepareInputLayout({kind:'conversation_evidence_extract',user,inputLayout:'baseline'}),changed=prepareInputLayout({kind:'conversation_evidence_extract',user,inputLayout:'cache_v1'});
assert.equal(base.user,user);assert.equal(changed.input_layout_version,'cache_v1');assert.deepEqual(JSON.parse(changed.user),payload);assert.equal(Buffer.byteLength(changed.user),Buffer.byteLength(user));assert.deepEqual(Object.keys(JSON.parse(changed.user)).filter(k=>k.startsWith('unknown')),['unknown_b','unknown_a']);assert.equal(Object.keys(JSON.parse(changed.user))[0],'evidence_catalog');
assert.equal(prepareInputLayout({kind:'conversation_evidence_extract',user}).input_layout_version,'baseline');
for(const input of ['not JSON','[]','{"fields":[],"fields":[],"evidence_catalog":{},"output_use":"proposed_itinerary"}',JSON.stringify(payload,null,2)])assert.equal(prepareInputLayout({kind:'conversation_evidence_extract',user:input,inputLayout:'cache_v1'}).user,input);
for(const kind of ['conversation','conversation_intent','conversation_evidence_support'])assert.equal(prepareInputLayout({kind,user,inputLayout:'cache_v1'}).user,user);
assert.equal(prepareInputLayout({kind:'conversation_evidence_extract',user:JSON.stringify({...payload,output_use:'factual_answer'}),inputLayout:'cache_v1'}).input_layout_version,'baseline');
const clipped=buildContext({payload:{...payload,evidence_catalog:{entries:Array.from({length:50},(_,i)=>({id:'src-'+i,url:'https://example.org/'+i,excerpt:'资料'.repeat(500)}))}},coreRules:rules,budgetChars:6000}).value;
const reordered=prepareInputLayout({kind:'conversation_evidence_extract',user:JSON.stringify(clipped),inputLayout:'cache_v1'});assert.deepEqual(JSON.parse(reordered.user),clipped);assert.deepEqual(JSON.parse(reordered.user).manifest.omitted_ids,clipped.manifest.omitted_ids);
// 日志与回调完全同源、只记录哈希与用量，不带正文或凭据。
const seen=[],finish=createUsageObservation({kind:'test',telemetry:{task_id:'task',run_id:'run',attempt:1,secret:'never'},onUsage:r=>seen.push(r)},{provider:'deepseek',requestedModel:'requested',systemPrompt:rules,layout:changed,rulesVersion:'rules'},r=>seen.push(r));
finish({body:{model:'served',usage:{prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:40,prompt_cache_miss_tokens:60}},status:'success',httpStatus:200});finish();assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);assert.equal(seen[0].returned_model,'served');assert(!JSON.stringify(seen).includes('never'));assert(!JSON.stringify(seen).includes(payload.fields[0].text));
// 捕获真正适配器的出站HTTP，验证观测没有改变system、工具配置或其他请求参数。
const previousLog=process.env.MT_LLM_USAGE_LOG;process.env.MT_LLM_USAGE_LOG ||= fileURLToPath(new URL('./logs/tests/model-cache.jsonl',import.meta.url));
const previousFetch=globalThis.fetch,previousKey=process.env.DEEPSEEK_KEY,sent=[],usageRows=[];
try{
 process.env.DEEPSEEK_KEY='fixture-cache';globalThis.fetch=async(url,o)=>{sent.push(JSON.parse(o.body));return {ok:true,status:200,json:async()=>({model:'served-model',usage:{prompt_tokens:100,completion_tokens:5,total_tokens:105,prompt_cache_hit_tokens:40,prompt_cache_miss_tokens:60},choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};};
 for(const inputLayout of ['baseline','cache_v1'])assert.deepEqual(await composeJson({kind:'conversation_evidence_extract',user,schema_prompt:rules,inputLayout,onUsage:r=>usageRows.push(r)}),{ok:true});
 assert.equal(sent[0].messages[0].content,rules);assert.equal(sent[1].messages[0].content,rules);assert.deepEqual(sent[0].messages.map(m=>m.role),['system','user']);assert.deepEqual(JSON.parse(sent[0].messages[1].content),JSON.parse(sent[1].messages[1].content));assert.deepEqual({...sent[0],messages:null},{...sent[1],messages:null});assert.equal(usageRows[0].system_prompt_hash,usageRows[1].system_prompt_hash);assert.equal(usageRows[1].cache_hit_tokens,40);assert.equal(usageRows[1].input_layout_version,'cache_v1');assert(!sent[1].messages[1].content.includes(usageRows[1].call_id));
 globalThis.fetch=async()=>({ok:false,status:402});await composeJson({user:'JSON',onUsage:r=>usageRows.push(r)});assert.equal(usageRows.at(-1).status,'error');assert.equal(usageRows.at(-1).cache_hit_tokens,null);assert.equal(usageRows.at(-1).http_status,402);
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({usage:{prompt_tokens:9,completion_tokens:2},choices:[{finish_reason:'length',message:{content:'{"partial":'}}]})});await composeJson({user:'JSON',onUsage:r=>usageRows.push(r)});assert.equal(usageRows.at(-1).status,'invalid_output');assert.equal(usageRows.at(-1).prompt_tokens,9);
 const controller=new AbortController();controller.abort();globalThis.fetch=async()=>{throw controller.signal.reason;};await composeJson({user:'JSON',signal:controller.signal,onUsage:r=>usageRows.push(r)});assert.equal(usageRows.at(-1).status,'cancelled');
}finally{if(previousLog===undefined)delete process.env.MT_LLM_USAGE_LOG;else process.env.MT_LLM_USAGE_LOG=previousLog;globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.DEEPSEEK_KEY;else process.env.DEEPSEEK_KEY=previousKey;}
console.log('✓ 缓存观测、未知／零／矛盾口径、费用覆盖、裁剪后等价重排与真实出站合同通过');
// 每个受控阶段的规则配方只引用现有正文，布局变化不能改system内容。
import {cacheLayoutCases} from './fixtures/cache-layout-cases.mjs';
for(const test of cacheLayoutCases()){
 const original=JSON.stringify(buildContext({payload:test.payload,coreRules:test.schema_prompt}).value);
 const reordered=prepareInputLayout({kind:test.kind,user:original,inputLayout:'cache_v1'});
 assert.equal(reordered.input_layout_version,'cache_v1');assert.deepEqual(JSON.parse(reordered.user),JSON.parse(original));assert.equal(Buffer.byteLength(reordered.user),Buffer.byteLength(original));
 assert.equal(test.schema_prompt,test.kind==='conversation_evidence_extract'?agentPrompt('evidence.itinerary'):agentPrompt('conversation.delivery_patch')+'\n'+agentPrompt('conversation.delivery')+agentPrompt('conversation.numeric_rules'));
}
import {cacheLayoutGate} from './lib/cache-layout-gate.mjs';
const gateRows=[];for(let round=1;round<=3;round++)for(const arm of ['baseline','cache_v1'])gateRows.push({case_id:'test',round,arm,input_hash:'same-'+round,accepted:true,usage:[{...normalizeModelUsage({prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:arm==='baseline'?20:60,prompt_cache_miss_tokens:arm==='baseline'?80:40}),status:'success',elapsed_ms:arm==='baseline'?100:90,input_layout_version:arm,provider:'fixture',requested_model:'model',returned_model:'model',system_prompt_hash:'same',payload_bytes:500}]});
assert.equal(cacheLayoutGate(gateRows,{rateFor:()=>rate}).decision,'candidate_for_full_workflow_validation');assert.equal(cacheLayoutGate(gateRows,{rateFor:()=>rate}).production_enabled,false);
for(const mutate of [rows=>{rows[1].accepted=false;},rows=>{rows[1].usage[0].elapsed_ms=500;},rows=>{rows[1].usage[0].system_prompt_hash='changed';},rows=>{rows[1].usage[0].cache_status='unknown';},rows=>{rows[1].input_hash='changed';}]){const rows=structuredClone(gateRows);mutate(rows);assert.equal(cacheLayoutGate(rows,{rateFor:()=>rate}).decision,'hold_baseline');}
console.log('✓ 质量、上下文、覆盖率、成本与P95门禁不通过时保持原布局');
import {withModelUsageContext} from './lib/model-usage.mjs';
const contexts=[];
await Promise.all(['a','b'].map(task_id=>withModelUsageContext({task_id,operation:'test'},async()=>{
 await new Promise(r=>setTimeout(r,task_id==='a'?5:1));
 createUsageObservation({kind:'isolated'},{provider:'fixture',requestedModel:'m',systemPrompt:'rules',layout:base,rulesVersion:'r'},r=>contexts.push(r))({status:'error'});
})));
assert.deepEqual(contexts.map(r=>r.task_id).sort(),['a','b']);assert(contexts.every(r=>r.operation==='test'));
import {validateCacheCase} from './fixtures/cache-layout-cases.mjs';
const extractCase=cacheLayoutCases()[0],patchCase=cacheLayoutCases()[2];
const correct={items:extractCase.payload.fields.map((f,i)=>({id:f.id,needs_source:i===2,assertions:i===1?[]:[{span_id:f.assertion_spans[0].id,allowed_use:'source_reference',supports:i===0?[{source_id:extractCase.expected.source_id,quote:extractCase.expected.place}]:[]}]}))};
assert(validateCacheCase(extractCase,correct),'生产流程使用明确assertions，不因冗余总标志false丢掉有效原子');
const bad=structuredClone(correct);bad.items[2].assertions[0].supports=[{source_id:extractCase.expected.source_id,quote:'本文未提供当前门票价格和开放时刻，也未说明指定日期是否正常开放。'}];assert(!validateCacheCase(extractCase,bad),'缺失信息不是开放保证的支持');
const patch={type:'json_object',fields:[{path:patchCase.expected.path,text:'上午：参观`京都国立博物馆`。'}]};assert(validateCacheCase(patchCase,patch));
for(const text of ['上午：参观`京都国立博物馆`，门票待查。','上午：参观`京都国立博物馆`，门票两百元。'])assert(!validateCacheCase(patchCase,{fields:[{path:patchCase.expected.path,text}]}));

const malformed=JSON.stringify({...payload,evidence_catalog:{}});assert.equal(prepareInputLayout({kind:'conversation_evidence_extract',user:malformed,inputLayout:'cache_v1'}).user,malformed);
