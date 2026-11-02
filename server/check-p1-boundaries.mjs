import {progressLabel} from './lib/conversation-stream.mjs';
import {fileURLToPath} from 'node:url';
process.env.MT_LLM_USAGE_LOG ||= fileURLToPath(new URL('./logs/tests/p1-boundaries.jsonl',import.meta.url));
import assert from 'node:assert/strict';
import {retryAfterMs,classifyModelFailure,runModelAttempts} from './lib/model-retry.mjs';
import {composeJson} from './lib/llm.mjs';
import {conversationTurn} from './lib/conversation.mjs';
import {absenceOnlyEvidence,normalizeSupportDecision} from './lib/evidence-relations.mjs';
import {buildEvidenceCatalog,assessEvidenceClaims,validateEvidenceClaims} from './lib/evidence-grounding.mjs';
assert.equal(retryAfterMs('2',0),2000);assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT',1000),2000);assert.equal(retryAfterMs('-1'),null);assert.equal(retryAfterMs('invalid'),null);
for(const status of [408,425,429,500,502,503,504])assert.equal(classifyModelFailure({status}).retryable,true);
for(const status of [400,401,402,403,404,422,501,505])assert.equal(classifyModelFailure({status}).retryable,false);
assert.equal(classifyModelFailure({status:429}).reason_code,'rate_limited');
let clock=0,calls=0,reserved=0;const seen=[];
const r=await runModelAttempts({timeoutMs:2000,execute:async o=>{seen.push(o.timeoutMs);calls++;clock+=100;return calls===1?{value:null,failure:classifyModelFailure({status:429,retryAfter:'0'})}:{value:{ok:true}};},reserveRetry:()=>{reserved++;return true;}},{clock:()=>clock,random:()=>.5,wait:async ms=>{clock+=ms;}});
assert(r.value.ok);assert.equal(calls,2);assert.equal(reserved,1);assert(seen[1]<seen[0],'补试不重置阶段时限');
for(const deny of ['time','budget','cancel']){
 calls=0;clock=0;const abort=new AbortController();const result=await runModelAttempts({timeoutMs:1000,signal:abort.signal,execute:async()=>{calls++;return {value:null,failure:classifyModelFailure({status:429,retryAfter:deny==='time'?'30':null})};},reserveRetry:()=>false},{clock:()=>clock,random:()=>.5,wait:async ms=>{clock+=ms;if(deny==='cancel')abort.abort();}});
 assert.equal(calls,1);assert.equal(result.value,null);assert(result.failure.retry_handled);
}
calls=0;await runModelAttempts({execute:async()=>{calls++;return {value:null,failure:{reason_code:'invalid_json',retryable:false},decoded_failure:true};}});assert.equal(calls,1);
const oldFetch=globalThis.fetch,oldKey=process.env.DEEPSEEK_KEY;
try{
 process.env.DEEPSEEK_KEY='p1-fixture';let requests=[],usage=[],failures=[];
 globalThis.fetch=async(url,opts)=>{requests.push(JSON.parse(opts.body));return requests.length===1?{ok:false,status:429,headers:{get:()=> '0'}}:{ok:true,status:200,json:async()=>({model:'fixture',usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};};
 assert.deepEqual(await composeJson({user:'{}',schema_prompt:'JSON',timeoutMs:2000,onUsage:r=>usage.push(r),onFailure:f=>failures.push(f)}),{ok:true});assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(usage.length,2);assert.equal(usage[0].reason_code,'rate_limited');assert.equal(usage[1].physical_attempt,2);assert.equal(failures.length,0);
 let count=0;globalThis.fetch=async()=>{count++;return {ok:false,status:503,headers:{get:()=>null}};};failures=[];await composeJson({user:'{}',timeoutMs:2000,reserveRetry:()=>false,onFailure:f=>failures.push(f)});assert.equal(count,1);assert.equal(failures[0].retry_skipped,'call_budget');
 for(const status of [401,402,403]){count=0;globalThis.fetch=async()=>{count++;return {ok:false,status}};await composeJson({user:'{}',timeoutMs:2000});assert.equal(count,1);}
 const abort=new AbortController();count=0;globalThis.fetch=async()=>{count++;return {ok:false,status:429}};await composeJson({user:'{}',signal:abort.signal,onUsage:()=>abort.abort()});assert.equal(count,1);
 // 驱动真实主编排：两次429只产生两次HTTP，不被理解层再次重试，也不判永久拒绝。
 count=0;const retryEvents=[];globalThis.fetch=async()=>{count++;return {ok:false,status:429,headers:{get:()=>null}}};const limited=await conversationTurn({text:'先聊旅行想法'},null,{search:async()=>[],onTrace:e=>retryEvents.push(e)});assert(retryEvents.some(e=>e.status==='retry_wait'&&progressLabel(e)?.includes('限流')));assert.equal(count,2);assert.equal(limited.status,'unavailable');assert.notEqual(limited.run.reason,'model_provider_rejected');assert.match(limited.reply,/暂时限流/);
 // 一次限流后恢复，后续调用序号包含补试。
 count=0;usage=[];globalThis.fetch=async(url,o)=>{count++;if(count===1)return {ok:false,status:429};const p=JSON.parse(JSON.parse(o.body).messages[1].content);const value=p.fields?{items:p.fields.map(f=>({id:f.id,text:f.text,needs_source:false,allowed_use:null,supports:[]}))}:{intent_action:'discuss',reply:'你想去哪里？',brief:{origin:'',destination:'',summary:''},ready:false,planning:{action:'ask'},requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}};return {ok:true,status:200,json:async()=>({usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]})};};
 const recovered=await conversationTurn({text:'先聊旅行想法'},null,{search:async()=>[],onModelUsage:r=>usage.push(r)});assert.equal(recovered.status,'ok');assert.equal(usage[1].attempt,2);assert.equal(usage[2].attempt,3);
}finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.DEEPSEEK_KEY;else process.env.DEEPSEEK_KEY=oldKey;}
// 缺失说明必须看完整句语境，不能通过截去“未提供”伪装支持；混合句交语义核对。
const absence='本文未提供开放时间，也未说明当天是否开放。';assert(absenceOnlyEvidence(absence,{excerpt:absence}));assert(absenceOnlyEvidence('开放时间',{excerpt:absence}));assert(!absenceOnlyEvidence('该馆周一闭馆。',{excerpt:'该馆周一闭馆。'}));assert(!absenceOnlyEvidence('本文未提供票价，但明确周一开放。',{excerpt:'本文未提供票价，但明确周一开放。'}));assert(absenceOnlyEvidence('This page does not provide opening hours.',{excerpt:'This page does not provide opening hours.'}));
assert.equal(normalizeSupportDecision({decision:'supported',relation:'missing',reason:'未说明'}).decision,'uncertain');assert.equal(normalizeSupportDecision({decision:'supported',relation:'refutes',reason:'相反'}).decision,'unsupported');assert.equal(normalizeSupportDecision({decision:'supported',reason:'漏字段'}).decision,'uncertain');
const now=Date.parse('2026-11-02T00:00:00Z'),sources=[{url:'https://example.org/a',title:'开放信息',excerpt:absence,published_at:'2026-11-01',kind:'official'},{url:'https://example.org/b',title:'另一个页面',excerpt:'本页未记载开放时间。',published_at:'2026-11-01',kind:'official'}],catalog=buildEvidenceCatalog({sources,now});
let examined=0;for(const allowed_use of ['source_reference','conflict']){
 const text=allowed_use==='conflict'?'两份资料对开放时间说法冲突。':'该馆每天开放。',claims=[{text,allowed_use,supports:catalog.entries.map(e=>({source_id:e.id,quote:e.excerpt}))}];const assessment=await assessEvidenceClaims(text,catalog,claims,async()=>{examined++;return {items:[]}});assert.equal(validateEvidenceClaims(text,catalog,{claims,assessment}).grounded.length,0);
}assert.equal(examined,0,'纯缺失引用在语义核对之前拒绝');
const positive=buildEvidenceCatalog({sources:[{...sources[0],excerpt:'该馆周一开放。'},{...sources[1],excerpt:'该馆周一闭馆。'}],now});
const text='两份资料对该馆周一开放还是闭馆说法不一，仍需确认。',claims=[{text,allowed_use:'conflict',evidence_relation:'conflicting',supports:positive.entries.map(e=>({source_id:e.id,quote:e.excerpt}))}];
for(const relation of ['conflicting','supports','missing']){const assessment=await assessEvidenceClaims(text,positive,claims,async o=>({items:JSON.parse(o.user).claims.map(c=>({id:c.id,decision:'supported',relation,reason:'当前关系核对'}))}));assert.equal(validateEvidenceClaims(text,positive,{claims,assessment}).grounded.length,relation==='conflicting'?1:0);}
console.log('✓ P1：限流退避、共享时限、额度与取消、去除叠加重试，以及缺失／反驳／冲突边界通过');
// 已补试的HTTP请求随后输出无效，不能让理解层再次补试。
{
 let n=0,clock=0;const result=await runModelAttempts({timeoutMs:2000,execute:async()=>++n===1?{value:null,failure:classifyModelFailure({status:429})}:{value:null,decoded_failure:true,failure:{reason_code:'empty_response',retryable:true}}},{clock:()=>clock,wait:async ms=>{clock+=ms;},random:()=>0});assert.equal(n,2);assert.equal(result.failure.retry_handled,true);
}
import {resolveEvidenceAtoms} from './lib/evidence-spans.mjs';
const normalized=resolveEvidenceAtoms({needs_source:false,assertions:[{text:'甲馆',allowed_use:'source_reference',supports:[]}]},{id:'one',text:'甲馆'});assert.equal(normalized.needs_source,true,'已登记事实不能被矛盾的总标志隐藏');
assert.equal(resolveEvidenceAtoms({needs_source:false,assertions:[],supports:[]},{id:'one',text:'当前方案5天'}).needs_source,false,'普通用户条件不被强制当外部事实');
// 说明资料自身缺失是可支持的元信息，不能与拿缺失说明证明现实结论混淆。
{
 const text=absence,claims=[{text,allowed_use:'source_reference',evidence_relation:'supported',supports:[{source_id:catalog.entries[0].id,quote:absence}]}];
 const assessment=await assessEvidenceClaims(text,catalog,claims,async o=>({items:JSON.parse(o.user).claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'复述来源明确的缺失说明'}))}));assert.equal(validateEvidenceClaims(text,catalog,{claims,assessment}).grounded.length,1);
}
assert(!absenceOnlyEvidence('本文记载该馆未提供接送服务。',{excerpt:'本文记载该馆未提供接送服务。'}),'不把实际没有服务当成来源没提供信息');
assert(!absenceOnlyEvidence('This article states the museum does not provide shuttle services.',{excerpt:'This article states the museum does not provide shuttle services.'}));
assert(!absenceOnlyEvidence('本文未提供开放时间吗？',{excerpt:'本文未提供开放时间吗？'}),'缺失信息的提问也不是确定的缺失说明');
{
 const field={id:'x',text:'两份资料说法不一，仍需确认。'},spans=(await import('./lib/evidence-spans.mjs')).evidenceSpans(field);
 const result=resolveEvidenceAtoms({needs_source:true,assertions:[{span_id:spans.find(s=>s.text==='仍需确认').id,evidence_relation:'missing',allowed_use:'source_reference',supports:[]}]},field);
 assert.equal(result.assertions.length,0);assert.equal(result.needs_source,true,'不能因删去纯限定语而隐藏整句中可能漏登记的事实');
 const only={id:'y',text:'仍需确认。'},onlySpans=(await import('./lib/evidence-spans.mjs')).evidenceSpans(only);const clean=resolveEvidenceAtoms({needs_source:true,assertions:[{span_id:onlySpans[0].id,supports:[]}]},only);assert.equal(clean.needs_source,false);
}
// 非必需摘要阶段限流后，也停止本轮，避免其它阶段立即再次轰击同一服务。
{
 const fetchBefore=globalThis.fetch,keyBefore=process.env.DEEPSEEK_KEY;let n=0;
 try{process.env.DEEPSEEK_KEY='p1-fixture';globalThis.fetch=async()=>{n++;return {ok:false,status:429}};
 const out=await conversationTurn({text:'继续聊旅行',messages:Array.from({length:40},(_,i)=>({mid:i+1,role:i%2?'assistant':'user',text:'历史讨论'+i}))},null,{search:async()=>[]});assert.equal(n,2);assert.equal(out.run.reason,'model_rate_limited');assert.equal(out.status,'unavailable');
 }finally{globalThis.fetch=fetchBefore;if(keyBefore===undefined)delete process.env.DEEPSEEK_KEY;else process.env.DEEPSEEK_KEY=keyBefore;}
}
{
 const controller=new AbortController();const r=await runModelAttempts({signal:controller.signal,execute:async()=>{controller.abort();return {value:{late:true}};}});assert.equal(r.value,null,'取消后的迟到成功也不能被采用');
}
