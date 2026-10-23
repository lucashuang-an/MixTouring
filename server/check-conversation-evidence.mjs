/* 真实编排合同：最终答复/草案、证据核对与用户引用消费同一来源集合。 */
import assert from 'node:assert/strict';
import {conversationTurn} from './lib/conversation.mjs';
import {buildEvidenceCatalog} from './lib/evidence-grounding.mjs';
import {groundConversationOutput} from './lib/conversation-evidence.mjs';
const now=Date.parse('2026-10-22T02:00:00Z');
const source={title:'北京到阿拉木图开通直飞',content:'北京到阿拉木图开通直飞。',link:'https://example.gov.cn/transport/direct',date:'2026-10-20'};
const statement='来源记载北京到阿拉木图开通直飞，本次日期仍待确认。';
const brief={origin:'北京',destination:'阿拉木图',summary:'北京到阿拉木图旅行'};
const base={intent_action:'question',reply:statement,brief,ready:true,confirmed:false,requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{},search_query:'北京到阿拉木图航班',search_purpose:'transport',destination_country:'KZ'};
const start={text:'北京到阿拉木图交通资料怎样？',conversation:{stage:'discuss',brief,routing:{origin:'北京',destination:'阿拉木图'}}};
const execute=async({page=source,answer=statement,assessment='supported',extract=null,draft=null,action='chat',reviewFailure=false,reviewSources=false,searchFailure=false,omitSearchQuery=false,repairReply=null,text='北京到阿拉木图交通资料怎样？'}={})=>{
  const calls=[],queries=[],collections=[],views=[];const model=async opts=>{
    calls.push(opts.kind);
    if(opts.kind==='conversation')views.push(JSON.parse(opts.user));
    if(opts.kind==='conversation')return {...base,reply:answer,intent_action:draft?'revise':'question',draft,search_query:omitSearchQuery?'':'北京到阿拉木图航班'};
    if(opts.kind==='conversation_review')return {reply:answer,draft,changes:[]};
    if(opts.kind==='conversation_evidence_repair')return repairReply?{reply:repairReply}:null;
    if(opts.kind==='conversation_source_relevance')return reviewFailure?null:{items:JSON.parse(opts.user).candidates.map(s=>({id:s.id,decision:'keep',reason:'相关资料',quote:s.title}))};
    if(opts.kind==='conversation_evidence_extract'){
      if(extract==='fail')return null;
      const {fields,evidence_catalog}=JSON.parse(opts.user);
      return {items:fields.map(f=>({id:f.id,text:f.text,needs_source:/开通直飞/.test(f.text),allowed_use:/核心取舍/.test(f.text)?'inference':'source_reference',supports:/开通直飞/.test(f.text)?[{source_id:evidence_catalog.entries[0]?.id,quote:evidence_catalog.entries[0]?.excerpt || ''}]:[]}))};
    }
    if(opts.kind==='conversation_evidence_support')return {items:JSON.parse(opts.user).claims.map(c=>({id:c.id,decision:assessment,reason:'逐句核对完成'}))};
    return {};
  };
  const input=action==='generate'?{action:'generate',conversation:{stage:'ready',brief,routing:{origin:'北京',destination:'阿拉木图'}}}:{...start,text};
  const result=await conversationTurn(input,null,{now,evidenceReview:true,sourceReview:reviewFailure || reviewSources,search:async query=>{queries.push(query);return searchFailure?null:page?[page]:[];},model,onSourceCollection:s=>collections.push(s)});
  return {result,calls,queries,collections,views};
};
const good=await execute();
assert.equal(good.result.status,'ok');assert.equal(good.result.sources.length,1);assert.equal(good.result.evidence_claims.length,1);
assert.ok(good.calls.includes('conversation_evidence_extract') && good.calls.includes('conversation_evidence_support'));
assert.equal(good.result.evidence_claims[0].supports[0].source_id,good.result.sources[0].id);
const generatedView=good.views.find(v=>v.search_complete);
assert.equal(generatedView.evidence_catalog.entries[0].excerpt,source.content);
assert.deepEqual(generatedView.search_results,[]);assert.deepEqual(generatedView.transport_references,[],'最终生成不借旧交通资料或另一份长摘录扩展事实');
assert.equal(good.collections[0].source_count,1);assert.ok(!JSON.stringify(good.collections[0]).includes(source.link),'诊断只传计数和状态，不传网页身份或正文');
const unsupported=await execute({assessment:'unsupported'});
assert.equal(unsupported.result.status,'ok');assert.match(unsupported.result.reply,/待核实/);assert.equal(unsupported.result.sources.length,0);assert.equal(unsupported.result.evidence_claims.length,0);
const repaired=await execute({assessment:'unsupported',repairReply:'可以先比较航班和铁路的查询入口，再分别核实日期与衔接；你更看重少换乘还是沿途体验？'});
assert.equal(repaired.result.status,'ok');assert.match(repaired.result.reply,/少换乘/);assert.doesNotMatch(repaired.result.reply,/开通直飞/);assert.equal(repaired.result.sources.length,0);
const brokenLong=await execute({answer:statement+'\n\n这两处都能无车直达，适合安排为固定的当地一日游。\n\n因此它们比其他走法更合适，应当把它们安排进每天的行程。',assessment:'unsupported',
  repairReply:'如果能核实少换乘的连接，可以优先比较；也可以把沿途停留作为备选，先分别查证交通。'});
