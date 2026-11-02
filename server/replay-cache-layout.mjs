import {cacheLayoutGate} from './lib/cache-layout-gate.mjs';
/* 显式实网A/B：固定资料，不执行搜索或写入旅行状态，生产开关不受影响。 */
import {writeFile,mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {cacheLayoutCases,validateCacheCase,CACHE_VALIDATOR_VERSION} from './fixtures/cache-layout-cases.mjs';
import {composeJson,composeModelInfo} from './lib/llm.mjs';
import {buildContext} from './lib/context-builder.mjs';
import {AGENT_RULES_VERSION} from './lib/agent-prompts.mjs';
import {summarizeModelUsage} from './lib/model-usage.mjs';
const args=process.argv.slice(2),output=args.find(a=>a.startsWith('--out='));
if(!args.includes('--live')||!output)throw Error('显式运行：--live --out=私有目录 [--stage=extract|patch]');
const selected=args.find(a=>a.startsWith('--stage='))?.slice(8);if(selected&&!['extract','patch'].includes(selected))throw Error('阶段参数无效');
const out=resolve(output.slice(6));await mkdir(out,{recursive:true});const root=fileURLToPath(new URL('../',import.meta.url));
async function hash(){const h=createHash('sha256');for(const name of (await readdir(join(root,'server/lib'))).filter(n=>n.endsWith('.mjs')).sort()){h.update(name);h.update(await readFile(join(root,'server/lib',name)));}h.update(await readFile(join(root,'AGENTS.md')));h.update(await readFile(join(root,'server/fixtures/cache-layout-cases.mjs')));h.update(await readFile(join(root,'server/replay-cache-layout.mjs')));return h.digest('hex');}
const codeBefore=await hash(),results=[],model=composeModelInfo();
// 固定高峰单价仅用于同模型比较，不声称是实际账户账单，也不应用到其他模型。
const rate={hit:.006,miss:.3,output:1.2,currency:'USD',version:'deepseek-flash-2026-11-02-peak-comparison',basis:'fixed_peak_rates_for_comparison_only',source:'https://api-docs.deepseek.com/quick_start/pricing/'};
const rateFor=r=>r.provider==='deepseek'&&r.requested_model==='deepseek-flash'?rate:null;
const corpus=Array.from({length:3},(_,i)=>cacheLayoutCases(i+1).filter(c=>!selected||c.id.startsWith(selected)));
const corpusHash=createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
let stop=false;
for(let round=1;round<=3&&!stop;round++)for(const test of corpus[round-1]){
 for(const arm of round%2?['baseline','cache_v1']:['cache_v1','baseline']){
  const usage=[],failures=[],built=buildContext({payload:test.payload,coreRules:test.schema_prompt,rulesVersion:AGENT_RULES_VERSION});
  const value=await composeJson({kind:test.kind,schema_prompt:test.schema_prompt,user:JSON.stringify(built.value),inputLayout:arm,timeoutMs:20000,telemetry:{task_id:'cache-ab-'+test.id+'-'+round+'-'+arm},onUsage:r=>usage.push(r),onFailure:f=>failures.push(f)});
  const row={case_id:test.id,round,arm,input_hash:createHash('sha256').update(JSON.stringify(built.value)).digest('hex'),accepted:validateCacheCase(test,value),usage,failures,value};results.push(row);
  await writeFile(join(out,'results.json'),JSON.stringify({rules:AGENT_RULES_VERSION,validator_version:CACHE_VALIDATOR_VERSION,code_before:codeBefore,model,results,rate,corpus_hash:corpusHash,round_mode:'shared_catalog_new_fields',tools_invoked:0},null,2));
  console.log(JSON.stringify({case:test.id,round,arm,accepted:row.accepted,status:usage[0]?.status,hit:usage[0]?.cache_hit_tokens,miss:usage[0]?.cache_miss_tokens,ms:usage[0]?.elapsed_ms}));
  if(failures.some(f=>f.reason_code==='http_rejected'&&f.retryable===false)){stop=true;break;}
 }
 if(stop)break;
}
const codeAfter=await hash(),summary={rules:AGENT_RULES_VERSION,validator_version:CACHE_VALIDATOR_VERSION,code_before:codeBefore,code_after:codeAfter,code_unchanged:codeBefore===codeAfter,model,rate,corpus_hash:corpusHash,round_mode:'shared_catalog_new_fields',tools_invoked:0,stopped:stop,
 arms:Object.fromEntries(['baseline','cache_v1'].map(arm=>{const rows=results.filter(r=>r.arm===arm);return [arm,{evaluations:rows.length,accepted:rows.filter(r=>r.accepted).length,first_round:summarizeModelUsage(rows.filter(r=>r.round===1).flatMap(r=>r.usage),{rateFor}).overall,repeated_rounds:summarizeModelUsage(rows.filter(r=>r.round>1).flatMap(r=>r.usage),{rateFor}).overall,...summarizeModelUsage(rows.flatMap(r=>r.usage),{rateFor})}];}))};
summary.stage_gates=Object.fromEntries(['extract','patch'].map(stage=>[stage,cacheLayoutGate(results.filter(r=>r.case_id.startsWith(stage)),{rateFor})]));
await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({code_unchanged:summary.code_unchanged,stopped:stop,arms:Object.fromEntries(Object.entries(summary.arms).map(([k,v])=>[k,{accepted:v.accepted,evaluations:v.evaluations,metrics:v.overall}]))}));
