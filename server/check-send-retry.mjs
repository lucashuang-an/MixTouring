/* check-send-retry.mjs · Issue #28 确定性回归：对话失败重发不重复追加用户消息与模型上下文。
 * 从 trip.html 提取真实 sendConversation 函数体，在桩环境中驱动：断网→重发→成功、连续失败、
 * 改写后发送、成功后同文再发、undo 单次推送。无网络、无密钥、无浏览器。运行：node server/check-send-retry.mjs */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
const fnSrc = html.slice(start, end);

let fail = 0, total = 0;
const ok = (cond, name) => { total++; if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

function makeEnv(postImpl) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = { value: '', textContent: '', innerHTML: '', hidden: false, focus() {} });
  const sandbox = {
    console, JSON, Object, Array, Date, Error, Promise,
    document: { getElementById: el },
    conversationBusy: false, planning: false,
    conversation: { stage: 'draft', brief: { origin: '', destination: '', summary: '', wishes: [], open_questions: [] }, draft: null, revision: 0 },
    guideMessages: [], guideSequence: 0, guideUndo: [], conversationError: null,
    guideState: {}, guideSnapshot: () => JSON.parse(JSON.stringify({ request: {}, travel: {}, constraints: {}, conversation: null, candidate_key: null, nights: 0, messages: sandbox.guideMessages, undo: sandbox.guideUndo.length })),
    activePlan: { plan_id: 'p1', intent: { origin: '北京', destination: '乌鲁木齐' }, candidates: [] },
    currentCandidate: () => null, visibleRoutes: () => [],
    transportSearchCache: new Map(), liveTransportKey: () => 'k',
    anchors: {}, collectTravel: () => ({}), collectConstraints: () => ({}),
    MTGuide: { clean: (p) => p || {} }, MTSights: { getState: () => ({}), applyPatch() {}, reset() {} },
    MTRouteWorkspace: { changes: () => [], routeFor: () => [] },
    fillTravel() {}, fillConstraints() {},
    renderGuide() {let seq=Math.max(0,...sandbox.guideMessages.map(m=>m.mid || 0));sandbox.guideMessages.forEach(m=>{if(!m.mid)m.mid=++seq;});}, rememberSession() {}, renderTaskPreview() {}, showWorkspaceView() {},
    openJourney() {}, requestPlan: async () => true, generateConversation: async () => {},
    /* 模拟真实 undoGuide→restoreGuideSnapshot：用快照整体覆盖消息列表（复审指出的漏桩） */
    undoGuide() { var snap = sandbox.guideUndo.pop(); if (snap && Array.isArray(snap.messages)) sandbox.guideMessages = JSON.parse(JSON.stringify(snap.messages)); },
    planController: null, planSequence: 0, journeySequence: 0, conversationController: null,
    pendingRestore: null, lastRequest: {}, confirmedPlaces: {}, resultArea: { set innerHTML(v) {} },
    cancelRouteResearch(){sandbox.routeResearch.cancel();},
    post: postImpl
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
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

console.log(fail === 0 ? `\n✓ 对话失败重发回归全部通过（${total} 项断言）` : `\n✗ 失败 ${fail} 项（共 ${total} 项断言）`);
if (fail) process.exit(1);
