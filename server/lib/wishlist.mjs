/* wishlist.mjs · Phase 3 服务端心愿队列（AGENTS §6.3：心愿登记 → 服务端任务队列 → 离线生成 → 三重守门写回 → 状态回流）
 * 存储复用 pipeline/data/wishlist.json（与离线管道 wishlist-store.mjs 同一文件，管道处理后状态在此回流）。
 * 采集执行仍属离线 AI 工厂（§6.2）：本模块只管登记/去重/查询/移除/标记，不做在线实时生成。 */

import { getWishlist, saveWishlist } from '../../pipeline/wishlist-store.mjs';

const DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;

export function listWishes() {
  return getWishlist().items;
}

/* 登记心愿：同 from-to 存在未完成（pending/processing）登记时直接返回既有条目（幂等去重）。
 * 校验失败返回 { error }，成功返回 { item }。date 可缺省（前端总会带，管道侧可无日期生成）。 */
export function addWish({ from, to, date }) {
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string') return { error: '缺少出发地或目的地' };
  if (from.trim() === to.trim()) return { error: '出发地和目的地不能相同' };
  if (date && !DATE_RE.test(date)) return { error: '日期格式须为 YYYY/MM/DD' };
  const f = from.trim();
  const t = to.trim();
  const items = listWishes();
  const exist = items.find((w) => w.from === f && w.to === t && (w.status === 'pending' || w.status === 'processing'));
  if (exist) return { item: exist, deduped: true };
  const item = {
    id: 'wish-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    from: f, to: t,
    date: date || '',
    status: 'pending',
    ts: Date.now()
  };
  items.push(item);
  saveWishlist(items);
  return { item };
}

/* 移除心愿（队列管理用：清理误登记/测试数据） */
export function removeWish(id) {
  const items = listWishes();
  const next = items.filter((w) => w.id !== id);
  if (next.length === items.length) return false;
  saveWishlist(next);
  return true;
}

/* 生成完成后回流状态：generate-plan 写回成功后调用，pending → generated */
export function markGenerated(from, to, generatedAt) {
  const items = listWishes();
  const hit = items.find((w) => w.from === from && w.to === to && w.status === 'pending');
  if (!hit) return false;
  hit.status = 'generated';
  hit.generatedAt = generatedAt || new Date().toISOString();
  saveWishlist(items);
  return hit;
}
