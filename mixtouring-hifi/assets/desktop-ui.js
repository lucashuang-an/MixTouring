/* 桌面设计组件接入真实状态；不替换规划执行器或私人数据。 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const en = () => window.MTLanguage?.locale() === 'en';
  const say = (zh, english) => window.MT?.toast(en() ? english : zh);
  const sidebar = $('sidebarToggle'), account = $('accountToggle'), menu = $('accountMenu');
  function syncSidebar(){
    if(sidebar)sidebar.setAttribute('aria-label',en()?(document.body.classList.contains('mt-sidebar-collapsed')?'Expand sidebar':'Collapse sidebar'):(document.body.classList.contains('mt-sidebar-collapsed')?'展开侧栏':'收起侧栏'));
  }
  function openMenu(last=false){
    if(!menu)return;
    menu.hidden=false;account.setAttribute('aria-expanded','true');
    const links=menu.querySelectorAll('a,button:not([disabled])');(last?links[links.length-1]:links[0])?.focus();
  }
  function closeMenu(returnFocus = false) {
    if (!menu) return;
    menu.hidden = true;
    account.setAttribute('aria-expanded', 'false');
    if (returnFocus) account.focus();
  }
  sidebar?.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('mt-sidebar-collapsed');
    sidebar.setAttribute('aria-expanded', String(!collapsed));
    sidebar.setAttribute('aria-label', en() ? (collapsed ? 'Expand sidebar' : 'Collapse sidebar') : (collapsed ? '展开侧栏' : '收起侧栏'));
  });
  account?.addEventListener('click', () => {
    if(menu.hidden)openMenu();else closeMenu(true);
  });
  account?.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();openMenu(e.key==='ArrowUp');}});
  document.addEventListener('click', e => {
    if (!e.target.closest('.mt-account')) closeMenu();
    document.querySelectorAll('.trip-more[open]').forEach(d=>{if(!d.contains(e.target))d.open=false;});
  });
  document.addEventListener('focusin',e=>{if(menu&&!menu.hidden&&!e.target.closest('.mt-account'))closeMenu();});
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu && !menu.hidden) { closeMenu(true); e.preventDefault(); }
    else if(menu&&!menu.hidden&&menu.contains(e.target)&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
      const links=[...menu.querySelectorAll('a,button:not([disabled])')],index=links.indexOf(e.target);
      const next=e.key==='Home'?0:e.key==='End'?links.length-1:(index+(e.key==='ArrowDown'?1:-1)+links.length)%links.length;
      links[next]?.focus();e.preventDefault();
    }
    if(e.key==='Escape'){const more=e.target.closest('.trip-more[open]');if(more){more.open=false;more.querySelector('summary')?.focus();e.preventDefault();}}
  });
  document.addEventListener('click', e => {
    if (e.target.closest('[data-itinerary-close]')) {
      document.body.classList.add('itinerary-collapsed');
      document.querySelector('[data-itinerary-open]')?.focus();
    }
    if (e.target.closest('[data-itinerary-open]')) {
      document.body.classList.remove('itinerary-collapsed');
      document.querySelector('[data-itinerary-close]')?.focus();
    }
    const tab = e.target.closest('[data-itinerary-tab]');
    if (!tab) return;
    const panel = tab.closest('.dynamic-itinerary'), map = tab.dataset.itineraryTab === 'map';
    panel.dataset.panelView = map ? 'map' : 'itinerary';
    panel.querySelector('.map-view').hidden = !map;
    panel.querySelector('.itinerary-list').hidden = map;
    const dayIndex=panel.querySelector('.itinerary-day-index');if(dayIndex)dayIndex.hidden=map;
    panel.querySelectorAll('[data-itinerary-tab]').forEach(b => b.setAttribute('aria-pressed', String(b === tab)));
    if (map) requestAnimationFrame(() => window.MTDiscovery?.invalidate(panel.querySelector('.current-route-map')));
  });
  document.querySelectorAll('[data-theme-picture]').forEach(button => button.addEventListener('click', () => {
    $('themePicture').src = '../assets/' + button.dataset.themePicture + '.png';
    document.querySelectorAll('[data-theme-picture]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  }));
  const memory = $('composerMemory');
  memory?.setAttribute('title','长期偏好记忆，不影响当前对话上下文');
  $('attachText')?.setAttribute('title','添加 TXT 文本');
  function syncMemory() {
    if (!memory || !window.MTPreferences) return;
    const on = MTPreferences.isEnabled();
    memory.setAttribute('aria-checked', String(on));
    memory.disabled = MTPreferences.status().health !== 'ready';
    $('composerMemoryLabel').textContent = en() ? (on ? 'Memory on' : 'Memory off') : (on ? '记忆已开启' : '记忆已关闭');
  }
  memory?.addEventListener('click', async () => {
    memory.disabled = true;
    try {
      const ok = await MTPreferences.setEnabled(!MTPreferences.isEnabled());
      if (!ok) say('未能保存记忆设置，原记录保留。', 'Memory settings could not be saved. Existing records were kept.');
    } finally { syncMemory(); }
  });
  if (memory) { MTPreferences.subscribe(syncMemory); syncMemory(); }
  const file = $('textAttachment'), input = $('nlInput'), feedback = $('attachmentStatus');
  if(input && window.sessionStorage){try{const idea=(globalThis.MTSessionStorage || sessionStorage).getItem('mt:saved-place-intent');if(idea){input.value=idea.slice(0,input.maxLength);input.dispatchEvent(new Event('input',{bubbles:true}));(globalThis.MTSessionStorage || sessionStorage).removeItem('mt:saved-place-intent');input.focus();}}catch{say('未能读取收藏地点，请重试。','The saved place could not be loaded. Please try again.');}}

  $('attachText')?.addEventListener('click', () => file.click());
  file?.addEventListener('change', async () => {
    const selected = file.files[0];
    if (!selected) return;
    try {
      if (!/\.txt$/i.test(selected.name) || selected.size > 16 * 1024) throw new Error(en() ? 'Choose a TXT file under 16 KB.' : '请选择 16 KB 以内的 TXT 文本。');
      const text = (await selected.text()).trim();
      const combined = [input.value.trim(), text].filter(Boolean).join('\n\n');
      if (!text || combined.length > input.maxLength) throw new Error(en() ? 'The combined message must contain 1–2,000 characters.' : '合并后的旅行想法需为 1—2000 字。');
      input.value = combined;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      feedback.textContent = en() ? 'Text added. Review it before sending.' : '文本已加入，请检查后发送。';
    } catch (error) { feedback.textContent = error.message; }
    feedback.hidden = false;
    file.value = '';
  });
  // 当前语言变化时只同步控件，不翻译旅行正文。
  const languageObserver = new MutationObserver(()=>{syncMemory();syncSidebar();});
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
})();
