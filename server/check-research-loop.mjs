/* R1-C 有界补查回归：共享预算、逐轮相关性与数字守门、增量判定、去重与跑题拦截、取消、
 * 鉴权停止、换范围失效与恢复只读、桌面入口与旧请求隔离。全部确定性桩：不联网、不使用真实模型。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {runResearchLoop,resolveResearchLoop,researchLoopTask,createResearchBudget,planFitsTask,RESEARCH_LOOP_LIMITS} from './lib/research-loop.mjs';

const now=Date.parse('2026-10-24T02:00:00Z');
const transportInput={question:'北京到阿拉木图的交通怎么走',gap:'直飞班期与票价未知',task_type:'transport',leg:{from:'北京',to:'阿拉木图',mode:'plane'},window:'2026-11-01 ~ 2026-11-08'};

async function harness({plans,searchResults,readPage=null,answer=null,extractSupports=true,assessment='supported',searchThrows=null,limits=null,signal=null,nowOverride=now,relevanceFail=false,relevanceDecision='keep',task=transportInput,modelHook=null}={}){
  const calls={model:[],search:0,read:0};
  let planIndex=0;
  const model=async opts=>{
    calls.model.push(opts.kind);
    if(modelHook){const override=await modelHook(opts);if(override!==undefined)return override;}
    if(opts.kind==='research_loop_plan'){
      const plan=Array.isArray(plans)?plans[Math.min(planIndex++,plans.length-1)]:plans;
      return plan && typeof plan==='object'?plan:null;
    }
    if(opts.kind==='conversation_source_relevance'){
      if(relevanceFail)return null;
      const views=JSON.parse(opts.user).candidates;
      return {items:views.map(v=>({id:v.id,decision:relevanceDecision,reason:relevanceDecision==='keep'?'与任务相关':'与任务无关',quote:v.title}))};
    }
    if(opts.kind==='research_loop_answer')return {reply:answer || '来源记载北京到阿拉木图开通直飞，本次日期仍待确认。'};
    if(opts.kind==='conversation_evidence_extract'){
      const {fields,evidence_catalog}=JSON.parse(opts.user),entry=evidence_catalog.entries[0];
      return {items:fields.map(f=>({id:f.id,text:f.text,needs_source:extractSupports && /直飞|200元/.test(f.text),
        allowed_use:'source_reference',supports:extractSupports && /直飞|200元/.test(f.text) && entry?[{source_id:entry.id,quote:entry.excerpt}]:[]}))};
    }
    if(opts.kind==='conversation_evidence_support')return {items:JSON.parse(opts.user).claims.map(c=>({id:c.id,decision:assessment,reason:'原句支持该结论'}))};
    return {};
  };
  const search=async(query,options)=>{calls.search++;if(searchThrows)throw Error(searchThrows);return searchResults(query,options);};
  const read=async(url,options)=>{calls.read++;return typeof readPage==='function'?readPage(url,options):readPage;};
  const record=await runResearchLoop(task,{now:nowOverride,model,search,readPage:read,signal,limits});
  return {record,calls};
}
const fresh=i=>({title:'北京到阿拉木图客运公告'+(i||''),link:'https://example'+(i || 0)+'.gov.cn/transport/notice',content:'来源记载北京到阿拉木图开通直飞。',date:'2026-10-20'});

/* 0) 接口取消接通（复审 P1-1）：正式路由必须把依赖对象整体传入，丢弃 signal 的三参数形状不允许再出现。 */
assert.ok(readFileSync(new URL('./index.mjs',import.meta.url),'utf8').includes('runResearchLoop(body,{search:searchWeb,signal})'),'research-loop 路由以依赖对象传参，请求取消接通共享预算');

