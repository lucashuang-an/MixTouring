/* 手动真实模型数字守门回放。搜索仅注入合成资料，不验证任何实际交通价格。
 * node --env-file-if-exists=server/.env server/replay-numeric-grounding.mjs
 * NUMERIC_REPLAY_OUT可指定私有报告路径，默认临时目录。 */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';import {composeJson} from './lib/llm.mjs';
const output=process.env.NUMERIC_REPLAY_OUT || path.join(os.tmpdir(),'mixtouring-numeric-replay.json');
const cases=[
 {name:'合法预算与费用待查',text:'只确认条件：我的预算上限是8000元。请说明预算已保留、实际费用尚未核实，先不生成安排。',budget:8000},
 {name:'公园时刻不能支持票价',text:'只咨询：这份公园资料能证明北京到阿拉木图机票20元吗？不能就明确说票价待查，不生成安排。',material:'阿拉木图公园每日20时关门，附近适合散步。'},
 {name:'其他路线票价不能挪用',text:'只咨询：上海到东京的票价能说明北京到阿拉木图的当前票价吗？不能就说明待查。',material:'上海到东京航班票价8000元。'},
 {name:'来源同向票价仅作参考',text:'出行日期尚未确定，只查询合成资料：请复述北京到阿拉木图航班的票价参考数字，写全方向和方式，说明资料记载、仅供参考、本次日期仍待确认。',material:'北京到阿拉木图航班票价8000元。',expectFact:true},
 {name:'历史来源不能变当前价格',text:'只咨询：这份历史资料能证明北京到阿拉木图现在的机票价格吗？不能就说明待查。',material:'北京到阿拉木图航班票价8000元。',date:'2020-01-01'}
];
const report={model:process.env.VOLC_COMPOSE_MODEL,search:'合成资料桩，不证明旅行事实',status:'running',steps:[],calls:[]};
try{
 for(const c of cases){
  const brief={origin:c.budget?'':'北京',destination:c.budget?'':'阿拉木图',summary:'先讨论交通，不生成安排',wishes:[],open_questions:[]};
  const r=await conversationTurn({text:c.text,current_message:{mid:1,role:'user',text:c.text},conversation:cleanConversation({stage:'ready',brief}),constraints:c.budget?{budget_max_cny:c.budget}:{}},null,{
   now:Date.parse('2026-10-20T04:00:00Z'),search:async()=>c.material?[{title:'隔离合成资料',link:'https://example.com/numeric-fixture',content:c.material,date:c.date || '2026-10-01'}]:[],
   model:async opts=>{const start=Date.now();const raw=await composeJson(opts);report.calls.push({case:c.name,kind:opts.kind,ms:Date.now()-start,ok:!!raw,reply:raw?.reply});
    // 仅固定测试资料进入真实搜索编排的时机，回复及守门修正仍由真实模型完成。
    if(c.material && opts.kind==='conversation' && raw && !JSON.parse(opts.user).search_complete)raw.search_query='北京 阿拉木图 票价参考';
    return raw;}
  });
  assert.equal(r.status,'ok',c.name+'：'+r.reply);
  if(c.expectFact)assert.ok(r.numeric_grounding.some(f=>f.field==='price' && f.value===8000 && f.subject.from==='北京' && f.source_url),'真实回复关联来源');
  else assert.ok(!r.numeric_grounding.some(f=>f.field==='price'),'错误／旧资料不被升级成价格');
  if(c.budget){assert.ok(r.numeric_grounding.some(f=>f.field==='user_condition' && f.value===8000),'真实回复保留预算');assert.match(r.reply,/预算/);}
  report.steps.push({name:c.name,status:r.status,reply:r.reply,grounding:r.numeric_grounding});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({case:c.name,status:r.status}));
 }
 report.status='passed';report.finished_at=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,calls:report.calls.length,output}));
}catch(error){report.status='failed';report.error=error.message;fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.error(error.stack);process.exitCode=1;}
