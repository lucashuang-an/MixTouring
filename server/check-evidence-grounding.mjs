/* R1-B 底座复审回归：原始反例、合法放行、真实目录形状及核对失败边界。 */
import assert from 'node:assert/strict';
import {buildEvidenceCatalog,validateEvidenceClaims,isQuestionSource,textDirection,assessEvidenceClaims,operationalAssertions} from './lib/evidence-grounding.mjs';
import {buildContext} from './lib/context-builder.mjs';
import {sourceId} from './lib/source-relevance.mjs';
const now=Date.parse('2026-10-22T00:00:00Z'),routing={origin:'北京',destination:'阿拉木图'};
const row=(excerpt,over={})=>({url:'https://example.gov.cn/article',title:'交通资料',excerpt,published_at:'2026-10-20',kind:'official',read_status:'page_excerpt',...over});
const make=(sources,extra={})=>buildEvidenceCatalog({sources,routing,now,retrieval:{purpose:'transport'},...extra});
const reply='来源记载北京到阿拉木图开通直飞，本次日期仍待确认。',quote='北京到阿拉木图开通直飞。',cat=make([row(quote)]);
const claim=(catalog=cat,text=reply,q=catalog.entries[0].excerpt)=>({text,allowed_use:'source_reference',supports:[{source_id:catalog.entries[0].id,quote:q}]});
const supported=async({user})=>({items:JSON.parse(user).claims.map(c=>({id:c.id,decision:'supported',reason:'原句支持限定后的资料参考'}))});
const check=async(catalog,text=reply,claims=[claim(catalog,text)],model=supported)=>validateEvidenceClaims(text,catalog,{claims,assessment:await assessEvidenceClaims(text,catalog,claims,model)});
assert.equal(cat.entries[0].id,sourceId(row(quote)));
assert.equal((await check(cat)).grounded.length,1);
const naturalPending='来源记载北京到阿拉木图开通直飞，具体班次和适用日期需另行核实。';
assert.equal((await check(cat,naturalPending,[claim(cat,naturalPending)])).grounded.length,1,'自然等价的日期待核表达不能误删');
const pricePending='来源记载北京到阿拉木图开通直飞，票价仍待核实。';
assert.equal((await check(cat,pricePending,[claim(cat,pricePending)])).grounded.length,0,'仅票价待核不代表本次班次日期已经核实');
const overcount='这两份资料记载北京到阿拉木图开通直飞，本次日期仍待确认。';
assert.equal((await check(cat,overcount,[claim(cat,overcount)])).grounded.length,0,'一份来源不能写成两份资料');
assert.equal(validateEvidenceClaims(reply,cat,{claims:[claim()]}).grounded.length,0,'引用及原句存在不等于语义已核对');
for(const source of [row('阿拉木图国际机场位于哈萨克斯坦。',{title:'阿拉木图国际机场介绍'}),row('北京到阿拉木图尚未开通直飞。'),row('请问有人知道吗？',{title:'北京到阿拉木图有直飞吗？'}),row('Does Beijing have direct flights to Almaty?'),row(quote,{kind:'experience'}),row(quote,{allowed_use:'software_reference'}),row(quote,{relevance:{decision:'uncertain'}})]){
  const c=make([source]);let called=0;
  const r=await check(c,reply,[claim(c)],async p=>{called++;return supported(p);});
  assert.ok(r.rejected.length);assert.equal(r.grounded.length,0);assert.equal(called,0,'确定性不合格资料不花费模型调用');
}
const question={title:'北京到阿拉木图有直飞吗',excerpt:'请问怎么查'};
assert.equal(isQuestionSource(question),true);
assert.equal(isQuestionSource({...question,excerpt:'答：北京到阿拉木图开通直飞。'}),false);
assert.equal((await check(make([row(quote,{title:question.title})]))).grounded.length,1,'问答混合须核对具体回答');
const faqGuide=make([row('清邁古城適合步行嗎？古城區景點集中，建議以步行或租借自行車方式遊覽。',{title:'清邁自由行常見問題',kind:'guide'})],{retrieval:{purpose:'experience'}});
assert.equal(faqGuide.entries[0].question_like,true,'夹具确实触发整页提问提示');
const faqText='这份资料建议步行或租自行车游览古城。';let faqCalls=0;
assert.equal((await check(faqGuide,faqText,[claim(faqGuide,faqText,'古城區景點集中，建議以步行或租借自行車方式遊覽。')],async p=>{faqCalls++;return supported(p);})).grounded.length,1,'问答攻略中的明确答案进入语义核对');assert.equal(faqCalls,1);
const faqExperience=make([row('一個人自由行安全嗎？城市不大、景點集中、步調緩慢。',{title:'作者的清邁旅行记录',kind:'experience'})],{retrieval:{purpose:'experience'}});
const faqPersonal='作者当时记录了城市不大、景点集中的感受。';
assert.equal((await check(faqExperience,faqPersonal,[{...claim(faqExperience,faqPersonal,'城市不大、景點集中、步調緩慢。'),allowed_use:'travel_experience'}])).grounded.length,1,'个人经验中的问题标题不删除其真实回答');
const questionFragment=make([row('清邁古城區景點集中嗎？有人能回答嗎？',{title:'清邁問題',kind:'guide'})],{retrieval:{purpose:'experience'}}),questionFact='资料记载清邁古城區景點集中。';let questionCalls=0;
assert.equal((await check(questionFragment,questionFact,[claim(questionFragment,questionFact,'清邁古城區景點集中')],async p=>{questionCalls++;return supported(p);})).grounded.length,0,'截去问号的片段仍按其原句提问语境拒绝');assert.equal(questionCalls,0);
const reverse=make([row('阿拉木图到北京开通直飞。')]);
const denied=await check(reverse,reply,[claim(reverse)],async({user})=>({items:JSON.parse(user).claims.map(c=>({id:c.id,decision:'unsupported',reason:'反向航线不能支持正向'}))}));
assert.equal(denied.grounded.length,0,'方向由语义核对，不靠城市首现顺序证明方向');
assert.equal(textDirection('阿拉木图出发到北京','北京','阿拉木图'),'BA');assert.equal(textDirection('机场介绍','北京','阿拉木图'),null);
assert.equal((await check(cat,'北京到阿拉木图现在有直飞。',[claim(cat,'北京到阿拉木图现在有直飞。')])).grounded.length,0);
const badQuote=claim();badQuote.supports[0].quote='北京到阿拉木图每天直飞';assert.equal((await check(cat,reply,[badQuote])).grounded.length,0);
assert.equal((await check(cat,reply,[claim(),claim()])).grounded.length,0);
assert.equal((await check(cat,reply,[{...claim(),supports:[...claim().supports,...claim().supports]}])).grounded.length,0);
const wrongRef=reply.replace('。',' [ev_1]。');assert.equal((await check(cat,wrongRef,[claim(cat,wrongRef)])).grounded.length,0);
console.log('✓ 背景、提问、否定、用途、方向语义、伪造原句及合法参考通过');

