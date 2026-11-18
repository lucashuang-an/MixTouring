/* 选择原文片段而不改写事实；保留顺序，避免网页开头导航挤占资料预算。 */
export function selectSourcePassages(value,task={},limit=1600){
  const text=typeof value==='string'?value.trim():'';
  if(text.length<=limit)return text;
  const query=[task.destination,task.query,task.foreignQuery,task.question].filter(Boolean).join(' ').toLowerCase();
  const tokens=new Set(query.match(/[a-z]{3,}|[\u3400-\u9fff]{2,}/g)||[]);
  for(const token of [...tokens])if(/[\u3400-\u9fff]/.test(token) && token.length>2){tokens.delete(token);for(let i=0;i<token.length-1;i++)tokens.add(token.slice(i,i+2));}
  const parts=(text.match(/[^。！？!?\n]+[。！？!?]?/g)||[text]).map((s,i)=>({text:s.trim(),i})).filter(p=>p.text);
  const ranked=parts.map(p=>{const lower=p.text.toLowerCase();let score=0;for(const t of tokens)if(lower.includes(t))score+=t.length>3?3:1;
    if(/导航|版权所有|服务热线|登录|注册|copyright|cookie|subscribe/i.test(p.text))score-=5;
    return {...p,score};}).sort((a,b)=>b.score-a.score||a.i-b.i);
  const selected=[],seen=new Set();let used=0;
  for(const p of ranked){if(p.score<0 || seen.has(p.text) || p.text.length>limit || used+p.text.length+(selected.length?1:0)>limit)continue;seen.add(p.text);selected.push(p);used+=p.text.length+(selected.length>1?1:0);}
  return selected.length?selected.sort((a,b)=>a.i-b.i).map(p=>p.text).join('\n'):text.slice(0,limit);
}

// 同任务按查询语言分工，显式基线探针仍可固定原服务。
export function sourceSearchProvider(language,env=process.env){
  if(language==='zh' && ['tavily','deepseek','current'].includes(env.TRAVEL_CHINESE_SEARCH_PROVIDER))return env.TRAVEL_CHINESE_SEARCH_PROVIDER;
  if(env.TRAVEL_SEARCH_MODE!=='hybrid')return null;
  if(language==='zh' && env.VOLC_SEARCH_API_KEY)return 'current';
  if(language && language!=='zh' && env.TAVILY_API_KEY)return 'tavily';
  return null;
}
