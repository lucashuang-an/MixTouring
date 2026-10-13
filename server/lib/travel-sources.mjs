/* 旅行经验与目的地资料并行检索；平台归属依据真实 URL，不由模型指定。 */
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
  if(hostIs(host,'ctrip.com'))return {platform:'携程',kind:url.pathname.startsWith('/travels/')?'experience':'guide',host};
  if(hostIs(host,'caravanistan.com'))return {platform:'Caravanistan',kind:url.pathname.startsWith('/forum')?'experience':'guide',host};
  if(['tripadvisor.com','tripadvisor.co.uk','tripadvisor.fr','tripadvisor.de','tripadvisor.com.au','tripadvisor.cn','tripadvisor.in','tripadvisor.it','tripadvisor.es'].some(d=>hostIs(host,d)))return {platform:'Tripadvisor',kind:/ShowTopic|ShowUserReviews/.test(url.pathname)?'experience':'guide',host};
  if(/\.gov(?:\.[a-z]{2})?$/.test(host) || hostIs(host,'kazakhstan.travel'))return {platform:host,kind:'official',host};
  return {platform:host,kind:'guide',host};
}
function cleanResult(raw){
  const meta=classifyTravelSource(raw?.link);if(!meta)return null;
  const url=new URL(raw.link);url.hash='';
  if(url.pathname==='/' || /\/search(?:\/|$)/.test(url.pathname))return null;
  if(hostIs(meta.host,'xiaohongshu.com') && !/^\/(explore|discovery\/item)\/[^/]+/.test(url.pathname))return null;
  for(const key of [...url.searchParams.keys()])if(/^utm_|^(spm|share_source|share_from)$/i.test(key))url.searchParams.delete(key);
  return {...meta,url:url.href,title:String(raw.title || meta.platform).slice(0,160),excerpt:String(raw.content || '').slice(0,500),
    published_at:raw.date || null,checked_at:new Date().toISOString()};
}
export async function collectTravelSources({destination='',query='',international=false,foreignQuery=''},search,{useCache=true}={}){
  const topic=String(query || destination+' 旅行').slice(0,50);
  const queries=[
    {channel:'中文旅行经验',text:'小红书 马蜂窝 穷游 '+destination.slice(0,20)+' '+topic.slice(0,45)+' 游记 旅行体验'},
    ...(international?[{channel:'海外旅行经验',text:'Reddit Caravanistan Tripadvisor '+String(foreignQuery || destination+' travel itinerary experience without car').slice(0,65)}]:[]),
    {channel:'目的地资料',text:topic+' 官方旅游 交通 开放 official tourism transport'}
  ];
  const settled=await Promise.allSettled(queries.map(async q=>{
    const hit=cache.get(q.text);
    if(useCache && hit?.until>Date.now())return hit.results;
    const results=await search(q.text,{limit:4,timeoutMs:15000}) || [];
    if(useCache && results.length)cache.set(q.text,{results,until:Date.now()+300000});
    if(cache.size>80)cache.delete(cache.keys().next().value);
    return results;
  }));
  const seen=new Set(),pool=[],channels=[];
  settled.forEach((item,i)=>{
    const results=item.status==='fulfilled' && Array.isArray(item.value)?item.value:[];
    const valid=results.map(cleanResult).filter(Boolean);
    channels.push({channel:queries[i].channel,status:valid.some(s=>i===queries.length-1 || s.kind==='experience')?'found':'unavailable'});
    for(const result of valid){
      const key=result.platform==='Trip.com'?'trip.com'+new URL(result.url).pathname.replace(/\/$/,''):result.url;
      if(seen.has(key))continue;seen.add(key);pool.push(result);
    }
  });
  /* 经验优先，同时给资料留位置；同一网站最多两条，避免一个平台占满。 */
  const counts=new Map();
  const diverse=pool.sort((a,b)=>(a.kind==='experience'?0:1)-(b.kind==='experience'?0:1)).filter(s=>{
    const count=counts.get(s.platform)||0;if(count>=2)return false;counts.set(s.platform,count+1);return true;
  });
  const sources=diverse.filter(s=>s.kind==='experience').slice(0,4).concat(diverse.filter(s=>s.kind!=='experience').slice(0,2));
  return {sources,channels,results:sources.map(s=>({title:s.title,link:s.url,content:s.excerpt,date:s.published_at,source_kind:s.kind,platform:s.platform}))};
}
