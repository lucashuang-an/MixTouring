/* “回程”可能指景点返回住处。关键词只筛候选，不能直接改写用户日程。 */
import {agentPrompt} from './agent-prompts.mjs';
const kinds=new Set(['return_to_origin','local_return','not_scheduled','unclear']);
export async function unconfirmedReturnCards(draft,routing,model,cache=new Map()){
 const origin=routing.origin;
 const candidates=draft.cards.filter((c,index)=>{
  const prose=(c.title+' '+c.content).replace(/`/g,'');
  return /返程|回程|回家/.test(prose)||origin&&([c.title,c.content].some(s=>['返回','回到','回',...(index>0?['抵达','到达']:[])].some(word=>s.replace(/`/g,'').includes(word+origin))) || c.place===origin&&index>0&&!draft.route.slice(1).includes(origin)&&draft.cards.slice(0,index).some(x=>x.place&&x.place!==origin));
 });
 if(!candidates.length)return [];
 const payload={origin,route:draft.route,cards:candidates.map(({id,place,label,title,content})=>({id,place,label,title,content}))};
 const key=JSON.stringify(payload);if(cache.has(key))return candidates.filter(c=>cache.get(key).includes(c.id));
 const checked=await model({kind:'conversation_return_check',timeoutMs:12000,schema_prompt:agentPrompt('conversation.return_check'),user:key});
 const rows=checked?.classifications;
 if(!Array.isArray(rows)||rows.length!==candidates.length||new Set(rows.map(c=>c?.id)).size!==candidates.length||rows.some(row=>{
  const card=candidates.find(c=>c.id===row?.id);
  return !card||!kinds.has(row.kind)||row.kind==='unclear'||typeof row.quote!=='string'||!row.quote.trim()||![card.title,card.content].some(t=>t.includes(row.quote));
 }))throw Error('单程返程范围核对未完成，原安排保留');
 const ids=rows.filter(r=>r.kind==='return_to_origin').map(r=>r.id);cache.set(key,ids);
 return candidates.filter(c=>ids.includes(c.id));
}
