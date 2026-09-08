/* MixTouring HIFI — api.js · API 层（Phase 1：fetch 首选，mock 离线兜底；函数签名与桩一致）
 * 后端可用时全部数据来自真后端（与 mock.js 同一派生管线，逐字节一致）；
 * 后端不可达（file:// 打开 / 服务未启动）时自动回落本地 mock，行为不变。 */
(function () {
  'use strict';

  var backend = null; /* null=未探测 / true=后端可用 / false=走本地兜底 */

  /* ---------- 本地兜底查找（与 mock.js 的辅助一致） ---------- */

  function localFindPlan(id) {
    var routes = window.DB.routes;
    for (var key in routes) {
      var plans = routes[key].plans;
      for (var i = 0; i < plans.length; i++) {
        if (plans[i].id === id) return plans[i];
      }
    }
    return null;
  }

  function localFindTemplate(id) {
    var list = window.DB.templates;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* ---------- 后端探测：预取全量 DB，原地改写 window.DB（保持页面已捕获的引用不变） ---------- */

  function applyDB(data) {
    var db = window.DB;
    if (!db) {
      db = window.DB = { cities: [], routes: {}, templates: [] };
    }
    db.cities = data.cities || [];
    db.routes = data.routes || {};
    db.templates = data.templates || [];
  }

  function probe() {
    if (backend !== null) return Promise.resolve(backend);
    if (typeof fetch !== 'function' || location.protocol === 'file:') {
      backend = false;
      return Promise.resolve(false);
    }
    return fetch('/api/bootstrap', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (res && res.code === 0 && res.data) {
          applyDB(res.data);
          backend = true;
        } else {
          backend = false;
        }
        return backend;
      })
      .catch(function () { backend = false; return false; });
  }

  /* ---------- fetch 工具：{code:0,data} 信封原样返回（页面消费 res.data），失败抛错交由调用方兜底 ---------- */

  function getEnvelope(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (res) {
      if (!res || typeof res.code !== 'number') throw new Error('bad envelope');
      return res;
    });
  }

  /* GET /api/plans?from&to&date → { code, data: { direct, plans[] } } */
  function planSearch(params) {
    return probe().then(function (ok) {
      if (!ok) return localPlanSearch(params);
      var q = 'from=' + encodeURIComponent(params.from) +
        '&to=' + encodeURIComponent(params.to) +
        '&date=' + encodeURIComponent(params.date || '');
      return getEnvelope('/api/plans?' + q).catch(function () { return localPlanSearch(params); });
    });
  }

  function localPlanSearch(params) {
    var key = params.from + '-' + params.to;
    var route = window.DB.routes[key];
    return Promise.resolve({ code: 0, data: route || { direct: null, plans: [] } });
  }

  /* GET /api/templates?region → { code, data: Template[] } */
  function fetchTemplates(params) {
    return probe().then(function (ok) {
      if (!ok) return localFetchTemplates(params);
      var region = params && params.region ? params.region : '';
      return getEnvelope('/api/templates?region=' + encodeURIComponent(region))
        .catch(function () { return localFetchTemplates(params); });
    });
  }

  function localFetchTemplates(params) {
    var region = params && params.region;
    var list = (!region || region === '全部')
      ? window.DB.templates.slice()
      : window.DB.templates.filter(function (t) { return t.region === region; });
    return Promise.resolve({ code: 0, data: list });
  }

  /* GET /api/items/:id → { code, data: Plan|Template|null } */
  function fetchItem(params) {
    return probe().then(function (ok) {
      if (!ok) return localFetchItem(params);
      var id = params.tpl || params.id;
      return getEnvelope('/api/items/' + encodeURIComponent(id))
        .catch(function () { return localFetchItem(params); });
    });
  }

  function localFetchItem(params) {
    var item = params.tpl ? localFindTemplate(params.tpl) : (localFindPlan(params.id) || localFindTemplate(params.id));
    return Promise.resolve({ code: 0, data: item || null });
  }

  /* POST /api/feedback { id, cost, time, note } → { code }
   * 反馈以 localStorage（MT.addFeedback）为权威；后端可达时同步上报一份，失败静默（无账号体系） */
  function postFeedback(rec) {
    var done = function () {
      window.MT.addFeedback(rec);
      return Promise.resolve({ code: 0 });
    };
    return probe().then(function (ok) {
      if (!ok) return done();
      return fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec)
      }).then(function () { return done(); }).catch(done);
    });
  }

  window.API = {
    planSearch: planSearch,
    fetchTemplates: fetchTemplates,
    fetchItem: fetchItem,
    postFeedback: postFeedback
  };
})();
