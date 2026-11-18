/* 请求去重与检查点只保存用户结构；失效证据和地图观察不随恢复续期。 */
import {mkdir,readFile,writeFile,rename,readdir,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {planningHash} from './planning-state.mjs';
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
// 同一恢复编号在不同邀请身份下必须对应不同文件；本机历史文件沿用原路径。
const checkpointId=(token,owner)=>owner?planningHash(owner)+'_'+token:token;
const identity=input=>planningHash(Object.fromEntries(Object.entries(input).filter(([key])=>!['planning_session_id','request_id','resume_token','progressive'].includes(key))));
const unavailable=(input,message='本轮已取消，原稿保留。')=>({status:'unavailable',reply:message,conversation:input.conversation,run:{status:'interrupted'},task:{state:'active'}});
export function createPlanningSessions({directory,storage,rulesVersion,ttlMs=86400000,clock=Date.now,maxSessions=64,maxRequestsPerSession=8}={}){
 const sessions=new Map(),locks=new Map();let lastSweep=-Infinity,sweeping=null;
 const locked=(token,fn)=>{const previous=locks.get(token)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);locks.set(token,next);return next.finally(()=>{if(locks.get(token)===next)locks.delete(token);});};
 const trim=()=>{for(const [sid,s]of sessions)if(!s.pending&&clock()-s.touched>=ttlMs)sessions.delete(sid);};
 async function save(token,value){return locked(token,async()=>{if(storage)return storage.save(token,value);await mkdir(directory,{recursive:true});const temporary=join(directory,token+'.'+randomUUID()+'.tmp');try{await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,join(directory,token+'.json'));}finally{await unlink(temporary).catch(()=>{});}});}
 async function read(token){try{const file=join(directory,token+'.json');const stat=await lstat(file);if(!stat.isFile()||stat.size>8*1024*1024)return null;const d=JSON.parse(await readFile(file,'utf8'));return d.schema_version===1&&Number.isFinite(d.expires_at)&&d.expires_at>clock()&&['structure_ready','facts_checked','validated','committed'].includes(d.stage)&&typeof d.signature==='string'&&(d.stage!=='committed'||d.conversation&&typeof d.conversation==='object'&&!Array.isArray(d.conversation))?d:null;}catch{return null;}}
 async function load(token,owner=null){const id=checkpointId(token,owner);return uuid(token)?locked(id,()=>storage?storage.read(id,clock()):read(id)):null;}
 async function prune(){
  trim();if(sweeping)return sweeping;lastSweep=clock();
  sweeping=(async()=>{if(storage){await storage.prune(clock());return;}let files;try{files=await readdir(directory);}catch{return;}
   for(const name of files){
    const token=name.match(/^((?:[a-f0-9]{64}_)?[a-f0-9-]{36})(?:\.json|\.[a-f0-9-]{36}\.tmp)$/)?.[1];if(!token||!uuid(token.slice(-36)))continue;
    await locked(token,async()=>{try{const path=join(directory,name),stat=await lstat(path);if(!stat.isFile())return;
     let expired=clock()-stat.mtimeMs>=ttlMs;
     if(name.endsWith('.json')){try{const d=JSON.parse(await readFile(path,'utf8'));expired=Number.isFinite(d.expires_at)?d.expires_at<=clock():expired;}catch{}}
     if(expired)await unlink(path);
    }catch{}});
   }
  })().finally(()=>{sweeping=null;});return sweeping;
 }
 const checkpoint=(signature,stage,extra)=>({schema_version:1,rules_version:rulesVersion,signature,stage,expires_at:clock()+ttlMs,...extra});
 function actionMetadata(result){const type=result.next_action?.type || (result.request_generation?'generate':result.request_route_discovery?'discover_routes':'none');return {next_action:{type:['generate','discover_routes'].includes(type)&&result.conversation?.stage==='ready'?type:'none',revision:result.conversation?.revision || 0},selected_candidate_id:result.selected_candidate_id || null,clear_selection:result.clear_selection===true,...(result.action==='undo'?{action:'undo'}:{}),preference_memory_upserts:result.preference_memory_upserts || [],preference_memory_context:result.preference_memory_context || null,preference_memory_notice:result.preference_memory_notice || null};}
 function restored(saved,token){
  const meta=actionMetadata({...saved.actions,conversation:saved.conversation});
  const reply=meta.action==='undo'?'已撤销上次修改，恢复之前的安排。':meta.next_action.type==='generate'?'已恢复已确认方案，继续编排每日行程。':saved.response_text&&!saved.conversation.draft?(saved.had_sources?'已恢复上次回复，资料时效需重新核对。\n\n':'已恢复上次回复。\n\n')+saved.response_text:'已恢复上次保存的安排，交通参考需重新查询。';
  return {status:'ok',engine:'checkpoint',reply,conversation:structuredClone(saved.conversation),patch:structuredClone(saved.patch || {preferences:{},travel:{},constraints:{},sights:{}}),sources:[],...meta,request_generation:meta.next_action.type==='generate',request_route_discovery:meta.next_action.type==='discover_routes',run:{status:'completed'},task:{state:'active',scope:'current_request'},resume_token:token};
 }
 const api={load,prune,stats:()=>({sessions:sessions.size,requests:[...sessions.values()].reduce((n,s)=>n+s.requests.size,0),pending:[...sessions.values()].reduce((n,s)=>n+s.pending,0)}),async run(input,{signal,execute}){
  if(signal?.aborted)return unavailable(input);
  if(!uuid(input.planning_session_id)||!uuid(input.request_id))return execute(input,{signal});
  trim();if(clock()-lastSweep>=60000)void prune();
  const owner=input._access_user || null;
  const sid=(owner || '')+':'+input.planning_session_id,rid=input.request_id,signature=identity(input),base=planningHash(input.conversation||null);
  let session=sessions.get(sid);
  if(!session){
   while(sessions.size>=maxSessions){const idle=[...sessions].filter(([,s])=>!s.pending).sort((a,b)=>a[1].touched-b[1].touched)[0];if(!idle)return unavailable(input,'当前请求较多，请稍后重试，原稿保留。');sessions.delete(idle[0]);}
   session={base,requests:new Map(),generation:0,pending:0,touched:clock()};sessions.set(sid,session);
  }
  session.touched=clock();if(session.committing)await session.committing;
  if(signal?.aborted)return unavailable(input);
  const repeated=session.requests.get(rid);
  if(repeated){
   if(repeated.signature!==signature)return {status:'conflict',reply:'请求内容已改变，请重新发送。',conversation:input.conversation};
   if(!repeated.settled&&repeated.signal.aborted){await repeated.promise;return api.run(input,{signal,execute});}
   if(repeated.settled&&repeated.afterBase!==session.base)return {status:'conflict',reply:'当前行程版本已变化，请恢复最新版本后继续。',conversation:input.conversation};
   return repeated.promise;
  }
  if(session.base!==base)return {status:'conflict',reply:'当前行程版本已变化，请恢复最新版本后继续。',conversation:input.conversation};
  while(session.requests.size>=maxRequestsPerSession){const idle=[...session.requests].find(([,r])=>r.settled);if(!idle)return unavailable(input,'当前请求较多，请稍后重试，原稿保留。');session.requests.delete(idle[0]);}
  session.controller?.abort();const controller=new AbortController();session.controller=controller;const generation=++session.generation;session.pending++;
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let token=uuid(input.resume_token)?input.resume_token:randomUUID();
  const saveCheckpoint=value=>save(checkpointId(token,owner),value);
  const active=()=>!combined.aborted&&generation===session.generation;
  const entry={signature,signal:combined,settled:false};
  const promise=(async()=>{
   const saved=input.resume_token?await load(input.resume_token,owner):null;
   if(!active())return unavailable(input);
   const resume=saved&&saved.signature===signature&&saved.rules_version===rulesVersion?saved:null;
   if(saved&&!resume)token=randomUUID();
   if(resume?.stage==='committed'){
    session.base=planningHash(resume.conversation);
    return restored(resume,token);
   }
   const onCheckpoint=async data=>{if(!active())return;await saveCheckpoint(checkpoint(signature,data.stage,{draft:workspace.cleanDraft(data.draft)}));};
   const result=await execute(input,{signal:combined,resumeDraft:resume?.draft || null,onCheckpoint});
   if(!active())return {...unavailable(input),resume_token:token};
   if(result.status==='ok'&&(!result.conversation||typeof result.conversation!=='object'||Array.isArray(result.conversation)))return {...unavailable(input,'回复状态不完整，原稿保留，可重试。'),resume_token:token};
   if(result.status==='ok'){
    let release;session.committing=new Promise(resolve=>{release=resolve;});
    try{
     await saveCheckpoint(checkpoint(signature,'committed',{conversation:result.conversation,patch:result.patch,actions:actionMetadata(result),response_text:typeof result.reply==='string'?result.reply.slice(0,12000):'',had_sources:!!result.sources?.length}));
     if(!active()){
      await saveCheckpoint(checkpoint(signature,'structure_ready',{draft:workspace.cleanDraft(result.conversation?.draft)}));
      return {...unavailable(input),resume_token:token};
     }
     session.base=planningHash(result.conversation||null);
    }finally{release();session.committing=null;}
   }
   return {...result,resume_token:token};
  })().catch(()=>({...unavailable(input,'本轮尚未保存成功，原稿保留，可重试。'),resume_token:token}));
  entry.promise=promise;session.requests.set(rid,entry);const result=await promise;
  session.pending--;session.touched=clock();entry.settled=true;entry.afterBase=session.base;
  if(result.status!=='ok')session.requests.delete(rid);
  else entry.promise=Promise.resolve(restored({conversation:result.conversation,patch:result.patch,actions:actionMetadata(result),response_text:result.reply,had_sources:!!result.sources?.length},token));
  return result;
 }};
 return api;
}
