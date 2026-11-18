import {editItinerary,deliveryReviewMode} from './light-edit.mjs';
import {reviewFinalItinerary} from './final-review.mjs';
import {preferenceReplyReceipt} from './trip-memory.mjs';
import {reviewIntakeAction} from './intake-action.mjs';
import {englishRequest} from './response-language.mjs';
import {unconfirmedReturnCards,repairReturnSummary,unconfirmedReturnFields} from './return-scope.mjs';
import {ensureItineraryQuality} from './itinerary-quality.mjs';
import {cleanTransportChoices,applicableTransportChoices,updateTransportChoices,reviseTransport} from './transport-revision.mjs';
import {cleanDiscussion,scopeRequirements,discussPlan,authorizedOutline} from './planning-discussion.mjs';
import {updateStayLocks,allocationReview,allocationMessage,outlineDayPlan,cleanStayLocks} from './itinerary-constraints.mjs';
import {createAgentRuntime,validationModelCapacity} from './agent-runtime.mjs';
import {googleMapsEnabled} from './google-maps.mjs';
import {runPlanningLoop,explicitDayScope,revisionDayScope,preserveOutsideScope,dayOnlyPreferenceScope,applyLocalRevision,numericRevisionScope} from './planning-loop.mjs';
import {planWorkspace,taskContract,assessDelivery,changedDays,routeMatchesIntent} from './planning-state.mjs';
import {evaluatePlan} from './planning-mobility.mjs';
import {resolveDayMap} from './day-map.mjs';
import {checkTravelDelivery,taskOutcome,nextConversationAction} from './travel-completion.mjs';
import {agentPrompt,AGENT_RULES_VERSION} from './agent-prompts.mjs';
/* AI 主导的旅行讨论。模型理解语言；代码处理状态、确认、字段及来源边界。 */
import { composeJson, searchWeb,composeModelInfo } from './llm.mjs';
import {reasoningEffort,reasoningBudget,withModelSettings} from './model-settings.mjs';
import { sanitizeConstraints, sanitizeIntentFields } from './anywhere.mjs';
import guide from '../../mixtouring-hifi/assets/trip-guide.js';
import { normalizeSightState } from './sights.mjs';
import { countryScope } from './place-scope.mjs';
import { collectTravelSources, classifyTravelSource } from './travel-sources.mjs';
import { resolveConversationRouting, routingSnapshot,verifyRoutingChange } from './conversation-routing.mjs';
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
import {retrievalContext,partitionTimedSources,sourceWindow} from './source-time.mjs';
import {readPublicPage} from './public-reader.mjs';
import {transportSearchEvidence} from './transport-search.mjs';
import {buildRouteComparison} from './route-comparison.mjs';
import {draftQueryScope} from './draft-research.mjs';
import {cleanMemory, extractMemoryCandidates, commitMemoryDecisions, decisionIndexForPrompt, validatePreferenceUpserts, sanitizeRecalledPreferences} from './trip-memory.mjs';
import {buildContext,cleanSummaries, summarizeBacklog, appendSummary, summaryFingerprint, isStale} from './context-builder.mjs';
import {buildNumericCatalog,validateNumericClaims,numericOccurrences} from './numeric-grounding.mjs';
import {relevanceReviewer} from './source-relevance.mjs';
import {buildEvidenceCatalog} from './evidence-grounding.mjs';
import {groundConversationOutput,groundScopedConversationOutput,evidenceFields} from './conversation-evidence.mjs';
import {runResearchLoop} from './research-loop.mjs';
import {itineraryMaterialCities,materialCoverage,mergeMaterialCollections,activityContentGaps} from './material-coverage.mjs';
import {buildLocalMobilityIndex} from './local-mobility.mjs';

const str = (v, n = 1600) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const strings = (v, n = 12) => Array.isArray(v) ? v.map(x => str(x, 400)).filter(Boolean).slice(0, n) : [];
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};

function cleanRequirements(raw = {}) {
  return {required_stops:[...new Set(strings(raw.required_stops).map(s=>s.slice(0,80)))],
    trip_days:Number.isInteger(raw.trip_days) && raw.trip_days>0 && raw.trip_days<=60?raw.trip_days:null,
    verified_cross_border_only:raw.verified_cross_border_only===true};
}
function updateRequirements(before, raw = {}) {
  const next=cleanRequirements(before), add=strings(raw.add_stops).map(s=>s.slice(0,80)), remove=strings(raw.remove_stops).map(s=>s.slice(0,80));
  next.required_stops=[...new Set(next.required_stops.filter(s=>!remove.includes(s)).concat(add))].slice(0,12);
  if(Object.hasOwn(raw,'trip_days')){if(raw.trip_days!==null && (!Number.isInteger(raw.trip_days) || raw.trip_days<1 || raw.trip_days>60))throw Error('总天数字段无效');next.trip_days=raw.trip_days;}
  if(Object.hasOwn(raw,'verified_cross_border_only')){if(typeof raw.verified_cross_border_only!=='boolean')throw Error('核实要求字段无效');next.verified_cross_border_only=raw.verified_cross_border_only;}
  return next;
}

// 预览是未采纳的模型提案：有完整全程日序时校对其自身时长，不用旧十天反压七天提案。
function proposedPreviewDays(draft,origin,travel){
  const cards=draft?.cards || [];
  if(!origin || !cards.length || cards[0].place!==origin)return null;
  const last=cards.at(-1);
  if(travel.trip_type==='round_trip' && last.place!==origin && !['返回','回到','飞回','抵达','到达'].some(word=>(last.title+' '+last.content).includes(word+origin)))return null;
  const ranges=cards.map(c=>String(c.label || '').match(/^第\s*(\d+)\s*(?:[—–\-~至到]\s*(\d+)\s*)?天/));
  if(ranges.some(r=>!r))return null;
  const days=Math.max(...ranges.map(r=>Number(r[2] || r[1])));
  if(!Number.isInteger(days) || days<1 || days>60)return null;
  const coverage=workspace.dayCoverage(draft,days);
  return coverage && !coverage.missing.length && !coverage.outside.length?days:null;
}

