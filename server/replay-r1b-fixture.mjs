/* 真实模型跑完整编排，资料是明确标识的合成夹具；不调用搜索，不证明交通事实。 */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {conversationTurn} from './lib/conversation.mjs';
import {composeJson} from './lib/llm.mjs';
const output=process.env.R1B_FIXTURE_OUT || join(tmpdir(),'mixtouring-r1b-fixture.json');
const now=Date.parse('2026-10-22T02:00:00Z');
const scenarios=[
  {name:'资料事实',origin:'北京',destination:'阿拉木图',question:'请查看合成测试资料，说明北京到阿拉木图的交通方向是否值得探索，班次仍要待查。',
    source:{title:'合成测试：北京到阿拉木图直飞方向资料',link:'https://example.gov.cn/fixture/beijing-almaty',content:'合成测试资料称北京到阿拉木图开通直飞方向，具体班次与适用日期需另行核实。',date:'2026-10-20'}},
  {name:'旅行者经验',origin:'乌鲁木齐',destination:'伊宁',question:'请核对公开的合成旅行者记录，讨论伊宁无车旅行的体验和取舍，不宣称当前班次。',
    source:{title:'合成测试：伊宁无车旅行者记录',link:'https://www.xiaohongshu.com/explore/r1b-fixture',content:'合成旅行者记录：我在伊宁市区步行逛街，公交线路和班次仍需按出行日核实。',date:'2026-10-20'}}
];
const report={fixture:true,code_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),sampled_at:new Date().toISOString(),cases:[]};
for(const scenario of scenarios.filter(s=>!process.env.R1B_FIXTURE_CASES || process.env.R1B_FIXTURE_CASES.split(',').includes(s.name))){
  const brief={origin:scenario.origin,destination:scenario.destination,summary:scenario.question},route=[scenario.origin,scenario.destination];
  const conversation={stage:'draft',brief,routing:{origin:scenario.origin,destination:scenario.destination},draft:{title:'合成体验草案',overview:'交通待查。',route,cards:[{id:'place',place:scenario.destination,label:'目的地阶段',title:'自由安排',content:'活动待讨论。'}],sections:[],pending:['交通待核实。']}};
  const usage=[],stages=[],started=Date.now();
  const result=await conversationTurn({text:scenario.question,conversation},null,{now,budgetMs:110000,sourceReview:true,evidenceReview:true,
    search:async()=>[scenario.source],readPage:async url=>({url,read_status:'page_excerpt',title:scenario.source.title,excerpt:scenario.source.content,published_at:scenario.source.date}),
    model:async opts=>{const value=await composeJson(opts);if(process.env.R1B_CAPTURE_MODEL)stages.push({kind:opts.kind,input:JSON.parse(opts.user),output:value});return value;},
    onModelUsage:u=>usage.push(u)});
  const expected_use=scenario.name==='旅行者经验'?'travel_experience':'source_reference';
  const passed=result.status==='ok' && result.sources?.length>0 && result.evidence_claims?.some(c=>c.allowed_use===expected_use) &&
    result.sources.every(s=>s.url===scenario.source.link) && result.evidence_claims.every(c=>result.reply.includes(c.sentence) && c.supports.every(s=>result.sources.some(source=>source.id===s.source_id)));
  report.cases.push({name:scenario.name,status:result.status,passed,expected_use,reply:result.reply,sources:result.sources || [],claims:result.evidence_claims || [],inferences:result.evidence_inferences || [],relevance:result.source_relevance,usage,...(process.env.R1B_CAPTURE_MODEL?{stages}:{}),elapsed_ms:Date.now()-started});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(`${scenario.name}：${result.status}；来源${result.sources?.length || 0}；证据结论${result.evidence_claims?.length || 0}`);
}
console.log('私有报告：'+output);
if(report.cases.some(c=>!c.passed))process.exitCode=1;
