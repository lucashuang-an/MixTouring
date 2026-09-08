/* MixTouring HIFI — api.js · API 桩层（形状即未来真实 API，接后端时仅替换实现） */
(function () {
  'use strict';

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* GET /api/plans?from&to&date → { code, data: { direct, plans[] } } */
  async function planSearch(params) {
    await delay(900); // 模拟网络延迟，让 loading/骨架态可见
    // TODO: replace with fetch(`/api/plans?from=${from}&to=${to}&date=${date}`)
    var key = params.from + '-' + params.to;
    var route = window.DB.routes[key];
    if (!route) return { code: 0, data: { direct: null, plans: [] } };
    return { code: 0, data: route };
  }

  /* GET /api/templates?region → { code, data: Template[] } */
  async function fetchTemplates(params) {
    await delay(300);
    // TODO: replace with fetch(`/api/templates?region=${region}`)
    var region = params && params.region;
    var list = (!region || region === '全部')
      ? window.DB.templates.slice()
      : window.DB.templates.filter(function (t) { return t.region === region; });
    return { code: 0, data: list };
  }

  /* GET /api/items/:id → { code, data: Plan|Template|null } */
  async function fetchItem(params) {
    await delay(200);
    // TODO: replace with fetch(`/api/items/${id}`)
    var item = params.tpl ? window.DB.findTemplate(params.tpl) : window.DB.findItem(params.id);
    return { code: 0, data: item };
  }

  /* POST /api/feedback { id, cost, time, note } → { code } */
  async function postFeedback(rec) {
    await delay(400);
    // TODO: replace with fetch('/api/feedback', { method: 'POST', body: JSON.stringify(rec) })
    window.MT.addFeedback(rec);
    return { code: 0 };
  }

  window.API = {
    planSearch: planSearch,
    fetchTemplates: fetchTemplates,
    fetchItem: fetchItem,
    postFeedback: postFeedback
  };
})();
