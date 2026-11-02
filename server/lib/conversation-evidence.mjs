import {agentPrompt,AGENT_RULES_VERSION} from './agent-prompts.mjs';
/* 最终答复与草案共用证据目录；所有句子由模型逐项分类，证据支持另行核对。 */
import {buildContext} from './context-builder.mjs';
import {assessEvidenceClaims,operationalAssertions,validateEvidenceClaims,isPendingChecklist} from './evidence-grounding.mjs';
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
import {evidenceSpans,resolveEvidenceAtoms,planningEvidenceUse,isKnownRoutePlan} from './evidence-spans.mjs';

const sentences=text=>String(text || '').split(/(?<=[。！？!?；;\n])/).map(s=>s.trim()).filter(Boolean);
const assertedTravelFact=text=>/(?:公交|班车|火车|航班|地铁|景区|接驳|门票|住宿).{0,30}(?:比较轻松|方便|通常|必须|直达|开放)|(?:通常|一般|必须).{0,40}(?:中转|接驳|公交|班车|景区)/.test(text);
// 待查清单的范围从句首开始，不能让句尾一个“待查”覆盖前面的肯定事实。
const pendingOnly=isPendingChecklist;
const unavailableContent=(text,catalog)=>!catalog?.entries?.length &&
  (/^(?:目前|本轮|这轮|当前)?(?:尚无|没有)(?:可核对|可引用|足够)(?:的)?(?:公开)?(?:资料|来源)/.test(text) ||
   /^(?:现有|本轮|当前)(?:的)?(?:资料|证据|来源)(?:仍)?不足以(?:核实|支持|确认|给出)/.test(text)) &&
  !/但是|然而|不过|可是|但|却|已确认|已确定|保证|肯定|必定/.test(text) && !operationalAssertions(text).length;
