/* 旅行经验与目的地资料并行检索；平台归属依据真实 URL，不由模型指定。 */
import {retrievalContext,partitionTimedSources,sourceDay} from './source-time.mjs';
const cache=new Map();
const hostIs=(host,domain)=>host===domain || host.endsWith('.'+domain);
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
  if(/\.gov(?:\.[a-z]{2})?$/.test(host) || hostIs(host,'kazakhstan.travel'))return {platform:host,kind:'official',host};
  return {platform:host,kind:'guide',host};
}
function cleanResult(raw,now=Date.now()){
  const meta=classifyTravelSource(raw?.link);if(!meta)return null;
  const url=new URL(raw.link);url.hash='';
  if(url.username || url.password)return null;
  if(url.pathname==='/' || /\/search(?:\/|$)/.test(url.pathname))return null;
  if(hostIs(meta.host,'xiaohongshu.com') && !/^\/(explore|discovery\/item)\/[^/]+/.test(url.pathname))return null;
  for(const key of [...url.searchParams.keys()])if(/^utm_|^(spm|share_source|share_from)$/i.test(key))url.searchParams.delete(key);
  return {...meta,url:url.href,title:String(raw.title || meta.platform).slice(0,160),excerpt:String(raw.content || '').slice(0,500),
    published_at:sourceDay(raw.date),published_raw:raw.date || null,date_basis:raw.date?'search_index':'unknown',read_status:'search_excerpt',checked_at:new Date(now).toISOString()};
}
export async function collectTravelSources({destination='',query='',international=false,foreignQuery='',travel={},window=null,purpose='experience'},search,{useCache=true,readPage=null,now=Date.now(),signal=null}={}){
  const temporal=retrievalContext({travel,window,purpose,now});
  const since=new Date(Date.parse(temporal.today+'T00:00:00Z')-temporal.max_age_days*86400000).toISOString().slice(0,10);
  const stamp=' after:'+since+(temporal.target_window?' '+temporal.target_window.replaceAll(' ',''):' before:'+temporal.today);
  const topic=String(query || destination+' 旅行').slice(0,36);
  const aliases={'北京':'Beijing','乌鲁木齐':'Urumqi','伊宁':'Yining','阿拉木图':'Almaty','霍尔果斯':'Khorgos'};
  const english=String(foreignQuery || destination+' travel report').replace(/北京|乌鲁木齐|伊宁|阿拉木图|霍尔果斯/g,x=>aliases[x]);
  const queries=[
    {channel:'小红书',domain:'xiaohongshu.com',text:'site:xiaohongshu.com '+destination+' 旅行 乘车'},
    {channel:'马蜂窝',domain:'mafengwo.cn',text:'site:mafengwo.cn '+destination+' 游记'},
    {channel:'穷游',domain:'qyer.com',text:'site:bbs.qyer.com '+destination+' 交通'},
    ...(international?[
      {channel:'Reddit',domain:'reddit.com',text:'site:reddit.com '+english},
      {channel:'Caravanistan',domain:'caravanistan.com',text:'site:caravanistan.com/forum '+english},
      {channel:'背包客栈',domain:'backpackers.com.tw',text:'site:backpackers.com.tw/forum '+destination+' 交通'}]:[]),
    {channel:'官方与目的地资料',text:topic+' 官方 交通 开放 最新'}
  ].map(q=>{const scope=q.domain?stamp.replace(since,new Date(Date.parse(temporal.today+'T00:00:00Z')-365*86400000).toISOString().slice(0,10)):stamp;return {...q,text:q.text.slice(0,100-scope.length)+scope};});
  const key=JSON.stringify([queries,temporal]);
  /* #32（复审二轮）：取消检查统一三处——缓存命中前、搜索阶段后、原文读取阶段后；
   * 取消轮一律返回 cancelled（不产出来源、不登记、缓存命中也不放行），重试重新全量检索。 */
  const cancelledResult=()=>({sources:[],archive:[],experiences:[],channels:[],temporal,status:'unavailable',reader:{attempted:0,available:0},excluded_count:0,cache_hit:false,retrieved_at:new Date(now).toISOString(),results:[],cancelled:true});
  const cached=cache.get(key);
  if(useCache && cached?.until>now){if(signal?.aborted)return cancelledResult();return {...structuredClone(cached.value),cache_hit:true};}
  const settled=signal?.aborted?[]:await Promise.allSettled(queries.map(q=>search(q.text,{limit:5,timeoutMs:12000,signal})));
  /* #32（复审 P2）：部分查询先成功、其余被取消时，本轮不产出可用结果、不登记来源、不写缓存 */
  if(signal?.aborted)return cancelledResult();
  const pool=[],seen=new Set(),channels=[];
  settled.forEach((item,i)=>{
    const results=item.status==='fulfilled' && Array.isArray(item.value)?item.value:[];
    const valid=results.map(raw=>cleanResult(raw,now)).filter(r=>r && (!queries[i].domain || hostIs(r.host,queries[i].domain) && r.kind==='experience'));
    channels.push({channel:queries[i].channel,status:valid.length?'found':item.status==='fulfilled' && Array.isArray(item.value)?'empty':'unavailable',query:queries[i].text});
    for(const result of valid){if(seen.has(result.url))continue;seen.add(result.url);pool.push(result);}
  });
  const candidates=partitionTimedSources(pool,temporal);
  // 少量读取日期不明或近期结果的原文，不触碰登录态，不把验证页当正文。
  const experienceCandidates=partitionTimedSources(pool.filter(s=>s.kind==='experience'),retrievalContext({travel,window,purpose:'experience',now})).current;
  const readable=candidates.current.concat(experienceCandidates,candidates.archive.filter(s=>s.temporal.state==='undated'));
  const targets=[readable.find(s=>s.kind==='official'),...readable.filter(s=>s.kind==='experience').slice(0,2),...readable].filter((s,i,all)=>s && all.findIndex(x=>x?.url===s.url)===i).slice(0,3);
  /* #32：取消后不再启动原文读取；已取消的读取按失败处理，不写入缓存 */
  const reads=!readPage?[]:await Promise.allSettled(targets.map(s=>signal?.aborted?Promise.reject(Object.assign(Error('已取消'),{name:'AbortError'})):readPage(s.url,{timeoutMs:5500,signal})));
  /* 复审二轮：读取阶段被取消（部分读取已成功）同样不产出可用结果 */
  if(signal?.aborted)return cancelledResult();
  /* #30：文章身份核对——最终 URL 规范化后须与检索 URL 同 host 同 path（或读取器未报告最终 URL）
   * 才合并正文/标题/平台/日期；跳转到其他文章时保留原索引记录与读取缺口，不把别站文章
   * 嫁接原平台日期或冒充原平台原帖。 */
  const articleIdentity=url=>{try{const x=new URL(url);x.hash='';for(const k of [...x.searchParams.keys()])if(/^utm_|^(spm|share_source|share_from)$/i.test(k))x.searchParams.delete(k);return x.host.replace(/^www\./,'')+x.pathname.replace(/\/$/,'')+x.search;}catch{return url;}};
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
  const partition=partitionTimedSources(pool,temporal);
  const diverse=list=>{const counts=new Map();return list.filter(s=>{const count=counts.get(s.platform)||0;if(count>=2)return false;counts.set(s.platform,count+1);return true;});};
  const experienceContext=retrievalContext({travel,window,purpose:'experience',now});
  const experiences=diverse(partitionTimedSources(pool.filter(s=>s.kind==='experience'),experienceContext).current).slice(0,8).map(s=>({...s,allowed_use:'travel_experience'}));
  const sources=diverse(partition.current).slice(0,8),archive=diverse(partition.archive).slice(0,8);
  const available=channels.filter(c=>c.status!=='unavailable').length;
  const value={sources,archive,experiences,channels,temporal,status:available===0?'unavailable':available<channels.length?'partial':'available',reader:{attempted:reads.length,available:readCount},excluded_count:partition.excluded.length,cache_hit:false,retrieved_at:new Date(now).toISOString(),
    results:sources.map(s=>({title:s.title,link:s.url,content:s.excerpt,date:s.published_at,date_basis:s.date_basis,source_kind:s.kind,platform:s.platform,read_status:s.read_status,temporal:s.temporal}))};
  if(useCache && available && !signal?.aborted){cache.set(key,{value:structuredClone(value),until:now+300000});if(cache.size>80)cache.delete(cache.keys().next().value);}
  return value;
}
