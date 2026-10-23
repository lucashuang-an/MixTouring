/* 手动真实模型支持核对，全部资料为合成夹具，不代表旅行事实；不调用搜索。 */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {composeJson} from './lib/llm.mjs';
import {buildEvidenceCatalog,assessEvidenceClaims,validateEvidenceClaims} from './lib/evidence-grounding.mjs';
const now=Date.parse('2026-10-22T00:00:00Z');
const reply='来源记载北京到阿拉木图开通直飞，本次日期仍待确认。';
const cases=[
  ['正向资料参考','北京到阿拉木图开通直飞。',true],
  ['反向不能替代正向','阿拉木图到北京开通直飞。',false],
  ['城市首现不等于方向','北京旅客注意：从阿拉木图出发、抵达北京的直飞已开通。',false],
  ['铁路不能变为航空','北京到阿拉木图开通铁路服务。',false],
  ['混合句中的否定范围','北京到阿拉木图尚未开通直飞；北京到上海开通直飞。',false],
  ['缺少一端不能证明航线','阿拉木图开通直飞服务，目的城市未注明。',false],
  ['时间不能支持票券范围','do not assume every lift section shares the same hours',false,'缆车各段开放时间可能不同，不能默认一张票通到底。'],
  ['完整复合参考仍可支持','缆车各段开放时间不同。各段票券需要分别确认。',true,'资料提示缆车各段开放时间不同，各段票券需要分别确认。'],
  ['一个景点不能支持另一个','Visit Panfilov Park and admire Zenkov Cathedral.',false,'资料建议游览Panfilov Park，还建议游览Green Bazaar。'],
  ['不能凭空翻译成另一公园','Day 2 - GORKY PARK',false,'资料列出果戈里公园。'],
  ['保留原名的公园参考','Day 2 - GORKY PARK',true,'资料列出GORKY PARK。'],
  ['原文有中文名可使用','GORKY PARK（高尔基公园）',true,'资料列出高尔基公园。'],
  ['workable不授予可执行资格','A workable sequence is central Almaty to Medeu, Shymbulak base, an upper station, then back down.',false,'该指南把这条走法写成一条可执行的路线，仅供参考。'],
  ['探索顺序参考仍可表达','A workable sequence is central Almaty to Medeu, Shymbulak base, an upper station, then back down.',true,'该指南给出了central Almaty到Medeu的探索顺序，仅供参考。']
];
const report={sampled_at:new Date().toISOString(),fixture:true,model:process.env.VOLC_COMPOSE_MODEL || process.env.LLM_MODEL,cases:[]};
const output=process.env.EVIDENCE_REPLAY_OUT || join(tmpdir(),'mixtouring-evidence-replay.json');
for(const [name,excerpt,expected,statement=reply] of cases){
  const catalog=buildEvidenceCatalog({sources:[{url:'https://example.gov.cn/fixture',title:'合成交通资料',excerpt,published_at:'2026-10-20',kind:'official'}],now,retrieval:{purpose:'transport'}});
  const claims=[{text:statement,allowed_use:'source_reference',supports:[{source_id:catalog.entries[0].id,quote:excerpt}]}];
  const usage=[],realModel=opts=>composeJson({...opts,onUsage:u=>usage.push(u)});
  const start=Date.now(),assessment=await assessEvidenceClaims(statement,catalog,claims,realModel,{signal:AbortSignal.timeout(20000)});
  const result=validateEvidenceClaims(statement,catalog,{claims,assessment});
  const passed=assessment.status!=='unavailable' && (result.grounded.length===1)===expected;
  report.cases.push({name,excerpt,expected,assessment,result,passed,usage,elapsed_ms:Date.now()-start});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(name,passed?'通过':'需核查');
}
console.log('私有报告：'+output);if(report.cases.some(c=>!c.passed))process.exitCode=1;
