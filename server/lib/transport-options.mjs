/* 从本轮公开资料整理可比较的查询方向；查询页不是班次存在或当期可订的证明。 */
import {createHash} from 'node:crypto';
import {sourceSupportsLeg} from './route-discovery.mjs';
const words={rail:/列车|火车|高铁|动车|铁路|train|rail/i,plane:/机票|航班|航空|飞机|flight|airline/i,drive:/自驾|驾车|开车|行车路线|驾车路线|driv(?:e|ing)/i,road:/班车|大巴|巴士|长途汽车|bus|coach/i};
const labels={rail:'火车',plane:'飞机',drive:'自驾',road:'长途客运'};
const denied=/暂无|没有|无直达|无航班|停运|停航|停飞|已取消|暂停|尚未开通|规划中|货运|物流|托运|freight|cargo|no (?:flights|trains|service)|suspended/i;
export function connectionOptions(sources,{from,to,mode='unknown',exclude_road=false,no_self_drive=false}={}){
  const modes=mode==='unknown'?['rail','plane',...(!exclude_road&&!no_self_drive?['drive']:[]),...(!exclude_road?['road']:[])]:[mode];
  return modes.flatMap(kind=>{
    const candidates=(sources || []).filter(s=>/^https:\/\//.test(s.url || '') && !['future','expired','outside_window','after_trip'].includes(s.temporal?.state));
    const supported=candidates.map(source=>{
      const body=source.title+'\n'+(source.excerpt || ''),clauses=body.split(/[。；;！!？?\n]/);
      if(clauses.some(line=>denied.test(line) && words[kind]?.test(line) && line.includes(from) && line.includes(to)))return null;
      const quote=clauses.find(line=>{
        if(denied.test(line)||!words[kind]?.test(line))return false;
        const start=line.indexOf(from),end=line.indexOf(to,start+from.length);
        return start>=0 && end>start && end-start<80 && /到|至|往返|—|－|→|开往|\bto\b/i.test(line.slice(start+from.length,end));
      });
      if(!quote)return null;
      const established=kind!=='drive' && sourceSupportsLeg({title:source.title,content:source.excerpt},from,to,kind);
      // 泛查询入口只说明有该方向的查询页面，不借标题推断有直达或当日可售。
      if(!established && !/查询|时刻表|机票|路线|攻略|怎么|导航|高铁|火车|train|flight|route|driv/i.test(quote))return null;
      return {source,basis:established?'connection_reference':'search_entry'};
    }).filter(Boolean);
    if(!supported.length)return [];
    supported.sort((a,b)=>Number(b.basis==='connection_reference')-Number(a.basis==='connection_reference'));
    const best=supported[0],id='connection_'+createHash('sha256').update([from,to,kind,best.source.url].join('|')).digest('hex').slice(0,16);
    const method={rail:'比较出发站、到达站和直达／换乘车次，再计入市内接驳。',plane:'比较航空行程的直飞／中转结果，同时考虑机场往返与候机时间。',drive:'查看驾车路线，按体力安排休息与停留；出发前确认路况、通行条件和停车。',road:'查询乘车点、到达站与客运班次，确认实际运营后再安排衔接。'}[kind];
    return [{id,from,to,mode:kind,label:labels[kind],route_nodes:[from,to],method,source:best.source,supplementary_sources:supported.slice(1,2).map(x=>x.source),basis:best.basis,evidence_state:'explore',
      temporal:{label:best.basis==='search_entry'?'查询入口':'连接参考',reason:kind==='drive'?'导航方向不证明全程可通行，路况与限制需按出发时间确认。':best.basis==='search_entry'?'查询页不证明存在直达或所选日期有班次；以实际查询结果为准。':'资料支持参考连接；实际班次、日期与票价仍需查询。'}}];
  });
}
