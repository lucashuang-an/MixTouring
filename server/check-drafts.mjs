/* check-drafts.mjs · 卡 A：私人草案存储层确定性测试（Node VM + 内存 localStorage 假体，无网络无服务）
 * v0.42.3 二十二轮修订：版本唯一 vid（连续保存不重号、按 vid 恢复不错版）、上限不静默删除、
 * 损坏分层（整体 JSON 损坏→corrupted_store 拒写保护/单条坏条目隔离）、旧键隔离测试修正（同一假存储逐字节比对）。
 * 运行：node server/check-drafts.mjs */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
let total = 0;
const ok = (cond, name) => { total++; if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

function makeEnv({ quotaExceeded = false, preset = null } = {}) {
  const store = new Map();
  if (preset) for (const [k, v] of Object.entries(preset)) store.set(k, v);
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (quotaExceeded) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: (k) => store.delete(k)
  };
  const sandbox = { window: {}, localStorage: ls, console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'mixtouring-hifi/assets/draft-store.js'), 'utf8'), sandbox);
  return { MTDrafts: sandbox.window.MTDrafts, ls, store };
}

const snap = (over = {}) => Object.assign({
  request: { origin: '北京', destination: '阿拉木图' },
  travel: { trip_type: 'round_trip', outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1 },
  constraints: {},
  place_names: { origin: '北京', destination: '阿拉木图' },
  confirmed_note: { origin: null, destination: null },
  candidate: { id: 'cand-one-transfer', label: '一次中转假设', kind: 'one_transfer', hub: '乌鲁木齐', modes: '+plane' },
  nights: 0, engine: 'dict'
}, over);

/* ---------- 基础保存/版本/vid 唯一 ---------- */
{
  const env = makeEnv();
  const r1 = env.MTDrafts.save('北京 → 阿拉木图', snap());
  ok(r1.ok && r1.draft.versions[0].vid === 'v1', '保存新建：版本 vid=v1');
  const r2 = env.MTDrafts.save('北京 → 阿拉木图', snap({ nights: 2 }));
  ok(r2.ok && r2.draft.versions.length === 2 && r2.draft.versions[0].snapshot.nights === 0 && r2.vid === 'v2',
    '同名保存追加版本，原版不被覆盖，新 vid=v2');
  ok(env.MTDrafts.list().drafts.length === 1, '同名归并为一份草案');
  ok(env.MTDrafts.save('北京 → 喀什', snap({ travel: { trip_type: 'one_way', traveler_count: 1 } })).ok, '不同名保存为独立草案');
  ok(env.MTDrafts.list().drafts.some(d => d.versions[0].snapshot.travel.trip_type === 'one_way' && !d.versions[0].snapshot.travel.return_window),
    '单程快照不带返程窗（恢复不会回填返程）');
}

/* ---------- P1-2：连续保存 15 次 vid 不重号、按 vid 恢复正确 ---------- */
{
  const env = makeEnv();
  for (let i = 0; i < 15; i++) env.MTDrafts.save('多版本', snap({ nights: i }));
  const d = env.MTDrafts.get(env.MTDrafts.list().drafts[0].id);
  const vids = d.versions.map((v) => v.vid);
  ok(new Set(vids).size === vids.length, 'P1-2：连续保存 15 次版本 vid 全部唯一（不重号）');
  const last = d.versions[d.versions.length - 1];
  const got = env.MTDrafts.get(d.id).versions.filter((v) => v.vid === last.vid)[0];
  ok(got.snapshot.nights === 14, 'P1-2：按 vid 取最新版内容正确（不错版）');
}

/* ---------- P1-3：上限不静默删除 ---------- */
{
  const env = makeEnv();
  const first = env.MTDrafts.save('多版本', snap({ nights: 0 }));
  for (let i = 0; i < 14; i++) env.MTDrafts.save('多版本', snap({ nights: i + 1 }));
  const d = env.MTDrafts.get(first.draft.id);
  ok(!!d && d.versions.length >= 11 && d.versions.some((v) => v.snapshot.nights === 0),
    'P1-3：版本超 10 不静默删除原版（保留并提示由界面传达）');
  const env2 = makeEnv();
  let firstId = null;
  for (let i = 0; i < 21; i++) { const r = env2.MTDrafts.save('草案 ' + i, snap({ nights: i })); if (i === 0) firstId = r.draft.id; }
  ok(!!env2.MTDrafts.get(firstId), 'P1-3：草案数超 20 不静默删除最旧（原数据保留）');
  ok(env2.MTDrafts.list().drafts.length === 21, 'P1-3：不自动删除的容量策略（21 份都在，用户主动清理）');
}

