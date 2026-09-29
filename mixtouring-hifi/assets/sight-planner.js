/* 卡 C 景点比较：只保存用户选择与预算，来源与可行性每次由服务端重取。 */
(function () {
  'use strict';
  var state = { selected_ids:['nalati','kalajun','xiata','kuerdening'],full_days:2,day_hours:8,preference:'不限',visit_hours:{} };
  var history = [], box, context, onChange, sequence = 0, cacheKey = null, catalog = [];
  var copy = function (x) { return JSON.parse(JSON.stringify(x)); };
  var esc = function (x) { return MT.esc(String(x == null ? '' : x)); };
  function snapshot() { return Object.assign(copy(state), { history:copy(history) }); }
  function remember() { if (onChange) onChange(); }
  function refresh(force) {
    if (!box) return;
    var ctx = context(), key = JSON.stringify({state:state,constraints:ctx.constraints});
    if (!force && key === cacheKey) return;
    cacheKey = key;
    var token = ++sequence;
    fetch('/api/anywhere/sights', { method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({state:state,constraints:ctx.constraints,plan_id:ctx.plan_id}) })
      .then(function (r) { if (!r.ok) throw Error('查询失败'); return r.json(); })
      .then(function (r) {
        if (token !== sequence) return;
        if (r.code !== 0 || !r.data) throw Error('比较失败');
        catalog = r.data.catalog.attractions; state = r.data.comparison.state;
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
    state = next; remember(); refresh(true);
  }
  function applyPatch(patch) {
    if (!patch || !Object.keys(patch).length) return;
    var next = copy(state);
    if (patch.selected_ids) next.selected_ids = patch.selected_ids.slice();
    if (patch.add_ids) next.selected_ids = Array.from(new Set(next.selected_ids.concat(patch.add_ids)));
    if (patch.remove_ids) next.selected_ids = next.selected_ids.filter(function (id) { return patch.remove_ids.indexOf(id) < 0; });
    ['full_days','preference'].forEach(function (k) { if (patch[k] != null) next[k] = patch[k]; });
    change(next); document.getElementById('sightDetails').open = true;
    document.getElementById('sightDetails').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function render(data) {
    var html = '<p>以伊宁为接驳查询起点，先比较想保留的景点。完整游玩日由你确认，不包含去返交通日。</p>';
    html += '<form id="sightForm"><div class="sight-controls">' +
      '<label>完整游玩日<input id="sightDays" type="number" min="1" max="14" value="'+state.full_days+'"></label>' +
      '<label>每天可用小时<input id="sightDayHours" type="number" min="4" max="12" value="'+state.day_hours+'"></label>' +
      '<label>景观偏好<select id="sightPreference">'+['不限','草原','森林','雪山河谷','湖泊','村落'].map(function (v) {return '<option '+(state.preference===v?'selected':'')+'>'+v+'</option>';}).join('')+'</select></label></div>';
    html += '<fieldset><legend>想比较的景点与游玩预留小时</legend><div class="sight-choices">'+catalog.map(function (a) {
      return '<div><label><input type="checkbox" name="sightChoice" value="'+a.id+'" '+(state.selected_ids.indexOf(a.id)>=0?'checked':'')+'>'+esc(a.name)+'</label>'+
        '<label for="sightHours_'+a.id+'" class="sight-muted">预留小时</label><input id="sightHours_'+a.id+'" type="number" min="1" max="12" value="'+(state.visit_hours[a.id]||6)+'"></div>';
    }).join('')+'</div></fieldset><button type="submit">比较并检查时间</button> <button id="sightUndo" type="button" '+(!history.length?'disabled':'')+'>撤销景点调整</button></form>';
    html += '<div role="status" class="sight-status"><p>'+esc(data.message)+'</p><p>可用预算 '+data.budget.available_hours+' 小时 · 游玩预留 '+data.budget.visit_hours+' 小时 · 路上耗时待查</p><p class="sight-muted">'+esc(data.budget.basis)+'</p>'+
      (data.status==='budget_conflict' ? (data.minimum_budget_days<=14 ? '<button type="button" id="sightMoreDays">按游玩预算增加到 '+data.minimum_budget_days+' 个完整游玩日</button>' : '<p>当前游玩预算至少需要 '+data.minimum_budget_days+' 天，超过本次比较范围，请先删减景点。</p>') + '<p class="sight-muted">增加天数后仍须核对路上时间和锚点，不会自动移动去返交通。</p>' : '')+'</div>';
    if (data.options.length) html += '<h3>可比较的两处组合</h3><p class="sight-muted">按景观偏好、景观差异和所在县区排序；每个组合的接驳仍待核查。</p>'+data.options.map(function (o,i) {
      return '<div class="sight-option"><p>'+esc(o.names.join('＋'))+'</p><p>'+esc(o.reason)+'</p><button type="button" data-sight-option="'+i+'">保留这两处</button></div>';
    }).join('');
    html += '<div class="sight-grid">'+data.comparisons.map(function (a) {
      return '<article><h3>'+esc(a.name)+'</h3><p>'+esc(a.landscape)+'</p><p>所在县区：'+esc(a.county)+'</p><p>游玩预留：'+a.visit_hours+' 小时（可调整）</p><p>'+esc(a.travel_note)+'</p><p>'+esc(a.season_note)+'</p><p>'+(data.no_self_drive?'不开车：':'接驳：')+'可达性待核查</p><ul>'+a.access_questions.map(function (q) {return '<li>'+esc(q)+'</li>';}).join('')+'</ul><a href="'+esc(a.source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(a.source.title)+'</a><p class="sight-muted">历史资料 · 发布于 '+esc(a.source.published_at)+'</p></article>';
    }).join('')+'</div><ul class="sight-muted">'+data.warnings.map(function (w) {return '<li>'+esc(w)+'</li>';}).join('')+'</ul>';
    box.innerHTML = html;
    document.getElementById('sightForm').onsubmit = function (e) {
      e.preventDefault(); var next = copy(state);
      next.selected_ids = Array.from(box.querySelectorAll('[name="sightChoice"]:checked')).map(function (el) {return el.value;});
      next.full_days = Number(document.getElementById('sightDays').value); next.day_hours = Number(document.getElementById('sightDayHours').value);
      next.preference = document.getElementById('sightPreference').value;
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
    restore:function (saved) {
      if (!saved || typeof saved!=='object' || Array.isArray(saved)) saved=null;
      history=saved&&Array.isArray(saved.history)?copy(saved.history).filter(function (v) {return v&&typeof v==='object'&&Array.isArray(v.selected_ids);}).slice(-20):[];
      state=saved?copy(saved):{selected_ids:['nalati','kalajun','xiata','kuerdening'],full_days:2,day_hours:8,preference:'不限',visit_hours:{}};
      if (!Array.isArray(state.selected_ids)) state.selected_ids=['nalati','kalajun','xiata','kuerdening'];
      if (!state.visit_hours || typeof state.visit_hours!=='object') state.visit_hours={};
      delete state.history;cacheKey=null;refresh(true);
    },
    reset:function () {this.restore(null);}
  };
})();
