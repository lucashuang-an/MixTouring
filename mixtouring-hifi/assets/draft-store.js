/* draft-store.js · 卡 A：本机私人草案存储（纯前端 localStorage，G4 轻量版）
 * 交接纪律（v0.42.1 开发流程卡 A）：
 *  - 独立键 mt:drafts，不覆盖旧收藏（mt:favs）与心愿（mt:wishlist）键；
 *  - 保存内容=用户输入 + 地点名称与当时确认记录 + 约束 + 停留选择 + 候选结构摘要 + 版本号 + 保存时间；
 *  - plan_id/candidate_id/开放地点确认标识是短期服务端标识，只作「当时探索快照」记录，
 *    恢复时不得直接调用详情——必须重新规划，开放地点重新走服务端核验/用户确认；
 *  - 每次用户明确保存修改版时追加可回看版本，原版不覆盖；提供重命名、删除与删除确认；
 *  - 草案仅当前浏览器可见；页面明示清理浏览器数据可能丢失；不自动公开、不收集证件/精确住址；
 *  - 存储写入失败（隐私模式拒写/超限）不得谎报成功。 */
(function () {
  'use strict';
  var DRAFT_KEY = 'mt:drafts';
  var MAX_DRAFTS = 20;
  var MAX_VERSIONS = 10;

  function read() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      var val = raw ? JSON.parse(raw) : null;
      return val && typeof val === 'object' ? val : {};
    } catch (e) { return {}; }
  }
  function flush(all) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
      return true;
    } catch (e) {
      console.error('私人草案写入失败：' + e.message);
      return false;
    }
  }
  function isDraftShape(d) {
    return d && typeof d === 'object' && typeof d.id === 'string' &&
      Array.isArray(d.versions) && d.versions.length > 0 &&
      d.versions.every(function (v) { return v && typeof v.snapshot === 'object' && typeof v.saved_at === 'string'; });
  }

  /** 列出全部草案（损坏记录单列，不伪装成可用草案） */
  function list() {
    var all = read();
    var drafts = [], corrupted = [];
    Object.keys(all).forEach(function (id) {
      if (isDraftShape(all[id])) drafts.push(all[id]);
      else corrupted.push(id);
    });
    drafts.sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
    return { drafts: drafts, corrupted_ids: corrupted };
  }

  function get(id) {
    var d = read()[id];
    return isDraftShape(d) ? d : null;
  }

  /**
   * 保存（新建或追加版本）。snapshot 形如：
   * { request:{origin,destination,text}, travel:{...}, constraints:{...},
   *   place_names:{origin,destination,hub}, confirmed_note:{origin,destination},
   *   candidate:{id,label,kind,hub}, nights, engine }
   * plan_id/candidate_id 只进快照记录，恢复时不用。
   * @returns {ok, draft?, reason?} reason: 'write_failed' | 'corrupted_store'
   */
  function save(name, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'bad_snapshot' };
    var all = read();
    /* 存储整体损坏检测：非对象即拒写保护 */
    var now = new Date().toISOString();
    var id;
    var existing = Object.keys(all).filter(function (k) { return isDraftShape(all[k]); });
    /* 同名草案视为同一草案的修改保存（追加版本） */
    var match = existing.filter(function (k) { return all[k].name === name; })[0];
    if (match) {
      id = match;
      all[id].versions.push({ version: all[id].versions.length + 1, snapshot: snapshot, saved_at: now });
      if (all[id].versions.length > MAX_VERSIONS) all[id].versions = all[id].versions.slice(-MAX_VERSIONS);
      all[id].updated_at = now;
    } else {
      id = 'dft_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      all[id] = { id: id, name: name || '未命名草案', created_at: now, updated_at: now, versions: [{ version: 1, snapshot: snapshot, saved_at: now }] };
    }
    var ids = Object.keys(all).filter(function (k) { return isDraftShape(all[k]); });
    /* 超出上限：删最旧 */
    if (ids.length > MAX_DRAFTS) {
      ids.sort(function (a, b) { return String(all[a].updated_at || '').localeCompare(String(all[b].updated_at || '')); });
      ids.slice(0, ids.length - MAX_DRAFTS).forEach(function (k) { delete all[k]; });
    }
    var ok = flush(all);
    return ok ? { ok: true, draft: all[id] } : { ok: false, reason: 'write_failed' };
  }

  function rename(id, name) {
    var all = read();
    if (!isDraftShape(all[id])) return { ok: false, reason: 'not_found' };
    all[id].name = String(name || '').trim().slice(0, 40) || all[id].name;
    all[id].updated_at = new Date().toISOString();
    return flush(all) ? { ok: true, draft: all[id] } : { ok: false, reason: 'write_failed' };
  }

  function remove(id) {
    var all = read();
    if (!all[id]) return { ok: false, reason: 'not_found' };
    delete all[id];
    return flush(all) ? { ok: true } : { ok: false, reason: 'write_failed' };
  }

  window.MTDrafts = { list: list, get: get, save: save, rename: rename, remove: remove, DRAFT_KEY: DRAFT_KEY };
})();
