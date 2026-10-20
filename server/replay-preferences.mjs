/* M2手动真实模型验收；搜索注入空结果，独立评估偏好表达与生命周期，不核验旅行事实。
 * node --env-file-if-exists=server/.env server/replay-preferences.mjs
 * PREFERENCE_REPLAY_OUT指定本机报告，默认临时目录；不写凭据或用户旅行数据。 */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import assert from 'node:assert/strict';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';import {composeJson} from './lib/llm.mjs';
const output=process.env.PREFERENCE_REPLAY_OUT || path.join(os.tmpdir(),'mixtouring-preference-replay.json');
const backing=new Map(),env={console,window:{addEventListener(){}},localStorage:{getItem:k=>backing.get(k)??null,setItem:(k,v)=>backing.set(k,v)}};
vm.createContext(env);vm.runInContext(fs.readFileSync(new URL('../mixtouring-hifi/assets/preference-store.js',import.meta.url),'utf8'),env);
const store=env.window.MTPreferences,report={status:'running',model:process.env.VOLC_COMPOSE_MODEL,search:'注入空结果',steps:[],calls:[]};
let mid=0,state;
function fresh(){state={conversation:cleanConversation({stage:'discuss'}),messages:[],preferences:{},travel:{},constraints:{}};}
fresh();
const deps={search:async()=>[],model:async o=>{const start=Date.now();const r=await composeJson(o);report.calls.push({kind:o.kind,elapsed_ms:Date.now()-start,ok:!!r});return r;}};
function persist(){fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
async function send(text){
  const user={mid:++mid,role:'user',text},request=store.snapshotForRequest();
  const r=await conversationTurn({...state,text,current_message:user,preference_memory:request},null,deps);
  assert.equal(r.status,'ok',r.reply);
  let applied=null;
  if(r.preference_memory_upserts?.length)applied=await store.applyUpserts(r.preference_memory_upserts,user.mid,request);
  assert.ok(!applied || applied.ok,'正常版本的偏好写入成功');
  state={...state,conversation:r.conversation,preferences:{...state.preferences,...r.patch.preferences},travel:{...state.travel,...r.patch.travel},constraints:{...state.constraints,...r.patch.constraints}};
  state.messages.push(user,{mid:++mid,role:'assistant',text:r.reply});
  report.steps.push({text,reply:r.reply,upserts:r.preference_memory_upserts,profile:store.snapshotForRequest(),current_preferences:state.preferences});persist();
  console.log(JSON.stringify({step:report.steps.length,status:r.status,active:store.list().map(e=>e.key+':'+e.value)}));return r;
}
try{
  await send('先讨论旅行方式，目的地未定。以后旅行我都更喜欢坐火车，请记为长期偏好。');
  assert.equal(store.isEnabled(),false);assert.equal(store.list().length,0);
  await store.setEnabled(true);fresh();
  await send('请长期记住：以后每次旅行我都优先铁路。目的地还没定，先讨论不要生成路线。');
  assert.equal(store.list().find(e=>e.key==='preferred_mode')?.value,'rail','已开启空库记录第一条真实长期偏好');
  const firstId=store.list().find(e=>e.key==='preferred_mode').id;
  await send('这次交通偏好改为飞机，但以后旅行仍优先铁路，长期偏好不改。');
  assert.equal(state.preferences.preferred_mode,'plane');assert.equal(store.list().find(e=>e.key==='preferred_mode').value,'rail');
  fresh();const recall=await send('只查询：我长期偏好的交通方式是什么？这次还没有确定出发地、目的地或日期，不改记忆。');
  assert.match(recall.reply,/铁路|火车/);assert.equal(state.travel.outbound_window ?? null,null);assert.equal(state.constraints.budget_max_cny ?? null,null);assert.deepEqual(state.conversation.requirements.required_stops,[]);
  await send('纠正长期偏好：以后旅行更喜欢航班，请把长期交通偏好改为航班。这次暂不安排路线。');
  assert.equal(store.list().find(e=>e.key==='preferred_mode').value,'plane');assert.equal(store.list().find(e=>e.key==='preferred_mode').id,firstId);
  const user={mid:++mid,role:'user',text:'新的长期要求：以后改成优先火车，记住这一条。'},old=store.snapshotForRequest();
  const pending=conversationTurn({...state,text:user.text,current_message:user,preference_memory:old},null,deps);
  await store.remove(firstId);const response=await pending;assert.equal(response.status,'ok');assert.ok(response.preference_memory_upserts.length);
  const late=await store.applyUpserts(response.preference_memory_upserts,user.mid,old);assert.equal(late.reason,'stale_response');assert.equal(store.list().length,0);
  report.steps.push({text:user.text,late_response:late,profile:store.snapshotForRequest()});persist();
  await send('现在重新明确授权：以后旅行优先铁路，重新记住这个长期偏好。');
  assert.equal(store.list().find(e=>e.key==='preferred_mode').value,'rail');
  await store.setEnabled(false);fresh();
  const off=await send('以后旅行更重视自然，目的地未定，先讨论。');assert.deepEqual(off.preference_memory_upserts,[]);assert.equal(store.isEnabled(),false);
  assert.equal(store.entries().filter(e=>e.status==='active').length,1,'关闭后保留已有记录，但不记新内容');
  report.status='passed';report.finished_at=new Date().toISOString();persist();console.log(JSON.stringify({status:report.status,calls:report.calls.length,output}));
}catch(error){report.status='failed';report.error=error.message;persist();console.error(error.stack);process.exitCode=1;}
