/* 手动真实模型／Tavily回放。默认合成夹具，可显式读取本机私有S1捕获；报告不入库。 */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {composeJson,searchWebDetailed} from './lib/llm.mjs';
import {relevanceReviewer} from './lib/source-relevance.mjs';
import {conversationTurn} from './lib/conversation.mjs';
import {readPublicPage} from './lib/public-reader.mjs';
const output=resolve(process.env.SOURCE_TASK_REPLAY_OUT || join(tmpdir(),'mixtouring-source-task-replay.json'));
const source=(name,title,excerpt)=>({url:'https://www.xiaohongshu.com/explore/'+name,title,excerpt,kind:'experience',read_status:'page_excerpt'});
let ili=source('positive','伊宁公共交通游记','独自旅行时在伊宁市区乘公交，步行逛街，结合打车安排。'),vietnam=source('unrelated','越南独旅行程','河内到胡志明的旅行体验。'),ad=source('promotion','P人不想做旅行攻略？圆周旅迹带你出发','这个APP一键抓取全网攻略，自动整合生成专属行程。'),camp=source('camp','北京周边露营','怀柔露营与自驾烧烤的经验。');
if(process.env.SOURCE_TASK_CAPTURE){const capture=JSON.parse(readFileSync(resolve(process.env.SOURCE_TASK_CAPTURE),'utf8')),find=(id,fragment)=>capture.records.find(r=>r.task_id===id)?.sources.find(s=>s.title.includes(fragment));
  ili=find('experience-yili-xhs','毕业旅行') || ili;vietnam=find('experience-yili-xhs','越南') || vietnam;ad=find('experience-yili-xhs','圆周旅迹') || ad;camp=find('boundary-sparse-xhs','露营') || camp;
}
const report={sampled_at:new Date().toISOString(),model:process.env.VOLC_COMPOSE_MODEL || process.env.LLM_MODEL,capture:!!process.env.SOURCE_TASK_CAPTURE,cases:[]};
const save=()=>{mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');};
const selected=process.env.SOURCE_TASK_CASES?.split(',');
for(const scenario of [
  {name:'伊宁真实正反例',task:{destination:'伊宁',query:'伊宁独自无车旅行体验',purpose:'experience'},sources:[ili,vietnam,ad,camp],expected:['keep','reject','reject','reject']},
  {name:'大阪标题与正文',task:{destination:'大阪',query:'大阪无车旅行',purpose:'experience'},sources:[source('osaka','日本关西独旅攻略','在大阪坐地铁、散步逛街，记录大阪无车旅行的体验。')],expected:['keep']},
  {name:'软件咨询',task:{destination:'伊宁',query:'有哪些自动整理旅行攻略的Apps',purpose:'guide'},sources:[ad],expected:['keep']},
  {name:'正文缺失',task:{destination:'伊宁',query:'伊宁无车旅行',purpose:'experience'},sources:[source('empty','旅行首页','首页 联系我们 关于我们 版权信息')],expected:['uncertain']}
]){
  if(selected && !selected.includes(scenario.name))continue;
  const start=Date.now(),result=await relevanceReviewer(composeJson)(scenario.task,scenario.sources),decisions=result.items.map(x=>x.decision);
  const passed=result.status==='completed' && JSON.stringify(decisions)===JSON.stringify(scenario.expected);
  report.cases.push({name:scenario.name,task:scenario.task,sources:scenario.sources,result,expected:scenario.expected,passed,elapsed_ms:Date.now()-start});save();console.log(scenario.name,passed?'通过':'需核查',decisions.join(','));
}
if(!selected || selected.includes('真实Tavily对话')){
  const start=Date.now(),searches=[];
  const result=await conversationTurn({text:'请查一下伊宁无车旅行和当地乘车的经验，只回答资料与取舍，先不要修改行程。',conversation:{stage:'draft',brief:{origin:'北京',destination:'伊宁',summary:'伊宁无车旅行体验'},routing:{origin:'北京',destination:'伊宁'},draft:{title:'伊宁探索',overview:'交通待核实',route:['北京','伊宁'],cards:[{id:'city',place:'伊宁',label:'市区阶段',title:'慢游市区',content:'交通仍待查。'}],sections:[],pending:['交通待核实']}}},null,
    {budgetMs:90000,sourceReview:true,readPage:readPublicPage,search:async(query,options)=>{const r=await searchWebDetailed(query,{...options,provider:'tavily'});searches.push(r);return r.results;}});
  report.cases.push({name:'真实Tavily对话',result,searches,passed:result.status==='ok' && searches.length<=2,elapsed_ms:Date.now()-start});save();console.log('真实Tavily对话',result.status,result.source_relevance?.status,'查询'+searches.length);
}
report.finished_at=new Date().toISOString();save();console.log('私有报告：'+output);if(report.cases.some(c=>!c.passed))process.exitCode=1;
