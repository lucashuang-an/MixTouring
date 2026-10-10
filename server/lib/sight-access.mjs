/* 景点接驳分项：只消费服务端策展来源，驾车参考不进入无车预算，也不充当本次日期班次。 */
import { readFileSync } from 'node:fs';
import { utcToZoned } from './trip.mjs';
import { isValidWindow } from './anywhere.mjs';
const DATA=JSON.parse(readFileSync(new URL('../../pipeline/data/sight-access.json',import.meta.url),'utf8'));
const KINDS=['road','public_transport','waiting','local_transfer'];
export function validAccessReference(row) {
  if (!row || !KINDS.includes(row.kind) || typeof row.from!=='string' || !row.from || typeof row.to!=='string' || !row.to) return false;
  const s=row.source;
  if (!s || !/^https:\/\//.test(s.url || '') || !s.title || !/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(s.published_at || '') || !row.method) return false;
  const pub=s.published_at.length===4?s.published_at+'-01-01':s.published_at.length===7?s.published_at+'-01':s.published_at;
  if (!isValidWindow(pub+' ~ '+pub) || !isValidWindow(s.sampled_at+' ~ '+s.sampled_at)) return false;
  if (row.review_by && !isValidWindow(row.review_by+' ~ '+row.review_by)) return false;
  if (!['historical','source_lead'].includes(row.evidence_state)) return false;
  if (row.duration_minutes!==null && (!Number.isFinite(row.duration_minutes) || row.duration_minutes<=0)) return false;
  if (row.kind==='road' && !['self_drive','road_reference'].includes(row.mode)) return false;
  if (row.kind==='public_transport' && row.mode!=='road_passenger') return false;
  return true;
}
export function sightAccess(id, name, nowMs=Date.now()) {
  const today=utcToZoned(nowMs,'Asia/Shanghai').dateStr;
  const refs=DATA.references.filter((r)=>r.attraction_id===id && validAccessReference(r)).map((r)=>{
    const copy=structuredClone(r);
    if (r.review_by && today>r.review_by) copy.evidence_state='stale';
    if (r.source.published_at>today || r.source.sampled_at>today) copy.evidence_state='unsupported';
    return copy;
  });
  const components=KINDS.map((kind)=>({kind,from:kind==='local_transfer'?name+'门区':'伊宁／对应县城',to:kind==='waiting'?'上车等候地点':name,
    duration_minutes:null,evidence_state:'explore',operator:null,applicable_dates:null,source:null,
    references:refs.filter((r)=>r.kind===kind),
    missing:kind==='road'?['本次实际道路路线与耗时']:kind==='public_transport'?['运营方、上下车点、去返班次和本次日期运营']:kind==='waiting'?['候车和返程末班时间']:['景区区间车、步道和开放范围']}));
  const lead=refs.find((r)=>r.kind==='public_transport' && r.evidence_state==='source_lead');
  return { location:structuredClone(DATA.locations[id] || null),components,
    no_car_access:lead?'source_lead':'unverified', travel_time_hours:null,
    public_note:lead?'有 '+lead.from+' → '+lead.to+' 的线路车报道；仍须核对本次运营、候车和回程，不代表伊宁起点全程可达。':null,
    season:structuredClone(DATA.season_notes[id] || null),
    basis:'资料车程按其原始起终点和方式展示，复核期限不是运营有效期；未知分项不记零，不将驾车参考换算为公共交通时间。' };
}
