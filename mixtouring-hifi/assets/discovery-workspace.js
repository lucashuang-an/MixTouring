/* 比较卡与地图共用服务端比较结果；地图连线为城市位置示意，不表示实际交通路径。 */
(function(root,factory){var api=factory();if(typeof module==='object' && module.exports)module.exports=api;else root.MTDiscovery=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var maps=new WeakMap(),esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  function cardsHtml(comparison,selectedId){return (comparison.routes || []).map(function(r){
    return '<article class="discovery-card '+(r.id===selectedId?'is-inspected':'')+'" data-compare-card="'+esc(r.id)+'"><div class="discovery-eyebrow"><span>'+(r.baseline?'直达基准':r.recommended?'适合你的沿途选择':'另一个方向')+'</span><span>'+esc(r.effort.label)+'</span></div><h3>'+esc(r.title)+'</h3><p class="discovery-path">'+esc(r.route.join(' → '))+'</p><ul class="discovery-benefits">'+r.benefits.map(function(b){return '<li>'+esc(b)+'</li>';}).join('')+'</ul><p class="discovery-reason">'+esc(r.reason)+'</p><div class="discovery-facts"><div><span>时间与节奏</span><p>'+esc(r.time.label)+'</p></div><div><span>费用结构</span><p>'+esc(r.cost.label)+'</p></div></div><p class="discovery-tradeoff">'+esc(r.tradeoff)+'</p><details class="discovery-evidence"><summary>比较依据与下一步</summary><p>'+esc(r.time.basis)+'。</p><p>'+esc(r.cost.basis)+'。</p><p>'+esc(r.critical)+'</p>'+r.sources.map(function(s){return String(s.url || '').startsWith('https://')?'<a target="_blank" rel="noopener noreferrer" href="'+esc(s.url)+'">'+esc(s.title)+' ↗<span>地点背景 · '+esc(s.published_at || '发布日期未明')+'</span></a>':'';}).join('')+'</details>'+(r.variants?.length>1?'<label class="discovery-mode">交通组合<select data-route-variant>'+r.variants.map(function(v){return '<option value="'+esc(v.id)+'">'+esc(v.label)+'</option>';}).join('')+'</select></label>':'<p class="discovery-mode">交通方向<span>'+esc(r.variants?.[0]?.label || '交通方式待查')+'</span></p>')+'<div class="discovery-actions"><button type="button" class="mt-button-secondary" data-inspect-route="'+esc(r.id)+'">在地图上看</button><button type="button" class="mt-button-primary" data-select-route="'+esc(r.id)+'" '+(!r.eligible?'disabled':'')+'>选这条走法 →</button></div></article>';
  }).join('');}
  function mapRender(host,comparison,selectedId,onInspect,onPlace){
    var valid=function(p){return Number.isFinite(p.lat)&&Number.isFinite(p.lon);};
    var routes=comparison.routes || [],points=routes.flatMap(function(r){return r.points.filter(valid);});
    if(!rootLeaflet() || !points.length){host.innerHTML='<div class="map-unavailable">地图暂未加载，仍可先比较下方走法。</div>';return;}
    var L=rootLeaflet(),entry=maps.get(host);
    if(!entry){
      host.innerHTML='';var canvas=document.createElement('div');canvas.className='discovery-map-canvas';host.appendChild(canvas);
      var status=document.createElement('p');status.className='map-status';status.setAttribute('role','status');host.appendChild(status);
      var map=L.map(canvas,{scrollWheelZoom:false,attributionControl:true,zoomControl:false});
      L.control.zoom({zoomInTitle:'放大地图',zoomOutTitle:'缩小地图'}).addTo(map);
      var tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'}).addTo(map);
      tiles.on('tileerror',function(){status.textContent='底图暂不可用，连线仅展示已知城市位置。';});
      var layer=L.layerGroup().addTo(map);entry={map:map,layer:layer,signature:null};maps.set(host,entry);
      map.on('resize',function(){if(entry.bounds)map.fitBounds(entry.bounds,{padding:[36,36],maxZoom:9,animate:false});});
    }
    entry.layer.clearLayers();
    entry.markers={};
    routes.forEach(function(r,index){var active=r.id===selectedId,color=active?'#B35E45':'#9BA7A0';
      r.points.slice(1).forEach(function(p,i){var from=r.points[i];if(valid(p)&&valid(from))L.polyline([[from.lat,from.lon],[p.lat,p.lon]],{color:color,weight:active?4:2,opacity:active ? .9 : .45,dashArray:'7 7'}).addTo(entry.layer).on('click',function(){onInspect(r.id);});});
      if(active)r.points.filter(valid).forEach(function(p,i){var marker=L.circleMarker([p.lat,p.lon],{radius:7,color:'#fff',weight:2,fillColor:'#B35E45',fillOpacity:1}).addTo(entry.layer).bindTooltip(esc(p.name),{permanent:true,direction:i?'top':'bottom'});entry.markers[p.name]=marker;if(onPlace){marker.on('click',function(){onPlace(p.name);});var node=marker.getElement();if(node){node.setAttribute('role','button');node.setAttribute('tabindex','0');node.setAttribute('aria-label','定位'+p.name+'的安排');node.addEventListener('keydown',function(e){if(e.key==='Enter' || e.key===' '){e.preventDefault();onPlace(p.name);}});}}});
    });
    var signature=JSON.stringify(points.map(function(p){return [p.lat,p.lon];}));
    entry.bounds=L.latLngBounds(points.map(function(p){return [p.lat,p.lon];}));
    if(entry.signature!==signature){if(host.getBoundingClientRect().width)entry.map.fitBounds(entry.bounds,{padding:[36,36],maxZoom:9});else entry.pendingFit=true;entry.signature=signature;}
    requestAnimationFrame(function(){entry.map.invalidateSize();});
  }
  function rootLeaflet(){return typeof globalThis!=='undefined'?globalThis.L:null;}
  function render(host,comparison,options){
    options=options || {};var oldMap=host.querySelector('.discovery-map'),selected=options.selectedId || comparison.recommended_id || comparison.routes[0]?.id;
    host.innerHTML='<div class="discovery-heading"><div><p class="mt-eyebrow">'+(options.hasDraft?'继续比较':'发现 · 选择走法')+'</p><h2>先选一种更适合你的旅行</h2><p>'+esc(comparison.trip_days?'全程 '+comparison.trip_days+' 天 · 比较体验与沿途代价':'先比较方向，日期可以之后再确定')+'</p></div></div><div class="discovery-map"></div><div class="map-caption"><span>城市位置与绕行概览 · 虚线为示意，非实际客运路径</span><button type="button" data-map-overview>查看全程</button></div><p class="discovery-notice">'+esc(comparison.notice)+'</p><div class="discovery-grid">'+cardsHtml(comparison,selected)+'</div>';
    var mapHost=host.querySelector('.discovery-map');if(oldMap){mapHost.replaceWith(oldMap);mapHost=oldMap;}
    function inspect(id){options.selectedId=id;host.querySelectorAll('[data-compare-card]').forEach(function(c){c.classList.toggle('is-inspected',c.dataset.compareCard===id);});mapRender(mapHost,comparison,id,inspect,options.onPlace);}
    mapRender(mapHost,comparison,selected,inspect,options.onPlace);
    host.onclick=function(e){var choice=e.target.closest('[data-select-route]'),focus=e.target.closest('[data-inspect-route]');if(choice && !choice.disabled)options.onSelect(choice.closest('article').querySelector('[data-route-variant]')?.value || choice.dataset.selectRoute);else if(focus)inspect(focus.dataset.inspectRoute);else if(e.target.closest('[data-map-overview]')){var entry=maps.get(mapHost);if(entry){entry.signature=null;inspect(options.selectedId || selected);}}};
  }
  function invalidate(host){var entry=maps.get(host);if(!entry)return;entry.map.invalidateSize();if(entry.pendingFit && host.getBoundingClientRect().width && entry.bounds){entry.map.fitBounds(entry.bounds,{padding:[36,36],maxZoom:9});entry.pendingFit=false;}}
  function focusPlace(host,name){var entry=maps.get(host),marker=entry?.markers?.[name];if(!marker)return;Object.keys(entry.markers).forEach(function(key){entry.markers[key].setStyle({fillColor:key===name?'#426747':'#B35E45'});});entry.map.panTo(marker.getLatLng());marker.openTooltip();}
  return {cardsHtml:cardsHtml,render:render,renderMap:mapRender,invalidate:invalidate,focusPlace:focusPlace};
});
