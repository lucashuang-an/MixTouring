import {qualityReviewPayload,needsQualityBatches,reviewLongItinerary} from './quality-batches.mjs';
/* 最终成稿质量：内部一致性不是外部事实证明；补丁仍须独立过证据与数字校验。 */
import {buildContext} from './context-builder.mjs';
import {AGENT_RULES_VERSION,agentPrompt} from './agent-prompts.mjs';
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
const codes=new Set(['missing_activity','title_mismatch','summary_mismatch','cross_day_conflict','condition_conflict']);
const copy=v=>structuredClone(v);
const issue=(code,ids,reason,quote='')=>({code,card_ids:ids,reason,quote});
const note=/^(提醒|提示|Tips|小贴士|补充|交通说明|注意)[：:]/i;
const logistics=/^(?:返回|回到|返程|抵达|到达|前往机场|去机场|办理|整理行李|收拾行李|确认次日|就近吃饭|早点休息|休息|带好|带足|注意|穿|按航班|视航班|从.{0,20}(?:返回|飞回))/;
export function hollowDayIssues(draft){
  return (draft?.cards || []).flatMap(c=>{
    const title=String(c.title||'').replace(/出发前/g,'准备');
    if(/返程|回程|返回|回到|跨境|抵达|飞回|飞往|离开|交通|出发/.test(title))return [];
    if(/休整|缓冲|自由活动|准备/.test(title) && !/公园|博物馆|湖|峡谷|街区|老城|市场|巴扎|寺|文化|地标/.test(title))return [];
    const lines=String(c.content||'').split(/\n+/).map(s=>s.replace(/^\s*[-*•]\s*/,'').trim()).filter(Boolean).filter(s=>!note.test(s))
      .map(s=>s.replace(/^(?:清晨|早上|上午|中午|下午|傍晚|晚上|全天|途中|抵达后)[：:]\s*/,''));
    if(!lines.length || lines.every(s=>logistics.test(s)))return [issue('missing_activity',[c.id],'活动日只剩交通、休息或提醒',c.title)];
    // 标题承诺了具体类型的体验时，团型介绍／沿途吃饭不能替代该体验；不依赖反引号。
    const promised=[...new Set(title.match(/峡谷|湖|公园|博物馆|海滩|古镇|瀑布|温泉/g)||[])];
    const activityText=lines.filter(s=>!logistics.test(s) && !/^(?:有相关|具体团型|具体安排|以实际|根据团队|视实际)/.test(s)).join('\n');
    return promised.some(topic=>!activityText.includes(topic))?[issue('title_mismatch',[c.id],'正文未落实标题中的主要体验',c.title)]:[];
  });
}
function normalizeReview(raw,draft,neighbors=[]){
  const cards=draft.cards||[],ids=new Set(cards.map(c=>c.id)),issueIds=new Set([...cards,...neighbors].map(c=>c.id));
  if(!raw || !Array.isArray(raw.cards) || raw.cards.length!==cards.length || new Set(raw.cards.map(c=>c?.id)).size!==cards.length ||
    raw.cards.some(c=>!ids.has(c?.id) || !['activity','transport','rest'].includes(c.role) || typeof c.activity_present!=='boolean' || typeof c.title_matches!=='boolean') ||
    typeof raw.summary_matches!=='boolean' || !Array.isArray(raw.issues) || raw.issues.length>24)return null;
  const allText=[draft.overview,...(draft.sections||[]).flatMap(s=>[s.title,s.content]),...[...cards,...neighbors].flatMap(c=>[c.title,c.content])].join('\n');
  if(raw.issues.some(i=>!codes.has(i?.code) || !Array.isArray(i.card_ids) || i.card_ids.some(id=>!issueIds.has(id)) ||
    i.code!=='summary_mismatch' && !i.card_ids.length || typeof i.reason!=='string' || !i.reason.trim() ||
    typeof i.quote!=='string' || !i.quote.trim() || !allText.includes(i.quote)))return null;
  const issues=raw.issues.map(i=>issue(i.code,[...new Set(i.card_ids)],i.reason.slice(0,240),i.quote.slice(0,300)));
  for(const c of raw.cards){
    if(c.role==='activity' && !c.activity_present)issues.push(issue('missing_activity',[c.id],'当天缺少实质活动'));
    if(!c.title_matches)issues.push(issue('title_mismatch',[c.id],'标题承诺与当天内容不一致'));
  }
  if(!raw.summary_matches)issues.push(issue('summary_mismatch',[],'概览与实际逐日安排不一致'));
  return {cards:raw.cards,issues};
}
const unique=issues=>issues.filter((x,i,a)=>a.findIndex(y=>y.code===x.code && JSON.stringify(y.card_ids)===JSON.stringify(x.card_ids))===i);
export async function ensureItineraryQuality({draft,current,model,catalog,getCatalog=()=>catalog,verify,semantic=true,signal,canCall=()=>true,onTrace=()=>{},budgetChars}){
  const original=copy(draft);
  const repairCall=async (kind,rule,payload,timeoutMs)=>{
    const schema_prompt=agentPrompt(rule);
    const {value}=buildContext({payload,coreRules:schema_prompt,rulesVersion:AGENT_RULES_VERSION,budgetChars});
    return model({kind,timeoutMs,schema_prompt,user:JSON.stringify(value)});
  };
  const syncAttempts=new Set();
  async function assess(value,mustHaveActivity=[]){
    const deterministic=hollowDayIssues(value);
    if(!semantic)return {status:deterministic.length?'needs_repair':'passed',issues:deterministic,cards:[]};
    if(!canCall(1))return {status:'unreviewed',issues:deterministic,cards:[]};
    try{
      let checked;
      if(needsQualityBatches(value,current,mustHaveActivity,budgetChars))checked=await reviewLongItinerary({draft:value,current,mustHaveActivity,model,normalizeReview,canCall,signal,onTrace,budgetChars});
      else {
        const raw=await model({kind:'conversation_quality_review',timeoutMs:15000,schema_prompt:agentPrompt('conversation.quality_review'),user:JSON.stringify(qualityReviewPayload(value,current,mustHaveActivity))});
        checked=normalizeReview(raw,value);
      }
      if(signal?.aborted)throw signal.reason;
      if(!checked)return {status:'unreviewed',issues:deterministic,cards:[]};
      for(const id of mustHaveActivity){const card=checked.cards.find(c=>c.id===id);if(card && (card.role!=='activity' || !card.activity_present))checked.issues.push(issue('missing_activity',[id],'不能把缺活动的日期改名为休整来通过检查'));}
      const issues=unique(deterministic.concat(checked.issues));
      return {status:issues.length?'needs_repair':'passed',issues,cards:checked.cards};
    }catch(error){if(signal?.aborted || error.code==='RUN_INTERRUPTED')throw error;return {status:'unreviewed',issues:deterministic,cards:[]};}
  }
  let assessment=await assess(original);
  onTrace({stage:'itinerary_quality',status:assessment.status,issues:assessment.issues});
  const finish=(value,assessment,extra={})=>({draft:value,status:assessment.status,issues:assessment.issues,checked:assessment.status!=='unreviewed',...extra});
  async function syncMetadata(value,assessment,verification,mustHaveActivity){
    const keep=()=>finish(value,assessment,{repair:'applied',verification});
    if(assessment.status!=='needs_repair' || !assessment.issues.length || assessment.issues.some(i=>!['title_mismatch','summary_mismatch'].includes(i.code)) || current?.sights?.selected_ids?.length || !canCall(4))return keep();
    const ids=[...new Set(assessment.issues.flatMap(i=>i.card_ids))],clean=workspace.cleanDraft(value);
    if(ids.some(id=>!clean?.cards.find(c=>c.id===id)?.activities?.some(a=>a.places.length)))return keep();
    if(ids.some(id=>!assessment.cards.some(c=>c.id===id && c.role==='activity' && c.activity_present)))return keep();
    const identity=JSON.stringify([value.cards,value.overview,value.sections]);if(syncAttempts.has(identity))return keep();syncAttempts.add(identity);
    try{
      const raw=await repairCall('conversation_quality_sync','conversation.quality_sync',{current,issues:assessment.issues,targets:value.cards.filter(c=>ids.includes(c.id)).map(c=>({id:c.id,title:c.title})),
          summary_fields:[{path:'overview',text:value.overview},...value.sections.map((s,i)=>({path:'sections.'+i+'.content',text:s.content}))],readonly_cards:value.cards},12000);
      if(signal?.aborted)throw signal.reason;
      if(raw?.blocked===true || !Array.isArray(raw?.titles)||raw.titles.length!==ids.length||new Set(raw.titles.map(c=>c?.id)).size!==ids.length||raw.titles.some(c=>!ids.includes(c.id)||Object.keys(c).some(k=>!['id','title'].includes(k))||typeof c.title!=='string'||!c.title.trim()||c.title.length>100))return keep();
      const allowed=new Set(['overview',...value.sections.map((_,i)=>'sections.'+i+'.content')]),fields=raw.summary_fields || [];
      if(!Array.isArray(fields)||new Set(fields.map(f=>f?.path)).size!==fields.length||fields.some(f=>!allowed.has(f.path)||typeof f.text!=='string'||!f.text.trim()||f.text.length>(f.path==='overview'?1000:1200)))return keep();
      let next=copy(value);for(const c of raw.titles)next.cards.find(x=>x.id===c.id).title=c.title;
      for(const f of fields){if(f.path==='overview')next.overview=f.text;else next.sections[Number(f.path.split('.')[1])].content=f.text;}
      if(JSON.stringify(next)===JSON.stringify(value) || !canCall(3))return keep();
      const checked=await verify(next,{card_ids:ids,summary:true,title_only:true,baseline:value,catalog:getCatalog()});
      if(!checked?.accepted)return keep();
      next=checked.draft || next;
      if(JSON.stringify(next.route)!==JSON.stringify(value.route)||next.cards.length!==value.cards.length||next.cards.some((c,i)=>c.id!==value.cards[i].id||c.place!==value.cards[i].place||c.label!==value.cards[i].label||c.content!==value.cards[i].content||!ids.includes(c.id)&&c.title!==value.cards[i].title)||next.sections.length!==value.sections.length||next.sections.some((s,i)=>s.title!==value.sections[i].title))return keep();
      const reviewed=await assess(next,mustHaveActivity);
      const a=verification?.evidence,b=checked.evidence;
      const merged=b?{...checked,evidence:{...b,claims:[...(a?.claims||[]),...(b.claims||[])],sources:[...(a?.sources||[]),...(b.sources||[])].filter((s,i,all)=>all.findIndex(x=>x.id===s.id)===i),inferences:[...new Set([...(a?.inferences||[]),...(b.inferences||[])])]}}:verification;
      onTrace({stage:'itinerary_summary_sync',status:reviewed.status,card_ids:ids});
      return finish(next,reviewed,{repair:'applied',summary_sync:true,verification:merged});
    }catch(error){if(signal?.aborted||error.code==='RUN_INTERRUPTED')throw error;return keep();}
  }
  if(assessment.status==='passed' || !assessment.issues.length || !semantic || !canCall(4))return finish(original,assessment);
  const synchronized=await syncMetadata(original,assessment,null,[]);
  if(synchronized.status==='passed')return synchronized;
  const ids=[...new Set(assessment.issues.filter(i=>i.code!=='summary_mismatch').flatMap(i=>i.card_ids))],summary=assessment.issues.some(i=>['summary_mismatch','cross_day_conflict','title_mismatch'].includes(i.code));
  // 单次局部修复，避免把质量检查变成全稿重写循环；超出范围保留部分结果。
  const targets=original.cards.filter(c=>ids.includes(c.id)).map(c=>({id:c.id,place:c.place,label:c.label,title:c.title,content:c.content}));
  try{
    const raw=await repairCall('conversation_quality_repair','conversation.quality_repair',{current,issues:assessment.issues,targets,summary:summary?{fields:[{path:'overview',text:original.overview},...original.sections.map((s,i)=>({path:'sections.'+i+'.content',title:s.title,text:s.content}))]}:null,
        readonly_outline:original.cards.map(c=>({id:c.id,place:c.place,label:c.label,title:c.title,...(!ids.includes(c.id)?{content:c.content}:{})})),route:original.route,evidence_catalog:getCatalog()},20000);
    if(signal?.aborted)throw signal.reason;
    if(!raw || !Array.isArray(raw.cards) || raw.cards.length!==ids.length || new Set(raw.cards.map(c=>c?.id)).size!==ids.length ||
      raw.cards.some(c=>!ids.includes(c?.id) || Object.keys(c).some(k=>!['id','title','content'].includes(k)) || typeof c.title!=='string' || !c.title.trim() || c.title.length>100 || typeof c.content!=='string' || !c.content.trim() || c.content.length>1200))return finish(original,assessment,{repair:'invalid_shape'});
    let candidate=copy(original);
    candidate.cards=candidate.cards.map(c=>{const change=raw.cards.find(p=>p.id===c.id);return change?{...c,title:change.title,content:change.content}:c;});
    const summaryFields=raw.summary_fields || [];
    if(!Array.isArray(summaryFields) || new Set(summaryFields.map(f=>f?.path)).size!==summaryFields.length ||
      (!summary && summaryFields.length) || raw.overview!==undefined || raw.sections!==undefined)return finish(original,assessment,{repair:'outside_scope'});
    const allowed=new Set(['overview',...original.sections.map((_,i)=>'sections.'+i+'.content')]);
    if(summaryFields.some(f=>!allowed.has(f?.path) || typeof f.text!=='string' || !f.text.trim() || f.text.length>(f.path==='overview'?1000:1200)))return finish(original,assessment,{repair:'invalid_summary'});
    for(const f of summaryFields){if(f.path==='overview')candidate.overview=f.text;else candidate.sections[Number(f.path.split('.')[1])].content=f.text;}
    if(!canCall(3))return finish(original,assessment,{repair:'unverified'});
    const verification=await verify(candidate,{card_ids:ids,summary,catalog:getCatalog()});
    if(!verification?.accepted)return finish(original,assessment,{repair:'rejected'});
    if(verification.draft){
      const safe=verification.draft;
      if(JSON.stringify(safe.route)!==JSON.stringify(original.route) || safe.cards?.length!==original.cards.length || safe.cards.some((c,i)=>
        c.id!==original.cards[i].id || c.place!==original.cards[i].place || c.label!==original.cards[i].label ||
        !ids.includes(c.id) && (c.title!==original.cards[i].title || c.content!==original.cards[i].content)) ||
        safe.sections?.length!==original.sections.length || safe.sections.some((s,i)=>s.title!==original.sections[i].title) ||
        !summary && (safe.overview!==original.overview || JSON.stringify(safe.sections)!==JSON.stringify(original.sections)))return finish(original,assessment,{repair:'verification_scope_error'});
      candidate=copy(safe);
    }
    const mustHaveActivity=[...new Set(assessment.issues.filter(i=>i.code==='missing_activity').flatMap(i=>i.card_ids))];
    assessment=await assess(candidate,mustHaveActivity);
    onTrace({stage:'itinerary_quality',status:assessment.status,issues:assessment.issues,repaired_cards:ids});
    return syncMetadata(candidate,assessment,verification,mustHaveActivity);
  }catch(error){if(signal?.aborted || error.code==='RUN_INTERRUPTED')throw error;return finish(original,assessment,{repair:error.code==='CONTEXT_BUDGET_EXCEEDED'?'context_limit':'unavailable'});}
}