const hours=make([row('do not assume every lift section shares the same hours')]);
const compound='缆车各段开放时间可能不同，不能默认一张票通到底。';let checkedParts=[];
const compoundClaims=[claim(hours,compound)];
const partialAssessment=await assessEvidenceClaims(compound,hours,compoundClaims,async({user})=>{
  const input=JSON.parse(user);checkedParts=input.claims.map(c=>c.claim.text);
  assert.equal(input.source_catalog.length,1,'分句共享相同可见来源目录');
  return {items:input.claims.map(c=>({id:c.id,decision:c.claim.text.includes('一张票')?'unsupported':'supported',reason:'时间信息不能证明票券范围'}))};
});
assert.equal(checkedParts.length,2,'完整枚举真实反例的两个分句');
assert.equal(validateEvidenceClaims(compound,hours,{claims:compoundClaims,assessment:partialAssessment}).grounded.length,0,'半句有出处不能放行整句');
for(const mode of ['missing','duplicate']){
  const assessment=await assessEvidenceClaims(compound,hours,compoundClaims,async({user})=>{
    const first={id:JSON.parse(user).claims[0].id,decision:'supported',reason:'只回答前半句'};
    return {items:mode==='missing'?[first]:[first,first]};
  });
  assert.equal(validateEvidenceClaims(compound,hours,{claims:compoundClaims,assessment}).grounded.length,0,'漏交或重复分句不得通过');
}
const twoFacts=make([row('鹤鸣茶社提供盖碗茶。大旗茶馆由老厂房改造。')]);
const twoText='资料提到鹤鸣茶社提供盖碗茶，大旗茶馆由老厂房改造。';
const twoClaims=[{text:twoText,allowed_use:'source_reference',supports:['鹤鸣茶社提供盖碗茶。','大旗茶馆由老厂房改造。'].map(quote=>({source_id:twoFacts.entries[0].id,quote}))}];
assert.equal((await check(twoFacts,twoText,twoClaims)).grounded.length,1,'同一篇文章可用不同原句支持多个事实');
assert.equal((await check(twoFacts,twoText,[{...twoClaims[0],allowed_use:'conflict'}])).grounded.length,0,'同篇多原句不能伪装成两个冲突来源');
console.log('✓ 逐分句支持、部分支持拒绝、漏交失效及同源多原句通过');
const foreignPlace=make([row('Day 2 - GORKY PARK')]);
for(const text of ['资料列出果戈里公园。','城区建议果戈里公园。','资料列出果戈里公园（GORKY PARK）。'])assert.equal((await check(foreignPlace,text,[claim(foreignPlace,text)])).grounded.length,0,'未核实音译不能改变地点对象');
assert.equal((await check(foreignPlace,'资料列出GORKY PARK。',[claim(foreignPlace,'资料列出GORKY PARK。')])).grounded.length,1,'保留来源原名可正常引用');
const groupGuide=make([row('Day 2 - GORKY PARK',{title:'面向独行旅行者的团体行程',kind:'guide'})]);
const groupText='这份面向独行旅行者的行程资料列出GORKY PARK。';
assert.equal((await check(groupGuide,groupText,[claim(groupGuide,groupText)])).grounded.length,1,'面向旅行者的商业行程不误标成个人经历');
const bilingualPlace=make([row('GORKY PARK（高尔基公园）')]);
assert.equal((await check(bilingualPlace,'资料列出高尔基公园。',[claim(bilingualPlace,'资料列出高尔基公园。')])).grounded.length,1,'来源明确给出的中文名仍可引用');
const workable=make([row('A workable sequence is central Almaty to Medeu, Shymbulak base, an upper station, then back down.')]);
for(const text of ['该指南把这条走法写成一条可执行的路线，仅供参考。','可以考虑这条可执行的路线。','这条行程确定可达。','这条方案一定省钱。'])assert.equal((await check(workable,text,[claim(workable,text)])).grounded.length,0,'普通资料不能授予本次可执行或确定省钱资格');
assert.equal(validateEvidenceClaims('当前路线可执行。',{entries:[]}).rejected.length,1,'漏交支持时也拦截可执行承诺');
for(const text of ['不能把指南当作本次可执行的路线。','如果核实这条路线可执行，可以再安排。'])assert.equal(validateEvidenceClaims(text,{entries:[]}).rejected.length,0,'否定和明确假设不当作可执行承诺');
const exploratory='该指南给出了central Almaty到Medeu的探索顺序，仅供参考。';
assert.equal((await check(workable,exploratory,[claim(workable,exploratory)])).grounded.length,1);

