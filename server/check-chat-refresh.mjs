/* check-chat-refresh.mjs · Issue #31 确定性回归：后台检索刷新不打断阅读位置、引用展开按消息身份保留。
 * 从 trip.html 提取真实 renderConversation，在假 DOM 桩中驱动；无网络、无密钥、无浏览器。
 * 运行：node server/check-chat-refresh.mjs */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../mixtouring-hifi/pages/trip.html', import.meta.url), 'utf8');
const start = html.indexOf('function renderConversation()');
if (start < 0) { console.error('✗ trip.html 中找不到 renderConversation'); process.exit(1); }
let depth = 0, end = -1;
for (let i = html.indexOf('{', start); i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error('✗ 函数体提取失败'); process.exit(1); }

let fail = 0, total = 0;
const ok = (cond, name) => { total++; if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

/* 假消息区：维护消息行（mid/offsetTop/offsetHeight）与每行引用 details 状态 */
function makeEnv(messages, opts = {}) {
  const box = {
    scrollTop: 0, scrollHeight: 1800, clientHeight: 400, rows: [], scrollCalls: 0, getBoundingClientRect() { return { top: 0 }; },
    scrollTo() { this.scrollCalls++; },
    querySelector(sel) {
      const m = sel.match(/data-mid="([^"]+)"/);
      return m ? this.rows.find((r) => r.mid === m[1]) || null : null;
    },
    querySelectorAll(sel) {
      if (sel === '.message-row[data-mid]') return this.rows;
      if (sel === '.source-details') return this.rows.flatMap((r) => r.details);
      return [];
    }
  };
  const buildRows = () => { /* 每次 innerHTML 重写后按当前消息重建行（模拟真实 DOM 重建） */
    box.rows = sandbox.guideMessages.slice(-12).map((m, i) => {
      const details = { _open: false, listeners: [],
        addEventListener(ev, fn) { this.listeners.push(fn); }, getBoundingClientRect() { return { top: 150 }; },
        get open() { return this._open; },
        set open(v) { const next = !!v; if (next === this._open) return; this._open = next;
          setTimeout(() => this.listeners.forEach((fn) => fn()), 0); }  /* 真实浏览器:下一任务派发 toggle */
      };
      return { mid: String(m.mid), offsetTop: i * 150, offsetHeight: 150,
        get details() { return [details]; },
        getAttribute() { return String(m.mid); },
        querySelectorAll(sel) { return sel === '.source-details' ? [details] : []; }
      };
    });
  };
  const experienceRow = { open: false, addEventListener() {} };
  const area = {
    hidden: false, innerHTML: '',
    querySelector(sel) { return sel === '.guide-messages' ? box : null; },
    querySelectorAll(sel) {
      if (sel === '.message-row[data-mid]') return box.rows;
      if (sel === '.experience-row') return sandbox.currentExperiences.length ? [{ querySelectorAll: (s) => s === '.source-details' ? [experienceRow] : [] }] : [];
      if (sel === '.source-details') return [];
      if (sel === '[data-open-version]' || sel === '[data-restore-version]') return [];
      return [];
    },
    appendChild() { buildRows(); }
  };
  const input = { value: opts.inputValue || '', placeholder: '', focus() { input.focused = true; } };
  const sandbox = {
    console, JSON, Object, Array, Date, String, Math, setTimeout,
    document: { getElementById: (id) => id === 'guideArea' ? area : id === 'nlInput' ? input : { hidden: false } },
    composer: { contains: () => false, remove() {} },
    input, area, currentExperiences: opts.currentExperiences || [],
    conversation: { draft: null }, conversationBusy: false, conversationError: null,
    guideMessages: messages, msgSeq: 0,
    liveTransportKey: () => 'k', transportSearchCache: new Map(),
    sourceCards: () => '<details class="source-details"></details>',
    versionCard: () => '', MT: { esc: (s) => String(s) },
    updateComposer() {}, showWorkspaceView() {},
    actionLabel: () => '...', restoreConversationVersion() {}, guideUndo: []
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.renderConversation = vm.runInContext('(' + html.slice(start, end) + ')', sandbox);
  return { sandbox, box, input };
}

const msgs = () => [
  { role: 'user', text: '旧消息一' }, { role: 'assistant', text: '答复一', sources: [{ url: 'https://a.example/1' }] },
  { role: 'user', text: '旧消息二' }, { role: 'assistant', text: '答复二' }
];

/* 场景一（审计复现）：用户上滚读旧消息（scrollTop=120），后台资料刷新重绘——阅读位置不变 */
{
  const { sandbox, box } = makeEnv(msgs());
  sandbox.renderConversation();                    /* 首次渲染（模拟此前已在底部） */
  box.scrollTop = 120;                             /* 用户上滚到旧消息处 */
  sandbox.renderConversation();                    /* 后台检索完成触发重绘（无新消息） */
  ok(box.scrollTop === 120, '#31 读旧消息时后台刷新：阅读位置保持 120，不被拉到底部（修复前为 1800）');
}

/* 场景二：原本在底部——保持跟随最新内容 */
{
  const { sandbox, box } = makeEnv(msgs());
  sandbox.renderConversation();
  box.scrollTop = box.scrollHeight - box.clientHeight;   /* 用户在底部 */
  sandbox.guideMessages.push({ role: 'assistant', text: '新回复' });
  sandbox.renderConversation();
  ok(box.scrollTop === box.scrollHeight - box.clientHeight || box.scrollTop >= box.scrollHeight - box.clientHeight,
    '#31 在底部时新消息到达：继续跟随最新');
}

/* 场景三：读旧消息时到达新回复——阅读锚点不被拉走 */
{
  const { sandbox, box } = makeEnv(msgs());
  sandbox.renderConversation();
  box.scrollTop = 120;
  sandbox.guideMessages.push({ role: 'assistant', text: '后台新回复' });
  sandbox.renderConversation();
  ok(box.scrollTop === 120, '#31 读旧消息时新回复到达：锚点消息位置保持');
}

/* 场景四：引用展开按消息身份保留——前置新增「旅行者经验」区不把展开状态转给别的引用 */
{
  const { sandbox, box } = makeEnv(msgs());
  sandbox.renderConversation();
  box.rows[1].details[0].open = true;              /* 用户展开第二条消息（assistant）的引用 */
  sandbox.currentExperiences = [{ url: 'https://exp.example/1' }];  /* 经验区将出现在最前 */
  sandbox.renderConversation();
  const rows = box.rows;
  ok(rows[1].details[0].open === true && rows[0].details[0].open === false,
    '#31 经验区前置后：原消息引用展开状态仍按 mid 归位（不按 DOM 下标错位）');
  const exp = sandbox.area.querySelectorAll('.experience-row')[0].querySelectorAll('.source-details')[0];
  ok(exp.open === false, '#31 新出现的经验区引用默认收起');
}

/* 场景五：不抢输入焦点、未发送文案保留 */
{
  const { sandbox, input } = makeEnv(msgs(), { inputValue: '还没发送的想法' });
  sandbox.renderConversation();
  ok(input.focused !== true, '#31 非焦点状态重绘不抢占输入焦点');
  ok(input.value === '还没发送的想法', '#31 未发送文案保留');
}

/* 场景六（复审 P2）：恢复的消息自带 mid 而计数器从零开始——不产生重复 ID */
{
  const restored = [ { role: 'user', text: '甲', mid: 1 }, { role: 'assistant', text: '乙', mid: 2 } ];
  const { sandbox } = makeEnv(restored);
  sandbox.msgSeq = 0;                              /* 模拟刷新后计数器重置 */
  sandbox.renderConversation();
  sandbox.guideMessages.push({ role: 'user', text: '新消息' });   /* 无 mid，走分配 */
  sandbox.renderConversation();
  const mids = sandbox.guideMessages.map((m) => m.mid);
  ok(new Set(mids).size === mids.length, '#31 恢复后新消息分配不与已有 mid 重复（修复前为 [1,2,1]）');
}
/* 场景七（复审 P2）：快照里已存在重复 mid——渲染时唯一化 */
{
  const dup = [ { role: 'user', text: '甲', mid: 1 }, { role: 'assistant', text: '乙', mid: 2 }, { role: 'user', text: '丙', mid: 1 } ];
  const { sandbox } = makeEnv(dup);
  sandbox.msgSeq = 0;
  sandbox.renderConversation();
  const mids = sandbox.guideMessages.map((m) => m.mid);
  ok(new Set(mids).size === mids.length, '#31 已重复的存量 mid 渲染时被唯一化');
}

/* 场景八（复审二轮）：程序恢复 details.open 异步派发 toggle——不触发自动滚动 */
{
  const { sandbox, box } = makeEnv(msgs());
  sandbox.renderConversation();
  const d = box.rows[1].details[0];
  d.open = true;                                    /* 模拟用户此前展开该引用 */
  await new Promise((r) => setTimeout(r, 5));       /* 上次渲染派发的 toggle 沉淀（该阶段监听会滚动一次） */
  box.scrollCalls = 0;
  sandbox.renderConversation();                     /* 重绘：程序恢复 open=true，异步派发 toggle */
  await new Promise((r) => setTimeout(r, 10));
  ok(box.scrollCalls === 0, '#31 程序恢复引用展开不触发自动滚动（修复前真浏览器 900→459）');
  const after = box.rows[1].details[0];             /* 用户随后主动开合新渲染的引用 */
  after.open = false;
  await new Promise((r) => setTimeout(r, 5));
  after.open = true;
  await new Promise((r) => setTimeout(r, 10));
  ok(box.scrollCalls >= 1, '#31 用户主动展开仍自动滚动到引用');
}

console.log(fail === 0 ? `\n✓ 聊天刷新阅读位置回归全部通过（${total} 项断言）` : `\n✗ 失败 ${fail} 项（共 ${total} 项断言）`);
if (fail) process.exit(1);
