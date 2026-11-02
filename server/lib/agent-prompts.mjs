/* 产品运行规则的唯一文件入口。相对模块定位，启动时锁定快照，不依赖cwd或请求参数。 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const AGENT_PROMPT_IDS=Object.freeze([
  'planning.transport_scope','planning.transport_authorization','conversation.transport_revision','planning.transport_review',
  'planning.outline','planning.confirmation','planning.directions',
  'planning.route_decision','planning.route_structure','conversation.local_revision','conversation.quality_sync',
  'conversation.quality_batch','conversation.quality_global','conversation.quality_review','conversation.quality_repair','conversation.intake','conversation.main','conversation.numeric_rules','conversation.digest','conversation.preference_intent',
  'conversation.intent','conversation.understand','conversation.discuss','conversation.numeric_repair','conversation.condition_update','conversation.delivery','conversation.delivery_repair','conversation.compose','conversation.calendar','conversation.review','conversation.scope',
  'conversation.return_check','conversation.schedule','conversation.question_review','conversation.evidence_rules',
  'conversation.selected_route','conversation.generate','conversation.memory_context',
  'conversation.preference_context','conversation.experience_boundary','conversation.field_correction',
  'conversation.operation_context','conversation.background_context','conversation.source_context',
  'conversation.review_source_boundary','conversation.numeric_correction','routing.change','routing.resolve',
  'map.query_names','conversation.activity_fill','conversation.delivery_patch','search.places','search.routes','search.route_check','research.plan','research.answer','sources.relevance',
  'evidence.extract','evidence.itinerary','evidence.repair','evidence.support','evidence.catalog_lookup','format.json','search.web_query'
]);
const invalid=message=>Object.assign(Error('AGENTS.md运行规则无效：'+message),{code:'AGENT_RULES_INVALID'});
const parameters=/\{\{([a-z][a-z0-9_]*)\}\}/g;

/** 标记外的说明不进入模型；参数一次替换，替换值不再作为模板解释。 */
export function parseAgentPrompts(markdown,{requiredIds=AGENT_PROMPT_IDS}={}){
  if(typeof markdown!=='string')throw invalid('需要文本');
  const source=markdown.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const pattern=/^<!-- agent-prompt:([a-z][a-z0-9_.-]*) -->\n```text\n([\s\S]*?)\n```\n<!-- \/agent-prompt -->$/gm;
  const entries=[...source.matchAll(pattern)],prompts=Object.create(null);
  const starts=(source.match(/<!--\s*agent-prompt:/g)||[]).length;
  const ends=(source.match(/<!--\s*\/agent-prompt\s*-->/g)||[]).length;
  if(!entries.length || starts!==entries.length || ends!==entries.length)throw invalid('规则块标记或text围栏未完整配对');
  for(const [,id,body]of entries){
    if(Object.hasOwn(prompts,id))throw invalid('重复规则ID：'+id);
    if(!body.trim())throw invalid('空规则：'+id);
    if(body.replace(parameters,'').includes('{{'))throw invalid('模板参数格式错误：'+id);
    prompts[id]=body;
  }
  for(const id of requiredIds)if(!Object.hasOwn(prompts,id))throw invalid('缺少必需规则：'+id);
  Object.freeze(prompts);
  const ids=Object.freeze(Object.keys(prompts));
  const version='agents-md-'+createHash('sha256').update(JSON.stringify(Object.entries(prompts).sort(([a],[b])=>a<b?-1:a>b?1:0))).digest('hex').slice(0,16);
  return Object.freeze({version,ids,get(id,values={}){
    if(!Object.hasOwn(prompts,id))throw invalid('未知规则ID：'+id);
    if(!values || typeof values!=='object' || Array.isArray(values))throw invalid('模板参数需要对象：'+id);
    const body=prompts[id],slots=new Set([...body.matchAll(parameters)].map(m=>m[1]));
    for(const key of slots)if(!Object.hasOwn(values,key) || typeof values[key]!=='string')throw invalid('缺少字符串参数：'+id+'.'+key);
    for(const key of Object.keys(values))if(!slots.has(key))throw invalid('多余模板参数：'+id+'.'+key);
    return body.replace(parameters,(_,key)=>values[key]);
  }});
}

const catalog=parseAgentPrompts(readFileSync(new URL('../../AGENTS.md',import.meta.url),'utf8'));
export const AGENT_RULES_VERSION=catalog.version;
export const agentPrompt=(id,values)=>catalog.get(id,values);