/* ---------- P2：损坏分层 ---------- */
{
  /* 整体 JSON 损坏：拒写保护 */
  const env1 = makeEnv({ preset: { 'mt:drafts': '{broken json' } });
  const s1 = env1.MTDrafts.save('x', snap());
  ok(!s1.ok && s1.reason === 'corrupted_store', 'P2：整体 JSON 损坏 → save 拒绝覆盖（corrupted_store）');
  ok(env1.store.get('mt:drafts') === '{broken json', 'P2：原损坏数据原样保留（不被覆盖）');
  ok(env1.MTDrafts.list().store_corrupted === true, 'P2：list 标记 store_corrupted（界面可提示）');
  /* 数组顶层：同样视为损坏 */
  const env1b = makeEnv({ preset: { 'mt:drafts': '[]' } });
  ok(!env1b.MTDrafts.save('x', snap()).ok && env1b.MTDrafts.list().store_corrupted === true,
    'P2：顶层数组/非字典视为损坏');
  /* 单条坏条目：隔离、好草案不受影响 */
  const env2 = makeEnv();
  env2.MTDrafts.save('好草案', snap());
  const raw = JSON.parse(env2.ls.getItem('mt:drafts'));
  raw.bad1 = { no_versions: true };
  raw.bad2 = { id: 'x', versions: [{ vid: 'v1', snapshot: null, saved_at: '2026-09-26' }] }; /* null 快照 */
  env2.ls.setItem('mt:drafts', JSON.stringify(raw));
  const list = env2.MTDrafts.list();
  ok(list.drafts.length === 1 && list.corrupted_ids.length === 2, 'P2：null 快照/坏条目隔离单列，好草案正常显示');
  ok(env2.MTDrafts.get('bad2') === null, 'P2：null 快照条目 get 为 null（界面可提示并清理）');
  const pc = env2.MTDrafts.purgeCorrupted();
  ok(pc.ok && pc.removed.length === 2 && env2.MTDrafts.list().drafts.length === 1,
    'P2：purgeCorrupted 经确认只清坏条目（好草案保留）');
}

