/* M2原始反例回归：真实存储脚本、并发标签、拒写、坏格式及前端到实际对话编排。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
import {sanitizeRecalledPreferences,validatePreferenceUpserts} from './lib/trip-memory.mjs';
const messages4 = () => Array.from({ length: 4 }, (_, i) => ({ mid: i + 1, role: i % 2 ? 'assistant' : 'user', text: 'm' + (i + 1) }));
const source=fs.readFileSync(new URL('../mixtouring-hifi/assets/preference-store.js',import.meta.url),'utf8');
const backing=()=>({raw:null,failRead:false,failWrite:false,writes:0});
let lockQueue=Promise.resolve();const locks={request(_name,fn){const p=lockQueue.then(fn);lockQueue=p.catch(()=>{});return p;}};
function make(data=backing()){
 const events=[];const env={console,window:{addEventListener:(name,fn)=>{if(name==='storage')events.push(fn);}},navigator:{locks},localStorage:{getItem:()=>{if(data.failRead)throw Error('拒读');return data.raw;},setItem:(_k,v)=>{if(data.failWrite)throw Error('拒写');data.raw=v;data.writes++;}}};
 vm.createContext(env);vm.runInContext(source,env);return {p:env.window.MTPreferences,data,fire:()=>events.forEach(fn=>fn({key:'mt:preference-memory'}))};
}
{
 const {p}=make();assert.equal(p.isEnabled(),false);assert.equal((await p.propose('road','exclude',1)).ok,false);
 assert.equal(await p.setEnabled(true),true);const empty=p.snapshotForRequest();assert.equal(empty.enabled,true);assert.equal(empty.preferences.length,0);
 assert.equal(sanitizeRecalledPreferences(empty).enabled,true,'开关授权不能依赖条目数量');
 assert.equal(sanitizeRecalledPreferences({enabled:'true',preferences:[]}).enabled,false);
 const first=await p.propose('preferred_mode','rail',1);assert.equal(first.ok,true);assert.equal(p.list()[0].value,'rail');
 const corrected=await p.propose('preferred_mode','plane',3);assert.equal(corrected.ok,true);assert.equal(corrected.id,first.id);assert.equal(p.list()[0].revision,1);
 assert.equal((await p.remove(first.id)).ok,true);assert.equal(p.list().length,0);assert.equal(p.entries()[0].status,'removed');
 assert.equal(sanitizeRecalledPreferences(p.snapshotForRequest()).enabled,true,'删除最后一条仍可重新记录');
 assert.equal((await p.propose('road','open',5)).ok,true);assert.equal((await p.propose('trip_days','7',7)).ok,false);
 assert.equal((await p.propose('road','非法值',7)).ok,false);assert.equal((await p.propose('pace','explore',null)).ok,false);
}
for(const operation of ['delete','close_reopen','correct']){
 const data=backing(),a=make(data);await a.p.setEnabled(true);const first=await a.p.propose('road','exclude',1),request=a.p.snapshotForRequest();const b=make(data);
 if(operation==='delete')await b.p.remove(first.id);
 if(operation==='close_reopen'){await b.p.setEnabled(false);await b.p.setEnabled(true);}
 if(operation==='correct')await b.p.propose('road','prefer_other',9);
 a.fire();const delayed=await a.p.applyUpserts([{key:'road',value:'exclude'},{key:'preferred_mode',value:'rail'}],1,request);
 assert.equal(delayed.ok,false,operation+'后旧响应整批失效');assert.equal(delayed.reason,'stale_response');
 assert.equal(a.p.list().some(e=>e.key==='preferred_mode'),false,'不能部分写入第二个候选');
 if(operation==='delete'){assert.equal(a.p.list().length,0);const fresh=await a.p.propose('road','exclude',21);assert.equal(fresh.ok,true,'新的明确授权仍能添加');}
 if(operation==='correct')assert.equal(a.p.list().find(e=>e.key==='road').value,'prefer_other');
}
{
 const data=backing(),a=make(data);await a.p.setEnabled(true);const b=make(data),ra=a.p.snapshotForRequest(),rb=b.p.snapshotForRequest();
 const results=await Promise.all([a.p.applyUpserts([{key:'road',value:'exclude'}],1,ra),b.p.applyUpserts([{key:'pace',value:'explore'}],1,rb)]);
 assert.equal(results.filter(r=>r.ok).length,1,'并发同版本响应经Web Locks只提交一批');assert.equal(make(data).p.list().length,1);
 const request=a.p.snapshotForRequest(),before=data.raw;
 const invalid=await a.p.applyUpserts([{key:'road',value:'open'},{key:'trip_days',value:'7'}],3,request);assert.equal(invalid.ok,false);assert.equal(data.raw,before,'非法批次原子拒绝');
 const cancelled=await a.p.applyUpserts([{key:'road',value:'open'}],3,request,{isCurrent:()=>false});assert.equal(cancelled.ok,false);assert.equal(data.raw,before);
}
for(const op of ['enable','remove','disable','correct','batch']){
 const data=backing(),a=make(data);let id;
 if(op!=='enable'){await a.p.setEnabled(true);id=(await a.p.propose('preferred_mode','rail',1)).id;}
 const old=data.raw;data.failWrite=true;
 const r=op==='enable'?await a.p.setEnabled(true):op==='remove'?await a.p.remove(id):op==='disable'?await a.p.setEnabled(false):op==='batch'?await a.p.applyUpserts([{key:'preferred_mode',value:'plane'},{key:'road',value:'exclude'}],3,a.p.snapshotForRequest()):await a.p.propose('preferred_mode','plane',3);
 assert.equal(typeof r==='boolean'?r:r.ok,false);assert.equal(data.raw,old,'拒写时原存储不变');
 assert.equal(a.p.status().error,'write_failed');assert.equal(a.p.isEnabled(),false,'拒写后本页暂停记忆并报告原因');
 if(op!=='enable'){assert.equal(a.p.entries()[0].value,'rail','候选不能先污染内存');assert.equal(a.p.entries().length,1,'拒写整批不部分新增');}
 data.failWrite=false;const fresh=make(data);assert.equal(fresh.p.isEnabled(),op!=='enable');a.p.reload();assert.equal(a.p.status().paused,false);
}
for(const raw of ['{损坏',JSON.stringify({schema_version:99,enabled:true,entries:[{key:'road',value:'exclude'}]}),'[]']){
 const data=backing();data.raw=raw;const a=make(data);assert.equal(a.p.isEnabled(),false);
 assert.equal(await a.p.setEnabled(true),false);assert.equal(await a.p.setEnabled(false),false);assert.equal((await a.p.remove('pref_1')).ok,false);
 assert.equal(data.raw,raw,'同一存储读取、操作后原文字节保留');assert.equal(data.writes,0);assert.equal(make(data).p.isEnabled(),false);
}
{
 const data=backing(),a=make(data);await a.p.setEnabled(true);const raw=data.raw;data.failRead=true;
 assert.equal(a.p.snapshotForRequest().enabled,false);assert.equal(await a.p.setEnabled(false),false);assert.equal(data.raw,raw);assert.equal(a.p.status().health,'read_failed');
}
{
 const recalled=sanitizeRecalledPreferences({enabled:true,preferences:[{key:'road',value:'exclude'},{key:'trip_days',value:'7'},{key:'budget_max_cny',value:'8000'}]});
 assert.deepEqual(recalled.preferences,[{key:'road',value:'exclude'}]);
 const checked=validatePreferenceUpserts({upserts:[{key:'road',value:'open'},{key:'required_stops',value:'伊宁'}]},{memoryEnabled:true});assert.equal(checked.accepted.length,1);assert.equal(checked.rejected.length,1);
}
/* 提取实际前端发送函数，并连接真实conversationTurn；请求快照、用户出处及候选落盘一起验证。 */
const helper=fs.readFileSync(new URL('./check-send-retry.mjs',import.meta.url),'utf8');
const setup=helper.slice(helper.indexOf('const html ='),helper.indexOf('const okPayload')).replace("new URL('../mixtouring-hifi/pages/trip.html', import.meta.url)","new URL('../mixtouring-hifi/pages/trip.html', baseUrl)");
const outer={readFileSync:fs.readFileSync,vm,console,process,URL,baseUrl:import.meta.url};vm.createContext(outer);vm.runInContext(setup+'\nglobalThis.make=makeEnv;',outer);
const brief={origin:'北京',destination:'阿拉木图',summary:'讨论走法',wishes:[],open_questions:[]};
for(const fault of ['throw','malformed']){
 const result=await conversationTurn({text:'以后旅行我都优先火车',current_message:{mid:1,role:'user',text:'以后旅行我都优先火车'},conversation:cleanConversation({brief}),preference_memory:{enabled:true,preferences:[],store_id:'test',revision:1}},null,{search:async()=>[],model:async o=>{
  if(o.kind==='conversation_preference_intent'){if(fault==='throw')throw Error('临时模型故障');return {};}
  return {reply:'本次对话继续。',brief,ready:true,requirements_patch:{},preferences:{},preference_memory_patch:{upserts:[{key:'preferred_mode',value:'rail'}]}};
 }});
 assert.equal(result.status,'ok','可选记忆核对失败不能丢失本轮对话');assert.equal(result.preference_memory_upserts.length,0);assert.match(result.preference_memory_notice,/暂未记录/);
}
let payloads=[],release=null,hold=false,seen=[];
const {sandbox}=outer.make(async(_url,body)=>{
 payloads.push(JSON.parse(JSON.stringify(body)));
 const model=async o=>{
  const c=JSON.parse(o.user);seen.push(c);
  if(o.kind==='conversation_preference_intent')return {upserts:body.text.startsWith('以后')?[{key:'preferred_mode',value:body.text.includes('航班')?'plane':'rail'}]:[]};
  return {reply:'本次安排继续保留。',brief,ready:true,requirements_patch:{},preferences:body.text.startsWith('这次')?{preferred_mode:'plane'}:{},preference_memory_patch:{upserts:[{key:'preferred_mode',value:body.text.includes('航班')?'plane':'rail'}]}};
 };
 const r=await conversationTurn(body,null,{model,search:async()=>[]});
 if(hold)await new Promise(resolve=>release=resolve);
 return {code:0,data:r};
});
const data=backing();sandbox.localStorage={getItem:()=>data.raw,setItem:(_k,v)=>data.raw=v};sandbox.addEventListener=()=>{};sandbox.navigator={locks};sandbox.renderPreferencePanel=()=>{};sandbox.prefMemoryFeedback='';
vm.runInContext(source,sandbox);const store=sandbox.MTPreferences;await store.setEnabled(true);
await sandbox.sendConversation('以后旅行我都优先火车');assert.equal(payloads[0].preference_memory.enabled,true);assert.equal(payloads[0].preference_memory.preferences.length,0);
assert.equal(store.list()[0].value,'rail');assert.equal(store.entries()[0].source_message_mid,payloads[0].current_message.mid);
await sandbox.sendConversation('这次改为航班，长期偏好不变');assert.equal(store.list()[0].value,'rail');assert.equal(sandbox.guideState.preferred_mode,'plane');
assert.ok(seen.some(c=>Array.isArray(c.long_term_preferences)),'真实发送路径包含召回');
await sandbox.sendConversation('以后偏好纠正为航班');assert.equal(store.list()[0].value,'plane');
hold=true;const pending=sandbox.sendConversation('以后旅行我都优先火车');while(!release)await new Promise(r=>setTimeout(r,0));
await store.remove(store.list()[0].id);release();await pending;assert.equal(store.list().length,0,'实际前端在途回复不复活已删偏好');
assert.match(sandbox.prefMemoryFeedback,/旧回复/);
console.log('✓ M2空库首条、纠正、跨标签在途失效、原子拒写、坏格式保护及真实前端编排通过');

