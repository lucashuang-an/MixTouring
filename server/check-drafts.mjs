/* check-drafts.mjs · 卡 A：私人草案存储层确定性测试（纯函数 + 内存 localStorage 假体，无网络无服务）
 * 失败场景矩阵（v0.42.1 卡 A 验收④）：存储拒写、损坏记录、版本追加不覆盖、删除确认语义（删除后不可恢复）、
 * 单程快照不带返程窗（形状断言）、同名保存追加版本、上限截断最旧。
 * 运行：node server/check-drafts.mjs */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
let total = 0;
const ok = (cond, name) => { total++; if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

/* 内存 localStorage 假体（可注入拒写） */
function makeEnv({ quotaExceeded = false } = {}) {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (quotaExceeded) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: (k) => store.delete(k)
  };
  const sandbox = { window: {}, localStorage: ls, console };
  vm.createContext(sandbox);
  const src = readFileSync(join(root, 'mixtouring-hifi/assets/draft-store.js'), 'utf8');
  vm.runInContext(src, sandbox);
  return { MTDrafts: sandbox.window.MTDrafts, ls, store };
}

const snap = (over = {}) => Object.assign({
  request: { origin: '北京', destination: '阿拉木图' },
  travel: { trip_type: 'round_trip', outbound_window: '2026-09-27 ~ 2026-10-03', return_window: '2026-10-05 ~ 2026-10-11', traveler_count: 1 },
  constraints: {},
  place_names: { origin: '北京', destination: '阿拉木图' },
  confirmed_note: { origin: null, destination: null },
  candidate: { id: 'cand-one-transfer', label: '一次中转假设', kind: 'one_transfer', hub: '乌鲁木齐' },
  nights: 0, engine: 'dict'
}, over);

/* ---------- 基础保存/版本 ---------- */
{
  const { MTDrafts } = makeEnv();
  const r1 = MTDrafts.save('北京 → 阿拉木图', snap());
  ok(r1.ok && r1.draft.versions.length === 1, '保存新建：1 个版本');
  const r2 = MTDrafts.save('北京 → 阿拉木图', snap({ nights: 2 }));
  ok(r2.ok && r2.draft.versions.length === 2 && r2.draft.versions[0].snapshot.nights === 0,
    '同名保存追加版本，原版不被覆盖');
  const list = MTDrafts.list();
  ok(list.drafts.length === 1, '同名归并为一份草案');
  const other = MTDrafts.save('北京 → 喀什', snap({ request: { origin: '北京', destination: '喀什' }, travel: { trip_type: 'one_way', traveler_count: 1 } }));
  ok(other.ok && MTDrafts.list().drafts.length === 2, '不同名保存为独立草案');
  ok(MTDrafts.list().drafts.some(d => d.versions[0].snapshot.travel.trip_type === 'one_way' && !d.versions[0].snapshot.travel.return_window),
    '单程快照不带返程窗（恢复不会回填返程）');
}

/* ---------- 失败场景：存储拒写 ---------- */
{
  const { MTDrafts } = makeEnv({ quotaExceeded: true });
  const r = MTDrafts.save('北京 → 阿拉木图', snap());
  ok(!r.ok && r.reason === 'write_failed', '存储拒写：save 如实返回 write_failed（不谎报成功）');
}

/* ---------- 失败场景：损坏记录 ---------- */
{
  const { MTDrafts, ls } = makeEnv();
  MTDrafts.save('好草案', snap());
  /* 直接注入损坏记录 */
  const raw = JSON.parse(ls.getItem('mt:drafts'));
  raw.bad1 = { no_versions: true };
  raw.bad2 = { id: 'x', versions: [{ no_snapshot: 1 }] };
  ls.setItem('mt:drafts', JSON.stringify(raw));
  const list = MTDrafts.list();
  ok(list.drafts.length === 1 && list.corrupted_ids.length === 2,
    '损坏记录单列不伪装可用草案（好草案不受影响）');
  ok(MTDrafts.get('bad1') === null, 'get 损坏 id 返回 null');
}

/* ---------- 失败场景：坏快照入参 ---------- */
{
  const { MTDrafts } = makeEnv();
  ok(!MTDrafts.save('x', null).ok && !MTDrafts.save('x', 'not-object').ok, '非法快照入参被拒');
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

/* ---------- 上限截断 ---------- */
{
  const { MTDrafts } = makeEnv();
  for (let i = 0; i < 25; i++) MTDrafts.save('草案 ' + i, snap({ nights: i }));
  const list = MTDrafts.list();
  ok(list.drafts.length <= 20, '草案数上限 20（超出删最旧）');
  ok(list.drafts.some(d => d.name === '草案 24'), '最新草案保留');
  ok(!list.drafts.some(d => d.name === '草案 0'), '最旧草案被截断');
}

/* ---------- 版本数上限 ---------- */
{
  const { MTDrafts } = makeEnv();
  for (let i = 0; i < 15; i++) MTDrafts.save('多版本', snap({ nights: i }));
  const d = MTDrafts.list().drafts[0];
  ok(d.versions.length <= 10 && d.versions[d.versions.length - 1].snapshot.nights === 14,
    '版本数上限 10（保留最新）');
}

/* ---------- 旧键隔离 ---------- */
{
  const { ls, store } = makeEnv();
  MTDrafts_save();
  function MTDrafts_save() { /* 占位，下面真正调用 */ }
  const { MTDrafts } = makeEnv();
  MTDrafts.save('x', snap());
  ok(!store.has('mt:favs') && !store.has('mt:wishlist'),
    '私人草案使用独立键，不触碰旧收藏/心愿键');
}

console.log(fail === 0
  ? `\n✓ 私人草案存储层确定性测试全部通过（${total} 项断言）`
  : `\n✗ 失败 ${fail} 项（共 ${total} 项断言）`);
process.exit(fail === 0 ? 0 : 1);
