import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'mt-budget-wire-'));
process.env.MT_DAILY_UPSTREAM_LIMIT='1';process.env.MT_BUDGET_FILE=join(dir,'ledger.json');process.env.DEEPSEEK_KEY='fixture-key';process.env.MT_LLM_USAGE_LOG=join(dir,'usage.jsonl');
const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '0'}};};
try{
 const {composeJson}=await import('./lib/llm.mjs');
 let failure;assert.equal(await composeJson({kind:'quota-fixture',user:'{}',schema_prompt:'JSON',timeoutMs:2000,onFailure:f=>failure=f}),null);
 assert.equal(calls,1,'重试前预算阻断，不再发HTTP');assert.equal(failure.reason_code,'budget_exceeded');
 const {searchDeepSeek}=await import('./lib/search-deepseek.mjs');await searchDeepSeek('test',{key:'fixture',fetchImpl:globalThis.fetch});assert.equal(calls,1,'模型与搜索共用预算');
 const {googlePlace}=await import('./lib/google-maps.mjs');const place=await googlePlace('test',{apiKey:'fixture',fetchImpl:globalThis.fetch});assert.equal(place.reason,'budget_exceeded');assert.equal(calls,1);
}finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
console.log('✓ 真实出口：物理重试、搜索和地图在发请求前共用预算');
