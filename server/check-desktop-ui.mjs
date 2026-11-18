import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const {window,document}=parseHTML(readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8'));
let enabled=false,refuse=false,subscribers=[],messages=[];
const prefs={isEnabled:()=>enabled,status:()=>({health:'ready'}),subscribe:f=>subscribers.push(f),setEnabled:async value=>{if(refuse)return false;enabled=value;subscribers.forEach(f=>f());return true;}};
window.MTPreferences=prefs;window.MTLanguage={locale:()=> 'zh-CN'};window.MT={toast:s=>messages.push(s)};
const context=vm.createContext({window,document,MTPreferences:prefs,Event:window.Event,MutationObserver:window.MutationObserver});
vm.runInContext(readFileSync(new URL('../mixtouring-hifi/assets/desktop-ui.js',import.meta.url),'utf8'),context);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const $=id=>document.getElementById(id);
$('composerMemory').click();await tick();assert.equal(enabled,true);assert.equal($('composerMemory').getAttribute('aria-checked'),'true');
refuse=true;$('composerMemory').click();await tick();assert.equal(enabled,true);assert.equal($('composerMemory').getAttribute('aria-checked'),'true');assert.equal(messages.length,1);
const input=$('nlInput'),file=$('textAttachment');input.maxLength=2000;input.value='原有条件';let submissions=0,changes=0;
$('conversationComposer').addEventListener('submit',()=>submissions++);input.addEventListener('input',()=>changes++);
file.files=[{name:'旅行.txt',size:50,text:async()=> '新增中文条件'}];file.dispatchEvent(new window.Event('change'));await tick();
assert.equal(input.value,'原有条件\n\n新增中文条件');assert.equal(changes,1);assert.equal(submissions,0);
for(const f of [{name:'图片.png',size:10,text:async()=> '不应读取'},{name:'过大.txt',size:20000,text:async()=> '不应读取'},{name:'超长.txt',size:3000,text:async()=> '长'.repeat(2001)}]){
 const before=input.value;file.files=[f];file.dispatchEvent(new window.Event('change'));await tick();assert.equal(input.value,before);assert.equal(submissions,0);assert.equal($('attachmentStatus').hidden,false);
}
$('accountToggle').click();assert.equal($('accountMenu').hidden,false);assert.equal($('accountToggle').getAttribute('aria-expanded'),'true');
$('sidebarToggle').click();assert.equal(document.body.classList.contains('mt-sidebar-collapsed'),true);
assert.equal(document.querySelectorAll('.mt-nav-links a').length,4);
console.log('✓ 桌面组件：记忆拒写不假成功、TXT合并保留原文、错误不改输入、附件不自动发送、菜单与侧栏通过');

assert.equal(document.querySelector('#anchorPanel,#prefMemoryPanel'),null,'旧折叠面板已删除');
assert.equal(document.querySelectorAll('.entry-examples [data-idea]').length,3,'与新版三个快捷入口一致');

// 翻译或收藏控件改变DOM不能被误判为日卡内容改变。
vm.runInContext(readFileSync(new URL('../mixtouring-hifi/assets/route-workspace.js',import.meta.url),'utf8'),context);
const workspace=window.MTRouteWorkspace,host=document.createElement('div');
host.innerHTML='<div class="route-strip-host"></div><div class="transport-list"></div><div class="itinerary-list"></div>';
document.body.append(host);
const draft=workspace.cleanDraft({title:'Test',route:['A','B'],cards:[{id:'card-day-1',place:'B',label:'第1天',title:'Walk',content:'上午：散步。'},{id:'card-day-2',place:'B',label:'第2天',title:'Rest',content:'下午：休息。'}]});
const render=d=>workspace.render(host,d,['A','B'],null,[],'ready');render(draft);
const first=host.querySelector('[data-card-id="card-day-1"]'),body=first.querySelector('.itinerary-card-body');
first.querySelector('.card-edit').textContent='Adjust this day';first.querySelector('details').open=true;
render(draft);assert.equal(first.querySelector('.itinerary-card-body'),body);assert.equal(first.querySelector('details').open,true);assert.equal(first.classList.contains('itinerary-changed'),false);
render({...draft,cards:[draft.cards[0],{...draft.cards[1],content:'下午：慢慢散步。'}]});
assert.equal(first.querySelector('.itinerary-card-body'),body,'改第二天不重绘第一天');
assert.equal(host.querySelector('[data-card-id="card-day-2"]').classList.contains('itinerary-changed'),true);
console.log('✓ 英文UI重译不触发日卡重绘，真实局部变化仅更新受影响日卡');

for(const name of readdirSync(new URL('../mixtouring-hifi/pages/',import.meta.url)).filter(n=>n.endsWith('.html'))){
 const html=readFileSync(new URL('../mixtouring-hifi/pages/'+name,import.meta.url),'utf8');
 assert.equal((html.match(/id="mainContent"/g)||[]).length,1,name+'唯一正文目标');
 assert.equal((html.match(/class="mt-skip"/g)||[]).length,1,name+'唯一跳转链接');
 assert.ok(html.indexOf('<nav ')<html.indexOf('<main '),name+'导航在正文之前');
}
console.log('✓ 全部正式页面的跳转目标及键盘导航顺序一致');

// 执行正式页面注册的键盘处理器，不复制其判断逻辑。
const page=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');
const keyboard=page.match(/document\.getElementById\('nlInput'\)\.addEventListener\('keydown', (function \(event\) \{[\s\S]*?\n    \})\);/)[1];
let submitCount=0,preventCount=0;
const onKey=vm.runInNewContext('('+keyboard+')',{composer:{requestSubmit:()=>submitCount++}});
const event=extra=>({key:'Enter',shiftKey:false,isComposing:false,keyCode:13,preventDefault:()=>preventCount++,...extra});
onKey(event({isComposing:true}));assert.equal(submitCount,0,'组词中Enter不得提交');
onKey(event({keyCode:229}));assert.equal(submitCount,0,'IME处理键不得提交');
onKey(event({shiftKey:true}));assert.equal(submitCount,0,'Shift+Enter保留换行');
onKey(event({key:'a'}));assert.equal(submitCount,0);
onKey(event({}));assert.equal(submitCount,1,'普通Enter恰好提交一次');assert.equal(preventCount,1);
console.log('✓ 正式输入处理器：组词、IME处理键、换行与普通Enter边界通过（非OS候选窗口测试）');

// 回归执行正式详情弹窗的Tab边界处理器。
const personalSource=readFileSync(new URL('../mixtouring-hifi/assets/personal-ui.js',import.meta.url),'utf8');
const focusHandler=personalSource.match(/dialog\.addEventListener\('keydown',(e=>\{[\s\S]*?\})\);document\.body\.append\(dialog\)/)[1];
const focusDocument={activeElement:null};const controls=[0,1,2].map(id=>({id,getClientRects:()=>[{}],focus(){focusDocument.activeElement=this;}}));
const focusKey=vm.runInNewContext('('+focusHandler+')',{document:focusDocument,dialog:{querySelectorAll:()=>controls}});
let prevented=0;focusDocument.activeElement=controls[0];focusKey({key:'Tab',shiftKey:true,preventDefault:()=>prevented++});assert.equal(focusDocument.activeElement,controls[2]);
focusKey({key:'Tab',shiftKey:false,preventDefault:()=>prevented++});assert.equal(focusDocument.activeElement,controls[0]);
focusDocument.activeElement=controls[1];focusKey({key:'Tab',shiftKey:false,preventDefault:()=>prevented++});assert.equal(prevented,2,'中间控件仍走原生Tab顺序');
console.log('✓ 弹窗正式事件处理器首尾循环与中间Tab顺序通过');

// 实际页面按服务端模型能力显示推理控件，不向DeepSeek用户展示无效设置。
{
 const page=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');
 const code=page.split('\n').find(line=>line.includes("fetch('/api/capabilities'"));assert(code);
 for(const provider of ['openai','deepseek',null]){const select={hidden:true};await vm.runInNewContext(code,{reasoningSelect:select,fetch:async()=>({ok:true,json:async()=>({data:{model:provider?{provider}:null}})})});assert.equal(select.hidden,provider!=='openai');}
 const select={hidden:true};await vm.runInNewContext(code,{reasoningSelect:select,fetch:async()=>{throw Error('offline');}});assert.equal(select.hidden,true);
}
