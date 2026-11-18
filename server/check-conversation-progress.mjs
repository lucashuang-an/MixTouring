import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {conversationStream,progressLabel} from './lib/conversation-stream.mjs';
import client from '../mixtouring-hifi/assets/conversation-progress.js';
assert.equal(progressLabel({stage:'conversation_transport_revision',status:'started'}),'正在调整交通日安排…');assert.equal(progressLabel({stage:'source_audit',status:'started',secret:'x'}),null);
const stream=conversationStream(async emit=>{emit({stage:'search',status:'started',secret:'private'});emit({stage:'search',status:'started'});return {code:0,data:{status:'ok'}};});
let text='';for await(const chunk of stream)text+=chunk;const rows=text.trim().split('\n').map(JSON.parse);assert.equal(rows.length,2);assert(!text.includes('private'));
const saved=globalThis.fetch;
try{
 const bytes=new TextEncoder().encode(text);
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=2)c.enqueue(bytes.slice(i,i+2));c.close();}}),{headers:{'content-type':'application/x-ndjson'}});
 const seen=[];assert.equal((await client.request('/',{},undefined,label=>seen.push(label))).code,0);assert.deepEqual(seen,['正在查找旅行资料…']);
 globalThis.fetch=async()=>new Response('{"type":"progress","label":"正在查询"}\n',{headers:{'content-type':'application/x-ndjson'}});
 await assert.rejects(client.request('/',{},undefined,()=>{}),/中断/);
 const controller=new AbortController();const cancelled=conversationStream(async emit=>{controller.abort();emit({stage:'search',status:'started'});return {code:0};},controller.signal);let output='';for await(const chunk of cancelled)output+=chunk;assert.equal(output,'');
}finally{globalThis.fetch=saved;}
// 执行真实停止处理器：不改原稿，令迟到响应失效，保留文本和所选方式，下一次使用新执行身份。
const html=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');const start=html.indexOf('function stopConversation(){'),end=html.indexOf('function postConversation(',start);
const controller=new AbortController(),input={value:''},original={draft:{title:'原稿'}};
const env={conversationBusy:true,conversationController:controller,conversation:original,guideSequence:4,conversationProgress:'进行中',planningExecution:{id:'old'},activeConversationInput:{text:'改用自驾',transport_choices:[{from:'甲',to:'乙',mode:'drive'}]},sessionStorage:{removeItem(){}},document:{getElementById:()=>input},renderGuide(){},rememberSession(){}};
vm.createContext(env);vm.runInContext(html.slice(start,end)+'stopConversation();',env);
assert(controller.signal.aborted);assert.equal(env.guideSequence,5);assert.equal(env.conversation,original);assert.equal(input.value,'改用自驾');assert.equal(env.planningExecution,null);assert.equal(env.conversationError.transport_choices[0].mode,'drive');
console.log('✓ 真实阶段流、敏感字段隔离、跨字节解码、截断失败、取消不提交与停止后重试状态通过');
const previousFetch=globalThis.fetch;
try{
 let cancelled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"type":"result","response":{"code":0,"data":{}}}\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/x-ndjson'}});
 assert.equal((await client.request('/',{},undefined,null,{timeoutMs:30})).code,0,'终包到达即完成，不等待连接关闭');assert(cancelled);
 globalThis.fetch=async()=>new Response(new ReadableStream({start(){},cancel(){}}),{headers:{'content-type':'application/x-ndjson'}});
 await assert.rejects(client.request('/',{},undefined,null,{timeoutMs:15}),/超时/);
 globalThis.fetch=async()=>new Response('x'.repeat(100),{headers:{'content-type':'application/x-ndjson'}});
 await assert.rejects(client.request('/',{},undefined,null,{maxBytes:20}),/过大/);
 globalThis.fetch=async()=>new Response('{"type":"result","response":{}}\n',{headers:{'content-type':'application/x-ndjson'}});
 await assert.rejects(client.request('/',{},undefined,null),/格式/);
 globalThis.fetch=async()=>new Response('{"code":0,"data":{"text":"正常回复"}}',{headers:{'content-type':'application/json'}});
 assert.equal((await client.request('/',{},undefined,null)).data.text,'正常回复');
 const aborted=new AbortController();aborted.abort();globalThis.fetch=async()=>{throw Error('已取消不能再发送');};await assert.rejects(client.request('/',{},aborted.signal,null),e=>e.name==='AbortError');
 let calls=0;const stream=conversationStream(async()=>{calls++;},aborted.signal);for await(const chunk of stream){}assert.equal(calls,0);
}finally{globalThis.fetch=previousFetch;}
console.log('✓ 流式终包即返回、超时退出、大小限制、格式校验、JSON兼容与预取消通过');
