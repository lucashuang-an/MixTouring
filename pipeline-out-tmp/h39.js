/* ---------- G2.6（十四轮流转；v0.39.0 十六轮修订）：依据与路段/方向显式绑定 ----------
 * 连接依据两类（transfer-hubs.json）：{role:'hub'} 枢纽区位——只作「值得核查的方向」标注；
 * {scope, leg:'in'|'out', direction, note} 段连接依据——leg=in 支撑起点→枢纽段、out 支撑枢纽→目的地段，
 * 消费时按「段一致 + 目的方向匹配」过滤，方向不符不挂（十五轮 P1-2 的路段级收口）。
 * one_transfer 末段方式由可用的 out 依据 scope 决定（air→plane；rail 且枢纽可达→rail）；
 * 缺对应依据的骨架降为方向探索或不生成（不伪称支持具体路段）。 */

const HUB_DETOUR_MAX = 1.6; /* 与 geo-skill MAX_DETOUR_RATIO 同口径 */
export const DIRECT_HINT_KM = 1300; /* 国内短距提示档：直达卡文案提示优先核查直达（经验判断，不做最优断言、不 gate 中转生成） */

let HUBS = null;
function loadTransferHubs() {
  if (!HUBS) {
    try { HUBS = JSON.parse(readFileSync(join(ROOT, 'pipeline/data/transfer-hubs.json'), 'utf8')).hubs || []; }
    catch { HUBS = []; }
  }
  return HUBS;
}

function hubInfo(name) {
  return loadTransferHubs().find((h) => h.name === name) || null;
}

/** 目的方向匹配：连接 direction 与目的地国家码或名称互含即视为服务该方向。 */
function directionMatches(connDirection, d) {
  if (!connDirection) return false;
  const cd = String(connDirection);
  return cd === d.country || (d.name && (d.name.includes(cd) || cd.includes(d.name))) ||
    (d.country_name && d.country_name.includes(cd));
}

/** 段连接依据：leg（in=起点→枢纽 / out=枢纽→目的地）与目的方向均匹配才返回。 */
function hubLegWhys(name, leg, d) {
  const h = hubInfo(name);
  if (!h || !Array.isArray(h.connections)) return [];
  return h.connections
    .filter((c) => c && c.leg === leg && c.scope && c.note && directionMatches(c.direction, d))
    .map((c) => ({ scope: c.scope, leg: c.leg, direction: c.direction, text: c.note }));
}

/** 枢纽区位说明（role=hub）：只作「值得核查的方向」标注，不写成段依据。 */
function hubRoleNote(name) {
  const h = hubInfo(name);
  const r = h && Array.isArray(h.connections) ? h.connections.find((c) => c.role === 'hub') : null;
  return r ? r.note : null;
}

/** 枢纽绕行比（防明显反向绕行）：(o→hub + hub→d) / o→d；任一坐标缺失 → null（无法校验）。 */
function hubDetourRatio(o, d, hubName) {
  const h = loadPlaces().find((p) => p.name === hubName && p.kind === 'city');
  if (!h || [o.lat, o.lon, d.lat, d.lon, h.lat, h.lon].some((x) => x == null || Number.isNaN(Number(x)))) return null;
  const direct = haversineKm(Number(o.lat), Number(o.lon), Number(d.lat), Number(d.lon));
  if (!direct) return null;
  const via = haversineKm(Number(o.lat), Number(o.lon), Number(h.lat), Number(h.lon)) +
    haversineKm(Number(h.lat), Number(h.lon), Number(d.lat), Number(d.lon));
  return Math.round((via / direct) * 100) / 100;
}

/**
 * 中转点选择（v0.39.0 十六轮修订）：依据与路段/方向绑定。
 * 国内：geo 顺路内择「枢纽 + 段连接依据」（one_transfer 需 out 段 air/rail 依据且方向匹配目的地；
 * mixed 需 in 段 rail 依据 + out 段 air 依据且方向匹配）；
 * 国际：枢纽表 gateway_for 匹配 + 绕行比（out 段依据同理）；LLM 提名兜底（依据标注待查）。
 * 返回 { one: {name, source, outScope, whys}, mixed: {…}, degradations }。
 */
