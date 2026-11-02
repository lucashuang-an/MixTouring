/* check-send-retry.mjs · Issue #28 确定性回归：对话失败重发不重复追加用户消息与模型上下文。
 * 从 trip.html 提取真实 sendConversation 函数体，在桩环境中驱动：断网→重发→成功、连续失败、
 * 改写后发送、成功后同文再发、undo 单次推送。无网络、无密钥、无浏览器。运行：node server/check-send-retry.mjs */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const html = readFileSync(new URL('../mixtouring-hifi/pages/trip.html', import.meta.url), 'utf8');
const start = html.indexOf('async function sendConversation(');
if (start < 0) { console.error('✗ trip.html 中找不到 sendConversation'); process.exit(1); }
/* 花括号配对提取函数全文 */
let depth = 0, end = -1;
for (let i = html.indexOf('{', start); i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error('✗ 函数体提取失败'); process.exit(1); }
const helperSource=['planningCanonical','planningSnapshotState','planningChanged','planningRequest','planningCommitted'].map(name=>{const at=html.indexOf('function '+name+'(');let n=0;for(let i=html.indexOf('{',at);i<html.length;i++){if(html[i]==='{')n++;else if(html[i]==='}'&&!--n)return html.slice(at,i+1);}throw Error(name);}).join('\n');
const fnSrc = html.slice(start, end);

let fail = 0, total = 0;
const ok = (cond, name) => { total++; if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

function makeEnv(postImpl) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = { value: '', textContent: '', innerHTML: '', hidden: false, focus() {} });
  const sandbox = {
    console, JSON, Object, Array, Date, Error, Promise,AbortController,crypto:webcrypto,sessionStorage:{getItem:()=>null,setItem:()=>{}},
    document: { getElementById: el },
    conversationBusy: false, planning: false,
    conversation: { stage: 'draft', brief: { origin: '', destination: '', summary: '', wishes: [], open_questions: [] }, draft: null, revision: 0 },
    guideMessages: [], guideSequence: 0, guideUndo: [], conversationError: null,
    guideState: {}, guideSnapshot: () => JSON.parse(JSON.stringify({ request: {}, travel: {}, constraints: {}, conversation: null, candidate_key: null, nights: 0, messages: sandbox.guideMessages, undo: sandbox.guideUndo.length })),
    activePlan: { plan_id: 'p1', intent: { origin: '北京', destination: '乌鲁木齐' }, candidates: [] },
    activePlanSignature:null,planningSignature:()=>null,
    currentCandidate: () => null, visibleRoutes: () => [],
    transportSearchCache: new Map(), liveTransportKey: () => 'k',
    anchors: {}, collectTravel: () => ({}), collectConstraints: () => ({}),
    MTGuide: { clean: (p) => p || {} }, MTSights: { getState: () => ({}), applyPatch() {}, reset() {} },
    MTRouteWorkspace: { changes: () => [], routeFor: () => [], transportRoute:() => [] },
    fillTravel() {}, fillConstraints() {}, renderPreferencePanel() {}, prefMemoryFeedback:'',
    renderGuide() {let seq=Math.max(0,...sandbox.guideMessages.map(m=>m.mid || 0));sandbox.guideMessages.forEach(m=>{if(!m.mid)m.mid=++seq;});}, rememberSession() {}, renderTaskPreview() {}, showWorkspaceView() {},
    openJourney() {}, requestPlan: async () => true, generateConversation: async () => {},
    /* 模拟真实 undoGuide→restoreGuideSnapshot：用快照整体覆盖消息列表（复审指出的漏桩） */
    undoGuide() { var snap = sandbox.guideUndo.pop(); if (snap && Array.isArray(snap.messages)) sandbox.guideMessages = JSON.parse(JSON.stringify(snap.messages)); },
    planController: null, planSequence: 0, journeySequence: 0, conversationController: null,
    pendingRestore: null, lastRequest: {}, confirmedPlaces: {}, resultArea: { set innerHTML(v) {} },
    cancelRouteResearch(){sandbox.routeResearch.cancel();},
    /* R1-C：新输入使旧补查失效；沙箱中补空实现，只验证调用不阻塞发送 */
    cancelGapResearch(){}, lastEvidenceGaps: [],
    postConversation:postImpl,post: postImpl
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);vm.runInContext('var planningExecution=null;'+helperSource,sandbox);
  sandbox.sendConversation = vm.runInContext('(' + fnSrc + ')', sandbox);
  return { sandbox, el };
}

