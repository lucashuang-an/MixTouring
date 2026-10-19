/* check-preference-memory.mjs · v0.60.1 M2：跨旅行偏好——本机存储生命周期、召回边界与
 * 候选白名单。无网络、无密钥；前端 store 以真实脚本+localStorage 桩驱动。
 * 运行：node server/check-preference-memory.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validatePreferenceUpserts, sanitizeRecalledPreferences } from './lib/trip-memory.mjs';
import { conversationTurn } from './lib/conversation.mjs';


/* ---------- 前端 preference-store：真实脚本 + localStorage 桩 ---------- */
function makeStore() {
  const backing = { value: null };
  const localStorageStub = {
    getItem: (k) => (k === 'mt:preference-memory' ? backing.value : null),
    setItem: (k, v) => { if (k === 'mt:preference-memory') backing.value = v; },
    getItemRaw: () => backing.value
  };
  const listeners = [];
  const sandbox = {
    console, JSON, Object, Array, Date, Number, String, Boolean, Math, Error,
    localStorage: localStorageStub,
    setTimeout: (fn) => fn(),
    window: { addEventListener: (ev, fn) => { if (ev === 'storage') listeners.push(fn); } },
    module: { exports: {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = readFileSync(new URL('../mixtouring-hifi/assets/preference-store.js', import.meta.url), 'utf8');
  vm.runInContext(src, sandbox);
  const store = sandbox.window.MTPreferences || sandbox.module.exports;
  return { store, backing, listeners, sandbox };
}

/* 默认关闭：未开启时零召回、零提交（M03/M09 前提） */
{
  const { store } = makeStore();
  assert.equal(store.isEnabled(), false, '偏好：默认关闭');
  const prop = store.propose('road', 'exclude', 3);
  assert.equal(prop.ok, false, '偏好：未开启时提交被拒');
  assert.equal(prop.reason, 'memory_disabled', '偏好：拒绝原因如实标注');
  const emptySnap = store.snapshotForRequest();
  assert.equal(emptySnap.enabled, false, '偏好：关闭时请求快照未开启');
  assert.equal(emptySnap.preferences.length, 0, '偏好：关闭时请求快照零召回');
  const v = validatePreferenceUpserts({ upserts: [{ key: 'road', value: 'exclude' }] }, { memoryEnabled: false });
  assert.equal(v.accepted.length, 0 && v.disabled === true, '服务端：未开启记忆时候选全部丢弃');
}

/* 开启后：propose/list/纠正 revision 递增/快照只含 active */
{
  const { store } = makeStore();
  assert.equal(store.setEnabled(true), true, '偏好：显式开启成功');
  const first = store.propose('road', 'exclude', 3);
  assert.equal(first.ok, true, '偏好：开启后记录长期表达');
  assert.equal(store.list().length, 1, '偏好：开启后记录一条');
  assert.equal(store.list()[0].value, 'exclude', '偏好：记录值为长期表达');
  const fix = store.propose('road', 'prefer_other', 9);
  assert.equal(fix.ok && fix.corrected === true, true, '偏好：同 key 纠正走更新');
  assert.equal(store.list()[0].value, 'prefer_other', '偏好：纠正后值为新表达');
  const snap = store.snapshotForRequest();
  assert.equal(snap.enabled, true, '偏好：开启时快照带 enabled');
  assert.equal(snap.preferences.length, 1, '偏好：开启时快照携带生效条目');
  store.propose('trip_days', '7', 9);
  assert.equal(store.list().length, 1, '偏好：一次性条件（天数）不是合法偏好键，不记录');
}

/* 删除=撤销标记：list 不再含、entries 可审计、请求快照不含（M04 恢复不复活） */
{
  const { store } = makeStore();
  store.setEnabled(true);
  const p = store.propose('preferred_mode', 'rail', 2);
  store.remove(p.id);
  assert.equal(store.list().length, 0, 'M04：删除后召回不含该条');
  assert.equal(store.snapshotForRequest().preferences.length, 0, 'M04：删除后请求快照不含该条');
  assert.equal(store.entries().some((e) => e.id === p.id && e.status === 'removed'), true, 'M04：撤销标记保留可审计（不物理删）');
}

/* 跨标签页失效：存储侧 revision 前进后，旧状态写回被拒并重载（M04） */
{
  const { store, backing } = makeStore();
  store.setEnabled(true);
  store.propose('pace', 'explore', 1);
  const staleState = JSON.parse(backing.value);      /* 模拟另一标签页在其之上又改了一轮 */
  staleState.revision += 3;
  staleState.entries.push({ id: 'pref_99', key: 'pace', value: 'simple', status: 'active', revision: 0, created_at: '', updated_at: '' });
  backing.value = JSON.stringify(staleState);
  const result = store.propose('preferred_mode', 'rail', 5);  /* 旧内存状态发起写入 */
  const fresh = JSON.parse(backing.value);
  assert.equal(fresh.entries.some((e) => e.id === 'pref_99'), true, 'M04：另一标签页的新条目未被旧状态覆盖');
  assert.equal(fresh.entries.filter((e) => e.key === 'preferred_mode').length, 0, 'M04：旧标签页的迟到写入被拒绝');
  assert.notEqual(result.ok, true, 'M04：迟到写返回不成功语义');
}

/* 未知 schema：保留原文并降级运行，不覆盖（M07 同策略） */
{
  const { store, backing } = makeStore();
  backing.value = JSON.stringify({ schema_version: 99, enabled: true, entries: [{ key: 'road', value: 'exclude' }] });
  const fresh = makeStore();
  assert.equal(fresh.store.isEnabled(), false, '未知 schema：降级为默认关闭');
  assert.ok(JSON.parse(backing.value).schema_version === 99, '未知 schema：原文保留未覆盖');
}

/* ---------- 服务端：召回边界与候选白名单 ---------- */
/* 召回：仅开启且白名单内注入；当前条件优先说明随附（M03） */
{
  const recalled = sanitizeRecalledPreferences({ enabled: true, preferences: [
    { key: 'road', value: 'exclude' }, { key: 'trip_days', value: '7' }, { key: 'night_arrival', value: 'avoid' }] });
  assert.deepEqual(recalled.preferences, [{ key: 'road', value: 'exclude' }], 'M03：召回白名单过滤——天数/夜间到达等一次性条件不进偏好');
  assert.deepEqual(sanitizeRecalledPreferences({ enabled: false, preferences: [{ key: 'road', value: 'exclude' }] }).preferences, [], 'M03：未开启不召回');
}

/* 候选白名单：一次性条件拒绝并给原因（M03）；未开启丢弃并标记（M09） */
{
  const v = validatePreferenceUpserts({ upserts: [
    { key: 'road', value: 'prefer_other' },
    { key: 'trip_days', value: '7' },
    { key: 'required_stops', value: '伊宁' },
    { key: 'budget_max_cny', value: '8000' },
    { key: 'pace', value: 'overnight_bus' }
  ] }, { memoryEnabled: true });
  assert.deepEqual(v.accepted, [{ key: 'road', value: 'prefer_other' }], 'M03：仅枚举软偏好通过');
  assert.equal(v.rejected.length, 2, 'M03：单轮上限内的一次性条件全部拒绝（天数/必经）');
  const v2 = validatePreferenceUpserts({ upserts: [
    { key: 'budget_max_cny', value: '8000' },
    { key: 'pace', value: 'overnight_bus' }
  ] }, { memoryEnabled: true });
  assert.equal(v2.accepted.length, 0 && v2.rejected.length, 2, 'M03：预算与非法枚举值同样拒绝');
  assert.ok(v.rejected[0].reason.includes('白名单'), 'M03：拒绝原因说明一次性条件不升级');
}

/* 编排：关闭时模型给了候选也不返回 upserts（M09）；开启时经白名单返回 */
{
  const brief = { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] };
  const modelNoPatch = async () => ({ reply: '好', brief, ready: true, confirmed: false, requirements_patch: {} });
  const off = await conversationTurn({ text: '记住了', conversation: cleanConversation({ stage: 'ready', brief }), messages: messages4(),
    preference_memory: { enabled: false, preferences: [] } }, null, { model: async (opts) => {
      assert.ok(!JSON.parse(opts.user).long_term_preferences, 'M09：未开启时上下文不含偏好召回');
      return { ...okPayload2(), preference_memory_patch: { upserts: [{ key: 'road', value: 'exclude' }] } };
    } });
  assert.equal((off.preference_memory_upserts || []).length, 0, 'M09：未开启记忆时候选不返回（来源/网页内容更不可能写偏好）');
  const seen = [];
  const on = await conversationTurn({ text: '以后都不想坐长途巴士', conversation: cleanConversation({ stage: 'ready', brief }), messages: messages4(),
    preference_memory: { enabled: true, preferences: [{ key: 'pace', value: 'explore' }] } }, null, { model: async (opts) => {
      const user = JSON.parse(opts.user);
      seen.push(user.long_term_preferences || null);
      return { ...okPayload2(), preference_memory_patch: { upserts: [{ key: 'road', value: 'exclude' }, { key: 'trip_days', value: '5' }] } };
    } });
  assert.ok(seen.some((p) => p && p.some((x) => x.key === 'pace')), 'M03：开启时召回已启用偏好进入上下文');
  assert.deepEqual(on.preference_memory_upserts, [{ key: 'road', value: 'exclude' }], 'M03：一次性条件在返回前被白名单剥离');
}
function messages4() { return Array.from({ length: 4 }, (_, i) => ({ mid: i + 1, role: i % 2 ? 'assistant' : 'user', text: 'm' + (i + 1) })); }
import { cleanConversation } from './lib/conversation.mjs';
function okPayload2() { return { reply: '好', brief: { origin: '北京', destination: '阿拉木图', summary: 's', wishes: [], open_questions: [] }, ready: true, confirmed: false, requirements_patch: {} }; }


console.log('✓ 跨旅行偏好回归通过');