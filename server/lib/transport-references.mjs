/* 方向资料只由服务端策展；报道运营方与本次已核运营方分开，航线页售期不等于逐日班次。 */
import { readFileSync } from 'node:fs';
import { isValidWindow, resolvePlace } from './anywhere.mjs';
import { utcToZoned } from './trip.mjs';
const DATA=JSON.parse(readFileSync(new URL('../../pipeline/data/transport-references.json',import.meta.url),'utf8'));
const day=(s)=>typeof s==='string' && isValidWindow(s+' ~ '+s);
export function validTransportReference(r) {
  return !!(r && r.id && resolvePlace(r.from) && resolvePlace(r.to) && r.from!==r.to &&
    r.kind==='public_transport' && ['plane','road_passenger'].includes(r.mode) &&
    ['source_lead','historical'].includes(r.evidence_state) && r.method && r.duration_minutes===null &&
    r.source?.title && /^https:\/\//.test(r.source.url || '') && day(r.source.sampled_at) &&
    (r.source.published_at===null || day(r.source.published_at)) &&
    (r.reported_until===null || day(r.reported_until)) && (!r.review_by || day(r.review_by)));
}
export function transportReferences(from,to,nowMs=Date.now(),window=null) {
  const today=utcToZoned(nowMs,'Asia/Shanghai').dateStr;
  return DATA.references.filter(r=>r.from===from && r.to===to && validTransportReference(r)).map(r=>{
    const copy=structuredClone(r);
    if ((r.review_by && today>r.review_by) || (r.reported_until && today>r.reported_until)) copy.evidence_state='stale';
    if (r.source.sampled_at>today || (r.source.published_at && r.source.published_at>today)) copy.evidence_state='unsupported';
    copy.date_scope=r.reported_until && isValidWindow(window) && window.slice(13,23)>r.reported_until?'outside_reference':'unverified';
    copy.missing=['本次具体班次和起落两端当地时刻','指定日期运营与可用性','本次单人票价、行李及市内接驳'];
    return copy;
  });
}