/* ---------- 二十三轮：v0.42.2 升级迁移 / 损坏保护 / 直达匹配 ---------- */
{
  /* P1-1：v0.42.2 无 vid 旧草案升级——单版/多版保留、vid 迁移、清理不删旧草案 */
  const envOld = makeEnv({ preset: { 'mt:drafts': JSON.stringify({ d1: { id: 'd1', name: '旧草案', created_at: '2026-09-25', updated_at: '2026-09-25', versions: [
    { version: 1, snapshot: { request: { origin: '北京', destination: '阿拉木图' }, nights: 0 }, saved_at: '2026-09-25T10:00:00.000Z' },
    { version: 2, snapshot: { request: { origin: '北京', destination: '阿拉木图' }, nights: 2 }, saved_at: '2026-09-25T11:00:00.000Z' }
  ] } }) } });
  const l1 = envOld.MTDrafts.list();
  ok(l1.drafts.length === 1 && l1.corrupted_ids.length === 0, 'P1-1：v0.42.2 旧草案（无 vid）识别为合法草案而非损坏');
  const migrated = envOld.MTDrafts.get('d1');
  ok(migrated.versions.length === 2 && migrated.versions.every((v) => /^v[0-9]+$/.test(v.vid)) &&
    migrated.versions[1].snapshot.nights === 2, 'P1-1：迁移补 vid 且两条旧快照逐项保留');
  envOld.MTDrafts.purgeCorrupted();
  ok(!!envOld.MTDrafts.get('d1') && envOld.MTDrafts.list().drafts.length === 1, 'P1-1 反例：清理损坏不删除旧版合法草案');
  /* 重号旧版本：normalize 去重递增 */
  const envDup = makeEnv({ preset: { 'mt:drafts': JSON.stringify({ d2: { id: 'd2', name: '重号', created_at: 'x', updated_at: 'x', versions: [
    { vid: 'v11', version: 11, snapshot: { request: { a: 1 }, nights: 11 }, saved_at: 'x' },
    { vid: 'v11', version: 11, snapshot: { request: { a: 1 }, nights: 11 }, saved_at: 'x' }
  ] }, __seq: 11 }) } });
  const d2n = envDup.MTDrafts.get('d2');
  ok(new Set(d2n.versions.map((v) => v.vid)).size === d2n.versions.length, 'P1-1：已有重号版本迁移后 vid 去重递增');
  /* P2：整体损坏拒写保护已测；此处补数组顶层 */
  const envArr = makeEnv({ preset: { 'mt:drafts': '[]' } });
  ok(envArr.MTDrafts.list().store_corrupted === true && !envArr.MTDrafts.save('x', snap()).ok,
    'P2：顶层数组 → 损坏拒写（原数据不被覆盖）');
  /* null 快照单条隔离已在上方覆盖；此处补列表不因 null 抛错 */
  const envN = makeEnv({ preset: { 'mt:drafts': JSON.stringify({ ok1: { id: 'ok1', name: '好', created_at: 'x', updated_at: 'x', versions: [{ vid: 'v1', version: 1, snapshot: { request: { a: 1 }, nights: 0 }, saved_at: 'x' }] }, bad: { id: 'bad', name: '坏', created_at: 'x', updated_at: 'x', versions: [{ vid: 'v1', snapshot: null, saved_at: 'x' }] } }) } });
  const ln = envN.MTDrafts.list();
  ok(ln.drafts.length === 1 && ln.corrupted_ids.length === 1, 'P2 反例：null 快照草案隔离，好草案仍显示（列表不抛错）');
}

/* ---------- 二十四轮：混合好坏版本保留、旧版身份稳定 ---------- */
{
  const valid = (name, nights, vid) => ({
    id: name, name, created_at: 'x', updated_at: 'x',
    versions: [{ ...(vid ? { vid } : {}), version: 1,
      snapshot: { request: { origin: '北京', destination: '喀什' }, nights }, saved_at: 'x' }]
  });
  const env = makeEnv({ preset: { 'mt:drafts': JSON.stringify({
    d1: valid('d1', 1), d2: valid('d2', 2), d3: valid('d3', 3, 'v1')
  }) } });
  const listed = env.MTDrafts.list();
  const identities = listed.drafts.map((d) => d.versions[0].vid);
  ok(new Set(identities).size === 3 && identities.every(Boolean),
    '二十四轮：多份旧草案迁移后，跨草案 vid 唯一');
  ok(listed.drafts.every((d) => env.MTDrafts.get(d.id).versions[0].vid === d.versions[0].vid),
    '二十四轮：list/get 对同一旧版本返回相同 vid');
  const persisted = env.ls.getItem('mt:drafts');
  const reloaded = makeEnv({ preset: { 'mt:drafts': persisted } });
  ok(reloaded.MTDrafts.list().drafts.every((d) =>
    listed.drafts.find((old) => old.id === d.id).versions[0].vid === d.versions[0].vid),
  '二十四轮：迁移写回后刷新，旧版本 vid 不变');
  const before = reloaded.MTDrafts.get('d2').versions[0];
  reloaded.MTDrafts.save('d2', snap({ nights: 4 }));
  const after = reloaded.MTDrafts.get('d2');
  ok(after.versions.some((v) => v.vid === before.vid && v.snapshot.nights === 2) &&
    new Set(reloaded.MTDrafts.list().drafts.flatMap((d) => d.versions.map((v) => v.vid))).size === 4,
  '二十四轮：追加新版后旧版仍按原 vid 精确恢复，全部 vid 唯一');
  const blocked = makeEnv({ quotaExceeded: true, preset: { 'mt:drafts': JSON.stringify({ d1: valid('d1', 1), d2: valid('d2', 2) }) } });
  const blockedRaw = blocked.ls.getItem('mt:drafts');
  const blockedList = blocked.MTDrafts.list();
  ok(blockedList.drafts.every((d) => blocked.MTDrafts.get(d.id).versions[0].vid === d.versions[0].vid) &&
    blocked.ls.getItem('mt:drafts') === blockedRaw && blocked.MTDrafts.save('d1', snap()).reason === 'write_failed',
  '二十四轮：迁移写入受限时读取身份仍稳定，原文不变且保存如实失败');
}
{
  const mixed = { id: 'mixed', name: '部分损坏', created_at: 'x', updated_at: 'x', versions: [
    { version: 1, snapshot: { request: { origin: '北京', destination: '喀什' }, nights: 2 }, saved_at: 'x' },
    { version: 2, snapshot: null, saved_at: 'x' }
  ] };
  const bad = { id: 'bad', name: '全损坏', versions: [{ version: 1, snapshot: null, saved_at: 'x' }] };
  const env = makeEnv({ preset: { 'mt:drafts': JSON.stringify({ mixed, bad }) } });
  const shown = env.MTDrafts.list();
  ok(shown.drafts.length === 1 && shown.drafts[0].corrupted_version_count === 1 &&
    shown.drafts[0].versions[0].snapshot.nights === 2 && shown.corrupted_ids.join() === 'bad',
  '二十四轮：混合好坏版本只隔离坏版本，好版本仍可恢复');
  const rawBeforePurge = JSON.parse(env.ls.getItem('mt:drafts'));
  ok(rawBeforePurge.mixed.versions.length === 2 && rawBeforePurge.mixed.versions[1].snapshot === null,
    '二十四轮：迁移不静默删除损坏版本原文');
  const purged = env.MTDrafts.purgeCorrupted();
  const rawAfterPurge = JSON.parse(env.ls.getItem('mt:drafts'));
  ok(purged.ok && purged.removed.join() === 'bad' &&
    rawAfterPurge.mixed.versions.length === 2 &&
    env.MTDrafts.get('mixed').versions[0].snapshot.nights === 2,
  '二十四轮：清理只删除全损坏条目，混合草案与好版本保留');
}

