/* 搜索驱动的旅行Agent服务；无预置地点、方案或离线生成器。 */
import Koa from 'koa';
import {PassThrough} from 'node:stream';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join,normalize,sep,resolve} from 'node:path';
import {composeConfigured,webSearchStatus,searchWeb} from './lib/llm.mjs';
import {capabilities,webSearchConfigured} from './lib/trip-service.mjs';
import {registerJourneyPlan,journeyDetailFromPlanId,guidePlanFromId} from './lib/journey.mjs';
import {conversationTurn} from './lib/conversation.mjs';
import {buildRouteComparison} from './lib/route-comparison.mjs';
import {researchSelectedRoute} from './lib/route-research.mjs';
import {draftResearchChanges,searchDraftChanges} from './lib/draft-research.mjs';
import {createRequestSignal} from './lib/request-signal.mjs';
import {searchTransportSources,resolveTransportSearch} from './lib/transport-search.mjs';
import {runResearchLoop,resolveResearchLoop} from './lib/research-loop.mjs';
import {progressivePlan} from './lib/progressive.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const PORT=Number(process.env.PORT) || 3000;
export const app=new Koa();
app.use(async(ctx,next)=>{try{await next();}catch(error){console.error('✗ 请求失败：'+error.message);ctx.status=500;ctx.body={code:1,msg:'服务内部错误'};}});
export async function apiRouter(ctx,next){
  if(!ctx.path.startsWith('/api/') && ctx.path!=='/healthz')return next();
  ctx.type='application/json; charset=utf-8';const path=ctx.path;
  if(path==='/healthz'){ctx.body={status:'ok'};return;}
  if(path==='/api/capabilities'){ctx.body={code:0,data:capabilities(composeConfigured(),webSearchConfigured().configured,webSearchStatus().status)};return;}
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
      planner(body, (data, phase) => {
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
    const plan=guidePlanFromId(body.plan_id),data=await conversationTurn(body,plan,{signal});
    data.research_update=draftResearchChanges(body,data,plan);
    ctx.body = { code: 0, data };
    return;
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
    try{ctx.body={code:0,data:await searchTransportSources({from:body.from,to:body.to,window:body.window,mode:body.mode,exclude_road:body.exclude_road,places:body.places},searchWeb,{signal})};}
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
app.use(apiRouter);
function readBody(ctx) {
  return new Promise((resolve) => {
    let raw = '';
    ctx.req.on('data', (c) => { raw += c; });
    ctx.req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ raw }); }
    });
  });
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
  const file = normalize(join(HIFI_DIR, decodeURIComponent(rel)));
  if (!file.startsWith(HIFI_DIR + sep)) { ctx.status = 403; return; } /* 防目录穿越 */
  if (!existsSync(file) || !statSync(file).isFile()) { ctx.status = 404; ctx.type = 'text/plain; charset=utf-8'; ctx.body = 'Not Found'; return; }
  ctx.type = MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
  ctx.body = readFileSync(file);
});

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))app.listen(PORT,()=>console.log('✓ MixTouring旅行Agent已启动：http://localhost:'+PORT));
