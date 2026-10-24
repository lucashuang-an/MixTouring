/* R1-C 有界补查回归：共享预算、增量判定、去重与跑题拦截、取消、鉴权停止、换范围失效与恢复只读。
 * 全部使用确定性桩：不联网、不使用真实模型。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {runResearchLoop,resolveResearchLoop,researchLoopTask,createResearchBudget,planFitsTask,RESEARCH_LOOP_LIMITS} from './lib/research-loop.mjs';

const now=Date.parse('2026-10-24T02:00:00Z');
const transportInput={question:'北京到阿拉木图的交通怎么走',gap:'直飞班期与票价未知',task_type:'transport',leg:{from:'北京',to:'阿拉木图',mode:'plane'},window:'2026-11-01 ~ 2026-11-08'};

async function harness({plans,searchResults,readPage=null,answer=null,extractSupports=true,assessment='supported',searchThrows=null,limits=null,signal=null,nowOverride=now,relevanceFail=false}={}){
  const calls={model:[],search:0,read:0};
  let planIndex=0;
  const model=async opts=>{
    calls.model.push(opts.kind);
    if(opts.kind==='research_loop_plan'){
      const plan=Array.isArray(plans)?plans[Math.min(planIndex++,plans.length-1)]:plans;
      return plan && typeof plan==='object'?plan:null;
    }
    if(opts.kind==='conversation_source_relevance'){
      if(relevanceFail)return null;
      const views=JSON.parse(opts.user).candidates;
      return {items:views.map(v=>({id:v.id,decision:'keep',reason:'与任务相关',quote:v.title}))};
    }
    if(opts.kind==='research_loop_answer')return {reply:answer || '来源记载北京到阿拉木图开通直飞，本次日期仍待确认。'};
    if(opts.kind==='conversation_evidence_extract'){
      const {fields,evidence_catalog}=JSON.parse(opts.user),entry=evidence_catalog.entries[0];
      return {items:fields.map(f=>({id:f.id,text:f.text,needs_source:extractSupports && /直飞/.test(f.text),
        allowed_use:'source_reference',supports:extractSupports && /直飞/.test(f.text) && entry?[{source_id:entry.id,quote:entry.excerpt}]:[]}))};
    }
    if(opts.kind==='conversation_evidence_support')return {items:JSON.parse(opts.user).claims.map(c=>({id:c.id,decision:assessment,reason:'原句支持该结论'}))};
    return {};
  };
  const search=async()=>{calls.search++;if(searchThrows)throw Error(searchThrows);return searchResults();};
  const read=async()=>{calls.read++;return readPage;};
  const record=await runResearchLoop(transportInput,{now:nowOverride,model,search,readPage:read,signal,limits});
  return {record,calls};
}
const fresh=i=>({title:'北京到阿拉木图客运公告'+(i||''),link:'https://example'+(i || 0)+'.gov.cn/transport/notice',content:'来源记载北京到阿拉木图开通直飞。',date:'2026-10-20'});

/* 1) 最小闭环：一轮检索→整合→证据核对在预算内完成，嵌套调用全部入账。 */
const minimal=await harness({plans:[{query:'北京 阿拉木图 官方 航班',foreign_query:'Beijing Almaty flight',rationale:'查官方班期'},{done:true}],searchResults:()=>[fresh()]});
assert.equal(minimal.record.status,'ok');
assert.equal(minimal.record.stop_reason,'planner_done');
assert.equal(minimal.record.rounds.length,1);
assert.ok(minimal.record.reply.includes('直飞'));
assert.equal(minimal.record.claims.length,1);
assert.equal(minimal.record.claims[0].supports[0].source_id,minimal.record.evidence_sources[0].id);
assert.equal(minimal.record.usage.model_calls,minimal.calls.model.length,'用量与实际调用一致，无隐藏开销');
assert.deepEqual(new Set(minimal.calls.model),new Set(['research_loop_plan','conversation_source_relevance','research_loop_answer','conversation_evidence_extract','conversation_evidence_support']));
assert.ok(minimal.record.usage.searches<=RESEARCH_LOOP_LIMITS.searches && minimal.record.usage.reads<=RESEARCH_LOOP_LIMITS.reads && minimal.record.usage.model_calls<=RESEARCH_LOOP_LIMITS.model_calls);

