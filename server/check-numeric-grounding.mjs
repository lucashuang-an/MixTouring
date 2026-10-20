/* 数字事实真实编排回归：同数不同义、方向／币种／用途／时效，以及合法预算不误拦。 */
import assert from 'node:assert/strict';
import {buildNumericCatalog,validateNumericClaims,numericOccurrences} from './lib/numeric-grounding.mjs';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
const now=Date.parse('2026-10-20T04:00:00Z');
const source=(excerpt,over={})=>({url:'https://example.com/fare',excerpt,published_at:'2026-10-01',read_status:'page_excerpt',...over});
const fare=source('北京到阿拉木图航班票价8000元');
const catalog=buildNumericCatalog({sources:[fare],now});
assert.equal(catalog.length,1);assert.equal(catalog[0].subject.from,'北京');assert.equal(catalog[0].subject.to,'阿拉木图');
assert.equal(catalog[0].unit,'CNY');assert.equal(catalog[0].source_url,fare.url);assert.equal(catalog[0].allowed_use,'source_reference');
const reference='来源显示北京到阿拉木图航班票价8000元，仅供参考，本次日期仍待确认。';
assert.equal(validateNumericClaims({reply:reference},{catalog}).rejected.length,0);
assert.equal(validateNumericClaims({reply:'资料记载，北京到阿拉木图的航班票价参考为8000元。这只是资料参考，本次日期仍待确认。'},{catalog}).rejected.length,0,'来源引导语与紧邻限定语可跨分句，不误拦合法引用');
for(const text of [
 '来源显示阿拉木图到北京航班票价8000元，仅供参考，本次日期待确认。',
 '来源显示上海到东京航班票价8000元，仅供参考，本次日期待确认。',
 '来源显示北京到阿拉木图火车票价8000元，仅供参考，本次日期待确认。',
 '来源显示北京到阿拉木图航班票价8000美元，仅供参考，本次日期待确认。',
 '来源显示北京到阿拉木图航班耗时8000分钟，仅供参考，本次日期待确认。',
 '当前北京到阿拉木图航班票价8000元。',
 '北京到阿拉木图航班票价8000元。另一个问题资料仍待确认。'
])assert.equal(validateNumericClaims({reply:text},{catalog}).rejected.length,1,text);
for(const over of [
 {url:'https://www.reddit.com/r/travel/comments/synthetic/almaty/'},
 {kind:'experience'},{allowed_use:'travel_experience'},{kind:'place_background'},
 {published_at:'2020-01-01'},{published_at:null},{published_at:'2026-11-01'},
 {valid_until:'2026-09-01'},{temporal:{state:'outside_window'}}
])assert.equal(buildNumericCatalog({sources:[source(fare.excerpt,over)],now}).length,0,JSON.stringify(over));
assert.equal(buildNumericCatalog({sources:[source('阿拉木图公园每日20时关门')],now}).length,0);
assert.equal(buildNumericCatalog({sources:[source('北京到阿拉木图航班去年票价8000元')],now}).length,0);
assert.equal(buildNumericCatalog({sources:[fare],retrieval:{target_window:'2026-09-01 ~ 2026-09-02'},now}).length,0,'晚于历史出行的资料不能回填');
assert.equal(buildNumericCatalog({sources:[source(fare.excerpt,{valid_from:'2026-10-01',valid_until:'2026-10-31'})],retrieval:{target_window:'2027-01-01 ~ 2027-01-02'},now}).length,0);
assert.equal(buildNumericCatalog({transport:[{directions:[{source:fare}],archive:[{source:fare}]}],now}).length,0,'方向与历史存档不提供当前数字');
for(const text of ['$2,000','USD 2000','2000美元','2千美元']){
 const f=numericOccurrences(text)[0];assert.equal(f.value,2000);assert.equal(f.unit,'USD');
 assert.equal(validateNumericClaims({reply:'航班票价'+text+'。'}).rejected.length,1);
}
for(const text of ['票价八千元。','票价八千多元。','票价8000—10000元。','票价USD 8000-10000。','票价USD -8000。','票价2000比索。','票价MXN 2000。','票价2000。'])assert.ok(validateNumericClaims({reply:text}).rejected.length,text+'不能绕过数字检查');
assert.equal(numericOccurrences('二零零零美元')[0].value,2000);
assert.equal(validateNumericClaims({reply:'预算八千元，实际费用待查。'},{constraints:{budget_max_cny:8000}}).rejected.length,0);
const duration=buildNumericCatalog({sources:[source('北京到阿拉木图航班耗时2小时')],now});
assert.equal(validateNumericClaims({reply:'资料记载北京到阿拉木图航班耗时120分钟，仅供参考，本次日期待确认。'},{catalog:duration}).rejected.length,0,'只允许确定性的同量纲换算');
const budget={constraints:{budget_max_cny:8000},text:'预算上限8000元，先讨论。'};
assert.equal(validateNumericClaims({reply:'预算8000元，实际费用待查。'},budget).rejected.length,0);
assert.equal(validateNumericClaims({reply:'预算8000元，实际费用待查。当前机票价格8000元。'},budget).rejected.length,1,'重复同数字各自检查位置');
assert.equal(validateNumericClaims({reply:'预算8000元，实际费用待查。',draft:{cards:[{id:'c1',content:'当前机票价格8000元。'}]}},budget).rejected[0].path,'draft.cards.0.content','回复预算不能给卡片票价作依据');
assert.equal(validateNumericClaims({reply:'无法确认票价是否为8000元。'},{text:'票价是不是8000元？'}).rejected.length,0,'可以如实回答用户提出的价格尚未确认');
assert.equal(validateNumericClaims({reply:'这份资料不能证明航班票价20元。'},{text:'资料能证明机票20元吗？'}).rejected.length,0,'不能证明用户提出的数字不是价格承诺');
assert.equal(validateNumericClaims({reply:'无法确认班次但票价确实20元。'},{text:'票价20元吗？'}).rejected.length,1,'否定知识不能掩护后续肯定价格');
assert.equal(validateNumericClaims({reply:'航班耗时2小时。'},{text:'我最多接受2小时。'}).rejected.length,1,'用户时长要求不变成运营耗时');

