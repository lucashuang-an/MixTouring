/* 国内历史结构与国际探索线索采用相同内容结构；复用只发送已整理的灵感编号。 */
(function () {
  'use strict';
  var items = [], scope = 'all', wrap = document.getElementById('tplList');
  var modes = { rail: '铁路', plane: '航班', road: '公路客运' };
  function render() {
    var list = items.filter(function (r) { return scope === 'all' || r.scope === scope; });
    wrap.innerHTML = list.map(function (r) {
      return '<article class="mt-route-card"><p class="mt-route-label">' + (r.scope === 'international' ? '国际 · 路线探索' : '国内 · 历史结构') + '</p>' +
        '<h2>' + MT.esc(r.title) + '</h2><div class="mt-route-path">' + r.stops.map(MT.esc).join(' → ') + '</div>' +
        '<p class="mt-route-muted">' + r.modes.map(function (m) { return modes[m] || '方式待查'; }).join(' → ') +
        (r.via && r.via.length ? ' · 途经' + r.via.map(MT.esc).join('、') : '') + '</p>' +
        '<p class="mt-route-muted">值得考虑：' + MT.esc(r.reason) + '</p><p class="mt-route-muted">主要取舍：' + MT.esc(r.tradeoff) + '</p>' +
        '<details><summary>查看路线依据与待查项</summary><p>这是一条可以继续研究的路线。出发与返回日期、每段班次、接驳、费用及停留安排均待重新查询。</p>' +
        r.sources.map(function (s) { return '<p>' + (/^https:\/\//.test(s.link || '') ? '<a href="' + MT.esc(s.link) + '" target="_blank" rel="noopener">' + MT.esc(s.title) + '</a>' : MT.esc(s.title)) +
          (s.date ? ' · 来源日期 ' + MT.esc(s.date) : '') + '</p>'; }).join('') + '</details>' +
        '<a class="mt-route-action" href="trip.html?inspiration=' + encodeURIComponent(r.id) + '">以此为起点</a></article>';
    }).join('') || '<p class="mt-route-muted">这个分类暂未收录路线。</p>';
  }
  document.querySelectorAll('[data-scope]').forEach(function (b) { b.addEventListener('click', function () {
    scope = b.getAttribute('data-scope');
    document.querySelectorAll('[data-scope]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    render();
  }); });
  function load() {
    document.getElementById('libraryStatus').textContent = '正在整理路线灵感…';
    fetch('/api/inspirations').then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then(function (res) {
      if (!Array.isArray(res.data)) throw new Error();
      items = res.data; render(); document.getElementById('libraryStatus').textContent = '';
    }).catch(function () {
      document.getElementById('libraryStatus').textContent = '路线库暂时无法加载，请重试，或先回规划页说说你的想法。';
      document.getElementById('libraryRetry').hidden = false;
    });
  }
  document.getElementById('libraryRetry').onclick = function () { this.hidden = true; load(); };
  load();
})();
