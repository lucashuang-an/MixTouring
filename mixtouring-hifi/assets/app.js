/* MixTouring HIFI — app.js · 共享工具层（状态/存储/导航/Toast） */
(function () {
  'use strict';

  /* 本机个人中心版本；规划器版本由服务端管理。 */
  var VERSION = 'personal-phase-1';

  var FAV_KEY = 'mt:favs';
  var FB_KEY = 'mt:feedback';
  var WISH_KEY = 'mt:wishlist';

  /* ---------- 本地存储（匿名 + localStorage，账号体系 TBD） ---------- */
  function read(key, fallback) {
    try {
      var raw = (globalThis.MTLocalStorage || localStorage).getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, val) {
    try { (globalThis.MTLocalStorage || localStorage).setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式下静默降级 */ }
  }

  /* ---------- 收藏 ---------- */
  function favAll() { return read(FAV_KEY, {}); }
  function favList() {
    var all = favAll();
    return Object.keys(all).map(function (k) { return all[k]; })
      .sort(function (a, b) { return b.ts - a.ts; });
  }

  /* ---------- 回填实测记录 ---------- */
  function wishList() { return read(WISH_KEY, []); }
  function feedbackList() { return read(FB_KEY, []); }
  /* ---------- URL 参数 ---------- */
  /* ---------- 底部导航统一接线（唯一选中规则：data-active="true"） ---------- */
  var NAV_TARGET = { search: 'trip.html', me: 'me.html' };
  function wireNav() {
    document.querySelectorAll('[data-nav-key]').forEach(function (btn) {
      if (btn.getAttribute('data-nav-key') === 'search') {
        var label = btn.querySelector('span:last-child');
        if (label) label.textContent = '规划';
      }
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-nav-key');
        if (btn.getAttribute('data-active') === 'true' && !(key === 'search' && /\/search\.html$/.test(location.pathname))) return;
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
  function fmtTs(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
  }

  window.MT = { VERSION:VERSION,read:read,write:write,favList:favList,feedbackList:feedbackList,wishList:wishList,wireNav:wireNav,toast:toast,esc:esc,fmtTs:fmtTs };
})();
