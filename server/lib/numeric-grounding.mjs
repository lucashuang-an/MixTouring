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
const WORDS=new Intl.Segmenter('zh-CN',{granularity:'word'});
const CHARGES={baggage:/行李(?:费用|费)?|托运费|baggage(?: fee)?/gi,tax:/税费|燃油附加费|机场建设费|tax(?:es)?/gi,
  fare:/机票(?:价格|费用|票价)?|车票(?:价格|费用|票价)?|票价|票款|fare/gi,admission:/门票(?:价格|费用)?|入场费/gi,
  lodging:/房费|房价|住宿费/gi,transfer:/接驳费|接送费/gi,meal:/餐费|餐饮费/gi,total:/总费用|总价|全程费用|合计费用/gi};
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
    if(!clause)continue;
    out.push({text:m[0],start:m.index,end:m.index+m[0].length,field,unit,value:Number.isFinite(number)?number*factor:null,unsupported_number:!Number.isFinite(number),range:ranges.some(r=>m.index>=r.index && m.index<r.index+r[0].length),approximate:/[多余]/.test(m[0]),clause:clause.text,clause_start:clause.start});
  }
  for(const m of text.matchAll(UNPARSED_PRICE)){
    const start=m.index+m[0].indexOf(m[1]);
    if(out.some(f=>start>=f.start && start<f.end))continue;
    if(!bareMoneyToken(text,start,m[1]))continue;
    const clause=parts.find(p=>start>=p.start && start<p.start+p.text.length);
    if(clause)out.push({text:m[0],start,end:m.index+m[0].length,field:'price',unit:'unknown',value:numberValue(m[1]),unsupported_unit:true,clause:clause.text,clause_start:clause.start});
  }
  for(const f of out){
    const before=text.slice(0,f.start),after=text.slice(f.end),boundary=before.match(/[。；;!?！？\n]/g);
    const start=boundary?before.lastIndexOf(boundary.at(-1))+1:0,tail=after.search(/[。；;!?！？\n]/);
    f.sentence_start=start;f.sentence=text.slice(start,tail<0?undefined:f.end+tail);
  }
  return out.sort((a,b)=>a.start-b.start);
}
function bareMoneyToken(text,start,number){
  if(/\d/.test(number))return true;
  const end=start+number.length,tail=text.slice(end),wordEnds=new Set([...WORDS.segment(text)].map(s=>s.index+s.segment.length));
  if(!wordEnds.has(end))return false; // “一般／一律／三思”等完整词内部不是裸金额。
  if(/^\s*(?:$|[。；;，,!?！？\n）)]|[A-Z]{3}\b|\p{Sc}|比索|法郎|里拉|第纳尔|克朗|卢比|雷亚尔)/u.test(tail))return true;
  if(/^(?:别|不要|不能|不应|勿)/.test(tail))return false;
  if(number.length===1)return /^(?:起|左右|上下|已定|已确认|已核实|即可)/.test(tail);
  // 无币种时采用规范数词形态；“万一”等词不能因包含数词而变成价格。
  return /^[负−-]?[零〇一二两三四五六七八九十]/.test(number);
}
function numberValue(text){
  if(/^[-−负]/.test(text))return -numberValue(text.slice(1));
  if(/^\d/.test(text))return Number(text.replace(/[,，万千]/g,''))*(text.endsWith('万')?10000:text.endsWith('千')?1000:1);
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000,万:10000,亿:100000000};
  const [integer,decimal]=text.split('点');
  if(!/[十百千万亿]/.test(integer))return Number([...integer].map(x=>digits[x]).join(''))+(decimal?Number('0.'+[...decimal].map(x=>digits[x]).join('')):0);
  if(/[百千万亿][一二两三四五六七八九]$/.test(integer))return NaN; // “一万二／二百五”不擅自选一个精确值。
  const parse=s=>{
    if(!s)return 0;
    let at=-1,unit=0;
    for(let i=0;i<s.length;i++)if((units[s[i]] || 0)>=unit && units[s[i]]){at=i;unit=units[s[i]];}
    if(at<0)return Number([...s].map(x=>digits[x]).join(''));
    return (at?parse(s.slice(0,at)):1)*unit+parse(s.slice(at+1));
  };
  return parse(integer)+(decimal?Number('0.'+[...decimal].map(x=>digits[x]).join('')):0);
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
function ownPhrase(f,all){
  const previous=all.filter(x=>x.end<=f.start && x.clause_start===f.clause_start).at(-1);
  const next=all.find(x=>x.start>=f.end && x.clause_start===f.clause_start);
  return {left:f.clause.slice(previous?previous.end-f.clause_start:0,f.start-f.clause_start),right:f.clause.slice(f.end-f.clause_start,next?next.start-f.clause_start:undefined)};
}
function chargeDescriptor(text){
  const hits=Object.entries(CHARGES).flatMap(([item,re])=>[...text.matchAll(re)].map(m=>({item,start:m.index,end:m.index+m[0].length})));
  const ordered=hits.filter(h=>!hits.some(x=>x!==h && x.start<=h.start && x.end>=h.end && x.end-x.start>h.end-h.start)).sort((a,b)=>a.start-b.start);
  const last=ordered.at(-1);if(!last)return {item:'unspecified',components:[]};
  let at=ordered.length-1;
  if(last.item==='total' && at && /^(?:\s|合计|共|一共|等|的)*$/.test(text.slice(ordered[at-1].end,last.start)))at--;
  const group=[ordered[at].item];
  while(at>0 && /^\s*(?:和|与|及|以及|加|加上|、|\+|包括|包含|含)\s*$/.test(text.slice(ordered[at-1].end,ordered[at].start))){group.push(ordered[--at].item);}
  const components=[...new Set(group)].sort();
  return components.length>1?{item:last.item==='total'?'total':'composite',components}:{item:last.item,components:[]};
}
const chargeItem=text=>chargeDescriptor(text).item;
function conditionIdentity(f,all,{user=false}={}){
  const {left,right}=ownPhrase(f,all);
  if(/(?:就是|即为|等于|保证|确保|实际|足够|够买|能买|可买).*(?:票价|价格|费用|耗时|距离|机票)|(?:足够|够买|能买|可买)/.test(right))return null;
  const fragment=left.split(/但是|但|不过|然而|而是/).at(-1);
  const wish=/(?:你|用户)(?:希望|要求|接受|愿意|想)|按你(?:的)?(?:要求|目标)/.test(fragment) || user && /我(?:们)?(?:希望|要求|接受|愿意|想|最多)/.test(fragment);
  const attributed=/(?:你|用户)(?:希望|要求|接受|愿意|想|最多|的(?:目标|预算|上限))|按你(?:的)?(?:要求|目标|预算)/.test(fragment) || user && /我(?:们)?(?:希望|要求|接受|愿意|想|最多)/.test(fragment);
  // “最多／不超过”是比较关系，不是用户授权。必须明示预算字段或归属用户的目标。
  if(!wish && /(?:实际|当前|现价|真实|已核实|已确认|保证|确保).*(?:票价|价格|费用|耗时|距离|车程)|(?:票价|价格|费用|耗时|距离|车程).*(?:实际|当前|保证|确保)/.test(fragment))return null;
  if(/(?:票价|价格|费用).*(?:就是|等于|即为).*(?:预算|上限)|(?:预算|上限).*(?:就是|等于|即为).*(?:票价|价格|费用)/.test(fragment))return null;
  if(f.field==='price'){
    const trailingBudget=new RegExp('^[）)“”"\\s]*(?:以内|以下)?(?:是|为|作为)?(?:你|用户'+(user?'|我':'')+')的(?:预算|目标|上限)').test(right);
    if(!/预算/.test(fragment) && !trailingBudget && !(attributed && CONDITION.test(fragment+right)))return null;
    return {kind:'budget',scope:chargeItem(fragment)==='unspecified'?'trip':chargeItem(fragment)};
  }
  if(!attributed || !CONDITION.test(fragment+right))return null;
  return {kind:f.field,scope:/换乘|转机|中转/.test(fragment)?'layover':/游玩|参观|停留/.test(fragment)?'visit':'general'};
}
function conditionMatches(f,all,{constraints={},text=''}){
  const identity=conditionIdentity(f,all);if(!identity)return false;
  if(f.field==='price' && identity.scope==='trip' && f.unit==='CNY' && constraints.budget_max_cny===f.value)return {...identity,key:'budget_max_cny',origin:'current_conditions'};
  if(f.field==='duration' && identity.scope==='layover' && constraints.max_layover_hours*60===f.value)return {...identity,key:'max_layover_hours',origin:'current_conditions'};
  const given=numericOccurrences(text);
  return given.some(x=>!x.unsupported_number && !x.unsupported_unit && !x.range && !x.approximate && x.field===f.field && x.unit===f.unit && x.value===f.value && JSON.stringify(conditionIdentity(x,given,{user:true}))===JSON.stringify(identity))?{...identity,origin:'current_user_message'}:null;
}
function uncertainQualifier(text,start,end,patterns=[]){
  const clause=clauses(text).find(c=>start>=c.start && start<c.start+c.text.length);
  if(!clause)return true;
  const prefix=text.slice(clause.start,start).split(/但是|但|不过|然而|而是/).at(-1);
  if(/未说明|未注明|未标明|未确定|未确认|没有说明|没有注明|是否|不清楚|不确定|尚不明确/.test(prefix))return true;
  let tail=text.slice(end,clause.start+clause.text.length);
  for(const re of patterns)tail=tail.replace(new RegExp(re.source,re.flags.replace('g','')+'g'),'');
  return /^(?:还是|或者|或|和|及|与|、|\/|情况|与否|信息|口径|状态|都|\s)*(?:(?:尚未|未|没有)(?:说明|注明|标明|确认|确定)|不清楚|不确定|待查|待确认)/.test(tail);
}
function singleQualifier(text,options){
  const found=Object.entries(options).filter(([,re])=>[...text.matchAll(new RegExp(re.source,re.flags.replace('g','')+'g'))]
    .some(m=>!uncertainQualifier(text,m.index,m.index+m[0].length,Object.values(options)))).map(([key])=>key);
  return found.length>1?'ambiguous':found[0] || 'unspecified';
}
function quantityMeaning(f,all){
  const {left,right}=ownPhrase(f,all);
  const nextItem=Object.values(CHARGES).flatMap(re=>[...right.matchAll(re)].map(m=>m.index)).sort((a,b)=>a-b)[0];
  const local=left+f.text+right.slice(0,nextItem ?? right.length);
  const phrase=f.sentence && all.filter(x=>x.field===f.field && x.sentence_start===f.sentence_start).length===1?f.sentence:local;
  if(f.field==='price'){
    const charge=chargeDescriptor(left),basis=singleQualifier(phrase,{per_person:/每人|人均|每位|per person/i,party_total:/总(?:票)?价|合计|总费用|全程费用/});
    const count=phrase.match(new RegExp('('+AMOUNT+')\\s*(?:人|位)'));
    const billing=singleQualifier(phrase,{piece:/每件|每包|per bag|per item/i,night:/每晚|每夜|per night/i,segment:/每段|每程|per segment/i,vehicle:/每车|每辆|per vehicle/i,kg:/每公斤|每千克|per kg/i});
    const quantity=[...phrase.matchAll(new RegExp('('+AMOUNT+')\\s*(公斤|千克|kg|件|包|晚|夜|段|程)','gi'))].find(m=>phrase[m.index-1]!=='第' && !uncertainQualifier(phrase,m.index,m.index+m[0].length));
    const quantityUnit=quantity?({公斤:'kg',千克:'kg',kg:'kg',件:'piece',包:'piece',晚:'night',夜:'night',段:'segment',程:'segment'}[quantity[2].toLowerCase()]):['piece','night','segment','vehicle','kg'].includes(billing)?billing:null;
    return {...charge,trip:singleQualifier(phrase,{one_way:/单程|单向|one[- ]way/i,round_trip:/往返|双程|round[- ]trip/i}),
      basis,party_size:count && !uncertainQualifier(phrase,count.index,count.index+count[0].length)?numberValue(count[1]):basis==='per_person'?1:null,
      billing_unit:billing,quantity_count:quantity?numberValue(quantity[1]):quantityUnit?1:null,quantity_unit:quantityUnit,
      passenger:singleQualifier(phrase,{adult:/成人/,child:/儿童|小孩/,student:/学生/,senior:/老人|老年/}),
      tax:singleQualifier(phrase,{included:/(?<![不未])含税|税费已含|已含税费/,excluded:/不含税|未含税|税费另计/}),
      cabin:singleQualifier(phrase,{economy:/经济舱/,business:/商务舱/,first:/头等舱/})};
  }
  if(f.field==='duration'){
    const kind=singleQualifier(phrase,{layover:/中转|换乘|候机/,visit:/游玩|参观|游览|停留/,transfer:/站点接驳|市内接驳/});
    return {kind:kind==='unspecified'?'travel':kind};
  }
  return {kind:singleQualifier(phrase,{straight_line:/直线|大圆|飞行距离/,road:/公路|道路|行驶距离/,walking:/步行|徒步/})};
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
    const occurrences=numericOccurrences(excerpt);
    for(const f of occurrences){
      const sourceClause=f.clause.replace(/不含税(?:费)?|未含税(?:费)?|税费另计/g,'税费未含');
      if(f.unsupported_number || f.unsupported_unit || f.range || f.approximate || f.value<0 || BAD_SOURCE.test(sourceClause) || CONDITION.test(f.clause) || /\b(?:19|20)\d{2}年/.test(f.clause) && [...f.clause.matchAll(/((?:19|20)\d{2})年/g)].some(x=>Number(x[1])<Number(time.published_at?.slice(0,4))))continue;
      if(f.field==='price' && !PRICE.test(f.clause) && chargeItem(f.clause)==='unspecified')continue;
      if(f.field==='duration' && !/耗时|需时|用时|车程|航程|行程|duration|takes?/i.test(f.clause))continue;
      if(f.field==='distance' && !/距离|相距|路程|里程|distance/i.test(f.clause))continue;
      const subject=subjectFor(f.clause,f);if(!subject)continue;
      const meaning=quantityMeaning(f,occurrences);if(Object.values(meaning).includes('ambiguous'))continue;
      const key=JSON.stringify([url,subject,f.field,f.unit,f.value,f.start]);if(seen.has(key))continue;seen.add(key);
      facts.push({id:'number_'+(facts.length+1),field:f.field,value:f.value,unit:f.unit,subject,meaning,source_url:url,evidence_quote:f.sentence || f.clause,published_at:time.published_at,read_status:source.read_status || 'search_excerpt',
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
      if(f.unsupported_number || f.unsupported_unit || f.range || f.approximate){rejected.push({path:item.path,occurrence,text:f.text,reason:'币种、范围或模糊数值缺少可核对的完整事实'});continue;}
      const condition=conditionMatches(f,occurrences,{constraints,text});
      if(condition){grounded.push({path:item.path,occurrence,field:'user_condition',value:f.value,unit:f.unit,condition_ref:condition});continue;}
      const prefix=f.clause.slice(0,f.start-f.clause_start);
      const unknown=[...prefix.matchAll(/(?:无法|不能|尚未|未能).{0,20}(?:确认|证实|判断|证明|核实|支持|断定|推断)|不足以.{0,12}(?:证明|支持)|没有.{0,8}(?:依据|证据).{0,12}(?:确认|证明|断言)/g)].at(-1);
      if(unknown && !/但是|但|不过|然而|而是|实际上|确实|就是|已经确认/.test(prefix.slice(unknown.index+unknown[0].length)) && numericOccurrences(text).some(x=>x.field===f.field && x.unit===f.unit && x.value===f.value)){
        grounded.push({path:item.path,occurrence,field:'unverified_user_question',value:f.value,unit:f.unit});continue;
      }
      const subject=subjectFor(f.clause,f);
      const meaning=quantityMeaning(f,occurrences);
      const fact=catalog.find(c=>c.field===f.field && c.unit===f.unit && c.value===f.value && sameSubject(c.subject,subject) && JSON.stringify(c.meaning)===JSON.stringify(meaning));
      // 网页数值只允许作为来源参考。即使适用期覆盖，也不据摘录证明当前可售、余票或保证完成。
      const sentenceStart=Math.max(item.text.lastIndexOf('。',f.start-1),item.text.lastIndexOf('\n',f.start-1))+1;
      const tail=item.text.slice(f.end).search(/[。！？\n]/),sentence=item.text.slice(sentenceStart,tail<0?undefined:f.end+tail);
      const following=tail<0?'':item.text.slice(f.end+tail+1).split(/[。！？\n]/)[0];
      const qualifier=/^(?:这|该|仅供参考|本次|出行日期)/.test(following.trim())?following:'';
      const reference=REF.test(sentence) && UNCERTAIN.test(sentence+qualifier) && !/当前|目前|现价|已核实|保证|确保|一定|实际(?:票价|价格)|符合预算/.test(f.clause);
      if(fact && reference){grounded.push({path:item.path,occurrence,...fact});continue;}
      rejected.push({path:item.path,occurrence,text:f.text,field:f.field,subject,meaning,reason:!fact?'缺少同字段、单位、对象、方向及收费项目／计价口径的可用来源':'来源数值只支持参考，当前可用性或指定日期仍待确认'});
    }
  }
  return {rejected,grounded};
}
