import {DurableObject} from 'cloudflare:workers';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {apiRouter} from '../index.mjs';
import {createAccessPolicy} from '../lib/access-policy.mjs';
import {withRequestOwner} from '../lib/request-owner.mjs';
import {withModelUsageContext} from '../lib/model-usage.mjs';
import {withRuntimeServices} from '../lib/runtime-services.mjs';
import {createPlanningSessions} from '../lib/planning-session.mjs';
import {AGENT_RULES_VERSION} from '../lib/agent-prompts.mjs';
import {createCloudState} from '../lib/cloud-state.mjs';
import {upstreamBudgetConfig} from '../lib/upstream-budget.mjs';
import {createAccounts,sessionToken,sessionCookie} from '../lib/accounts.mjs';

// 适配既有路由合同；请求体仍经过同一大小、编码和JSON结构校验。
function requestContext(request,{readBody=true}={}) {
  const url=new URL(request.url),headers=new Headers(),res=new EventEmitter();
  res.writableEnded=false;
  const req=readBody&&request.body?Readable.fromWeb(request.body):Readable.from([]);
  req.headers=Object.fromEntries(request.headers);req.socket={remoteAddress:request.headers.get('cf-connecting-ip')||'unknown'};
  const abort=()=>{req.destroy();res.emit('close');};
  request.signal.addEventListener('abort',abort,{once:true});
  const ctx={path:url.pathname,method:request.method,query:Object.fromEntries(url.searchParams),state:{},req,res,status:200,
    set:(key,value)=>headers.set(key,value),get:key=>request.headers.get(key)||'',headers};
  Object.defineProperty(ctx,'type',{set:value=>headers.set('Content-Type',value==='application/x-ndjson'?'application/x-ndjson; charset=utf-8':value)});
  ctx.finish=()=>{res.writableEnded=true;request.signal.removeEventListener('abort',abort);};
  ctx.response=()=>{
    let body=ctx.body;
    if(body instanceof Response){const copy=new Response(body.body,body);headers.forEach((v,k)=>copy.headers.set(k,v));ctx.finish();return copy;}
    if(body instanceof Readable){
      const source=Readable.toWeb(body),reader=source.getReader();
      body=new ReadableStream({async pull(controller){try{const chunk=await reader.read();if(chunk.done){ctx.finish();controller.close();}else controller.enqueue(chunk.value);}catch(error){ctx.finish();controller.error(error);}},async cancel(reason){res.emit('close');await reader.cancel(reason);ctx.finish();}});
    }else{if(body&&typeof body==='object'&&!ArrayBuffer.isView(body)){body=JSON.stringify(body);if(!headers.has('Content-Type'))headers.set('Content-Type','application/json; charset=utf-8');}ctx.finish();}
    return new Response(request.method==='HEAD'?null:body,{status:ctx.status,headers});
  };
  return ctx;
}

// 只协调共享的额度与并发，不在此对象中执行旅行任务。
export class UsageCoordinator extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.state=createCloudState(ctx.storage);this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY, expires REAL NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rates(id TEXT PRIMARY KEY, expires REAL NOT NULL, count INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.accounts=createAccounts({get:id=>{const row=[...this.sql.exec('SELECT value FROM accounts WHERE id=?',id)][0];return row?JSON.parse(row.value):null;},set:(id,value)=>this.sql.exec('INSERT INTO accounts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',id,JSON.stringify(value)),remove:id=>this.sql.exec('DELETE FROM accounts WHERE id=?',id),transaction:fn=>this.ctx.storage.transactionSync(fn)},env);
  }
  async account(action,data,token,ip){try{return {ok:true,...await this.accounts.handle(action,data,token,ip)};}catch(e){return {ok:false,status:e.status||500,msg:e.status?e.message:'账号服务暂不可用'};}}
  reserve(kind){return this.state.reserve(kind,upstreamBudgetConfig(this.env));}
  rejectAuth(ip){return this.ctx.storage.transactionSync(()=>{
    const now=Date.now(),id='auth:'+ip;this.sql.exec('DELETE FROM rates WHERE expires<=?',now);
    const row=[...this.sql.exec('SELECT count FROM rates WHERE id=?',id)][0];
    if(row?.count>=10)return false;
    this.sql.exec('INSERT INTO rates(id,expires,count) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET count=count+1',id,now+60000);return true;
  });}
  admit(user,ip){
    return this.ctx.storage.transactionSync(()=>{
      const now=Date.now(),limit=Number(this.env.MT_API_PER_MINUTE||20);
      this.sql.exec('DELETE FROM rates WHERE expires<=?',now);
      for(const id of ['user:'+user,'ip:'+ip]){
        const row=[...this.sql.exec('SELECT count FROM rates WHERE id=?',id)][0];
        if(row?.count>=limit)return false;
      }
      for(const id of ['user:'+user,'ip:'+ip])this.sql.exec('INSERT INTO rates(id,expires,count) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET count=count+1',id,now+60000);
      return true;
    });
  }
  acquire(){return this.ctx.storage.transactionSync(()=>{
    const now=Date.now();this.sql.exec('DELETE FROM leases WHERE expires<=?',now);
    if([...this.sql.exec('SELECT count(*) AS n FROM leases')][0].n>=Number(this.env.MT_MAX_CONCURRENT||4))return null;
    const id=crypto.randomUUID();this.sql.exec('INSERT INTO leases VALUES(?,?)',id,now+900000);return id;
  });}
  release(id){this.sql.exec('DELETE FROM leases WHERE id=?',id);}
}