const brief={origin:'',destination:'',summary:'先讨论旅行方式',wishes:[],open_questions:[]};
const input={text:budget.text,current_message:{mid:1,role:'user',text:budget.text},conversation:cleanConversation({brief}),constraints:budget.constraints};
function output(reply,extra={}){return {intent_action:'question',reply,brief,ready:false,preferences:{},travel:{},constraints:{},requirements_patch:{},...extra};}
for(const [name,reply,material]of [
 ['同值预算与票价','预算8000元。我会先比较沿途城市、住宿安排和交通取舍，再查清关键连接。当前机票价格8000元。',null],
 ['无关时刻','北京到阿拉木图航班当前票价为20元。',source('阿拉木图公园每日20时关门')],
 ['其他方向','北京到阿拉木图航班当前票价为8000元。',source('上海到东京航班票价8000元')],
 ['经验与币种','阿拉木图班车当前票价为2000元。',source('在阿拉木图乘车花了2000坚戈',{url:'https://www.reddit.com/r/travel/comments/synthetic/almaty/'})],
 ['前置美元','该航班当前票价是$2000。',null],['前置币种','该航班当前票价是USD 2000。',null]
]){
 let corrections=0;
 const r=await conversationTurn(input,null,{now,search:async()=>material?[{title:'合成资料',link:material.url,content:material.excerpt,date:material.published_at}]:[],model:async o=>{
  const c=JSON.parse(o.user);if(c.correction){corrections++;return output('预算8000元，实际费用待查。');}
  if(material && !c.search_complete)return output('先查询资料。',{search_query:'阿拉木图 交通'});
  return output(reply);
 }});
 assert.equal(r.status,'ok',name);assert.equal(corrections,1,name+'触发真实纠正分支');assert.equal(r.reply,'预算8000元，实际费用待查。');
}
{
 let calls=0;const r=await conversationTurn(input,null,{now,model:async()=>{calls++;return output('预算8000元，实际费用待查。');}});
 assert.equal(r.status,'ok');assert.equal(calls,1,'合法预算直接通过，不浪费纠正调用');
 assert.equal(r.numeric_grounding[0].field,'user_condition');
}
{
 const r=await conversationTurn(input,null,{now,search:async()=>[{title:'合成航班资料',link:fare.url,content:fare.excerpt,date:fare.published_at}],model:async o=>{
  const c=JSON.parse(o.user);if(!c.search_complete)return output('先查询资料。',{search_query:'北京 阿拉木图 航班'});
  assert.ok(c.numeric_fact_catalog.some(f=>f.subject.from==='北京' && f.unit==='CNY'),'主模型实际收到结构化记录');
  return output(reference);
 }});
 assert.equal(r.status,'ok');assert.equal(r.numeric_grounding[0].source_url,fare.url);
 assert.ok(r.sources.some(s=>s.url===fare.url),'实际支撑数字的来源进入用户引用列表');
}
{
 const travelBrief={...brief,origin:'北京',destination:'阿拉木图'},before=cleanConversation({stage:'ready',brief:travelBrief});
 const draft={title:'探索草案',overview:'班期与接驳待查。',route:['北京','阿拉木图'],cards:[{id:'a',place:'阿拉木图',label:'目的地阶段',title:'参考资料',content:reference}],sections:[],pending:['本次日期及运营待查']};
 for(const unsafe of [false,true]){
  let reviewed=false;
  const r=await conversationTurn({action:'generate',text:'生成草案',conversation:before},null,{now,search:async()=>[{title:'合成航班资料',link:fare.url,content:fare.excerpt,date:fare.published_at}],model:async o=>{
   const c=JSON.parse(o.user);
   if(o.kind==='conversation_review'){
    reviewed=true;assert.ok(c.numeric_fact_catalog.length,'草案校对也读取当前事实表');
    return {reply:'已整理草案。',draft:unsafe?{...draft,cards:[{...draft.cards[0],content:'航班当前票价8000美元。'}]}:draft};
   }
   return {...output('已整理草案。'),brief:travelBrief,ready:true,draft};
  }});
  assert.ok(reviewed);assert.equal(r.status,unsafe?'unavailable':'ok','校对后再次守门');
  if(unsafe)assert.equal(r.conversation.draft,null,'拒绝校对产生的无依据数值，原状态保留');
  else assert.ok(r.numeric_grounding.some(f=>f.path==='draft.cards.0.content' && f.source_url===fare.url));
 }
}
console.log('✓ 数字事实对象／方向／方式／单位／用途／日期隔离、原始反例及合法预算实际编排通过');