/* ---------- 失败场景：坏快照入参 / 存储拒写 ---------- */
{
  const { MTDrafts } = makeEnv();
  ok(!MTDrafts.save('x', null).ok && !MTDrafts.save('x', 'not-object').ok, '非法快照入参被拒');
  const q = makeEnv({ quotaExceeded: true });
  const r = q.MTDrafts.save('北京 → 阿拉木图', snap());
  ok(!r.ok && r.reason === 'write_failed', '存储拒写：save 如实返回 write_failed（不谎报成功）');
}

/* ---------- 重命名/删除 ---------- */
{
  const { MTDrafts } = makeEnv();
  const r = MTDrafts.save('旧名', snap());
  const id = r.draft.id;
  ok(MTDrafts.rename(id, '新名').ok && MTDrafts.get(id).name === '新名', '重命名生效');
  ok(!MTDrafts.rename('missing', 'x').ok, '重命名不存在草案返回失败');
  ok(MTDrafts.remove(id).ok && MTDrafts.get(id) === null, '删除后不可恢复（get 为 null）');
  ok(!MTDrafts.remove(id).ok, '重复删除返回失败');
}

/* ---------- 旧键隔离（二十二轮修正：同一假存储逐字节比对） ---------- */
{
  const OLD_FAVS = JSON.stringify([{ id: 'f1', title: '旧收藏' }]);
  const OLD_WISH = JSON.stringify([{ id: 'w1' }]);
  const env = makeEnv({ preset: { 'mt:favs': OLD_FAVS, 'mt:wishlist': OLD_WISH } });
  env.MTDrafts.save('隔离草案', snap());
  env.MTDrafts.save('隔离草案 2', snap());
  ok(env.ls.getItem('mt:favs') === OLD_FAVS && env.ls.getItem('mt:wishlist') === OLD_WISH,
    '旧键隔离（修正）：同一假存储中操作草案后旧收藏/心愿逐字节不变');
}

console.log(fail === 0
  ? `\n✓ 私人草案存储层确定性测试全部通过（${total} 项断言）`
  : `\n✗ 失败 ${fail} 项（共 ${total} 项断言）`);
process.exit(fail === 0 ? 0 : 1);
