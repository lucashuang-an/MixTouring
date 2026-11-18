import {evidenceRelationCases,validateEvidenceRelationOutput} from './fixtures/evidence-relation-cases.mjs';
/* P1实网专项：固定测试资料，无检索、无用户行程写入。 */
import {agentPrompt,AGENT_RULES_VERSION} from './lib/agent-prompts.mjs';
import {composeJson} from './lib/llm.mjs';
import {evidenceSpans,resolveEvidenceAtoms} from './lib/evidence-spans.mjs';
import {buildContext} from './lib/context-builder.mjs';
import {buildEvidenceCatalog,assessEvidenceClaims,validateEvidenceClaims} from './lib/evidence-grounding.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const args=process.argv.slice(2),output=args.find(a=>a.startsWith('--out='));if(!args.includes('--live')||!output)throw Error('需要--live --out=私有目录');const out=resolve(output.slice(6));await mkdir(out,{recursive:true});
const cases=evidenceRelationCases;
const results=[],usage=[];let halted=false;
for(let round=1;round<=2&&!halted;round++)for(const test of cases){
 const entries=test.sources.map((excerpt,i)=>({id:'source-'+i,title:'测试资料'+i,kind:'official',allowed_use:'source_reference',excerpt})),field={id:'field-1',text:test.text,path:'draft.overview'};field.assertion_spans=evidenceSpans(field);
 const payload={fields:[field],evidence_catalog:{entries},source_refs:entries.map(e=>({source_id:e.id})),output_use:'proposed_itinerary',planning_conditions:{text:'只核对这段文字，不改日程。'}};
 let failure=null;const value=await composeJson({kind:'conversation_evidence_extract',schema_prompt:agentPrompt('evidence.itinerary'),user:JSON.stringify(buildContext({payload,coreRules:agentPrompt('evidence.itinerary')}).value),inputLayout:'baseline',telemetry:{task_id:'p1-extract-'+test.id+'-'+round},timeoutMs:15000,onUsage:r=>usage.push(r),onFailure:f=>failure=f});
 const checked=validateEvidenceRelationOutput(test,value),valid=checked.valid,atoms=value?.items?.[0]?.assertions || [];
 results.push({id:test.id,round,expected:test.expected,valid:!!valid,raw_flag_consistent:checked.raw_flag_consistent,value,failure});await writeFile(out+'/extraction.json',JSON.stringify({rules:AGENT_RULES_VERSION,results,usage},null,2));console.log(JSON.stringify({id:test.id,round,valid:!!valid,relations:atoms.map(a=>a.evidence_relation)}));
 if(failure?.reason_code==='http_rejected'&&!failure.retryable){halted=true;break;}
}
const semantic=[];
for(const test of cases.filter(c=>['missing','refuted','negative_supported','conflicting'].includes(c.id)).concat({id:'absence_statement',text:'本文未提供开放时间，也未说明当天是否开放。',sources:['本文未提供开放时间，也未说明当天是否开放。'],expected:'supported'})){
 if(halted)break;const catalog=buildEvidenceCatalog({sources:test.sources.map((excerpt,i)=>({url:'https://example.org/'+i,title:'资料'+i,excerpt,kind:'official',published_at:'2026-11-01'})),now:Date.parse('2026-11-02T00:00:00Z')});
 const claims=[{text:test.text,allowed_use:test.expected==='conflicting'?'conflict':'source_reference',supports:catalog.entries.map(e=>({source_id:e.id,quote:e.excerpt}))}];
 const assessment=await assessEvidenceClaims(test.text,catalog,claims,async o=>composeJson({...o,inputLayout:'baseline',telemetry:{task_id:'p1-support-'+test.id},onUsage:r=>usage.push(r)}));const result=validateEvidenceClaims(test.text,catalog,{claims,assessment});const passed=result.grounded.length===(['negative_supported','conflicting','absence_statement'].includes(test.id)?1:0);semantic.push({id:test.id,passed,assessment,result});console.log(JSON.stringify({semantic:test.id,passed,grounded:result.grounded.length}));
}
await writeFile(out+'/summary.json',JSON.stringify({rules:AGENT_RULES_VERSION,extraction_total:results.length,extraction_passed:results.filter(r=>r.valid).length,semantic,usage,halted},null,2));
if(halted||results.some(r=>!r.valid)||semantic.some(r=>!r.passed))process.exitCode=1;
