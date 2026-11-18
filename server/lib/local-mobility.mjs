/* 从本轮可见目录提取出行方式线索；不是可售库存或指定日运营确认。 */
const modes=[['day_tour',/day[ -]?tours?|day[ -]?trips?|一日(?:游|团)|当天游|当地团/i],['shared_tour',/拼团|小团|跟团|guided tours?|group tours?/i],['transfer',/包车|接送|接驳|shuttles?|transfers?|private car|pick[ -]?up/i],['public_transit',/公交|公共交通|地铁|public bus|metro|public transport/i],['cable_car',/缆车|索道|cable car|gondola/i]];
const productHost=host=>/(^|\.)(?:getyourguide\.com|viator\.com|klook\.com|headout\.com|civitatis\.com|tripadvisor\.[a-z.]+)$/.test(host);
export function buildLocalMobilityIndex(catalog){
  const rows=[];
  for(const source of catalog?.entries || []){
    let url;try{url=new URL(source.url);if(url.protocol!=='https:')continue;}catch{continue;}
    const pieces=[source.title,source.excerpt].filter(Boolean).flatMap(t=>t.match(/[^。！？!?\n；;]+[。！？!?；;]?/g)||[]);
    for(const [mode,pattern]of modes){
      const sentence=pieces.find(p=>pattern.test(p));if(!sentence)continue;
      const match=sentence.match(pattern),start=Math.max(0,match.index-80),quote=sentence.slice(start,Math.max(start+240,match.index+match[0].length)).trim();
      const negative=/(?:没有|无|未找到|取消|停运|not available|no tours?|cancelled|suspended)/i.test(sentence);
      const multiple=/(?:\b(?:[2-9]|[1-9]\d+|two|three|four|multi)[ -]?days?\b|(?:[2-9]|[1-9]\d+|两|二|三|四|五|六|七|八|九|十)日游|多日游)/i.test(sentence);
      const single=/\b(?:one|1)[ -]?day\b|一日游|一日团/i.test(sentence);
      rows.push({mode:mode==='day_tour' && multiple && !single?'multi_day_tour':mode,source_id:source.id,url:source.url,title:source.title,quote,
        basis:negative?'unavailable_reference':source.kind==='experience'?'experience_reference':productHost(url.hostname) || /^\/(?:things-to-do|tours?|activities)\//.test(url.pathname)?'offer_reference':'source_reference',
        read_status:source.read_status,temporal_state:source.temporal_state,availability:'not_checked'});
      if(rows.length>=12)return rows;
    }
  }
  return rows;
}
