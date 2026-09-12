/* MixTouring HIFI — app.js · 共享工具层（状态/存储/导航/Toast） */
(function () {
  'use strict';

  /* 产品版本号（与 工作记录.md 最新版本同步；me.html「关于」动态读取，勿在页面写死） */
  var VERSION = 'v0.19.0';

  var FAV_KEY = 'mt:favs';
  var FB_KEY = 'mt:feedback';
  var WISH_KEY = 'mt:wishlist';

  /* ---------- 本地存储（匿名 + localStorage，账号体系 TBD） ---------- */
  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式下静默降级 */ }
  }

  /* ---------- 收藏 ---------- */
  function favAll() { return read(FAV_KEY, {}); }
  function isFav(id) { return !!favAll()[id]; }
  /* snapshot: {id, type, title, price, saved} */
  function toggleFav(snapshot) {
    var all = favAll();
    if (all[snapshot.id]) {
      delete all[snapshot.id];
      write(FAV_KEY, all);
      return false;
    }
    all[snapshot.id] = {
      id: snapshot.id, type: snapshot.type, title: snapshot.title,
      price: snapshot.price, saved: snapshot.saved, ts: Date.now()
    };
    write(FAV_KEY, all);
    return true;
  }
  function favList() {
    var all = favAll();
    return Object.keys(all).map(function (k) { return all[k]; })
      .sort(function (a, b) { return b.ts - a.ts; });
  }

  /* ---------- 回填实测记录 ---------- */
  function feedbackList() { return read(FB_KEY, []); }
  function addFeedback(rec) {
    var list = feedbackList();
    list.unshift({
      id: rec.id, title: rec.title, cost: rec.cost,
      time: rec.time, note: rec.note, smooth: rec.smooth || null, ts: Date.now()
    });
    write(FB_KEY, list);
  }

  /* ---------- 心愿单（随机输入无数据时登记，离线生成后回填） ---------- */
  /* item: { id, from, to, date, status: 'pending'|'generated'|'dismissed', ts, generatedAt? } */
  function wishList() { return read(WISH_KEY, []); }
  function wishIndex(from, to) {
    var list = wishList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].from === from && list[i].to === to && list[i].status !== 'dismissed') return i;
    }
    return -1;
  }
  function wishAdd(item) {
    var list = wishList();
    if (wishIndex(item.from, item.to) !== -1) { return false; }
    list.unshift({
      id: 'wish-' + Date.now(), from: item.from, to: item.to, date: item.date,
      status: 'pending', ts: Date.now()
    });
    write(WISH_KEY, list);
    return true;
  }
  function wishDismiss(id) {
    var list = wishList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { list[i].status = 'dismissed'; break; }
    }
    write(WISH_KEY, list);
  }
  function wishMarkGenerated(from, to, generatedAt) {
    var list = wishList();
    var idx = wishIndex(from, to);
    if (idx !== -1) {
      list[idx].status = 'generated';
      list[idx].generatedAt = generatedAt || Date.now();
      write(WISH_KEY, list);
    }
  }

  /* ---------- URL 参数 ---------- */
  function qs(name) {
    var m = new URLSearchParams(location.search).get(name);
    return m ? decodeURIComponent(m) : '';
  }
  function go(page, params) {
    var url = page;
    if (params) {
      var q = new URLSearchParams();
      Object.keys(params).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') q.set(k, params[k]);
      });
      var s = q.toString();
      if (s) url += '?' + s;
    }
    location.href = url;
  }
  /* 返回：有站内历史则 back()，否则去 fallback（防直接深链时卡死） */
  function goBack(fallback) {
    var ref = document.referrer || '';
    var sameSite = ref.indexOf(location.host) !== -1;
    if (sameSite && window.history.length > 1) {
      window.history.back();
    } else {
      location.href = fallback;
    }
  }

  /* ---------- 底部导航统一接线（唯一选中规则：data-active="true"） ---------- */
  var NAV_TARGET = { search: 'search.html', library: 'library.html', me: 'me.html' };
  function wireNav() {
    document.querySelectorAll('[data-nav-key]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-nav-key');
        if (btn.getAttribute('data-active') === 'true') return; // 当前页，不跳
        if (NAV_TARGET[key]) location.href = NAV_TARGET[key];
      });
    });
  }

  /* ---------- Toast（全局单例） ---------- */
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('mt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mt-toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:88px;transform:translateX(-50%) translateY(8px);' +
        'background:#111111;color:#FFFFFF;font-size:13.5px;padding:10px 18px;border-radius:9999px;' +
        'box-shadow:0 10px 30px -5px rgba(0,0,0,0.18);opacity:0;pointer-events:none;z-index:200;' +
        'transition:opacity .2s ease,transform .2s ease;max-width:80%;text-align:center;line-height:1.4;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(function () {
      el.style.opacity = '1';
      el.style.transform = 'translateX(-50%) translateY(0)';
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(8px)';
    }, 1800);
  }

  /* ---------- 展示辅助 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* 风险判级配色（低/中/高 → state 色，禁止黑箱总分） */
  var LEVEL_COLOR = { '低': '#34c759', '中': '#FBBF24', '高': '#E11D48' };
  function levelColor(level) { return LEVEL_COLOR[level] || '#7C8089'; }
  function favSnapshot(item) {
    return {
      id: item.id, type: item.type,
      title: item.from + ' → ' + item.to,
      price: item.price, saved: item.saved
    };
  }
  /* detail 页链接 */
  function detailUrl(item) {
    return item.type === 'tpl' ? ('detail.html?tpl=' + item.id) : ('detail.html?id=' + item.id);
  }
  function fmtTs(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
  }

  /* ---------- 居中弹窗（桌面版；v0.17 采集完成通知） ---------- */
  /* opts: { title, body, actions: [{ label, primary?, onClick? }] }；返回关闭函数 */
  function modal(opts) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(17,17,17,0.35);z-index:300;display:flex;' +
      'align-items:center;justify-content:center;opacity:0;transition:opacity .2s ease;';
    var card = document.createElement('div');
    card.style.cssText = 'width:min(400px,calc(100vw - 48px));background:var(--mixtouring-card,#FFFFFF);' +
      'border-radius:var(--mixtouring-radius-lg,24px);padding:28px 24px 22px;box-shadow:0 24px 60px -12px rgba(0,0,0,0.25);' +
      'transform:translateY(10px);transition:transform .2s ease;text-align:center;';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:17px;color:var(--mixtouring-foreground,#1E2022);letter-spacing:-0.01em;line-height:1.4;';
    title.textContent = opts.title || '';
    var body = document.createElement('div');
    body.style.cssText = 'font-size:13.5px;color:var(--mixtouring-muted-foreground,#7C8089);margin-top:8px;line-height:1.6;';
    body.textContent = opts.body || '';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:20px;flex-wrap:wrap;';
    (opts.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      var primary = !!a.primary;
      b.style.cssText = primary
        ? 'background:var(--mixtouring-primary,#111111);color:var(--mixtouring-primary-foreground,#FFFFFF);border:none;border-radius:9999px;padding:11px 22px;font-size:13.5px;cursor:pointer;font-family:inherit;'
        : 'background:none;color:var(--mixtouring-muted-foreground,#7C8089);border:none;border-radius:9999px;padding:11px 16px;font-size:13.5px;cursor:pointer;font-family:inherit;';
      b.textContent = a.label;
      b.addEventListener('click', function () { close(); if (a.onClick) a.onClick(); });
      row.appendChild(b);
    });
    card.appendChild(title); card.appendChild(body); card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    function close() {
      if (!overlay.parentNode) return;
      overlay.style.opacity = '0';
      card.style.transform = 'translateY(10px)';
      setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 220);
    }
    requestAnimationFrame(function () {
      overlay.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    });
    return close;
  }

  /* ---------- 心愿采集实时进度（v0.17：问答/搜索无数据路线 → 调起采集 API → 大致进度条 → 完成回调） ---------- */
  /* opts: { from, to, mount, onDone(wish)?, onFail(info)?, pollMs? }
   * 轮询 /api/wishlist，按 stage 映射大致百分比；generated → onDone；超 10 分钟视为中断 → onFail。
   * 返回 { stop() }。阶段百分比是粗粒度示意（服务端为多进程流水线，无精确进度可言，如实用「大致」）。 */
  function wishProgress(opts) {
    var from = opts.from, to = opts.to, mount = opts.mount;
    var pollMs = opts.pollMs || 3000;
    var STAGE = {
      starting: { pct: 12, label: '启动采集' },
      search: { pct: 35, label: '联网检索公开班次与票价' },
      assemble: { pct: 68, label: 'AI 组装方案结构' },
      gate: { pct: 88, label: '质量守门校验' }
    };
    var TIMEOUT_MS = 10 * 60 * 1000;
    mount.innerHTML =
      '<div class="mt-wish-progress">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<svg style="width:13px;height:13px;color:var(--mixtouring-ring,#C86A4B);flex-shrink:0;"><use href="#hero-sparkles"></use></svg>' +
          '<span data-role="label" style="font-size:12.5px;color:#A8543A;">AI 正在联网采集…</span>' +
        '</div>' +
        '<div style="height:4px;border-radius:9999px;background:var(--mixtouring-border,#E8E9EB);overflow:hidden;margin-top:8px;">' +
          '<div data-role="bar" style="height:100%;width:8%;border-radius:9999px;background:var(--mixtouring-ring,#C86A4B);transition:width .6s ease;"></div>' +
        '</div>' +
        '<div data-role="meta" style="font-size:11.5px;color:var(--mixtouring-muted-foreground,#7C8089);margin-top:6px;">预计 1–2 分钟</div>' +
      '</div>';
    var el = {
      bar: mount.querySelector('[data-role="bar"]'),
      label: mount.querySelector('[data-role="label"]'),
      meta: mount.querySelector('[data-role="meta"]')
    };
    var startedAt = Date.now();
    var stopped = false;
    var timer = null;
    var sawProcessing = false; /* 是否见过 processing：此后翻回 pending = 本轮采集已失败退回 */

    function stop() { stopped = true; if (timer) clearTimeout(timer); }
    function tick() {
      if (stopped) return;
      var secs = Math.round((Date.now() - startedAt) / 1000);
      if (el.meta && secs > 8) el.meta.textContent = '已用时 ' + secs + ' 秒 · 预计 1–2 分钟';
      if (Date.now() - startedAt > TIMEOUT_MS) {
        stop();
        if (opts.onFail) opts.onFail({ reason: 'timeout', from: from, to: to });
        return;
      }
      API.fetchWishes().then(function (res) {
        if (stopped) return;
        if (!res || res.code !== 0 || !Array.isArray(res.data)) {
          timer = setTimeout(tick, pollMs * 2); /* 服务暂不可达，放慢重试 */
          return;
        }
        var w = null;
        res.data.forEach(function (x) { if (x.from === from && x.to === to) w = x; });
        if (!w) { timer = setTimeout(tick, pollMs); return; }
        if (w.status === 'generated') {
          el.bar.style.width = '100%';
          el.label.textContent = '采集完成';
          stop();
          if (opts.onDone) opts.onDone(w);
          return;
        }
        if (w.status === 'processing') {
          sawProcessing = true;
          var st = STAGE[w.stage] || STAGE.starting;
          el.bar.style.width = st.pct + '%';
          el.label.textContent = 'AI 正在联网采集 · ' + st.label;
          if (w.processingAt) startedAt = Math.min(startedAt, new Date(w.processingAt).getTime());
        } else if (w.status === 'pending' && sawProcessing) {
          /* 本轮执行结束但未产卡：如实告知，不再让进度条空等 */
          stop();
          if (opts.onFail) opts.onFail({ reason: 'attempt_failed', from: from, to: to });
          return;
        }
        timer = setTimeout(tick, pollMs);
      }).catch(function () { if (!stopped) timer = setTimeout(tick, pollMs * 2); });
    }
    tick();
    return { stop: stop };
  }

  window.MT = {
    VERSION: VERSION,
    read: read, write: write,
    isFav: isFav, toggleFav: toggleFav, favList: favList,
    feedbackList: feedbackList, addFeedback: addFeedback,
    wishList: wishList, wishAdd: wishAdd, wishDismiss: wishDismiss, wishMarkGenerated: wishMarkGenerated, wishIndex: wishIndex,
    qs: qs, go: go, goBack: goBack, wireNav: wireNav, toast: toast,
    esc: esc, levelColor: levelColor, favSnapshot: favSnapshot,
    detailUrl: detailUrl, fmtTs: fmtTs,
    modal: modal, wishProgress: wishProgress
  };
})();
