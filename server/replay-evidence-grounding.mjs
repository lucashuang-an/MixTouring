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
  ['缺少一端不能证明航线','阿拉木图开通直飞服务，目的城市未注明。',false]
];
const report={sampled_at:new Date().toISOString(),fixture:true,model:process.env.VOLC_COMPOSE_MODEL || process.env.LLM_MODEL,cases:[]};
const output=process.env.EVIDENCE_REPLAY_OUT || join(tmpdir(),'mixtouring-evidence-replay.json');
for(const [name,excerpt,expected] of cases){
  const catalog=buildEvidenceCatalog({sources:[{url:'https://example.gov.cn/fixture',title:'合成交通资料',excerpt,published_at:'2026-10-20',kind:'official'}],now,retrieval:{purpose:'transport'}});
  const claims=[{text:reply,allowed_use:'source_reference',supports:[{source_id:catalog.entries[0].id,quote:excerpt}]}];
  const start=Date.now(),assessment=await assessEvidenceClaims(reply,catalog,claims,composeJson,{signal:AbortSignal.timeout(20000)});
  const result=validateEvidenceClaims(reply,catalog,{claims,assessment});
  const passed=assessment.status==='completed' && (result.grounded.length===1)===expected;
  report.cases.push({name,excerpt,expected,assessment,result,passed,elapsed_ms:Date.now()-start});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(name,passed?'通过':'需核查');
}
console.log('私有报告：'+output);if(report.cases.some(c=>!c.passed))process.exitCode=1;
