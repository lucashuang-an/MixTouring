import {agentPrompt} from './agent-prompts.mjs';
/* 将旅行范围与交通端点分开。复杂旧摘要由模型结合已确认对话整理，不能直接送地图。 */
import { countryScope } from './place-scope.mjs';
const text=v=>typeof v==='string'?v.trim().slice(0,80):'';
function endpoint(v){
  const name=text(v);
  /* 这是端点字段的类型约束，不用这些词理解用户意图。 */
  if(!name || countryScope(name) || /[+＋→、，,\n]|待定|倾向|待确认|具体城市/.test(name))return '';
  return name;
}
export function routingSnapshot(raw={}){
  return {origin:endpoint(raw?.origin),destination:endpoint(raw?.destination)};
}
export async function verifyRoutingChange({before,proposed,text:message,messages=[]},model){
  const current=routingSnapshot(before?.routing);
  if(!current.origin || !current.destination || current.origin===proposed.origin && current.destination===proposed.destination)return proposed;
  const checked=await model({kind:'conversation_route_change',timeoutMs:15000,
    schema_prompt:agentPrompt('routing.change'),
    user:JSON.stringify({current,proposed,text:message,user_messages:messages.filter(m=>m?.role==='user').slice(-12)})});
  const routing=routingSnapshot(checked);
  if(!checked || !['origin','destination'].every(k=>Object.hasOwn(checked,k) && (checked[k]===null || typeof checked[k]==='string' && endpoint(checked[k]))))throw Error('路线端点变更核对未完成');
  return routing;
}
export async function resolveConversationRouting(input,model,{allowModel=true}={}){
  const brief=input.brief || {},before=input.before || {},provided=routingSnapshot(input.routing);
  let routing={origin:provided.origin || endpoint(brief.origin) || (brief.origin===before.brief?.origin?endpoint(before.routing?.origin):''),
    destination:provided.destination || endpoint(brief.destination) || (brief.destination===before.brief?.destination?endpoint(before.routing?.destination):'')};
  if(routing.origin && routing.destination)return {routing,available:true,question:null,engine:'structured'};
  if(!allowModel || (!brief.origin && !brief.destination))return {routing,available:true,question:null,engine:'structured'};
  const output=await model({kind:'conversation_places',timeoutMs:15000,
    schema_prompt:agentPrompt('routing.resolve'),
    user:JSON.stringify({brief,routing,before:before.routing || null,text:input.text || '',messages:input.messages || []})});
  if(!output || !Object.hasOwn(output,'destination'))return {routing,available:false,question:null,engine:'unavailable'};
  routing={origin:endpoint(output.origin) || routing.origin,destination:endpoint(output.destination) || routing.destination};
  return {routing,available:true,question:typeof output.question==='string'?output.question.slice(0,300):null,engine:'llm'};
}
