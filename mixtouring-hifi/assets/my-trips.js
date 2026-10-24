/* 我的旅行只展示私人快照；摘要、搜索与版本变化不升级交通事实。 */
(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MTTrips=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function summary(s){s=s || {};var c=s.conversation || {},route=Array.isArray(c.draft?.route)?c.draft.route.filter(function(n){return typeof n==='string' && n.length<=80;}).slice(0,12):[];var req=c.requirements || {},t=s.travel || {};
    return {title:c.draft?.title || s.candidate?.label || '旅行草案',route:route.length?route.join(' → '):[s.request?.origin,s.request?.destination].filter(Boolean).join(' → '),
      conditions:[req.trip_days?req.trip_days+' 天全程':null,t.traveler_count?t.traveler_count+' 人':null,Number.isFinite(s.constraints?.budget_max_cny)?'预算上限 ¥'+s.constraints.budget_max_cny:null,t.outbound_window?'出发 '+t.outbound_window:'日期未定',t.return_window?'返回 '+t.return_window:null,Array.isArray(req.required_stops)&&req.required_stops.length?'必经 '+req.required_stops.filter(function(n){return typeof n==='string';}).join('、'):null,req.verified_cross_border_only?'跨境须核实':null].filter(Boolean),
      cards:Array.isArray(c.draft?.cards)?c.draft.cards.length:0};
  }
  function changes(before,after){if(!before)return ['首次保存'];var a=before.conversation || {},b=after?.conversation || {},out=[];
    var same=function(x,y){return JSON.stringify(x)===JSON.stringify(y);};
    if(!same(a.draft?.route,b.draft?.route))out.push('调整路线');
    if(!same(a.requirements,b.requirements))out.push('更新旅行条件');
    if(!same(before.travel,after.travel))out.push('更新日期或人数');
    if(!same(before.anchors,after.anchors))out.push('更新已定交通');
    if(!same(before.constraints,after.constraints))out.push('更新预算或出行限制');
    if(!same(before.preferences,after.preferences))out.push('调整偏好');
    if(!same(a.draft?.cards,b.draft?.cards))out.push('更新安排卡');
    if(!same(before.sights,after.sights))out.push('调整景点');
    return out.length?out:['更新讨论或其他安排'];
  }
  function filter(drafts,query){var q=String(query || '').trim().toLocaleLowerCase();return (drafts || []).filter(function(d){var s=summary(d.versions?.at(-1)?.snapshot);return !q || [d.name,s.title,s.route].join(' ').toLocaleLowerCase().includes(q);});}
  return {summary:summary,changes:changes,filter:filter};
});
