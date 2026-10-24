/* 公共路线灵感只复用经整理的结构；历史价格、日期和班次不会进入新行程。 */
import { readFileSync } from 'node:fs';
import { buildServiceDB } from '../../pipeline/lib/derive.mjs';
const data = new URL('../../pipeline/data/', import.meta.url);
const experiences=JSON.parse(readFileSync(new URL('route-experiences.json',data),'utf8')).places;
const EDITORIAL = {
  'tpl-001':'在银川停一站，再经阿克苏继续到喀什，把铁路与航班分成不同阶段。',
  'tpl-002':'在兰州暂停一下，把前往乌鲁木齐的铁路旅程分成两段。',
  'tpl-003':'去昆明之前，先把贵阳留作另一座想逛的城市。',
  'tpl-004':'先在海口停留，再研究沿铁路继续到三亚的安排。',
  'tpl-005':'把沈阳和哈尔滨放进同一次旅程，给中途停留留出空间。',
  'tpl-006':'先到西宁，再探索铁路进拉萨的方向，中途停留可以独立安排。'
};

export function listInspirations() {
  const store = JSON.parse(readFileSync(new URL('plans.json', data), 'utf8'));
  const domestic = buildServiceDB(store).templates.map((t) => ({
    id: t.id, scope: 'domestic', from: t.from, to: t.to,
    stops: t.stops.map((s) => s.name), modes: t.segs.map((s) => s.mode === 'train' ? 'rail' : 'plane'),
    title: '经' + t.stops.slice(1, -1).map((s) => s.name).join('、') + '慢慢抵达',
    reason: EDITORIAL[t.id] || '把'+t.stops.slice(1,-1).map(s=>s.name).join('、')+'也加入旅行，再继续前往'+t.to+'。',
    tradeoff: '需要在'+t.stops.slice(1,-1).map(s=>s.name).join('、')+'安排换乘'+(new Set(t.segs.map(s=>s.mode)).size>1?'，并衔接铁路与航班':'，适合愿意把旅程分段的人')+'。',
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
      title: experiences[choice.gateway]?.headline || choice.title, reason: choice.reason,
      benefits:experiences[choice.gateway]?.benefits || [],stop_days:{min:1,max:2,basis:'可调整停留建议，未包含未知交通耗时'},cost_label:'沿途住宿与接驳支出需另计',
      tradeoff: '进入门户城市的交通待查；跨境客运班期、口岸手续与衔接均须确认。',
      evidence_state: 'explore', preferences: { pace: 'explore' },
      sources: [{ title: corridor.title, link: corridor.link, date: corridor.date },...(experiences[choice.gateway]?[{title:experiences[choice.gateway].source.title,link:experiences[choice.gateway].source.url,date:experiences[choice.gateway].source.published_at}]:[])]
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
