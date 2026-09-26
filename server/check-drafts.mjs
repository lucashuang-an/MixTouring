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
  const d = env.MTDrafts.list().drafts[0];
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