const okPayload = (reply, extra = {}) => ({ code: 0, data: Object.assign({ status: 'ok', action: 'chat', reply, conversation: { stage: 'discuss', revision: 1, brief: {}, draft: null, routing: {} }, patch: {}, sources: [] }, extra) });

/* 场景一：断网→重发→成功（普通路径，不带 retry 标志） */
{
  const payloads = [];
  let calls = 0;
  const { sandbox } = makeEnv(async (url, body) => {
    payloads.push(JSON.parse(JSON.stringify(body)));
    if (++calls <= 1) throw new TypeError('Failed to fetch');
    return okPayload('好的，已记录。');
  });
  await sandbox.sendConversation('查一下北京到乌鲁木齐的火车');
  ok(sandbox.guideMessages.length === 1 && sandbox.guideMessages[0].role === 'user' && sandbox.guideMessages[0].pending === true,
    '#28 断网后：用户消息恰好一条且标记未决');
  ok(payloads[0].current_message?.mid===sandbox.guideMessages[0].mid && payloads[0].current_message?.role==='user',
    'M1：本轮用户消息身份与原话独立传入，不混入历史助手');
  ok(sandbox.conversationError && sandbox.conversationError.text === '查一下北京到乌鲁木齐的火车',
    '#28 断网后：失败态可触发重发提示');
  await sandbox.sendConversation('查一下北京到乌鲁木齐的火车');
  ok(sandbox.guideMessages.filter((m) => m.role === 'user').length === 1, '#28 重发后：可见用户消息仍是一条（不重复追加）');
  ok((payloads[1].messages || []).every((m) => !(m.role === 'user' && m.text === payloads[1].text)),
    '#28 重发请求：messages 历史不再含同一条输入（模型上下文不重复）');
  ok(payloads[1].text === '查一下北京到乌鲁木齐的火车', '#28 重发请求：当前输入仍完整发送');
  ok(sandbox.guideMessages.filter((m) => m.role === 'assistant').length === 1 && sandbox.guideMessages[1].text === '好的，已记录。',
    '#28 重发成功：助手回复恰好一条');
  ok(sandbox.guideMessages[0].pending === undefined, '#28 重发成功：用户消息未决标记已解除');
  ok(sandbox.guideUndo.length === 1, '#28 重发成功：只提交一次撤销快照');
  ok(sandbox.conversationError === null, '#28 重发成功：失败态已清除');
}

/* 场景二：连续失败——消息不翻倍 */
{
  const { sandbox } = makeEnv(async () => { throw new TypeError('Failed to fetch'); });
  await sandbox.sendConversation('A');
  await sandbox.sendConversation('A');
  await sandbox.sendConversation('A');
  ok(sandbox.guideMessages.length === 1, '#28 连续失败三次：可见用户消息仍一条');
}

/* 场景三：改写后发送——新输入是新消息，旧失败消息保留一次 */
{
  const payloads = [];
  let fail = true;
  const { sandbox } = makeEnv(async (url, body) => {
    payloads.push(JSON.parse(JSON.stringify(body)));
    if (fail) throw new TypeError('Failed to fetch');
    return okPayload('收到');
  });
  await sandbox.sendConversation('A');
  await sandbox.sendConversation('B');
  ok(sandbox.guideMessages.length === 2 && sandbox.guideMessages[0].text === 'A' && sandbox.guideMessages[1].text === 'B',
    '#28 改写后发送：旧失败消息与新消息各自一条');
  ok((payloads[1].messages || []).some((m) => m.role === 'user' && m.text === 'A') &&
    !(payloads[1].messages || []).some((m) => m.role === 'user' && m.text === payloads[1].text),
    '#28 改写后发送：历史含旧消息、当前输入不在历史中重复');
  fail = false;
  await sandbox.sendConversation('B');
  ok(sandbox.guideMessages.length === 3 && sandbox.guideMessages.filter((m) => m.text === 'B').length === 1,
    '#28 改写后重发 B：复用未决消息，不产生第二条 B');
}

