import {upstreamBudgetConfig} from './lib/upstream-budget.mjs';
import {reasoningEffort} from './lib/model-settings.mjs';
import {runtimeServices} from './lib/runtime-services.mjs';
import {createAccessPolicy} from './lib/access-policy.mjs';
import {withRequestOwner} from './lib/request-owner.mjs';
import {ITINERARY_REVIEW_MODE} from './lib/light-edit.mjs';
import {withModelUsageContext} from './lib/model-usage.mjs';
import {INPUT_LAYOUT_POLICY} from './lib/input-layout.mjs';
import {RUNTIME_VERSION} from './lib/runtime-version.mjs';
import {appendBoundedJsonl} from './lib/bounded-log.mjs';
import {readJsonBody} from './lib/http-body.mjs';
import {nodeAccounts} from './lib/account-node.mjs';
import {conversationStream} from './lib/conversation-stream.mjs';
import {googleStaticMap} from './lib/google-maps.mjs';
/* 搜索驱动的旅行Agent服务；无预置地点、方案或离线生成器。 */
import Koa from 'koa';
import {PassThrough} from 'node:stream';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {runMapTool} from './lib/map-tool.mjs';
import {fileURLToPath} from 'node:url';
import {dirname,join,normalize,sep,resolve} from 'node:path';
import {composeConfigured,composeModelInfo,webSearchStatus,searchWeb} from './lib/llm.mjs';
import {capabilities,webSearchConfigured} from './lib/trip-service.mjs';
import {registerJourneyPlan,journeyDetailFromPlanId,guidePlanFromId} from './lib/journey.mjs';
import {conversationTurn} from './lib/conversation.mjs';
import {createPlanningSessions} from './lib/planning-session.mjs';
import {AGENT_RULES_VERSION} from './lib/agent-prompts.mjs';
import {checkDaySchedule} from './lib/planning-mobility.mjs';
import {buildRouteComparison} from './lib/route-comparison.mjs';
import {researchSelectedRoute} from './lib/route-research.mjs';
import {draftResearchChanges,searchDraftChanges} from './lib/draft-research.mjs';
import {createRequestSignal} from './lib/request-signal.mjs';
import {searchTransportSources,resolveTransportSearch} from './lib/transport-search.mjs';
import {runResearchLoop,resolveResearchLoop} from './lib/research-loop.mjs';
import {progressivePlan} from './lib/progressive.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const planningSessions=createPlanningSessions({directory:join(root,'server','logs','planning-checkpoints'),rulesVersion:AGENT_RULES_VERSION});
const PORT=Number(process.env.PORT) || 3000;
const BIND_HOST=process.env.MIXTOURING_HOST || '127.0.0.1';
if((process.env.NODE_ENV==='production'||!['127.0.0.1','::1','localhost'].includes(BIND_HOST))&&process.env.MT_PUBLIC!=='1')throw Error('公开监听或生产模式必须启用MT_PUBLIC=1');
let draining=false;
export const app=new Koa();
app.use(async(ctx,next)=>{try{await next();}catch(error){const exposed=error.expose&&[400,408,413,415].includes(error.status);if(!exposed)console.error('✗ 请求失败：'+error.message);ctx.status=exposed?error.status:500;ctx.body={code:1,msg:exposed?error.message:'服务内部错误'};}});
export async function apiRouter(ctx,next){
  if(!ctx.path.startsWith('/api/') && ctx.path!=='/healthz' && ctx.path!=='/readyz')return next();
  ctx.type='application/json; charset=utf-8';ctx.set('Cache-Control','no-store');const path=ctx.path;
  if(path==='/readyz'){const ready=!draining&&composeConfigured()&&webSearchConfigured().configured;ctx.status=ready?200:503;ctx.body={status:ready?'ready':'unavailable'};return;}
  if(path==='/healthz'){ctx.body={status:'ok',runtime_version:RUNTIME_VERSION,agent_rules_version:AGENT_RULES_VERSION,input_layouts:INPUT_LAYOUT_POLICY,itinerary_review:ITINERARY_REVIEW_MODE};return;}
  if(path==='/api/capabilities'){ctx.body={code:0,data:{...capabilities(composeConfigured(),webSearchConfigured().configured,webSearchStatus().status),model:composeConfigured()?composeModelInfo():null,runtime_version:RUNTIME_VERSION,agent_rules_version:AGENT_RULES_VERSION,input_layouts:INPUT_LAYOUT_POLICY,itinerary_review:ITINERARY_REVIEW_MODE}};return;}
  if (['/api/anywhere/plan','/api/anywhere/search-plan'].includes(path) && ctx.method === 'POST') {
    const body = await readBody(ctx);
    if (!body || (!String(body.text || '').trim() && !String(body.origin || '').trim() && !String(body.destination || '').trim())) {
      ctx.body = { code: 1, msg: '缺少 text 或 origin/destination' };
      return;
    }
    if (body.progressive === true) {
      const stream = new PassThrough(), controller = new AbortController();
      ctx.type = 'application/x-ndjson';
      ctx.set('Cache-Control', 'no-store');
      ctx.body = stream;
      ctx.res.once('close', () => controller.abort());
      const planner=progressivePlan;
      ctx.state.apiWork=planner(body, (data, phase) => {
        if (controller.signal.aborted) return;
        if (data.candidates.length || data.anchors?.full_cover || data.planning_mode!=='search_first' && (data.intent?.origin_place && data.intent?.destination_place)) data.plan_id = registerJourneyPlan(data);
        stream.write(JSON.stringify({ code: 0, phase, data }) + '\n');
      }, {}, controller.signal).catch(() => {
        if (!controller.signal.aborted) stream.write(JSON.stringify({ code: 1, msg: '补充搜索未完成，已有走法仍可查看' }) + '\n');
      }).finally(() => stream.end());
      return;
    }
    const data = await progressivePlan(body,()=>{}, {},createRequestSignal(ctx.req,ctx.res));
    if (data.candidates.length || data.anchors?.full_cover || data.planning_mode!=='search_first' && (data.intent?.origin_place && data.intent?.destination_place)) data.plan_id = registerJourneyPlan(data);
    ctx.body = { code: 0, data };
    return;
  }

  if (path === '/api/anywhere/compare' && ctx.method === 'POST') {
    const body=await readBody(ctx) || {},plan=guidePlanFromId(body.plan_id);
    ctx.body=plan?{code:0,data:buildRouteComparison(plan,{preferences:body.preferences,requirements:body.requirements,constraints:body.constraints,travel:body.travel,retrieval_ids:body.retrieval_ids,current_route:body.current_route})}:{code:1,msg:'路线比较已过期，请重新发现走法'};
    return;
  }
  if (path === '/api/anywhere/conversation' && ctx.method === 'POST') {
    /* #32：客户端断开（提交阶段断开或等待回复时断开）取消下游模型/检索；正常完成不取消 */
    const signal = createRequestSignal(ctx.req, ctx.res);
    const body = await readBody(ctx) || {};
    body.reasoning_effort=reasoningEffort(body.reasoning_effort);
    if(ctx.state.accessUser)body._access_user=ctx.state.accessUser;else delete body._access_user;
    const action=body.action===undefined?'chat':body.action;
    if(!['chat','prepare','generate','accept_preview','discard_preview'].includes(action)||body.text!==undefined&&typeof body.text!=='string')throw Object.assign(Error('对话请求字段无效。'),{status:400,expose:true});
    if(action==='chat'&&!body.text?.trim())throw Object.assign(Error('请先输入你的旅行想法。'),{status:400,expose:true});
    const taskId=ctx.state?.modelUsageTaskId || randomUUID(),events=[];
    const execute=async (progress=()=>{})=>{
    const observe=event=>{events.push({at:new Date().toISOString(),...event});progress(event);};
    const plan=guidePlanFromId(body.plan_id),data=await (runtimeServices()?.planningSessions || planningSessions).run(body,{signal,execute:(request,execution)=>conversationTurn(request,plan,{...execution,taskId,
      onTrace:observe,onModelUsage:value=>observe({stage:'model_usage',...value}),onSourceAudit:items=>observe({stage:'source_audit',items}),
      onSourceCollection:value=>observe({stage:'source_collection',...value})})});
    data.trace_id=taskId;
    try{const dir=join(root,'server','logs');appendBoundedJsonl(join(dir,'agent-trace.jsonl'),{task_id:taskId,action:body.action || 'chat',status:data.status,
      before:{revision:body.conversation?.revision || 0,requirements:body.conversation?.requirements},after:{revision:data.conversation?.revision || 0,requirements:data.conversation?.requirements},events});}catch{}
    data.research_update=draftResearchChanges(body,data,plan);
    return {code:0,data};
    };
    if(body.progressive===true){ctx.type='application/x-ndjson';ctx.set('Cache-Control','no-store');ctx.body=conversationStream(execute,signal);}else ctx.body=await execute();
    return;
  }
  if(path==='/api/anywhere/google-map-image' && ctx.method==='GET'){
    const ids=typeof ctx.query.ids==='string'?ctx.query.ids.split(','):[];
    const result=await googleStaticMap(ids,{signal:createRequestSignal(ctx.req,ctx.res)});
    ctx.set('Cache-Control','no-store');ctx.set('X-Content-Type-Options','nosniff');ctx.status=result.status;
    if(result.data){ctx.type='image/png';ctx.body=result.data;}else ctx.body={code:1,msg:'Google底图暂不可用',reason:result.reason};
    return;
  }
  if(path==='/api/anywhere/map-places' && ctx.method==='POST'){
    const signal=createRequestSignal(ctx.req,ctx.res),body=await readBody(ctx) || {};
    ctx.body={code:0,data:await runMapTool('map_cities',{names:body.names || [],places:Array.isArray(body.places)?body.places:[]},{signal})};return;
  }
  if(path==='/api/anywhere/day-schedule' && ctx.method==='POST'){
    const signal=createRequestSignal(ctx.req,ctx.res),body=await readBody(ctx) || {};
    ctx.set('Cache-Control','no-store');
    ctx.body={code:0,data:await checkDaySchedule(body,{signal})};return;
  }
  if(path==='/api/anywhere/day-map' && ctx.method==='POST'){
    const signal=createRequestSignal(ctx.req,ctx.res),body=await readBody(ctx) || {};
    ctx.body={code:0,data:await runMapTool('map_day',{...body,places:body.places || []},{signal})};return;
  }
  if (path === '/api/anywhere/route-research' && ctx.method === 'POST') {
    const signal=createRequestSignal(ctx.req,ctx.res),body=await readBody(ctx) || {};
    try{ctx.body={code:0,data:await researchSelectedRoute(body,guidePlanFromId(body.plan_id),searchWeb,{signal})};}
    catch(error){ctx.body={code:1,msg:error.message};}
    return;
  }
  if (path === '/api/anywhere/transport-search' && ctx.method === 'POST') {
    const signal = createRequestSignal(ctx.req, ctx.res);
    const body=await readBody(ctx) || {};
    try{ctx.body={code:0,data:await searchTransportSources({from:body.from,to:body.to,window:body.window,mode:body.mode,exclude_road:body.exclude_road,no_self_drive:body.no_self_drive,places:body.places},searchWeb,{signal})};}
    catch(error){ctx.body={code:1,msg:error.message};}
    return;
  }
  if (path === '/api/anywhere/transport-search-status' && ctx.method === 'POST') {
    const body=await readBody(ctx) || {};
    try{ctx.body={code:0,data:resolveTransportSearch({ids:body.ids,legs:body.legs,window:body.window})};}
    catch(error){ctx.body={code:1,msg:error.message};}
    return;
  }
  if (path === '/api/anywhere/transport-search-batch' && ctx.method === 'POST') {
    const signal=createRequestSignal(ctx.req,ctx.res),body=await readBody(ctx) || {};
    try{ctx.body={code:0,data:await searchDraftChanges(body,searchWeb,{signal})};}
    catch(error){ctx.body={code:1,msg:error.message};}
    return;
  }
  /* R1-C 有界补查：单个任务在共享预算内完成检索、读取、整合与证据核对后一次返回。
   * 依赖对象必须整体传入：请求断开/取消沿 deps.signal 进入循环预算（复审 P1-1）。 */
  if (path === '/api/anywhere/research-loop' && ctx.method === 'POST') {
    const signal=createRequestSignal(ctx.req,ctx.res),body=await readBody(ctx) || {};
    try{ctx.body={code:0,data:await runResearchLoop(body,{search:searchWeb,signal})};}
    catch(error){ctx.body={code:1,msg:error.message};}
    return;
  }
  if (path === '/api/anywhere/research-loop-status' && ctx.method === 'POST') {
    const body=await readBody(ctx) || {};
    try{ctx.body={code:0,data:resolveResearchLoop({task_id:body.task_id,task:body.task})};}
    catch(error){ctx.body={code:1,msg:error.message};}
    return;
  }
  /* G3：根据服务端保存的规划生成探索详情；客户端仅提交 plan_id、candidate_id 与停留晚数。 */
  if (path === '/api/anywhere/journey' && ctx.method === 'POST') {
    const body = await readBody(ctx) || {};
    try {
      ctx.body = { code: 0, data: journeyDetailFromPlanId(body.plan_id, body.candidate_id, body.stopover_nights ?? 0) };
    } catch (error) {
      ctx.body = { code: 1, msg: error.message };
    }
    return;
  }

  ctx.status=410;ctx.body={code:1,msg:'此旧接口已退役，请使用旅行对话与搜索规划。'};
}
app.use(async(ctx,next)=>{if(draining&&ctx.path.startsWith('/api/')){ctx.status=503;ctx.body={code:1,msg:'服务正在重启，请稍后重试'};return;}return next();});
upstreamBudgetConfig();
app.use(nodeAccounts());
app.use(createAccessPolicy());
app.use(async(ctx,next)=>{
  if(!ctx.path.startsWith('/api/'))return next();
  const taskId=randomUUID();ctx.state.modelUsageTaskId=taskId;
  return withRequestOwner(ctx.state.accessUser,()=>withModelUsageContext({task_id:taskId,operation:ctx.path},next));
});
app.use(apiRouter);
function readBody(ctx) {
  if(!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(ctx.req.headers?.['content-type'] || '')){ctx.req.once('error',()=>{});ctx.req.resume();throw Object.assign(Error('请使用JSON格式提交请求。'),{status:415,expose:true});}
  return readJsonBody(ctx.req);
}