/* 1) 最小闭环：一轮检索→逐轮相关性→整合→证据与数字核对在预算内完成，嵌套调用全部入账。 */
const minimal=await harness({plans:[{query:'北京 阿拉木图 官方 航班',foreign_query:'Beijing Almaty flight',rationale:'查官方班期'},{done:true}],searchResults:()=>[fresh()]});
assert.equal(minimal.record.status,'ok');
assert.equal(minimal.record.stop_reason,'planner_done');
assert.equal(minimal.record.rounds.length,1);
assert.equal(minimal.record.rounds[0].relevance,'completed','相关性核对逐轮执行');
assert.ok(minimal.record.reply.includes('直飞'));
assert.equal(minimal.record.claims.length,1);
assert.equal(minimal.record.claims[0].supports[0].source_id,minimal.record.evidence_sources[0].id);
assert.equal(minimal.record.usage.model_calls,minimal.calls.model.length,'用量与实际调用一致，无隐藏开销');
assert.deepEqual(new Set(minimal.calls.model),new Set(['research_loop_plan','conversation_source_relevance','research_loop_answer','conversation_evidence_extract','conversation_evidence_support']));
assert.equal(minimal.record.usage.model_calls,6);
assert.ok(minimal.record.usage.searches<=RESEARCH_LOOP_LIMITS.searches && minimal.record.usage.reads<=RESEARCH_LOOP_LIMITS.reads && minimal.record.usage.model_calls<=RESEARCH_LOOP_LIMITS.model_calls);