const old=make([row(quote,{published_at:'2026-05-01'})]);assert.equal(old.entries[0].temporal_state,'historical');assert.equal((await check(old)).grounded.length,0);
const experienceWindow=make([row(quote,{published_at:'2026-05-01'})],{retrieval:{purpose:'experience'}});
assert.equal(experienceWindow.entries[0].temporal_state,'recent');assert.equal((await check(experienceWindow)).grounded.length,0);
const history=make([row(quote)],{retrieval:{purpose:'transport',target_window:'2026-10-01 ~ 2026-10-08'}});
assert.equal(history.entries[0].temporal_state,'after_trip');assert.equal((await check(history)).grounded.length,0);
for(const over of [{published_at:null},{date_basis:'provider_estimate'},{temporal:{state:'historical'}},{valid_until:'2026-10-01'}])assert.equal((await check(make([row(quote,over)]))).grounded.length,0);
const future=make([row(quote,{valid_from:'2026-10-01',valid_until:'2026-10-31',validity_basis:'schedule'})],{retrieval:{purpose:'transport',target_window:'2026-11-01 ~ 2026-11-08'}});assert.equal(future.entries[0].temporal_state,'outside_window');
console.log('✓ 交通复核期、历史窗、估计日期和原状态不可升级通过');

for(const text of ['目前无法确认是否有直飞，班车也仍待核实。','没有直飞，班车尚未恢复运行。','如果开通直飞，可以再比较。','Are there direct flights?','Direct flights are unconfirmed.','可以先探索市区，再确认交通。'])assert.equal(validateEvidenceClaims(text,{entries:[]}).rejected.length,0,text);
for(const text of ['无法确认票价，但北京到阿拉木图有直飞。','是否有直飞？北京到阿拉木图每天发车。'])assert.ok(validateEvidenceClaims(text,{entries:[]}).rejected.length);
for(const text of ['你更想先查直飞方向，还是把中转方向一起列入待查？','是否值得继续探索，取决于你更看重省心直飞，还是愿意比较中转。'])assert.equal(validateEvidenceClaims(text,{entries:[]}).rejected.length,0,'偏好问句不能因逗号丢失提问范围');
for(const text of ['北京到阿拉木图有直飞，你想比较吗？','你更想搭已经开通的北京到阿拉木图直飞，还是中转？'])assert.ok(validateEvidenceClaims(text,{entries:[]}).rejected.length,'问句不能替其预设的运营事实免责');
for(const text of ['北京到阿拉木图有航班。','北京到阿拉木图每天都有航班。','北京到阿拉木图有直达列车。','北京到阿拉木图有直飞但班车未确认。','北京到阿拉木图有航班但是列车待查。','北京到阿拉木图未开通直飞但有航班。']){
  assert.equal(operationalAssertions(text).length,1,text);
  assert.ok(validateEvidenceClaims(text,{entries:[]}).rejected.length,'未交结构化支持也必须拦截：'+text);
}
assert.equal(validateEvidenceClaims('方向上可优先按成都东—昆明南直达高铁去查。',{entries:[]}).rejected.length,1,'未标注的直达高铁方向不能伪装成确定连接');
for(const text of ['新干线直达省心、换乘少，适合把时间留给大阪。','可以先比较新干线直达与沿途停留。','高铁可以直达昆明。','东京到大阪有direct trains。'])assert.ok(validateEvidenceClaims(text,{entries:[]}).rejected.length,'交通方式在前的直达承诺同样需要证据：'+text);
for(const text of ['如果有新干线直达，可以先比较少换乘方案。','若能核实高铁直达，可以先比较少换乘方案。','新干线是否直达大阪仍待核实。'])assert.equal(validateEvidenceClaims(text,{entries:[]}).rejected.length,0,'明确假设和待查仍可表达：'+text);
const shinkansen=make([row('东京到大阪新干线直达。')]),shinkansenReply='来源记载东京到大阪新干线直达，本次日期仍待确认。';
assert.equal((await check(shinkansen,shinkansenReply,[claim(shinkansen,shinkansenReply)])).grounded.length,1,'有原句和语义支持的直达资料参考可通过');
for(const text of ['北京到阿拉木图未开通直飞。','北京到阿拉木图未恢复航班。','北京到阿拉木图无直飞。','北京到阿拉木图未开通直飞但班车也待查。']){
  assert.equal(operationalAssertions(text).length,0,text);
  assert.equal(validateEvidenceClaims(text,{entries:[]}).rejected.length,0,'诚实否定无需证据支持：'+text);
}
const trainQuote='北京到阿拉木图有直达列车。',trainCatalog=make([row(trainQuote)]);
const trainReply='来源记载北京到阿拉木图有直达列车，本次日期仍待确认。';
assert.equal((await check(trainCatalog,trainReply,[claim(trainCatalog,trainReply)])).grounded.length,1,'新识别的合法参考仍能通过');
const experience=make([row('我在大阪散步很愉快。',{kind:'experience'})],{retrieval:{purpose:'experience'}}),experienceText='该旅行者记录了在大阪散步的愉快体验。';
assert.equal((await check(experience,experienceText,[{...claim(experience,experienceText),allowed_use:'travel_experience'}])).grounded.length,1);
assert.equal((await check(experience,experienceText,[claim(experience,experienceText)])).grounded.length,0,'不能把个人记录标成普通资料事实');
const unAttributed='大阪散步很愉快。';
assert.equal((await check(experience,unAttributed,[{...claim(experience,unAttributed),allowed_use:'travel_experience'}])).grounded.length,0,'个人感受缺少旅行者归因时不作为普遍结论发布');
const personalArticle=make([row('作者当时在大阪步行游览。',{kind:'guide'})]),personalText='这篇游记记录了作者当时在大阪步行游览的经历。';
assert.equal((await check(personalArticle,personalText,[claim(personalArticle,personalText)])).grounded.length,0,'综合媒体中的游记也不能冒充普遍事实');
assert.equal((await check(personalArticle,personalText,[{...claim(personalArticle,personalText),allowed_use:'travel_experience'}])).grounded.length,1);
console.log('✓ 否定、疑问、假设、转折和有出处经验正常表达通过');

