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
  // 仅清理提醒段的相邻逐字重复，不跨时段／日期删除安排或改写原句。
  function dedupeNotes(value) {
    if(typeof value!=='string')return '';
    var previousNote=null,note=/^(\s*(?:[-*•]\s*)?(?:提醒|提示|Tips|小贴士|补充|交通说明|注意)[：:]\s*)(.*)$/i;
    return value.split('\n').map(function(line){
      var match=line.match(note);if(!match)return line;
      var previous=null,parts=match[2].match(/[^。！？!?]*[。！？!?]|[^。！？!?]+$/g) || [];
      return match[1]+parts.filter(function(part){var key=part.trim(),duplicate=key===previous;previous=key;return !duplicate;}).join('');
    }).filter(function(line){
      if(!note.test(line)){previousNote=null;return true;}
      var same=previousNote===line.trim();previousNote=line.trim();return !same;
    }).join('\n');
  }
  function cleanDraft(raw, before) {
    if (!raw || typeof raw !== 'object') return null;
    var sections = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, 30).map(function (s) {
      return { title:text(s && s.title, 100), content:text(s && s.content) };
    }).filter(function (s) { return s.title && s.content; });
    var seen = new Set(), old = before && before.cards || [];
    var cards = (Array.isArray(raw.cards) ? raw.cards : []).slice(0, 60).map(function (c) {
      if (!c || typeof c !== 'object') return null;
      var title = text(c.title, 100), place = text(c.place, 80), label = text(c.label, 60), content = text(dedupeNotes(c.content));
      if (!title || !content) return null;
      var matched = old.find(function (x) { return x.id === c.id || x.place === place && x.label === label && x.title === title; });
      var id = matched ? matched.id : /^card-[a-z0-9-]{1,100}$/.test(c.id || '') ? c.id : key(place + '|' + label + '|' + title);
      while (seen.has(id)) id += '-next';
      seen.add(id);
      return Object.assign({ id:id, place:place, label:label, title:title, content:content },activityIndex(content,id,place,raw.route));
    }).filter(Boolean);
    if (!sections.length && !cards.length) return null;
    var route = (Array.isArray(raw.route) ? raw.route : []).map(function (p) { return text(p, 80); }).filter(Boolean).slice(0, 12)
      .filter(function (p, i, all) { return i === 0 || p !== all[i - 1]; });
    return { title:text(raw.title, 100) || '旅行草案', overview:text(raw.overview, 1000), sections:sections,
      cards:cards, route:route, ...(['complete','partial','unreviewed'].includes(raw.quality_status)?{quality_status:raw.quality_status}:{}), pending:(Array.isArray(raw.pending) ? raw.pending : []).map(function (s) { return text(s, 400); }).filter(Boolean).slice(0, 10), evidence_state:'explore',
      ...((raw.map_places || before && before.map_places)?{map_places:(Array.isArray(raw.map_places)?raw.map_places:before?.map_places || []).filter(function(p){return p && route.includes(p.name);}).slice(0,12).map(function(p){return {name:text(p.name,80),name_latin:text(p.name_latin,100),country_hint:/^[A-Z]{2}$/.test(p.country_hint || '')?p.country_hint:null};})}:{}) };
  }
  function cardsFor(draft) {
    return draft.cards && draft.cards.length ? draft.cards : (draft.sections || []).map(function (s, i) {
      return { id:key(s.title + '|' + i), place:'', label:'', title:s.title, content:s.content };
    });
  }
  // 由同一份正文派生活动索引，忽略调用方旧索引，避免局部改稿后地点与详情分叉。
  function activityIndex(content,cardId,city,route) {
    var activities=[],tips=[];
    String(content || '').replace(/([。！？!?；;])\s*-\s*(?=(?:清晨|早上|上午|中午|下午|傍晚|晚上|全天|提醒|补充|Tips)[：:])/g,'$1\n- ').split(/\n+/).map(function(s){return s.replace(/^\s*[-*•]\s+/,'').trim();}).filter(Boolean).forEach(function(line){
      var note=line.match(/^(交通说明|交通|推荐理由|体验亮点|体验|备选|提醒|补充|Tips|小贴士)[：:]/i);
      if(note){tips.push({kind:note[1],text:line.slice(note[0].length)});return;}
      var slot=line.match(/^(清晨|早上|上午|中午|下午|傍晚|晚上|全天)[：:]/),body=slot?line.slice(slot[0].length):line;
      var places=Array.from(body.matchAll(/`([^`\n]{1,80})`/g)).filter(function(m){return m[1]!==city && !(route || []).includes(m[1]) && !/(?:表演|潜水体验|美食体验|接送服务)$/.test(m[1]);}).map(function(m){return {id:'place-'+key(city+'|'+m[1]).slice(5),name:m[1],city:city};});
      activities.push({id:cardId+'-activity-'+(activities.length+1),slot:slot?slot[1]:null,text:body,places:places.filter(function(p,i,a){return a.findIndex(function(q){return q.id===p.id;})===i;})});
    });
    return {activities:activities,tips:tips};
  }
  // 只移走整句核验说明，不删掉限定词后留下确定承诺；不生成任何活动或事实。
  function presentReply(value,removed) {
    var diagnostic=/待查|待核实|待确认|待考证|未核实|未确认|未验证|(?:金额|费用|价格|班次|时刻).{0,8}未知|无法确认|不能确认|不支持|不确定|资料不足|来源不足|仍需核实|仍需确认|另行核对|另行核实|具体.{0,12}(?:需确认|需核对|需核实)|不(?:作|做)?承诺|(?:不|不能|无法|不作|不做)保证|(?:能否|是否).{0,12}(?:准点|按点|当天).{0,8}(?:返|回|到).{0,8}(?:确认|核实)|(?:运营|价格|班次|衔接).{0,15}(?:需|另行).{0,5}(?:确认|核实)/;
    return String(value || '').split(/(?<=[。！？!?；;\n])/).filter(function(sentence){if(/已停运|已关闭|已取消|暂停运营|禁止进入|无法通行/.test(sentence))return true;if(diagnostic.test(sentence)){if(removed)removed.push(sentence.trim());return false;}return true;}).join('').trim();
  }
  function presentDraft(draft) {
    if(!draft)return draft;
    var removed=[],visible=function(value){return presentReply(value,removed);};
    var copy=Object.assign({},draft,{title:visible(draft.title) || (draft.route || []).join(' → '),overview:visible(draft.overview),
      cards:(draft.cards || []).map(function(c){var content=visible(c.content);return Object.assign({},c,{title:visible(c.title) || [c.label,c.place].filter(Boolean).join(' · '),content:content},activityIndex(content,c.id,c.place));}),
      sections:(draft.sections || []).map(function(s){return {title:visible(s.title),content:visible(s.content)};}).filter(function(s){return s.title && s.content;})});
    copy.overview ||= (copy.route || []).join(' → ');
    copy.pending=Array.from(new Set((draft.pending || []).concat(removed))).slice(0,10);return copy;
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
  function transportRoute(route,travel) {
    var chain=(route || []).slice();
    if(travel?.trip_type==='round_trip' && chain.length>1 && chain[chain.length-1]!==chain[0])chain.push(chain[0]);
    return chain;
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
    if(JSON.stringify(before.pending)!==JSON.stringify(after.pending))notes.push('补充规划细节');
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
    if(source.kind==='map')return '<a class="transport-source" href="'+esc(url.href)+'" target="_blank" rel="noopener noreferrer"><span>Google Maps</span>'+esc(source.title)+' ↗</a>';
    var kind=source.kind || (/\.gov(?:\.[a-z]{2})?$/.test(url.hostname)?'official':'guide');
    return '<a class="transport-source" href="'+esc(url.href)+'" target="_blank" rel="noopener noreferrer"><span>'+esc({official:'官方资料',operator:'运营方资料',report:'当地报道',experience:'旅行者经验'}[kind] || '公开资料')+' · '+esc((source.published_at || '发布日期未注明')+(source.date_basis==='search_index'?'（索引日期，原文未确认）':''))+'</span>'+esc(source.title)+' ↗</a>';
  }
  function transportOptionHtml(ref,index,historical) {
    var nodes=ref.route_nodes || [ref.from,ref.to],metrics='';
    if(ref.provider==='Google Maps' && Number.isFinite(ref.route_result?.distance_m) && Number.isFinite(ref.route_result?.duration_s)){var minutes=Math.ceil(ref.route_result.duration_s/60),hours=Math.floor(minutes/60);metrics='<p class="transport-route-metrics">参考里程 '+esc((ref.route_result.distance_m/1000).toFixed(1))+' 公里 · 约 '+esc((hours?hours+'小时':'')+(minutes%60?minutes%60+'分钟':hours?'':'0分钟'))+'</p>';}
    var fallback=ref.map_fallback?'<p class="transport-check">'+esc(ref.map_fallback)+'</p>':'';
    return '<details class="transport-option" data-transport-option="'+esc(JSON.stringify([ref.from,ref.to,ref.id]))+'"'+(!historical && index===0?' open':'')+'><summary>'+esc(ref.label || (ref.mode==='road_passenger'?'国际巴士参考':ref.mode==='plane'?'航空参考':'参考走法'))+'<span>'+esc((ref.selected?'已选 · ':'')+(ref.temporal?.label || '参考方案'))+'</span></summary><p class="transport-path">'+esc(nodes.join(' → '))+'</p>'+fallback+'<p>'+esc(ref.method)+'</p>'+metrics+(ref.reported_boarding_stop?'<p class="transport-boarding">资料中的乘车点：'+esc(ref.reported_boarding_stop)+'</p>':'')+'<div class="transport-sources">'+[ref.source].concat(ref.supplementary_sources || []).filter(Boolean).map(transportSourceHtml).join('')+'</div><p class="transport-check">'+esc(ref.temporal?.reason || '本次班次、日期与费用仍需确认。')+'</p>'+(!historical?'<button type="button" class="transport-discuss" data-discuss-transport="'+esc(ref.id)+'" data-transport-from="'+esc(ref.from)+'" data-transport-to="'+esc(ref.to)+'">聊聊这条走法 ↗</button>':'')+(!historical && ref.can_apply!==false && ['drive','rail','road','plane'].includes(ref.mode)?'<button type="button" class="transport-discuss" data-apply-transport="'+esc(ref.id)+'" data-transport-from="'+esc(ref.from)+'" data-transport-to="'+esc(ref.to)+'">'+(ref.selected?'重新调整交通日':'按此方式调整交通日')+'</button>':'')+'</details>';
  }
  function transportHtml(route,candidate,references,status) {
    var notice=status==='loading'?'<p class="transport-notice" role="status">正在整理参考走法…</p>':status==='error'?'<p class="transport-notice" role="status">参考资料暂未加载。<button type="button" data-retry-transport>重新加载</button></p>':'';
    return notice+route.slice(1).map(function(to,i){
      var from=route[i], segment=(references || []).find(function(s){return s.from===from && s.to===to;}) || {},directions=(segment.directions || []).concat((segment.live?.connection_options || []).filter(function(r){return !(segment.exclude_road && ['drive','road','road_passenger'].includes(r.mode)) && !(segment.no_self_drive && r.mode==='drive');})),options=directions.concat((segment.options || []).filter(function(r){return !directions.some(function(d){return d.id===r.id;});})),archive=segment.archive || [],live=segment.live;
      return '<section class="transport-reference-group"><div class="transport-segment"><span class="transport-symbol" aria-hidden="true">↗</span><div><h4>'+esc(from)+' → '+esc(to)+'</h4><p>'+esc(segment.search_window?'检索时间窗 '+segment.search_window:'先比较交通方式，日期确定后再查班次')+'</p></div></div>'+options.map(function(r,n){var attempt=(live?.map_attempts || []).find(function(a){return a.kind===r.mode;});var fallback=attempt && attempt.status!=='available' && r.provider!=='Google Maps'?'Google Routes 暂未返回这段'+(r.mode==='drive'?'驾车':'公共交通')+'路线，以下为补充资料。':null;return transportOptionHtml(Object.assign({},r,{from:r.from || from,to:r.to || to,map_fallback:fallback,selected:segment.selected_mode===r.mode,can_apply:!segment.read_only}),n,false);}).join('')+
        '<div class="transport-search-bar"><span>'+esc(segment.searching?'正在查询路线工具与补充资料…':live?(live.map_attempts || []).some(function(a){return a.status==='needs_refresh';})?'地图路线参考需重新查询':live.status==='unavailable'?'检索通道暂不可用，无法判断是否存在近期资料':options.length?'按出行日期确认班次、价格与通行条件':live.sources.length?'找到连接资料，具体走法还需整理':'本轮未找到足够的线路资料，可重新查询':options.length?'参考资料仍需核对本次可用性':'优先查询地图路线，缺口再补充资料')+'</span><button type="button" data-search-leg="'+i+'" '+(segment.searching?'disabled':'')+'>'+(segment.searching?'检索中…':live?'重新检索':'查找交通方式')+'</button></div>'+
        (live?'<details class="transport-archive"><summary>检索记录与补充来源</summary><p class="transport-check">'+esc(live.temporal.target_window?'按 '+live.temporal.target_window+' 查询，具体乘车日仍需确认':'按当前日期筛选近期资料')+' · '+(live.restored_lookup?'复用上次检索（未重新搜索）':live.cache_hit?'复用五分钟内查询':'检索于 '+(Number.isFinite(Date.parse(live.retrieved_at))?new Date(live.retrieved_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):'时间未明'))+' · 原文摘录 '+live.reader.available+' / '+live.reader.attempted+'</p><p class="transport-check">'+esc(live.note)+'</p><div class="transport-live-sources">'+live.sources.map(function(source){return transportSourceHtml(source)+'<p class="transport-check">'+esc(source.temporal.label+' · '+(source.read_status==='page_excerpt'?'网页摘录':'搜索摘要，原文未确认'))+'</p>';}).join('')+'</div></details>':'')+
        (directions.some(function(r){return (r.supplementary_sources || []).some(function(x){return x.kind==='experience';});})?'<details class="transport-archive" data-transport-option="community-'+i+'"><summary>社区乘车经验 · 已收录参考</summary><p class="transport-check">保留原帖日期；日期未明或较早内容只帮助了解流程，不证明当前运营。</p>'+directions.flatMap(function(r){return r.supplementary_sources || [];}).filter(function(x,n,all){return x.kind==='experience' && all.findIndex(function(a){return a.url===x.url;})===n;}).map(transportSourceHtml).join('')+'</details>':'')+
        (live && live.experiences?.length?'<details class="transport-experiences"><summary>旅行者经验</summary><p class="transport-check">用于了解乘车流程与取舍，不作为当期班次依据。</p>'+(live.experiences || []).map(transportSourceHtml).join('')+'<p class="transport-check">'+(live.channels || []).map(function(c){return esc(c.channel)+'：'+esc({found:'找到公开资料',empty:'未找到匹配公开帖',unavailable:'检索暂不可用'}[c.status]);}).join(' · ')+'</p></details>':'')+
        (segment.search_error?'<p class="transport-check" role="status">检索暂未完成，请重试；没有用旧资料代替近期结果。</p>':'')+
        (archive.length || live?.archive?.length?'<details class="transport-archive" data-transport-option="archive-'+i+'"><summary>较早／日期未明资料，仅作历史参考</summary><p class="transport-check">以下资料只帮助理解走法，不证明当前班次或日期可用性。</p>'+archive.map(function(r,n){return transportOptionHtml(r,n,true);}).join('')+(live?.archive || []).map(function(source){return transportSourceHtml(source)+'<p class="transport-check">'+esc(source.temporal.label+'：'+source.temporal.reason)+'</p>';}).join('')+'</details>':'')+'</section>';
    }).join('');
  }
  function itineraryTextHtml(value) {
    // 只支持地点标记，所有HTML仍按文本转义，不开放任意Markdown/HTML执行。
    return String(value || '').split(/(`[^`\n]{1,80}`)/g).map(function(part){
      return /^`[^`\n]+`$/.test(part)?'<span class="itinerary-place">'+esc(part.slice(1,-1))+'</span>':esc(part);
    }).join('');
  }
  function itineraryContentHtml(value) {
    var raw=String(value || '').trim(),lines=raw.split(/\n+/).map(function(s){return s.trim();}).filter(Boolean);
    // 老版本散文仅按原句拆行，不补地点、时刻或活动；保存数据保持原样。
    if(lines.length===1 && raw.length>90)lines=raw.match(/[^。！？!?]+[。！？!?]?/g) || lines;
    var schedule=[],notes=[];
    lines.forEach(function(line){
      var content=line.replace(/^\s*(?:[-*•]\s+|\d+[.、]\s*)/,'');
      var note=content.match(/^(交通说明|交通|推荐理由|体验亮点|体验|备选|提醒|补充|Tips|小贴士)[：:]/i);
      if(note){notes.push('<div class="itinerary-note"><dt>'+esc(note[1])+'</dt><dd>'+itineraryTextHtml(content.slice(note[0].length))+'</dd></div>');return;}
      var label=content.match(/^(清晨|早上|上午|中午|下午|傍晚|晚上|全天)[：:]/);
      schedule.push('<li>'+(label?'<strong class="itinerary-slot">'+esc(label[1])+'</strong>'+itineraryTextHtml(content.slice(label[0].length)):itineraryTextHtml(content))+'</li>');
    });
    return (schedule.length?'<ul class="itinerary-points" aria-label="当天安排">'+schedule.join('')+'</ul>':'')+
      (notes.length?'<aside class="itinerary-notes" aria-label="行程补充"><dl>'+notes.join('')+'</dl></aside>':'');
  }
  function cardHtml(card) {
    var named=(card.activities || activityIndex(card.content,card.id,card.place).activities).some(function(a){return a.places.length;});
    var preview=String(card.content || '').split(/\n+/).map(function(s){return s.replace(/^\s*[-*•]\s+/,'').trim();}).filter(function(s){return s && !/^(交通说明|交通|推荐理由|体验亮点|体验|备选|提醒|补充|Tips|小贴士)[：:]/i.test(s);}).slice(0,3).map(function(s){
      var first=s.match(/^[^。！？!?]+[。！？!?]?/)?.[0] || s;
      return first.length>140?first.slice(0,140).replace(/`/g,'')+'…':first;
    }).join('\n');
    return '<div class="itinerary-marker" aria-hidden="true"></div><div class="itinerary-card-body">' +
      (card.label || card.place ? '<div class="itinerary-meta">' + esc([card.label, card.place].filter(Boolean).join(' · ')) + '</div>' : '') +
      '<h3>' + esc(card.title) + '</h3><details class="itinerary-day-details"><summary aria-label="展开或收起'+esc(card.label || '当天')+'详细安排"><div class="itinerary-day-preview">'+itineraryContentHtml(preview)+'</div><span class="day-expand">查看当天详细安排 ↓</span><span class="day-collapse">收起当天详情 ↑</span></summary><div class="itinerary-day-full">'+itineraryContentHtml(card.content)+(named?'<button type="button" class="day-map-button" data-day-map="'+esc(card.id)+'">查看当天地点地图</button><div class="day-map-panel" hidden><div class="day-poi-map discovery-map" aria-label="当天地点地图"></div><p class="day-map-caption" role="status"></p></div>':'')+'</div></details><button type="button" class="card-edit" data-edit-card="' + esc(card.id) + '">调整这段<span aria-hidden="true"> ↗</span></button></div>';
  }
  function render(container, draft, route, candidate, references, transportStatus, onFocusPlace, transportChain) {
    var strip = container.querySelector('.route-strip-host'), routeMarkup = routeHtml(route);
    if (strip.innerHTML !== routeMarkup) strip.innerHTML = routeMarkup;
    var transport=container.querySelector('.transport-list');
    if(transport){
      var opened=new Map(Array.from(transport.querySelectorAll('[data-transport-option]')).map(function(el){return [el.dataset.transportOption,el.open];}));
      transport.innerHTML=transportHtml(transportChain || route,candidate,references,transportStatus);
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
      if (node.innerHTML !== markup) { var existed = !!node.parentNode,expanded=node.querySelector('.itinerary-day-details')?.open; node.innerHTML = markup; if(expanded)node.querySelector('.itinerary-day-details').open=true;if (existed) { node.classList.remove('itinerary-changed'); void node.offsetWidth; node.classList.add('itinerary-changed'); } }
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
  var api = { dedupeNotes:dedupeNotes, cleanDraft:cleanDraft, presentDraft:presentDraft,presentReply:presentReply,cardsFor:cardsFor, routeFor:routeFor, transportRoute:transportRoute, matches:matches, selectedCandidate:selectedCandidate, routeHtml:routeHtml, changes:changes, groupsFor:groupsFor, dayCoverage:dayCoverage, transportHtml:transportHtml, itineraryContentHtml:itineraryContentHtml,cardHtml:cardHtml,render:render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MTRouteWorkspace = api;
})(typeof window !== 'undefined' ? window : globalThis);
