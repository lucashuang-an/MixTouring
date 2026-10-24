/* 手动真实模型回放，只使用脱敏测试想法；不加入无密钥 CI。 */
import { writeFileSync } from 'node:fs';
import { conversationTurn } from './lib/conversation.mjs';
import { planAnywhere } from './lib/anywhere.mjs';
const report={sampled_at:new Date().toISOString(),cases:[]};
for(const scenario of [
  {name:'城区自然与改口',turns:['想从北京去阿拉木图休息一下，城区和自然都想兼顾，但别每天赶路','在目的地留三天，不会开车，住同一个地方，晚上散步找吃的，日期还没定','确认，就按这个思路生成吧','山景那天先不去了，多给城区和吃饭留点时间，别动其他安排']},
  {name:'未定目的地与非枚举偏好',turns:['从上海出发，想找一个适合慢慢吃东西和散步的地方，先帮我想想','先选昆明吧，留四天，不想每天安排早起，预算暂时不定','就按这些想法做一个初稿','如果下雨的话怎么调？先说说，不用改方案']}
]) {
  let input={messages:[],preferences:{},travel:{},constraints:{}},plan=null;
  const record={name:scenario.name,turns:[]};
  for(const text of scenario.turns){
    const start=Date.now();
    let r=await conversationTurn({...input,text},plan);
    record.turns.push({text,elapsed_ms:Date.now()-start,...r});
    console.log(scenario.name,r.status,r.conversation.stage,r.reply);
    if(r.status!=='ok')break;
    input={...input,conversation:r.conversation,preferences:{...input.preferences,...r.patch.preferences},travel:{...input.travel,...r.patch.travel},constraints:{...input.constraints,...r.patch.constraints},messages:[...input.messages,{role:'user',text},{role:'assistant',text:r.reply}]};
    if(r.request_generation){
      plan=await planAnywhere({origin:r.conversation.brief.origin,destination:r.conversation.brief.destination,travel:input.travel,constraints:input.constraints},{callJson:async()=>null,searchWeb:async()=>null});
      r=await conversationTurn({...input,action:'generate'},plan);
      record.turns.push({action:'generate',...r});
      console.log('生成',r.status,r.conversation.draft?.title);
      if(r.status!=='ok')break;
      input.conversation=r.conversation;input.candidate_id=r.selected_candidate_id;
      input.messages.push({role:'assistant',text:r.reply});
    }
  }
  report.cases.push(record);
}
writeFileSync(new URL('../pipeline/out/conversation-replay.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log('真实模型回放已写入 pipeline/out/conversation-replay.json；路线骨架使用无搜索基线，模型问答与按需目的地搜索为真实调用。');
