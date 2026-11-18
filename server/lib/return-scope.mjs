/* “回程”可能指景点返回住处。关键词只筛候选，不能直接改写用户日程。 */
import {agentPrompt} from './agent-prompts.mjs';
const kinds=new Set(['return_to_origin','local_return','not_scheduled','unclear']);
export async function unconfirmedReturnCards(draft,routing,model,cache=new Map()){
 const origin=routing.origin;
 const candidates=draft.cards.filter((c,index)=>{
  const prose=(c.title+' '+c.content).replace(/`/g,'');
  return /返程|回程|回家|\breturn\b|\bback\b/i.test(prose)||origin&&([c.title,c.content].some(s=>['返回','回到','回',...(index>0?['抵达','到达']:[])].some(word=>s.replace(/`/g,'').includes(word+origin))) || c.place===origin&&index>0&&!draft.route.slice(1).includes(origin)&&draft.cards.slice(0,index).some(x=>x.place&&x.place!==origin));
 });
 if(!candidates.length)return [];
 const payload={origin,route:draft.route,cards:candidates.map(({id,place,label,title,content})=>({id,place,label,title,content}))};
 const itineraryContext=(draft.itineraryCards || draft.cards).map(({label,place,title})=>({label,place,title}));
 const key=JSON.stringify([payload,itineraryContext]);if(cache.has(key))return candidates.filter(c=>cache.get(key).includes(c.id));
 const request={kind:'conversation_return_check',timeoutMs:12000,schema_prompt:agentPrompt('conversation.return_check'),user:JSON.stringify(payload)};
 let checked=await model(request);
 function validationError(rows){
  if(!Array.isArray(rows)||rows.length!==candidates.length||new Set(rows.map(r=>r?.id)).size!==candidates.length)return 'classification_ids';
  for(const row of rows){
   const card=candidates.find(c=>c.id===row?.id);
   if(!card||!kinds.has(row.kind))return 'classification_shape';
   if(row.kind==='unclear')return 'unclear';
   if(typeof row.quote!=='string'||!row.quote.trim()||![card.title,card.content].some(t=>t.includes(row.quote)))return 'quote_not_verbatim:'+row.id;
  }
  return null;
 }
 let reason=validationError(checked?.classifications);
 if(checked && reason){
  // 歧义时补上全程顺序与住宿城市，让分类器看到当地折返的上下文。
  const itinerary_context=reason==='unclear'?itineraryContext:undefined;
  checked=await model({...request,user:JSON.stringify({...payload,validation_error:reason,itinerary_context})});
  reason=validationError(checked?.classifications);
 }
 if(reason)throw Error('单程返程范围核对未完成（'+reason+'），原安排保留');
 const rows=checked.classifications;
 const ids=rows.filter(r=>r.kind==='return_to_origin').map(r=>r.id);cache.set(key,ids);
 return candidates.filter(c=>ids.includes(c.id));
}

export async function unconfirmedReturnFields(draft,routing,model,cache=new Map()){
 const fields=[{id:'overview',title:'',content:draft.overview || ''},...(draft.sections || []).map((s,i)=>({id:'sections.'+i+'.content',title:'',content:s.content || ''}))];
 return unconfirmedReturnCards({route:draft.route,cards:fields,itineraryCards:draft.cards},routing,model,cache);
}
export async function repairReturnSummary(draft,routing,model,cache=new Map()){
 const affected=await unconfirmedReturnFields(draft,routing,model,cache);if(!affected.length)return draft;
 const raw=await model({kind:'conversation_return_summary',timeoutMs:15000,schema_prompt:agentPrompt('conversation.return_summary'),user:JSON.stringify({routing,fields:affected.map(f=>({path:f.id,text:f.content})),readonly_cards:draft.cards})});
 if(!Array.isArray(raw?.fields)||raw.fields.length!==affected.length||new Set(raw.fields.map(f=>f.path)).size!==affected.length||raw.fields.some(f=>!affected.some(a=>a.id===f.path)||typeof f.text!=='string'||!f.text.trim()||f.text.length>1200))throw Error('概览返程修复范围无效');
 const next=structuredClone(draft);for(const f of raw.fields){if(f.path==='overview')next.overview=f.text;else next.sections[Number(f.path.split('.')[1])].content=f.text;}
 if((await unconfirmedReturnFields(next,routing,model,cache)).length)throw Error('概览仍有未确认返程');return next;
}