for(const model of [async()=>null,async()=>({items:[]}),async()=>{throw Error('不记录原始故障');},async({user})=>({items:[{id:JSON.parse(user).claims[0].id,decision:'supported',reason:''}]}),async({user})=>{const r={id:JSON.parse(user).claims[0].id,decision:'supported',reason:'重复'};return {items:[r,r]};}])assert.equal((await check(cat,reply,[claim()],model)).grounded.length,0);
const assessment=await assessEvidenceClaims(reply,cat,[claim()],supported),changed=structuredClone(cat);changed.entries[0].excerpt='北京到阿拉木图尚未开通直飞。';
assert.equal(validateEvidenceClaims(reply,changed,{claims:[claim()],assessment}).grounded.length,0);
const changedReply='来源记载北京到阿拉木图每天直飞，本次日期仍待确认。';assert.equal(validateEvidenceClaims(changedReply,cat,{claims:[claim(cat,changedReply)],assessment}).grounded.length,0);
const changedScope=structuredClone(cat);changedScope.retrieval.target_window='2026-11-01 ~ 2026-11-08';assert.equal(validateEvidenceClaims(reply,changedScope,{claims:[claim()],assessment}).grounded.length,0);
assert.equal(validateEvidenceClaims('可以考虑直飞方案，再核实交通。',{entries:[]}).rejected.length,0);
const ctrl=new AbortController();const cancelled=await assessEvidenceClaims(reply,cat,[claim()],async p=>{ctrl.abort();return supported(p);},{signal:ctrl.signal});assert.equal(cancelled.reason,'cancelled');
let calls=0;await assessEvidenceClaims(reply,cat,[claim()],async()=>{calls++;},{signal:ctrl.signal});assert.equal(calls,0);
assert.equal((await assessEvidenceClaims(reply,cat,[claim()],supported,{budgetChars:50})).status,'unavailable');
console.log('✓ 缺项、重复、模型故障、修改后失效、取消和预算保护通过');

const large=make(Array.from({length:12},(_,i)=>row('旅行参考资料。'.repeat(70),{url:'https://example.gov.cn/article/'+i}))),before=JSON.stringify(large);
const built=buildContext({payload:{text:'保留本轮条件',evidence_catalog:large},budgetChars:4000});
assert.ok(built.manifest.omitted_ids.includes('evidence_catalog'));assert.equal(built.value.text,'保留本轮条件');assert.equal(JSON.stringify(large),before);
assert.ok(built.value.evidence_catalog.entries.length<12);assert.ok(built.value.evidence_catalog.entries.every(e=>e.id===sourceId(e)));
const removed=large.entries.find(e=>!built.value.evidence_catalog.entries.some(v=>v.id===e.id));
assert.equal((await check(built.value.evidence_catalog,reply,[{text:reply,allowed_use:'source_reference',supports:[{source_id:removed.id,quote:removed.excerpt}]}])).grounded.length,0);
assert.equal(buildContext({payload:{search_results:[row(quote)],evidence_catalog:cat}}).value.evidence_catalog.entries[0].excerpt,quote);
console.log('✓ 真实目录形状裁剪、稳定身份、原对象保护和可见引用一致性通过');
