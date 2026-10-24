/* 旅行经验与目的地资料并行检索；平台归属依据真实 URL，不由模型指定。 */
import {retrievalContext,partitionTimedSources,sourceDay,assessSourceTime} from './source-time.mjs';
import {RELEVANCE_VERSION,sourceId,sourceRule} from './source-relevance.mjs';
import {publicUrl} from './public-reader.mjs';
const cache=new Map();
const hostIs=(host,domain)=>host===domain || host.endsWith('.'+domain);
export const articleIdentity=url=>{try{const x=new URL(url);x.hash='';for(const k of [...x.searchParams.keys()])if(/^utm_|^(spm|share_source|share_from)$/i.test(k))x.searchParams.delete(k);return x.host.replace(/^www\./,'')+x.pathname.replace(/\/$/,'')+x.search;}catch{return url;}};
export function classifyTravelSource(link){
  let url;try{url=new URL(link);}catch{return null;}
  if(!['https:','http:'].includes(url.protocol))return null;
  const host=url.hostname.toLowerCase().replace(/^www\./,'');
  const platforms=[['xiaohongshu.com','小红书'],['xhslink.com','小红书'],['mafengwo.cn','马蜂窝'],['qyer.com','穷游'],['8264.com','8264'],['reddit.com','Reddit']];
  const hit=platforms.find(([domain])=>hostIs(host,domain));
  if(hit){
    const path=url.pathname;
    const experience=hostIs(host,'xiaohongshu.com') || hostIs(host,'xhslink.com') ||
      hostIs(host,'mafengwo.cn') && /^\/(i\/|weng\/|mweng\/wengdetail)/.test(path) ||
      hostIs(host,'qyer.com') && (/thread-|\/review/.test(path) || host.startsWith('bbs.')) ||
      hostIs(host,'8264.com') && /youji\/|thread-/.test(path) ||
      hostIs(host,'reddit.com') && /\/comments\//.test(path);
    return {platform:hit[1],kind:experience?'experience':'guide',host};
  }
  if(hostIs(host,'trip.com'))return {platform:'Trip.com',kind:url.pathname.startsWith('/moments/detail/')?'experience':'guide',host};
  if(hostIs(host,'ctrip.com'))return {platform:'携程',kind:/^\/(?:travels\/[^/]+\/\d+|html5\/you\/travels\/\d+\/\d+)\.html$/.test(url.pathname)?'experience':'guide',host};
  if(hostIs(host,'backpackers.com.tw'))return {platform:'背包客栈',kind:url.pathname.includes('/forum/')?'experience':'guide',host};
  if(hostIs(host,'caravanistan.com'))return {platform:'Caravanistan',kind:url.pathname.startsWith('/forum')?'experience':'guide',host};
  if(['tripadvisor.com','tripadvisor.co.uk','tripadvisor.fr','tripadvisor.de','tripadvisor.com.au','tripadvisor.cn','tripadvisor.in','tripadvisor.it','tripadvisor.es'].some(d=>hostIs(host,d)))return {platform:'Tripadvisor',kind:/ShowTopic|ShowUserReviews/.test(url.pathname)?'experience':'guide',host};
  if(/\.gov(?:\.[a-z]{2})?$/.test(host) || ['kazakhstan.travel','jr-central.co.jp','jreast.co.jp','smart-ex.jp','12306.cn','csair.com','airchina.com.cn','airastana.com'].some(d=>hostIs(host,d)))return {platform:host,kind:'official',host};
  return {platform:host,kind:'guide',host};
}
function cleanResult(raw,now=Date.now()){
  const meta=classifyTravelSource(raw?.link);if(!meta)return null;
  const published=raw.date_basis==='provider_estimate'?null:raw.date;
  const url=new URL(raw.link);url.hash='';
  if(url.username || url.password)return null;
  if(url.pathname==='/' || /\/search(?:\/|$)/.test(url.pathname))return null;
  if(hostIs(meta.host,'xiaohongshu.com') && !/^\/(explore|discovery\/item)\/[^/]+/.test(url.pathname))return null;
  for(const key of [...url.searchParams.keys()])if(/^utm_|^(spm|share_source|share_from)$/i.test(key))url.searchParams.delete(key);
  return {...meta,url:url.href,title:String(raw.title || meta.platform).slice(0,160),excerpt:String(raw.content || '').slice(0,1600),
    ...(raw.date_basis==='provider_estimate'?{estimated_date:String(raw.estimated_date || '').slice(0,100),estimated_date_basis:'provider_estimate'}:{}),
    published_at:sourceDay(published),published_raw:published || null,date_basis:published?'search_index':'unknown',read_status:'search_excerpt',checked_at:new Date(now).toISOString()};
}
export async function collectTravelSources({destination='',query='',question='',international=false,foreignQuery='',travel={},window=null,purpose='experience'},search,{useCache=true,readPage=null,now=Date.now(),signal=null,queryPlans=null,diagnostics=false,assessSources=null}={}){
  const temporal=retrievalContext({travel,window,purpose,now});
  const stamp=temporal.target_window?' '+temporal.target_window.replaceAll(' ',''):'';
  const task={destination:String(destination).trim(),query:String(query).trim(),question:String(question).trim().slice(0,2000),foreignQuery:String(foreignQuery).trim(),purpose,international:!!international};
  const directUrls=[...task.question.matchAll(/https?:\/\/[^\s<>"'（）()]+/gi)].map(m=>m[0].replace(/[.,，。!?！？;；]+$/,''))
    .map(value=>{try{return publicUrl(value).href;}catch{return null;}}).filter(Boolean).filter((value,i,all)=>all.indexOf(value)===i).slice(0,2);
  const topic=task.query || destination+' 旅行';
  const aliases={'北京':'Beijing','乌鲁木齐':'Urumqi','伊宁':'Yining','阿拉木图':'Almaty','霍尔果斯':'Khorgos'};
  const english=String(foreignQuery || topic).replace(/北京|乌鲁木齐|伊宁|阿拉木图|霍尔果斯/g,x=>aliases[x]);
  /* R1-A：任务查询计划——替代固定四/七平台展开，普通资料补充收敛到最多两次搜索；
   * 多域名合并到单条查询（Tavily include_domains restrict），语言与用途显式。 */
  const CN_COMMUNITY_DOMAINS = ['xiaohongshu.com', 'mafengwo.cn', 'qyer.com'];
  const OVERSEAS_DOMAINS = ['reddit.com', 'caravanistan.com', 'backpackers.com.tw'];
  const themeWords = purpose === 'transport' ? '交通 班车 班次' : purpose === 'guide' ? '官方 交通 开放 攻略' : '旅行 乘车 游记';
  // 国际体验可查海外社区；交通／官方资料始终保留开放查询，不让域限制排除运营方。
  const communityKinds = ['experience', 'guide'];
  const request=task.question+' '+task.query;
  const explicitDomains=[...new Set([...request.matchAll(/\bsite:([a-z0-9.-]+)/gi)].map(m=>m[1].toLowerCase()).concat(
    [['小红书|xiaohongshu','xiaohongshu.com'],['马蜂窝|mafengwo','mafengwo.cn'],['穷游|qyer','qyer.com'],['reddit','reddit.com'],['caravanistan','caravanistan.com'],['getyourguide','getyourguide.com']].filter(([pattern])=>new RegExp(pattern,'i').test(request)).map(([,domain])=>domain)))].slice(0,8);
  const language=text=>/[\u3040-\u30ff]/.test(text) || /[\u3400-\u9fff]/.test(text) && /\bsite:[^\s]+\.jp(?:\s|$)/i.test(text)?'ja':/[\u3400-\u9fff]/.test(text)?'zh':'en';
  const officialTopic=international?english:topic;
  const officialPlan = { channel: '官方与目的地资料', domains: null, language:language(officialTopic), kinds: ['official', 'guide'],
    base:officialTopic,suffix:language(officialTopic)==='ja'?'公式 '+(purpose==='transport'?'時刻表':'案内'):language(officialTopic)==='zh'?'官方 '+(purpose==='transport'?'交通 班次':'开放 最新'):'official '+(purpose==='transport'?'transport schedule':'visitor information') };
  const fit=(value,limit)=>{const text=String(value || '').trim();if(text.length<=limit)return text;
    const headSize=Math.ceil((limit-1)/2),tailSize=Math.floor((limit-1)/2),left=text.slice(0,headSize),right=text.slice(-tailSize);
    // 英文不在词中间截断；无空格的中文长题仍保留头尾与本轮关键尾词。
    const head=/\s/.test(left)?left.slice(0,left.lastIndexOf(' ')):left;
    const tail=/\s/.test(right)?right.slice(right.indexOf(' ')+1):right;
    return head+' '+tail;
  };
  const defaults = [
    { channel: explicitDomains.length?'指定来源':'中文社区', domains: explicitDomains.length?explicitDomains:CN_COMMUNITY_DOMAINS, domainMode:explicitDomains.length?'restrict':'prefer', language:language(topic), kinds: communityKinds, base:task.query || destination+' '+themeWords },
    ...(international && purpose==='experience' && !explicitDomains.length ? [{ channel: '海外社区', domains: OVERSEAS_DOMAINS, domainMode:'prefer', language:language(english), kinds: communityKinds, base:english }] : [officialPlan])
  ].map(({base,suffix,...q}) => { const scope = stamp;
    const room=100-scope.length,primary=fit(base,room),free=room-primary.length-1;
    const secondary=(suffix || '').split(/\s+/).reduce((value,word)=>{const next=value?value+' '+word:word;return next.length<=free?next:value;},'');
    return {...q,text:primary+(secondary?' '+secondary:'')+scope,domain:q.domains?q.domains[0]:null,
      startDate:new Date(Date.parse(temporal.today+'T00:00:00Z')-(q.domains?365:temporal.max_age_days)*86400000).toISOString().slice(0,10),endDate:temporal.today}; });
  // 固定探针仅供内部基线工具注入，不接受 HTTP 入参；默认产品检索计划与筛选保持原样。
  if(queryPlans!==null && (!Array.isArray(queryPlans) || !queryPlans.length || queryPlans.length>8 || queryPlans.some(q=>!q || typeof q.text!=='string' || !q.text.trim() || q.text.length>100 || !/^[a-z0-9.-]+$/.test(q.domain || '') || !Array.isArray(q.kinds) || !q.kinds.length || q.kinds.some(k=>!['experience','guide','official'].includes(k)))))throw Error('基线查询计划无效');
  const queries=queryPlans || defaults;
  if(diagnostics || queryPlans)useCache=false;
  /* R1-A:服务敏感缓存——不同检索服务的来源集合不可互串 */
  const key=JSON.stringify(['sources-0.60.25',RELEVANCE_VERSION,process.env.TRAVEL_SEARCH_PROVIDER || 'current',task,queries,temporal,!!readPage,assessSources?'model':'rules']);
  /* #32（复审二轮）：取消检查统一三处——缓存命中前、搜索阶段后、原文读取阶段后；
   * 取消轮一律返回 cancelled（不产出来源、不登记、缓存命中也不放行），重试重新全量检索。 */
  const cancelledResult=()=>({sources:[],archive:[],experiences:[],channels:[],temporal,status:'unavailable',reader:{attempted:0,available:0},excluded_count:0,cache_hit:false,retrieved_at:new Date(now).toISOString(),results:[],cancelled:true});
  const cached=cache.get(key);
  if(useCache && cached?.until>now){if(signal?.aborted)return cancelledResult();return {...structuredClone(cached.value),cache_hit:true};}
  const settled=signal?.aborted?[]:await Promise.allSettled(queries.map(q=>search(q.text,{limit:5,timeoutMs:12000,signal,domains:q.domains || (q.domain?[q.domain]:null),domainMode:q.domainMode || 'restrict',language:q.language || null,startDate:q.startDate || null,endDate:q.endDate || null})));
  /* #32（复审 P2）：部分查询先成功、其余被取消时，本轮不产出可用结果、不登记来源、不写缓存 */
  if(signal?.aborted)return cancelledResult();
  let pool=[];
  const seen=new Map(),channels=[],queryDiagnostics=[],queryEntries=[];
  settled.forEach((item,i)=>{
    const results=item.status==='fulfilled' && Array.isArray(item.value)?item.value:[];
    const plan=queries[i],planDomains=plan.domains || (plan.domain?[plan.domain]:[]),cleaned=results.map(raw=>cleanResult(raw,now));
    const inPlanDomain=raw=>{try{return planDomains.some(d=>hostIs(new URL(raw.link).hostname.toLowerCase(),d));}catch{return false;}};
    const domainHits=results.filter(inPlanDomain);
    const entries=cleaned.map(source=>{
      if(!source)return {reason:'invalid_source'};
      // 产品通用计划允许站外补充；显式探针仍严格核对实际域名与类型。
      if(queryPlans && !planDomains.some(d=>hostIs(source.host,d)))return {source,reason:'domain_mismatch'};
      if(queryPlans && !plan.kinds.includes(source.kind))return {source,reason:'kind_mismatch'};
      if(!queryPlans){const rule=sourceRule(task,source);if(rule?.kind){source.kind=rule.kind;source.allowed_use=rule.reason;}if(rule?.decision==='reject')return {source,...rule};}
      const existing=seen.get(source.url);if(existing)return {source:existing,duplicate:true};
      seen.set(source.url,source);pool.push(source);return {source};
    });
    queryEntries.push(entries);
    queryDiagnostics.push({query:plan.text,raw_count:results.length,domain_hit_count:domainHits.length});
    channels.push({channel:plan.channel,status:item.status==='fulfilled' && Array.isArray(item.value)?'empty':'unavailable',query:plan.text});
  });
  if(directUrls.length){
    const entries=directUrls.map(url=>{const existing=seen.get(url);if(existing){existing.direct_input=true;return {source:existing,duplicate:true};}
      const source=cleanResult({link:url,title:new URL(url).hostname,content:''},now);if(!source)return {reason:'invalid_source'};
      source.direct_input=true;seen.set(source.url,source);pool.unshift(source);return {source};});
    queryEntries.push(entries);queryDiagnostics.push({query:'用户指定公开网页',raw_count:entries.length,domain_hit_count:entries.length});
    channels.push({channel:'用户指定公开网页',status:'empty',query:'用户明确提供的公开地址'});
  }
  const candidates=partitionTimedSources(pool,temporal);
  // 少量读取日期不明或近期结果的原文，不触碰登录态，不把验证页当正文。
  const experienceCandidates=partitionTimedSources(pool.filter(s=>s.kind==='experience'),retrievalContext({travel,window,purpose:'experience',now})).current;
  const readable=candidates.current.concat(experienceCandidates,candidates.archive.filter(s=>s.temporal.state==='undated'));
  const readPriority=s=>{
    // 索引估计日期只帮助选择读哪篇，不写入published_at或授予当前证据资格。
    const estimate=sourceDay(s.estimated_date) || (s.estimated_date && Number.isFinite(Date.parse(s.estimated_date))?new Date(s.estimated_date).toISOString().slice(0,10):null);
    const promising=estimate && ['recent','window_reference'].includes(assessSourceTime({published_at:estimate},temporal).state);
    return (s.direct_input?100:0)+(s.kind==='official'?20:0)+(s.published_at?10:0)+(promising?5:0)+(s.kind==='experience'?1:0);
  };
  const targets=readable.filter((s,i,all)=>all.findIndex(x=>x.url===s.url)===i).sort((a,b)=>readPriority(b)-readPriority(a)).slice(0,2);
  /* #32：取消后不再启动原文读取；已取消的读取按失败处理，不写入缓存 */
  const reads=!readPage?[]:await Promise.allSettled(targets.map(s=>signal?.aborted?Promise.reject(Object.assign(Error('已取消'),{name:'AbortError'})):readPage(s.url,{timeoutMs:5500,signal})));
  /* 复审二轮：读取阶段被取消（部分读取已成功）同样不产出可用结果 */
  if(signal?.aborted)return cancelledResult();
  /* #30：文章身份核对——最终 URL 规范化后须与检索 URL 同 host 同 path（或读取器未报告最终 URL）
   * 才合并正文/标题/平台/日期；跳转到其他文章时保留原索引记录与读取缺口，不把别站文章
   * 嫁接原平台日期或冒充原平台原帖。 */
  let readCount=0;
  reads.forEach((out,i)=>{
    const source=pool.find(s=>s.url===targets[i].url),page=out.status==='fulfilled'?out.value:null;
    if(!source)return;
    if(page?.read_status==='page_excerpt'){
      if(page.url && classifyTravelSource(page.url) && articleIdentity(page.url)!==articleIdentity(source.url)){
        source.read_status='search_excerpt';
        source.read_note='原文读取跳转到其他文章，为避免身份混淆未采用，仅有搜索摘要';
        return;
      }
      readCount++;source.excerpt=String(page.excerpt || source.excerpt).slice(0,3500);source.read_status='page_excerpt';
      if(page.title){source.search_title=source.title;source.title=String(page.title).slice(0,160);}
      if(page.url && classifyTravelSource(page.url)){source.original_url=source.url;source.url=page.url;Object.assign(source,classifyTravelSource(page.url));}
      source.updated_at=page.updated_at || null;source.truncated=!!page.truncated;
      if(page.published_at){source.published_at=sourceDay(page.published_at);source.date_basis='page_metadata';}
    }else if(readPage){source.read_status='search_excerpt';source.read_note='原文未能读取，仅有搜索摘要';}
  });
  // 原文合并后再审查，避免搜索摘要的导航噪声或截断掩盖推广／跑题内容。
  const decisions=new Map(),relevance={version:RELEVANCE_VERSION,status:'rules_only',reviewed:0,kept:0,rejected:0,uncertain:0};
  if(!queryPlans){
    for(const source of pool)if(source.direct_input && source.read_status!=='page_excerpt')decisions.set(source.url,{decision:'reject',reason:'direct_read_failed',stage:'reader'});
    for(const source of pool){const rule=sourceRule(task,source);if(rule?.kind){source.kind=rule.kind;source.allowed_use=rule.reason;}if(rule?.decision==='reject')decisions.set(source.url,rule);}
    const experienceScope=retrievalContext({travel,window,purpose:'experience',now});
    const eligible=pool.filter(s=>!decisions.has(s.url) && ['recent','window_reference','undated'].includes(assessSourceTime(s,s.kind==='experience'?experienceScope:temporal).state));
    if(assessSources && eligible.length){
      let assessed;try{assessed=await assessSources(task,eligible,{signal});}catch{}
      if(signal?.aborted)return cancelledResult();
      relevance.status=assessed?.status || 'unavailable';
      relevance.reason_code=assessed?.status==='completed'?null:assessed?.reason_code || 'model_unavailable';
      for(const source of eligible){const item=assessed?.items?.find(x=>x.id===sourceId(source));
        const decision=item && ['keep','reject','uncertain'].includes(item.decision)?item:{decision:'uncertain',reason:'来源相关性未完成'};
        decisions.set(source.url,{...decision,stage:'model'});relevance.reviewed++;
      }
    }
  }
  for(const source of pool){const decision=decisions.get(source.url);if(decision)source.relevance=decision;}
  const accepted=source=>!decisions.has(source.url) || decisions.get(source.url).decision==='keep';
  queryEntries.forEach((entries,i)=>{
    const usable=entries.filter(e=>!e.reason && accepted(e.source));
    Object.assign(queryDiagnostics[i],{accepted_count:usable.length,rejected_count:entries.length-usable.length,duplicate_count:usable.filter(e=>e.duplicate).length,
      task_filtered:entries.filter(e=>e.reason || !accepted(e.source)).map(e=>({...(e.source?{url:e.source.url}:{}),reason:e.reason || decisions.get(e.source.url)?.reason || 'unassessed',stage:e.stage || decisions.get(e.source?.url)?.stage || 'source'}))});
    if(channels[i].status!=='unavailable')channels[i].status=usable.length?'found':'empty';
  });
  relevance.rejected=queryDiagnostics.reduce((sum,q)=>sum+q.rejected_count,0);
  relevance.uncertain=[...decisions.values()].filter(d=>d.decision==='uncertain').length;
  if(assessSources && relevance.uncertain && relevance.status==='completed'){relevance.status='partial';relevance.reason_code='incomplete_assessment';}
  pool=pool.filter(accepted);relevance.kept=pool.length;
  const partition=partitionTimedSources(pool,temporal);
  const diverse=list=>{const counts=new Map();return list.filter(s=>{const count=counts.get(s.platform)||0;if(count>=2)return false;counts.set(s.platform,count+1);return true;});};
  const experienceContext=retrievalContext({travel,window,purpose:'experience',now});
  const experiences=diverse(partitionTimedSources(pool.filter(s=>s.kind==='experience'),experienceContext).current).slice(0,8).map(s=>({...s,allowed_use:'travel_experience'}));
  const sources=diverse(partition.current).slice(0,8),archive=diverse(partition.archive).slice(0,8);
  const available=channels.filter(c=>c.status!=='unavailable').length;
  const value={sources,archive,experiences,channels,temporal,relevance,query_diagnostics:queryDiagnostics,status:available===0?'unavailable':available<channels.length?'partial':'available',reader:{attempted:reads.length,available:readCount},excluded_count:partition.excluded.length,cache_hit:false,retrieved_at:new Date(now).toISOString(),
    results:sources.map(s=>({title:s.title,link:s.url,content:s.excerpt,date:s.published_at,date_basis:s.date_basis,source_kind:s.kind,platform:s.platform,read_status:s.read_status,temporal:s.temporal}))};
  if(diagnostics)value.diagnostics={queries:queryDiagnostics,all_sources:[...partition.current,...partition.archive,...partition.excluded]};
  if(useCache && available && !['unavailable','partial'].includes(relevance.status) && !signal?.aborted){cache.set(key,{value:structuredClone(value),until:now+300000});if(cache.size>80)cache.delete(cache.keys().next().value);}
  return value;
}