export class TravelerAgent extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.storage=createCloudState(ctx.storage);this.sessions=createPlanningSessions({storage:this.storage,rulesVersion:AGENT_RULES_VERSION});}
  async fetch(request){
    const owner=request.headers.get('x-mixtouring-owner');
    if(!owner)return new Response('Forbidden',{status:403});
    const budget=this.env.USAGE.getByName('upstream'),lease=await budget.acquire();
    if(!lease)return Response.json({code:1,msg:'正在处理的请求较多，请稍后再试'},{status:429,headers:{'Retry-After':'60'}});
    const ctx=requestContext(request);ctx.state.accessUser=owner;ctx.state.modelUsageTaskId=crypto.randomUUID();
    const deadline=setTimeout(()=>ctx.res.emit('close'),840000);
    const done=async()=>{clearTimeout(deadline);await budget.release(lease);};
    try{
      await withRuntimeServices({planningSessions:this.sessions,reserveUpstream:kind=>budget.reserve(kind)},()=>
        withRequestOwner(owner,()=>withModelUsageContext({task_id:ctx.state.modelUsageTaskId,operation:ctx.path},()=>apiRouter(ctx,()=>{ctx.status=404;}))));
      const work=ctx.state.apiWork||ctx.body?.completion;
      if(work)this.ctx.waitUntil(Promise.resolve(work).finally(done));else await done();
      return ctx.response();
    }catch(error){await done();ctx.finish();const status=error.expose&&[400,408,413,415].includes(error.status)?error.status:500;
      console.error(JSON.stringify({event:'request_failed',status}));return Response.json({code:1,msg:status===500?'服务内部错误':error.message},{status});}
  }
}

export default {
  async fetch(request,env){
    const ctx=requestContext(request,{readBody:false});
    try{
      if(env.MT_ACCOUNT_AUTH==='1'&&!['/healthz','/readyz'].includes(ctx.path)){
        const url=new URL(request.url),token=sessionToken(request.headers.get('cookie')||''),accounts=env.USAGE.getByName('upstream');
        if(ctx.path.startsWith('/api/auth/')){
          const action=ctx.path.slice('/api/auth/'.length),read=action==='session';
          if(request.method!==(read?'GET':'POST'))return new Response(null,{status:405});
          if(!read&&(request.headers.get('origin')!==env.MT_PUBLIC_ORIGIN||request.headers.get('sec-fetch-site')==='cross-site'))return new Response(null,{status:403});
          let data={};
          if(!read){if(!request.headers.get('content-type')?.startsWith('application/json'))return new Response(null,{status:415});const reader=request.body?.getReader();let body='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});if(reader){for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4096){await reader.cancel();return new Response(null,{status:413});}body+=decoder.decode(part.value,{stream:true});}try{data=JSON.parse(body+decoder.decode());}catch{return new Response(null,{status:400});}}}
          const result=await accounts.account(action,data,token,request.headers.get('cf-connecting-ip')||'unknown');
          const headers={'Cache-Control':'no-store'};if(result.ok&&'token'in result)headers['Set-Cookie']=sessionCookie(result.token);
          return Response.json(result.ok?{user:result.user}:{msg:result.msg},{status:result.ok?200:result.status,headers});
        }
        if(['/pages/login.html','/assets/auth.css','/assets/auth.js','/assets/language.js','/assets/theme.js','/assets/desktop-ui.css'].includes(ctx.path))return env.ASSETS.fetch(request);
        const result=await accounts.account('session',{},token,'');
        if(!result.user){if(ctx.path.startsWith('/api/'))return Response.json({msg:'请先登录'},{status:401});return Response.redirect(url.origin+'/pages/login.html',302);}
        if(ctx.path==='/assets/account-context.js')return new Response('window.MTAccount='+JSON.stringify(result.user)+';',{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'}});
        ctx.state.accessUser=result.owner || 'account:'+result.user.id;
      }
      await createAccessPolicy(env)(ctx,async()=>{
        if(['/healthz','/readyz'].includes(ctx.path))return apiRouter(ctx,()=>{});
        if(ctx.path.startsWith('/api/')){
          const budget=env.USAGE.getByName('upstream'),ip=request.headers.get('cf-connecting-ip')||'unknown';
          if(!await budget.admit(ctx.state.accessUser,ip)){ctx.status=429;ctx.body={code:1,msg:'请求过于频繁，请稍后再试'};ctx.set('Retry-After','60');return;}
          const headers=new Headers(request.headers);headers.set('x-mixtouring-owner',ctx.state.accessUser);
          const identity=createHash('sha256').update(ctx.state.accessUser).digest('hex');
          ctx.body=await env.TRAVELERS.getByName(identity).fetch(new Request(request,{headers}));
        }else{
          const url=new URL(request.url);if(url.pathname==='/')url.pathname='/index.html';
          ctx.body=await env.ASSETS.fetch(new Request(url,request));
          ctx.set('Cache-Control','private, no-store');
        }
      });
      if(ctx.status===401&&!await env.USAGE.getByName('upstream').rejectAuth(request.headers.get('cf-connecting-ip')||'unknown')){
        ctx.status=429;ctx.body={code:1,msg:'访问尝试过于频繁，请稍后再试'};ctx.set('Retry-After','60');
      }
      return ctx.response();
    }catch{ctx.finish();return Response.json({code:1,msg:'服务暂不可用，请稍后重试'},{status:503});}
  }
};
