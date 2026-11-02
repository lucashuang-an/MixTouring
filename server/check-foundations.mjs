import {backendVersion} from './lib/runtime-version.mjs';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,readFile,writeFile,readdir,utimes,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readJsonBody} from './lib/http-body.mjs';
import {createPlanningSessions} from './lib/planning-session.mjs';
import {loadOrCreateKey} from './lib/runtime-key.mjs';
import {appendBoundedJsonl} from './lib/bounded-log.mjs';
import {discussPlan,authorizedOutline} from './lib/planning-discussion.mjs';
import {cleanConversation} from './lib/conversation.mjs';
// 分块UTF-8与无效请求必须在进入模型前处理。
const request=new PassThrough(),parsed=readJsonBody(request),bytes=Buffer.from('{"text":"旅行想法"}');for(const byte of bytes)request.write(Buffer.from([byte]));request.end();assert.deepEqual(await parsed,{text:'旅行想法'});
for(const raw of ['{bad','[]','null','"文本"']){const req=new PassThrough(),read=readJsonBody(req);req.end(raw);await assert.rejects(read,e=>e.status===400);}
{const req=new PassThrough(),read=readJsonBody(req,{maxBytes:4});req.end('12345');await assert.rejects(read,e=>e.status===413);assert.equal(req.listenerCount('data'),0);}
{const req=new PassThrough(),read=readJsonBody(req);req.emit('aborted');await assert.rejects(read,e=>e.status===400);}
{const req=new PassThrough(),read=readJsonBody(req,{timeoutMs:10});const hold=setTimeout(()=>{},40);await assert.rejects(read,e=>e.status===408);clearTimeout(hold);}
const directory=await mkdtemp(join(tmpdir(),'mt-foundations-'));
try{
 let now=Date.now();const make=(extra={})=>createPlanningSessions({directory,rulesVersion:'test',clock:()=>now,ttlMs:1000,...extra});
 const input=()=>({planning_session_id:randomUUID(),request_id:randomUUID(),resume_token:randomUUID(),conversation:{revision:0},text:'确认',messages:[],retrieval_ids:[]});
 // 恢复确认动作不能丢下一步，也不能给事实续期。
 const accepted=input(),store=make();await store.run(accepted,{execute:async()=>({status:'ok',conversation:{revision:1,stage:'ready'},request_generation:true,next_action:{type:'generate',revision:1},sources:[{url:'https://example.org/old'}]})});
 const replay=await make().run(accepted,{execute:()=>{throw Error('不应重复生成');}});assert.equal(replay.request_generation,true);assert.deepEqual(replay.next_action,{type:'generate',revision:1});assert.deepEqual(replay.sources,[]);
 for(const changed of [{messages:[{role:'user',text:'换城市'}]},{retrieval_ids:['new']},{plan_id:'different'},{research_scope:{route:['甲','乙']}}])assert.equal((await store.run({...accepted,...changed},{execute:()=>{throw Error('不能执行');}})).status,'conflict');
 // 更晚版本提交后，旧幂等请求不能返回旧稿覆盖当前版本。
 await store.run({...accepted,request_id:randomUUID(),resume_token:randomUUID(),conversation:replay.conversation},{execute:async()=>({status:'ok',conversation:{revision:2}})});
 assert.equal((await store.run(accepted,{execute:()=>{throw Error('不能执行');}})).status,'conflict');
 // 外部已经取消时，不从磁盘恢复提交结果。
 const controller=new AbortController();controller.abort();assert.equal((await make().run(accepted,{signal:controller.signal,execute:()=>{throw Error('不能执行');}})).status,'unavailable');
 // 同token的不同请求不得覆盖已有检查点。
 const collision={...accepted,text:'不同请求'};const displaced=await make().run(collision,{execute:async()=>({status:'ok',conversation:{revision:7}})});assert.notEqual(displaced.resume_token,accepted.resume_token);assert.equal((await make().load(accepted.resume_token)).conversation.revision,1);

 // 已提交恢复期间取消，不得把磁盘旧结果提交回本轮。
 const duringLoad=make(),abortLoad=new AbortController();const loading=duringLoad.run(accepted,{signal:abortLoad.signal,execute:()=>{throw Error('不应重做');}});abortLoad.abort();assert.equal((await loading).status,'unavailable');
 assert.equal((await duringLoad.run(accepted,{execute:()=>{throw Error('不应重做');}})).request_generation,true);
 // 原连接取消后，同ID重试等待旧运行退出，再实际执行新运行。
 const interruptedStore=make(),retryInput=input(),abortOld=new AbortController();let releaseOld,oldStarted;const oldGate=new Promise(r=>releaseOld=r),startedGate=new Promise(r=>oldStarted=r);let runs=0;
 const firstRun=interruptedStore.run(retryInput,{signal:abortOld.signal,execute:async()=>{runs++;oldStarted();await oldGate;return {status:'ok',conversation:{revision:99}};}});await startedGate;abortOld.abort();
 const retryRun=interruptedStore.run(retryInput,{execute:async()=>{runs++;return {status:'ok',conversation:{revision:1}};}});releaseOld();assert.equal((await firstRun).status,'unavailable');assert.equal((await retryRun).conversation.revision,1);assert.equal(runs,2);
 // 缓存只恢复交付文本和用户操作，不续用交通观察与来源核实。
 const answerInput=input(),answers=make(),upserts=[{key:'pace',value:'simple',source_message_mid:1}],context={enabled:true,store_id:'test-store',revision:2};
 await answers.run(answerInput,{execute:async()=>({status:'ok',reply:'先聊偏好。',conversation:{stage:'discuss',revision:1},preference_memory_upserts:upserts,preference_memory_context:context,sources:[{id:'source'}],transport_updates:[{duration_s:12345}]})});
 for(const replayStore of [answers,make()]){const result=await replayStore.run(answerInput,{execute:()=>{throw Error('不应重做');}});assert.match(result.reply,/先聊偏好/);assert.match(result.reply,/时效需重新核对/);assert.deepEqual(result.preference_memory_upserts,upserts);assert.deepEqual(result.preference_memory_context,context);assert.deepEqual(result.sources,[]);assert.equal(result.transport_updates,undefined);}
 const undoInput=input();await make().run(undoInput,{execute:async()=>({status:'ok',action:'undo',conversation:{revision:0}})});assert.equal((await make().run(undoInput,{execute:()=>{throw Error('不应重做');}})).action,'undo');
 // 有界内存，过期磁盘清理只处理约定文件，不删除非检查点文件。
 const limited=make({maxSessions:2,maxRequestsPerSession:2});for(let i=0;i<5;i++)await limited.run(input(),{execute:async()=>({status:'ok',conversation:{revision:1}})});assert(limited.stats().sessions<=2);
 const sequence=input();let conversation=sequence.conversation;for(let i=0;i<5;i++){const result=await limited.run({...sequence,request_id:randomUUID(),resume_token:randomUUID(),conversation},{execute:async()=>({status:'ok',conversation:{revision:i+1}})});conversation=result.conversation;}assert(limited.stats().requests<=4);
 const active=make({maxSessions:1});let release,started;const gate=new Promise(r=>release=r),start=new Promise(r=>started=r);const pending=active.run(input(),{execute:async()=>{started();await gate;return {status:'ok',conversation:{revision:1}};}});await start;assert.equal((await active.run(input(),{execute:()=>{throw Error('不能挤掉运行中任务');}})).status,'unavailable');release();await pending;
 await writeFile(join(directory,'keep.txt'),'keep');const temp=randomUUID()+'.'+randomUUID()+'.tmp';await writeFile(join(directory,temp),'partial');await utimes(join(directory,temp),new Date(now-10000),new Date(now-10000));now+=2000;await limited.prune();assert.equal(limited.stats().sessions,0);assert(!(await readdir(directory)).some(f=>f.endsWith('.json')||f.endsWith('.tmp')));assert.equal(await readFile(join(directory,'keep.txt'),'utf8'),'keep');
 // 持久签名跨进程，拒绝损坏而非自动换钥。
 const keyPath=join(directory,'test.key'),first=loadOrCreateKey(keyPath);assert.deepEqual(loadOrCreateKey(keyPath),first);const migrated=loadOrCreateKey(join(directory,'new-state.key'),{legacyPath:keyPath});assert.deepEqual(migrated,first);await writeFile(keyPath,'bad');assert.throws(()=>loadOrCreateKey(keyPath),/密钥格式/);
 const before=cleanConversation({brief:{origin:'甲',destination:'乙'},routing:{origin:'甲',destination:'乙'},requirements:{trip_days:1},discussion:{options:[{id:'one',title:'乙',description:'城市散步',route:['甲','乙'],segments:[{place:'乙',days:1,scope:''}],outbound_days:0,return_days:0}],confirmation_requested:true}});
 const current={requirements:before.requirements,preferences:{},travel:{trip_type:'one_way'},constraints:{},sights:{}};
 const approval=await discussPlan({before,next:structuredClone(before),current,raw:{planning:{action:'confirm',selected_id:'one'}},input:{text:'确认生成'},model:async()=>({generate:true,quote:'确认生成'}),trace:()=>{}});assert(authorizedOutline(approval.conversation,current));
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {authorizedOutline} from ${JSON.stringify(new URL('./lib/planning-discussion.mjs',import.meta.url).href)};console.log(Boolean(authorizedOutline(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]))));`,JSON.stringify(approval.conversation),JSON.stringify(current)],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'true');

 // 启动指纹用于区分旧实例；环境和签名密钥不得进入指纹输入。
 const codeRoot=join(directory,'version-test');await mkdir(join(codeRoot,'server','lib'),{recursive:true});
 for(const file of ['AGENTS.md','server/index.mjs','server/package.json','server/package-lock.json','server/lib/module.mjs'])await writeFile(join(codeRoot,file),'fixture');
 const version=backendVersion(codeRoot);await writeFile(join(codeRoot,'server','.env'),'fixture-secret');await writeFile(join(codeRoot,'server','private.key'),'fixture-key');assert.equal(backendVersion(codeRoot),version);await writeFile(join(codeRoot,'server','lib','module.mjs'),'changed');assert.notEqual(backendVersion(codeRoot),version);
 // 日志有界且超大记录保留明确截断标记，不产生半行JSON。
 const log=join(directory,'events.jsonl');for(let i=0;i<20;i++)assert(appendBoundedJsonl(log,{i,payload:'x'.repeat(180)},{maxBytes:512,maxRecordBytes:256,archives:2}));
 const files=(await readdir(directory)).filter(n=>n.startsWith('events.jsonl'));assert(files.length<=3);for(const name of files){const content=await readFile(join(directory,name),'utf8');assert(Buffer.byteLength(content)<=512);content.trim().split('\n').forEach(line=>JSON.parse(line));}
 assert(appendBoundedJsonl(log,{task_id:'large',payload:'x'.repeat(2000)},{maxBytes:512,maxRecordBytes:256,archives:2}));assert.equal(JSON.parse((await readFile(log,'utf8')).trim().split('\n').at(-1)).truncated,true);
 console.log('✓ 基础工程：请求边界、确认恢复、幂等身份、版本保护、缓存容量、过期清理、跨进程授权及日志轮转');
}finally{await rm(directory,{recursive:true,force:true});}