/* ---------- G2（复审二轮 P2）：本次覆盖不隐藏长期记录——两个视图分开 ---------- */
{
  const brief = { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] };
  const seen = [];
  /* 长期 preferred_mode=rail;本次 preferences.plane → 长期记录仍完整可见,覆盖单独标注 */
  const out = await conversationTurn({ text: '我的长期交通偏好是什么?',
    conversation: cleanConversation({ stage: 'ready', brief }),
    messages: Array.from({ length: 4 }, (_, i) => ({ mid: i + 1, role: i % 2 ? 'assistant' : 'user', text: 'm' + (i + 1) })),
    preferences: { preferred_mode: 'plane' },
    preference_memory: { enabled: true, preferences: [{ key: 'preferred_mode', value: 'rail' }] } }, null,
    { model: async (opts) => { seen.push(JSON.parse(opts.user)); return { reply: '你的长期交通偏好是铁路。', brief, ready: true, confirmed: false, requirements_patch: {} }; } });
  assert.equal(out.status, 'ok', 'G2:正常完成');
  const ctx = seen[0];
  assert.deepEqual(ctx.long_term_preferences, [{ key: 'preferred_mode', value: 'rail' }],
    'G2:长期记录完整保留在模型输入(不被本次选择移出,真实模型可如实回答)');
  assert.deepEqual(ctx.current_preference_overrides, [{ key: 'preferred_mode', value: 'plane', long_term_value: 'rail' }],
    'G2:本次覆盖单独派生(本次飞机优先,长期铁路可查询)');
  assert.ok(ctx.long_term_preference_instruction.includes('如实引用'), 'G2:指令要求长期查询如实回答');
}

/* ---------- G2 补:无本次覆盖时 overrides 为空,长期照常注入 ---------- */
{
  const brief = { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] };
  const seen = [];
  await conversationTurn({ text: '继续', conversation: cleanConversation({ stage: 'ready', brief }), messages: messages4(),
    preference_memory: { enabled: true, preferences: [{ key: 'road', value: 'exclude' }] } }, null,
    { model: async (opts) => { seen.push(JSON.parse(opts.user)); return { reply: '好', brief, ready: true, confirmed: false, requirements_patch: {} }; } });
  assert.deepEqual(seen[0].long_term_preferences, [{ key: 'road', value: 'exclude' }], 'G2:无覆盖时长期照常注入');
  assert.equal(seen[0].current_preference_overrides.length, 0, 'G2:无覆盖时 overrides 为空');
}