assert.ok(brokenLong.calls.includes('conversation_evidence_repair'),'长回复删句后也必须尝试一次完整重组');
assert.doesNotMatch(brokenLong.result.reply,/这两处|因此它们/,'不发布失去前文的指代');
const pending=await execute({answer:'待查项：具体班次、票价与适用日期。',page:null});
assert.equal(pending.result.status,'ok');assert.match(pending.result.reply,/具体班次/);assert.equal(pending.result.sources.length,0,'明确待查清单不伪装成外部事实');
const airport=await execute({page:{...source,title:'阿拉木图机场介绍',content:'阿拉木图机场位于哈萨克斯坦。'}});
assert.equal(airport.result.status,'ok');assert.equal(airport.result.sources.length,0);assert.doesNotMatch(airport.result.reply,/开通直飞/);
const failed=await execute({extract:'fail'});assert.equal(failed.result.status,'unavailable');assert.equal(failed.result.conversation.revision || 0,0);
const unreviewed=await execute({reviewFailure:true});assert.equal(unreviewed.result.status,'unavailable');assert.match(unreviewed.result.reply,/不能据此判断是否有匹配资料/);assert.equal(unreviewed.result.sources.length,0);
const channelsDown=await execute({searchFailure:true});assert.equal(channelsDown.result.status,'unavailable');assert.match(channelsDown.result.reply,/不能据此判断是否有匹配资料/);
const historical=await execute({page:{...source,date:null},reviewSources:true});
assert.equal(historical.result.status,'ok');assert.equal(historical.result.sources.length,0,'日期未明不能成为当前事实引用');
assert.equal(historical.result.historical_sources.length,1,'相关日期未明来源只进探索折叠区');
const explicit=await execute({omitSearchQuery:true,text:'请核对公开资料：北京到阿拉木图航班。先不要改行程。'});
assert.equal(explicit.queries.length,2,'用户明确要求核对时，意图模型漏交查询词不能取消检索');
const plan={title:'旅行草案',overview:statement,route:['北京','阿拉木图'],cards:[{id:'city',place:'阿拉木图',label:'目的地阶段',title:'城区',content:'安排市区活动。'}],sections:[],pending:['班次待核实。']};
const generated=await execute({action:'generate',draft:plan});
assert.equal(generated.result.status,'ok');assert.equal(generated.result.conversation.draft.overview,statement);
assert.equal(generated.result.sources.length,1);assert.equal(generated.result.evidence_claims.length,1);
const generatedDenied=await execute({action:'generate',draft:plan,assessment:'unsupported'});
assert.equal(generatedDenied.result.status,'ok');assert.doesNotMatch(generatedDenied.result.conversation.draft.overview,/开通直飞/);
assert.equal(generatedDenied.result.sources.length,0);
const inferred=await execute({answer:'这次的核心取舍是以伊宁为基地少换乘，还是多换乘比较沿线。',page:null});
assert.equal(inferred.result.status,'ok');assert.match(inferred.result.reply,/核心取舍/);
assert.equal(inferred.result.evidence_inferences.length,1);assert.equal(inferred.result.sources.length,0);
const mixedFact=await execute({answer:'伊宁公交比较轻松，去草原通常要县城中转。',page:null});
assert.equal(mixedFact.result.status,'ok');assert.doesNotMatch(mixedFact.result.reply,/公交比较轻松/,'建议中的客观事实不能因模型漏分类而直接放行');
const shinkansen=await execute({answer:'可以先比较新干线直达省心、换乘少，还是沿途停一站。',page:null});
assert.equal(shinkansen.result.status,'ok');assert.doesNotMatch(shinkansen.result.reply,/新干线直达/,'即使抽取模型漏交事实，真实编排也必须移除无来源直达承诺');
const conflictSources=[{title:'正向报道',url:'https://example.gov.cn/yes',excerpt:'北京到阿拉木图班车已经开通。',published_at:'2026-10-20',kind:'official'},
  {title:'反向公告',url:'https://example.gov.cn/no',excerpt:'北京到阿拉木图班车尚未开通。',published_at:'2026-10-20',kind:'official'}];
const conflictCatalog=buildEvidenceCatalog({sources:conflictSources,now,routing:{origin:'北京',destination:'阿拉木图'},retrieval:{purpose:'transport'}});
const conflictText='两份资料对北京到阿拉木图班车是否开通说法不一，仍待核实。';
const conflict=await groundConversationOutput({reply:conflictText,catalog:conflictCatalog,model:async opts=>{
  if(opts.kind==='conversation_evidence_extract')return {items:JSON.parse(opts.user).fields.map(f=>({id:f.id,text:f.text,needs_source:true,allowed_use:'conflict',supports:conflictCatalog.entries.map(s=>({source_id:s.id,quote:s.excerpt}))}))};
  return {items:JSON.parse(opts.user).claims.map(c=>({id:c.id,decision:'supported',reason:'来源确有冲突且结论保留待查'}))};
}});
assert.equal(conflict.status,'complete');assert.equal(conflict.claims[0].allowed_use,'conflict');assert.equal(conflict.sources.length,2);
console.log('✓ 主对话、最终答复、生成草案、来源与引用一致、失败保留通过');
