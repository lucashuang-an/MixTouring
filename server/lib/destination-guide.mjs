/* 目的地玩法与路线调整分开理解，建议只消费策展景观资料，不生成班次或精确日程。 */
import { readFileSync } from 'node:fs';
import { resolvePlace } from './anywhere.mjs';
import { sightCatalog } from './sights.mjs';
import guide from '../../mixtouring-hifi/assets/trip-guide.js';
const DATA=JSON.parse(readFileSync(new URL('../../pipeline/data/destination-guides.json',import.meta.url),'utf8'));
const THEMES={mountains:'山景',canyon:'峡谷',lake:'湖泊',forest:'森林'};
export function destinationTurn(text,plan,context={}) {
  const t=String(text || ''),prefs=guide.clean(context.preferences),patch={};
  if(/只保留|去掉|删掉|再加|加上/.test(t) || /不去.*(?:夏塔|那拉提|喀拉峻|库尔德宁|赛里木湖|恰西|琼库什台)/.test(t) || /(?:推荐|只去|只选|保留|少选).*(?:两|二|2|几个).*(?:景点|处)|(?:两|二|2)个景点/.test(t)) return null;
  const place=resolvePlace(plan?.intent?.destination_place?.city || plan?.intent?.destination_place?.name || plan?.intent?.destination || context.destination);
  const city=place?.city || place?.name;
  const nature=/自然|山景|雪山|峡谷|湖泊|森林|户外/.test(t),urban=/城区|市区|市内|城市(?:游玩|生活|和|与)|人文|建筑/.test(t);
  const ask=/景点|怎么玩|游玩|值得.*去|规划思考|城区|市区/.test(t) || !!prefs.experience;
  if(!ask || /车次|航班|返程|去程|中转|换乘/.test(t)) return null;
  if(urban && nature && /兼顾|同时|搭配|结合|都想|都要/.test(t)) patch.experience='balanced';
  else if(/(?:更想|喜欢|优先|偏好|只想|只看).*(?:城区|市区|人文)/.test(t)) patch.experience='city';
  else if(/(?:更想|喜欢|优先|偏好|只想|只看).*(?:自然|户外)/.test(t)) patch.experience='nature';
  const names=[['mountains',/山景|雪山|山地/],['canyon',/峡谷/],['lake',/湖泊|湖景/],['forest',/森林/]];
  for(const [key,re] of names) if(re.test(t) && !/不想|不去|不要|取消/.test(t) && (/更想|喜欢|偏好|优先/.test(t) || t.length<=8)) patch.nature_theme=key;
  if(prefs.nature_theme && /不去|不想|不要|取消/.test(t) && names.find(([key,re])=>key===prefs.nature_theme && re.test(t))) patch.nature_theme=null;
  const days=t.match(/(?:目的地|当地|这里|城区|玩|留)\s*([一二两三四五六七八九十]|\d+)\s*天/) || (prefs.experience?t.match(/^\s*([一二两三四五六七八九十]|\d+)\s*天\s*$/):null);
  if(days){const n={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[days[1]] || Number(days[1]);if(n>=1 && n<=14)patch.destination_days=n;}
  const continuing=!!prefs.experience && /^(好|可以|就这样|按这个|继续|帮我安排|整理)/.test(t);
  if(!nature && !urban && !Object.keys(patch).length && !/怎么玩|值得.*去|景点|规划思考/.test(t) && !continuing) return null;
  const state={...prefs,...patch};
  if(!state.experience) patch.experience=state.experience=urban&&!nature?'city':'balanced';
  if(!city) return {patch,reply:'可以把城区漫步与周边自然分开安排。想先规划哪座目的地城市？',sources:[]};
  const entry=DATA.destinations[city];
  let reply,sources=[];
  if(entry){
    const theme=state.nature_theme || 'mountains',chosen=entry.nature[theme] || entry.nature.mountains;
    reply=state.experience==='city'?entry.city:state.nature_theme
      ? '在'+city+'，自然部分先考虑'+chosen.name+'。'+chosen.reason+' '+chosen.tradeoff
      :nature && !urban?city+'的自然景点先比较山景和峡谷：Shymbulak 山地度假区偏重山景；恰伦峡谷偏重峡谷地貌。我建议优先山景方向，与城区游玩搭配，峡谷作为需要单独安排往返的备选。'
      : city+'可以按「城区漫步＋山景」来安排。'+entry.city+'自然部分我优先建议 '+entry.nature.mountains.name+'；如果更想看不同地貌，再考虑恰伦峡谷，单独留出往返交通。';
    sources=state.nature_theme?[chosen.source]:[entry.nature.mountains.source,entry.nature.canyon.source];
  } else if(/伊宁|伊犁/.test(city)){
    const theme=state.nature_theme==='forest'?'森林':state.nature_theme==='lake'?'湖泊':'雪山河谷';
    const a=sightCatalog().attractions.find(a=>a.theme===theme);
    reply='伊宁城区与伊犁自然景点可以分开安排。自然部分先比较'+a.name+'，看的是'+a.landscape+'；再决定是否加入另一种景观，避免来回跨区。';sources=[a.source];
  } else reply='在'+city+'，我建议先保留城区散步与当地生活，再选一处'+(THEMES[state.nature_theme] || '周边自然景点')+'作为重点，避免把多个远郊方向塞在一起。';
  if(state.destination_days) reply+='你给目的地留了'+state.destination_days+'天，可以据此拆分城区与自然的游玩时段，交通确认后再落到具体日期。';
  reply+=state.experience!=='city' && !state.nature_theme?'你更想看山景，还是峡谷？':!state.destination_days?'你准备在'+city+'留几天？':'这些玩法偏好已保留；可以继续告诉我想增加或删减的方向。';
  return {patch,reply,sources};
}
