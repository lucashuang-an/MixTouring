/* MixTouring HIFI — app.js · 共享工具层（状态/存储/导航/Toast） */
(function () {
  'use strict';

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
      time: rec.time, note: rec.note, ts: Date.now()
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

  window.MT = {
    read: read, write: write,
    isFav: isFav, toggleFav: toggleFav, favList: favList,
    feedbackList: feedbackList, addFeedback: addFeedback,
    wishList: wishList, wishAdd: wishAdd, wishDismiss: wishDismiss, wishMarkGenerated: wishMarkGenerated, wishIndex: wishIndex,
    qs: qs, go: go, goBack: goBack, wireNav: wireNav, toast: toast,
    esc: esc, levelColor: levelColor, favSnapshot: favSnapshot,
    detailUrl: detailUrl, fmtTs: fmtTs
  };
})();