/* 场景四：成功后同文再次发送——仍是合法新消息 */
{
  const { sandbox } = makeEnv(async () => okPayload('答'));
  await sandbox.sendConversation('同文');
  await sandbox.sendConversation('同文');
  ok(sandbox.guideMessages.length === 4 && sandbox.guideMessages.filter((m) => m.role === 'user').length === 2,
    '#28 成功后同文再发：两条用户消息各自保留（不按文本全局去重）');
}

/* 场景五：undo 成功——恢复快照覆盖消息列表后，本轮用户消息仍保留且不重复 */
{
  const { sandbox } = makeEnv(async () => okPayload('已撤销上次调整。', { action: 'undo' }));
  await sandbox.sendConversation('撤销');
  ok(sandbox.guideMessages.length === 2 &&
    sandbox.guideMessages[0].role === 'user' && sandbox.guideMessages[0].text === '撤销' &&
    sandbox.guideMessages[1].role === 'assistant',
    '#28 undo：快照恢复后本轮用户消息保留一次并跟助手回复（复审 P2：不丢本轮消息）');
}

/* 后台资料补查不得阻断下一轮；新输入取消旧查询，回复先提交再派发新查询。 */
{
  let calls=0,cancelled=0,queued=0,pruned=0;
  const scope={route:['北京','伊宁','阿拉木图'],legs:[{from:'北京',to:'伊宁',mode:'unknown'}],window:null};
  const {sandbox}=makeEnv(async()=>{calls++;return okPayload('已加入伊宁。',{conversation:{stage:'draft',revision:2,brief:{},draft:{route:scope.route},routing:{origin:'北京',destination:'阿拉木图'}},research_update:{scope,queries:scope.legs,remaining:[]}});});
  sandbox.routeResearch={isPending:only=>!only,getState:()=>({input:{kind:'draft'}}),cancel:()=>{cancelled++;}};
  sandbox.pruneTransportResults=()=>{pruned++;};sandbox.supplementDraftChanges=()=>{queued++;return new Promise(()=>{});};
  await sandbox.sendConversation('加入伊宁');
  ok(calls===1 && cancelled===1,'后台补查期间可发送新消息，并取消旧查询');
  ok(pruned===1 && queued===1 && sandbox.conversation.revision===2,'先提交新草案和查询范围，再派发不阻塞回复的增量补查');
}


/* ready不触发工具；仅执行服务端的明确动作，并拒绝旧revision。 */
for(const [next,expected] of [[null,0],[{type:'none',revision:1},0],[{type:'generate',revision:1},1],[{type:'discover_routes',revision:1},1],[{type:'generate',revision:0},0]]){
  const {sandbox}=makeEnv(async()=>okPayload('已记录。',{next_action:next,conversation:{stage:'ready',revision:1,brief:{},draft:null,routing:{}}}));
  sandbox.activePlan=null;let generated=0,searched=0;
  sandbox.generateConversation=async()=>{generated++;};sandbox.requestPlan=async()=>{searched++;};
  await sandbox.sendConversation('先记录条件');
  ok(generated===expected && searched===0,'前端只执行当前revision对应的服务端动作：'+JSON.stringify(next));
}

console.log(fail === 0 ? `\n✓ 对话失败重发回归全部通过（${total} 项断言）` : `\n✗ 失败 ${fail} 项（共 ${total} 项断言）`);
if (fail) process.exit(1);

// 完整请求身份：仅键顺序不同可重用，检索与历史变化必须换请求ID。
{
 const {sandbox}=makeEnv(async()=>okPayload('ok'));
 const a=sandbox.planningRequest('chat','继续',null,{},null,{text:'继续',messages:[],retrieval_ids:['a']});
 const b=sandbox.planningRequest('chat','继续',null,{},null,{retrieval_ids:['a'],messages:[],text:'继续'});
 const c=sandbox.planningRequest('chat','继续',null,{},null,{text:'继续',messages:[],retrieval_ids:['b']});
 ok(a.request_id===b.request_id,'请求键顺序变化不会破坏幂等身份');ok(a.request_id!==c.request_id,'检索身份变化时创建新请求');
}