function pickTransferHubs(o, d, llmHints, degradations) {
  const one = { name: null, source: null, outScope: null, whys: [] };
  const mixed = { name: null, source: null, outScope: null, whys: [] };
  const fromCity = geoCityName(o);
  const toCity = geoCityName(d);
  const domesticGeo = isDomesticPair(o, d) && fromCity && toCity;

  if (domesticGeo) {
    const airHubs = candidatesBetween(fromCity, toCity, { mode: 'plane' });
    const railAirHubs = candidatesBetween(fromCity, toCity, { mode: 'train' }).filter((h) => h.has_airport);
    /* one_transfer：优先枢纽表 out 段依据（方向匹配目的地）；rail 依据要求枢纽在大陆铁路网内（rail 末段） */
    for (const cand of airHubs) {
      const airW = hubLegWhys(cand.name, 'out', d).filter((w) => w.scope === 'air');
      const railW = hubLegWhys(cand.name, 'out', d).filter((w) => w.scope === 'rail');
      const hubCn = loadPlaces().some((p) => p.name === cand.name && p.country === 'CN' && p.is_mainland === true);
      if (airW.length || (railW.length && hubCn)) {
        one.name = cand.name; one.source = 'rule:geo';
        one.outScope = airW.length ? 'air' : 'rail';
        one.whys.push({ scope: 'geo', leg: null, direction: null, text: '地理顺路窗口内的枢纽城市（绕行比受控的确定性估算）' },
          ...(airW.length ? airW : railW).map((w) => ({ ...w })));
        break;
      }
    }
    /* mixed：in 段 rail 依据 + out 段 air 依据（方向匹配），缺一不产 */
    for (const cand of railAirHubs) {
      if (cand.name === one.name) continue;
      const inW = hubLegWhys(cand.name, 'in', d).filter((w) => w.scope === 'rail' || w.scope === 'general');
      const outW = hubLegWhys(cand.name, 'out', d).filter((w) => w.scope === 'air');
      if (inW.length && outW.length) {
        mixed.name = cand.name; mixed.source = 'rule:geo'; mixed.outScope = 'air';
        mixed.whys.push({ scope: 'geo', leg: null, direction: null, text: '顺路且铁路与航空双可达的枢纽城市（确定性估算）' },
          ...inW.map((w) => ({ ...w, leg: 'in' })), ...outW.map((w) => ({ ...w, leg: 'out' })));
        break;
      }
    }
  }

  /* 国际：枢纽表 gateway_for 匹配（含绕行比校验），out 段依据按方向分域取用 */
  if (!one.name || !mixed.name) {
    const destKey = d.country || '';
    const cands = loadTransferHubs()
      .filter((h) => h.gateway_for.some((g) => g === destKey || (d.country_name && d.country_name.includes(g))))
      .map((h) => ({ h, ratio: hubDetourRatio(o, d, h.name) }))
      .filter((x) => x.ratio != null && x.ratio <= HUB_DETOUR_MAX)
      .sort((a, b) => a.ratio - b.ratio);
    for (const best of cands) {
      const name = best.h.name;
      const railCn = loadPlaces().some((p) => p.name === name && p.country === 'CN' && p.is_mainland === true);
      const airW = hubLegWhys(name, 'out', d).filter((w) => w.scope === 'air');
      const railW = hubLegWhys(name, 'out', d).filter((w) => w.scope === 'rail');
      const roleNote = hubRoleNote(name);
      if (!one.name && (airW.length || (railW.length && railCn))) {
        one.name = name; one.source = 'rule:hub';
        one.outScope = airW.length ? 'air' : 'rail';
        one.whys.push({ scope: 'geo', leg: null, direction: null, text: roleNote || '该方向枢纽（值得核查）' },
          ...(airW.length ? airW : railW).map((w) => ({ ...w })));
      }
      if (!mixed.name && railCn) {
        const inW = hubLegWhys(name, 'in', d).filter((w) => w.scope === 'rail' || w.scope === 'general');
        const outAir = hubLegWhys(name, 'out', d).filter((w) => w.scope === 'air');
        if (inW.length && outAir.length) {
          mixed.name = name; mixed.source = 'rule:hub'; mixed.outScope = 'air';
          mixed.whys.push({ scope: 'geo', leg: null, direction: null, text: roleNote || '该方向枢纽（值得核查）' },
            ...inW.map((w) => ({ ...w, leg: 'in' })), ...outAir.map((w) => ({ ...w, leg: 'out' })));
        }
      }
      if (one.name && mixed.name) break;
    }
  }

  /* LLM 提名兜底（清单校验 + 绕行比校验在消费点） */
  const citySet = new Set(loadPlaces().filter((p) => p.kind === 'city').map((p) => p.name));
  const llmOk = (n) => n && citySet.has(n) && n !== o.name && n !== d.name;
  if (!one.name && llmOk(llmHints.one_transfer_city)) {
    one.name = llmHints.one_transfer_city; one.source = 'llm'; one.outScope = 'air';
    one.whys.push({ scope: 'llm', leg: null, direction: null, text: '由 AI 从已收录城市中提名（待验证假设，段连接依据待查）' });
  }
  if (!mixed.name && llmOk(llmHints.mixed_rail_city)) {
    mixed.name = llmHints.mixed_rail_city; mixed.source = 'llm'; mixed.outScope = 'air';
    mixed.whys.push({ scope: 'llm', leg: null, direction: null, text: '由 AI 从已收录城市中提名（待验证假设，段连接依据待查）' });
  }

  /* 防反向：任何来源的枢纽都过绕行比（能算则算） */
  for (const slot of [one, mixed]) {
    if (!slot.name) continue;
    const ratio = hubDetourRatio(o, d, slot.name);
    if (ratio != null && ratio > HUB_DETOUR_MAX) {
      degradations.push('中转城市「' + slot.name + '」绕行比 ' + ratio + ' 超过 ' + HUB_DETOUR_MAX + '（明显反向绕行）：该骨架未生成');
      slot.name = null; slot.source = null; slot.outScope = null; slot.whys = [];
    }
  }
  return { one, mixed };
}

/** 段级不确定性；多段卡无依据比较哪段更不确定时，两段并列待查（十五轮附注）。 */
function legUncertain(fromName, toName, crossBorder) {
  const suffix = crossBorder ? '（跨境：班期、口岸/签证衔接均未核验）' : '（班期未核验）';
  return fromName + ' → ' + toName + suffix;
}

/** 逐段跨境判定（十六轮 P2：任一段跨境只标该段自身，不标记到其它段）。 */
function segUncertain(a, b) {
  return legUncertain(a.name, b.name, a.country !== b.country);
}
