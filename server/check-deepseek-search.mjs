import assert from 'node:assert/strict';
import {searchDeepSeek} from './lib/search-deepseek.mjs';
import {searchWebDetailed} from './lib/llm.mjs';
import {sourceSearchProvider} from './lib/source-passages.mjs';
import {webSearchConfigured} from './lib/trip-service.mjs';
const original={...process.env},fetchBefore=globalThis.fetch;
const row={title:'测试海岸',url:'https://example.org/coast',summary:'原始摘要',date:null};
assert.equal(webSearchConfigured({TRAVEL_SEARCH_PROVIDER:'deepseek',DEEPSEEK_KEY:'fixture'}).configured,true,'服务就绪判断与实际适配器使用相同key命名');
try{
 process.env.DEEPSEEK_KEY='fixture-new';delete process.env.DEEPSEEK_API_KEY;process.env.TAVILY_API_KEY='fixture-tavily';process.env.TRAVEL_SEARCH_PROVIDER='tavily';process.env.TRAVEL_CHINESE_SEARCH_PROVIDER='deepseek';process.env.TRAVEL_SEARCH_MODE='hybrid';
 const calls=[];
 globalThis.fetch=async(url,o)=>{calls.push(url);assert.equal(o.headers.authorization,'Bearer fixture-new');assert.equal(o.redirect,'error');const b=JSON.parse(o.body);assert(b.query.includes('lang:zh'));assert.equal(b.need_content,false);return {ok:true,status:200,json:async()=>({results:[row]})};};
 const r=await searchWebDetailed('海岸散步',{language:'zh'});assert.equal(r.provider,'deepseek-search');assert.equal(r.results[0].content,'原始摘要');assert.equal(r.results[0].date,null);assert.equal(calls.length,1);
 assert.equal(sourceSearchProvider('zh'),'deepseek');assert.equal(sourceSearchProvider('en'),'tavily');
 globalThis.fetch=async(url)=>{calls.push(url);return url.includes('deepseek')?{ok:false,status:429}:{ok:true,status:200,json:async()=>({results:[{title:row.title,url:row.url,content:'补充摘要'}]})};};
 const fallback=await searchWebDetailed('海岸',{language:'zh'});assert.equal(fallback.provider,'tavily');assert.equal(fallback.attempts[0].status,'rate_limited');assert.equal(fallback.network_requests,2);assert(fallback.results.length);
 globalThis.fetch=async url=>{assert(url.includes('deepseek'));return {ok:true,status:200,json:async()=>({results:[]})};};
 assert.equal((await searchWebDetailed('没有命中',{language:'zh'})).network_requests,1,'空结果不隐式重复检索');
 const controller=new AbortController();controller.abort();assert.equal((await searchWebDetailed('已取消',{language:'zh',signal:controller.signal})).network_requests,0);
 let sent=0;assert.equal(await searchDeepSeek('问题',{domains:['a'.repeat(125)+'.com'],fetchImpl:async()=>{sent++;}}),null);assert.equal(sent,0,'不能截断必需过滤器后发送');
 let query;await searchDeepSeek('😀'.repeat(200),{language:'zh',fetchImpl:async(u,o)=>{query=JSON.parse(o.body).query;return {ok:true,status:200,json:async()=>({results:[row]})};}});assert.equal([...query].length,128);assert(query.endsWith('lang:zh'));
 const late=new AbortController();const cancelled=await searchDeepSeek('问题',{signal:late.signal,fetchImpl:async()=>({ok:true,status:200,json:async()=>{late.abort();return {results:[row]};}})});assert.equal(cancelled,null);
 delete process.env.DEEPSEEK_KEY;process.env.DEEPSEEK_API_KEY='fixture-standard';await searchDeepSeek('问题',{fetchImpl:async(u,o)=>{assert.equal(o.headers.authorization,'Bearer fixture-standard');return {ok:true,status:200,json:async()=>({results:[]})};}});
 console.log('DeepSeek搜索：key兼容、中文主路由、外文补查、失败可观测回退、空结果／取消及Unicode长度边界通过');
}finally{globalThis.fetch=fetchBefore;for(const k of ['DEEPSEEK_KEY','DEEPSEEK_API_KEY','TAVILY_API_KEY','TRAVEL_SEARCH_PROVIDER','TRAVEL_CHINESE_SEARCH_PROVIDER','TRAVEL_SEARCH_MODE']){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}}
