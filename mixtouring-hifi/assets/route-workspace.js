/* 探索草案的结构与卡片视图共用一份数据；不把建议节点升级为交通事实。 */
(function (root) {
  'use strict';
  var text = function (v, n) { return typeof v === 'string' ? v.trim().slice(0, n || 1200) : ''; };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); };
  function key(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return 'card-' + (hash >>> 0).toString(36);
  }
  function cleanDraft(raw, before) {
    if (!raw || typeof raw !== 'object') return null;
    var sections = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, 30).map(function (s) {
      return { title:text(s && s.title, 100), content:text(s && s.content) };
    }).filter(function (s) { return s.title && s.content; });
    var seen = new Set(), old = before && before.cards || [];
    var cards = (Array.isArray(raw.cards) ? raw.cards : []).slice(0, 30).map(function (c) {
      if (!c || typeof c !== 'object') return null;
      var title = text(c.title, 100), place = text(c.place, 80), label = text(c.label, 60), content = text(c.content);
      if (!title || !content) return null;
      var matched = old.find(function (x) { return x.id === c.id || x.place === place && x.label === label && x.title === title; });
      var id = matched ? matched.id : /^card-[a-z0-9-]{1,100}$/.test(c.id || '') ? c.id : key(place + '|' + label + '|' + title);
      while (seen.has(id)) id += '-next';
      seen.add(id);
      return { id:id, place:place, label:label, title:title, content:content };
    }).filter(Boolean);
    if (!sections.length && !cards.length) return null;
    var route = (Array.isArray(raw.route) ? raw.route : []).map(function (p) { return text(p, 80); }).filter(Boolean).slice(0, 12)
      .filter(function (p, i, all) { return i === 0 || p !== all[i - 1]; });
    return { title:text(raw.title, 100) || '旅行草案', overview:text(raw.overview, 1000), sections:sections,
      cards:cards, route:route, pending:(Array.isArray(raw.pending) ? raw.pending : []).map(function (s) { return text(s, 400); }).filter(Boolean).slice(0, 10), evidence_state:'explore' };
  }
  function cardsFor(draft) {
    return draft.cards && draft.cards.length ? draft.cards : (draft.sections || []).map(function (s, i) {
      return { id:key(s.title + '|' + i), place:'', label:'', title:s.title, content:s.content };
    });
  }
  function routeFor(draft, candidate, routing) {
    if (draft && draft.route && draft.route.length > 1) return draft.route;
    var legs = candidate && candidate.legs || [];
    if (legs.length) return legs.map(function (l) { return l.from; }).concat(legs[legs.length - 1].to);
    return [routing && routing.origin, routing && routing.destination].filter(Boolean);
  }
  function matches(route, candidate) {
    return JSON.stringify(route || []) === JSON.stringify(routeFor(null, candidate, null));
  }
  function selectedCandidate(draft, candidates, id) {
    var candidate=(candidates || []).find(function(c){return c.id===id;});
    return candidate && (!(draft && draft.route && draft.route.length) || matches(draft.route,candidate)) ? candidate : null;
  }
  function routeHtml(route) {
    return '<div class="route-strip" aria-label="路线结构">' + route.map(function (p, i) {
      return '<button type="button" class="route-stop" data-focus-place="' + esc(p) + '" aria-pressed="false"><span class="route-dot" aria-hidden="true">'+(i+1)+'</span>' + esc(p) + '</button>' +
        (i < route.length - 1 ? '<span class="route-link" aria-hidden="true">→</span>' : '');
    }).join('') + '</div>';
  }
  function changes(before, after) {
    if (!after) return [];
    if (!before) return ['生成初稿', cardsFor(after).length + ' 张安排卡'];
    var notes=[], oldRoute=before.route || [], nextRoute=after.route || [];
    var added=nextRoute.filter(function(p){return !oldRoute.includes(p);}), removed=oldRoute.filter(function(p){return !nextRoute.includes(p);});
    if(added.length)notes.push('加入 '+added.join('、'));
    if(removed.length)notes.push('移除 '+removed.join('、'));
    if(!added.length && !removed.length && JSON.stringify(oldRoute)!==JSON.stringify(nextRoute))notes.push('调整城市顺序');
    var previous=cardsFor(before), next=cardsFor(after), changed=next.filter(function(c){var old=previous.find(function(x){return x.id===c.id;});return !old || JSON.stringify(old)!==JSON.stringify(c);}).length;
    var deleted=previous.filter(function(c){return !next.some(function(x){return x.id===c.id;});}).length;
    if(changed)notes.push('更新 '+changed+' 张安排卡');
    if(deleted)notes.push('减少 '+deleted+' 张安排卡');
    if(JSON.stringify(before.pending)!==JSON.stringify(after.pending))notes.push('更新待核实事项');
    return notes.length?notes:['保留原安排'];
  }
  function groupsFor(draft) {
    var groups=[];
    cardsFor(draft).forEach(function(card){
      var place=card.place || '沿途安排', last=groups[groups.length-1];
      if(!last || last.place!==place){last={place:place,cards:[]};groups.push(last);}
      last.cards.push(card);
    });
    return groups;
  }
  function dayCoverage(draft, days) {
    if(!days)return null;
    var covered=new Set(), hasDays=false, outside=[];
    cardsFor(draft).forEach(function(c){var m=(c.label || '').match(/^第\s*(\d+)\s*(?:[—–\-~至到]\s*(\d+)\s*)?天/);if(!m)return;
      hasDays=true;var start=Number(m[1]),end=Number(m[2] || m[1]);
      if(start<1 || end<start || end>days){outside.push(c.label);return;}
      for(var i=start;i<=end;i++)covered.add(i);
    });
    return hasDays?{missing:Array.from({length:days},function(_,i){return i+1;}).filter(function(n){return !covered.has(n);}),outside:outside}:null;
  }
  function transportSourceHtml(source) {
    var url;try{url=new URL(source.url);if(url.protocol!=='https:')return '';}catch(e){return '';}
    var kind=source.kind || (/\.gov(?:\.[a-z]{2})?$/.test(url.hostname)?'official':'guide');
    return '<a class="transport-source" href="'+esc(url.href)+'" target="_blank" rel="noopener noreferrer"><span>'+esc({official:'官方资料',operator:'运营方资料',report:'当地报道',experience:'旅行者经验'}[kind] || '公开资料')+' · '+esc((source.published_at || '发布日期未注明')+(source.date_basis==='search_index'?'（索引日期，原文未确认）':''))+'</span>'+esc(source.title)+' ↗</a>';
  }
  function transportOptionHtml(ref,index,historical) {
    var nodes=ref.route_nodes || [ref.from,ref.to];
    return '<details class="transport-option" data-transport-option="'+esc(ref.id)+'"'+(!historical && index===0?' open':'')+'><summary>'+esc(ref.label || (ref.mode==='road_passenger'?'国际巴士参考':ref.mode==='plane'?'航空参考':'参考走法'))+'<span>'+esc(ref.temporal?.label || '参考方案')+'</span></summary><p class="transport-path">'+esc(nodes.join(' → '))+'</p><p>'+esc(ref.method)+'</p>'+(ref.reported_boarding_stop?'<p class="transport-boarding">资料中的乘车点：'+esc(ref.reported_boarding_stop)+'</p>':'')+'<div class="transport-sources">'+[ref.source].concat(ref.supplementary_sources || []).filter(Boolean).map(transportSourceHtml).join('')+'</div><p class="transport-check">'+esc(ref.temporal?.reason || '本次班次、日期与费用仍需确认。')+'</p>'+(!historical?'<button type="button" class="transport-discuss" data-discuss-transport="'+esc(ref.id)+'">聊聊这条走法 ↗</button>':'')+'</details>';
  }
  function transportHtml(route,candidate,references,status) {
    var notice=status==='loading'?'<p class="transport-notice" role="status">正在整理参考走法…</p>':status==='error'?'<p class="transport-notice" role="status">参考资料暂未加载。<button type="button" data-retry-transport>重新加载</button></p>':'';
    return notice+route.slice(1).map(function(to,i){
      var from=route[i], segment=(references || []).find(function(s){return s.from===from && s.to===to;}) || {},directions=segment.directions || [],options=directions.concat((segment.options || []).filter(function(r){return !directions.some(function(d){return d.id===r.id;});})),archive=segment.archive || [],live=segment.live;
      return '<section class="transport-reference-group"><div class="transport-segment"><span class="transport-symbol" aria-hidden="true">↗</span><div><h4>'+esc(from)+' → '+esc(to)+'</h4><p>'+esc(segment.search_window?'检索时间窗 '+segment.search_window:'日期未定，先查近期资料')+'</p></div></div>'+options.map(function(r,n){return transportOptionHtml(r,n,false);}).join('')+
        '<div class="transport-search-bar"><span>'+esc(segment.searching?'正在检索并核对资料日期…':live?live.status==='unavailable'?'检索通道暂不可用，无法判断是否存在近期资料':live.sources.length?'找到近期连接线索，班次仍待确认':'尚无近期运营资料；参考走法不代表本次班次已核实':options.length?'参考资料仍需核对本次可用性':'暂无通过时效筛选的近期参考（交通复核期90天）')+'</span><button type="button" data-search-leg="'+i+'" '+(segment.searching?'disabled':'')+'>'+(segment.searching?'检索中…':live?'重新检索':'查交通与社区经验')+'</button></div>'+
        (live?'<p class="transport-check">'+esc(live.temporal.target_window?'按 '+live.temporal.target_window+' 查询，具体乘车日仍需确认':'按当前日期筛选近期资料')+' · '+(live.cache_hit?'复用五分钟内查询':'检索于 '+(Number.isFinite(Date.parse(live.retrieved_at))?new Date(live.retrieved_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):'时间未明'))+' · 原文摘录 '+live.reader.available+' / '+live.reader.attempted+'</p><p class="transport-check">'+esc(live.note)+'</p><div class="transport-live-sources">'+live.sources.map(function(source){return transportSourceHtml(source)+'<p class="transport-check">'+esc(source.temporal.label+' · '+(source.read_status==='page_excerpt'?'网页摘录':'搜索摘要，原文未确认'))+'</p>';}).join('')+'</div>':'')+
        (directions.some(function(r){return (r.supplementary_sources || []).some(function(x){return x.kind==='experience';});})?'<details class="transport-archive" data-transport-option="community-'+i+'"><summary>社区乘车经验 · 已收录参考</summary><p class="transport-check">保留原帖日期；日期未明或较早内容只帮助了解流程，不证明当前运营。</p>'+directions.flatMap(function(r){return r.supplementary_sources || [];}).filter(function(x,n,all){return x.kind==='experience' && all.findIndex(function(a){return a.url===x.url;})===n;}).map(transportSourceHtml).join('')+'</details>':'')+
        (live?'<div class="transport-experiences"><h4>旅行者经验</h4><p class="transport-check">用于了解乘车流程与取舍，不作为当期班次依据。</p>'+(live.experiences || []).map(transportSourceHtml).join('')+'<p class="transport-check">'+(live.channels || []).map(function(c){return esc(c.channel)+'：'+esc({found:'找到公开资料',empty:'未找到匹配公开帖',unavailable:'检索暂不可用'}[c.status]);}).join(' · ')+'</p></div>':'')+
        (segment.search_error?'<p class="transport-check" role="status">检索暂未完成，请重试；没有用旧资料代替近期结果。</p>':'')+
        (archive.length || live?.archive?.length?'<details class="transport-archive" data-transport-option="archive-'+i+'"><summary>较早／日期未明资料，仅作历史参考</summary><p class="transport-check">以下资料未进入当前参考与模型的现时回答。</p>'+archive.map(function(r,n){return transportOptionHtml(r,n,true);}).join('')+(live?.archive || []).map(function(source){return transportSourceHtml(source)+'<p class="transport-check">'+esc(source.temporal.label+'：'+source.temporal.reason)+'</p>';}).join('')+'</details>':'')+'</section>';
    }).join('');
  }
  function cardHtml(card) {
    return '<div class="itinerary-marker" aria-hidden="true"></div><div class="itinerary-card-body">' +
      (card.label || card.place ? '<div class="itinerary-meta">' + esc([card.label, card.place].filter(Boolean).join(' · ')) + '</div>' : '') +
      '<h3>' + esc(card.title) + '</h3><p>' + esc(card.content) + '</p><button type="button" class="card-edit" data-edit-card="' + esc(card.id) + '">调整这段<span aria-hidden="true"> ↗</span></button></div>';
  }
  function render(container, draft, route, candidate, references, transportStatus, onFocusPlace) {
    var strip = container.querySelector('.route-strip-host'), routeMarkup = routeHtml(route);
    if (strip.innerHTML !== routeMarkup) strip.innerHTML = routeMarkup;
    var transport=container.querySelector('.transport-list');
    if(transport){
      var opened=new Map(Array.from(transport.querySelectorAll('[data-transport-option]')).map(function(el){return [el.dataset.transportOption,el.open];}));
      transport.innerHTML=transportHtml(route,candidate,references,transportStatus);
      transport.querySelectorAll('[data-transport-option]').forEach(function(el){if(opened.has(el.dataset.transportOption))el.open=opened.get(el.dataset.transportOption);});
    }
    var list = container.querySelector('.itinerary-list'), nodes=Array.from(list.querySelectorAll('[data-card-id]'));
    var oldGroups=Array.from(list.children), used=new Set();
    groupsFor(draft).forEach(function(group,index){
      var section=oldGroups.find(function(el){return el.dataset.groupPlace===group.place && !used.has(el);});
      if(!section){section=document.createElement('section');section.className='itinerary-city';section.dataset.groupPlace=group.place;section.innerHTML='<div class="city-heading"><span class="city-number"></span><div><h3></h3><p></p></div></div><div class="city-cards"></div>';}
      used.add(section);section.querySelector('.city-number').textContent=index+1;
      section.querySelector('.city-heading h3').textContent=group.place;
      section.querySelector('.city-heading p').textContent=group.cards.length+' 项建议安排';
      group.cards.forEach(function(card){
      var node = nodes.find(function (el) { return el.dataset.cardId === card.id; });
      if (!node) { node = document.createElement('article'); node.className = 'itinerary-card'; node.dataset.cardId = card.id; }
      var markup = cardHtml(card);
      if (node.innerHTML !== markup) { var existed = !!node.parentNode; node.innerHTML = markup; if (existed) { node.classList.remove('itinerary-changed'); void node.offsetWidth; node.classList.add('itinerary-changed'); } }
      section.querySelector('.city-cards').appendChild(node);
      });
      Array.from(section.querySelectorAll('[data-card-id]')).forEach(function(el){if(!group.cards.some(function(c){return c.id===el.dataset.cardId;}))el.remove();});
      list.appendChild(section);
    });
    oldGroups.forEach(function(el){if(!used.has(el))el.remove();});
    strip.querySelectorAll('[data-focus-place]').forEach(function(button){button.onclick=function(){
      if(onFocusPlace)onFocusPlace(button.dataset.focusPlace);
      var target=Array.from(list.children).find(function(el){return el.dataset.groupPlace===button.dataset.focusPlace;});
      strip.querySelectorAll('[data-focus-place]').forEach(function(b){b.setAttribute('aria-pressed',String(b===button));});
      list.querySelectorAll('.is-focused').forEach(function(el){el.classList.remove('is-focused');});
      var note=container.querySelector('.route-focus-note');
      if(note)note.textContent=target?'已定位 '+button.dataset.focusPlace+' 的安排':button.dataset.focusPlace+' 目前是交通节点，停留安排尚未分配。';
      if(target){target.classList.add('is-focused');target.setAttribute('tabindex','-1');target.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});target.focus({preventScroll:true});}
    };});
  }
  var api = { cleanDraft:cleanDraft, cardsFor:cardsFor, routeFor:routeFor, matches:matches, selectedCandidate:selectedCandidate, routeHtml:routeHtml, changes:changes, groupsFor:groupsFor, dayCoverage:dayCoverage, transportHtml:transportHtml, render:render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MTRouteWorkspace = api;
})(typeof window !== 'undefined' ? window : globalThis);