export function cleanConversation(raw = {}) {
  raw = object(raw);
  const b = object(raw.brief);
  return {
    stage: ['discuss', 'ready', 'draft'].includes(raw.stage) ? raw.stage : 'discuss',
    brief: { origin: str(b.origin, 80), destination: str(b.destination, 80), summary: str(b.summary),
      wishes: strings(b.wishes), open_questions: strings(b.open_questions, 4) },
    routing:routingSnapshot(raw.routing),
    discussion:cleanDiscussion(raw.discussion),
    transport_choices:cleanTransportChoices(raw.transport_choices),
    requirements:cleanRequirements(object(raw.requirements)),
    draft: cleanDraft(raw.draft), revision: Number.isSafeInteger(raw.revision) ? Math.max(0, raw.revision) : 0,
    preview: raw.preview && typeof raw.preview === 'object' && (cleanDraft(raw.preview.draft) || raw.preview.kind==='conditions') ? {
      kind:cleanDraft(raw.preview.draft)?'draft':'conditions',
      draft:cleanDraft(raw.preview.draft), brief:object(raw.preview.brief), patch:object(raw.preview.patch), requirements:cleanRequirements(raw.preview.requirements || raw.requirements),
      base_revision:raw.preview.base_revision, base_signature:str(raw.preview.base_signature,12000), selected_candidate_id:str(raw.preview.selected_candidate_id,100) || null,
      ...(Array.isArray(raw.preview.transport_choices)?{transport_choices:cleanTransportChoices(raw.preview.transport_choices)}:{}),
      memory_candidates:Array.isArray(raw.preview.memory_candidates) ? raw.preview.memory_candidates.slice(0,4) : [],
      memory_evidence_refs:Array.isArray(raw.preview.memory_evidence_refs)?raw.preview.memory_evidence_refs.filter(u=>typeof u==='string' && /^https:\/\//.test(u) && u.length<=4096).slice(0,16):[]
    } : null,
    /* M1：旅行决策记忆与增量摘要——随旅行快照保存；旧快照缺少字段视为空，不覆盖原文 */
    memory: cleanMemory(raw.memory),
    summaries: cleanSummaries(raw.summaries)
  };
}
const cleanDraft = workspace.cleanDraft;

const PROMPT = agentPrompt('conversation.main');

function patches(raw, sanitize, keys) {
  raw = object(raw);
  const clean = sanitize(raw), out = {};
  for (const key of keys) if (Object.hasOwn(raw, key)) {
    if (raw[key] === null) out[key] = null;
    else if (Object.hasOwn(clean, key) && clean[key] !== null) out[key] = clean[key];
    else throw new Error('模型字段无效：'+key);
  }
  return out;
}

function cleanPatch(raw = {}, sights = {}) {
  return {
    preferences:patches(raw.preferences,guide.clean,['pace','road','nights','preferred_mode','experience','nature_theme','destination_days']),
    travel:patches(raw.travel,sanitizeIntentFields,['trip_type','outbound_window','arrival_window','return_window','traveler_count']),
    constraints:patches(raw.constraints,sanitizeConstraints,['budget_max_cny','max_layover_hours','max_transfers','night_arrival','no_self_drive','lodging_stays']),
    sights:patches(raw.sights,v=>normalizeSightState({...sights,...v}),['selected_ids','visit_dates','full_days','play_window'])
  };
}

function conditionSignature(input) {
  const sorted=v=>Array.isArray(v)?v.map(sorted):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
  const travel=sanitizeIntentFields(input.travel);travel.trip_type ||= 'pending';travel.traveler_count ||= 1;
  return JSON.stringify(sorted({requirements:cleanRequirements(input.conversation?.requirements || input.requirements),stay_locks:cleanStayLocks(input.conversation?.discussion?.stay_locks || input.stay_locks),transport_choices:cleanTransportChoices(input.conversation?input.conversation.transport_choices:input.transport_choices),preferences:guide.clean(input.preferences),travel,constraints:sanitizeConstraints(input.constraints),anchors:{outbound:input.anchors?.outbound || null,return:input.anchors?.return || null},sights:normalizeSightState(input.sights)}));
}

function acceptPreview(before, input, plan) {
  // 旧快照{}与表单恢复后的空锚点等价，不能把填充默认值误判为用户修改。
  let signatureMatches=true;
  if(before.preview?.base_signature){try{signatureMatches=conditionSignature(JSON.parse(before.preview.base_signature))===conditionSignature(input);}catch{signatureMatches=false;}}
  if (!before.preview || before.preview.base_revision !== before.revision || !signatureMatches) return {status:'unavailable',reply:'条件已有变化，这份预览需要重新比较；当前安排仍保留。',conversation:before};
  try {
    const p=before.preview;
    const outline=before.discussion.options.find(o=>o.id===before.discussion.selected_id);
    if(p.draft && allocationReview(p.draft,outline,before.discussion.stay_locks).hard_issues.length)throw Error('预览不满足明确停留要求');
    const checkedMemory=extractMemoryCandidates({decisions:p.memory_candidates||[]},
      {userMessages:input.messages || [],allowedEvidenceRefs:p.memory_evidence_refs || []});
    if(checkedMemory.rejected.length)throw Error('预览决策出处未能恢复');
    const conversation=cleanConversation({...before,brief:p.brief,draft:p.draft,requirements:p.requirements,transport_choices:p.transport_choices || before.transport_choices,revision:before.revision+1,preview:null,
      /* M02：预览内的记忆增量与旅行状态在同一转换中提交；校验失败则整次采纳失败、原状态保留 */
      // 来源仅保留为历史决策出处，不返回可用sources、不续期；现时事实仍由证据层复核。
      memory:commitMemoryDecisions(before.memory,checkedMemory.accepted,{baseRevision:before.revision+1})});
    if(p.draft?.route.length && !routeMatchesIntent(p.draft.route,before.routing,p.requirements || before.requirements))throw Error('预览端点不一致');
    const selected=(plan?.candidates || []).find(c=>c.id===p.selected_candidate_id && (!p.draft?.route.length || workspace.matches(p.draft.route,c)));
    return {status:'ok',engine:'state',reply:'已采用预览中的安排，其他已确认条件继续保留。',conversation,patch:cleanPatch(p.patch,input.sights),
      selected_candidate_id:selected?.id || null,clear_selection:!selected && (p.draft?.route.length || 0)>1,sources:[],request_generation:false};
  } catch { return {status:'unavailable',reply:'预览暂时无法采用，当前安排仍保留。',conversation:before}; }
}

export async function conversationTurn(input = {}, plan = null, deps = {}) {
  const effort=reasoningEffort(input.reasoning_effort);
  const budgetMs=deps.budgetMs ?? (!deps.model && composeModelInfo().provider==='openai'?reasoningBudget(effort).turnMs:120000);
  return withModelSettings({effort,deadlineAt:Date.now()+budgetMs},()=>runConversationTurn(input,plan,{...deps,budgetMs}));
}
async function runConversationTurn(input,plan,deps){
  const runtime=createAgentRuntime({onEvent:deps.onTrace});
  let safeDelivery=null;
  let result=await performConversationTurn(input,plan,{...deps,runtime,onCheckpoint:async data=>{
    if(data.safe_delivery)safeDelivery=structuredClone(data.safe_delivery);
    await deps.onCheckpoint?.(data);
  }});
  if(deps.signal?.aborted)runtime.interrupt('cancelled');
  if(runtime.interruption){
    result=safeDelivery && !deps.signal?.aborted && runtime.interruption!=='cancelled'?{...safeDelivery,status:'ok',engine:'partial',task_status:'partial',reply:(runtime.interruption==='model_rate_limited'?'初稿已保留，模型暂时限流，仍有检查尚未完成；请稍后继续。':runtime.interruption==='model_temporarily_unavailable'?'初稿已保留，模型服务暂时不可用，仍有检查尚未完成；请稍后继续。':runtime.interruption==='model_provider_rejected'?'初稿已保留，模型服务暂时拒绝请求，仍有检查尚未完成；服务恢复后可继续。':'初稿已保留，仍有检查尚未完成，可继续完善。')+(allocationMessage(safeDelivery.delivery_validation?.allocation_changes)?'\n\n'+allocationMessage(safeDelivery.delivery_validation.allocation_changes):''),request_generation:false}:
      {status:'unavailable',engine:'unavailable',retry_after_ms:result.retry_after_ms ?? null,provider_error_code:result.provider_error_code || null,reply:runtime.interruption==='model_rate_limited'?'模型暂时限流，本轮已停止，原输入与方案已保留；请稍后重试。':runtime.interruption==='model_temporarily_unavailable'?'模型服务暂时不可用，本轮已停止，原输入与方案已保留；请稍后重试。':runtime.interruption==='model_provider_rejected'?'模型服务暂时拒绝请求，原输入与安排已保留；服务恢复后可继续。':'本轮运行已中断，原条件与草案已保留，可以重试。',conversation:cleanConversation(input.conversation)};
  }
  if(result.status==='ok' && result.conversation){
    const conditions={requirements:result.conversation.requirements,travel:{...input.travel,...result.patch?.travel},constraints:{...input.constraints,...result.patch?.constraints}};
    // 每次从已校验正文重建，不信任客户端提交的状态／观察字段。
    if(result.conversation.draft)result.planning_workspace=planWorkspace(result.conversation.draft,conditions);
    if(result.conversation.preview?.draft)result.preview_workspace=planWorkspace(result.conversation.preview.draft,conditions);
    if(result.conversation.draft){
      let choices=result.conversation.transport_choices || [];
      if((result.patch?.preferences?.road??input.preferences?.road)==='exclude')choices=choices.filter(c=>!['drive','road'].includes(c.mode));
      result.conversation.transport_choices=applicableTransportChoices(choices,result.conversation.draft,conditions.travel,conditions.constraints);
    }
  }
  const outcome=runtime.finish({status:result.status==='unavailable'?'failed':'completed',taskState:taskOutcome(result),reason:result.status==='unavailable'?'execution_failed':null,checks:result.delivery_validation?.checks || []});
  if(englishRequest(input) && result.status==='unavailable')result.reply='This request could not be completed. Your input and existing plan have been preserved. Please try again.';
  return {...result,...outcome,next_action:nextConversationAction({...result,...outcome})};
}
async function performConversationTurn(input = {}, plan = null, deps = {}) {
  const before = cleanConversation(input.conversation);
  const interactionFirst=deliveryReviewMode({mode:deps.deliveryReview || (deps.model?'strict':undefined)})==='final';
  if(input.action==='accept_preview')return acceptPreview(before,input,plan);
  if(input.action==='discard_preview')return {status:'ok',engine:'state',reply:'继续保留原来的安排。',conversation:{...before,preview:null},patch:cleanPatch(),sources:[],request_generation:false};
  /* #32：请求级取消与总时限——客户端断开或按模型策略分配的整轮预算耗尽后，
   * 后续模型/检索/原文读取不再启动（编排层在每个阶段前主动检查，不依赖下游自觉）；
   * 各阶段自身超时保持不变，二者取最先触发。 */
  const budgetMs=deps.budgetMs ?? 120000,deadlineAt=Date.now()+budgetMs;
  const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(budgetMs)]) : AbortSignal.timeout(budgetMs);
  const runtime=deps.runtime;
  const cancelErr=()=>runtime.interrupt(deps.signal?.aborted?'cancelled':'deadline');
  let currentFrame=null,qualityCatalog=null;
  let permanentModelFailure=false,lastModelFailure=null;
  const usage={model_calls:0,search_calls:0};
  let modelCapacity=20;
  const trace=(stage,status,extra={})=>{try{deps.onTrace?.({stage,status,...extra});}catch{}};
  const model = async (opts) => {
    if(englishRequest(input) && /^(conversation$|planning_outline$|planning_directions$|planning_intake_review$|conversation_(discuss|delivery|delivery_patch|delivery_repair|evidence_repair|compose|local_revision|activity_fill|numeric_repair|quality_repair|quality_sync|final_review)$)/.test(opts.kind))opts={...opts,schema_prompt:opts.schema_prompt+'\n'+agentPrompt('conversation.response_language')};
    if(permanentModelFailure)throw Object.assign(Error('模型服务拒绝请求'),{code:'MODEL_PROVIDER_REJECTED'});
    if(signal.aborted)return Promise.reject(cancelErr());
    runtime.assertActive(signal);
    if(usage.model_calls>=modelCapacity)throw runtime.interrupt('model_capacity');
    usage.model_calls++;lastModelFailure=null;
    const refreshCurrent=['conversation','conversation_review','conversation_activity_fill','conversation_numeric_repair'].includes(opts.kind);
    const payload=runtime.prepareRequest(JSON.parse(opts.user),{phase:opts.instruction_phase || opts.kind,includeObservations:!['conversation_evidence_extract','conversation_evidence_support','conversation_delivery_patch','conversation_delivery','conversation_quality_review','conversation_quality_repair','conversation_quality_sync'].includes(opts.kind),
      current:refreshCurrent?(currentFrame?.target_current || currentFrame?.current):null});
    if(!['understand','intake'].includes(opts.instruction_phase) && ['conversation','conversation_review','conversation_scope','conversation_schedule','conversation_delivery','conversation_delivery_patch','conversation_evidence_repair','conversation_numeric_repair'].includes(opts.kind)){
      payload.numeric_fact_catalog=numericCatalog();
      const addDelivery=!['conversation_delivery','conversation_delivery_patch','conversation_evidence_repair','conversation_numeric_repair'].includes(opts.kind) && opts.instruction_phase!=='answer';
      opts={...opts,schema_prompt:opts.schema_prompt+agentPrompt('conversation.numeric_rules')+(addDelivery?'\n'+agentPrompt('conversation.delivery'):'')};
    }
    const built=buildContext({payload,coreRules:opts.schema_prompt,
      rulesVersion:AGENT_RULES_VERSION,budgetChars:deps.contextBudgetChars});
    if(opts.kind==='conversation_quality_repair' && built.value.evidence_catalog)qualityCatalog=structuredClone(built.value.evidence_catalog);
    // 来源记录保留在采集层；输出核对只沿用写作阶段实际看到的视图，不能补回被裁剪事实。
    if(evidenceReview && ['conversation','conversation_review','conversation_scope','conversation_schedule'].includes(opts.kind) && built.value.evidence_catalog)
      context.evidence_catalog=structuredClone(built.value.evidence_catalog);
    const started=Date.now();trace(opts.kind,'started',{attempt:usage.model_calls,phase:opts.instruction_phase || null});
    try{
      let transientFailure=null;
      const value=await (deps.model || composeJson)({...opts,user:JSON.stringify(built.value),signal,telemetry:{task_id:deps.taskId || null,run_id:runtime.id,attempt:usage.model_calls},onUsage:deps.onModelUsage,
        canRetry:()=>!signal.aborted&&usage.model_calls<modelCapacity&&deadlineAt-Date.now()>1000&&(!opts.canRetry||opts.canRetry()),
        onRetryWait:failure=>{trace(opts.kind,'retry_wait',failure);opts.onRetryWait?.(failure);},
        reserveRetry:()=>{if(signal.aborted||usage.model_calls>=modelCapacity||deadlineAt-Date.now()<=1000)return false;if(opts.reserveRetry&&!opts.reserveRetry())return false;usage.model_calls++;return {attempt:usage.model_calls};},
        onRetry:failure=>{trace(opts.kind,'retry',failure);opts.onRetry?.(failure);},
        onFailure:failure=>{transientFailure=failure;lastModelFailure=failure;if(failure.reason_code==='http_rejected' && failure.retryable===false){permanentModelFailure=true;runtime.interrupt('model_provider_rejected');}else if(failure.reason_code==='rate_limited')runtime.interrupt('model_rate_limited');else if(['service_unavailable','request_timeout','temporary_request'].includes(failure.reason_code))runtime.interrupt('model_temporarily_unavailable');trace(opts.kind,'failed',{phase:opts.instruction_phase || null,...failure});opts.onFailure?.(failure);}});
      runtime.assertActive(signal);
      if(permanentModelFailure)throw Object.assign(Error('模型服务拒绝请求'),{code:'MODEL_PROVIDER_REJECTED'});
      trace(opts.kind,value?'completed':'unavailable',{elapsed_ms:Date.now()-started,phase:opts.instruction_phase || null});
      if(value==null && opts.kind==='conversation_evidence_support' && transientFailure?.retryable===true && !transientFailure.retry_handled && !opts.retry_attempt && usage.model_calls<modelCapacity && deadlineAt-Date.now()>3000){
        trace(opts.kind,'retry',{reason_code:transientFailure.reason_code});
        return model({...opts,retry_attempt:true,timeoutMs:Math.min(12000,deadlineAt-Date.now()-1000)});
      }
      return value;
    }catch(error){trace(opts.kind,'failed',{reason_code:signal.aborted?'cancelled':'model_error'});throw error;}
  };
  // 默认交互流程不逐句审批；旧严格对照策略仍验证引用与事实核对合同。
  const evidenceReview=!interactionFirst && (!deps.model || deps.evidenceReview===true);
  runtime.register('search',{readOnly:true,validate:a=>typeof a?.query==='string' && !!a.query.trim() && a.query.length<=2000,
    classify:rows=>Array.isArray(rows)?rows.length?'success':'empty':'error',
    execute:async({query,options},{signal,context})=>{
      if(usage.search_calls>=8)throw runtime.interrupt('search_capacity');
      usage.search_calls++;const started=Date.now();trace('search','started',{attempt:usage.search_calls});
      const found=await (deps.search || searchWeb)(query,{...options,onAttempt:context?.onAttempt,signal});
      trace('search',Array.isArray(found)?'completed':'unavailable',{elapsed_ms:Date.now()-started,count:found?.length || 0});return found;
    }});
  runtime.register('read_page',{readOnly:true,validate:a=>typeof a?.url==='string' && /^https?:\/\//i.test(a.url) && a.url.length<=4096,
    classify:page=>page?.read_status==='page_excerpt'?'success':'error',
    execute:({url,options},{signal,context})=>(deps.readPage || readPublicPage)(url,{...options,signal})});
  const serialOptions=opts=>Object.fromEntries(Object.entries(opts || {}).filter(([k,v])=>k!=='signal' && typeof v!=='function' && (v==null || ['string','number','boolean'].includes(typeof v) || Array.isArray(v))));
  const toolScope=()=>({rules:AGENT_RULES_VERSION,routing:currentFrame?.resolved_intent?.routing || before.routing,current:currentFrame?.target_current || currentFrame?.current});
  const search=async(q,opts={})=>{
    const result=await runtime.call('search',{query:q,options:serialOptions(opts)},{scope:toolScope(),signal:opts.signal && opts.signal!==signal?AbortSignal.any([signal,opts.signal]):signal,context:opts});
    return result.status==='error'?null:result.data;
  };
  const readPage=deps.readPage || !deps.search?async(url,opts={})=>{
    const result=await runtime.call('read_page',{url,options:serialOptions(opts)},{scope:toolScope(),signal:opts.signal && opts.signal!==signal?AbortSignal.any([signal,opts.signal]):signal,retry:opts.retryFailed===true});
    return result.data;
  }:null;
  const action = ['generate','prepare'].includes(input.action) ? input.action : 'chat';
  /* M1：全量消息（带 mid）用于摘要与决策出处；近期窗口原文进 prompt，更早由增量摘要承载。
   * 无 mid 的旧消息只进近期窗口，不作为决策出处引用。 */
  const allMessages = (Array.isArray(input.messages) ? input.messages : [])
    .filter(m => ['user','assistant'].includes(m?.role))
    .map(m => ({ mid: Number.isSafeInteger(m?.mid) ? m.mid : null, role: m.role, text: str(m.text, 2000) }));
  const messages = allMessages.slice(-16);
  const currentText=typeof input.text==='string'?input.text.trim():'';
  const supplied=input.current_message;
  const currentMessage=supplied?.role==='user' && Number.isSafeInteger(supplied.mid) &&
    typeof supplied.text==='string' && supplied.text.trim()===currentText && !allMessages.some(m=>m.mid===supplied.mid && (m.role!=='user' || m.text!==currentText))
    ? {mid:supplied.mid,role:'user',text:currentText}:null;
  const userMessages=allMessages.filter(m=>m.role==='user').concat(currentMessage?[currentMessage]:[]);
  /* M1：增量摘要——滑出近期窗口且未被有效摘要覆盖的范围一次提炼；失败用已验证摘要与
   * 近期原文继续，不阻塞主流程（摘要触发按未摘要范围，非每轮）。 */
  /* M1：摘要指纹绑源消息内容+硬条件——日期、约束变化或撤销回滚使旧摘要失效；
   * 软偏好调整不使摘要失效（摘要记录的是决策与硬条件，不是软偏好快照）。 */
  const fingerprint = summaryFingerprint(before.revision, JSON.stringify({ requirements: before.requirements, routing: before.routing,
    travel:sanitizeIntentFields(input.travel),constraints:sanitizeConstraints(input.constraints),anchors:input.anchors || {} }));
  let workingSummaries = before.summaries;
  try {
    /* G3：未知格式摘要保留原样——不进入模型、不生成覆盖它的增量，保存时原样带回 */
    if (workingSummaries.degraded) throw Object.assign(Error('未知摘要格式，跳过生成'), { skipped: true });
    const backlog = summarizeBacklog(allMessages.filter(m => m.mid != null), workingSummaries, fingerprint);
    // 一次只压缩有界范围，不能让摘要请求先超过预算，再把省略范围标为已经摘要。
    backlog.pending=backlog.pending.slice(0,8);
    if (backlog.pending.length >= 4) {
      const digest = await model({ kind:'conversation_digest', timeoutMs:15000,
        schema_prompt:agentPrompt('conversation.digest'),
        user: JSON.stringify({current:{requirements:before.requirements,routing:before.routing,travel:input.travel,constraints:input.constraints},range:[backlog.pending[0].mid, backlog.pending[backlog.pending.length-1].mid],
          later_user_updates:allMessages.filter(m=>m.role==='user' && m.mid>backlog.pending.at(-1).mid).slice(-12),
          messages: backlog.pending.map(m => ({ mid:m.mid, role:m.role, text:m.text.slice(0, 600) })) }) });
      const digestText = digest && typeof digest.summary === 'string' ? digest.summary.trim().slice(0, 1200) : '';
      if (digestText) workingSummaries = appendSummary(workingSummaries,
        { fromMid: backlog.pending[0].mid, toMid: backlog.pending[backlog.pending.length-1].mid, text: digestText }, fingerprint, before.revision, allMessages);
    }
  } catch { /* 摘要失败：保留原摘要状态继续（M07） */ }
  if(action==='prepare'){
    try{
      const prepared=await resolveConversationRouting({brief:before.brief,routing:before.routing,before,messages,text:input.text},model);
      if(!prepared.available)throw Error('整理未完成');
      if(!prepared.routing.origin || !prepared.routing.destination)return {status:'needs_intent',reply:prepared.question || '你希望从哪座城市出发、先抵达哪座城市？',conversation:{...before,routing:prepared.routing,stage:'discuss'}};
      return {status:'ok',engine:prepared.engine,conversation:{...before,routing:prepared.routing,stage:'ready'},routing:prepared.routing};
    }catch{return {status:'unavailable',reply:'路线信息暂时没有整理完成，已有想法仍保留，可以直接重试。',conversation:before};}
  }
  const initialRouting=await resolveConversationRouting({brief:before.brief,routing:before.routing,before},model,{allowModel:false});
  const generationOutline=action==='generate'?authorizedOutline(before,{requirements:before.requirements,preferences:guide.clean(input.preferences),travel:sanitizeIntentFields(input.travel),constraints:sanitizeConstraints(input.constraints),anchors:input.anchors,sights:normalizeSightState(input.sights)}):null;
  if(action==='generate' && !generationOutline)return {status:'needs_intent',reply:'请先确认文字粗略方案；方案或条件变化后，需要重新确认再编排。',conversation:{...before,stage:before.draft?'draft':'discuss'}};
  if (action==='generate' && (!initialRouting.routing.origin || !initialRouting.routing.destination || before.stage!=='ready'))
    return {status:'needs_intent',reply:'先确定本次出发地和首个抵达城市，再生成草案。',conversation:before};
  if(action==='generate')before.routing=initialRouting.routing;
  const destination = before.brief.destination || plan?.intent?.destination;
  const context = { date: new Date(deps.now || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), action,
    text: currentText, current_user_message:currentMessage,conversation: before, messages,
    output_contract:{route_origin:before.routing.origin,route_destination:before.routing.destination,route_includes_return:false,trip_type:input.travel?.trip_type || 'pending',max_cards:60,...(generationOutline?{selected_route:generationOutline.route,confirmed_outline:generationOutline,confirmed_day_plan:outlineDayPlan(generationOutline)}: {})},
    can_undo:input.can_undo===true,
    current: { requirements:before.requirements, transport_choices:before.transport_choices, preferences: guide.clean(input.preferences), travel: sanitizeIntentFields(input.travel),
      constraints: sanitizeConstraints(input.constraints), anchors: input.anchors || {}, sights:normalizeSightState(input.sights), selected_candidate_id:input.candidate_id || null },
    selection_request:(plan?.candidates || []).some(c=>c.id===input.requested_candidate_id)?input.requested_candidate_id:null,
    routes: (()=>{const ranked=guide.rank(plan?.candidates || [],input.preferences).items.map(x=>x.candidate);
      const shown=Array.isArray(input.displayed_candidate_ids)?[...new Set(input.displayed_candidate_ids)].map(id=>ranked.find(c=>c.id===id)).filter(Boolean):[];
      return (shown.length?shown:ranked).slice(0,8);})().map(c => ({ id:c.id, kind:c.kind, legs:c.legs,
      explanation:c.explanation, basis:c.basis })),
    destination_material:null,sight_material:null };
  currentFrame=context;
  function numericCatalog(){
    const catalog=buildNumericCatalog({sources:[...context.search_results || [],...context.visible_search_results || []],
      transport:context.transport_references || [],retrieval:context.retrieval || retrievalContext({travel:context.current.travel,now:deps.now || Date.now()}),now:deps.now || Date.now()});
    return !evidenceReview || !context.evidence_catalog?catalog:catalog.filter(f=>context.evidence_catalog.entries.some(e=>
      e.url===f.source_url && [e.title,e.excerpt].some(t=>t?.includes(f.evidence_quote))));
  }
  /* M1：决策索引（当前条目供理由引用）与有效摘要注入；清单是派生物，只进 prompt 不进保存状态 */
  const validSummaries = workingSummaries.items.filter(s => !isStale(s, fingerprint, allMessages));
  context.decision_index = decisionIndexForPrompt(before.memory,userMessages);
  context.history_summaries = validSummaries.map(s => '[' + s.from_mid + '..' + s.to_mid + '] ' + s.text);
  context.memory_instruction = agentPrompt('conversation.memory_context');
  /* M2：跨旅行偏好召回——仅用户显式开启记忆才注入；白名单外与一次性条件（日期/预算/必经/住宿）
   * 永不来自偏好，当前旅行明确条件始终优先于长期软偏好。 */
  const recalledPreferences = sanitizeRecalledPreferences(input.preference_memory);
  context.preference_memory_status={enabled:recalledPreferences.enabled};
  context.long_term_preference_instruction = agentPrompt('conversation.preference_context');
  if (recalledPreferences.enabled) {
    /* G2（复审 P2）：长期记录完整保留（只读），本次覆盖单独派生——「本次采用什么」与
     * 「长期记了什么」是两个视图；用户查询长期设置必须能如实回答，本次选择仍优先。 */
    context.long_term_preferences = recalledPreferences.preferences;
    context.current_preference_overrides = recalledPreferences.preferences
      .filter(p => context.current.preferences[p.key] != null)
      .map(p => ({ key: p.key, value: context.current.preferences[p.key], long_term_value: p.value }));
  }
  async function preferenceMemoryResult(raw){
    const requestContext={enabled:recalledPreferences.enabled,store_id:recalledPreferences.store_id ?? null,revision:recalledPreferences.revision ?? null};
    const validation=validatePreferenceUpserts(raw.preference_memory_patch,{memoryEnabled:recalledPreferences.enabled});
    const candidates=validation.accepted;
    const invalidNotice=recalledPreferences.enabled && validation.rejected.length?'部分长期偏好格式无效，未记录；请重试记忆操作。':undefined;
    if(!currentMessage || action!=='chat' || !candidates.length)return {upserts:[],context:requestContext,notice:invalidNotice};
    // 只依据本轮用户原话确认长期授权，搜索后的模型候选和旧消息都不能自行扩大记忆范围。
    let checked;
    try { checked=await model({kind:'conversation_preference_intent',timeoutMs:10000,
      schema_prompt:agentPrompt('conversation.preference_intent'),
      user:JSON.stringify({current_user_message:currentMessage,candidates})});
    } catch(error) { if(deps.signal?.aborted)throw error; }
    if(!checked || !Array.isArray(checked.upserts))return {upserts:[],context:requestContext,notice:'长期偏好暂未记录，本次对话和安排仍保留；可以重试记忆操作。'};
    const verified=validatePreferenceUpserts(checked,{memoryEnabled:true}).accepted.filter(p=>candidates.some(c=>c.key===p.key && c.value===p.value));
    return {upserts:verified.map(p=>({...p,source_message_mid:currentMessage.mid})),context:requestContext,notice:invalidNotice};
  }
  context.route_comparison=buildRouteComparison(plan,{preferences:input.preferences,requirements:before.requirements,constraints:input.constraints,travel:input.travel,retrieval_ids:input.retrieval_ids,now:deps.now || Date.now()});
  const explicitChoice=action==='generate'?(plan?.candidates || []).find(c=>c.id===input.requested_candidate_id):null;
  const requestedChoice=(plan?.candidates || []).find(c=>c.id===input.requested_candidate_id && (!generationOutline || JSON.stringify(workspace.routeFor(null,c))===JSON.stringify(generationOutline.route)));
  if(requestedChoice)context.output_contract.selected_route=workspace.routeFor(null,requestedChoice);
  context.transport_references=[];
  const evidenceRoute=requestedChoice?workspace.routeFor(null,requestedChoice):generationOutline?.route || before.draft?.route || [];
  const evidenceCandidate=requestedChoice || (plan?.candidates || []).find(c=>workspace.matches(evidenceRoute,c));
  let evidenceLegs=draftQueryScope({route:evidenceRoute,candidate:evidenceCandidate,transport_choices:before.transport_choices,preferences:input.preferences,previous:input.research_scope,anchors:input.anchors,travel:input.travel},deps.now || Date.now()).legs.map(l=>({...l,mode_guess:l.mode}));
  let visibleEvidence=transportSearchEvidence(input.retrieval_ids,{route:evidenceRoute,legs:evidenceLegs,window:retrievalContext({travel:input.travel,now:deps.now || Date.now()}).target_window,now:deps.now || Date.now()});
  context.visible_search_results=visibleEvidence;
  context.visible_experiences=transportSearchEvidence(input.retrieval_ids,{route:evidenceRoute,legs:evidenceLegs,window:retrievalContext({travel:input.travel,now:deps.now || Date.now()}).target_window,now:deps.now || Date.now(),purpose:'experience'});
  context.experience_boundary=agentPrompt('conversation.experience_boundary');
  const isUnderstanding=()=>action==='chat' && !!before.draft && !context.resolved_intent;
  const isComposing=()=>action==='generate' || action==='chat' && !!before.draft && ['revise','preview'].includes(context.resolved_intent?.intent_action) &&
    context.resolved_intent?.routing?.origin===initialRouting.routing.origin && context.resolved_intent?.routing?.destination===initialRouting.routing.destination;
  const generationContext=()=>isUnderstanding()?{
    date:context.date,action:'understand',conversation:{revision:before.revision},text:context.text,current_user_message:currentMessage,current:context.current,brief:before.brief,routing:initialRouting.routing,operation:context.operation,
    user_messages:messages.filter(m=>m.role==='user').slice(-8),can_undo:context.can_undo,decision_index:context.decision_index,
    draft_outline:{title:before.draft.title,route:before.draft.route,cards:before.draft.cards.map(c=>({id:c.id,place:c.place,label:c.label,title:c.title}))},
    preview:before.preview?{requirements:before.preview.requirements,title:before.preview.draft?.title || null}:null,
    routes:context.routes.map(c=>({id:c.id,route:workspace.routeFor(null,c)})),
    preference_memory_status:context.preference_memory_status,long_term_preference_instruction:context.long_term_preference_instruction,
    ...(Object.hasOwn(context,'long_term_preferences')?{long_term_preferences:context.long_term_preferences}:{}),field_correction:context.field_correction,
  }:isComposing()?{
    date:context.date,action,conversation:{revision:before.revision},text:context.text,brief:context.resolved_intent?.brief || before.brief,
    current:context.target_current || context.current,
    output_contract:{...context.output_contract,delivery_mode:action==='generate'?'generate':context.resolved_intent.intent_action},
    local_mobility_index:buildLocalMobilityIndex(context.evidence_catalog),
    original_draft:action==='generate'?null:workspace.presentDraft(before.draft),
    routes:context.routes.map(c=>({id:c.id,kind:c.kind,route:workspace.routeFor(null,c)})),
    user_messages:messages.filter(m=>m.role==='user').slice(-8),evidence_catalog:context.evidence_catalog,retrieval:context.retrieval,
    search_complete:context.search_complete===true,visible_search_results:evidenceReview?[]:context.visible_search_results,visible_experiences:evidenceReview?[]:context.visible_experiences,
    correction:context.correction,field_correction:context.field_correction,
  }:evidenceReview && context.search_complete?{...context,
    // 最终事实只来自证据目录的实际可见摘录，不从更长摘要或旧目的地资料偷渡事实。
    destination_material:null,sight_material:null,transport_references:[],visible_search_results:[],visible_experiences:[],search_results:[],experience_results:[]}:context;
  let resumeConsumed=false;
  const invoke = async () => {
    let failure=null;
    const intakePhase=action==='chat' && !before.draft && !context.search_complete;
    const understandingPhase=isUnderstanding(),composingPhase=isComposing(),answeringPhase=action==='chat' && context.search_complete && !understandingPhase && !composingPhase;
    if(composingPhase && deps.resumeDraft && !resumeConsumed){
      resumeConsumed=true;trace('checkpoint_resume','completed',{checkpoint_stage:'structure_ready'});
      return {reply:'已恢复行程结构并重新核对资料。',draft:cleanDraft(deps.resumeDraft)};
    }
    if(composingPhase && context.local_scope?.length){
      const payload=generationContext();
      payload.local_scope=context.local_scope;
      payload.original_draft={...payload.original_draft,cards:before.draft.cards.filter(c=>context.local_scope.includes(c.id))};
      payload.readonly_outline=before.draft.cards.filter(c=>!context.local_scope.includes(c.id)).map(c=>({id:c.id,place:c.place,label:c.label,title:c.title}));
      const local=await model({kind:'conversation_local_revision',instruction_phase:'compose_local',timeoutMs:20000,schema_prompt:agentPrompt('conversation.local_revision'),user:JSON.stringify(payload)});
      if(!local)throw Error('局部改稿未完成');
      return {reply:local.reply,draft:applyLocalRevision(before.draft,local,context.local_scope)};
    }
    const options={ schema_prompt: intakePhase?agentPrompt('conversation.intake'):understandingPhase?agentPrompt('conversation.understand'):(composingPhase?agentPrompt('conversation.compose'):answeringPhase?agentPrompt('conversation.discuss'):PROMPT) + agentPrompt('conversation.preference_context') + agentPrompt('conversation.evidence_rules') + (composingPhase && context.output_contract.selected_route?agentPrompt('conversation.selected_route'):'') + (action==='generate'
    ? agentPrompt('conversation.generate')
    : ''), user: JSON.stringify(generationContext()), kind: 'conversation',instruction_phase:intakePhase?'intake':understandingPhase?'understand':composingPhase?'compose':answeringPhase?'answer':'discuss', timeoutMs:before.draft?35000:25000,onFailure:value=>{failure=value;}};
    let result=await model(options);
    if(result==null && failure?.retryable===true && !failure.retry_handled && !signal.aborted && usage.model_calls<modelCapacity && deadlineAt-Date.now()>options.timeoutMs+1000){
      trace('conversation','retry',{reason_code:failure.reason_code});result=await model(options);
    }
    if(result==null)throw Error('模型调用未完成');
    if(intakePhase && (!deps.model || deps.validateIntake===true) && result && !['ask','propose','select','confirm','question'].includes(result.planning?.action)){
      result=await model({...options,user:JSON.stringify({...generationContext(),output_validation_error:{field:'planning.action',reason:'missing_or_invalid'}})});
      if(!result || !['ask','propose','select','confirm','question'].includes(result.planning?.action))throw Error('规划动作字段无效');
    }
    if(intakePhase && (!deps.model || deps.validateIntake===true) && result)result=await reviewIntakeAction(result,{text:context.text,messages,conversation:before,current:context.current,model});
    return answeringPhase && result?{reply:result.reply,answer_resolution:result.resolution}:understandingPhase && result?{...result,draft:null}:result;
  };
  try {
    let intent=null;
    const transportRevision=choices=>reviseTransport({before:intent?.discard_preview?{...before,preview:null}:before,input,current:context.current,choices,model,search,readPage,runtime,signal,evidenceReview,mapTools:deps.transportMapTools,now:deps.now || Date.now(),trace,preview:intent?.intent_action==='preview',baseSignature:conditionSignature(input)});
    if(input.transport_choices!=null){
      if(action!=='chat'||!before.draft)throw Object.assign(Error('请在已有日程中选择要调整的交通段。'),{code:'TRANSPORT_REVISION'});
      return await transportRevision(input.transport_choices);
    }
    if(action==='chat' && before.draft){
      intent=await model({kind:'conversation_intent',timeoutMs:15000,schema_prompt:agentPrompt('conversation.intent'),
        user:JSON.stringify({text:context.text,route:before.draft.route,requirements:before.requirements,preview:!!before.preview,user_messages:messages.filter(m=>m.role==='user').slice(-8),current:context.current})});
      if(intent?.transport_choices?.some(c=>c.mode===null))intent.transport_only=false;
      if(intent?.transport_only!==false&&['revise','preview'].includes(intent?.intent_action)&&Array.isArray(intent.transport_choices)&&intent.transport_choices.length){
        if(intent.transport_choices.some(c=>typeof c.quote!=='string'||!c.quote.trim()||!context.text.includes(c.quote)))throw Object.assign(Error('没有核对到本轮交通选择的完整原话，原稿已保留。'),{code:'TRANSPORT_REVISION'});
        return await transportRevision(intent.transport_choices);
      }
      if(['revise','preview','question','undo','accept_preview','discuss'].includes(intent?.intent_action)){
        context.operation={intent_action:intent.intent_action,requirements_patch:object(intent.requirements_patch)};
        context.operation_instruction=agentPrompt('conversation.operation_context');
      }
      if(before.preview){const p=before.preview;context.conversation={...before,preview:{kind:p.kind,requirements:p.requirements,patch:p.patch,brief:p.brief,
        draft:p.draft?{title:p.draft.title,overview:str(p.draft.overview,200),route:p.draft.route,cards:p.draft.cards.map(c=>({id:c.id,place:c.place,label:c.label,title:c.title,content:str(c.content,160)}))}:null}};}
      if(intent?.intent_action==='accept_preview')return acceptPreview(before,input,plan);
    }
    let raw = action==='generate'?{intent_action:'revise',brief:before.brief,ready:true,confirmed:false}:await invoke();
    if(!raw)throw Error('模型理解未完成');
    if(intent?.transport_only===false && Array.isArray(intent.transport_choices))raw.planning={...raw.planning,transport_choices:intent.transport_choices};
    if(action==='chat' && raw){
      try {cleanPatch(raw,input.sights);}
      catch (error) {
        context.field_validation_error={reason:error.message};
        context.field_correction=agentPrompt('conversation.field_correction');
        raw=await invoke();
        if(!raw)throw Error('结构字段修正未完成');
        cleanPatch(raw,input.sights);
      }
    }
    if(action==='chat' && before.draft && raw){
      const op=['revise','preview','question','undo','accept_preview','discuss'].includes(intent?.intent_action)?intent.intent_action:raw.intent_action;
      /* 分类器的空增量不能抹掉主模型已识别的天数等字段。 */
      const requirementPatch={...object(raw.requirements_patch),...object(intent?.requirements_patch)};
      if(op!==raw.intent_action){
        context.operation={intent_action:op,requirements_patch:requirementPatch};
        context.operation_instruction=agentPrompt('conversation.operation_context');
        raw=await invoke();if(!raw)throw Error('操作落实未完成');
      }
      raw={...raw,intent_action:op,requirements_patch:requirementPatch,discard_preview:intent?.discard_preview===true || raw.discard_preview===true};
    }
    if(action==='chat' && raw?.intent_action==='accept_preview')return acceptPreview(before,input,plan);
    const understanding=raw?{intent_action:raw.intent_action,route_discovery:raw.route_discovery===true,brief:raw.brief,ready:raw.ready,confirmed:raw.confirmed,
      preferences:raw.preferences,travel:raw.travel,constraints:raw.constraints,sights:raw.sights,requirements_patch:raw.requirements_patch,discard_preview:raw.discard_preview===true,
      ...(raw.memory_patch!==undefined?{memory_patch:raw.memory_patch}:{}),...(raw.preference_memory_patch!==undefined?{preference_memory_patch:raw.preference_memory_patch}:{}),...(raw.selected_candidate_id?{selected_candidate_id:raw.selected_candidate_id}:{})}:null;
    context.resolved_intent=understanding;
    if(action==='chat' && raw?.intent_action==='undo')return {status:'ok',engine:'llm',action:input.can_undo===true?'undo':null,
      reply:input.can_undo===true?'已撤销上次调整。':'目前没有可撤销的调整。',conversation:before,
      patch:{preferences:{},travel:{},constraints:{},sights:{}},sources:[],request_generation:false};
    const routeResult=action==='generate'?initialRouting:await resolveConversationRouting({brief:raw?.brief || {},routing:raw?.routing,before,messages,text:context.text},model,
      {allowModel:!!before.draft && (raw?.confirmed===true || raw?.intent_action==='confirm' || raw?.ready===true && !countryScope(raw?.brief?.destination))});
    if(!routeResult.available && (!routeResult.routing.origin || !routeResult.routing.destination))throw Error('路线端点整理未完成');
    if(action==='chat' && before.routing.origin && before.routing.destination){
      const checked=await verifyRoutingChange({before,proposed:routeResult.routing,text:context.text,messages},model);
      if(JSON.stringify(checked)!==JSON.stringify(routeResult.routing)){
        const proposed=routeResult.routing;
        routeResult.routing=checked;
        raw.brief={...raw.brief,origin:!raw.brief?.origin || raw.brief.origin===proposed.origin?checked.origin:raw.brief.origin,destination:!raw.brief?.destination || raw.brief.destination===proposed.destination?checked.destination:raw.brief.destination};
        understanding.brief=raw.brief;
      }
    }
    understanding.routing=routeResult.routing;
    context.output_contract.route_origin=routeResult.routing.origin;context.output_contract.route_destination=routeResult.routing.destination;
    const textChoice=(plan?.candidates || []).find(c=>c.id===understanding.selected_candidate_id);
    if(textChoice){const chain=workspace.routeFor(null,textChoice),required=updateRequirements(before.requirements,object(understanding.requirements_patch));
      if(chain[0]===routeResult.routing.origin && chain.at(-1)===routeResult.routing.destination && required.required_stops.every(p=>chain.includes(p)) && !strings(understanding.requirements_patch?.remove_stops).some(p=>chain.includes(p)))context.output_contract.selected_route=chain;
    }
    // 文档操作与条件授权分别处理；咨询可补充真实条件，但须独立核对用户本轮授权。
    if(!interactionFirst && action==='chat' && raw.intent_action!=='preview'){
      const planningPatch=Object.fromEntries(['stay_locks','unlock_stays','remove_scopes','transport_choices'].filter(k=>Array.isArray(raw.planning?.[k])&&raw.planning[k].length).map(k=>[k,raw.planning[k]]));
      const proposed={requirements_patch:object(raw.requirements_patch),preferences:object(raw.preferences),travel:object(raw.travel),constraints:object(raw.constraints),sights:object(raw.sights),...(Object.keys(planningPatch).length?{planning:planningPatch}:{})};
      const authorizationCurrent={...context.current,scopes:before.discussion.scopes,stay_locks:before.discussion.stay_locks,route:before.draft?.route || before.discussion.options.find(o=>o.id===before.discussion.selected_id)?.route || []};
      if(Object.values(proposed).some(v=>Object.keys(v).length) || /往返|单程|自驾|预算|恢复|不采用|保留|\d+\s*天/.test(context.text)){
        let approved=await model({kind:'conversation_condition_update',timeoutMs:12000,
          schema_prompt:agentPrompt('conversation.condition_update'),
          user:JSON.stringify({text:context.text,current:authorizationCurrent,proposed})});
        const authorizedPatch=value=>{
          if(!value || typeof value!=='object' || Array.isArray(value))throw Error('本轮条件授权核对未完成');
          const candidate=Object.fromEntries(Object.keys(proposed).map(key=>[key,Object.fromEntries(Object.entries(object(value[key])).filter(([field,fieldValue])=>{
            if(key==='planning'&&!['stay_locks','unlock_stays','remove_scopes','transport_choices'].includes(field))return false;
            if(key==='planning'&&Array.isArray(fieldValue)&&fieldValue.every(item=>typeof item?.quote==='string'&&item.quote.trim().length>=2&&context.text.includes(item.quote)))return true;
            if(Object.hasOwn(proposed[key],field) && JSON.stringify(fieldValue)===JSON.stringify(proposed[key][field]))return true;
            const quote=value.authorizations?.[key+'.'+field];
            return typeof quote==='string' && quote.trim().length>=2 && context.text.includes(quote.trim());
          }))]));
          cleanPatch(candidate,input.sights);updateRequirements(before.requirements,candidate.requirements_patch);
          return candidate;
        };
        let checkedPatch;
        try{checkedPatch=authorizedPatch(approved);}catch(error){
          // 仅修复授权阶段的结构错误，不回到理解／搜索／整稿循环。
          trace('condition_patch','repairing',{reason_code:'invalid_condition_shape'});
          approved=await model({kind:'conversation_condition_update',timeoutMs:12000,schema_prompt:agentPrompt('conversation.condition_update'),
            user:JSON.stringify({text:context.text,current:authorizationCurrent,proposed,correction:error.message})});
          checkedPatch=authorizedPatch(approved);
        }
        const originalPlanning=raw.planning;
        Object.assign(raw,checkedPatch);
        if(proposed.planning)raw.planning={...originalPlanning,stay_locks:checkedPatch.planning?.stay_locks || [],unlock_stays:checkedPatch.planning?.unlock_stays || [],remove_scopes:checkedPatch.planning?.remove_scopes || [],transport_choices:checkedPatch.planning?.transport_choices || []};
      }
    }
    if(action==='chat' && before.draft && (dayOnlyPreferenceScope(context.text,before.draft) || raw.revision_scope?.editable?.length))raw.preferences={};
    for(const key of ['preferences','travel','constraints','sights','requirements_patch'])understanding[key]=raw[key];
    const calendarCandidate={travel:action==='chat'?patches(raw.travel,sanitizeIntentFields,['trip_type','outbound_window','arrival_window','return_window','traveler_count']):{}};
    let approvedSearchWindow=interactionFirst?sourceWindow(raw.search_window):null;
    const calendarKeys=['trip_type','outbound_window','arrival_window','return_window'];
    if(!interactionFirst && action==='chat' && (raw.search_window || /往返|单程|回程|返程|回到|飞回|返回|出发日期|日期未定/.test(context.text) || calendarKeys.some(key=>Object.hasOwn(calendarCandidate.travel,key) || raw.intent_action!=='question' && context.current.travel[key]))){
      const checked=await model({kind:'conversation_calendar',timeoutMs:15000,
        schema_prompt:agentPrompt('conversation.calendar'),
        user:JSON.stringify({date:context.date,text:context.text,messages,brief:before.brief,current:context.current.travel,
          proposed_search_window:raw.search_window || null})});
      if(!checked || !checked.travel || typeof checked.travel!=='object' || Array.isArray(checked.travel))throw Error('日期意图核对未完成');
      approvedSearchWindow=sourceWindow(checked.search_window);
      const approved=patches(checked.travel,sanitizeIntentFields,calendarKeys);
      for(const key of calendarKeys){delete calendarCandidate.travel[key];if(Object.hasOwn(approved,key))calendarCandidate.travel[key]=approved[key];}
    }
    raw.travel=calendarCandidate.travel;understanding.travel=calendarCandidate.travel;
    // 目标条件是本次动作的只读输入；preview仅用于备选，不提交为当前条件。
    const stayLocks=action==='generate'||raw.intent_action==='preview'?before.discussion.stay_locks:updateStayLocks(before.discussion.stay_locks,raw.planning,context.text);
    const transportChoices=action==='generate'?before.transport_choices:updateTransportChoices(before.transport_choices,raw.planning?.transport_choices || [],context.text);
    const targetCurrent={...context.current,transport_choices:transportChoices,stay_locks:stayLocks,requirements:action==='generate'?before.requirements:updateRequirements(before.requirements,object(raw.requirements_patch)),
      preferences:{...context.current.preferences,...object(raw.preferences)},travel:{...context.current.travel,...calendarCandidate.travel},constraints:{...context.current.constraints,...object(raw.constraints)}};
    context.target_current=targetCurrent;
    context.output_contract.max_cards=targetCurrent.requirements.trip_days || 60;
    if(action==='chat' && !before.draft && !['question','preview'].includes(raw.intent_action) && raw.route_discovery!==true){
      const proposedScopes=Array.isArray(raw.planning?.scopes)?cleanDiscussion({scopes:raw.planning.scopes}).scopes:[];
      const scopeKey=s=>countryScope(s.name)?.code || s.name;
      const removed=(raw.planning?.remove_scopes || []).filter(s=>typeof s?.quote==='string' && s.quote.trim().length>=2 && context.text.includes(s.quote) && before.discussion.scopes.some(old=>scopeKey(old)===scopeKey(s))).map(s=>scopeKey(s));
      const scopes=[...before.discussion.scopes,...proposedScopes].filter((s,i,a)=>!removed.includes(scopeKey(s)) && a.findIndex(t=>scopeKey(t)===scopeKey(s))===i);
      // 旧会话的国家级必经点迁移为范围；不删除用户的旅行范围。
      for(const place of targetCurrent.requirements.required_stops){const country=countryScope(place);if(country && !removed.includes(country.code) && !scopes.some(s=>s.name===place))scopes.push({name:place,level:'country'});}
      const next=cleanConversation({...before,brief:raw.brief,routing:routeResult.routing,discussion:{...before.discussion,scopes,stay_locks:stayLocks,...(Object.hasOwn(raw.planning || {},'recommendation_hold')?{recommendation_hold:raw.planning.recommendation_hold}:{})},summaries:workingSummaries});
      if(scopes.some(s=>s.name===next.routing.destination))next.routing.destination='';
      if(['select','confirm'].includes(raw.planning?.action) && before.discussion.options.length)next.brief=before.brief;
      next.requirements=scopeRequirements(targetCurrent.requirements,scopes);targetCurrent.requirements=next.requirements;
      targetCurrent.sights={...context.current.sights,...object(raw.sights)};
      const result=await discussPlan({before,next,current:targetCurrent,raw,input,model,search,readPage,signal,now:deps.now || Date.now(),evidenceReview,interactionFirst,trace,useCache:!deps.search});
      const candidates=extractMemoryCandidates(raw.memory_patch,{userMessages,currentMessageId:currentMessage?.mid ?? -1,allowedEvidenceRefs:[]});
      next.memory=commitMemoryDecisions(before.memory,candidates.accepted,{baseRevision:next.revision,now:deps.now || Date.now()});
      const preferenceWrite=await preferenceMemoryResult(raw);
      return {...result,reply:preferenceReplyReceipt(result.reply,{text:context.text,enabled:recalledPreferences.enabled}),patch:cleanPatch(raw,input.sights),preference_memory_upserts:preferenceWrite.upserts,preference_memory_context:preferenceWrite.context,preference_memory_notice:preferenceWrite.notice};
    }
    context.local_scope=before.draft && action==='chat' && targetCurrent.requirements.trip_days===before.requirements.trip_days && routeResult.routing.origin===before.routing.origin && routeResult.routing.destination===before.routing.destination && !(raw.requirements_patch?.add_stops?.length || raw.requirements_patch?.remove_stops?.length) && (dayOnlyPreferenceScope(context.text,before.draft) || raw.revision_scope?.editable?.length) && !/第[\d一二两三四五六七八九十]+天(?:起|之后|以后)/.test(context.text)?revisionDayScope(context.text,before.draft,raw.revision_scope).editable:[];
    context.readonly_scope=before.draft?revisionDayScope(context.text,before.draft,raw.revision_scope).readonly:[];
    const retrievalTravel=targetCurrent.travel;
    context.output_contract.trip_type=retrievalTravel.trip_type || 'pending';
    context.query_scope=draftQueryScope({route:evidenceRoute,candidate:evidenceCandidate,transport_choices:targetCurrent.transport_choices,preferences:{...input.preferences,...raw.preferences},previous:input.research_scope,anchors:input.anchors,travel:retrievalTravel},deps.now || Date.now());
    evidenceLegs=context.query_scope.legs.map(l=>({...l,mode_guess:l.mode}));
    context.retrieval=retrievalContext({travel:retrievalTravel,window:approvedSearchWindow,purpose:'experience',now:deps.now || Date.now()});
    visibleEvidence=transportSearchEvidence(input.retrieval_ids,{route:evidenceRoute,legs:evidenceLegs,window:context.retrieval.target_window,now:deps.now || Date.now()});context.visible_search_results=visibleEvidence;
    context.visible_experiences=transportSearchEvidence(input.retrieval_ids,{route:evidenceRoute,legs:evidenceLegs,window:context.retrieval.target_window,now:deps.now || Date.now(),purpose:'experience'});
    context.transport_references=[];
    const resolvedDestination = routeResult.routing.destination || str(raw?.brief?.destination,80) || destination;
    let sources=[];
    let historicalSources=[];
    sources=partitionTimedSources(visibleEvidence,context.retrieval).current.slice(0,6);
    context.evidence_catalog=buildEvidenceCatalog({sources,routing:routeResult.routing,retrieval:context.retrieval,travel:retrievalTravel,now:deps.now || Date.now()});
    context.background_only=agentPrompt('conversation.background_context');
    // 搜索是意图判定后的动作，目的地存在本身不触发检索。
    const confirming = action==='chat' && !before.draft && (raw.confirmed===true || raw.intent_action==='confirm');
    const explicitResearch=action==='chat' && /请.{0,12}(?:查|核对)|(?:查找|搜索|查询)(?:一下|资料|攻略|原帖)|有(?:没有|哪些).{0,5}(?:资料|来源)|查资料|核实|核对|补查|继续查/.test(context.text);
    const searchQuery=str(raw?.search_query,100) || (explicitResearch?str(context.text,100):'');
    const itineraryResearch=isComposing() && !explicitResearch;
    const materialCities=itineraryMaterialCities(generationOutline,targetCurrent.requirements.required_stops,resolvedDestination);
    const itineraryCities=materialCities.join(' ');
    const focus=itineraryResearch?str(before.brief.wishes.join(' '),80):'';
    const englishMaterial=itineraryResearch && englishRequest(input);
    const searchAction=isComposing() && !!resolvedDestination || !confirming && raw.route_discovery!==true && (explicitResearch || !!searchQuery);
    trace('action_decision','completed',{action:confirming?'confirm_generation':searchAction?'search':'discuss'});
    if (searchAction) {
      const country=countryScope(resolvedDestination)?.code || raw?.destination_country;
      let researched=null;
      if(explicitResearch && raw.research_request){
        try{
          trace('research_loop','started');
          researched=await runResearchLoop({...object(raw.research_request),question:context.text,window:approvedSearchWindow || context.retrieval.target_window,places:plan?.places || []},
            {model,search,signal,readPage:readPage || (async()=>null),now:deps.now,onTrace:deps.onTrace,
              limits:{rounds:2,searches:4,reads:2,model_calls:10,task_ms:60000}});
          trace('research_loop',researched.status,{stop_reason:researched.stop_reason});
        }catch(error){trace('research_loop','unavailable',{reason_code:signal.aborted?'cancelled':'research_failed'});}
      }
      let collected=researched?{sources:researched.sources || [],experiences:researched.experiences || [],archive:[],channels:[],
        temporal:context.retrieval,relevance:{status:'completed'},reader:{attempted:researched.budget?.used?.reads || 0,available:0},status:'available',
        results:(researched.sources || []).map(s=>({title:s.title,link:s.url,content:s.excerpt,date:s.published_at,date_basis:s.date_basis}))}
        :await collectTravelSources({destination:resolvedDestination,query:itineraryResearch?str(itineraryCities+' '+(focus || '深度游记 街区 地标 公园 自然 当地文化 特色体验'),100):searchQuery,question:context.text,
        itinerary_stops:itineraryResearch?materialCities:[],itinerary_focus:focus,itinerary_language:englishMaterial?'en':null,include_day_tours:itineraryResearch && !!targetCurrent.constraints?.no_self_drive,
        international:country?country!=='CN':true,foreignQuery:itineraryResearch?str((raw?.search_query_en || resolvedDestination)+' travel itinerary local culture neighborhoods nature',100):str(raw?.search_query_en,100),travel:retrievalTravel,window:approvedSearchWindow,
        purpose:itineraryResearch?'experience':['transport','experience','guide'].includes(raw.search_purpose)?raw.search_purpose:/交通|班车|巴士|航班|口岸|开放|票价/.test(str(raw?.search_query)+context.text)?'transport':'experience'},search,{useCache:!deps.search,now:deps.now || Date.now(),readPage,signal,
          // 纯搜索桩不隐式增加真实模型调用；回放可显式启用，生产路径共用模型预算与取消。
          assessSources:!interactionFirst && (!deps.search || deps.sourceReview===true)?relevanceReviewer(model):null});
      if(!interactionFirst && itineraryResearch && (!deps.search || deps.qualityResearch===true)){
        const cities=materialCities,coverage=materialCoverage(collected,cities);
        const gaps=coverage.filter(c=>c.status==='gap'),gap=gaps[0];
        if(gap && usage.search_calls<=6 && usage.model_calls<12 && deadlineAt-Date.now()>65000 && !signal.aborted){
          const gapCities=gaps.slice(0,2).map(item=>item.city);
          trace('material_gap','researching',{city:gap.city,cities:gapCities});
          const supplement=await collectTravelSources({destination:gap.city,itinerary_stops:gapCities,cityQueriesOnly:gapCities.length>1,itinerary_focus:gapCities.length>1?'街区 景点 特色美食 '+focus:'',query:gap.city+' 深度游记 街区 地标 特色美食 文化体验',question:'补充'+gap.city+'当天可安排的具体地点和特色',
            international:countryScope(gap.city)?.code!=='CN',foreignQuery:str(gap.city+' '+(focus || 'attractions neighborhoods culture travel guide'),100),purpose:'experience',travel:retrievalTravel},search,
            {useCache:false,now:deps.now || Date.now(),readPage,signal,assessSources:relevanceReviewer(model)});
          collected=mergeMaterialCollections(collected,supplement);
          trace('material_gap',materialCoverage(collected,[gap.city])[0].status==='covered'?'completed':'unresolved',{city:gap.city});
        }
        const remaining=materialCoverage(collected,cities).filter(c=>c.status==='gap').map(c=>c.city);
        context.output_contract.material_gaps=remaining;
        trace('material_coverage','completed',{cities:coverage.map(c=>c.city),remaining});
      }
      try{deps.onSourceCollection?.({status:collected.status,channels:collected.channels.map(c=>({channel:c.channel,status:c.status,provider:c.provider})),
        relevance:collected.relevance,source_count:collected.sources.length,archive_count:collected.archive.length,experience_count:collected.experiences.length,reader:collected.reader});
        deps.onSourceAudit?.(collected.source_audit || []);}catch{}
      const results=collected.results;
      historicalSources=collected.archive.filter(s=>s.relevance?.decision==='keep').slice(0,4);
      // 资料失败不撤回用户条件或具名候选；规划建议与已核实运营事实分开，轨迹保留真实检索结果。
      if(collected.relevance?.status==='unavailable' || collected.status==='unavailable')context.research_failure=collected.relevance?.reason_code || 'search_unavailable';
      context.destination_material = null;
      context.search_results = (results || []).concat(visibleEvidence.map(s=>({title:s.title,link:s.url,content:s.excerpt,date:s.published_at,temporal:s.temporal})));
      context.experience_results=collected.experiences;
      context.source_channels=collected.channels;
      context.retrieval=collected.temporal;context.reader_status=collected.reader;
      context.source_relevance=collected.relevance;
      context.search_complete = true;
      context.source_instruction = agentPrompt('conversation.source_context');
      const uniqueSources=partitionTimedSources(collected.sources.concat(sources),context.retrieval).current.filter((s,i,all)=>all.findIndex(x=>x.url===s.url)===i);
      sources=collected.experiences.concat(context.visible_experiences,uniqueSources).filter((s,i,all)=>all.findIndex(x=>x.url===s.url)===i).slice(0,8);
      const official=uniqueSources.find(s=>s.kind==='official');
      if(official && !sources.some(s=>s.url===official.url))sources[sources.length-1]=official;
      const chosen=new Set(sources.map(s=>s.url));
      context.search_results=context.search_results.filter(s=>chosen.has(s.link));
      context.experience_results=context.experience_results.filter(s=>chosen.has(s.url));
      const background=collected.archive.filter(s=>s.relevance?.decision==='keep' && ['official','guide','experience'].includes(s.kind)).slice(0,4).map(s=>({...s,allowed_use:s.kind==='experience'?'travel_experience_background':'destination_background'}));
      context.evidence_catalog=buildEvidenceCatalog({sources:sources.concat(background),routing:routeResult.routing,retrieval:context.retrieval,travel:retrievalTravel,now:deps.now || Date.now()});
      raw = {...await invoke(),...understanding};
    }
    /* 每次按当前来源重建事实表；主回复及所有编辑阶段执行相同的逐项守门。 */
    const verificationRequested=!!raw.research_request || /请.{0,12}(?:核实|核对|检查)|(?:时刻|时区|班次|费用|金额).{0,12}(?:核实|核对|检查)/.test(context.text);
    const deliveryOutput=value=>{
      if(!value)return value;
      if(action==='chat' && !before.draft && value.intent_action!=='preview')return {...value,draft:null};
      const clean=cleanDraft(value.draft,before.draft);
      return clean?{...value,reply:(verificationRequested?str(value.reply):workspace.presentReply(value.reply)) || '已整理这份安排，可以继续比较和调整。',draft:workspace.presentDraft(clean)}:value;
    };
    raw=deliveryOutput(raw);
    const checkNumbers=value=>validateNumericClaims(numericRevisionScope(value,before.draft,context.local_scope || []),{catalog:numericCatalog(),constraints:targetCurrent.constraints,text:context.text,includePending:false});
    const unsupportedNumbers=value=>checkNumbers(value).rejected.map(f=>f.path+'['+f.occurrence+'] '+f.text+'：'+f.reason);
    let numberRepairCalls=0;
    const repairNumericFields=async(value,targetCurrent=context.target_current || context.current)=>{
      const rejected=checkNumbers(value).rejected,paths=[...new Set(rejected.map(r=>r.path))];
      if(!paths.length || paths.length>8 || numberRepairCalls>=3 || signal.aborted)return value;
      const at=(object,path)=>path.split('.').reduce((v,key)=>v && Object.hasOwn(v,key)?v[key]:undefined,object);
      const fields=paths.map(path=>{const card=path.match(/^draft\.cards\.(\d+)\./),meta=card?value.draft?.cards?.[Number(card[1])]:null;return {path,text:at(value,path),is_itinerary:path.startsWith('draft.'),
        ...(meta?{card:{id:meta.id,label:meta.label,place:meta.place,title:meta.title}}:{})};});
      if(fields.some(f=>typeof f.text!=='string'))return value;
      numberRepairCalls++;
      let response;try{response=await model({kind:'conversation_numeric_repair',timeoutMs:12000,schema_prompt:agentPrompt('conversation.numeric_repair'),
        user:JSON.stringify({text:context.text,brief:context.resolved_intent?.brief || before.brief,route:value.draft?.route || before.draft?.route,current:targetCurrent,fields,rejections:rejected.map(r=>({path:r.path,text:r.text,reason:r.reason}))})});}catch{return value;}
      if(!Array.isArray(response?.fields) || response.fields.length!==paths.length || new Set(response.fields.map(f=>f?.path)).size!==paths.length ||
        response.fields.some(f=>!paths.includes(f?.path) || typeof f.text!=='string' || !f.text.trim() || f.text.length>(/\.title$/.test(f.path)?100:f.path==='draft.overview'?1000:f.path==='reply'?1600:1200)))return value;
      const copy=structuredClone(value),key=n=>[n.field,n.unit,n.value].join('|');
      for(const field of response.fields){
        const original=at(value,field.path),allowed=new Set(numericOccurrences(original).map(key));
        if(numericOccurrences(field.text).some(n=>!allowed.has(key(n))))return value;
        const parts=field.path.split('.'),leaf=parts.pop(),parent=parts.reduce((v,k)=>v[k],copy);parent[leaf]=field.text.trim();
      }
      if(checkNumbers(copy).rejected.length)return value;
      trace('numeric_repair','applied',{fields:paths});return copy;
    };
    if(!interactionFirst && unsupportedNumbers(raw).length){
      raw=await repairNumericFields(raw);
      if(unsupportedNumbers(raw).length){
        context.correction=agentPrompt('conversation.numeric_correction',{rejections:unsupportedNumbers(raw).join('、')});
        raw=deliveryOutput({...await invoke(),...understanding});
      }
    }
    if(action==='generate' && raw && !cleanDraft(raw.draft)){
      context.field_correction={reason:'invalid_draft_shape',expected:'route:string[]; cards:{id,place,label,title,content}[]'};
      raw=deliveryOutput({...await invoke(),...understanding});
    }
    const missingOutputFields=[...(!raw?['response']:[]),...(!str(raw?.reply)?['reply']:[]),...(!raw?.brief?['brief']:[]),...(typeof raw?.ready!=='boolean'?['ready']:[])];
    const remainingNumeric=!interactionFirst && raw?checkNumbers(raw).rejected:[];
    if(missingOutputFields.length || remainingNumeric.length){
      trace('output_contract','failed',{missing_fields:missingOutputFields,numeric_fields:remainingNumeric.map(r=>({path:r.path,reason:r.reason}))});
      throw Error(remainingNumeric.length?'数值字段修复后仍未通过':'模型回复缺少必需字段：'+missingOutputFields.join(','));
    }
    const next = cleanConversation({ ...before, brief: raw.brief,routing:routeResult.routing,transport_choices:transportChoices,discussion:{...before.discussion,stay_locks:stayLocks} });
    if(action==='chat' && raw.discard_preview===true)next.preview=null;
    /* M1：决策记忆候选——代码校验（kind/摘要/消息出处/同旅行可见来源）后随本次状态转换提交 */
    const memoryCandidates = extractMemoryCandidates(raw.memory_patch, {
      userMessages,currentMessageId:action==='chat'?currentMessage?.mid ?? -1:null,
      allowedEvidenceRefs: visibleEvidence.map(s => s.url).concat(sources.map(s => s.url))
    });
    next.summaries = workingSummaries;
    if(action==='generate')next.brief=before.brief;
    const changedDestination = raw.intent_action!=='question' && ((initialRouting.routing.destination && next.routing.destination!==initialRouting.routing.destination) || (initialRouting.routing.origin && next.routing.origin!==initialRouting.routing.origin));
    const questionOnly = action==='chat' && raw.intent_action==='question';
    next.requirements=action==='generate'?before.requirements:updateRequirements(before.requirements,object(raw.requirements_patch));
    let draft = questionOnly ? null : cleanDraft(raw.draft,before.draft);
    if(action==='chat' && raw.intent_action==='preview' && !Object.hasOwn(object(raw.requirements_patch),'trip_days')){
      const proposedDays=proposedPreviewDays(draft,next.routing.origin,{...context.current.travel,...object(raw.travel)});
      if(proposedDays){next.requirements={...next.requirements,trip_days:proposedDays};trace('preview_target','derived',{trip_days:proposedDays});}
    }
    if(draft && before.draft && (before.draft.cards.length && !draft.cards.length || before.draft.route.length && !draft.route.length))throw new Error('修改缺少原有路线与卡片');
    if(before.draft && ['revise','preview'].includes(raw.intent_action) && !draft && !changedDestination)throw new Error('修改或预览未落入草案');
    /* 生成只读取已经确认的条件，不能借写稿新填日期或改交通类型。 */
    if(action==='generate'){raw.preferences={};raw.travel={};raw.constraints={};raw.sights={};}
    const patch = {
      preferences: patches(raw.preferences, guide.clean, ['pace','road','nights','preferred_mode','experience','nature_theme','destination_days']),
      travel: patches(raw.travel, sanitizeIntentFields, ['trip_type','outbound_window','arrival_window','return_window','traveler_count']),
      constraints: patches(raw.constraints, sanitizeConstraints, ['budget_max_cny','max_layover_hours','max_transfers','night_arrival','no_self_drive','lodging_stays']),
      sights: context.sight_material ? patches(raw.sights, v => normalizeSightState({...input.sights,...v}), ['selected_ids','visit_dates','full_days','play_window']) : {}
    };
    if (action === 'generate' && !draft) throw new Error('模型未生成草案');
    const requestedActivityFill=action==='chat' && raw.intent_action==='revise' && /补全|完善|具体|丰富|详细/.test(context.text);
    if(!interactionFirst && (action==='generate' || requestedActivityFill) && draft && (!deps.search || deps.activityResearch===true)){
      const gaps=activityContentGaps(draft),gap=action==='generate'?gaps[0]:gaps.find(g=>context.text.includes(g.label)) || (/整体|整份|全部|全程/.test(context.text)?gaps[0]:null);
      if(gap && usage.search_calls<=6 && usage.model_calls<10 && deadlineAt-Date.now()>75000 && !signal.aborted){
        trace('activity_gap','researching',gap);
        try{
          const supplement=await collectTravelSources({destination:gap.city,query:(gap.city+' '+gap.title+' 具体景点 深度游记 特色体验').slice(0,100),question:gap.title+'需要具体地点与玩法',
            foreignQuery:(gap.city+' '+gap.title+' attractions activities travel guide').slice(0,100),international:countryScope(gap.city)?.code!=='CN',purpose:'experience'},search,
            {useCache:false,now:deps.now || Date.now(),signal,readPage,assessSources:relevanceReviewer(model)});
          const material=[...supplement.sources,...supplement.experiences,...supplement.archive].filter(s=>s.relevance?.decision==='keep');
          if(material.length){
            const extra=buildEvidenceCatalog({sources:material,routing:next.routing,retrieval:context.retrieval,now:deps.now || Date.now()});
            context.evidence_catalog={...context.evidence_catalog,entries:context.evidence_catalog.entries.concat(extra.entries).filter((s,i,a)=>a.findIndex(x=>x.id===s.id)===i)};
            const original=draft.cards.find(c=>c.id===gap.card_id);
            const filled=await model({kind:'conversation_activity_fill',timeoutMs:15000,schema_prompt:agentPrompt('conversation.activity_fill')+'\n'+agentPrompt('conversation.delivery'),
              user:JSON.stringify({card:original,requirements:next.requirements,current:targetCurrent,evidence_catalog:extra})});
            if(filled?.card?.id===original.id && typeof filled.card.title==='string' && filled.card.title.trim() && filled.card.title.length<=100 && typeof filled.card.content==='string' && filled.card.content.trim() && filled.card.content.length<=1200){
              const proposed=cleanDraft({...draft,cards:draft.cards.map(c=>c.id===original.id?{...c,title:filled.card.title,content:filled.card.content}:c)},draft);
              if(proposed && !unsupportedNumbers({draft:proposed}).length && !activityContentGaps(proposed).some(g=>g.card_id===gap.card_id)){draft=proposed;trace('activity_gap','prepared',{card_id:gap.card_id});}
            }
          }
        }catch{trace('activity_gap','unresolved',{card_id:gap.card_id});}
      }
    }
    const localScope=context.local_scope || [];
    if(draft && localScope.length)draft=preserveOutsideScope(before.draft,draft,localScope);
    const lockedInputs=Object.values(input.anchors || {}).some(Boolean) || targetCurrent.constraints?.lodging_stays?.length || input.sights?.selected_ids?.length;
    const driveConflict=!!targetCurrent.constraints?.no_self_drive && draft?.cards.some(c=>(c.title+'。'+c.content).split(/[。；;，,\n]/).some(s=>/自驾|租车|开车/.test(s) && !/(?:不(?:必|需要)?|无需|无须|不用|不要|避免)(?:自己)?(?:自驾|租车|开车)/.test(s)));
    // 首次基础稿由后续确定性结构检查和事实核对把关；已有稿修改／锁定输入仍需语义一致性编辑。
    const allocationOutline=generationOutline?{...generationOutline,preserve_allocation:true}:before.discussion.options.find(o=>o.id===before.discussion.selected_id) || null;
    const needsFullReview=!!lockedInputs || driveConflict || !!before.draft && !localScope.length || !!draft && allocationReview(draft,allocationOutline,stayLocks).hard_issues.length>0;
    if(draft && action==='generate' && !needsFullReview)trace('conversation_review','skipped',{reason_code:'initial_draft_structural_checks'});
    if(!interactionFirst && draft && (action==='generate' || before.draft) && !changedDestination && needsFullReview){
      let reviewed = await model({kind:'conversation_review',timeoutMs:25000,
        schema_prompt:agentPrompt('conversation.review'),
        /* 核对只读用户要求与拟稿，避免旧助手“已修正”的话术再次成为依据。 */
        user:JSON.stringify({action:context.action,text:context.text,user_messages:messages.filter(m=>m.role==='user'),
          current:targetCurrent,routing:before.routing,requirements:next.requirements,output_contract:context.output_contract,original_route:before.draft?.route || [],displayed_routes:context.routes,selection_request:context.selection_request,proposed_candidate_id:raw.selected_candidate_id,updated_brief:next.brief,patch,destination_material:evidenceReview?null:context.destination_material,
          evidence_catalog:context.evidence_catalog,local_mobility_index:buildLocalMobilityIndex(context.evidence_catalog),source_boundary:agentPrompt('conversation.review_source_boundary'),
          search_results:evidenceReview?[]:context.search_results,transport_references:[],proposed:{draft}})});
      if(reviewed?.draft){reviewed.reply=(verificationRequested?str(reviewed.reply):workspace.presentReply(reviewed.reply)) || '已整理这份安排，可以继续比较和调整。';reviewed.draft=workspace.presentDraft(reviewed.draft);}
      if(reviewed && unsupportedNumbers(reviewed).length)reviewed=await repairNumericFields(reviewed,{...context.current,requirements:next.requirements});
      const checked=cleanDraft(reviewed?.draft?{...reviewed.draft,...(draft.map_places && !reviewed.draft.map_places?{map_places:draft.map_places}:{})}:null,before.draft);
      if(!checked || unsupportedNumbers(reviewed).length)throw new Error('草案一致性检查未完成');
      /* 校对可改内容，不可悄悄丢掉模型已提供的结构。 */
      if(draft.cards.length && !checked.cards.length || draft.route.length && !checked.route.length)throw new Error('结构化草案校对未完成');
      draft=localScope.length?preserveOutsideScope(before.draft,checked,localScope):checked;raw.reply=str(reviewed.reply) || raw.reply;
    }
    if(draft){
      const travel={...context.current.travel,...patch.travel};
      const returnAllowed=travel.trip_type==='round_trip' || travel.return_window || input.anchors?.return;
      // route合同只存去程城市链；用户确认往返时，规范化模型多写的末尾返程节点，逐日返程保留。
      if(returnAllowed && draft.route.at(-1)===next.routing.origin && routeMatchesIntent(draft.route.slice(0,-1),next.routing,next.requirements))draft.route=draft.route.slice(0,-1);
      if(!interactionFirst){
      const returnChecks=new Map();
      const affected=returnAllowed?[]:await unconfirmedReturnCards(draft,next.routing,model,returnChecks);
      if(affected.length){
        const fixed=await model({kind:'conversation_scope',timeoutMs:25000,
          schema_prompt:agentPrompt('conversation.scope'),
          user:JSON.stringify({affected,travel,requirements:next.requirements,routing:next.routing,text:context.text})});
        let checked;
        if(Array.isArray(fixed?.cards)){
          if(fixed.cards.length!==affected.length || new Set(fixed.cards.map(c=>c?.id)).size!==affected.length || fixed.cards.some(c=>!affected.some(a=>a.id===c?.id) || !str(c.title) || !str(c.content)))throw Error('卡片修改范围不一致');
          checked=cleanDraft({...draft,cards:draft.cards.map(c=>{const change=fixed.cards.find(x=>x.id===c.id);return change?{...c,title:change.title,content:change.content,place:c.place===next.routing.origin && !draft.route.slice(1).includes(next.routing.origin)?next.routing.destination:c.place}:c;})},draft);
        }else checked=cleanDraft(fixed?.draft,draft);
        if(!checked)throw Error('返程修复未返回卡片');
        if((await unconfirmedReturnCards(checked,next.routing,model,returnChecks)).length)throw Error('返程修复仍含未确认返程');
        if(JSON.stringify(checked.route)!==JSON.stringify(draft.route))throw Error('返程修复改变城市链');
        if(unsupportedNumbers({reply:fixed?.reply,draft:checked}).length)throw Error('返程修复仍有无来源数字');
        draft=checked;raw.reply=str(fixed.reply) || raw.reply;
      }
      if(!returnAllowed)draft=await repairReturnSummary(draft,next.routing,model,returnChecks);
      const coverage=workspace.dayCoverage(draft,next.requirements.trip_days) || (action==='generate' && next.requirements.trip_days?{missing:Array.from({length:next.requirements.trip_days},(_,i)=>i+1),outside:[]}:null);
      if(coverage && (coverage.missing.length || coverage.outside.length)){
        const repaired=await model({kind:'conversation_schedule',timeoutMs:25000,
          schema_prompt:agentPrompt('conversation.schedule'),
          user:JSON.stringify({draft,requirements:next.requirements,travel:{...context.current.travel,...patch.travel},coverage})});
        let checked=cleanDraft(repaired?.draft,draft);
        if(checked && !coverage.outside.length){
          const originals=new Map(draft.cards.map(c=>[c.id,c]));
          if(draft.cards.some(c=>!checked.cards.some(x=>x.id===c.id)))throw Error('日序修复删除了原卡片');
          trace('schedule','applied',{mode:'labels_only',ignored_content_changes:checked.cards.filter(c=>originals.has(c.id) && ['title','content','place'].some(key=>c[key]!==originals.get(c.id)[key])).length});
          checked={...draft,cards:checked.cards.map(c=>originals.has(c.id)?{...originals.get(c.id),label:c.label}:c)};
        }
        const status=checked && workspace.dayCoverage(checked,next.requirements.trip_days);
        if(!checked || !status || status.missing.length || status.outside.length || JSON.stringify(checked.route)!==JSON.stringify(draft.route) || unsupportedNumbers({draft:checked}).length)throw Error('全程天数校对未完成');
        draft=checked;
      }
      if(!returnAllowed && (await unconfirmedReturnCards(draft,next.routing,model,returnChecks)).length)throw Error('日序校对重新引入未确认返程');
      }
    }
    if(questionOnly){next.brief=before.brief;next.routing=before.routing;}
    if(!interactionFirst && questionOnly && before.draft){
      const checked=await model({kind:'conversation_review',timeoutMs:25000,
        schema_prompt:agentPrompt('conversation.question_review'),
        user:JSON.stringify({...generationContext(),proposed_reply:raw.reply})});
      if(!str(checked?.reply) || unsupportedNumbers(checked).length)throw new Error('问答资料校对未完成');
      raw.reply=checked.reply;
    }
    if(!interactionFirst && draft?.route.length && !routeMatchesIntent(draft.route,next.routing,next.requirements)){
      trace('route_contract','repair',{route:draft.route});
      const fixed=await model({kind:'planning_route_structure',timeoutMs:12000,schema_prompt:agentPrompt('planning.route_structure'),
        user:JSON.stringify({route:draft.route,cards:draft.cards,routing:next.routing,required_stops:next.requirements.required_stops,selected_route:context.output_contract.selected_route || null})});
      const allowed=new Set([...draft.route,next.routing.origin,next.routing.destination,...next.requirements.required_stops]);
      if(Array.isArray(fixed?.route) && fixed.route.length>=2 && fixed.route.length<=12 && fixed.route.every(p=>typeof p==='string'&&allowed.has(p)) &&
        routeMatchesIntent(fixed.route,next.routing,next.requirements) && next.requirements.required_stops.every(p=>fixed.route.includes(p)))draft.route=fixed.route;
      if(!routeMatchesIntent(draft.route,next.routing,next.requirements))throw new Error('草案路线端点与确认信息不一致');
    }
    if(!interactionFirst && draft && next.requirements.required_stops.some(place=>!draft.route.includes(place)))throw Error('草案遗漏必经城市，保留原稿');
    if(!interactionFirst && action==='generate' && draft?.route.length && generationOutline && JSON.stringify(draft.route)!==JSON.stringify(generationOutline.route))throw Error('草案偏离已确认的城市方案，原方案保留');
    if(draft && next.requirements.verified_cross_border_only){
      const note='跨境交通须有可核查来源及适用日期；当前草案尚不能证明班次与衔接已核实。';
      if(!draft.pending.includes(note))draft.pending=[note,...draft.pending].slice(0,10);
    }
    if(!interactionFirst && requestedChoice && (!draft || !workspace.matches(draft.route,requestedChoice)))throw Error('生成稿未保留已选路线，原选择仍保留');
    const selected = requestedChoice || (plan?.candidates || []).find(c => c.id === raw.selected_candidate_id && (!draft?.route.length || workspace.matches(draft.route,c)));
    if(explicitChoice && draft){
      raw.reply='已按你选的 '+draft.route.join(' → ')+' 生成初稿，其他已确认条件保留。可以继续聊着调整。';
    }
    let planningResult=null;
    const optionalPlanningModel=opts=>action==='generate' && (usage.model_calls>=modelCapacity || deadlineAt-Date.now()<=1000)?Promise.resolve(null):model(opts);
    const resolvePlanningPlaces=deps.resolvePlanningPlaces || ((args,options)=>resolveDayMap(args,{...options,resolveNames:async(city,names)=>{
      const value=await optionalPlanningModel({kind:'planning_place_names',timeoutMs:10000,schema_prompt:agentPrompt('map.query_names'),user:JSON.stringify({city,names})});return value?.places || [];
    }}));
    const mobilityQuestion=questionOnly && before.draft && verificationRequested && /公交|交通|走完|衔接|车程/.test(context.text);
    const planningEnabled=deps.planning===true || !deps.model && googleMapsEnabled() && (!interactionFirst || mobilityQuestion);
    if(mobilityQuestion && planningEnabled){
      planningResult=await runPlanningLoop({draft:before.draft,conditions:targetCurrent,scope:localScope.length?localScope:null,model:null,runtime,signal,resolve:resolvePlanningPlaces,query:deps.queryPlanningRoute,now:deps.now || Date.now()});
      raw.reply='这次还不能判断全天能否按公共交通走完：需要明确出发时刻、各站停留，以及首末段安排。可在当天地图中填写这些条件后核对。';
    }
    if(action==='generate' && draft)raw.reply=englishRequest(input)?'Your daily itinerary is ready for review and adjustments.':'已整理这份逐日安排，可以继续调整。';
    // 未核验结构只供恢复后重查，绝不作为可交付内容；事实模型失败也能跳过重复整稿生成。
    if(draft)await deps.onCheckpoint?.({stage:'structure_ready',draft,conditions:targetCurrent});
    if(draft){const fields=evidenceFields(raw.reply,numericRevisionScope({draft},before.draft,localScope).draft,{includePending:false}).length;modelCapacity=validationModelCapacity(fields);trace('validation_workload','registered',{fields,model_capacity:modelCapacity});}
    const numericGrounding=checkNumbers({reply:raw.reply,draft});
    if(!interactionFirst && numericGrounding.rejected.length)throw Error('最终回复仍有无依据数字，原安排保留');
    const citedFacts=[...new Map(numericGrounding.grounded.filter(f=>f.source_url).map(f=>[f.source_url,f])).values()];
    if(!interactionFirst && citedFacts.length>8)throw Error('本轮数字来源过多，请缩小讨论范围');
    sources=citedFacts.map(f=>sources.find(s=>s.url===f.source_url) || {url:f.source_url,title:'数字参考资料',excerpt:f.evidence_quote,published_at:f.published_at,read_status:f.read_status,...classifyTravelSource(f.source_url)})
      .concat(sources).filter((s,i,a)=>a.findIndex(x=>x.url===s.url)===i).slice(0,8);
    const lightDelivery=interactionFirst || deliveryReviewMode({action,requiresDatedEvidence:next.requirements.verified_cross_border_only,
      mode:deps.deliveryReview || (deps.model?'strict':undefined)})==='light';
    let lightResult=null;
    if(lightDelivery && draft){
      const preservedValidation=checkTravelDelivery({draft,requirements:next.requirements,routing:next.routing,numeric:interactionFirst?null:checkNumbers({draft}),requireDaily:true,quality:{status:'unreviewed',issues:[]},confirmedOutline:allocationOutline,stayLocks});
      if(preservedValidation.valid)await deps.onCheckpoint?.({stage:'structure_ready',draft,conditions:targetCurrent,safe_delivery:{conversation:{...next,draft:{...draft,quality_status:'unreviewed'},stage:'draft',revision:before.revision+1,preview:null},patch,sources,evidence_claims:[],delivery_validation:{...preservedValidation,review_mode:interactionFirst?'final':'light'}}});
      lightResult=interactionFirst?await reviewFinalItinerary({draft,current:{...targetCurrent,brief:next.brief,routing:next.routing,text:context.text},messages:userMessages,confirmedOutline:allocationOutline,catalog:context.evidence_catalog,model,signal,scope:localScope,readonly:context.readonly_scope || [],budgetChars:deps.contextBudgetChars,
        check:candidate=>checkTravelDelivery({draft:candidate,requirements:next.requirements,routing:next.routing,requireDaily:true,confirmedOutline:allocationOutline,stayLocks}).checks}):await editItinerary({draft,current:{...targetCurrent,brief:next.brief},messages:allMessages,catalog:context.evidence_catalog,model,signal,budgetChars:deps.contextBudgetChars,
        validate:candidate=>checkTravelDelivery({draft:candidate,requirements:next.requirements,routing:next.routing,numeric:checkNumbers({draft:candidate}),requireDaily:true,confirmedOutline:allocationOutline,stayLocks}).valid});
      draft=cleanDraft(lightResult.draft,draft);
      if(interactionFirst && lightResult.status==='passed' && lightResult.applied>0)raw.reply=lightResult.notice || (englishRequest(input)?'The itinerary has been updated with the final corrections.':'已按最终修正更新安排。');
      trace(interactionFirst?'final_review':'light_edit',lightResult.status,{applied:lightResult.applied,skipped:lightResult.skipped,rejected:lightResult.rejected,reason:lightResult.reason});
    }
    let evidenceResult=null;
    if(evidenceReview && !lightDelivery){
      if(context.source_relevance?.status==='partial' || context.source_channels?.some(c=>c.status==='unavailable')){
        raw.reply=raw.reply.replace(/[^。！？!?\n]*?(?:没有(?:查到|找到|检索到|匹配到)|查无|未搜到|暂无(?:匹配|资料|攻略))[^。！？!?\n]*[。！？!?]?/g,'部分候选尚未核对，不能据此判断资料是否存在。');
      }
      evidenceResult=await groundScopedConversationOutput({reply:raw.reply,draft,catalog:context.evidence_catalog,model,signal,budgetChars:deps.contextBudgetChars,deliveryMode:!!draft,remainingMs:()=>deadlineAt-Date.now(),
        conditions:{text:context.text,verification_requested:verificationRequested,...(questionOnly&&before.draft?{read_only_plan:{title:before.draft.title,route:before.draft.route,cards:before.draft.cards.map(c=>({id:c.id,label:c.label,place:c.place,title:c.title}))}}:{}),current:{...context.current,requirements:next.requirements,preferences:{...context.current.preferences,...patch.preferences},travel:{...context.current.travel,...patch.travel},constraints:{...context.current.constraints,...patch.constraints}},route:draft?.route || [next.routing.origin,next.routing.destination]}},{before:before.draft,cardIds:localScope});
      if(evidenceResult.status==='unavailable')throw Error('结论证据核对未完成：'+evidenceResult.reason);
      if(evidenceResult.repair_scope)trace('delivery_repair','completed',evidenceResult.repair_scope);
      raw.reply=evidenceResult.reply;
      const mapPlaces=draft?.map_places;
      draft=evidenceResult.draft?cleanDraft(evidenceResult.draft,draft):null;
      if(draft && mapPlaces)draft.map_places=mapPlaces.filter(p=>draft.route.includes(p.name));
      let checkedNumbers=checkNumbers({reply:raw.reply,draft});
      if(checkedNumbers.rejected.length){
        const repaired=await repairNumericFields({reply:raw.reply,draft},{...context.current,requirements:next.requirements});
        if(!checkNumbers(repaired).rejected.length){
          const rechecked=await groundScopedConversationOutput({reply:repaired.reply,draft:repaired.draft,catalog:context.evidence_catalog,model,signal,budgetChars:deps.contextBudgetChars,deliveryMode:!!repaired.draft,remainingMs:()=>deadlineAt-Date.now(),
            conditions:{text:context.text,verification_requested:verificationRequested,...(questionOnly&&before.draft?{read_only_plan:{title:before.draft.title,route:before.draft.route,cards:before.draft.cards.map(c=>({id:c.id,label:c.label,place:c.place,title:c.title}))}}:{}),current:{...context.current,requirements:next.requirements},route:repaired.draft?.route}},{before:before.draft,cardIds:localScope});
          if(rechecked.status!=='unavailable'){evidenceResult=rechecked;raw.reply=rechecked.reply;draft=rechecked.draft?cleanDraft(rechecked.draft,draft):null;if(draft && mapPlaces)draft.map_places=mapPlaces.filter(p=>draft.route.includes(p.name));}
        }
        checkedNumbers=checkNumbers({reply:raw.reply,draft});
      }
      if(checkedNumbers.rejected.length)throw Error('证据核对后出现无依据数字');
      sources=evidenceResult.sources.concat(checkedNumbers.grounded.map(f=>sources.find(s=>s.url===f.source_url)).filter(Boolean))
        .filter((s,i,a)=>a.findIndex(x=>x.url===s.url)===i).slice(0,8);
    }
    if(action==='generate' && draft && evidenceResult && ['complete','partial'].includes(evidenceResult.status)){
      const safeValidation=checkTravelDelivery({draft,requirements:next.requirements,routing:next.routing,numeric:checkNumbers({draft}),evidence:evidenceResult,requireEvidence:true,requireDaily:true,quality:{status:'unreviewed',issues:[]},confirmedOutline:allocationOutline,stayLocks});
      if(safeValidation.valid)await deps.onCheckpoint?.({stage:'facts_checked',draft,safe_delivery:{conversation:{...next,draft:{...draft,quality_status:'unreviewed'},stage:'draft',revision:before.revision+1,preview:null},patch,sources,delivery_validation:safeValidation,evidence_claims:evidenceResult.claims || []}});
    }
    let itineraryQuality=lightResult;
    if(draft?.cards?.length && !lightDelivery){
      const qualityModel=opts=>{const remaining=deadlineAt-Date.now();if(usage.model_calls>=modelCapacity || remaining<=1000)throw Object.assign(Error('完整性复核尚未完成'),{code:'QUALITY_DEFERRED'});return model({...opts,timeoutMs:Math.min(opts.timeoutMs || 15000,remaining-500)});};
      itineraryQuality=await ensureItineraryQuality({draft,current:{...targetCurrent,brief:next.brief,routing:next.routing,text:context.text,confirmed_outline:generationOutline},model:qualityModel,
        catalog:context.evidence_catalog,getCatalog:()=>qualityCatalog || context.evidence_catalog,budgetChars:deps.contextBudgetChars,
        semantic:!deps.model || deps.semanticReview===true,signal,onTrace:e=>trace(e.stage,e.status,e),
        canCall:n=>!signal.aborted && usage.model_calls+n<=modelCapacity && deadlineAt-Date.now()>1000,
        verify:async(candidate,scope)=>{
          if(localScope.length && changedDays(preserveOutsideScope(before.draft,candidate,localScope),candidate).length)return {accepted:false};
          if(context.readonly_scope?.some(id=>changedDays(before.draft,candidate).includes(id)))return {accepted:false};
          const structural=checkTravelDelivery({draft:candidate,requirements:next.requirements,routing:next.routing,numeric:checkNumbers({draft:candidate}),requireDaily:action==='generate',confirmedOutline:allocationOutline,stayLocks});
          if(!structural.passed)return {accepted:false};
          if(!evidenceReview)return {accepted:true,evidence:{claims:[],sources:[],inferences:[]}};
          const reference=scope.baseline || draft,overviewChanged=scope.summary && candidate.overview!==reference.overview;
          const sectionIndexes=scope.summary?candidate.sections.map((s,i)=>s.title!==reference.sections[i]?.title||s.content!==reference.sections[i]?.content?i:-1).filter(i=>i>=0):[];
          const delta={...candidate,overview:overviewChanged?candidate.overview:'',cards:candidate.cards.filter(c=>scope.card_ids.includes(c.id) && reference.cards.some(old=>old.id===c.id && (old.title!==c.title || old.content!==c.content))).map(c=>scope.title_only?{...c,content:''}:c),sections:sectionIndexes.map(i=>candidate.sections[i]),pending:[]};
          const checked=await groundConversationOutput({reply:'',draft:delta,catalog:scope.catalog,model:qualityModel,signal,budgetChars:deps.contextBudgetChars,allowRepair:true,repairScope:'fields',deliveryMode:true,remainingMs:()=>deadlineAt-Date.now(),
            conditions:{text:context.text,current:targetCurrent,route:candidate.route}});
          if(!['complete','partial'].includes(checked.status) || !checked.draft || checked.draft.cards.length!==delta.cards.length || checked.draft.sections.length!==delta.sections.length)return {accepted:false};
          const safe=structuredClone(candidate);
          for(let i=0;i<delta.cards.length;i++){
            const card=checked.draft.cards[i];if(card.id!==delta.cards[i].id || (scope.title_only?!card.title.trim():!card.content.trim()))return {accepted:false};
            const at=safe.cards.findIndex(c=>c.id===card.id);safe.cards[at]={...safe.cards[at],title:card.title || draft.cards.find(c=>c.id===card.id).title,content:scope.title_only?safe.cards[at].content:card.content};
          }
          if(scope.summary){if(overviewChanged)safe.overview=checked.draft.overview || candidate.route.join(' → ');
            const indexes=sectionIndexes;
            for(let i=0;i<indexes.length;i++){if(!checked.draft.sections[i].content.trim())return {accepted:false};safe.sections[indexes[i]]={...safe.sections[indexes[i]],content:checked.draft.sections[i].content};}
          }
          if(checkNumbers({draft:safe}).rejected.length)return {accepted:false};
          return {accepted:true,draft:safe,evidence:checked};
        }});
      draft=cleanDraft(itineraryQuality.draft,draft);
      if(itineraryQuality.verification?.evidence){
        const delta=itineraryQuality.verification.evidence,rendered=evidenceFields(raw.reply,draft,{includePending:false}).map(f=>f.text).join('\n');
        const claims=(evidenceResult?.claims || []).filter(c=>rendered.includes(c.sentence)).concat(delta.claims || []).filter((c,i,a)=>a.findIndex(x=>x.sentence===c.sentence)===i);
        const needed=new Set(claims.flatMap(c=>(c.supports || []).map(s=>s.source_id)));
        sources=sources.concat(delta.sources || []).filter((s,i,a)=>needed.has(s.id) && a.findIndex(x=>x.id===s.id)===i);
        evidenceResult={...evidenceResult,draft,claims,sources,inferences:(evidenceResult?.inferences || []).concat(delta.inferences || [])};
      }
    }
    runtime.assertActive(signal);
    if(!interactionFirst && draft && targetCurrent.travel?.trip_type!=='round_trip' && !targetCurrent.travel?.return_window && !input.anchors?.return && (await unconfirmedReturnFields(draft,next.routing,model)).length)throw Error('最终概览重新引入未授权返程，原稿保留');
    if(draft && localScope.length && changedDays(preserveOutsideScope(before.draft,draft,localScope),draft).length)throw Error('局部修复超出授权日期，原稿保留');
    if(draft && context.readonly_scope?.some(id=>changedDays(before.draft,draft).includes(id)))throw Error('修改触及用户明确保留的日期，原稿保留');
    // 事实删句或质量修复可能改变路线，不能沿用优化前的交通结论。
    if(planningResult && draft && changedDays(planningResult.draft,draft).length){
      const fresh=await evaluatePlan(planWorkspace(draft,targetCurrent),draft,{runtime,signal,resolve:resolvePlanningPlaces,query:deps.queryPlanningRoute,scope:localScope.length?localScope:null,now:deps.now || Date.now()});
      planningResult.assessment={mobility:fresh.mobility,schedule:'unknown',dated_transport:'unknown',coverage:fresh.coverage,days:fresh.days.map(d=>({day_id:d.day_id,mobility:d.mobility,schedule:d.schedule,gaps:d.gaps}))};
    }
    const deliveryValidation=checkTravelDelivery({draft,requirements:next.requirements,routing:next.routing,numeric:interactionFirst?null:checkNumbers({reply:raw.reply,draft}),evidence:evidenceResult,requireEvidence:evidenceReview && !lightDelivery,requireDaily:action==='generate',quality:itineraryQuality,confirmedOutline:allocationOutline,stayLocks});
    const contract=taskContract({revision:before.revision,operation:raw.intent_action || action,conditions:targetCurrent,scope:localScope,
      verifyMobility:verificationRequested && /公交|交通|走完|衔接|车程/.test(context.text)});
    if(lightDelivery){contract.required_dimensions=contract.required_dimensions.filter(d=>d!=='grounding');deliveryValidation.review_mode=interactionFirst?'final':'light';}
    const assessment=assessDelivery(contract,{content:deliveryValidation.passed,grounding:!lightDelivery && deliveryValidation.valid,...(planningResult?.assessment || {})});
    if(localScope.length)deliveryValidation.verification_scope={card_ids:localScope,unchanged:'preserved_not_reverified'};
    if(draft || mobilityQuestion){deliveryValidation.assessment=assessment;deliveryValidation.passed &&= assessment.passed;}
    trace('delivery_contract',deliveryValidation.passed?'passed':'failed',{checks:deliveryValidation.checks});
    if(!interactionFirst && !deliveryValidation.valid)throw Error('最终交付合同未通过：'+deliveryValidation.checks.filter(c=>c.status==='failed').map(c=>c.name).join(','));
    const preferenceWrite=await preferenceMemoryResult(raw);
    runtime.assertActive(signal);
    if(draft){
      await deps.onCheckpoint?.({stage:'validated',draft,conditions:targetCurrent});
      if(itineraryQuality)draft.quality_status=itineraryQuality.status==='passed'?'complete':itineraryQuality.status==='unreviewed'?'unreviewed':'partial';
      const qualityNotes=itineraryQuality?.status==='passed'?[]:(itineraryQuality?.issues || []).map(i=>'日程完整性：'+i.card_ids.map(id=>draft.cards.find(c=>c.id===id)?.label).filter(Boolean).join('、')+' '+i.reason);
      if(itineraryQuality?.status==='unreviewed')qualityNotes.push('日程完整性：最终一致性复核尚未完成');
      draft.pending=[...new Set(qualityNotes.concat(draft.pending.filter(p=>!p.startsWith('日程完整性：'))))].slice(0,10);
      const gaps=activityContentGaps(draft);
      trace('activity_coverage','completed',{gaps});
      if(!interactionFirst && gaps.length)draft.pending=[...new Set(draft.pending.concat(gaps.map(g=>g.label+'：补充具体地点与玩法')))].slice(0,10);
    }
    if(draft?.cards.length && planningEnabled){
      await deps.onCheckpoint?.({stage:'validated',draft,conditions:targetCurrent,safe_delivery:action==='generate'?{
        conversation:{...next,draft,stage:'draft',revision:before.revision+1,preview:null},patch,sources,
        delivery_validation:deliveryValidation,evidence_claims:evidenceResult?.claims || []}:null});
      planningResult=await runPlanningLoop({draft,conditions:{...targetCurrent,brief:next.brief},scope:localScope.length?localScope:null,
        model:interactionFirst || lockedInputs?null:optionalPlanningModel,runtime,signal,resolve:resolvePlanningPlaces,query:deps.queryPlanningRoute,now:deps.now || Date.now(),onTrace:deps.onTrace});
      // 仅接受既有活动块的排列；正文事实不增删。固定先后、团行程与跨日描述拒绝重排。
      draft=planningResult.draft;
      const finalAssessment=assessDelivery(contract,{content:deliveryValidation.passed,grounding:!lightDelivery && deliveryValidation.valid,...planningResult.assessment});
      deliveryValidation.assessment=finalAssessment;deliveryValidation.passed &&= finalAssessment.passed;
    }
    if(action==='chat' && raw.intent_action==='preview' && !changedDestination){
      /* M02：预览内的记忆增量随采纳一起提交、丢弃一起删除——候选挂 preview，此处不提交 */
      return {status:'ok',engine:'llm',task_status:deliveryValidation.passed?'previewed':'partial',delivery_quality:itineraryQuality?{status:itineraryQuality.status,issues:itineraryQuality.issues,repair:itineraryQuality.repair || null}:null,delivery_validation:deliveryValidation,reply:deliveryValidation.passed?'先看看这个备选思路，当前条件与安排保持不变。'+str(raw.reply):'备选初稿已保留，部分日程还需要完善；当前安排未改变。',conversation:{...before,summaries:workingSummaries,preview:{kind:draft?'draft':'conditions',draft,brief:next.brief,patch,transport_choices:transportChoices,requirements:next.requirements,base_revision:before.revision,base_signature:conditionSignature(input),selected_candidate_id:selected?.id || null,memory_candidates:memoryCandidates.accepted,memory_evidence_refs:[...new Set(memoryCandidates.accepted.flatMap(c=>c.evidence_refs))]}},
        patch:cleanPatch(),sources,historical_sources:historicalSources,evidence_claims:evidenceResult?.claims || [],evidence_inferences:evidenceResult?.inferences || [],evidence_gaps:evidenceResult?.gaps || [],numeric_grounding:checkNumbers({reply:raw.reply,draft}).grounded,request_generation:false,selected_candidate_id:null,
        preference_memory_upserts:preferenceWrite.upserts,preference_memory_context:preferenceWrite.context,preference_memory_notice:preferenceWrite.notice};
    }
    if (action === 'generate' || (before.draft && draft && !changedDestination)) {
      next.draft = draft; next.revision = before.revision + 1; next.stage = 'draft';
      next.preview = null;
    } else {
      /* 意图已可读且地点明确，就让用户决定何时生成，避免模型无限追问。 */
      next.stage = before.draft && !changedDestination ? 'draft' : next.routing.origin && next.routing.destination && next.brief.summary ? 'ready' : 'discuss';
      if (changedDestination) {next.draft = null;next.preview=null;}
    }
    const requestGeneration=action === 'chat' && !!next.discussion.authorization && (before.stage === 'ready' || (!!before.brief.summary && messages.some(m=>m.role==='assistant'))) && (raw.confirmed === true || raw.intent_action==='confirm') && next.stage === 'ready';
    const clarifyTripScope=action==='chat' && !before.draft && !searchAction && !confirming && !questionOnly && next.routing.origin && next.routing.destination && next.requirements.trip_days && (!retrievalTravel.trip_type || retrievalTravel.trip_type==='pending');
    if(clarifyTripScope)next.brief.open_questions=['全程天数是否包含往返'];
    const discoveryReady=action==='chat' && !questionOnly && !next.draft && next.stage==='ready';
    next.memory=commitMemoryDecisions(before.memory,memoryCandidates.accepted,{baseRevision:next.revision,now:deps.now || Date.now()});
    /* M2：偏好候选白名单校验后交前端本机存储持久化（服务端不保存偏好）；未开启记忆全丢弃 */
    const baseReply=draft && !deliveryValidation.passed?(contract.required_dimensions.includes('dated_transport')?'初稿已保留，跨境交通的出行日期与运营资料仍需核实。':(englishRequest(input)?'Your draft is preserved; some parts still need review.':'初稿已保留，部分日程还需要完善。')):requestGeneration?'按已确认的条件整理行程。':clarifyTripScope?'这'+next.requirements.trip_days+'天包含从'+next.routing.origin+'出发和返回的时间吗？':next.stage==='discuss' && (raw.confirmed===true || raw.intent_action==='confirm') ? routeResult.question || '这份想法已经保留，先明确本次出发地和首个抵达城市。' : str(raw.reply);
    const priorAllocation=before.draft?allocationReview(before.draft,allocationOutline,stayLocks).changes:[];
    const allocationNotice=draft && JSON.stringify(priorAllocation)!==JSON.stringify(deliveryValidation.allocation_changes)?allocationMessage(deliveryValidation.allocation_changes,{accepted:deliveryValidation.passed,en:englishRequest(input)}):'';
    const unconfirmedReply=(questionOnly && (context.research_failure || explicitResearch && ['unavailable','partial'].includes(context.source_relevance?.status))?'这次资料查询或相关性核对未完成。\n\n'+baseReply:baseReply)+(allocationNotice?'\n\n'+allocationNotice:'');
    const finalReply=preferenceReplyReceipt(unconfirmedReply+(interactionFirst && itineraryQuality?.notice && !unconfirmedReply.includes(itineraryQuality.notice)?'\n\n'+itineraryQuality.notice:''),{text:context.text,enabled:recalledPreferences.enabled});
    const finalGrounding=checkNumbers({reply:finalReply,draft}).grounded;
    const finalEvidenceText=evidenceFields(finalReply,draft,{includePending:false}).map(f=>f.text).join('\n');
    const finalClaims=(evidenceResult?.claims || []).filter(c=>finalEvidenceText.includes(c.sentence));
    const finalSourceIds=new Set(finalClaims.flatMap(c=>(c.supports || []).map(s=>s.source_id)));
    const finalSources=evidenceReview && !lightDelivery?sources.filter(s=>finalSourceIds.has(s.id) || finalGrounding.some(f=>f.source_url===s.url)):sources;
    return { status:'ok', engine:'llm',delivery_quality:itineraryQuality?{status:itineraryQuality.status,issues:itineraryQuality.issues,repair:itineraryQuality.repair || null}:null,delivery_validation:deliveryValidation, task_status:(!interactionFirst || questionOnly) && context.research_failure || !deliveryValidation.passed?'partial':questionOnly?(raw.answer_resolution==='answered' && (interactionFirst || evidenceResult?.status==='complete' && evidenceResult.claims?.length)?'answered':'discussed'):draft?'delivered':'discussed',source_relevance:context.source_relevance || null, evidence_claims:finalClaims, evidence_inferences:(evidenceResult?.inferences || []).filter(t=>finalEvidenceText.includes(t)), evidence_gaps:evidenceResult?.gaps || [], numeric_grounding:finalGrounding, preference_memory_upserts:preferenceWrite.upserts, preference_memory_context:preferenceWrite.context,preference_memory_notice:preferenceWrite.notice, reply:finalReply, conversation:next, patch, sources:finalSources,historical_sources:historicalSources,
      selected_candidate_id: !questionOnly && next.draft && selected ? selected.id : null,
      clear_selection:!questionOnly && !!draft?.route.length && !selected && !!input.candidate_id && !workspace.matches(draft.route,(plan?.candidates || []).find(c=>c.id===input.candidate_id)),
      request_generation:requestGeneration,request_route_discovery:action==='chat' && raw.route_discovery===true && !requestGeneration && next.stage==='ready' };
  } catch (error) {
    trace('conversation','failed',{reason_code:error.code || 'conversation_invalid',detail:error.message});
    if(!deps.model)console.warn('对话未完成：'+error.message);
    const phaseMessage=error.code==='TRANSPORT_REVISION'?error.message:/locked_stays/.test(error.message)?'本次安排未满足你明确指定的停留天数，原方案已保留，可以重试。':/草案路线|城市方案|必经城市/.test(error.message)?'日程与已确认路线不一致，本次未采用；已选方案仍保留，可以重试编排。':/事实核对|证据|数值/.test(error.message)?'本次内容核对尚未通过，已确认的想法和方案仍保留，可以重试。':null;
    const temporaryMessage=lastModelFailure?.reason_code==='rate_limited'?'模型暂时限流，本轮未完成，原输入与方案已保留；请稍后重试。':['service_unavailable','request_timeout','timeout','network_or_timeout','temporary_request'].includes(lastModelFailure?.reason_code)?'模型服务暂时不可用，原输入与方案已保留；请稍后重试。':null;
    return { status:'unavailable', engine:'unavailable', retry_after_ms:lastModelFailure?.retry_after_ms ?? null,provider_error_code:lastModelFailure?.provider_error_code || null,reply:permanentModelFailure?'模型服务暂时拒绝请求，原输入与安排已保留；服务恢复后可继续。':error.code==='CONTEXT_BUDGET_EXCEEDED'?'当前条件与草案较长，本轮未能完整处理，原输入和安排已保留。':temporaryMessage || phaseMessage || 'AI 暂时没有完成回复，你的想法和原方案已保留。请再试一次。', conversation:before };
  }
}