/* 2) 满三轮仍有增益：三轮后按轮次上限停止，终验照常完成，不越上限。 */
let sourceIndex=0;
const plans3=[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 铁路',foreign_query:''},{query:'北京 阿拉木图 客运',foreign_query:''},{done:true}];
const full=await harness({plans:plans3,searchResults:()=>[fresh(++sourceIndex)]});
assert.equal(full.record.stop_reason,'rounds','三轮增益后按轮次上限停止');
assert.equal(full.record.rounds.length,3);
assert.equal(full.record.rounds.filter(r=>r.gain>0).length,3);
assert.equal(full.record.usage.searches,6);
assert.equal(full.record.usage.model_calls,9,'三轮各一次规划+逐轮相关性+终验三次均在十二次上限内');
assert.equal(full.calls.search,full.record.usage.searches);
assert.equal(full.record.status,'ok');
assert.ok(full.record.claims.length>=1);
/* 模型额度不足时以预算停止并保留部分成果，不强行发布未核对回复。 */
const capped=await harness({plans:[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 铁路',foreign_query:''}],searchResults:()=>[fresh('cap')],limits:{...RESEARCH_LOOP_LIMITS,model_calls:7}});
assert.equal(capped.record.stop_reason,'budget_model');
assert.equal(capped.record.rounds.length,2);
assert.ok(capped.record.reply && capped.record.claims.length,'在继续补查前保住终验，提前收尾仍交付有出处的回答');
assert.ok(capped.record.sources.length>=1,'部分成果保留');
assert.equal(capped.record.status,'ok');
assert.ok(capped.record.usage.model_calls<=7);

/* 3) 新URL不算增量：旧日期资料只进历史线索，连续两轮无已核对增益即停止。 */
let oldIndex=0;
const noGain=await harness({plans:[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 铁路',foreign_query:''},{done:true}],
  searchResults:()=>[{title:'旧攻略'+(++oldIndex),link:'https://example-old'+oldIndex+'.gov.cn/a',content:'历史上的口岸通行记录。',date:'2024-05-01'}]});
assert.equal(noGain.record.stop_reason,'no_gain');
assert.equal(noGain.record.rounds.length,2);
assert.ok(noGain.record.rounds.every(r=>r.gain===0));
assert.ok(noGain.record.leads.length>0 && noGain.record.sources.length===0,'旧资料只作历史线索');
assert.equal(noGain.record.status,'partial');

/* 3b) 增益只认已核对来源（复审 P1-3）：相关性全部拒绝时两轮即停，不再打满六次搜索。 */
let rejectIndex=0;
const rejected=await harness({plans:plans3.slice(0,2).concat([{done:true}]),relevanceDecision:'reject',
  searchResults:()=>[fresh(++rejectIndex)]});
assert.equal(rejected.record.stop_reason,'no_gain','被拒来源不计增益');
assert.equal(rejected.record.rounds.length,2);
assert.equal(rejected.record.usage.searches,4,'未打满三轮六搜');
assert.equal(rejected.record.sources.length,0);
assert.equal(rejected.record.status,'partial');

/* 4) 不重复原查询：规划再次给出同一查询即停止，不重复消耗搜索。 */
const repeat=await harness({plans:[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 航班',foreign_query:''}],searchResults:()=>[fresh()]});
assert.equal(repeat.record.stop_reason,'no_new_query');
assert.equal(repeat.record.rounds.length,1);
assert.equal(repeat.record.usage.searches,2);

/* 5) 体验任务跑题拦截：泛化的直达班次咨询不回答原问题，直接拒绝。 */
const offTopic=await runResearchLoop({question:'伊犁无车独自旅行怎么玩',gap:'无车可达的草原交通未知',task_type:'experience',destination:'伊犁'},
  {now,model:async opts=>opts.kind==='research_loop_plan'?{query:'北京到阿拉木图 直飞 班期',foreign_query:''}:{},
  search:async()=>{throw Error('不应发起跑题搜索');}});
assert.equal(offTopic.stop_reason,'plan_off_topic');
assert.equal(offTopic.usage.search_calls,0);
assert.ok(planFitsTask({query:'伊犁 无车 草原 交通',foreign_query:'Yili grassland transport'},researchLoopTask({question:'伊犁无车独自旅行怎么玩',gap:'x',task_type:'experience',destination:'伊犁'},now)),'贴题查询仍可执行');

/* 6) 取消：中断后不再发起模型与搜索，部分轮次与来源保留并可在服务端只读恢复。 */
const cancelController=new AbortController();
const cancelPlans=[{query:'北京 阿拉木图 航班',foreign_query:''},{query:'北京 阿拉木图 铁路',foreign_query:''}];
let cancelSearches=0;
const cancelled=await runResearchLoop(transportInput,{now,
  model:async opts=>{
    if(opts.kind==='research_loop_plan')return cancelPlans[0];
    if(opts.kind==='conversation_source_relevance')return {items:JSON.parse(opts.user).candidates.map(v=>({id:v.id,decision:'keep',reason:'相关',quote:v.title}))};
    throw Error('取消后不得再调用模型');
  },signal:cancelController.signal,
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

/* 9) 读原文轮：只读当前来源，读到正文不计增益；同一篇原文不重复读。 */
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
    if(opts.kind==='conversation_evidence_extract'){const {fields,evidence_catalog}=JSON.parse(opts.user),e=evidence_catalog.entries[0];return {items:fields.map(f=>({id:f.id,text:f.text,needs_source:/直飞/.test(f.text),allowed_use:'source_reference',supports:/直飞/.test(f.text)&&e?[{source_id:e.id,quote:e.excerpt}]:[]}))};}
    if(opts.kind==='conversation_evidence_support')return {items:JSON.parse(opts.user).claims.map(c=>({id:c.id,decision:'supported',reason:'原句支持'}))};
    return {};
  },
  search:async()=>[fresh()],
  readPage:async url=>{directReads++;return directReads>=2?{read_status:'page_excerpt',url,excerpt:'来源记载北京到阿拉木图开通直飞，每周三班。',title:'北京到阿拉木图客运公告',published_at:'2026-10-18'}:null;}});
assert.equal(readRecord.stop_reason,'planner_done');
assert.equal(readRecord.rounds[1].read_url,'https://example0.gov.cn/transport/notice');
assert.equal(readRecord.rounds[1].gain,0,'读到正文不等于新增支持，不计增益');
assert.equal(readRecord.sources[0].read_status,'page_excerpt');
const reread=await runResearchLoop(transportInput,{now,model:async opts=>opts.kind==='research_loop_plan'?{read_url:'https://example0.gov.cn/transport/notice'}:{},
  search:async()=>[fresh()]});
assert.equal(reread.stop_reason,'no_new_read','同一篇原文去重');

/* 10) 预算不足与相关性核对失败都保留部分成果。 */
const tight=await harness({plans:[{query:'北京 阿拉木图 航班',foreign_query:''},{done:true}],searchResults:()=>[fresh()],limits:{...RESEARCH_LOOP_LIMITS,model_calls:5}});
assert.equal(tight.record.stop_reason,'budget_model');
assert.equal(tight.record.rounds.length,1);
assert.equal(tight.record.status,'ok','五次额度可完成最小一轮与终验，不再用未核对结果代替答复');
assert.ok(tight.record.reply && tight.record.claims.length);
assert.equal(tight.record.usage.model_calls,5);
assert.ok(tight.record.sources.length>=1,'部分成果保留');
const insufficient=await harness({plans:plans3,searchResults:()=>[fresh()],limits:{...RESEARCH_LOOP_LIMITS,model_calls:4}});
assert.equal(insufficient.record.stop_reason,'budget_model');
assert.equal(insufficient.record.reply,null,'不足以完成最小闭环时不发布未经核对的回答');
assert.equal(insufficient.record.usage.model_calls,0);
assert.equal(insufficient.calls.search,0,'不足以完成闭环时也不白耗检索额度');
const unverified=await harness({plans:[{query:'北京 阿拉木图 航班',foreign_query:''},{done:true}],searchResults:()=>[fresh()],relevanceFail:true});
assert.equal(unverified.record.stop_reason,'relevance_unavailable','逐轮核对未完成即诚实停止');
assert.equal(unverified.record.reply,null,'未核对回复不发布');
assert.equal(unverified.record.status,'partial');

/* 11) 数字守门（复审 P1-2）：语义核对误判也不能把行李费发布成机票价格。 */
const numericSource=()=>[{title:'北京到阿拉木图航空行李规定',link:'https://example0.gov.cn/transport/baggage',content:'北京到阿拉木图航线航空行李托运费200元。',date:'2026-10-20'}];
const fareSwap=await harness({plans:[{query:'北京 阿拉木图 行李 票价',foreign_query:''},{done:true}],searchResults:numericSource,
  answer:'资料记载北京到阿拉木图的机票价格为200元，仅供参考。'});
assert.equal(fareSwap.record.verify_status,'numeric_rejected','数字口径不一致被守门拒绝');
assert.equal(fareSwap.record.reply,null,'错误口径回复不发布');
assert.equal(fareSwap.record.status,'partial');
assert.ok(fareSwap.record.evidence_gaps.length>=1);
const fareHonest=await harness({plans:[{query:'北京 阿拉木图 行李 票价',foreign_query:''},{done:true}],searchResults:numericSource,
  answer:'资料记载北京到阿拉木图航线航空行李托运费为200元，仅供参考，本次日期仍待确认。'});
assert.equal(fareHonest.record.status,'ok','同口径数字照常发布');
assert.ok(fareHonest.record.reply.includes('行李托运费'));

/* 12) 搜索出口去重（复审 P2-6）：换无效外文串重发相同中文查询时按实际查询跳过。 */
const {record:dupRecord}=await harness({plans:[{query:'北京 阿拉木图 官方 航班',foreign_query:'aa'},{query:'北京 阿拉木图 官方 航班',foreign_query:'bb'},{done:true}],searchResults:()=>[fresh()]});
assert.equal(dupRecord.usage.dedup_searches,1,'相同实际查询在出口被跳过');
assert.equal(dupRecord.usage.search_calls,3,'真实网络搜索只发三条');
assert.equal(dupRecord.usage.searches,3,'去重不消耗搜索预算');

/* 13) 预算对象合同：失败与重试占原额度，调用前拦截。 */
/* 复审补充：数字只能取最终实际可见视图，不能从长正文或修复前的目录补回。 */
const priceQuote='北京到阿拉木图航空机票票价200元。';
const guessedPrice='资料记载北京到阿拉木图航空机票票价为200元，仅供参考，本次日期仍待确认。';
const priceSource=()=>[{title:'北京到阿拉木图航空票价资料',link:'https://example0.gov.cn/fare',content:'北京到阿拉木图航空交通资料。',date:'2026-10-20'}];
for(const repair of [false,true]){
  let generatedPriceVisible=null;
  const hiddenPrice=await harness({plans:[{query:'北京 阿拉木图 机票票价',foreign_query:''},{done:true}],searchResults:priceSource,
    readPage:url=>({url,title:'北京到阿拉木图航空票价资料',excerpt:'北京到阿拉木图航空背景。'.repeat(160)+priceQuote,read_status:'page_excerpt',published_at:'2026-10-20'}),
    answer:repair?'北京到阿拉木图有直飞。':guessedPrice,extractSupports:false,
    modelHook:opts=>{
      if(opts.kind==='research_loop_answer')generatedPriceVisible=JSON.parse(opts.user).evidence_catalog.entries.some(e=>e.excerpt.includes('200元'));
      if(opts.kind==='conversation_evidence_repair')return {reply:guessedPrice};
    }});
  assert.equal(generatedPriceVisible,false,'测试确实把价格放在生成可见目录之外');
  assert.ok(hiddenPrice.record.sources.some(s=>s.excerpt.includes('200元')),'完整来源池确实含该价格，不能拿空输入当拒绝正例');
  assert.equal(hiddenPrice.record.verify_status,'numeric_rejected',repair?'修复后的数字也使用实际可见视图':'抽取漏标不能借完整正文放行价格');
  assert.equal(hiddenPrice.record.reply,null);
}
const visiblePrice=await harness({plans:[{query:'北京 阿拉木图 机票票价',foreign_query:''},{done:true}],searchResults:priceSource,
  readPage:url=>({url,title:'北京到阿拉木图航空票价资料',excerpt:priceQuote,read_status:'page_excerpt',published_at:'2026-10-20'}),answer:guessedPrice});
assert.equal(visiblePrice.record.status,'ok','同方向、同项目、实际可见且有出处的价格仍可引用');
assert.ok(visiblePrice.record.claims.length && visiblePrice.record.evidence_sources.length);
const unlinkedPrice=await harness({plans:[{query:'北京 阿拉木图 机票票价',foreign_query:''},{done:true}],searchResults:()=>[{...priceSource()[0],content:priceQuote}],
  answer:guessedPrice,extractSupports:false});
assert.equal(unlinkedPrice.record.verify_status,'numeric_rejected','数字即使可见，也不能丢掉最终出处关联');

/* 补读改变内容后必须重审；失败、无关和旧日期不能沿用摘要的 keep。 */
async function rereadCase({decision='keep',date='2026-10-20'}={}){
  let reads=0,reviews=0;
  const url='https://example0.gov.cn/museum',body=decision==='keep'?'昆明铁路博物馆设有米轨展览。':'该酒店提供早餐。';
  const result=await harness({task:{question:'昆明铁路博物馆开放情况',gap:'博物馆展览与开放待查',task_type:'experience',destination:'昆明'},
    plans:[{query:'昆明 铁路博物馆 开放资料',foreign_query:''},{read_url:url},{done:true}],
    searchResults:()=>[{title:'昆明铁路博物馆资料',link:url,content:'昆明铁路博物馆开放信息资料。',date:'2026-10-20'}],
    readPage:()=>++reads===1?null:{url,title:decision==='keep'?'昆明铁路博物馆资料':'酒店介绍',excerpt:body,read_status:'page_excerpt',published_at:date},
    answer:'资料记载昆明铁路博物馆设有米轨展览。',
    modelHook:opts=>{
      if(opts.kind==='conversation_source_relevance'){
        const candidates=JSON.parse(opts.user).candidates;reviews++;
        if(reviews>1){assert.equal(candidates[0].excerpt,body,'第二次相关性必须看到新正文');if(decision==='unavailable')return null;}
        return {items:candidates.map(c=>({id:c.id,decision:reviews===1?'keep':decision,reason:'按实际正文核对任务',quote:c.title}))};
      }
      if(opts.kind==='conversation_evidence_extract'){
        const {fields,evidence_catalog}=JSON.parse(opts.user);return {items:fields.map(f=>({id:f.id,text:f.text,needs_source:true,allowed_use:'source_reference',supports:[{source_id:evidence_catalog.entries[0]?.id,quote:body}]}))};
      }
    }});
  return {...result,reviews};
}
const changedArticle=await rereadCase({decision:'reject'});
assert.equal(changedArticle.reviews,2);
assert.equal(changedArticle.record.sources.length,0);
assert.equal(changedArticle.record.reply,null,'博物馆问题不能发布补读后无关的酒店结论');
assert.ok(!changedArticle.calls.model.includes('research_loop_answer'));
const validArticle=await rereadCase();
assert.equal(validArticle.reviews,2);
assert.equal(validArticle.record.status,'ok');assert.equal(validArticle.record.claims.length,1,'相关新正文仍正常进入终验');
for(const decision of ['uncertain','unavailable']){
  const pending=await rereadCase({decision});
  assert.equal(pending.record.stop_reason,'relevance_unavailable');
  assert.equal(pending.record.sources.length,0);assert.equal(pending.record.unreviewed_sources.length,1,'未核对新正文作为部分成果保留，不能当作当前依据');
  assert.equal(pending.record.reply,null);
}
const datedArticle=await rereadCase({date:'2024-05-01'});
assert.equal(datedArticle.record.sources.length,0);assert.equal(datedArticle.record.leads.length,1);
assert.equal(datedArticle.record.leads[0].published_at,'2024-05-01','补读发现旧发布日期不得续期');
assert.equal(datedArticle.record.reply,null);

/* 不同查询命中同篇正文时复用；失败只允许显式补读重试，不随每轮自动扣额度。 */
const repeatedArticle=await harness({plans:plans3,searchResults:()=>[fresh()],readPage:url=>({url,title:fresh().title,excerpt:fresh().content,read_status:'page_excerpt',published_at:'2026-10-20'})});
assert.equal(repeatedArticle.calls.read,1);assert.equal(repeatedArticle.record.usage.reads,1);
assert.ok(repeatedArticle.record.claims.length,'去重不丢已经核对的正文与出处');
assert.equal(readRecord.usage.reads,2,'显式补读可以重试一次自动读取失败的原文');
const repeatedFailure=await harness({plans:plans3,searchResults:()=>[fresh()],readPage:null});
assert.equal(repeatedFailure.calls.read,1,'自动读取失败也不因换查询重复尝试同一文章');

/* 相关性空响应补试不能侵占终验。十二次上限不提高；较紧预算须提前收尾。 */
for(const limit of [12,8]){
  let reviewCalls=0,nextSource=0;
  const retried=await harness({plans:plans3,searchResults:()=>[fresh('retry'+(++nextSource))],limits:{...RESEARCH_LOOP_LIMITS,model_calls:limit},
    modelHook:opts=>opts.kind==='conversation_source_relevance' && ++reviewCalls%2===1?null:undefined});
  assert.equal(retried.record.status,'ok');assert.ok(retried.record.reply && retried.record.claims.length);
  assert.notEqual(retried.record.verify_status,'skipped');assert.ok(retried.record.usage.model_calls<=limit);
  if(limit===8)assert.equal(retried.record.stop_reason,'budget_model','补试将触碰预留时，保住已有依据的最终答复');
}
const budget=createResearchBudget({now,signal:new AbortController().signal});
assert.equal(budget.take('searches',8),null);
assert.equal(budget.take('searches'),'budget_searches');
assert.equal(budget.take('rounds',3),null);
assert.equal(budget.take('rounds'),'budget_rounds');

/* 14) 桌面入口合同：待查清单出入口、语义绑定、取消找回、新输入失效、恢复只读与旧请求隔离。 */
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
  conversation:{routing:{origin:'北京',destination:'昆明'},draft:{route:['北京','昆明'],pending:['跨境交通须有可核查来源及适用日期。','昆明铁路博物馆当期开放时间待查。']}},
  researchScope:null,researchTasks:null,lastEvidenceGaps:['北京到昆明有直飞','到昆明后用米轨漫步和铁路博物馆这类火车主题体验过渡'],
  researchLoopState:{running:false,record:null,binding:null,error:null,interrupted:false,controller:null,runToken:0},restoredGapResearch:null,
  currentSearchWindow:()=>'2026-11-01 ~ 2026-11-08',guideState:{road:null},anchors:{},
  taskScope:()=>({route:['北京','昆明'],window:'2026-11-01 ~ 2026-11-08',legs:[{from:'北京',to:'昆明',mode:'unknown',exclude_road:false,locked:false}]}),
  renderResearchProgress(){env.rendered=env.gapResearchHtml(false,true);},
  rendered:'',
  /* 可控异步：每个请求挂起，测试侧决定何时解决/拒绝（复审 P2-7 旧请求隔离）。 */
  jobs:[],abortOnRun:false,
  post:(url,body,signal)=>new Promise((resolve,reject)=>{posts.push({url,body,signal,resolve,reject});
    if(url==='/api/anywhere/research-loop' && env.abortOnRun){signal?.addEventListener('abort',()=>reject(Object.assign(new Error('The operation was aborted'),{name:'AbortError'})));}
    if(url==='/api/anywhere/research-loop-status')resolve({code:0,data:{record:{...structuredClone(loopRecord),stop_reason:'cancelled'}}});
  })};
env.globalThis=env;env.window=env;
vm.createContext(env);
vm.runInContext(html.slice(gapStart,gapEnd),env);
const entryHtml=env.gapResearchHtml(false,true);
assert.ok(entryHtml.includes('继续核对缺口') && entryHtml.includes('跨境交通须有可核查来源及适用日期。'),'待查清单成为显式补查入口');
const bindings=item=>{const b=env.gapResearchBinding(item);return b?(b.task_type==='transport'?'交通补查 · '+b.leg.from+' → '+b.leg.to:'体验补查 · '+b.destination):'';};
assert.equal(bindings('北京到昆明的交通方式、班次与乘车点'),'交通补查 · 北京 → 昆明','明确两端绑交通');
assert.equal(bindings('昆明铁路博物馆当期开放时间'),'体验补查 · 昆明','场馆开放时间按语义绑体验，不因“铁路”二字绑交通');
assert.equal(bindings('后续东南亚陆路段的跨境交通与班次'),'交通补查 · 北京 → 昆明','交通信号仍绑路段');
assert.equal(bindings('到昆明后用米轨漫步和铁路博物馆这类火车主题体验过渡'),'体验补查 · 昆明','纯体验建议绑目的地');
const originalConversation=env.conversation,originalScope=env.taskScope;
env.conversation={routing:{origin:'北京',destination:'曼谷'},draft:{route:['北京','昆明','曼谷'],pending:['昆明铁路博物馆开放时间','昆明与曼谷博物馆开放时间']}};
env.taskScope=()=>({legs:[{from:'北京',to:'昆明',mode:'rail',locked:false},{from:'昆明',to:'曼谷',mode:'unknown',locked:false}]});
assert.equal(bindings('昆明铁路博物馆开放时间'),'体验补查 · 昆明','途中城市不被全局终点覆盖');
assert.equal(bindings('曼谷博物馆门票'),'体验补查 · 曼谷');
assert.equal(bindings('博物馆开放时间'),'体验补查 · 曼谷','未指明城市的体验缺口继续使用当前目的地');
assert.equal(bindings('北京到昆明列车售票时间'),'交通补查 · 北京 → 昆明','交通售票不误作场馆门票');
assert.equal(env.gapResearchBinding('昆明与曼谷博物馆开放时间'),null,'多地点体验缺口先明确对象，不自动选终点');
assert.equal(env.gapResearchBinding('交通方式待查'),null,'多条未锁定路段不能擅自选择第一段');
assert.match(env.gapResearchHtml(false,true),/请先在对话中明确地点或路段/);
env.conversation=originalConversation;env.taskScope=originalScope;
let ran=env.runGapResearch('跨境交通须有可核查来源及适用日期。');
const firstPost=posts.at(-1);firstPost.settled=true;firstPost.resolve({code:0,data:structuredClone(loopRecord)});
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
/* 取消后按任务身份找回部分结果 */
env.abortOnRun=true;
const cancelRun=env.runGapResearch('跨境交通须有可核查来源及适用日期。');
setTimeout(()=>env.researchLoopState.controller.abort(),0);
await cancelRun;
assert.equal(posts.at(-1).url,'/api/anywhere/research-loop-status','取消后按任务身份找回部分结果');
assert.equal(env.researchLoopState.record.stop_reason,'cancelled');
assert.ok(env.rendered.includes('已取消'));
/* 旧请求隔离（复审 P2-7）：取消旧任务再启动新任务，旧请求回写不得干扰新任务。 */
env.abortOnRun=false;
const stale=env.runGapResearch('后续东南亚陆路段的跨境交通与班次');
env.cancelGapResearch();
const live=env.runGapResearch('北京到昆明的交通方式、班次与乘车点');
const stalePost=posts.find(p=>p.body && p.body.gap && p.body.gap.includes('跨境交通与班次') && p.url==='/api/anywhere/research-loop' && !p.settled);
const livePost=posts.at(-1);
stalePost.settled=true;
stalePost.reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
await new Promise(r=>setTimeout(r,10));
assert.equal(env.researchLoopState.running,true,'旧请求失败不得把新任务改为已结束');
assert.equal(env.researchLoopState.interrupted,false,'旧请求失败不得误标新任务中断');
assert.ok(env.researchLoopState.binding.gap.includes('交通方式'),'当前状态仍属新任务');
livePost.settled=true;livePost.resolve({code:0,data:structuredClone(loopRecord)});
await live;
assert.equal(env.researchLoopState.running,false);
assert.ok(env.researchLoopState.record && env.researchLoopState.record.task.id==='research_loop_ui','新任务正常完成并回写');
await stale;/* 旧任务应已静默退出 */

/* 新输入取消但没有新开补查：迟到的成功和失败都不得恢复旧记录。 */
env.cancelGapResearch();
const beforeLate=store['mt:gap-research'];
const late=env.runGapResearch('北京到昆明的班次');const latePost=posts.at(-1);
env.cancelGapResearch();env.guideSequence++;
latePost.resolve({code:0,data:{...structuredClone(loopRecord),task:{id:'stale_after_new_input'}}});await late;
assert.equal(env.researchLoopState.record,null);assert.equal(env.researchLoopState.interrupted,false);
assert.equal(store['mt:gap-research'],beforeLate,'旧成功响应不能写回存储');
const lateFailure=env.runGapResearch('北京到昆明的班次');const failurePost=posts.at(-1);
env.cancelGapResearch();env.guideSequence++;
failurePost.reject(Object.assign(new Error('aborted'),{name:'AbortError'}));await lateFailure;
assert.equal(env.researchLoopState.record,null);assert.equal(env.researchLoopState.interrupted,false,'旧失败响应也不能误标当前状态');
env.cancelGapResearch();
env.restoredGapResearch={claims:['x'],stop_reason:'planner_done',reply:'上次结论'};
const restoredHtml=env.gapResearchHtml(false,true);
assert.ok(restoredHtml.includes('上次补查记录（只读）') && restoredHtml.includes('不自动重启付费任务'),'恢复只读且不自动重启');

console.log('✓ R1-C 有界补查：取消接通、逐轮相关性与数字守门、已核对增量、出口去重、恢复只读、桌面入口与旧请求隔离通过');
