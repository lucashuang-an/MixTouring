/* draft-store.js · 卡 A：本机私人草案存储（纯前端 localStorage，G4 轻量版）
 * 交接纪律（v0.42.1 卡 A）+ 二十二轮修订：
 *  - 独立键 mt:drafts，不覆盖旧收藏（mt:favs）与心愿（mt:wishlist）；
 *  - 版本带稳定唯一 vid（单调递增），恢复按 vid 精确取版，不按序号（避免截断后重号错版）；
 *  - 不自动删除：版本/草案数达上限后仍可保存（容量由浏览器决定），但结果带 warn 由界面提示用户主动清理；
 *  - 存储损坏分层：读取失败/整体 JSON 损坏 → corrupted，拒绝自动覆盖原数据（save 返回 corrupted_store）；
 *    整条损坏可由用户确认后清理，混合好坏版本只隐藏坏版并保留原文，好版本仍可恢复；
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
    if (normalizeAll(val)) {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(val)); }
      catch (e) { /* 只读时仍按确定性顺序展示；保存操作会单独报告写入失败。 */ }
    }
    return { data: val, corrupted: false };
  }

  /* 旧版草案没有 vid；一份草案只要有合法版本，就不能因另一版损坏而整份删除。 */
  function isVersionShape(v) {
    return v && typeof v === 'object' && !Array.isArray(v) &&
      v.snapshot && typeof v.snapshot === 'object' && !Array.isArray(v.snapshot) &&
      v.snapshot.request && typeof v.snapshot.request === 'object' && !Array.isArray(v.snapshot.request) &&
      typeof v.saved_at === 'string';
  }
  function isDraftShape(d) {
    return d && typeof d === 'object' && !Array.isArray(d) && typeof d.id === 'string' &&
      Array.isArray(d.versions) && d.versions.length > 0 &&
      d.versions.some(isVersionShape);
  }

  /* 全库一次分配版本身份：先保留已有 vid，再给缺号和重号分配新号。
   * 坏版本原样留在存储中，列表只展示好版本；读取时即持久化，刷新后身份不漂移。 */
  function normalizeAll(all) {
    var ids = Object.keys(all).filter(function (id) { return id !== '__seq' && isDraftShape(all[id]); }).sort();
    var seq = Number.isSafeInteger(all.__seq) && all.__seq >= 0 ? all.__seq : 0;
    var reserved = new Set(), assigned = new Set(), changed = false;
    ids.forEach(function (id) {
      all[id].versions.forEach(function (v) {
        if (!v || typeof v !== 'object' || typeof v.vid !== 'string' || !v.vid) return;
        reserved.add(v.vid);
        var m = /^v([0-9]+)$/.exec(v.vid);
        if (m && Number.isSafeInteger(Number(m[1]))) seq = Math.max(seq, Number(m[1]));
      });
    });
    ids.forEach(function (id) {
      all[id].versions.forEach(function (v) {
        if (!isVersionShape(v)) return;
        if (typeof v.vid === 'string' && v.vid && !assigned.has(v.vid)) {
          assigned.add(v.vid);
          return;
        }
        var next;
        do { seq += 1; next = 'v' + seq; } while (reserved.has(next));
        v.vid = next;
        reserved.add(next);
        assigned.add(next);
        changed = true;
      });
    });
    if (seq > 0 && all.__seq !== seq) { all.__seq = seq; changed = true; }
    return changed;
  }

  function visibleDraft(d) {
    var versions = d.versions.filter(isVersionShape);
    return Object.assign({}, d, {
      versions: versions,
      corrupted_version_count: d.versions.length - versions.length
    });
  }

  function list() {
    var st = readState();
    if (st.corrupted) return { drafts: [], corrupted_ids: [], store_corrupted: true, reason: st.reason };
    var all = st.data;
    var drafts = [], corrupted_ids = [];
    Object.keys(all).forEach(function (id) {
      if (id === '__seq') return; /* 版本 vid 全局序号，非草案条目 */
      if (isDraftShape(all[id])) drafts.push(visibleDraft(all[id]));
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
    return isDraftShape(d) ? visibleDraft(d) : null;
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
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.request ||
      typeof snapshot.request !== 'object' || Array.isArray(snapshot.request)) return { ok: false, reason: 'bad_snapshot' };
    var st = readState();
    if (st.corrupted) return { ok: false, reason: 'corrupted_store', detail: st.reason }; /* 二十二轮 P2：不覆盖原数据 */
    var all = st.data;
    var now = new Date().toISOString();
    var existing = Object.keys(all).filter(function (k) { return isDraftShape(all[k]); });
    var match = existing.filter(function (k) { return all[k].name === name; })[0];
    /* 版本唯一 vid：跨草案单调递增（存全局序号于顶层 __seq，兼容旧数据从现有最大 vid 推） */
    var seq = Number.isSafeInteger(all.__seq) && all.__seq >= 0 ? all.__seq : 0;
    var vid = 'v' + (seq + 1);
    all.__seq = seq + 1;
    var id;
    var warn = null;
    if (match) {
      id = match;
      var d = all[id];
      if (visibleDraft(d).versions.length >= MAX_VERSIONS) warn = 'version_limit';
      d.versions.push({ vid: vid, version: d.versions.length + 1, snapshot: snapshot, saved_at: now }); /* 不自动删除（二十轮 P1-3） */
      d.updated_at = now;
    } else {
      if (existing.length >= MAX_DRAFTS) warn = 'draft_limit';
      id = 'dft_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      all[id] = { id: id, name: name || '未命名草案', created_at: now, updated_at: now, versions: [{ vid: vid, version: 1, snapshot: snapshot, saved_at: now }] };
    }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); }
    catch (e) { return { ok: false, reason: 'write_failed' }; }
    return { ok: true, draft: visibleDraft(all[id]), vid: vid, warn: warn };
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
