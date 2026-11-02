import {agentPrompt} from './agent-prompts.mjs';
/* 来源相关性只决定本任务能否使用，不授予发布日期、运营事实或用户决策权。 */
import {createHash} from 'node:crypto';
export const RELEVANCE_VERSION='task-relevance-0.60.40';
export const sourceId=source=>'src_'+createHash('sha256').update(source.url).digest('hex').slice(0,16);
export function sourceRule(task,source){
  const request=String(task.question || '')+' '+String(task.query || '')+' '+String(task.foreignQuery || '');
  const text=source.title+'\n'+source.excerpt;
  const app=/\bapps?\b|应用|软件/i.test(text);
  if(app && /\bapps?\b|应用|软件|工具|下载|安装/i.test(request))return {decision:'keep',reason:'software_reference',kind:'guide'};
  if(task.purpose!=='experience')return null;
  const marketing=(text.match(/拯救懒癌|自动计算|自动整合|一键抓取|生成专属|多人实时共编/g) || []).length>=2 || /(?:旅行|旅游|出行)\s*app.{0,8}(?:下载|排行)/i.test(source.title);
  return app && marketing?{decision:'reject',reason:'app_promotion_not_experience',stage:source.read_status==='page_excerpt'?'page':'summary'}:null;
}
export function relevanceReviewer(model){
  return async(task,sources,{signal}={})=>{
    const views=sources.map(s=>({id:sourceId(s),url:s.url,title:s.title,excerpt:s.excerpt.slice(0,1600),kind:s.kind,read_status:s.read_status}));
    let response,reason_code=null,failure=null;const request={kind:'conversation_source_relevance',timeoutMs:12000,signal,
      onFailure:value=>{failure=value;reason_code=value.reason_code;},
      schema_prompt:agentPrompt('sources.relevance'),
      user:JSON.stringify({task,candidates:views})};
    try{response=await model(request);
      // 只补试明确可恢复的失败；内容过滤、格式错误及原因未明的null不原样重复。
      if(response==null && failure?.retryable===true && !signal?.aborted)response=await model(request);
    }catch(error){reason_code=signal?.aborted?'cancelled':error?.code==='CONTEXT_BUDGET_EXCEEDED'?'context_budget':'model_unavailable';}
    const items=Array.isArray(response?.items)?response.items:[],counts=new Map();
    for(const item of items)counts.set(item?.id,(counts.get(item?.id)||0)+1);
    return {status:Array.isArray(response?.items)?'completed':'unavailable',reason_code:Array.isArray(response?.items)?null:reason_code || 'model_unavailable',items:views.map(view=>{
      const item=items.find(x=>x?.id===view.id),reason=typeof item?.reason==='string'?item.reason.trim().slice(0,300):'',quote=typeof item?.quote==='string'?item.quote.trim():'';
      if(counts.get(view.id)!==1 || !['keep','reject','uncertain'].includes(item?.decision) || !reason || item.decision!=='uncertain' && (!quote || quote.length>500 || !(view.title+'\n'+view.excerpt).includes(quote)))return {id:view.id,decision:'uncertain',reason:'相关性判断缺少有效来源或原句',quote:''};
      return {id:view.id,decision:item.decision,reason,quote};
    })};
  };
}
