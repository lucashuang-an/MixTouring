/* 接驳核验清单：列出需要查询的方向，不推定线路存在，不从去程反转生成返程证据。 */
import { sanitizeAnchors, resolvePlace, isValidWindow } from './anywhere.mjs';
const GATEWAYS = {
  nalati:['新源县城','那拉提景区门区'], kalajun:['特克斯县城','喀拉峻景区门区'],
  xiata:['昭苏县城','夏塔景区门区'], kuerdening:['巩留县城','库尔德宁景区门区'],
  sayram:[null,'赛里木湖门区'], qiaxi:['巩留县城','恰西景区门区'],
  qiongkushitai:['特克斯县客运站','琼库什台村']
};
export function accessChecklist({ state, comparisons, anchors:raw, constraints = {}, destination } = {}) {
  const anchors = sanitizeAnchors(raw), rows = [];
  const dest = resolvePlace(destination)?.name;
  const dates = isValidWindow(state?.play_window) ? state.play_window : null;
  const add = (id, from, to, purpose, window, references = []) => {
    if (!from || !to || from === to) return;
    rows.push({ id, from, to, purpose, date_window:window, evidence_state:'explore',
      operator:null, boarding_stop:null, alighting_stop:null, departure_time:null, arrival_time:null,
      timezone:null, duration_minutes:null, fare:null, baggage:null, applicable_dates:null,
      references:references.filter(r => r.kind === 'public_transport' && r.from === from && r.to === to),
      missing:['本次运营方与具体上下车点','适用日期、出发到达时刻及时区','候车、行李和单人费用口径'],
      query:(purpose.includes('内部')?'向景区管理方查询「'+from+' → '+to+'」的开放范围、内部交通与步行需求；':'向两端客运站或实际运营方查询「'+from+' → '+to+'」'+(window?'在 '+window+' ':' 的计划日期 ')+'是否有客运服务；')+'索取日期对应的公告或运营方答复，记录来源与查询时间。' });
  };
  for (const a of comparisons || []) {
    const [county, entry] = GATEWAYS[a.id] || [null,a.name+'门区'];
    const nodes = county ? ['伊宁',county,entry] : ['伊宁',entry];
    const refs = a.access.components.flatMap(p => p.references);
    for (let i=0;i<nodes.length-1;i++) {
      add(a.id+'-out-'+i,nodes[i],nodes[i+1],'景点去程查询',dates,refs);
      add(a.id+'-back-'+i,nodes[i+1],nodes[i],'景点回程独立查询',dates,refs);
    }
    add(a.id+'-local',entry,a.name+'游览范围','景区内部交通与开放核查',dates);
    for (const stay of Array.isArray(constraints?.lodging_stays)?constraints.lodging_stays:[]) {
      if (!isValidWindow(stay?.date+' ~ '+stay?.date) || !resolvePlace(stay.city)) continue;
      if (dates && (stay.date < dates.slice(0,10) || stay.date > dates.slice(13,23))) continue;
      add(a.id+'-stay-'+rows.length,entry,resolvePlace(stay.city).name,'若该日游览此处，核查返回住宿地；尚未分配景点日期',stay.date+' ~ '+stay.date);
    }
  }
  if (comparisons?.length) {
    add('arrival-to-base',anchors.outbound?.to_city,'伊宁','若从锁定到达城前往伊犁游玩，核查进区接驳',null);
    add('base-to-destination','伊宁',dest,'若游玩后继续前往目的地，核查跨城／跨境接驳',null);
  }
  add('destination-to-return',dest,anchors.return?.from_city,'目的地至锁定返程出发城，不能省略；需衔接返程锚点，接驳日期尚未安排',null);
  return { evidence_state:'explore', executable:false, rows,
    return_anchor:anchors.return?{from_city:anchors.return.from_city,date:anchors.return.date,depart_time:anchors.return.depart_time || null}:null,
    basis:'下列两端是查询方向，县城／门区尚非已核实站点；景点顺序和逐日安排未确定。去返分别取证，来源线索不证明本次班次。',
    missing_context:[...(!dest?['目的地尚未识别，目的地至返程城清单未能生成']:[]),
      ...(!anchors.return?['尚未锁定返程，游玩后离开伊犁的接驳待补']:[]),
      ...(anchors.outbound || anchors.return?['交通锚点只到城市层级，机场／车站至住宿地或客运站的市内接驳仍须核对具体站点']:[])] };
}
