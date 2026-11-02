import {fileURLToPath} from 'node:url';
process.env.MT_LLM_USAGE_LOG ||= fileURLToPath(new URL('./logs/tests/compose-provider.jsonl',import.meta.url));
import assert from 'node:assert/strict';
import {composeJson,composeConfigured,composeModelInfo,llmModel} from './lib/llm.mjs';
import {sourceSearchProvider} from './lib/source-passages.mjs';
const original={...process.env},fetchBefore=globalThis.fetch;
try{
 process.env.DEEPSEEK_KEY='fixture-deepseek';process.env.DEEPSEEK_MODEL='deepseek-flash';process.env.VOLC_SEARCH_API_KEY='fixture-old';
 assert(composeConfigured());assert.equal(composeModelInfo().provider,'deepseek');
 assert.equal(llmModel(),'deepseek-flash');
 const calls=[];globalThis.fetch=async(url,options)=>{calls.push(url);assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(options.headers.authorization,'Bearer fixture-deepseek');
  const body=JSON.parse(options.body);assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.response_format.type,'json_object');
  return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};};
 assert.deepEqual(await composeJson({user:'返回JSON',schema_prompt:'返回JSON',kind:'provider-test'}),{ok:true});
 assert.equal(calls.length,1);
 let failure;globalThis.fetch=async()=>{calls.push('failed');return {ok:false,status:403};};
 assert.equal(await composeJson({user:'JSON',onFailure:f=>failure=f}),null);assert.equal(calls.length,2);assert.equal(failure.retryable,false,'不能失败后回退已耗尽的旧供应商');
 delete process.env.DEEPSEEK_KEY;process.env.DEEPSEEK_API_KEY='fixture-standard';assert.equal(composeModelInfo().provider,'deepseek');
 delete process.env.DEEPSEEK_API_KEY;assert.equal(composeModelInfo().provider,'volc');
 assert.equal(sourceSearchProvider('zh',{TRAVEL_SEARCH_MODE:'hybrid',VOLC_SEARCH_API_KEY:'old',TRAVEL_CHINESE_SEARCH_PROVIDER:'tavily'}),'tavily');
 console.log('模型供应商优先级、两种DeepSeek key命名、JSON请求、拒绝不回退与中文检索覆盖通过');
}finally{globalThis.fetch=fetchBefore;for(const key of ['DEEPSEEK_KEY','DEEPSEEK_API_KEY','DEEPSEEK_MODEL','VOLC_SEARCH_API_KEY']){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}}
