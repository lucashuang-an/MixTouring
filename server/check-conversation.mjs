/* 多轮对话合同：确认边界、上下文续接、失败不丢状态、模型与来源调用。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { conversationTurn } from './lib/conversation.mjs';
import {planAnywhere} from './lib/anywhere.mjs';
const brief={origin:'北京',destination:'阿拉木图',summary:'慢游，城区与自然搭配',wishes:['不想每天赶路','只住同一家住宿'],open_questions:[]};
const result=(over={})=>({reply:'先把城区和山景搭配起来。',brief,ready:true,confirmed:false,preferences:{experience:'balanced'},travel:{},constraints:{},...over});
const draft={title:'阿拉木图慢游草案',overview:'以城区为落脚点',sections:[{title:'山景安排',content:'先考虑山景，另留城区散步时间。'}],pending:['往返接驳待查']};
let contexts=[];
const model=async opts=>{contexts.push(JSON.parse(opts.user));return result({draft});};
const first=await conversationTurn({text:'想散心，城区自然都看看'},null,{model});
assert.equal(first.engine,'llm');assert.equal(first.conversation.stage,'ready');
assert.equal(first.conversation.draft,null,'未经用户确认，即使模型输出草案也不能采用');
assert.equal(first.request_generation,false);
const country=await conversationTurn({text:'想从北京去吉尔吉斯斯坦'},null,{model:async()=>result({brief:{...brief,destination:'吉尔吉斯斯坦',summary:'想去吉尔吉斯斯坦，城市未定'}})});
assert.equal(country.conversation.stage,'discuss','国家目的地继续讨论城市，不进入生成');
const countryGenerate=await conversationTurn({action:'generate',conversation:{...country.conversation,stage:'ready'}},null,{model:async()=>{throw Error('不应调用模型生成');}});
assert.equal(countryGenerate.status,'needs_intent');
const cityChosen=await conversationTurn({text:'那就从比什凯克开始',conversation:country.conversation},null,{model:async()=>result({brief:{...brief,destination:'比什凯克'}})});
assert.equal(cityChosen.conversation.stage,'ready');assert.equal(cityChosen.conversation.brief.destination,'比什凯克');
const legacy={stage:'ready',brief:{origin:'北京',destination:'吉尔吉斯斯坦（待定，倾向比什凯克+湖区）',summary:'首站比什凯克，随后湖区，偏好民宿',wishes:['湖区民宿','慢节奏']},revision:0};
const preparation=await conversationTurn({action:'prepare',conversation:legacy,messages:[{role:'assistant',text:'先飞到比什凯克，再去湖区，按此生成？'},{role:'user',text:'可以生成'}]},null,{model:async opts=>{
  assert.equal(opts.kind,'conversation_places');assert.match(JSON.parse(opts.user).messages[0].text,/飞到比什凯克/);
  return {origin:'北京',destination:'比什凯克',question:null};
}});
assert.equal(preparation.status,'ok');assert.deepEqual(preparation.routing,{origin:'北京',destination:'比什凯克'});
assert.deepEqual(preparation.conversation.brief.wishes,legacy.brief.wishes);
assert.equal(preparation.conversation.brief.destination,legacy.brief.destination,'旅行范围不丢，交通端点独立保存');
let geocoded=false;
const repairedPlan=await planAnywhere(preparation.routing,{callJson:async()=>null,searchWeb:async()=>null,osmSearch:async()=>{geocoded=true;return [];},env:{}});
assert.equal(repairedPlan.intent.destination_place.name,'比什凯克');assert.equal(geocoded,false,'不再将整段描述送进开放地图核验');
assert.ok(repairedPlan.candidates.length);
const ambiguous=await conversationTurn({action:'prepare',conversation:{...legacy,brief:{...legacy.brief,destination:'吉尔吉斯斯坦'}},messages:[{role:'user',text:'城市还没定'}]},null,{model:async()=>({origin:'北京',destination:null,question:'想先抵达哪座城市？'})});
assert.equal(ambiguous.status,'needs_intent');assert.equal(ambiguous.conversation.routing.destination,'');
const placeFailure=await conversationTurn({action:'prepare',conversation:legacy},null,{model:async()=>null});
assert.equal(placeFailure.status,'unavailable');assert.match(placeFailure.reply,/整理完成/);
const beforeEarly=contexts.length;
const early=await conversationTurn({action:'generate'},null,{model});
assert.equal(early.status,'needs_intent');assert.equal(contexts.length,beforeEarly);
const generated=await conversationTurn({action:'generate',conversation:first.conversation,anchors:{outbound:{from_city:'北京',to_city:'阿拉木图'}},constraints:{no_self_drive:true},messages:[{role:'user',text:'不每天搬住宿'}]},null,{model});
assert.equal(generated.conversation.stage,'draft');assert.equal(generated.conversation.revision,1);
assert.deepEqual(generated.patch.preferences,{},'写稿只读取确认条件，不制造新的结构化偏好');
assert.equal(contexts.at(-1).current.constraints.no_self_drive,true);
assert.equal(contexts.at(-1).user_messages[0].text,'不每天搬住宿');
assert.equal(contexts.at(-1).conversation,undefined,'校对不把旧助手和旧草案当权威条件');
const revised=await conversationTurn({text:'刚才那个山景先不去，多留城区',conversation:generated.conversation},null,{model:async opts=>{
  if(opts.kind==='conversation')assert.equal(JSON.parse(opts.user).conversation.draft.title,draft.title);
  return result({preferences:{experience:'city'},draft:{...draft,sections:[{title:'城区安排',content:'多留时间散步，暂不安排山景。'}]}});
}});
assert.equal(revised.conversation.revision,2);assert.equal(revised.patch.preferences.experience,'city');
const failed=await conversationTurn({text:'再调整',conversation:revised.conversation},null,{model:async()=>null});
assert.equal(failed.status,'unavailable');assert.deepEqual(failed.conversation,revised.conversation);
const undo=await conversationTurn({text:'撤销刚才的调整',conversation:revised.conversation,can_undo:true},null,{model:async()=>({intent_action:'undo'})});
assert.equal(undo.action,'undo');assert.deepEqual(undo.conversation,revised.conversation,'撤销由客户端历史快照恢复，模型不重写原稿');
const noUndo=await conversationTurn({text:'撤销',conversation:revised.conversation,can_undo:false},null,{model:async()=>({intent_action:'undo'})});
assert.equal(noUndo.action,null);assert.match(noUndo.reply,/没有/);
const notApplied=await conversationTurn({text:'改掉山景',conversation:revised.conversation},null,{model:async()=>result({intent_action:'revise',draft:null})});
assert.equal(notApplied.status,'unavailable','模型口头说已修改但没交付修订稿时不谎报成功');
const question=await conversationTurn({text:'先比较，不修改',conversation:revised.conversation},null,{model:async()=>result({intent_action:'question',draft,preferences:{experience:'nature'},constraints:{no_self_drive:false}})});
assert.deepEqual(question.conversation.draft,revised.conversation.draft);assert.deepEqual(question.patch.constraints,{});assert.deepEqual(question.patch.preferences,{});
const malformed=await conversationTurn({conversation:revised.conversation},null,{model:async()=>result({travel:{outbound_window:'2026-02-31 ~ 2026-02-31'}})});
assert.equal(malformed.status,'unavailable');assert.deepEqual(malformed.conversation,revised.conversation);
const durationOnly=await conversationTurn({text:'五天，住一晚中转，其他先待定'},null,{model:async opts=>{
  if(opts.kind==='conversation_calendar')return {travel:{}};
  return result({travel:{trip_type:'round_trip',outbound_window:'2026-10-14 ~ 2026-10-18'}});
}});
assert.deepEqual(durationOnly.patch.travel,{},'只有天数时，模型不得自动填今天出发或往返');
const calendarExplicit=await conversationTurn({text:'去程明天出发，返程20号',travel:{trip_type:'round_trip'}},null,{now:Date.parse('2026-10-14T03:00:00Z'),model:async opts=>{
  const travel={outbound_window:'2026-10-15 ~ 2026-10-15',return_window:'2026-10-20 ~ 2026-10-20'};
  if(opts.kind==='conversation_calendar'){assert.equal(JSON.parse(opts.user).date,'2026-10-14');return {travel};}
  return result({travel});
}});
assert.equal(calendarExplicit.patch.travel.return_window,'2026-10-20 ~ 2026-10-20','明确相对日期经模型核对后保留');
const cancelDates=await conversationTurn({text:'出发日期先不定',travel:{outbound_window:'2026-10-14 ~ 2026-10-18'}},null,{model:async opts=>{
  if(opts.kind==='conversation_calendar')return {travel:{outbound_window:null}};
  return result();
}});
assert.equal(cancelDates.patch.travel.outbound_window,null,'主模型漏掉取消日期时，意图核对仍落实用户更新');
const noGeneratedDates=await conversationTurn({action:'generate',conversation:first.conversation},null,{model:async()=>result({draft,brief:{...brief,destination:'昆明'},routing:{origin:'上海',destination:'昆明'},travel:{trip_type:'round_trip',outbound_window:'2026-10-14 ~ 2026-10-18'}})});
assert.deepEqual(noGeneratedDates.patch.travel,{},'生成步骤不能擅自添加日历日期');
assert.deepEqual(noGeneratedDates.conversation.routing,first.conversation.routing,'写稿不能改已确认的交通端点');
assert.deepEqual(noGeneratedDates.conversation.brief,first.conversation.brief,'写稿不能改已确认意图');
const changed=await conversationTurn({text:'还是换昆明吧',conversation:revised.conversation},null,{model:async opts=>opts.kind==='conversation_route_change'?{origin:'北京',destination:'昆明'}:result({brief:{...brief,destination:'昆明'},draft})});
assert.equal(changed.conversation.stage,'ready');assert.equal(changed.conversation.draft,null);
const confirm=await conversationTurn({text:'就按这个想法生成',conversation:first.conversation},null,{model:async()=>result({confirmed:true})});
assert.equal(confirm.request_generation,true);
const notFirst=await conversationTurn({text:'就生成吧'},null,{model:async()=>result({confirmed:true})});
assert.equal(notFirst.request_generation,false);
let clarificationCalls=0;
const confirmedAfterSearch=await conversationTurn({text:'确认从北京去比什凯克，按这个生成',conversation:{...first.conversation,stage:'discuss'},messages:[{role:'assistant',text:'你想从哪座城市开始？'}]},null,{
  model:async()=>++clarificationCalls===1?result({intent_action:'confirm',confirmed:true,brief:{...brief,destination:'比什凯克'},search_query:'比什凯克 自然风光'}):result({intent_action:'discuss',confirmed:false,brief:{...brief,destination:'吉尔吉斯斯坦'}}),search:async()=>[]});
assert.equal(confirmedAfterSearch.request_generation,true,'用户明确确认城市后，资料补充不能覆盖已识别的生成动作');
assert.equal(confirmedAfterSearch.conversation.brief.destination,'比什凯克');
let calls=0;
const searched=await conversationTurn({text:'还有什么自然景观'},null,{model:async opts=>{
  calls++;if(calls===1)return result({brief:{...brief,destination:'昆明'},search_query:'昆明 自然景观 官方旅游'});
  assert.equal(JSON.parse(opts.user).search_complete,true);return result();
},search:async()=>[{title:'目的地资料',link:'https://example.org/guide',content:'景观介绍',date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'})}]});
assert.equal(calls,2);assert.equal(searched.sources.length,1);
const store=new Map(),sandbox={window:{},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}};
vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('../mixtouring-hifi/assets/draft-store.js',import.meta.url),'utf8'),sandbox);
const snapshot={request:{origin:'北京',destination:'阿拉木图'},conversation:revised.conversation,messages:[{role:'user',text:'多留城区'}],constraints:{no_self_drive:true}};
const saved=sandbox.window.MTDrafts.save('AI 对话回归',snapshot);
const restored=sandbox.window.MTDrafts.get(saved.draft.id).versions[0].snapshot;
assert.equal(JSON.stringify(restored),JSON.stringify(snapshot),'意图、方案、对话与条件一起保存恢复');
await conversationTurn({...restored,text:'按刚才的偏好继续'},null,{model:async opts=>{
  const ctx=JSON.parse(opts.user);assert.equal(ctx.conversation.revision,2);assert.equal(ctx.current.constraints.no_self_drive,true);return result();
}});
console.log('✓ AI 对话确认、多轮上下文、改口、失败恢复、来源检索及私人保存合同通过');

/* ---------- #32：请求级取消与总时限（无密钥桩） ---------- */
{
  const { createRequestSignal } = await import('./lib/request-signal.mjs');
  const { EventEmitter } = await import('node:events');
  /* 断开判定：请求体读完后的 close 是正常完成，不取消；未读完即 close 才取消 */
  const done = new EventEmitter(); done.readableEnded = true;
  let doneSignal = createRequestSignal(done); done.emit('close');
  assert.equal(doneSignal.aborted, false, '#32 正常读完的 close 不当作取消');
  const partial = new EventEmitter(); partial.readableEnded = false;
  const partialSignal = createRequestSignal(partial); partial.emit('close');
  assert.equal(partialSignal.aborted, true, '#32 请求体未读完即 close 视为客户端断开');
  /* 复审 P1：等待 AI 回复时断开——请求体已读完、响应未写完即关闭 */
  const waitingRes = new EventEmitter(); waitingRes.writableEnded = false;
  const waitingSignal = createRequestSignal({ readableEnded: true, on(){} }, waitingRes);
  waitingRes.emit('close');
  assert.equal(waitingSignal.aborted, true, '#32 等待回复时客户端断开（响应未写完即 close）取消下游');
  const finishedRes = new EventEmitter(); finishedRes.writableEnded = true;
  const finishedSignal = createRequestSignal({ readableEnded: true, on(){} }, finishedRes);
  finishedRes.emit('close');
  assert.equal(finishedSignal.aborted, false, '#32 响应已写完的正常完成不取消');

  /* 预取消：signal 已中止 → 零模型调用，状态如旧 */
  const aborted = new AbortController().abort();
  let preCalls = 0;
  const preCancelled = await conversationTurn({ text: '想散心' }, null, {
    signal: AbortSignal.abort('pre'),
    model: async (opts) => { preCalls++; return result({ draft }); }
  });
  assert.equal(preCalls, 0, '#32 预取消：不调用模型');
  assert.equal(preCancelled.status, 'unavailable', '#32 预取消：如旧保留输入与状态');

  /* signal 贯穿模型调用 */
  const controller = new AbortController();
  let seenSignal = null;
  await conversationTurn({ text: '想散心' }, null, {
    signal: controller.signal,
    model: async (opts) => { seenSignal = opts.signal; return result({}); }
  });
  assert.equal(seenSignal instanceof AbortSignal, true, '#32 总取消信号传给模型出口');

  /* 中途取消：第一阶段中止后不进入后续阶段 */
  const mid = new AbortController();
  let midCalls = 0;
  const midOut = await conversationTurn({ text: '想散心' }, null, {
    signal: mid.signal,
    model: async () => { if (++midCalls === 1) mid.abort(); return result({ draft }); }
  });
  assert.equal(midCalls, 1, '#32 中途取消：不进入下一模型阶段');
  assert.equal(midOut.status, 'unavailable', '#32 中途取消：不产出成功状态');

  /* 总预算耗尽：阶段睡眠超过预算，后续阶段不启动 */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let slowCalls = 0;
  const budgeted = await conversationTurn({ text: '想散心' }, null, {
    budgetMs: 50,
    model: async () => { slowCalls++; await sleep(120); return result({ draft }); }
  });
  assert.equal(slowCalls, 1, '#32 总预算耗尽：不启动后续阶段');
  assert.equal(budgeted.status, 'unavailable', '#32 总预算耗尽：如实不可用');

  /* 正常成功不受小预算外的大预算影响：120s 预算下正常路径完成 */
  const normal = await conversationTurn({ text: '想散心，城区自然都看看' }, null, { model });
  assert.equal(normal.status, 'ok', '#32 正常成功路径不因总时限退化');
}
