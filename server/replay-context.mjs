/* M1手动真实模型验收：30轮合成对话、成稿、预览与实际草案存储模块的保存恢复。
 * 使用真实composeJson；资料搜索注入空结果以独立评估上下文，不宣称外部交通核实。
 * node --env-file-if-exists=server/.env server/replay-context.mjs
 * CONTEXT_REPLAY_OUT可指定私有报告路径；默认系统临时目录，不写入公共CI日志正文。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {conversationTurn} from './lib/conversation.mjs';
import {composeJson} from './lib/llm.mjs';
const output=process.env.CONTEXT_REPLAY_OUT || path.join(os.tmpdir(),'mixtouring-context-replay.json');
const report={started_at:new Date().toISOString(),model:process.env.VOLC_COMPOSE_MODEL,search:'注入空结果，不核实外部事实',turns:[],calls:[],checks:[],status:'running'};
const persist=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
let state={messages:[],preferences:{},travel:{},constraints:{}},mid=0;
const deps={search:async()=>[],model:async opts=>{
  const start=Date.now(),c=JSON.parse(opts.user),call={kind:opts.kind,chars:opts.user.length+opts.schema_prompt.length,manifest:c.manifest};
  assert.ok(call.chars<=24000);
  const answer=await composeJson(opts);report.calls.push({...call,elapsed_ms:Date.now()-start,ok:!!answer});return answer;
}};
async function turn(text,action='chat'){
  const user=action==='chat'?{mid:++mid,role:'user',text}:null;
  const input={...state,action,text,current_message:user};
  let r=await conversationTurn(input,null,deps);
  if(r.status!=='ok'){
    report.turns.push({text,action,status:r.status,retry:true});persist();
    r=await conversationTurn(input,null,deps);
  }
  assert.equal(r.status,'ok',text+': '+r.reply);
  state={...state,conversation:r.conversation,preferences:{...state.preferences,...r.patch?.preferences},travel:{...state.travel,...r.patch?.travel},constraints:{...state.constraints,...r.patch?.constraints}};
  if(user)state.messages.push(user);
  state.messages.push({mid:++mid,role:'assistant',text:r.reply});
  const item={text,action,reply:r.reply,revision:r.conversation.revision,memory_count:r.conversation.memory.entries.length,summary_count:r.conversation.summaries.items.length};
  report.turns.push(item);persist();
  console.log(JSON.stringify({turn:report.turns.length,action,status:r.status,memory:item.memory_count,summaries:item.summary_count}));
  assert.equal(state.travel.outbound_window ?? null,null,'未知出发日期不被推定');
  return r;
}
const texts=[
  '从北京到阿拉木图，十天独自旅行，预算八千，必须经伊宁，因为想了解沿途文化。日期待定，先讨论不要成稿。',
  '愿意坐巴士，但不是优先坐巴士。先聊，不生成日程。',
  '自然和城区文化都想兼顾，不要只剩自然。先讨论。',
  '我不会开车，不能把自驾作为确定安排。先讨论。',
  '不想每天换住宿，尽量少搬行李。先聊取舍。',
  '先比较直达与途经城市各会增加什么安排负担，不需要实际票价。',
  '交通时间未知时，我们应该预留什么弹性？只讨论原则。',
  '不需要每天塞满活动，先说说留白有什么价值。',
  '我希望去当地市场了解生活，这只是玩法偏好，先别排日程。',
  '我想尝本地食物，但不需要你现在给具体店名，继续讨论。',
  '关于一个人安排旅行，如何减少赶路疲劳？先不改条件。',
  '住宿位置与接驳便利之间怎么权衡？只聊判断方法。',
  '先聊选择长途铁路时需要核查哪些方面，不要编班次。',
  '飞机与陆路的体验差异怎么比较？先不替我选定交通。',
  '没有日期时，现在能做哪些决定，哪些应该留待核实？',
  '我比较重视行李方便，继续讨论，不改日期或总天数。',
  '交通不确定时，安排当地活动应怎样保持可调整？',
  '我只是询问下雨时活动类型怎么替换，先不修改计划。',
  '关于换乘与住宿，应该先核实哪一项？先讨论。',
  '我不追求打卡数量，如何判断一个停留是否值得？',
  '说说直达可能更合适的情况，先不取消途经要求。',
  '如果资料只有个人经历，我们能从中参考什么？',
  '怎么区分值得探索的走法和已经能执行的方案？',
  '先讨论一个人旅行时如何留出休息和机动时间。',
  '多种交通组合可以怎样比较行李和换乘负担？',
  '如果搜索查不到某段交通，应该如何理解这个结果？',
  '先说说停留体验与额外住宿支出之间的取舍，不报实际金额。',
  '继续保留当前想法，谈谈怎样避免路线看着顺路却实际衔接困难。',
  '整理一下目前仍待核实的类别，先不要生成行程。',
  '为什么我最初坚持保留伊宁？根据我当时的选择理由回答，先不修改安排。'
];
try{
  for(let i=0;i<texts.length;i++){
    const r=await turn(texts[i]);
    assert.ok(r.conversation.requirements.required_stops.includes('伊宁'),'硬条件跨轮保留');
    assert.equal(r.conversation.requirements.trip_days,10);
    if(i===texts.length-1)assert.match(r.reply,/文化|沿途/,'记得早期决策理由');
  }
  assert.ok(state.conversation.memory.entries.some(e=>e.message_refs.includes(1)),'早期用户出处保留');
  assert.ok(state.conversation.summaries.items.length>0,'真实长对话触发增量摘要');
  report.checks.push('30轮真实用户对话：十天、伊宁、早期文化理由和日期未定保留');
  await turn('现在明确选择北京→伊宁→阿拉木图，请生成十天探索草案，交通与日期未知保持待查。');
  if(!state.conversation.draft)await turn('按已确认条件生成十天探索草案。','generate');
  assert.ok(state.conversation.draft);assert.ok(state.conversation.draft.route.includes('伊宁'));
  const store=new Map(),sandbox={window:{},console,localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)}};
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(new URL('../mixtouring-hifi/assets/draft-store.js',import.meta.url),'utf8'),sandbox);
  const snapshot=()=>JSON.parse(JSON.stringify({...state,request:{origin:'北京',destination:'阿拉木图'}}));
  const saved=sandbox.window.MTDrafts.save('M1合成验收',snapshot());assert.equal(saved.ok,true);
  const savedCount=saved.draft.versions.length;
  await turn('如果全程只有七天呢？请直接给比较预览，伊宁必须保留，当前十天正式版不要改。');
  assert.equal(state.conversation.requirements.trip_days,10);assert.ok(state.conversation.preview);
  const previewSnapshot=snapshot();state=JSON.parse(JSON.stringify(previewSnapshot));
  await turn('采用这版七天预览。','accept_preview');
  assert.equal(state.conversation.requirements.trip_days,7);assert.equal(state.conversation.preview,null);
  const saved2=sandbox.window.MTDrafts.save('M1合成验收',snapshot(),{id:saved.draft.id});assert.equal(saved2.ok,true);
  assert.equal(saved2.draft.versions.length,savedCount+1);
  const restored=sandbox.window.MTDrafts.get(saved.draft.id).versions.at(-1).snapshot;
  assert.equal(restored.conversation.requirements.trip_days,7);assert.ok(restored.conversation.memory.entries.length>0);
  assert.equal(saved2.draft.versions[0].snapshot.conversation.requirements.trip_days,10);
  report.checks.push('真实模型十天成稿、七天预览、恢复后采纳、实际草案存储模块两版保存通过');
  report.final_snapshot=JSON.parse(JSON.stringify(restored));report.preview_snapshot=previewSnapshot;
  report.status='passed';report.finished_at=new Date().toISOString();persist();
  console.log(JSON.stringify({status:report.status,turns:report.turns.length,calls:report.calls.length,output}));
}catch(error){report.status='failed';report.error=error.message;persist();console.error(error.stack);process.exitCode=1;}
