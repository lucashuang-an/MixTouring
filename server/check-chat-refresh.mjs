/* check-chat-refresh.mjs · Issue #31 确定性回归：后台检索刷新不打断阅读位置、引用展开按消息身份保留。
 * 从 trip.html 提取真实 renderConversation，在假 DOM 桩中驱动；无网络、无密钥、无浏览器。
 * 运行：node server/check-chat-refresh.mjs */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../mixtouring-hifi/pages/trip.html', import.meta.url), 'utf8');
const start = html.indexOf('function renderConversation()');
const claimStart=html.indexOf('function claimEvidence(message)');
const historyStart=html.indexOf('function historicalMessages(messages)');
if (start < 0) { console.error('✗ trip.html 中找不到 renderConversation'); process.exit(1); }
let depth = 0, end = -1;
for (let i = html.indexOf('{', start); i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error('✗ 函数体提取失败'); process.exit(1); }

let fail = 0, total = 0;
const ok = (cond, name) => { total++; if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

/* 布局桩维护真实坐标关系、随展开变化的行高及异步 toggle，原生浏览器另行验收。 */
function makeEnv(messages, opts = {}) {
  const box = {
    scrollTop: 0, clientHeight: 400, clientTop: 2, rows: [], scrollCalls: 0,
    get scrollHeight() { return Math.max(1800, this.rows.reduce((n,r)=>n+r.offsetHeight,0)+(experienceRow?experienceRow.offsetHeight:0)); },
    getBoundingClientRect() { return { top: opts.boxTop || 0 }; },
    scrollTo({top}) { this.scrollCalls++;this.scrollTop=top; },
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
  let experienceRow=null,rendered=false,markup='';
  const detail = row => ({ _open: false, listeners: [],
    addEventListener(ev, fn) { this.listeners.push(fn); },
    getBoundingClientRect() { return { top: row.getBoundingClientRect().top+120 }; },
    get open() { return this._open; },
    set open(v) { const next = !!v;if(next===this._open)return;this._open=next;
      setTimeout(()=>this.listeners.forEach(fn=>fn()),0); }
  });
  const buildRows = () => { /* 展开引用会改变后续行的位置，不能再用固定行高掩盖布局漂移。 */
    experienceRow=null;
    if(markup.includes('experience-row')){
      experienceRow={get offsetHeight(){return 70+(this.details[0].open?160:0);},
        getBoundingClientRect(){return {top:box.getBoundingClientRect().top+box.clientTop-box.scrollTop};},
        querySelectorAll(sel){return sel==='.source-details'?this.details:[];}};
      experienceRow.details=[detail(experienceRow)];
    }
    box.rows = sandbox.guideMessages.slice(-12).map((m, i) => {
      const row={ mid:String(m.mid),
        get contentTop(){return (experienceRow?experienceRow.offsetHeight:0)+box.rows.slice(0,i).reduce((n,r)=>n+r.offsetHeight,0);},
        get offsetTop(){return (opts.offsetParentTop || 0)+this.contentTop;},
        get offsetHeight(){return 150+(this.details[0].open?160:0);},
        getBoundingClientRect(){const top=box.getBoundingClientRect().top+box.clientTop+this.contentTop-box.scrollTop;return {top,bottom:top+this.offsetHeight};},
        getAttribute(){return this.mid;},
        querySelectorAll(sel){return sel==='.source-details'?this.details:[];}
      };
      row.details=[detail(row)];return row;
    });
  };
  const area = {
    hidden: false,
    set innerHTML(value){markup=value;rendered=true;},get innerHTML(){return markup;},
    querySelector(sel) { return sel === '.guide-messages' && rendered ? box : null; },
    querySelectorAll(sel) {
      if (sel === '.message-row[data-mid]') return box.rows;
      if (sel === '.experience-row') return experienceRow?[experienceRow]:[];
      if (sel === '.source-details') return [];
      if (sel === '[data-open-version]' || sel === '[data-restore-version]') return [];
      return [];
    },
    appendChild() { buildRows(); }
  };
  const input = { value: opts.inputValue || '', placeholder: '', focus() { input.focused = true; } };
  const sandbox = {
    console, JSON, Object, Array, Date, String, Math, URL, setTimeout,
    document: { getElementById: (id) => id === 'guideArea' ? area : id === 'nlInput' ? input : { hidden: false } },
    composer: { contains: () => false, remove() {} },
    input, area,
    conversation: { draft: null }, conversationBusy: false, conversationError: null,
    guideMessages: messages, msgSeq: 0,
    liveTransportKey: () => 'k', transportSearchCache: new Map(),
    sourceCards: () => '<details class="source-details"></details>',
    versionCard: () => '', MT: { esc: (s) => String(s) },
    updateComposer() {}, showWorkspaceView() {},
    actionLabel: () => '...', restoreConversationVersion() {}, guideUndo: []
  };
  let experiences=[];
  Object.defineProperty(sandbox,'currentExperiences',{get:()=>experiences,set(value){
    experiences=value;sandbox.conversation.draft=value.length?{route:['起点','终点']}:null;
    sandbox.transportSearchCache=new Map(value.length?[['k',{retrieved_at:new Date().toISOString(),experiences:value}]]:[]);
  }});
  sandbox.currentExperiences=opts.currentExperiences || [];
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if(claimStart<0)throw Error('缺少结论引用渲染函数');
  let claimDepth=0,claimEnd=-1;
  for(let i=html.indexOf('{',claimStart);i<html.length;i++){
    if(html[i]==='{')claimDepth++;else if(html[i]==='}' && --claimDepth===0){claimEnd=i+1;break;}
  }
  sandbox.claimEvidence=vm.runInContext('(' + html.slice(claimStart,claimEnd) + ')',sandbox);
  if(historyStart<0)throw Error('缺少历史引用降级函数');
  let historyDepth=0,historyEnd=-1;
  for(let i=html.indexOf('{',historyStart);i<html.length;i++){
    if(html[i]==='{')historyDepth++;else if(html[i]==='}' && --historyDepth===0){historyEnd=i+1;break;}
  }
  sandbox.historicalMessages=vm.runInContext('(' + html.slice(historyStart,historyEnd) + ')',sandbox);
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

/* 展开的引用位于阅读消息上方，重复重绘后消息视口位置必须保持。 */
{
  const {sandbox,box}=makeEnv(Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',text:'消息'+i})),{boxTop:200,offsetParentTop:90});
  sandbox.renderConversation();box.rows[0].details[0].open=true;box.rows[1].details[0].open=true;
  await new Promise(r=>setTimeout(r,10));box.scrollTop=650;
  const target=box.rows[3],mid=target.mid,top=target.getBoundingClientRect().top;
  for(let i=0;i<4;i++){sandbox.renderConversation();await new Promise(r=>setTimeout(r,10));}
  const after=box.rows.find(r=>r.mid===mid);
  ok(after.getBoundingClientRect().top===top,'#31 多处引用改变行高，连续四次刷新后同一消息的视口位置保持');
  ok(box.rows[0].details[0].open && box.rows[1].details[0].open,'#31 上方已展开的正文引用保持展开');
}
/* 经验区与正文必须采用相同的状态身份协议，各自保持展开。 */
{
  const {sandbox,box}=makeEnv(msgs(),{currentExperiences:[{url:'https://example.org/experience'}]});
  sandbox.renderConversation();
  const exp=()=>sandbox.area.querySelectorAll('.experience-row')[0].querySelectorAll('.source-details')[0];
  exp().open=true;box.rows[1].details[0].open=true;
  await new Promise(r=>setTimeout(r,10));box.scrollTop=250;
  const top=box.rows[1].getBoundingClientRect().top;
  sandbox.renderConversation();await new Promise(r=>setTimeout(r,10));
  ok(exp().open,'#31 已展开的经验引用在后台刷新后仍展开');
  ok(box.rows[1].details[0].open,'#31 经验区和正文的展开状态互不覆盖');
  ok(box.rows[1].getBoundingClientRect().top===top,'#31 经验引用展开高度恢复后，正文阅读锚点保持');
}
/* 新查询加入经验区会推高消息位置，仍须保留用户正在看的同一条消息。 */
{
  const {sandbox,box}=makeEnv(msgs(),{boxTop:140,offsetParentTop:60});
  sandbox.renderConversation();box.rows[0].details[0].open=true;
  await new Promise(r=>setTimeout(r,10));box.scrollTop=260;
  const top=box.rows[1].getBoundingClientRect().top;
  sandbox.currentExperiences=[{url:'https://example.org/new-experience'}];
  sandbox.renderConversation();await new Promise(r=>setTimeout(r,10));
  ok(box.rows[1].getBoundingClientRect().top===top,'#31 新增经验区域后仍保持同一消息的可视位置');
}

/* 结论引用与原句使用同一来源身份；未通过核对的资料不混进结论卡。 */
{
  const {sandbox}=makeEnv(msgs());
  sandbox.MT.esc=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const markup=sandbox.claimEvidence({sources:[{id:'src_abc',url:'https://example.gov.cn/report',title:'运营方资料'}],
    evidence_claims:[{sentence:'资料记载这条路线可作参考。',allowed_use:'source_reference',supports:[{source_id:'src_abc',quote:'原文称可查询班车 <script>'}]}],
    evidence_inferences:['建议先比较两种路线。']});
  ok(markup.includes('原文称可查询班车 &lt;script&gt;') && !markup.includes('<script>') && markup.includes('https://example.gov.cn/report'),
    '结论卡显示同源原句与链接并转义网页文字');
  ok(markup.includes('探索判断') && !markup.includes('javascript:'),'无来源推断明确分级，不制造链接');
  const previous={role:'assistant',text:'此前资料',sources:[{id:'src_abc',url:'https://example.gov.cn/report'}],evidence_claims:[{sentence:'此前结论',supports:[{source_id:'src_abc',quote:'原句'}]}]};
  const restored=sandbox.historicalMessages([previous])[0];
  ok(restored.evidence_historical===true && previous.evidence_historical!==true && sandbox.claimEvidence(restored).includes('时效需重查'),
    '保存恢复把旧引用降为历史，原消息对象不被改写');
}

console.log(fail === 0 ? `\n✓ 聊天刷新阅读位置回归全部通过（${total} 项断言）` : `\n✗ 失败 ${fail} 项（共 ${total} 项断言）`);
if (fail) process.exit(1);
