/* 数字声明逐项核对：用户条件与外部事实分别建表，不用整份上下文中的同数作依据。 */
import {loadPlaces} from './trip-service.mjs';
import {classifyTravelSource} from './travel-sources.mjs';
import {assessSourceTime,retrievalContext} from './source-time.mjs';

const AMOUNT='[-−负]?(?:(?:\\d{1,3}(?:[,，]\\d{3})+|\\d+)(?:\\.\\d+)?(?:万|千)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二三四五六七八九]+)?)';
const CURRENCY='人民币|美元|美金|欧元|日元|港币|港元|加元|澳元|新加坡元|坚戈|英镑|泰铢|卢布|韩元|越南盾|印度卢比|CNY|RMB|USD|EUR|JPY|HKD|CAD|AUD|SGD|KZT|GBP|THB|RUB|KRW|VND|INR|[¥￥$€₸£฿₽₩₹]|元|块钱|块';
const MEASURE='个?小时|分钟|公里|千米|km|hours?|minutes?';
const PATTERN=new RegExp('(?:(?:'+CURRENCY+')\\s*'+AMOUNT+'|'+AMOUNT+'\\s*(?:多|余)?(?:'+CURRENCY+'|'+MEASURE+'))','gi');
const RANGE=new RegExp('(?:(?:'+CURRENCY+')\\s*'+AMOUNT+'\\s*[-—–~～至到]\\s*'+AMOUNT+'|'+AMOUNT+'\\s*[-—–~～至到]\\s*'+AMOUNT+'\\s*(?:'+CURRENCY+'|'+MEASURE+'))','gi');
const UNPARSED_PRICE=new RegExp('(?:票价|价格|费用|房费|车票|机票|售价|报价|price|fare)\\s*(?:约为|参考为|大约|约|为|是|参考|需要|要|需)?\\s*(?:[A-Z]{3}|\\p{Sc})?\\s*('+AMOUNT+')\\s*[\\p{L}\\p{Sc}]*','giu');
const CODES={人民币:'CNY',元:'CNY',块钱:'CNY',块:'CNY',RMB:'CNY','¥':'CNY','￥':'CNY',美元:'USD',美金:'USD','$':'USD',欧元:'EUR','€':'EUR',日元:'JPY',港币:'HKD',港元:'HKD',加元:'CAD',澳元:'AUD',新加坡元:'SGD',坚戈:'KZT','₸':'KZT',英镑:'GBP','£':'GBP',泰铢:'THB','฿':'THB',卢布:'RUB','₽':'RUB',韩元:'KRW','₩':'KRW',越南盾:'VND',印度卢比:'INR','₹':'INR'};
const MODES={plane:/飞机|航班|机票|航空|flight|airline/i,rail:/火车|铁路|列车|高铁|train|rail/i,road:/班车|大巴|巴士|客运|bus|coach/i};
const PRICE=/票价|价格|费用|花费|成本|报价|每人|机票|车票|房费|门票|fare|price|cost/i;
const CONDITION=/预算|上限|控制在|最多|不超过|以内|至少|希望|要求|接受|愿意|预留/;
const EXTERNAL=/实际|当前|现价|售价|票价|票款|价格|收费|耗时|车程|距离|需时|用时|费用|fare|price|cost|duration|distance/i;
const REF=/资料|来源|报道|记载|参考|摘录/;
const UNCERTAIN=/待查|待确认|未核实|不代表|仅供参考|仍需确认|尚未确认/;
const BAD_SOURCE=/去年|往年|曾经|当年|历史|停运|停飞|尚未开通|并未开通|不再运营|不含|不包括|并非|不是/;
const UNIT=v=>{
  const s=v.toUpperCase();
  if(/小时|HOUR/.test(s))return ['duration','minute',60];
  if(/分钟|MINUTE/.test(s))return ['duration','minute',1];
  if(/公里|千米|KM/.test(s))return ['distance','km',1];
  return ['price',CODES[v] || CODES[s] || s,1];
};
function clauses(text){
  // 千位分隔符属于数字；每个事实保留自己的位置，后续同数不会回到首次出现处。
  const out=[];let start=0;
  for(let i=0;i<text.length;i++)if(/[。；;!?！？\n，,]/.test(text[i]) && !(/[，,]/.test(text[i]) && /\d/.test(text[i-1] || '') && /^\d{3}(?:\D|$)/.test(text.slice(i+1)))){
    if(i>start)out.push({text:text.slice(start,i),start});start=i+1;
  }
  if(start<text.length)out.push({text:text.slice(start),start});return out;
}
export function numericOccurrences(text=''){
  const parts=clauses(text),out=[],ranges=[...text.matchAll(RANGE)];
  for(const m of text.matchAll(PATTERN)){
    const n=m[0].match(new RegExp(AMOUNT))[0],number=numberValue(n);
    const rawUnit=m[0].replace(n,'').replace(/^[多余]/,'').trim(),[field,unit,factor]=UNIT(rawUnit),clause=parts.find(p=>m.index>=p.start && m.index<p.start+p.text.length);
    if(!Number.isFinite(number) || !clause)continue;
    out.push({text:m[0],start:m.index,end:m.index+m[0].length,field,unit,value:number*factor,range:ranges.some(r=>m.index>=r.index && m.index<r.index+r[0].length),approximate:/[多余]/.test(m[0]),clause:clause.text,clause_start:clause.start});
  }
  for(const m of text.matchAll(UNPARSED_PRICE)){
    const start=m.index+m[0].indexOf(m[1]);
    if(out.some(f=>start>=f.start && start<f.end))continue;
    const clause=parts.find(p=>start>=p.start && start<p.start+p.text.length);
    if(clause)out.push({text:m[0],start,end:m.index+m[0].length,field:'price',unit:'unknown',value:numberValue(m[1]),unsupported_unit:true,clause:clause.text,clause_start:clause.start});
  }
  return out.sort((a,b)=>a.start-b.start);
}
function numberValue(text){
  if(/^[-−负]/.test(text))return -numberValue(text.slice(1));
  if(/^\d/.test(text))return Number(text.replace(/[,，万千]/g,''))*(text.endsWith('万')?10000:text.endsWith('千')?1000:1);
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000,万:10000,亿:100000000};
  const [integer,decimal]=text.split('点');
  if(!/[十百千万亿]/.test(integer))return Number([...integer].map(x=>digits[x]).join(''))+(decimal?Number('0.'+[...decimal].map(x=>digits[x]).join('')):0);
  let total=0,section=0,digit=0;
  for(const ch of integer){if(Object.hasOwn(digits,ch))digit=digits[ch];else if(units[ch]<10000){section+=(digit || 1)*units[ch];digit=0;}else{section+=digit;total=(total+section)*units[ch];section=0;digit=0;}}
  return total+section+digit+(decimal?Number('0.'+[...decimal].map(x=>digits[x]).join('')):0);
}
const canon=s=>String(s || '').toLowerCase().replace(/[\s“”"'：:（）()]/g,'');
function placesIn(text){
  const hits=[];
  for(const p of loadPlaces())for(const name of [p.name,...p.aliases || []]){
    if(!name || name.length<2)continue;
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(/^[a-z ]+$/i.test(name)?'\\b'+escaped+'\\b':escaped,'i'),m=re.exec(text);
    if(m){hits.push({name:p.name,start:m.index,end:m.index+m[0].length});break;}
  }
  return hits.sort((a,b)=>a.start-b.start || b.end-a.end).filter((p,i,a)=>!a.slice(0,i).some(x=>p.start>=x.start && p.end<=x.end));
}
function subjectFor(clause,occurrence){
  const modes=Object.entries(MODES).filter(([,re])=>re.test(clause)).map(([k])=>k),hits=placesIn(clause);
  if(modes.length){
    // 运营数字必须在同一事实分句明确方向；城市共现、用户路线或文章标题不能补造方向。
    if(modes.length!==1 || hits.length!==2)return null;
    const between=clause.slice(hits[0].end,hits[1].start);
    if(!/^(?:\s*(?:到|至|→|⇄|—|–|-|to|往|飞往)\s*)$/i.test(between))return null;
    if(/⇄/.test(between))return null;
    return {type:'transport',from:hits[0].name,to:hits[1].name,mode:modes[0]};
  }
  // 非交通对象保留完整实体短语；缩略指代无法确定对象时，不放行外部数字。
  const prefix=clause.slice(0,occurrence.start-occurrence.clause_start).replace(/^(?:据|根据)?(?:资料|来源|报道)(?:显示|记载|称)?[：:\s]*/,'');
  const entity=prefix.replace(/(?:门票|票价|价格|费用|花费|成本|报价|收费|距离|耗时|需时|用时|为|是|约|大约|仅|共|需|需要|目前|当前)+$/g,'').trim();
  if(entity.length<3 || /^(?:该|这|其|它)/.test(entity) || /^(?:博物馆|公园|景点|酒店|餐厅|票价|价格|交通)$/.test(entity))return null;
  return {type:'entity',entity:canon(entity)};
}
function sameSubject(a,b){return !!a && !!b && JSON.stringify(a)===JSON.stringify(b);}
function conditionKind(f,all){
  const previous=all.filter(x=>x.end<=f.start && x.clause_start===f.clause_start).at(-1);
  const left=f.clause.slice(previous?previous.end-f.clause_start:0,f.start-f.clause_start),right=f.clause.slice(f.end-f.clause_start);
  const labels=[...left.matchAll(/预算|上限|控制在|最多|不超过|至少|预留|票价|价格|费用|实际|收费|耗时|距离|车程/g)];
  const label=labels.at(-1)?.[0];
  if(/(?:就是|即为|等于|保证|确保|实际).*(?:票价|价格|费用|耗时|距离)/.test(right))return false;
  return !!label && CONDITION.test(label) && !EXTERNAL.test(label) || !EXTERNAL.test(left) && /^(?:以内|以下|上限|预算)/.test(right);
}
function conditionMatches(f,all,{constraints={},text=''}){
  if(!conditionKind(f,all))return false;
  if(f.field==='price' && f.unit==='CNY' && constraints.budget_max_cny===f.value)return true;
  if(f.field==='duration' && /换乘|转机|中转/.test(f.clause) && constraints.max_layover_hours*60===f.value)return true;
  const given=numericOccurrences(text);
  return given.some(x=>x.field===f.field && x.unit===f.unit && x.value===f.value && conditionKind(x,given));
}
function outputStrings(value){
  const out=[];
  const walk=(v,path)=>{if(typeof v==='string')out.push({path,text:v});else if(Array.isArray(v))v.forEach((x,i)=>walk(x,path+'.'+i));else if(v && typeof v==='object')for(const [key,x]of Object.entries(v))if(key!=='id')walk(x,path+'.'+key);};
  if(typeof value?.reply==='string')walk(value.reply,'reply');if(value?.draft)walk(value.draft,'draft');return out;
}
export function buildNumericCatalog({sources=[],transport=[],retrieval={},now=Date.now()}={}){
  const facts=[],seen=new Set();
  const candidates=sources.concat(transport.flatMap(section=>(section.options || []).map(r=>({...r.source,valid_from:r.schedule?.start,valid_until:r.schedule?.end || r.reported_until,validity_basis:r.schedule?'schedule':null}))));
  for(const source of candidates){
    const url=source.url || source.link,meta=classifyTravelSource(url);
    if(!meta || meta.kind==='experience' || [source.kind,source.source_kind].includes('experience') || source.allowed_use==='travel_experience' || source.kind==='place_background' || ['historical','expired','outside_window','future','after_trip','undated'].includes(source.temporal?.state))continue;
    const time=assessSourceTime({...source,published_at:source.published_at || source.date},retrievalContext({window:retrieval.target_window,purpose:'transport',now}));
    if(!['recent','window_reference'].includes(time.state))continue;
    const excerpt=source.excerpt || source.content || '';
    for(const f of numericOccurrences(excerpt)){
      if(f.unsupported_unit || f.range || f.approximate || f.value<0 || BAD_SOURCE.test(f.clause) || CONDITION.test(f.clause) || /\b(?:19|20)\d{2}年/.test(f.clause) && [...f.clause.matchAll(/((?:19|20)\d{2})年/g)].some(x=>Number(x[1])<Number(time.published_at?.slice(0,4))))continue;
      if(f.field==='price' && !PRICE.test(f.clause))continue;
      if(f.field==='duration' && !/耗时|需时|用时|车程|航程|行程|duration|takes?/i.test(f.clause))continue;
      if(f.field==='distance' && !/距离|相距|路程|里程|distance/i.test(f.clause))continue;
      const subject=subjectFor(f.clause,f);if(!subject)continue;
      const key=JSON.stringify([url,subject,f.field,f.unit,f.value,f.start]);if(seen.has(key))continue;seen.add(key);
      facts.push({id:'number_'+(facts.length+1),field:f.field,value:f.value,unit:f.unit,subject,source_url:url,evidence_quote:f.clause,published_at:time.published_at,read_status:source.read_status || 'search_excerpt',
        valid_from:source.valid_from || null,valid_until:source.valid_until || null,date_scope:time.date_scope,allowed_use:'source_reference'});
    }
  }
  return facts.slice(0,32);
}
export function validateNumericClaims(value,{catalog=[],constraints={},text=''}={}){
  const rejected=[],grounded=[];
  for(const item of outputStrings(value)){
    const occurrences=numericOccurrences(item.text);
    for(const [occurrence,f]of occurrences.entries()){
      if(f.unsupported_unit || f.range || f.approximate){rejected.push({path:item.path,occurrence,text:f.text,reason:'币种、范围或模糊数值缺少可核对的完整事实'});continue;}
      if(conditionMatches(f,occurrences,{constraints,text})){grounded.push({path:item.path,occurrence,field:'user_condition',value:f.value,unit:f.unit});continue;}
      const prefix=f.clause.slice(0,f.start-f.clause_start);
      const unknown=[...prefix.matchAll(/(?:无法|不能|尚未|未能).{0,20}(?:确认|证实|判断|证明|核实|支持)|不足以.{0,12}(?:证明|支持)|没有.{0,8}(?:依据|证据).{0,12}(?:确认|证明|断言)/g)].at(-1);
      if(unknown && !/但是|但|不过|然而|而是|实际上|确实|就是|已经确认/.test(prefix.slice(unknown.index+unknown[0].length)) && numericOccurrences(text).some(x=>x.field===f.field && x.unit===f.unit && x.value===f.value)){
        grounded.push({path:item.path,occurrence,field:'unverified_user_question',value:f.value,unit:f.unit});continue;
      }
      const subject=subjectFor(f.clause,f);
      const fact=catalog.find(c=>c.field===f.field && c.unit===f.unit && c.value===f.value && sameSubject(c.subject,subject));
      // 网页数值只允许作为来源参考。即使适用期覆盖，也不据摘录证明当前可售、余票或保证完成。
      const sentenceStart=Math.max(item.text.lastIndexOf('。',f.start-1),item.text.lastIndexOf('\n',f.start-1))+1;
      const tail=item.text.slice(f.end).search(/[。！？\n]/),sentence=item.text.slice(sentenceStart,tail<0?undefined:f.end+tail);
      const following=tail<0?'':item.text.slice(f.end+tail+1).split(/[。！？\n]/)[0];
      const qualifier=/^(?:这|该|仅供参考|本次|出行日期)/.test(following.trim())?following:'';
      const reference=REF.test(sentence) && UNCERTAIN.test(sentence+qualifier) && !/当前|目前|现价|已核实|保证|确保|一定|实际(?:票价|价格)|符合预算/.test(f.clause);
      if(fact && reference){grounded.push({path:item.path,occurrence,...fact});continue;}
      rejected.push({path:item.path,occurrence,text:f.text,field:f.field,subject,reason:!fact?'缺少同字段、单位、对象和方向的可用来源':'来源数值只支持参考，当前可用性或指定日期仍待确认'});
    }
  }
  return {rejected,grounded};
}
