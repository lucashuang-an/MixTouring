/* 卡 C 景点比较：只保存用户选择与预算，来源与可行性每次由服务端重取。 */
(function () {
  'use strict';
  var state = { selected_ids:[],full_days:2,day_hours:8,preference:'不限',visit_hours:{} };
  var history = [], box, context, onChange, sequence = 0, cacheKey = null, catalog = [], comparison = null;
  var copy = function (x) { return JSON.parse(JSON.stringify(x)); };
  var esc = function (x) { return MT.esc(String(x == null ? '' : x)); };
  function snapshot() { return Object.assign(copy(state), { history:copy(history) }); }
  function remember() { if (onChange) onChange(); }
  function refresh(force) {
    if (!box) return;
    var ctx = context();
    document.getElementById('sightDetails').hidden = !ctx.relevant;
    if (!ctx.relevant) {sequence++;cacheKey=null;comparison=null;box.innerHTML='';return;}
    var key = JSON.stringify({state:state,constraints:ctx.constraints,anchors:ctx.anchors,plan_id:ctx.plan_id,destination:ctx.destination});
    if (!force && key === cacheKey) return;
    cacheKey = key;
    comparison=null;
    var token = ++sequence;
    fetch('/api/anywhere/sights', { method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({state:state,constraints:ctx.constraints,anchors:ctx.anchors,plan_id:ctx.plan_id,destination:ctx.destination,sight_requested:state.requested===true}) })
      .then(function (r) { if (!r.ok) throw Error('查询失败'); return r.json(); })
      .then(function (r) {
        if (token !== sequence) return;
        if (r.code !== 0 || !r.data) throw Error('比较失败');
        catalog = r.data.catalog.attractions; state = r.data.comparison.state;comparison=r.data.comparison;
        render(r.data.comparison); remember();
      }).catch(function () {
        if (token !== sequence) return;
        cacheKey = null;
        box.innerHTML = '<p role="status">景点比较暂时不可用，当前选择仍保留。</p><button type="button" id="sightRetry">重试景点比较</button>';
        document.getElementById('sightRetry').onclick = function () { refresh(true); };
      });
  }
  function change(next) {
    history.push(copy(state)); history = history.slice(-20);
    state = next; comparison=null;remember(); refresh(true);
  }
  function applyPatch(patch) {
    if (!patch || !Object.keys(patch).length) return;
    var next = copy(state);
    next.requested=true;
    if (patch.selected_ids) next.selected_ids = patch.selected_ids.slice();
    if (patch.add_ids) next.selected_ids = Array.from(new Set(next.selected_ids.concat(patch.add_ids)));
    if (patch.remove_ids) next.selected_ids = next.selected_ids.filter(function (id) { return patch.remove_ids.indexOf(id) < 0; });
    ['full_days','preference','play_window'].forEach(function (k) { if (Object.prototype.hasOwnProperty.call(patch,k)) next[k] = patch[k]; });
    change(next); document.getElementById('sightDetails').open = true;
    document.getElementById('sightDetails').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function render(data) {
    var html = '<p>选几个感兴趣的地方，给伊犁留出游玩时间。</p>';
    html += '<form id="sightForm"><div class="sight-controls">' +
      '<label>完整游玩日<input id="sightDays" type="number" min="1" max="14" value="'+state.full_days+'"></label>' +
      '<label>游玩起始日（可空）<input id="sightStart" type="date" value="'+esc(state.play_window?state.play_window.slice(0,10):'')+'"></label>' +
      '<label>游玩结束日（可空）<input id="sightEnd" type="date" value="'+esc(state.play_window?state.play_window.slice(13,23):'')+'"></label>' +
      '<label>景观偏好<select id="sightPreference">'+['不限','草原','森林','雪山河谷','湖泊','村落'].map(function (v) {return '<option '+(state.preference===v?'selected':'')+'>'+v+'</option>';}).join('')+'</select></label></div>';
    html += '<fieldset><legend>想去哪里</legend><div class="sight-choices">'+catalog.map(function (a) {
      return '<div><label><input type="checkbox" name="sightChoice" value="'+a.id+'" '+(state.selected_ids.indexOf(a.id)>=0?'checked':'')+'>'+esc(a.name)+'</label>'+
        '<span class="sight-muted">'+esc(a.theme)+' · '+esc(a.county)+'</span></div>';
    }).join('')+'</div></fieldset><details><summary>调整游玩强度</summary><div class="sight-controls"><label>每天游玩小时<input id="sightDayHours" type="number" min="4" max="12" value="'+state.day_hours+'"></label>'+catalog.map(function(a){return '<label>'+esc(a.name)+'预留小时<input id="sightHours_'+a.id+'" type="number" min="1" max="12" value="'+(state.visit_hours[a.id]||6)+'"></label>';}).join('')+'</div></details><button type="submit">更新景点安排</button> <button id="sightUndo" type="button" '+(!history.length?'disabled':'')+'>撤销</button></form>';
    html += '<div role="status" class="sight-status"><p>'+esc(data.message)+'</p><p>可用预算 '+data.budget.available_hours+' 小时 · 游玩预留 '+data.budget.visit_hours+' 小时 · 路上耗时待查</p><p class="sight-muted">'+esc(data.budget.basis)+'</p>'+
      (data.status==='budget_conflict' ? (data.minimum_budget_days<=14 ? '<button type="button" id="sightMoreDays">按游玩预算增加到 '+data.minimum_budget_days+' 个完整游玩日</button>' : '<p>当前游玩预算至少需要 '+data.minimum_budget_days+' 天，超过本次比较范围，请先删减景点。</p>') + '<p class="sight-muted">增加天数后仍须核对路上时间和锚点，不会自动移动去返交通。</p>' : '')+'</div>';
    if (data.options.length) html += '<h3>可比较的两处组合</h3><p class="sight-muted">按景观偏好、景观差异和所在县区排序；每个组合的接驳仍待核查。</p>'+data.options.map(function (o,i) {
      return '<div class="sight-option"><p>'+esc(o.names.join('＋'))+'</p><p>'+esc(o.reason)+'</p><button type="button" data-sight-option="'+i+'">保留这两处</button></div>';
    }).join('');
    html += '<details class="sight-status"'+(data.window.issues.length?' open':'')+'><summary>日期与已定交通</summary><p>'+esc(data.window.basis)+'</p>'+
      (data.window.full_days_bounds?'<p>锁定期间完整游玩日范围：'+data.window.full_days_bounds.confirmed_min+' 至 '+data.window.full_days_bounds.possible_max+' 天（交通日不计入）</p>':'')+
      '<ul>'+data.window.issues.concat(data.window.notes).map(function (n) {return '<li>'+esc(n)+'</li>';}).join('')+'</ul>'+
      (data.window.affected_dates.length?'<p>相关日期：'+data.window.affected_dates.map(esc).join('、')+'</p>':'')+'</details>';
    html += '<div class="sight-grid">'+data.comparisons.map(function (a) {
      var loc=a.access.location, kinds={road:'道路资料',public_transport:'公共客运',waiting:'候车',local_transfer:'景区内接驳'};
      var states={historical:'历史参考',source_lead:'来源线索',stale:'待重新核对',unsupported:'来源时间异常'};
      var details=loc?'<p>位置：'+esc(loc.description)+'</p><p class="sight-muted">'+esc(loc.precision)+'</p><a href="'+esc(loc.source.url)+'" target="_blank" rel="noopener noreferrer">位置来源：'+esc(loc.source.title)+'</a>':'';
      details+='<details><summary>分项交通依据与缺口</summary>'+a.access.components.map(function (part) {
        return '<div><p>'+kinds[part.kind]+'：本次耗时未知</p>'+part.references.map(function (ref) {
          return '<p>'+esc(ref.from)+' → '+esc(ref.to)+' · '+esc(states[ref.evidence_state]||'待核查')+(ref.duration_minutes!==null?' · '+(ref.mode==='self_drive'?'驾车':'行车')+'资料参考 '+ref.duration_minutes+' 分钟':'')+'</p><p>'+esc(ref.method)+'</p>'+
            '<a href="'+esc(ref.source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(ref.source.title)+'</a><p class="sight-muted">发布：'+esc(ref.source.published_at)+' · 采样：'+esc(ref.source.sampled_at)+'</p>';
        }).join('')+'<p class="sight-muted">待查：'+part.missing.map(esc).join('、')+'</p></div>';
      }).join('')+'<p class="sight-muted">'+esc(a.access.basis)+'</p></details>';
      if(a.access.season) details+='<p>'+esc(a.access.season.note)+'</p><a href="'+esc(a.access.season.source.url)+'" target="_blank" rel="noopener noreferrer">季节资料：'+esc(a.access.season.source.title)+'</a>';
      return '<article><h3>'+esc(a.name)+'</h3><p>'+esc(a.landscape)+'</p><p class="sight-muted">'+esc(a.county)+' · 游玩预留 '+a.visit_hours+' 小时</p><p>'+ (a.access.no_car_access==='source_lead'?'交通：有线路资料，本次班期待确认':'交通：尚未安排')+'</p><details><summary>交通与来源</summary>'+details+'<p>'+esc(a.season_note)+'</p>'+(a.access.public_note?'<p>'+esc(a.access.public_note)+'</p>':'')+'<ul>'+a.access_questions.map(function (q) {return '<li>'+esc(q)+'</li>';}).join('')+'</ul><a href="'+esc(a.source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(a.source.title)+'</a><p class="sight-muted">历史景观资料 · 发布于 '+esc(a.source.published_at)+'</p></details></article>';
    }).join('')+'</div><details class="sight-muted"><summary>规划说明</summary><ul>'+data.warnings.map(function (w) {return '<li>'+esc(w)+'</li>';}).join('')+'</ul></details>';
    var checklist=data.access_checklist;
    if (checklist) {
      html += '<details id="accessChecklist"><summary>逐段接驳核验清单</summary><p>'+esc(checklist.basis)+'</p>';
      if (checklist.return_anchor) html+='<p>需衔接你锁定的返程：'+esc(checklist.return_anchor.from_city)+' · '+esc(checklist.return_anchor.date)+' · '+esc(checklist.return_anchor.depart_time || '出发时刻未填')+'（当地时间）；接驳应预留余量，尚未确定出发日期。</p>';
      html+='<ul>'+checklist.missing_context.map(function (n) {return '<li>'+esc(n)+'</li>';}).join('')+'</ul><div class="sight-grid">'+checklist.rows.map(function (row) {
        return '<article><h3>'+esc(row.from)+' → '+esc(row.to)+'</h3><p>'+esc(row.purpose)+'</p><p>计划日期范围：'+esc(row.date_window || '待定')+' · 本次班次、耗时和费用未知</p><p>'+esc(row.query)+'</p><ul>'+row.missing.map(function (m) {return '<li>'+esc(m)+'</li>';}).join('')+'</ul>'+row.references.map(function (r) {
          return '<a href="'+esc(r.source.url)+'" target="_blank" rel="noopener noreferrer">资料线索：'+esc(r.source.title)+'</a><p>发布 '+esc(r.source.published_at || '未注明')+' · 采样 '+esc(r.source.sampled_at)+' · '+esc({source_lead:'来源线索',stale:'待重新核对',unsupported:'来源时间异常',historical:'历史参考'}[r.evidence_state])+'；不代表本次运营</p><p>'+esc(r.method)+'</p>'+
            (r.reported_operator?'<p>资料中的运营方：'+esc(r.reported_operator)+'；本次运营方待核。</p>':'')+
            (r.reported_boarding_stop?'<p>资料中的上车点：'+esc(r.reported_boarding_stop)+'；本次站点待核。</p>':'')+
            (r.reported_until?'<p>页面列出的售期截止：'+esc(r.reported_until)+'；不证明期间每天有班次，之后需重新查证。</p>':'')+
            (r.date_scope==='outside_reference'?'<p>计划日期超出页面列出的范围，不能用此资料判断本次运营。</p>':'');
        }).join('')+((row.opposite_references || []).length?'<details><summary>反方向资料（不能证明本段）</summary>'+row.opposite_references.map(function(r){return '<p>'+esc(r.from)+' → '+esc(r.to)+' · '+esc(r.method)+'</p><a href="'+esc(r.source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(r.source.title)+'</a><p>发布 '+esc(r.source.published_at || '未注明')+' · 采样 '+esc(r.source.sampled_at)+'；本段仍需独立取证。</p>';}).join('')+'</details>':'')+'</article>';
      }).join('')+'</div></details>';
    }
    box.innerHTML = html;
    document.getElementById('sightForm').onsubmit = function (e) {
      e.preventDefault(); var next = copy(state);
      next.selected_ids = Array.from(box.querySelectorAll('[name="sightChoice"]:checked')).map(function (el) {return el.value;});
      next.full_days = Number(document.getElementById('sightDays').value); next.day_hours = Number(document.getElementById('sightDayHours').value);
      next.preference = document.getElementById('sightPreference').value;
      var start=document.getElementById('sightStart').value,end=document.getElementById('sightEnd').value;
      if ((start&&!end)||(!start&&end)) {MT.toast('请同时填写游玩起始日和结束日，或全部留空');return;}
      next.play_window=start&&end?start+' ~ '+end:null;
      next.requested=true;
      catalog.forEach(function (a) {next.visit_hours[a.id] = Number(document.getElementById('sightHours_'+a.id).value);});
      change(next);
    };
    document.getElementById('sightUndo').onclick = function () { if (!history.length) return; state = history.pop(); remember(); refresh(true); };
    var more = document.getElementById('sightMoreDays');
    if (more) more.onclick = function () {var next=copy(state);next.full_days=data.minimum_budget_days;change(next);};
    box.querySelectorAll('[data-sight-option]').forEach(function (button) {button.onclick=function () {var next=copy(state);next.selected_ids=data.options[Number(button.getAttribute('data-sight-option'))].selected_ids;change(next);};});
  }
  window.MTSights = {
    init:function (element, ctx, changed) {box=element;context=ctx;onChange=changed;refresh(true);},
    getState:snapshot,applyPatch:applyPatch,refresh:refresh,
    getCatalog:function(){return copy(catalog);},
    getComparison:function(){return comparison?copy(comparison):null;},
    restore:function (saved) {
      if (!saved || typeof saved!=='object' || Array.isArray(saved)) saved=null;
      history=saved&&Array.isArray(saved.history)?copy(saved.history).filter(function (v) {return v&&typeof v==='object'&&Array.isArray(v.selected_ids);}).slice(-20):[];
      state=saved?copy(saved):{selected_ids:[],full_days:2,day_hours:8,preference:'不限',visit_hours:{}};
      if (!Array.isArray(state.selected_ids)) state.selected_ids=[];
      if (!state.visit_hours || typeof state.visit_hours!=='object') state.visit_hours={};
      delete state.history;cacheKey=null;comparison=null;refresh(true);
    },
    reset:function () {this.restore(null);}
  };
})();
