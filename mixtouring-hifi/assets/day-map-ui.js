(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MTDayMap=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  function keyFor(card,hint){var places=Array.from(new Set((card.activities || []).flatMap(function(a){return a.places.map(function(p){return p.name;});}))).slice(0,8);return {places:places,key:JSON.stringify(['day-map-v3',card.place,places,hint])};}
  function snapshot(value){
    if(!value)return value;
    if(value.provider!=='Google Maps' && !(value.points || []).some(function(p){return p.provider==='Google Maps';}))return value;
    return {key:value.key,provider:'Google Maps',attribution:'Google Maps',status:'references',cacheable:false,points:(value.points || []).map(function(p){return {name:p.name,provider:'Google Maps',provider_id:p.provider_id || null,lat:null,lon:null};})};
  }
  function snapshots(values){return Object.fromEntries(Object.entries(values || {}).map(function(entry){return [entry[0],snapshot(entry[1])];}));}
  function routeSequence(card){return (card.activities || []).flatMap(function(a){return (a.places || []).map(function(p){return p.name;});}).filter(function(name,i,a){return i===0 || name!==a[i-1];});}
  function minutes(seconds){var n=Math.ceil(seconds/60);return n>=60?Math.floor(n/60)+'小时'+(n%60?n%60+'分钟':''):n+'分钟';}
  function distance(m){return m>=1000?(m/1000).toFixed(1)+'公里':Math.round(m)+'米';}
  function scheduleHtml(data){
    if(!data || data.status==='invalid')return '<p>请检查日期、停留时间和地点数量。</p>';
    function branch(value,label){
      var state=value.activity_schedule,text=state==='conflict'?'超出时间窗口，需要调整安排':state==='fits_under_assumptions'?'按填写的停留时间，已查询路段可放入时间窗口':'信息仍不完整，暂不能判断是否能走完';
      return '<p>'+esc(label+'：'+text)+'</p>'+(value.coverage!=='including_anchors'?'<p>首末段未计入，可填写出发地和结束地后再核对。</p>':'')+
        '<ol class="day-travel-legs">'+(value.observations||[]).map(function(o){return '<li><strong>'+esc(o.from+' → '+o.to)+'</strong><span>'+esc(o.status==='available'?'约'+distance(o.distance_m)+' · '+minutes(o.duration_s):'该路段尚未查到参考')+'</span></li>';}).join('')+'</ol>';
    }
    return branch(data.required,'必选活动')+(data.with_optional?branch(data.with_optional,'包含可选活动'):'')+'<p>这是按本次填写条件计算的参考，不修改旅行日期或当前行程。交通会随查询时刻变化。</p>';
  }
  function addScheduleForm(transport,options,sequence,mode,localTime,current,controller){
    if(!options.scheduleRequest || sequence.length<2 || sequence.length>12)return;
    var section=document.createElement('details');section.className='day-schedule-check';
    section.innerHTML='<summary>核对当天时间安排</summary><form><label>出发时间（本机时区）<input name="departure" type="datetime-local" required value="'+esc(localTime)+'"></label><label>结束时间（本机时区）<input name="deadline" type="datetime-local" required></label><label>出发地点（可不填）<input name="start" maxlength="80"></label><label>结束地点（可不填）<input name="end" maxlength="80"></label>'+sequence.map(function(name,i){return '<div class="day-schedule-event"><label>'+esc(name)+' · 停留分钟<input name="stay-'+i+'" type="number" min="0" max="1440" required></label><label><input name="optional-'+i+'" type="checkbox">可选</label></div>';}).join('')+'<button type="submit" class="mt-text-button">按这些条件核对</button></form><div class="day-schedule-result" role="status"></div>';
    transport.appendChild(section);var form=section.querySelector('form'),result=section.querySelector('.day-schedule-result'),generation=0;
    form.oninput=function(){generation++;result.textContent='条件已改变，请重新核对。';};
    form.onsubmit=async function(event){event.preventDefault();if(!form.reportValidity())return;
      var ticket=++generation,button=form.querySelector('button');button.disabled=true;result.textContent='正在按顺序查询交通…';
      var field=function(name){return form.elements.namedItem(name);};
      try{var response=await options.scheduleRequest({city:options.card.place,city_hint:(options.draft.map_places||[]).find(function(p){return p.name===options.card.place;}) || null,
        schedule:{mode:mode,departure:new Date(field('departure').value).toISOString(),deadline:new Date(field('deadline').value).toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
          start_name:field('start').value.trim()||null,end_name:field('end').value.trim()||null,events:sequence.map(function(name,i){return {name:name,stay_minutes:Number(field('stay-'+i).value),optional:field('optional-'+i).checked};})}},controller.signal);
        if(current()&&ticket===generation)result.innerHTML=scheduleHtml(response.data);
      }catch(e){if(current()&&ticket===generation)result.textContent='核对未完成，当前安排已保留。';}
      finally{if(current())button.disabled=false;}
    };
  }
  function transportHtml(data){
    if(!data || data.status==='not_applicable')return '<p>至少标注两个地点后，可查询地点间交通。</p>';
    if(data.status==='invalid')return '<p>交通查询条件无效，请调整方式或参考时间。</p>';
    var labels={TRANSIT:'公交',WALK:'步行',DRIVE:'车行（打车／接送参考）'};
    var rows=(data.legs || []).map(function(l){var valid=l.status==='available' && Number.isFinite(l.distance_m)&&Number.isFinite(l.duration_s);
      var text=valid?'约'+distance(l.distance_m)+' · '+minutes(l.duration_s):l.status==='unresolved'?'地点未定位，未查询':l.status==='no_route'?(l.mode==='TRANSIT'?'该参考时刻未返回路线':'该方式未返回路线'):l.status==='unsupported'?'超出可查询的时间范围':'路线查询未完成';
      var link=/^https:\/\/www\.google\.com\/maps\/dir\//.test(l.source_url || '')?'<a href="'+esc(l.source_url)+'" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>':'';
      return '<li><strong>'+esc(l.from+' → '+l.to)+'</strong><span>'+esc((l.walking_only?'公交查询返回步行方案':labels[l.mode]||'交通')+' · '+text)+'</span>'+link+'</li>';}).join('');
    var summary=data.summary?'<p>'+ (data.summary.complete?'参考合计':'已查到的路段合计')+'：约'+distance(data.summary.distance_m)+' · '+minutes(data.summary.duration_s)+(data.coverage?.missing?'；另有'+data.coverage.missing+'段未计入':'')+'</p>':'';
    return '<ol class="day-travel-legs">'+rows+'</ol>'+summary+(data.planning_hints?.includes('long_transfers')?'<p>有路段参考用时超过90分钟，可优先核对这段衔接。</p>':'')+
      '<p class="day-travel-basis">各段独立查询，合计不含游览停留及未标注的首末段。'+(data.mode==='TRANSIT'?'参考时刻不是已确认的旅行日期。':data.mode==='DRIVE'?'车行时长不含实时路况，也不代表已安排接送。':'步行结果仅作参考。')+(data.includes_optional?'顺序包含文中的可选地点。':'')+(data.coverage?.omitted_stops?'另有'+data.coverage.omitted_stops+'个地点未纳入本次查询。':'')+'</p>';
  }
  async function show(options){
    var card=options.card,node=options.node,button=options.button,hint=(options.draft.map_places || []).find(function(p){return p.name===card.place;}) || null,binding=keyFor(card,hint);
    var panel=node.querySelector('.day-map-panel'),host=panel.querySelector('.day-poi-map'),caption=panel.querySelector('.day-map-caption');
    var sequence=routeSequence(card),mode=options.transportMode || panel._transportMode || 'WALK',localTime=options.departureLocal===undefined?(panel._departureLocal || ''):options.departureLocal;
    var departure=localTime && Number.isFinite(Date.parse(localTime))?new Date(localTime).toISOString():null;
    binding.key=JSON.stringify([binding.key,sequence,mode,departure]);
    panel._transportMode=mode;panel._departureLocal=localTime;var oldTransport=panel.querySelector('.day-transport');if(oldTransport)oldTransport.hidden=true;
    panel._routeController?.abort();panel._routeController=new AbortController();var controller=panel._routeController;
    var current=function(){return !controller.signal.aborted && node.isConnected && (!options.isCurrent || options.isCurrent());};
    button.disabled=true;button.textContent='正在定位地点…';panel.hidden=false;
    try{
      var result=options.cache[binding.key];
      if(!result || result.status==='references'){var response=await options.request({city:card.place,places:binding.places,city_hint:hint,sequence:sequence,transport_mode:mode,departure_time:departure,optional:(card.activities || []).some(function(a){return /或|可选|若|视.{0,8}情况/.test(a.text);})},controller.signal);result=response.data;if(!result || !Array.isArray(result.points))throw Error('empty');
        if(!current())return;
        options.cache[binding.key]=result.cacheable===false?snapshot(result):result;var keys=Object.keys(options.cache);if(keys.length>60)delete options.cache[keys[0]];if(options.onCache)options.onCache();}
      if(!current())return;
      options.renderMap(host,{point_kind:'poi',provider:result.provider,routes:[{id:'day',points:result.points}]},'day',function(){},function(name){
        node.querySelectorAll('.itinerary-place').forEach(function(el){el.classList.toggle('is-map-focused',el.textContent===name);});
      });
      var count=result.points.filter(function(p){return Number.isFinite(p.lat)&&Number.isFinite(p.lon);}).length;
      caption.textContent=count+'/'+binding.places.length+' 个地点';
      var missing=result.points.filter(function(p){return p.lat==null;});
      if(missing.length){var links=document.createElement('div');links.className='day-map-search-links';
        missing.forEach(function(p){var a=document.createElement('a');a.textContent=p.name;a.href=result.provider==='Google Maps'?'https://www.google.com/maps/search/?'+new URLSearchParams({api:'1',query:card.place+' '+p.name}):'https://www.openstreetmap.org/search?'+new URLSearchParams({query:card.place+' '+p.name});a.target='_blank';a.rel='noopener noreferrer';links.appendChild(a);});caption.appendChild(links);}
      if(result.provider==='Google Maps' && new Set(sequence).size>=2){
        var transport=panel.querySelector('.day-transport');if(!transport){transport=document.createElement('div');transport.className='day-transport';panel.appendChild(transport);}
        transport.hidden=false;transport.innerHTML='<div class="day-travel-controls"><label>交通方式<select aria-label="交通方式"><option value="TRANSIT">公交</option><option value="WALK">步行</option><option value="DRIVE">车行（打车／接送参考）</option></select></label><label>公交查询时间（'+esc(Intl.DateTimeFormat().resolvedOptions().timeZone)+'，非行程日期）<input type="datetime-local" aria-label="参考出发时间"></label><button type="button" class="mt-text-button">更新交通参考</button><span class="day-travel-stale" role="status"></span></div>'+transportHtml(result.transport);
        var select=transport.querySelector('select'),date=transport.querySelector('input'),update=transport.querySelector('button');select.value=mode;date.value=localTime;date.disabled=mode!=='TRANSIT';var markDirty=function(){transport.querySelector('.day-travel-stale').textContent=select.value!==mode || select.value==='TRANSIT' && date.value!==localTime?'条件已改变，请更新交通参考。':'';};select.onchange=function(){date.disabled=select.value!=='TRANSIT';markDirty();};date.onchange=markDirty;
        update.onclick=function(){if(select.value==='TRANSIT'&&!date.value){date.required=true;date.reportValidity();return;}update.disabled=true;show(Object.assign({},options,{transportMode:select.value,departureLocal:date.value}));};
        addScheduleForm(transport,options,sequence,mode,localTime,current,controller);
      }
      button.textContent='查看当天地图与交通';
    }catch(e){if(current()){caption.textContent='地图加载失败，可重新点击；当天文字安排已保留。';button.textContent='重新加载当天地图';}}
    finally{if(current()){button.disabled=false;var updateButton=panel.querySelector('.day-travel-controls button');if(updateButton)updateButton.disabled=false;}}
  }
  return {show:show,keyFor:keyFor,snapshot:snapshot,snapshots:snapshots,routeSequence:routeSequence,transportHtml:transportHtml,scheduleHtml:scheduleHtml};
});