/* 2) 预算上限：三轮全程有增益也不得越过轮次、搜索与模型上限。 */
const plans3=[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 铁路',foreign_query:''},{query:'北京 阿拉木图 客运',foreign_query:''},{done:true}];
let sourceIndex=0;
const full=await harness({plans:plans3,searchResults:()=>[fresh(++sourceIndex)]});
assert.equal(full.record.stop_reason,'rounds');
assert.equal(full.record.rounds.length,3);
assert.equal(full.record.rounds.filter(r=>r.gain>0).length,3);
assert.equal(full.record.usage.searches,6);
assert.equal(full.record.usage.model_calls,7,'三轮规划+最终四次均在八次上限内');
assert.equal(full.calls.search,full.record.usage.searches);
assert.ok(full.record.status==='ok' && full.record.claims.length>=1);

/* 3) 新URL不算增量：旧日期资料只进历史线索，连续两轮无增益即停止。 */
let oldIndex=0;
const noGain=await harness({plans:plans3.slice(0,2).concat([{done:true}]),searchResults:()=>[{title:'旧攻略'+(++oldIndex),link:'https://example-old'+oldIndex+'.gov.cn/a',content:'历史上的口岸通行记录。',date:'2024-05-01'}]});
assert.equal(noGain.record.stop_reason,'no_gain');
assert.equal(noGain.record.rounds.length,2);
assert.ok(noGain.record.rounds.every(r=>r.gain===0));
assert.ok(noGain.record.leads.length>0 && noGain.record.sources.length===0,'旧资料只作历史线索');
assert.equal(noGain.record.status,'partial');

/* 4) 不重复原查询：规划再次给出同一查询即停止，不重复消耗搜索。 */
const repeat=await harness({plans:[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 航班',foreign_query:''}],searchResults:()=>[fresh()]});
assert.equal(repeat.record.stop_reason,'no_new_query');
assert.equal(repeat.record.rounds.length,1);
assert.equal(repeat.record.usage.searches,2);

/* 5) 体验任务跑题拦截：泛化的直达班次咨询不回答原问题，直接拒绝。 */
const experiencePlans=[{query:'北京到阿拉木图 直飞 班期',foreign_query:''}];
const experienceModel=async opts=>{
  if(opts.kind==='research_loop_plan')return experiencePlans[0];
  return {};
};
const offTopic=await runResearchLoop({question:'伊犁无车独自旅行怎么玩',gap:'无车可达的草原交通未知',task_type:'experience',destination:'伊犁'},
  {now,model:experienceModel,search:async()=>{throw Error('不应发起跑题搜索');}});
assert.equal(offTopic.stop_reason,'plan_off_topic');
assert.equal(offTopic.usage.search_calls,0);
assert.ok(planFitsTask({query:'伊犁 无车 草原 交通',foreign_query:'Yili grassland transport'},researchLoopTask({question:'伊犁无车独自旅行怎么玩',gap:'x',task_type:'experience',destination:'伊犁'},now)),'贴题查询仍可执行');

/* 6) 取消：中断后不再发起模型与搜索，部分轮次与来源保留并可在服务端只读恢复。 */
const cancelController=new AbortController();
const cancelPlans=[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 铁路',foreign_query:''}];
let cancelSearches=0;
const cancelModel=async opts=>{
  if(opts.kind==='research_loop_plan')return cancelPlans[0];
  if(opts.kind==='conversation_source_relevance')return {items:JSON.parse(opts.user).candidates.map(v=>({id:v.id,decision:'keep',reason:'相关',quote:v.title}))};
  throw Error('取消后不得再调用模型');
};
const cancelled=await runResearchLoop(transportInput,{now,model:cancelModel,signal:cancelController.signal,
  search:async()=>{cancelSearches++;const results=[fresh()];cancelController.abort();return results;},readPage:null});
assert.equal(cancelled.stop_reason,'cancelled');
assert.equal(cancelled.rounds.length,0,'取消轮不登记为完成');
const restoredCancel=resolveResearchLoop({task_id:cancelled.task.id,task:transportInput},{now:now+1000});
assert.equal(restoredCancel.record.task.id,cancelled.task.id,'部分记录可只读恢复');
assert.equal(restoredCancel.record.restored_lookup,true);

/* 7) 鉴权失败：通道全部不可用时停止追加搜索，不重试消耗。 */
const auth=await harness({plans:cancelPlans,searchResults:()=>[fresh()],searchThrows:'401 Unauthorized'});
assert.equal(auth.record.stop_reason,'search_unavailable');
assert.equal(auth.record.rounds.length,1);
assert.equal(auth.record.usage.searches,2,'只有本轮两次尝试，未再追加');
assert.equal(auth.calls.search,2);

/* 8) 换范围失效与恢复有效期：同任务可恢复，换窗/过期/改写编号都拿不到记录。 */
const restoredSame=resolveResearchLoop({task_id:minimal.record.task.id,task:transportInput},{now:now+1000});
assert.ok(restoredSame.record && restoredSame.record.claims.length===1);
assert.equal(resolveResearchLoop({task_id:minimal.record.task.id,task:{...transportInput,window:'2026-12-01 ~ 2026-12-08'}},{now:now+1000}).record,null,'换日期窗后旧记录失效');
assert.equal(resolveResearchLoop({task_id:minimal.record.task.id,task:transportInput},{now:now+900001}).record,null,'恢复不续期');
assert.throws(()=>resolveResearchLoop({task_id:'fake'},{now}),'记录编号需校验');
assert.equal(resolveResearchLoop({task_id:minimal.record.task.id,task:{...transportInput,leg:{from:'北京',to:'乌鲁木齐',mode:'plane'}}},{now:now+1000}).record,null,'换路段后旧记录失效');
const byIdentity=resolveResearchLoop({task:transportInput},{now:now+1000});
assert.equal(byIdentity.record.task.question,transportInput.question,'取消后可按任务身份找回最新部分结果');

/* 9) 读原文轮：只读当前来源，读到正文计为增量；同一篇原文不重复读，历史线索不在可选范围。 */
const readPlans=[
  {query:'北京 阿拉木图 官方 航班',foreign_query:''},
  {read_url:'https://example0.gov.cn/transport/notice'},
  {done:true}];
let directReads=0;
const readRecord=await runResearchLoop(transportInput,{now,
  model:async opts=>{
    if(opts.kind==='research_loop_plan')return readPlans[0] && readPlans.shift();
    if(opts.kind==='conversation_source_relevance')return {items:JSON.parse(opts.user).candidates.map(v=>({id:v.id,decision:'keep',reason:'相关',quote:v.title}))};
    if(opts.kind==='research_loop_answer')return {reply:'来源记载北京到阿拉木图开通直飞，本次日期仍待确认。'};
    if(opts.kind==='conversation_evidence_extract'){
      const {fields,evidence_catalog}=JSON.parse(opts.user),entry=evidence_catalog.entries[0];
      return {items:fields.map(f=>({id:f.id,text:f.text,needs_source:/直飞/.test(f.text),allowed_use:'source_reference',supports:/直飞/.test(f.text)&&entry?[{source_id:entry.id,quote:entry.excerpt}]:[]}))};
    }
    if(opts.kind==='conversation_evidence_support')return {items:JSON.parse(opts.user).claims.map(c=>({id:c.id,decision:'supported',reason:'原句支持'}))};
    return {};
  },
  search:async()=>[fresh()],
  readPage:async url=>{directReads++;return directReads>=2?{read_status:'page_excerpt',url,excerpt:'来源记载北京到阿拉木图开通直飞，每周三班。',title:'北京到阿拉木图客运公告',published_at:'2026-10-18'}:null;}});
assert.equal(readRecord.stop_reason,'planner_done');
assert.equal(readRecord.rounds[1].read_url,'https://example0.gov.cn/transport/notice');
assert.equal(readRecord.rounds[1].gain,1,'读到正文计为增量');
assert.equal(readRecord.sources[0].read_status,'page_excerpt');
const reread=await runResearchLoop(transportInput,{now,model:async opts=>opts.kind==='research_loop_plan'?{read_url:'https://example0.gov.cn/transport/notice'}:{},
  search:async()=>[fresh()]});
assert.equal(reread.stop_reason,'no_new_read','同一篇原文去重');

/* 10) 预算与核对失败都保留部分成果：削减轮次仍预留终验；核对未完成不发布回复。 */
let tightIndex=0;
const tight=await harness({plans:plans3,searchResults:()=>[fresh(++tightIndex)],limits:{...RESEARCH_LOOP_LIMITS,model_calls:6}});
assert.equal(tight.record.stop_reason,'budget_model','模型额度不足提前停轮');
assert.equal(tight.record.rounds.length,2);
assert.ok(tight.record.sources.length>=1,'部分成果保留');
assert.equal(tight.record.status,'ok','预留额度仍保证最终整合与证据核对完成');
const unverified=await harness({plans:[{query:'北京 阿拉木图 航班',foreign_query:''},{done:true}],searchResults:()=>[fresh()],relevanceFail:true});
assert.equal(unverified.record.stop_reason,'relevance_unavailable');
assert.equal(unverified.record.reply,null,'未核对回复不发布');
assert.ok(unverified.record.sources.length>=1,'来源保留为待核对线索');
assert.equal(unverified.record.status,'partial');

/* 11) 预算对象合同：失败与重试占原额度，调用前拦截。 */
const budget=createResearchBudget({now,signal:new AbortController().signal});
assert.equal(budget.take('searches',8),null);
assert.equal(budget.take('searches'),'budget_searches');
assert.equal(budget.take('rounds',3),null);
assert.equal(budget.take('rounds'),'budget_rounds');

/* 12) 桌面入口合同：待查清单出入口、绑定正确、取消可找回部分结果、新输入失效、恢复只读。 */
const html=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');
const gapStart=html.indexOf('var GAP_STOP_LABELS='),gapEnd=html.indexOf('function renderResearchProgress(){');
assert.ok(gapStart>=0 && gapEnd>gapStart,'trip.html 保留有界补查入口代码块');
const store={};const posts=[];
const loopRecord={status:'ok',stop_reason:'planner_done',task:{id:'research_loop_ui'},rounds:[{round:1,query:'北京 阿拉木图 航班',gain:1}],
  claims:[{sentence:'来源记载北京到阿拉木图开通直飞，本次日期仍待确认。',allowed_use:'source_reference',supports:[{source_id:'src_ui',quote:'来源记载北京到阿拉木图开通直飞。'}]}],
  evidence_sources:[{id:'src_ui',url:'https://example.gov.cn/notice',title:'公告',published_at:'2026-10-20'}],leads:[],reply:'来源记载北京到阿拉木图开通直飞，本次日期仍待确认。',evidence_gaps:[]};
const env={console,JSON,Object,Array,Date,Error,Promise,Set,encodeURIComponent,decodeURIComponent,AbortController,
  MT:{esc:v=>String(v == null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),toast(){}},
  sessionStorage:{getItem:k=>store[k] ?? null,setItem(k,v){store[k]=String(v);},removeItem(k){delete store[k];}},
  guideMessages:[{role:'user',text:'北京到阿拉木图怎么走'}],guideSequence:1,
  conversation:{routing:{origin:'北京',destination:'阿拉木图'},draft:{route:['北京','阿拉木图'],pending:['跨境交通须有可核查来源及适用日期。']}},
  researchScope:null,researchTasks:null,lastEvidenceGaps:['北京到阿拉木图有直飞'],
  researchLoopState:{running:false,record:null,binding:null,error:null,interrupted:false,controller:null},restoredGapResearch:null,
  currentSearchWindow:()=>'2026-11-01 ~ 2026-11-08',guideState:{road:null},anchors:{},
  taskScope:()=>({route:['北京','阿拉木图'],window:'2026-11-01 ~ 2026-11-08',legs:[{from:'北京',to:'阿拉木图',mode:'unknown',exclude_road:false,locked:false}]}),
  renderResearchProgress(){env.rendered=env.gapResearchHtml(false,true);},
  rendered:'',
  post:async(url,body,signal)=>{posts.push({url,body,signal});
    if(url==='/api/anywhere/research-loop'){
      /* 等一拍让测试侧模拟用户点击取消（控制器中止），再按真实 fetch 语义抛 AbortError。 */
      await new Promise(resolve=>setTimeout(resolve,5));
      if(env.abortOnRun && signal?.aborted)throw Object.assign(new Error('The operation was aborted'),{name:'AbortError'});
      return {code:0,data:structuredClone(loopRecord)};}
    if(url==='/api/anywhere/research-loop-status')return {code:0,data:{record:{...structuredClone(loopRecord),stop_reason:'cancelled'}}};
    throw Error('意外的接口调用 '+url);}};
env.globalThis=env;env.window=env;
vm.createContext(env);
vm.runInContext(html.slice(gapStart,gapEnd),env);
const entryHtml=env.gapResearchHtml(false,true);
assert.ok(entryHtml.includes('继续核对缺口') && entryHtml.includes('跨境交通须有可核查来源及适用日期。'),'待查清单成为显式补查入口');
assert.ok(entryHtml.includes('交通补查 · 北京 → 阿拉木图'),'交通类待查显示绑定路段');
assert.ok(entryHtml.includes('北京到阿拉木图有直飞') && entryHtml.includes('体验补查 · 阿拉木图')===false,'缺口句进入清单并按内容绑定类型');
let ran=env.runGapResearch('跨境交通须有可核查来源及适用日期。');
await ran;
assert.equal(posts[0].url,'/api/anywhere/research-loop');
assert.equal(posts[0].body.task_type,'transport');
assert.equal(posts[0].body.leg.from,'北京');
assert.equal(posts[0].body.question,'北京到阿拉木图怎么走','任务绑定原问题');
assert.equal(posts[0].body.window,'2026-11-01 ~ 2026-11-08');
assert.ok(env.researchLoopState.record && env.rendered.includes('1 条经核对的支持结论'),'完成后展示经核对结论与停止原因');
assert.ok(env.rendered.includes('https://example.gov.cn/notice'),'支持结论附来源链接');
assert.ok(JSON.parse(store['mt:gap-research']).task_id==='research_loop_ui','记录写入本机只读存储');
env.cancelGapResearch();
assert.equal(env.researchLoopState.record,null,'新输入或重置使旧补查结果失效');
env.abortOnRun=true;
const cancelRun=env.runGapResearch('跨境交通须有可核查来源及适用日期。');
setTimeout(()=>env.researchLoopState.controller.abort(),0);/* 模拟点击取消按钮 */
await cancelRun;
assert.equal(posts.at(-1).url,'/api/anywhere/research-loop-status','取消后按任务身份找回部分结果');
assert.equal(env.researchLoopState.record.stop_reason,'cancelled');
assert.ok(env.rendered.includes('已取消'));
env.cancelGapResearch();/* 新输入或重置使旧补查失效，再模拟刷新后的只读恢复 */
env.restoredGapResearch={claims:['x'],stop_reason:'planner_done',reply:'上次结论'};
const restoredHtml=env.gapResearchHtml(false,true);
assert.ok(restoredHtml.includes('上次补查记录（只读）') && restoredHtml.includes('不自动重启付费任务'),'恢复只读且不自动重启');

console.log('✓ R1-C 有界补查：共享预算、增量与去重、取消、鉴权停止、换范围失效、恢复只读与桌面入口通过');
