/* 手动真实模型验收：仅使用已授权的脱敏示例，会产生模型调用；不纳入无密钥 CI。 */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {conversationTurn} from './lib/conversation.mjs';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';

if(!process.env.LLM_API_KEY && !process.env.VOLC_SEARCH_API_KEY)throw Error('需要配置现用模型；本脚本不以模板代替真实模型。');
const plan={candidates:[
  {id:'direct',kind:'direct',legs:[{from:'北京',to:'阿拉木图',mode_guess:'plane'}]},
  {id:'overland',kind:'discovered',legs:[{from:'北京',to:'乌鲁木齐',mode_guess:'rail'},{from:'乌鲁木齐',to:'阿拉木图',mode_guess:'road'}]}
]};
const report={sampled_at:new Date().toISOString(),complete:false,
  note:'真实模型、固定探索候选、搜索桩；验证对话、日序覆盖与状态合同，不验证广泛路线发现质量或真实交通可执行性。',turns:[]};
let input={messages:[],preferences:{},travel:{},constraints:{},displayed_candidate_ids:['direct','overland']};
const save=()=>writeFileSync(new URL('../pipeline/out/workspace-replay.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
async function turn(text,action='chat'){
  const started=Date.now(), r=await conversationTurn({...input,text,action},plan,{search:async()=>[]});
  report.turns.push({text,action,elapsed_ms:Date.now()-started,...r});save();
  console.log(JSON.stringify({text,status:r.status,requirements:r.conversation.requirements,preview:r.conversation.preview?.requirements,route:r.conversation.draft?.route,cards:r.conversation.draft?.cards.length}));
  assert.equal(r.status,'ok','真实模型须完成回复');
  input={...input,conversation:r.conversation,preferences:{...input.preferences,...r.patch.preferences},travel:{...input.travel,...r.patch.travel},constraints:{...input.constraints,...r.patch.constraints},messages:[...input.messages,{role:'user',text},{role:'assistant',text:r.reply}]};
  const draft=input.conversation.preview?.draft || input.conversation.draft;
  const days=(input.conversation.preview?.requirements || input.conversation.requirements).trip_days;
  if(draft){const coverage=workspace.dayCoverage(draft,days);if(coverage)assert.deepEqual(coverage,{missing:[],outside:[]},'逐日卡片完整覆盖全程天数');
    if(input.travel.trip_type!=='round_trip' && !input.travel.return_window)assert.ok(!draft.cards.some(c=>/返程|回程/.test(c.title+' '+c.content)),'未确认返程不能混入逐日卡');}
  assert.ok(!input.travel.outbound_window && !input.travel.return_window,'未知日期不能擅补');
  return r;
}
try{
  await turn('我想从北京去阿拉木图，10天，一个人，预算8000元，喜欢自然和本地文化，愿意坐长途巴士。');
  assert.equal(input.conversation.requirements.trip_days,10);assert.notEqual(input.travel.trip_type,'round_trip');assert.ok(!input.preferences.destination_days);
  const confirmation=await turn('确认，就按这些想法生成初稿');assert.equal(confirmation.request_generation,true);
  await turn('生成已确认的旅行草案','generate');assert.ok(input.conversation.draft.cards.length);
  await turn('我喜欢第二条路线，但是希望加入伊宁。');
  assert.deepEqual(input.conversation.draft.route,['北京','乌鲁木齐','伊宁','阿拉木图']);assert.ok(input.conversation.requirements.required_stops.includes('伊宁'));
  const before=JSON.stringify(input.conversation.draft);
  await turn('如果我只有7天呢？');assert.equal(input.conversation.requirements.trip_days,10);assert.equal(input.conversation.preview?.requirements.trip_days,7);assert.equal(JSON.stringify(input.conversation.draft),before,'预览保留当前草案及卡片身份');
  await turn('采用这个预览','accept_preview');assert.equal(input.conversation.requirements.trip_days,7);
  await turn('跨境交通必须是经过核实的。');
  assert.equal(input.conversation.requirements.verified_cross_border_only,true);assert.ok(input.conversation.draft.route.includes('伊宁'));
  assert.equal(input.constraints.budget_max_cny,8000);assert.equal(input.travel.traveler_count,1);
  assert.ok(input.conversation.draft.pending.some(p=>p.includes('尚不能证明')));
  report.complete=true;save();console.log('✓ 原始四轮用例、确认生成、七天预览与采纳、硬要求及日序覆盖通过');
}catch(error){report.error=error.message;save();console.error('真实回放未通过：'+error.message.split('\n')[0]);process.exitCode=1;}
