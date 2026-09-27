/* 公共路线灵感只复用经整理的结构；历史价格、日期和班次不会进入新行程。 */
import { readFileSync } from 'node:fs';
import { buildServiceDB } from '../../pipeline/lib/derive.mjs';
const data = new URL('../../pipeline/data/', import.meta.url);

export function listInspirations() {
  const store = JSON.parse(readFileSync(new URL('plans.json', data), 'utf8'));
  const domestic = buildServiceDB(store).templates.map((t) => ({
    id: t.id, scope: 'domestic', from: t.from, to: t.to,
    stops: t.stops.map((s) => s.name), modes: t.segs.map((s) => s.mode === 'train' ? 'rail' : 'plane'),
    title: '经' + t.stops.slice(1, -1).map((s) => s.name).join('、') + '慢慢抵达',
    reason: '把途中城市留作可选停留，比较不同交通组合。',
    tradeoff: '换乘与接驳增加；历史组合需按本次日期重新查询。',
    evidence_state: 'historical', preferences: { pace: 'explore' },
    sources: [{ title: '库内历史路线结构，班期与费用不作当期依据', link: null }]
  }));
  const corridors = JSON.parse(readFileSync(new URL('discovery-corridors.json', data), 'utf8')).corridors;
  const choices = [
    { gateway: '伊宁', from: '北京', title: '先到伊犁，再探索阿拉木图', reason: '把伊宁作为中途城市，比较霍尔果斯跨境方向与直达的取舍。' },
    { gateway: '塔城', from: '北京', title: '经塔城探索巴克图方向', reason: '为想把塔城加入旅程的人保留另一条口岸方向。' },
    { gateway: '喀什', from: '广州', title: '从喀什继续探索比什凯克', reason: '先在喀什停留，再比较经吐尔尕特的跨境方向。' }
  ];
  const international = choices.map((choice) => {
    const corridor = corridors.find((c) => c.gateway === choice.gateway);
    if (!corridor) return null;
    return {
      id: 'intl-' + choice.gateway, scope: 'international', from: choice.from, to: corridor.destination,
      stops: [choice.from, corridor.gateway, corridor.destination], modes: [null, 'road'], via: corridor.waypoints,
      title: choice.title, reason: choice.reason,
      tradeoff: '进入门户城市的交通待查；跨境客运班期、口岸手续与衔接均须确认。',
      evidence_state: 'explore', preferences: { pace: 'explore' },
      sources: [{ title: corridor.title, link: corridor.link, date: corridor.date }]
    };
  }).filter(Boolean);
  return [...international, ...domestic];
}

export function inspirationFor(id, origin, destination) {
  return listInspirations().find((r) => r.id === id && r.from === origin && r.to === destination) || null;
}

export function inspirationRoute(item) {
  return { stops: item.stops.slice(1, -1), modes: item.modes.map((m) => m || 'unknown'),
    via: item.via || [], sources: item.sources, inspiration_id: item.id };
}