{
 let captured;const {sandbox}=makeEnv(async(url,body)=>{captured=body;return okPayload('保持原方案。');});
 const old={mid:1,role:'assistant',text:'原始回答',version:{draft:{content:'x'.repeat(10000)}},sources:[{excerpt:'不需要重发的来源'}]};
 sandbox.guideMessages.push(old);await sandbox.sendConversation('先聊聊');
 ok(captured.messages[0].text===old.text && captured.messages[0].mid===old.mid,'历史消息文本与出处身份完整发送');
 ok(!captured.messages[0].version&&!captured.messages[0].sources,'请求不重复携带历史行程与来源卡片');
 ok(sandbox.guideMessages[0].version===old.version,'精简请求不删除本地历史版本');
}
if(fail)process.exit(1);

// 在异步偏好写入期间停止，不能先把新草案或撤销快照提交给界面。
{
 let ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
 const context={enabled:true,store_id:'store',revision:1};
 const {sandbox}=makeEnv(async()=>okPayload('已更新',{conversation:{stage:'draft',revision:2,draft:{title:'新稿'}},preference_memory_upserts:[{key:'pace',value:'simple',source_message_mid:1}],preference_memory_context:context}));
 sandbox.MTPreferences={snapshotForRequest:()=>context,applyUpserts:async(a,b,c,options)=>{ready();await gate;return {ok:options.isCurrent(),reason:'stale_response'};}};
 const before=sandbox.conversation,pending=sandbox.sendConversation('以后记住慢游');await started;
 ok(sandbox.conversation===before && sandbox.guideUndo.length===0,'异步收尾完成前不提交新稿与撤销记录');
 const at=html.indexOf('function stopConversation(){'),until=html.indexOf('function postConversation(',at);sandbox.stopConversation=vm.runInContext('('+html.slice(at,until).trim()+')',sandbox);sandbox.stopConversation();release();await pending;
 ok(sandbox.conversation===before && sandbox.guideUndo.length===0,'收尾期间停止仍保留原稿');
}
if(fail)process.exit(1);

{
 const {sandbox}=makeEnv(async()=>okPayload('共5天，包含返程。',{conversation:JSON.parse(JSON.stringify(sandbox.conversation))}));
 sandbox.conversation={stage:'draft',revision:7,brief:{},routing:{},requirements:{trip_days:5},draft:{title:'原稿'}};
 sandbox.guideSnapshot=()=>JSON.parse(JSON.stringify({request:{},conversation:sandbox.conversation,preferences:{},travel:{},constraints:{},sights:{},messages:sandbox.guideMessages}));
 sandbox.guideUndo.push({marker:'真正的上次修改'});await sandbox.sendConversation('只问现在几天，不改稿');
 ok(sandbox.guideUndo.length===1 && sandbox.guideUndo[0].marker==='真正的上次修改','纯问答不会挡住撤销上次真正修改');
 ok(sandbox.planningChanged(sandbox.guideSnapshot(),{conversation:sandbox.conversation,patch:{constraints:{budget_max_cny:5000}}}),'明确条件变化仍保留撤销快照');
}
if(fail)process.exit(1);
{
 const {sandbox}=makeEnv(async()=>okPayload('ok'));
 const current={request:{},conversation:{stage:'draft',draft:{title:'现稿'}},travel:{},constraints:{},preferences:{},sights:{}};
 const older={...current,conversation:{stage:'draft',draft:{title:'上次修改前'}}};let restored;
 sandbox.guideSnapshot=()=>current;sandbox.guideUndo=[older,JSON.parse(JSON.stringify(current)),JSON.parse(JSON.stringify(current))];sandbox.restoreGuideSnapshot=value=>{restored=value;};
 const at=html.indexOf('function undoGuide() {'),until=html.indexOf('function collectConstraints()',at);sandbox.undoGuide=vm.runInContext('('+html.slice(at,until).trim()+')',sandbox);
 ok(sandbox.undoGuide()===true && restored.conversation.draft.title==='上次修改前','撤销跳过旧版本遗留的纯问答快照');
 ok(sandbox.undoGuide()===false,'没有真实修改时明确返回不可撤销');
}
if(fail)process.exit(1);
