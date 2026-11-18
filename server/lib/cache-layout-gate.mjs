/* 阶段实验门禁仅给出后续回归资格；绝不自动改生产开关。 */
import {summarizeModelUsage} from './model-usage.mjs';
export function cacheLayoutGate(results,{rateFor,minRounds=3}={}){
 const reasons=[],arms={};
 for(const arm of ['baseline','cache_v1']){const rows=results.filter(r=>r.arm===arm);arms[arm]={evaluations:rows.length,accepted:rows.filter(r=>r.accepted).length,metrics:summarizeModelUsage(rows.flatMap(r=>r.usage || []),{rateFor}).overall};if(new Set(rows.map(r=>r.round)).size<minRounds)reasons.push(arm+':insufficient_rounds');}
 const a=results.filter(r=>r.arm==='baseline'),b=results.filter(r=>r.arm==='cache_v1');
 if(a.length!==b.length||a.some(r=>b.filter(x=>x.case_id===r.case_id&&x.round===r.round&&x.input_hash===r.input_hash).length!==1))reasons.push('unpaired_inputs');
 if(b.some(r=>!r.accepted))reasons.push('candidate_quality_failures');
 if(a.some(r=>r.accepted&&!b.find(x=>x.case_id===r.case_id&&x.round===r.round)?.accepted))reasons.push('paired_quality_regression');
 if(b.some(r=>!r.usage?.length||r.usage.some(u=>u.input_layout_version!=='cache_v1')))reasons.push('layout_not_applied');
 if(a.some(r=>{const match=b.find(x=>x.case_id===r.case_id&&x.round===r.round);return r.usage?.length!==match?.usage?.length||r.usage?.some((u,i)=>u.system_prompt_hash!==match.usage[i].system_prompt_hash||u.provider!==match.usage[i].provider||u.requested_model!==match.usage[i].requested_model||u.returned_model!==match.usage[i].returned_model||u.payload_bytes!==match.usage[i].payload_bytes);} ))reasons.push('request_contract_changed');
 const old=arms.baseline.metrics,next=arms.cache_v1.metrics;
 if(old.currency!==next.currency||JSON.stringify(old.price_versions)!==JSON.stringify(next.price_versions))reasons.push('pricing_basis_changed');
 if(old.cache_input_coverage!==1||next.cache_input_coverage!==1||old.estimated_model_cost==null||next.estimated_model_cost==null)reasons.push('measurement_incomplete');
 else{if(!(next.cache_miss_tokens<old.cache_miss_tokens))reasons.push('miss_tokens_not_lower');if(!(next.estimated_model_cost<old.estimated_model_cost))reasons.push('estimated_model_cost_not_lower');}
 if(old.p95_ms==null||next.p95_ms==null||next.p95_ms>old.p95_ms)reasons.push('p95_not_improved');
 return {decision:reasons.length?'hold_baseline':'candidate_for_full_workflow_validation',production_enabled:false,reasons:[...new Set(reasons)],arms};
}
