/* 运行规则文件的真实加载与出站合同；临时目录、合成key和HTTP桩，不联网。 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,cpSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {agentPrompt,parseAgentPrompts,AGENT_RULES_VERSION,AGENT_PROMPT_IDS} from './lib/agent-prompts.mjs';
import {conversationTurn} from './lib/conversation.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const markdown=readFileSync(new URL('../AGENTS.md',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
const block=(id,text)=>'<!-- agent-prompt:'+id+' -->\n```text\n'+text+'\n```\n<!-- /agent-prompt -->';
const invalid=fn=>assert.throws(fn,error=>error.code==='AGENT_RULES_INVALID');
const catalog=parseAgentPrompts(markdown);
assert.deepEqual([...catalog.ids].sort(),[...AGENT_PROMPT_IDS].sort());
assert.equal(catalog.version,AGENT_RULES_VERSION);
assert.equal(parseAgentPrompts('\uFEFF'+markdown.replace(/\r?\n/g,'\r\n')).version,catalog.version,'换行和BOM不改变运行内容版本');
assert.equal(parseAgentPrompts('说明可编辑但不发送。\n'+markdown).version,catalog.version,'规则块外的说明不进入版本');
invalid(()=>parseAgentPrompts(''));
invalid(()=>parseAgentPrompts(markdown+block('conversation.main','重复')));
invalid(()=>parseAgentPrompts(markdown.replace('agent-prompt:conversation.main','agent-prompt:conversation.removed')));
invalid(()=>parseAgentPrompts(markdown.replace('<!-- /agent-prompt -->','<!-- 未闭合 -->')));
invalid(()=>parseAgentPrompts(block('sample','   '),{requiredIds:['sample']}));
invalid(()=>parseAgentPrompts(block('sample','{{broken'),{requiredIds:['sample']}));
invalid(()=>agentPrompt('missing'));
invalid(()=>agentPrompt('search.web_query'));
invalid(()=>agentPrompt('search.web_query',{query:'旅行',unexpected:'x'}));
const query='旅行查询 {{rejections}} $&';
assert.equal(agentPrompt('search.web_query',{query}),'请联网搜索下面的查询词，仅列出最相关的来源，每条用一句话概括。查询词：'+query,'参数只替换一次，值不被二次模板解释');
assert.ok(!agentPrompt('conversation.main').includes('DEVELOPMENT.md'),'开发指针不进入产品上下文');

// 驱动正式对话模块，检查发送给模型的规则正文及manifest，而非仅测试文件包含文字。
const brief={origin:'北京',destination:'阿拉木图',summary:'自然与文化',wishes:[],open_questions:[]};
let observed=0;
const turn=await conversationTurn({text:'想从北京去阿拉木图'},null,{
 search:async()=>[],
 model:async opts=>{
  observed++;assert.equal(opts.kind,'conversation');
  assert.equal(opts.schema_prompt,opts.instruction_phase==='intake'?agentPrompt('conversation.intake'):opts.instruction_phase==='answer'?agentPrompt('conversation.discuss')+agentPrompt('conversation.evidence_rules')+agentPrompt('conversation.numeric_rules'):agentPrompt('conversation.main')+agentPrompt('conversation.evidence_rules')+agentPrompt('conversation.numeric_rules')+'\n'+agentPrompt('conversation.delivery'));
  assert.equal(JSON.parse(opts.user).manifest.rules_version,AGENT_RULES_VERSION);
  return {intent_action:'discuss',reply:'可以先比较走法。',brief,ready:true,confirmed:false,preferences:{},travel:{},constraints:{},requirements_patch:{}};
 }
});
assert.equal(turn.status,'ok');assert.equal(observed,1,'仅表达目的地时不自动检索并重答');

// 隔离部署副本：编辑MD后在新进程调用实际两种模型适配器，捕获真实fetch请求体。
const dir=mkdtempSync(join(tmpdir(),'mixtouring-agent-prompts-'));
try{
 mkdirSync(join(dir,'server'),{recursive:true});
 cpSync(join(root,'server/lib'),join(dir,'server/lib'),{recursive:true});
 cpSync(join(root,'server/node_modules'),join(dir,'server/node_modules'),{recursive:true});
 const replacement='隔离部署中的默认规则：只输出JSON。';
 const edited=markdown.replace(block('format.json',agentPrompt('format.json')),block('format.json',replacement));
 assert.notEqual(edited,markdown,'确实修改默认规则块');
 writeFileSync(join(dir,'AGENTS.md'),edited);
 const script=String.raw`
  import assert from 'node:assert/strict';
  import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
  const root=process.argv[2],expected=process.argv[3],mode=process.argv[4];
  if(mode==='missing')unlinkSync(new URL('AGENTS.md',root));
  if(mode==='broken')writeFileSync(new URL('AGENTS.md',root),'损坏的规则文件');
  if(mode!=='valid'){
    let rejected=false;globalThis.fetch=async()=>{throw Error('规则失效时不得联网');};
    try{await import(new URL('server/lib/llm.mjs',root));}catch(error){rejected=mode==='missing'?error.code==='ENOENT':error.code==='AGENT_RULES_INVALID';}
    assert.equal(rejected,true);console.log('failure_is_explicit');
  }else{
    const sent=[],usage=[];
    globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);sent.push(body.messages[0].content);return {ok:true,json:async()=>({choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})};};
    const {composeJson,callJson}=await import(new URL('server/lib/llm.mjs',root));
    const {agentPrompt,AGENT_RULES_VERSION}=await import(new URL('server/lib/agent-prompts.mjs',root));
    assert.equal(agentPrompt('format.json'),expected);
    await composeJson({user:'{}',kind:'migration-compose',onUsage:u=>usage.push(u)});
    await callJson({user:'{}',kind:'migration-legacy',onUsage:u=>usage.push(u)});
    assert.deepEqual(sent,[expected,expected]);
    assert.ok(usage.every(u=>u.agent_rules_version===AGENT_RULES_VERSION));
    const logs=readFileSync(new URL('server/logs/llm-usage-v2.jsonl',root),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(logs.every(u=>u.agent_rules_version===AGENT_RULES_VERSION));
    writeFileSync(new URL('AGENTS.md',root),'已在运行中改坏文件');
    assert.equal(agentPrompt('format.json'),expected,'在途进程继续使用原规则快照');
    console.log(JSON.stringify({version:AGENT_RULES_VERSION,calls:sent.length}));
  }
 `;
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(?:LLM_|VOLC_|TAVILY_|TRAVEL_SEARCH_)/.test(key))delete env[key];
 Object.assign(env,{LLM_API_KEY:'fixture-key',VOLC_SEARCH_API_KEY:'fixture-key',MT_LLM_USAGE_LOG:join(dir,'server/logs/llm-usage-v2.jsonl')});
 const runner=join(dir,'check-http.mjs');writeFileSync(runner,script);
 const run=mode=>spawnSync(process.execPath,[runner,pathToFileURL(dir+'/').href,replacement,mode],{cwd:tmpdir(),env,encoding:'utf8',timeout:45000,windowsHide:true});
 const valid=run('valid');assert.equal(valid.status,0,valid.stderr);
 const actual=JSON.parse(valid.stdout.trim());assert.notEqual(actual.version,AGENT_RULES_VERSION);assert.equal(actual.calls,2);
 writeFileSync(join(dir,'AGENTS.md'),edited);
 const missing=run('missing');assert.equal(missing.status,0,missing.stderr);
 const broken=run('broken');assert.equal(broken.status,0,broken.stderr);
}finally{
 // 只清理本测试创建的临时目录；不跟随或删除工作区和用户文件。
 const rel=relative(tmpdir(),dir);
 assert.ok(!isAbsolute(rel) && /^mixtouring-agent-prompts-[^\\/]+$/.test(rel));
 rmSync(dir,{recursive:true,force:true});
}
console.log('✓ AGENTS运行规则：阶段加载、无开发指令、模板校验、内容版本、真实对话/双模型出站、异cwd、启动失败与进程快照通过');
