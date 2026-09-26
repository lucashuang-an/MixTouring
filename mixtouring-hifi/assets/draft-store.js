/* draft-store.js · 卡 A：本机私人草案存储（纯前端 localStorage，G4 轻量版）
 * 交接纪律（v0.42.1 卡 A）+ 二十二轮修订：
 *  - 独立键 mt:drafts，不覆盖旧收藏（mt:favs）与心愿（mt:wishlist）；
 *  - 版本带稳定唯一 vid（单调递增），恢复按 vid 精确取版，不按序号（避免截断后重号错版）；
 *  - 不自动删除：版本/草案数达上限后仍可保存（容量由浏览器决定），但结果带 warn 由界面提示用户主动清理；
 *  - 存储损坏分层：读取失败/整体 JSON 损坏 → corrupted，拒绝自动覆盖原数据（save 返回 corrupted_store），
 *    由用户确认后 purgeCorrupted() 才清；单条损坏（坏快照/null）隔离单列，好草案不受影响；
 *  - plan_id/candidate_id/开放地点确认标识只作当时快照，恢复须重新规划与核验确认；
 *  - 存储写入失败不得谎报成功。 */
(function () {
  'use strict';
  var DRAFT_KEY = 'mt:drafts';
  var MAX_DRAFTS = 20;
  var MAX_VERSIONS = 10;

  /* 读取状态分级：{data, corrupted:false} 正常；{data:null, corrupted:true, reason} 拒绝覆盖 */
  function readState() {
    var raw;
    try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return { data: null, corrupted: true, reason: 'read_failed' }; }
    if (raw == null) return { data: {}, corrupted: false };
    var val;
    try { val = JSON.parse(raw); } catch (e) { return { data: null, corrupted: true, reason: 'json_broken' }; }
    if (!val || typeof val !== 'object' || Array.isArray(val)) return { data: null, corrupted: true, reason: 'bad_top_level' };
    return { data: val, corrupted: false };
  }

  /* 形状判定不含 vid（二十三轮 P1-1）：v0.42.2 及更早的合法草案没有 vid，
   * 先按形状识别为草案，再由 normalizeDraft 迁移补 vid——迁移前不得判为损坏 */
  function isVersionShape(v) {
    return v && typeof v === 'object' &&
      v.snapshot && typeof v.snapshot === 'object' && v.snapshot.request !== undefined &&
      typeof v.saved_at === 'string';
  }
  function isDraftShape(d) {
    return d && typeof d === 'object' && typeof d.id === 'string' &&
      Array.isArray(d.versions) && d.versions.length > 0 &&
      d.versions.every(isVersionShape);
  }

  /** 迁移：为缺 vid 的版本补稳定唯一 vid（全局序号 __seq 向后推），并剔除形状不合规的版本条目；
   *  重复 vid（历史 bug 产生的重号）迁移时重新分配，保证草案内 vid 唯一。全部版本不合规的草案才算损坏。 */
  function normalizeDraft(d, all) {
    var seq = all && typeof all.__seq === 'number' ? all.__seq : 0;
    var used = new Set();
    var kept = [];
    d.versions.forEach(function (v) {
      if (!v.vid || used.has(v.vid)) {
        seq += 1;
        v.vid = 'v' + seq;
      } else {
        var m = /^v([0-9]+)$/.exec(v.vid);
        if (m) seq = Math.max(seq, +m[1]);
      }
      used.add(v.vid);
      if (isVersionShape(v)) kept.push(v);
    });
    if (all) all.__seq = seq;
    d.versions = kept;
    return d;
  }

  function list() {
    var st = readState();
    if (st.corrupted) return { drafts: [], corrupted_ids: [], store_corrupted: true, reason: st.reason };
    var all = st.data;
    var drafts = [], corrupted_ids = [];
    Object.keys(all).forEach(function (id) {
      if (id === '__seq') return; /* 版本 vid 全局序号，非草案条目 */
      if (isDraftShape(all[id])) drafts.push(normalizeDraft(all[id], all));
      else corrupted_ids.push(id);
    });
    drafts.sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
    return { drafts: drafts, corrupted_ids: corrupted_ids, store_corrupted: false };
  }

  function get(id) {
    if (id === '__seq') return null;
    var st = readState();
    if (st.corrupted) return null;
    var d = st.data[id];
    return isDraftShape(d) ? normalizeDraft(d, st.data) : null;
  }

  /** 用户确认后的损坏清理：只清坏条目；整体损坏需显式 reset */
  function purgeCorrupted() {
    var st = readState();
    if (st.corrupted) return { ok: false, reason: st.reason };
    var all = st.data;
    var removed = [];
    Object.keys(all).forEach(function (id) {
      if (id === '__seq') return;
      if (!isDraftShape(all[id])) { delete all[id]; removed.push(id); }
    });
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); return { ok: true, removed: removed }; }
    catch (e) { return { ok: false, reason: 'write_failed' }; }
  }

  /** 用户显式确认后的整体重置（仅整体损坏且拒绝覆盖后使用） */
  function resetAll() {
    try { localStorage.removeItem(DRAFT_KEY); return { ok: true }; } catch (e) { return { ok: false, reason: 'write_failed' }; }
  }

  function save(name, snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.request === undefined) return { ok: false, reason: 'bad_snapshot' };
    var st = readState();
    if (st.corrupted) return { ok: false, reason: 'corrupted_store', detail: st.reason }; /* 二十二轮 P2：不覆盖原数据 */
    var all = st.data;
    delete all.__seq; /* 序号已折算进 vid，不参与草案遍历 */
    var now = new Date().toISOString();
    var existing = Object.keys(all).filter(function (k) { return isDraftShape(all[k]); });
    var match = existing.filter(function (k) { return all[k].name === name; })[0];
    /* 版本唯一 vid：跨草案单调递增（存全局序号于顶层 __seq，兼容旧数据从现有最大 vid 推） */
    var seq = typeof all.__seq === 'number' ? all.__seq : 0;
    existing.forEach(function (k) { all[k].versions.forEach(function (v) { var m = /^v(\d+)$/.exec(v.vid || ''); if (m) seq = Math.max(seq, +m[1]); }); });
    var vid = 'v' + (seq + 1);
    all.__seq = seq + 1;
    var id;
    var warn = null;
    if (match) {
      id = match;
      var d = normalizeDraft(all[id], all);
      if (d.versions.length >= MAX_VERSIONS) warn = 'version_limit';
      d.versions.push({ vid: vid, version: d.versions.length + 1, snapshot: snapshot, saved_at: now }); /* 不自动删除（二十轮 P1-3） */
      d.updated_at = now;
    } else {
      if (existing.length >= MAX_DRAFTS) warn = 'draft_limit';
      id = 'dft_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      all[id] = { id: id, name: name || '未命名草案', created_at: now, updated_at: now, versions: [{ vid: vid, version: 1, snapshot: snapshot, saved_at: now }] };
    }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); }
    catch (e) { return { ok: false, reason: 'write_failed' }; }
    return { ok: true, draft: normalizeDraft(all[id], all), vid: vid, warn: warn };
  }

  function rename(id, name) {
    var st = readState();
    if (st.corrupted) return { ok: false, reason: 'corrupted_store' };
    if (!isDraftShape(st.data[id])) return { ok: false, reason: 'not_found' };
    st.data[id].name = String(name || '').trim().slice(0, 40) || st.data[id].name;
    st.data[id].updated_at = new Date().toISOString();
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(st.data)); return { ok: true, draft: st.data[id] }; }
    catch (e) { return { ok: false, reason: 'write_failed' }; }
  }

  function remove(id) {
    var st = readState();
    if (st.corrupted) return { ok: false, reason: 'corrupted_store' };
    if (!st.data[id]) return { ok: false, reason: 'not_found' };
    delete st.data[id];
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(st.data)); return { ok: true }; }
    catch (e) { return { ok: false, reason: 'write_failed' }; }
  }

  window.MTDrafts = { list: list, get: get, save: save, rename: rename, remove: remove, purgeCorrupted: purgeCorrupted, resetAll: resetAll, DRAFT_KEY: DRAFT_KEY };
})();
