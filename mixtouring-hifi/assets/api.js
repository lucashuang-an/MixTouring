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

  /* ---------- 自然语言行程解析（Phase 2 · 触点①） ---------- */

  /* 本地兜底：轻量规则（能力与后端声明一致，识别不到置 null，绝不编造）。
   * LLM key 在服务端，本地兜底永远走 rule 引擎（离线优先级）。 */
  function localParse(q) {
    var cities = (window.DB && window.DB.cities) || [];
    var seq = [];
    cities.forEach(function (c) {
      var idx = q.indexOf(c);
      if (idx !== -1) seq.push({ city: c, idx: idx });
    });
    seq.sort(function (a, b) { return a.idx - b.idx; });
    var from = seq.length ? seq[0].city : null;
    var to = seq.length > 1 ? seq[1].city : null;
    if (from === to) to = null;
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    var m = q.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/) || q.match(/(?:^|[^0-9])(\d{1,2})[/-](\d{1,2})(?!\d)/);
    var date = null;
    if (m) { var mo = +m[1], d = +m[2]; var t = new Date(); var dd = new Date(t.getFullYear(), mo - 1, d); date = dd.getFullYear() + '/' + pad(dd.getMonth() + 1) + '/' + pad(dd.getDate()); }
    else {
      var rel = ['今天', '今晚'].indexOf(q) >= 0 ? 0 : q.indexOf('明天') >= 0 ? 1 : q.indexOf('后天') >= 0 ? 2 : -1;
      if (rel >= 0) { var tt = new Date(); var td = new Date(tt.getFullYear(), tt.getMonth(), tt.getDate() + rel); date = td.getFullYear() + '/' + pad(td.getMonth() + 1) + '/' + pad(td.getDate()); }
    }
    var fields = (from ? 1 : 0) + (to ? 1 : 0) + (date ? 1 : 0);
    return { from: from, to: to, date: date, conf: fields >= 3 ? 0.85 : fields === 2 ? 0.65 : 0.4, engine: 'rule', note: fields < 3 ? '部分字段未识别，请手动补全' : null };
  }

  /* parseNaturalLanguage(q) → { code, data: { from, to, date, conf, engine, note } }
   * 后端可达时走 /api/parse（LLM 优先、规则兜底）；离线时用本地规则兜底。 */
  function parseNaturalLanguage(q) {
    return probe().then(function (ok) {
      if (!ok) return Promise.resolve({ code: 0, data: localParse(q) });
      return getEnvelope('/api/parse?q=' + encodeURIComponent(q))
        .catch(function () { return { code: 0, data: localParse(q) }; });
    });
  }

  /* GET /api/ask?q= → { code, data: { answer, refs, engine, model } }
   * Phase 2 触点③：站内 grounded 问答（答案只基于方案库数据）。问答必须走服务端（LLM key 在服务端），
   * 后端不可达时返回 code:1，本地不编造答案 */
  function askQ(q) {
    return probe().then(function (ok) {
      if (!ok) return { code: 1, msg: '问问 AI 需要启动后端服务' };
      return getEnvelope('/api/ask?q=' + encodeURIComponent(q)).catch(function () {
        return { code: 1, msg: '问答服务暂时不可用' };
      });
    });
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

  /* ---------- 心愿队列（Phase 3）：登记上报 + 服务端状态查询 ----------
   * localStorage 仍是用户侧权威（无账号体系）；后端可达时同步登记到服务端队列，
   * 失败静默（离线管道仍可通过运营侧收集）。 */

  /* POST /api/wishlist { from, to, date } → { code, data: { id, status, deduped } } */
  function wishRegister(rec) {
    return probe().then(function (ok) {
      if (!ok) return { code: 1, msg: 'offline' };
      return fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec)
      }).then(function (r) { return r.json(); }).catch(function () { return { code: 1, msg: 'offline' }; });
    });
  }

  /* GET /api/wishlist → { code, data: [{ id, from, to, date, status, ... }] } */
  function fetchWishes() {
    return probe().then(function (ok) {
      if (!ok) return { code: 1, msg: 'offline' };
      return getEnvelope('/api/wishlist').catch(function () { return { code: 1, msg: 'offline' }; });
    });
  }

  window.API = {
    planSearch: planSearch,
    fetchTemplates: fetchTemplates,
    fetchItem: fetchItem,
    parseNaturalLanguage: parseNaturalLanguage,
    askQ: askQ,
    wishRegister: wishRegister,
    fetchWishes: fetchWishes,
    postFeedback: postFeedback
  };
})();
