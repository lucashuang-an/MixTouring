/* 从当前私人任务派生草案；未分配的景点保留待安排，不生成班次或自动分日。 */
(function(root) {
  'use strict';
  function derive(snapshot, catalog) {
    var s=snapshot || {}, a=s.anchors || {}, travel=s.travel || {}, constraints=s.constraints || {}, rows=[];
    ['outbound','return'].forEach(function(dir){var x=a[dir];if(!x)return;
      rows.push({date:x.date,label:(dir==='outbound'?'去程':'返程')+'：'+x.from_city+' → '+x.to_city,
        note:'已定交通 · '+(x.depart_time || '出发时刻待补')+'（出发地当地时间）'+(x.service_no?' · '+x.service_no:'')});
      if(dir==='outbound' && x.arrive_date) rows.push({date:x.arrive_date,label:'抵达 '+x.to_city,note:(x.arrive_time || '到达时刻待补')+'（到达地当地时间）'});
    });
    (constraints.lodging_stays || []).forEach(function(stay){rows.push({date:stay.date,label:'住 '+stay.city,note:'你已指定的住宿城市'});});
    rows.sort(function(x,y){return x.date.localeCompare(y.date);});
    var names=(s.sights && s.sights.selected_ids || []).map(function(id){var item=(catalog || []).find(function(a){return a.id===id;});
      if(item && s.sights.visit_dates && s.sights.visit_dates[id]) rows.push({date:s.sights.visit_dates[id],label:'游玩 '+item.name,note:'你安排的游玩日 · 当地交通待补'});
      return item?item.name:null;}).filter(Boolean);
    rows.sort(function(x,y){return x.date.localeCompare(y.date);});
    var route=s.candidate && s.candidate.legs || [];
    return {title:(s.place_names && s.place_names.origin || s.request && s.request.origin || '出发地')+' → '+(s.place_names && s.place_names.destination || s.request && s.request.destination || '目的地'),
      route:route.length?route.map(function(l){return l.from;}).concat(route[route.length-1].to).join(' → '):null,
      dates:rows,windows:[travel.outbound_window?'出发 '+travel.outbound_window:null,travel.return_window?'返回 '+travel.return_window:null].filter(Boolean),
      sights:names,play_window:s.sights && s.sights.play_window || null,has_visit_dates:Object.values(s.sights?.visit_dates || {}).some(Boolean),nights:s.nights || 0,no_self_drive:constraints.no_self_drive===true,
      destination_preferences:s.preferences?{experience:s.preferences.experience,nature_theme:s.preferences.nature_theme,days:s.preferences.destination_days}:null,
      pending:[...(!route.length && !a.outbound?['选择一条走法']:[]),...(!travel.outbound_window && !a.outbound?['确定出发日期']:[]),
        ...(travel.trip_type==='round_trip' && !travel.return_window && !a.return?['确定返回日期']:[]),
        ...(a.return && s.place_names && s.place_names.destination && a.return.from_city!==s.place_names.destination?['安排 '+s.place_names.destination+' → '+a.return.from_city+' 的返程接驳']:[]),
        ...(route.length?['确认所选走法的班次与衔接']:[]),...(names.length?['补齐景点间的当地接驳']:[])],
      executable:false};
  }
  function affected(before,after) {
    var dates=new Set(), a=before.sights || {}, b=after.sights || {};
    new Set((a.selected_ids || []).concat(b.selected_ids || [])).forEach(function(id){
      if((a.visit_dates || {})[id] !== (b.visit_dates || {})[id] || (a.selected_ids || []).indexOf(id)!==(b.selected_ids || []).indexOf(id)) {
        if(a.visit_dates && a.visit_dates[id]) dates.add(a.visit_dates[id]);if(b.visit_dates && b.visit_dates[id]) dates.add(b.visit_dates[id]);
      }
    });
    if(JSON.stringify(before.constraints?.lodging_stays)!==JSON.stringify(after.constraints?.lodging_stays)) (before.constraints?.lodging_stays || []).concat(after.constraints?.lodging_stays || []).forEach(function(x){dates.add(x.date);});
    return Array.from(dates).sort();
  }
  var api={derive:derive,affected:affected};
  if(typeof module!=='undefined' && module.exports) module.exports=api;else root.MTTaskPreview=api;
})(typeof window!=='undefined'?window:globalThis);
