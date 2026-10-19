/* 跨旅行偏好记忆（v0.60.1 M2）：独立本机键，默认关闭；仅用户显式开启且明确长期表达才提交。
 * 删除/纠正用撤销标记与递增 revision——旧标签页、旧旅行快照或历史恢复不能把已删除条目写回。
 * 与旅行快照完全隔离：旅行保存/恢复流程不读写本键。 */
(function () {
  var STORE_KEY = 'mt:preference-memory';
  var SCHEMA_VERSION = 1;
  /* 跨旅行可复用的软偏好键（一次性条件——日期、预算、必经城市、住宿——不在其列） */
  var ALLOWED_KEYS = ['pace', 'road', 'preferred_mode', 'experience', 'nature_theme'];
  var KEY_LABEL = { pace: '节奏偏好', road: '公路接受度', preferred_mode: '优先交通', experience: '体验搭配', nature_theme: '自然主题' };

  var state = defaults();
  var loaded = false;

  function defaults() {
    return { schema_version: SCHEMA_VERSION, enabled: false, entries: [], next_id: 1, revision: 0, degraded: null };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaults();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults();
      if (parsed.schema_version !== SCHEMA_VERSION) {
        /* 未知更高 schema：保留原文不覆盖，降级为空记忆运行 */
        var kept = defaults();
        kept.degraded = { stored_schema_version: parsed.schema_version, raw: raw };
        return kept;
      }
      var st = defaults();
      st.enabled = parsed.enabled === true;
      st.next_id = Number.isSafeInteger(parsed.next_id) && parsed.next_id > 0 ? parsed.next_id : 1;
      st.revision = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
      st.entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map(function (e) {
        if (!e || typeof e !== 'object') return null;
        if (ALLOWED_KEYS.indexOf(e.key) < 0) return null;
        if (typeof e.value !== 'string' || !e.value) return null;
        if (['active', 'removed'].indexOf(e.status) < 0) return null;
        return {
          id: /^pref_\d+$/.test(String(e.id)) ? e.id : null,
          key: e.key, value: e.value.slice(0, 60), status: e.status,
          source_message_mid: Number.isSafeInteger(e.source_message_mid) ? e.source_message_mid : null,
          created_at: typeof e.created_at === 'string' ? e.created_at : null,
          updated_at: typeof e.updated_at === 'string' ? e.updated_at : null,
          revision: Number.isSafeInteger(e.revision) && e.revision >= 0 ? e.revision : 0
        };
      }).filter(Boolean).map(function (e, i) { if (!e.id) e.id = 'pref_' + (st.next_id + i); return e; });
      return st;
    } catch (e) { return defaults(); }
  }

  function persist() {
    try {
      var current = load();
      /* 跨标签页失效：存储侧 revision 已前进（另一标签页改过）——拒绝本次旧状态写回 */
      if (loaded && current.revision > state.revision) { state = current; return false; }
      state.revision += 1;
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      loaded = true;
      return true;
    } catch (e) { return false; }
  }

  function ensureLoaded() { if (!loaded) { state = load(); loaded = true; } }

  var MTPreferences = {
    KEYS: ALLOWED_KEYS.slice(),
    KEY_LABEL: KEY_LABEL,
    SCHEMA_VERSION: SCHEMA_VERSION,
    isEnabled: function () { ensureLoaded(); return state.enabled === true; },
    setEnabled: function (v) {
      ensureLoaded();
      state.enabled = v === true;
      return persist();
    },
    /* 全部条目（含已删除，供查看与审计） */
    entries: function () { ensureLoaded(); return JSON.parse(JSON.stringify(state.entries)); },
    /* 当前生效（已开启且 active）——召回与提交的唯一样源 */
    list: function () {
      ensureLoaded();
      return state.enabled ? state.entries.filter(function (e) { return e.status === 'active'; })
        .map(function (e) { return { id: e.id, key: e.key, value: e.value, revision: e.revision }; }) : [];
    },
    /* 新增或纠正：须已开启记忆；同 key 纠正更新 value 并递增条目 revision */
    propose: function (key, value, messageRef) {
      ensureLoaded();
      if (!state.enabled) return { ok: false, reason: 'memory_disabled' };
      if (ALLOWED_KEYS.indexOf(key) < 0) return { ok: false, reason: 'key_not_allowed' };
      if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'empty_value' };
      var now = new Date().toISOString();
      for (var i = 0; i < state.entries.length; i++) {
        var e = state.entries[i];
        if (e.key === key && e.status === 'active') {
          if (e.value === value.trim()) return { ok: true, id: e.id, unchanged: true };
          e.value = value.trim().slice(0, 60);
          e.updated_at = now;
          e.revision += 1;
          e.source_message_mid = Number.isSafeInteger(messageRef) ? messageRef : e.source_message_mid;
          return { ok: persist(), id: e.id, corrected: true };
        }
      }
      state.entries.push({
        id: 'pref_' + state.next_id, key: key, value: value.trim().slice(0, 60), status: 'active',
        source_message_mid: Number.isSafeInteger(messageRef) ? messageRef : null,
        created_at: now, updated_at: now, revision: 0
      });
      state.next_id += 1;
      return { ok: persist(), id: 'pref_' + (state.next_id - 1) };
    },
    /* 删除：撤销标记（不物理删）——旧快照/旧标签页恢复不能复活；重新明确表达才可新增 */
    remove: function (id) {
      ensureLoaded();
      for (var i = 0; i < state.entries.length; i++) {
        if (state.entries[i].id === id && state.entries[i].status === 'active') {
          state.entries[i].status = 'removed';
          state.entries[i].updated_at = new Date().toISOString();
          state.entries[i].revision += 1;
          return { ok: persist() };
        }
      }
      return { ok: false, reason: 'not_found' };
    },
    /* 供对话请求：仅开启时携带当前生效偏好；关闭时空（服务端不召回不提交） */
    snapshotForRequest: function () {
      ensureLoaded();
      if (!state.enabled) return { enabled: false, preferences: [] };
      return { enabled: true, preferences: this.list().map(function (e) { return { key: e.key, value: e.value }; }) };
    },
    /* 服务端校验后的 upserts 应用（仅 enabled；由前端显式调用，恢复流程不经过这里） */
    applyUpserts: function (upserts, messageRef) {
      ensureLoaded();
      var results = [];
      for (var i = 0; i < (Array.isArray(upserts) ? upserts : []).length; i++) {
        var u = upserts[i];
        results.push(this.propose(u && u.key, u && typeof u.value === 'string' ? u.value : String(u && u.value == null ? '' : u.value), messageRef));
      }
      return results;
    },
    _state: function () { ensureLoaded(); return JSON.parse(JSON.stringify(state)); }
  };

  /* 跨标签页失效：另一标签页写入后，本页下一次操作前重载最新状态 */
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', function (event) { if (event.key === STORE_KEY) { state = load(); loaded = true; } });
  }

  if (typeof window !== 'undefined') window.MTPreferences = MTPreferences;
  if (typeof module !== 'undefined' && module.exports) module.exports = MTPreferences;
})();