/* query 字符串容错：koa 在无该 key 时返回空字符串优先，兼容 |undefined */
function qstr(v) { return v == null ? '' : String(v).trim(); }

/* ---------- 静态服务：七页原型（让前端以 http 源访问，fetch 可用；轻量实现，零额外依赖） ---------- */

const HIFI_DIR = join(root, 'mixtouring-hifi');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

app.use(async (ctx, next) => {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return next();
  const rel = ctx.path === '/' ? '/index.html' : ctx.path;
  let decoded;try{decoded=decodeURIComponent(rel);}catch{ctx.status=400;ctx.body='Invalid path';return;}
  const file = normalize(join(HIFI_DIR, decoded));
  if (!file.startsWith(HIFI_DIR + sep)) { ctx.status = 403; return; } /* 防目录穿越 */
  if (!existsSync(file) || !statSync(file).isFile()) { ctx.status = 404; ctx.type = 'text/plain; charset=utf-8'; ctx.body = 'Not Found'; return; }
  ctx.type = MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
  ctx.body = readFileSync(file);
});

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=app.listen(PORT,BIND_HOST,()=>console.log('✓ MixTouring旅行Agent已启动：http://'+BIND_HOST+':'+PORT));
  server.headersTimeout=15000;
  server.requestTimeout=40000;
  const shutdown=()=>{
    if(draining)return;
    draining=true;
    const deadline=setTimeout(()=>{server.closeAllConnections();process.exit(1);},150000);
    deadline.unref();
    server.close(()=>{clearTimeout(deadline);process.exit(0);});
  };
  process.once('SIGTERM',shutdown);
  process.once('SIGINT',shutdown);
}