export function evidenceFields(reply,draft,{includePending=true}={}){
  const fields=[];
  const add=(path,text)=>sentences(text).forEach((sentence,index)=>fields.push({id:path+'#'+index,path,text:sentence}));
  add('reply',reply);
  if(draft){
    add('draft.overview',draft.overview);
    (draft.cards || []).forEach((card,i)=>{add('draft.cards['+i+'].title',card.title);add('draft.cards['+i+'].content',card.content);});
    (draft.sections || []).forEach((section,i)=>{add('draft.sections['+i+'].title',section.title);add('draft.sections['+i+'].content',section.content);});
    if(includePending)(draft.pending || []).forEach((value,i)=>add('draft.pending['+i+']',value));
  }
  return fields;
}
const unavailable=reason=>({status:'unavailable',reason,reply:null,draft:null,claims:[],sources:[]});
// 编辑已有文档时，只为新增／改动范围登记本轮事实。未改正文保留，不给旧事实续期。
export async function groundScopedConversationOutput(options,{before,cardIds=[]}={}){
 const full=options.draft;
 if(!full || !before || !cardIds.length)return groundConversationOutput(options);
 const indexes=full.sections.map((s,i)=>s.title!==before.sections[i]?.title||s.content!==before.sections[i]?.content?i:-1).filter(i=>i>=0);
 const overviewChanged=full.overview!==before.overview;
 const delta={...full,overview:overviewChanged?full.overview:'',cards:full.cards.filter(c=>cardIds.includes(c.id)),sections:indexes.map(i=>full.sections[i]),pending:[]};
 const result=await groundConversationOutput({...options,draft:delta});
 if(result.status==='unavailable')return result;
 if(!result.draft || result.draft.cards.length!==delta.cards.length || result.draft.cards.some((c,i)=>c.id!==delta.cards[i].id) || result.draft.sections.length!==indexes.length)return unavailable('local_evidence_shape');
 const merged=structuredClone(full);
 for(const c of result.draft.cards){const at=merged.cards.findIndex(x=>x.id===c.id);merged.cards[at]={...merged.cards[at],title:c.title,content:c.content};}
 if(overviewChanged)merged.overview=result.draft.overview;
 for(let i=0;i<indexes.length;i++)merged.sections[indexes[i]]=result.draft.sections[i];
 return {...result,draft:merged,verification_scope:{card_ids:cardIds,unchanged:'preserved_not_reverified'}};
}
/** 不调用搜索；模型失败或上下文不足时由主编排保留原草案并提示重试。 */
export async function groundConversationOutput({reply,draft,catalog,model,signal,budgetChars,conditions=null,allowRepair=true,repairScope='all',deliveryMode=false,remainingMs=()=>Infinity}={}){
  if(deliveryMode && draft)catalog={...catalog,delivery_context:'suggested_itinerary'};
  const planningMode=catalog?.delivery_context==='suggested_itinerary';
  if(planningMode && draft)draft=workspace.presentDraft(draft);
  const fields=evidenceFields(reply,draft,{includePending:!planningMode});
  if(signal?.aborted)return unavailable('cancelled');
  if(!fields.length)return {status:'complete',reply,draft,claims:[],sources:[],gaps:[],visible_catalog:catalog};
  const schema_prompt=agentPrompt(planningMode?'evidence.itinerary':'evidence.extract');
  let extracted;
  try{
    const batches=[],items=[];
    let visibleCatalog=null;
    const extractionCatalog=planningMode?{...catalog,entries:catalog.entries.map(e=>({id:e.id,title:e.title,excerpt:e.excerpt,kind:e.kind,allowed_use:e.allowed_use}))}:catalog;
    const prepareGroup=group=>{
      try{
        const built=buildContext({payload:{fields:planningMode?group.map(f=>({...f,assertion_spans:evidenceSpans(f)})):group,evidence_catalog:extractionCatalog,
          ...(planningMode?{source_refs:catalog.entries.map(e=>({source_id:e.id}))}:{}),
          output_use:planningMode?'proposed_itinerary':'factual_answer',planning_conditions:conditions},coreRules:schema_prompt,rulesVersion:AGENT_RULES_VERSION,budgetChars});
        const view=built.value.evidence_catalog;
        if(visibleCatalog && JSON.stringify(view.entries)!==JSON.stringify(visibleCatalog.entries))throw Error('inconsistent_catalog');
        visibleCatalog=view;batches.push({group,built});
      }catch(error){
        if(error.code!=='CONTEXT_BUDGET_EXCEEDED' || group.length<2)throw error;
        const middle=Math.ceil(group.length/2);prepareGroup(group.slice(0,middle));prepareGroup(group.slice(middle));
      }
    };
    const batchSize=24;
    for(let i=0;i<fields.length;i+=batchSize)prepareGroup(fields.slice(i,i+batchSize));
    for(let i=0;i<batches.length;i+=2){
      const results=await Promise.all(batches.slice(i,i+2).map(async({group,built})=>{
        let failure=null;
        const request={kind:'conversation_evidence_extract',schema_prompt,user:JSON.stringify(built.value),timeoutMs:planningMode?25000:15000,signal,onFailure:value=>{failure=value;}};
        let result=await model(request);
        if(result==null && failure?.retryable===true && !failure.retry_handled && !signal?.aborted && remainingMs()>request.timeoutMs+15000)result=await model(request);
        if(Array.isArray(result?.items))result={...result,items:result.items.map(item=>{const field=group.find(f=>f.id===item?.id);return field?resolveEvidenceAtoms(item,field):item;})};
        return result;
      }));
      if(results.some(r=>!Array.isArray(r?.items)))return unavailable('extract_failed');
      items.push(...results.flatMap(r=>r.items).map(item=>planningMode && item.text===undefined?{...item,text:fields.find(f=>f.id===item.id)?.text}:item));
    }
    if(visibleCatalog)catalog={...catalog,entries:visibleCatalog.entries.map(e=>({...catalog.entries.find(original=>original.id===e.id),...e}))};
    extracted={items};
  }catch(error){return unavailable(signal?.aborted?'cancelled':error.code==='CONTEXT_BUDGET_EXCEEDED'?'extract_context_limit':error.message==='inconsistent_catalog'?'extract_catalog_mismatch':'extract_failed');}
  if(signal?.aborted)return unavailable('cancelled');
  if(!Array.isArray(extracted?.items))return unavailable('extract_failed');
  const byId=new Map();for(const item of extracted.items){const items=byId.get(item?.id)||[];items.push(item);byId.set(item?.id,items);}
  if(fields.some(field=>byId.get(field.id)?.length!==1 || byId.get(field.id)[0].text!==field.text || typeof byId.get(field.id)[0].needs_source!=='boolean' || byId.get(field.id)[0].assertions!=null&&!Array.isArray(byId.get(field.id)[0].assertions)) || extracted.items.length!==fields.length)return unavailable('invalid_extraction');
  const claims=[],inferences=[],seen=new Set(),origins=new Map(),invalidFields=new Set();
  for(const field of fields){const item=byId.get(field.id)[0];
    if(pendingOnly(field.text) || unavailableContent(field.text,catalog))continue;
    if(planningMode && Array.isArray(item.assertions) && item.assertions.length && !operationalAssertions(field.text).length && !assertedTravelFact(field.text)){
      if(item.assertions.length>8 || item.assertions.some(a=>typeof a?.text!=='string' || !a.text.trim() || !field.text.includes(a.text) || !Array.isArray(a.supports))){invalidFields.add(field.text);continue;}
      for(const atom of item.assertions){
        if(isKnownRoutePlan(atom.text,conditions || {}))continue;
        const parents=origins.get(atom.text) || new Set();parents.add(field.text);origins.set(atom.text,parents);
        if(!seen.has(atom.text)){seen.add(atom.text);claims.push(planningEvidenceUse({text:atom.text,allowed_use:atom.allowed_use,evidence_relation:atom.evidence_relation,supports:atom.supports},catalog));}
      }
      continue;
    }
    if(item.allowed_use==='inference' && (!item.supports || !item.supports.length) && !operationalAssertions(field.text).length && !assertedTravelFact(field.text) && /核心取舍|建议|可以先|可以考虑|探索方向|作为候选|优先比较|如果|若(?:能|有|可|无法)|假设/.test(field.text)){
      inferences.push(field.text);continue;
    }
    if(!item.needs_source && !operationalAssertions(field.text).length && !assertedTravelFact(field.text))continue;
    if(seen.has(field.text))continue;seen.add(field.text);
    const atomSupports=planningMode && Array.isArray(item.assertions)?item.assertions.flatMap(a=>Array.isArray(a?.supports)?a.supports:[]):[];
    const supports=Array.isArray(item.supports)?item.supports:atomSupports.filter((s,i,a)=>a.findIndex(x=>x.source_id===s.source_id&&x.quote===s.quote)===i);
    const rejectedRelation=(Array.isArray(item.assertions)?item.assertions:[]).find(a=>['missing','refuted'].includes(a?.evidence_relation))?.evidence_relation;
    claims.push(planningEvidenceUse({text:field.text,allowed_use:item.allowed_use || (planningMode?'source_reference':undefined),evidence_relation:item.evidence_relation || rejectedRelation,supports},catalog));
  }
  const body=[...new Set(fields.map(f=>f.text).concat([...origins.keys()]))].join('\n');
  for(const claim of claims){const parents=origins.get(claim.text);if(parents && ![...parents].every(text=>[...text.matchAll(/`([^`]+)`/g)].some(m=>m[1]===claim.text)))claim.contexts=[...parents];}
  const assessment=await assessEvidenceClaims(body,catalog,claims,model,{signal,budgetChars});
  if(signal?.aborted)return unavailable('cancelled');
  if(assessment.status==='unavailable')return unavailable(assessment.reason || 'assessment_failed');
  const result=validateEvidenceClaims(body,catalog,{claims,assessment});
  const rejected=[...new Set([...invalidFields,...result.rejected.flatMap(r=>origins.has(r.sentence)?[...origins.get(r.sentence)]:[r.sentence])])];
  if(deliveryMode && draft){
    const visible=fields.filter(f=>!f.path.startsWith('draft.pending'));
    const diagnostic=/待查|待考证|待核实|待确认|未核实|尚未确认|尚未验证|无法确认|不能确认|不支持|不确定|尚不能证明|资料不足|来源不足/;
    const paths=[...new Set(visible.filter(f=>rejected.includes(f.text) || diagnostic.test(f.text)).map(f=>f.path))];
    if(allowRepair && paths.length){
      // 小范围错误只修受影响字段，重新审核对应卡片；未改活动沿用本轮已通过的核对。
      const keys=path=>path.replace(/\[(\d+)\]/g,'.$1').split('.');
      const get=(value,path)=>keys(path).reduce((v,k)=>v?.[k],value);
      try{
        const units=visible.filter(f=>rejected.includes(f.text) || diagnostic.test(f.text));
        const belongs=(claim,field)=>claim.sentence===field.text || origins.get(claim.sentence)?.has(field.text);
        const repairFields=units.map(f=>{
          const siblings=visible.filter(v=>v.path===f.path),i=siblings.findIndex(v=>v.id===f.id);
          const supported=result.grounded.filter(c=>belongs(c,f));
          const rejectedAtoms=result.rejected.filter(c=>belongs(c,f));
          const protectedPlaces=[...f.text.matchAll(/`([^`\n]{1,80})`/g)].map(m=>m[1]).filter(name=>supported.some(c=>c.sentence.includes(name)));
          return {path:f.id,text:f.text,protected_places:[...new Set(protectedPlaces)],
            supported_assertions:supported.map(c=>({text:c.sentence,allowed_use:c.allowed_use,supports:c.supports})),
            rejected_assertions:rejectedAtoms.map(c=>({text:c.sentence,reason:c.reason || '缺少完整支持'})),
            adjacent_readonly:{before:siblings.slice(Math.max(0,i-2),i).map(v=>v.text),after:siblings.slice(i+1,i+3).map(v=>v.text)}};
        });
        const base={reply,draft},fix={fields:[]},schema=agentPrompt('conversation.delivery_patch')+'\n'+agentPrompt('conversation.delivery'),requests=[];
        const compactCatalog={...catalog,entries:catalog.entries.map(e=>({id:e.id,title:e.title,excerpt:e.excerpt,kind:e.kind,allowed_use:e.allowed_use}))};
        const preparePatch=fields=>{
          try{const built=buildContext({payload:{conditions,fields,removed_statements:fields.flatMap(f=>f.rejected_assertions.map(a=>a.text)),evidence_catalog:compactCatalog,
            source_refs:catalog.entries.map(e=>({source_id:e.id}))},coreRules:schema,rulesVersion:AGENT_RULES_VERSION,budgetChars});requests.push({fields,user:JSON.stringify(built.value)});}
          catch(error){if(error.code!=='CONTEXT_BUDGET_EXCEEDED'||fields.length<2)throw error;const middle=Math.ceil(fields.length/2);preparePatch(fields.slice(0,middle));preparePatch(fields.slice(middle));}
        };
        for(let i=0;i<repairFields.length;i+=4)preparePatch(repairFields.slice(i,i+4));
        for(let i=0;i<requests.length;i+=2){
          const values=await Promise.all(requests.slice(i,i+2).map(async request=>({request,value:await model({kind:'conversation_delivery_patch',timeoutMs:12000,signal,schema_prompt:schema,user:request.user})})));
          for(const {request,value}of values){
            if(!Array.isArray(value?.fields)||value.fields.length!==request.fields.length||new Set(value.fields.map(f=>f?.path)).size!==value.fields.length)continue;
            for(const field of value.fields){const contract=request.fields.find(f=>f.path===field?.path);
              if(!contract || typeof field.text!=='string'||!field.text.trim()||diagnostic.test(field.text)||field.text.length>(field.path.includes('.title#')?100:400))continue;
              if(contract.protected_places.some(name=>!field.text.includes(name))||contract.rejected_assertions.some(a=>field.text.includes(a.text)))continue;
              fix.fields.push(field);
            }
          }
        }
        if(!fix.fields.length)throw Error('invalid_patch');
        const failedUnits=units.filter(u=>!fix.fields.some(f=>f.path===u.id));
        const next=structuredClone(base);
        for(const unit of failedUnits){const chain=keys(unit.path),leaf=chain.pop(),parent=chain.reduce((v,k)=>v[k],next);parent[leaf]=parent[leaf].replace(unit.text,'').trim();}
        for(const f of fix.fields){const unit=units.find(u=>u.id===f.path),chain=keys(unit.path),leaf=chain.pop(),parent=chain.reduce((v,k)=>v[k],next);parent[leaf]=parent[leaf].replace(unit.text,f.text.trim());}
        const verifiedText=new Set(visible.filter(f=>!rejected.includes(f.text) && !diagnostic.test(f.text)).map(f=>f.text));
        const finalFields=evidenceFields(next.reply,next.draft,{includePending:false});
        const changedText=[...new Set(finalFields.filter(f=>!verifiedText.has(f.text)).map(f=>f.text))].join('\n');
        const checked=changedText?await groundConversationOutput({reply:changedText,catalog,model,signal,budgetChars,conditions,remainingMs,allowRepair:false}):{status:'complete',claims:[],inferences:[]};
        if(!['complete','partial'].includes(checked.status))throw Error('patch_not_grounded');
        // 一句失败不能撤销其他已经核对的补丁，更不能触发整稿再写一遍。
        if(checked.status==='partial'){
          const refused=new Set(checked.gaps || []);
          for(const f of fix.fields){
            const safe=sentences(f.text).filter(sentence=>!refused.has(sentence)).join('\n');
            const unit=units.find(u=>u.id===f.path),chain=keys(unit.path),leaf=chain.pop(),parent=chain.reduce((v,k)=>v[k],next);
            parent[leaf]=parent[leaf].replace(f.text.trim(),safe).trim();
          }
        }
        // 引用合并只保留未改字段的原核对与补丁新核对；不以原结果担保修改后的句子。
        const safeFields=evidenceFields(next.reply,next.draft,{includePending:false}),safeText=new Set(safeFields.map(f=>f.text));
        const unchanged=new Set(safeFields.filter(f=>verifiedText.has(f.text)).map(f=>f.text));
        const retained=result.grounded.flatMap(c=>origins.has(c.sentence)?[...origins.get(c.sentence)].map(sentence=>({...c,sentence})):c).filter(c=>unchanged.has(c.sentence));
        const combined=retained.concat(checked.claims.filter(c=>safeText.has(c.sentence))),needed=new Set(combined.flatMap(c=>c.supports.map(s=>s.source_id)));
        // 保留稳定日卡身份，即使正文已删空也交给质量修复，不能由cleanDraft静默删除日期。
        return {status:checked.status==='complete'&&!failedUnits.length?'complete':'partial',reply:next.reply,draft:next.draft,claims:combined,
          inferences:inferences.filter(s=>unchanged.has(s)).concat(checked.inferences || []),sources:(catalog.entries || []).filter(e=>needed.has(e.id)).map(e=>({...e,temporal:{state:e.temporal_state}})),
          gaps:[...new Set(rejected.concat(checked.gaps || []))],visible_catalog:catalog,repair_scope:{kind:'fields',paths,rejected_sentences:checked.gaps?.length || 0}};
      }catch{/* 局部修复未通过时沿用原有有界交付修复，不发布未经审核的补丁。 */}
    }
    if(allowRepair && repairScope!=='fields' && (rejected.length || draft.cards.some(c=>!c.content.trim()) || visible.some(f=>f.path!=='reply' && diagnostic.test(f.text)))){
      // 一次完整重组后重新核对；不把删句残片或核验清单充作用户攻略。
      try{
        const repaired=await model({kind:'conversation_delivery',timeoutMs:25000,signal,
          schema_prompt:agentPrompt('conversation.compose')+'\n'+agentPrompt('conversation.delivery')+'\n'+agentPrompt('conversation.delivery_repair'),
          user:JSON.stringify({conditions,current:conditions?.current,output_contract:{route_origin:draft.route[0],route_destination:draft.route.at(-1)},structure:{...draft,cards:draft.cards.map(c=>({id:c.id,place:c.place,label:c.label})),overview:'',sections:[],pending:draft.pending},
            verified_fields:visible.filter(f=>!rejected.includes(f.text) && !diagnostic.test(f.text)),
            removed_statements:result.rejected.map(r=>({text:r.sentence,reason:r.reason})).concat([...invalidFields].map(text=>({text,reason:'事实抽取未能提供有效原文片段，不能视作已核对'}))),evidence_catalog:catalog})});
        const value=repaired?.draft?workspace.presentDraft(repaired.draft):null;
        if(repaired && !conditions?.verification_requested)repaired.reply=workspace.presentReply(repaired.reply) || '已整理这份安排，可以继续比较和调整。';
        if(!value || typeof value.title!=='string' || typeof value.overview!=='string' || !Array.isArray(value.sections) || JSON.stringify(value.route)!==JSON.stringify(draft.route) || !Array.isArray(value.cards) || value.cards.length!==draft.cards.length ||
          value.cards.some((c,i)=>c.id!==draft.cards[i].id || c.label!==draft.cards[i].label || c.place!==draft.cards[i].place || typeof c.title!=='string' || typeof c.content!=='string' || !c.title.trim() || !c.content.trim()))return unavailable('delivery_invalid_structure');
        if(evidenceFields(repaired.reply,value).some(f=>f.path!=='reply' && !f.path.startsWith('draft.pending') && diagnostic.test(f.text)))return unavailable('delivery_diagnostic_text');
        const safeText=new Set(visible.filter(f=>!rejected.includes(f.text) && !diagnostic.test(f.text)).map(f=>f.text));
        const finalFields=evidenceFields(repaired.reply,value,{includePending:false});
        const changed=[...new Set(finalFields.filter(f=>!safeText.has(f.text)).map(f=>f.text))].join('\n');
        const checked=changed?await groundConversationOutput({reply:changed,catalog,model,signal,budgetChars,conditions,remainingMs,allowRepair:false}):{status:'complete',claims:[],sources:[],inferences:[]};
        if(checked.status==='unavailable')return unavailable('delivery_check_'+checked.reason);
        // 保留原有“删除无支持整句后仍完整可交付”的边界，不把半句断言留下。
        const strip=text=>{let out=String(text || '');for(const sentence of checked.gaps || [])out=out.replaceAll(sentence,'');return out.trim();};
        if(checked.status!=='complete'){
          repaired.reply=strip(repaired.reply) || '已整理好每日行程，可以继续调整。';value.overview=strip(value.overview);
          value.cards=value.cards.map(c=>({...c,title:strip(c.title) || [c.label,c.place].join(' · '),content:strip(c.content)}));
          value.sections=value.sections.map(s=>({...s,title:strip(s.title),content:strip(s.content)})).filter(s=>s.title&&s.content);
        }
        if(value.cards.some(c=>!c.content.trim()))return unavailable('delivery_not_grounded');
        const afterFields=evidenceFields(repaired.reply,value,{includePending:false}),afterText=new Set(afterFields.map(f=>f.text));
        const retainedText=new Set(afterFields.filter(f=>safeText.has(f.text)).map(f=>f.text));
        const retained=result.grounded.flatMap(c=>origins.has(c.sentence)?[...origins.get(c.sentence)].map(sentence=>({...c,sentence})):c).filter(c=>retainedText.has(c.sentence));
        const combined=retained.concat(checked.claims.filter(c=>afterText.has(c.sentence))),ids=new Set(combined.flatMap(c=>c.supports.map(s=>s.source_id)));
        return {status:checked.status==='complete'?'complete':'partial',reply:repaired.reply,draft:workspace.cleanDraft({...value,pending:draft.pending},draft),claims:combined,
          inferences:inferences.filter(s=>retainedText.has(s)).concat(checked.inferences || []),sources:(catalog.entries || []).filter(e=>ids.has(e.id)).map(e=>({...e,temporal:{state:e.temporal_state}})),
          gaps:rejected,visible_catalog:catalog,repair_scope:{kind:'rewrite_delta',reused_sentences:retainedText.size,checked_sentences:finalFields.length-retainedText.size}};
      }catch{return unavailable('delivery_failed');}
    }
  }
  const replace=(text,title=false)=>{let value=String(text || ''),changed=false;
    for(const sentence of rejected)if(value.includes(sentence)){value=value.replaceAll(sentence,'');changed=true;}
    if(!changed)return value;
    if(title)return planningMode?'':'待核实事项';
    value=value.replace(/\n{3,}/g,'\n\n').trim();
    if(planningMode)return value;
    return value && /待查|待核实|不能确认|尚未确认/.test(value)?value:(value?value+'\n':'')+'相关具体信息仍待核实。';
  };
  const outputDraft=draft?structuredClone(draft):null;
  if(outputDraft){outputDraft.overview=replace(outputDraft.overview);
    outputDraft.cards=outputDraft.cards.map(c=>({...c,title:replace(c.title,true),content:replace(c.content)}));
    outputDraft.sections=outputDraft.sections.map(s=>({...s,title:replace(s.title,true),content:replace(s.content)}));
    outputDraft.pending=outputDraft.pending.map(replace);
  }
  const supported=new Set(result.grounded.flatMap(c=>c.supports.map(s=>s.source_id)));
  const sources=(catalog?.entries || []).filter(e=>supported.has(e.id)).map(e=>({id:e.id,url:e.url,title:e.title,excerpt:e.excerpt,platform:e.platform,kind:e.kind,published_at:e.published_at,date_basis:e.date_basis,read_status:e.read_status,allowed_use:e.allowed_use,temporal:{state:e.temporal_state,label:e.temporal_state==='recent'?'近期资料':'适用范围参考',published_at:e.published_at}}));
  const replyFields=new Set(fields.filter(f=>f.path==='reply').map(f=>f.text));
  const rejectedReply=rejected.filter(s=>replyFields.has(s));
  if(allowRepair && rejectedReply.length && !signal?.aborted){
    // 任何实质删句都可能破坏指代与取舍理由；一次有界重组后完整重验，不以剩余字数判断。
    try{
      const repaired=await model({kind:'conversation_evidence_repair',timeoutMs:12000,signal,
        schema_prompt:agentPrompt('evidence.repair'),
        user:JSON.stringify({text:conditions?.text || '',current:conditions?.current || null,route:conditions?.route || null,
          verified_claims:result.grounded.filter(c=>replyFields.has(c.sentence)),assistant_draft:{unsupported_statements:rejectedReply},
          candidate_sources:catalog?.entries || []})});
      if(typeof repaired?.reply==='string' && repaired.reply.trim() && repaired.reply.length<=2500 &&
        !/(?:已被|被)(?:标记|判定)为(?:不可用|无支持|未支持)|\b(?:candidate_sources|verified_claims|assistant_draft)\b/.test(repaired.reply)){
        const checked=await groundConversationOutput({reply:repaired.reply,catalog,model,signal,budgetChars,conditions,allowRepair:false});
        if(checked.status!=='unavailable' && checked.reply.trim() &&
          (checked.status==='complete' || checked.claims.length || checked.inferences.length || /待查项|需要核实的|你.{0,120}[?？]/.test(checked.reply))){
          const draftSentences=new Set(fields.filter(f=>f.path!=='reply').map(f=>f.text));
          const draftClaims=result.grounded.filter(c=>draftSentences.has(c.sentence));
          const combined=draftClaims.concat(checked.claims).filter((c,i,a)=>a.findIndex(x=>x.sentence===c.sentence)===i);
          const needed=new Set(combined.flatMap(c=>c.supports.map(s=>s.source_id)));
          return {...checked,status:'partial',draft:outputDraft,claims:combined,
            sources:sources.concat(checked.sources).filter((s,i,a)=>needed.has(s.id) && a.findIndex(x=>x.id===s.id)===i),gaps:rejected.concat(checked.gaps || [])};
        }
      }
    }catch{/* 修复失败不发布未经核对的新回复 */}
  }
  // 无法完整重组时，给保留事实补上实际出处主语；不让删掉的前文留下“它/这些”的悬空指代。
  const independent=s=>/^(?:[-*]\s*)?(?:如果|若|假设|可以先|可以考虑|建议|取舍上|就安排|在|以)/.test(s) &&
    !/它们|这些|这两|上述|前者|后者/.test(s) && !/[:：]$/.test(s);
  const chunks=[],rendered=new Set();let previousSources=null,size=0;
  if(rejectedReply.length)for(const field of fields.filter(f=>f.path==='reply')){
    if(rejectedReply.includes(field.text) || rendered.has(field.text))continue;
    const fact=result.grounded.find(c=>c.sentence===field.text);let paragraph=field.text,key=null;
    if(fact){
      key=[...new Set(fact.supports.map(s=>s.source_id))].sort().join('|');
      if(key!==previousSources){
        const hosts=[...new Set(sources.filter(s=>fact.supports.some(r=>r.source_id===s.id)).map(s=>new URL(s.url).hostname.replace(/^www\./,'')))];
        paragraph=/^(它|他们|这些|该)/.test(paragraph)?'资料参考（'+hosts.join('、')+'）：\n'+paragraph:paragraph+'（'+hosts.join('、')+'）';
      }
    }else if(!(inferences.includes(field.text) && independent(field.text) || pendingOnly(field.text) || /^你.{0,120}[?？]$/.test(field.text)))continue;
    // 只删完整段落，不让后续回复长度限制截断结论或引用。
    if(size+paragraph.length+2>1400)continue;
    chunks.push(paragraph);rendered.add(field.text);size+=paragraph.length+2;previousSources=key;
  }
  const fallback=rejectedReply.length?chunks.join('\n\n'):reply;
  const finalReply=planningMode?(rejectedReply.length?fallback:reply):rejectedReply.length?(fallback?fallback+'\n\n':'')+'本轮部分具体判断缺少完整出处，相关信息仍待核实。':reply;
  const displayed=new Set(evidenceFields(finalReply,outputDraft).map(f=>f.text));
  const expanded=result.grounded.flatMap(c=>origins.has(c.sentence)?[...origins.get(c.sentence)].map(sentence=>({...c,sentence})):[c]);
  const finalClaims=expanded.filter(c=>displayed.has(c.sentence) && !rejected.includes(c.sentence)).reduce((all,c)=>{
    const old=all.find(x=>x.sentence===c.sentence);if(old)old.supports.push(...c.supports.filter(s=>!old.supports.some(x=>x.source_id===s.source_id && x.quote===s.quote)));else all.push({...c,supports:[...c.supports]});return all;
  },[]),finalIds=new Set(finalClaims.flatMap(c=>c.supports.map(s=>s.source_id)));
  return {status:rejected.length?'partial':'complete',reply:finalReply,draft:outputDraft,claims:finalClaims,
    inferences:[...new Set(inferences)].filter(s=>displayed.has(s)),sources:sources.filter(s=>finalIds.has(s.id)),gaps:rejected,
    // 供调用方继续校验数字；这是本次抽取实际看到的视图，修复成功时沿用 checked 的更窄视图。
    visible_catalog:catalog};
}
