/* G3 探索行程详情：只消费服务端本次规划的候选，不把浏览器传来的路线当事实。 */
import { randomBytes } from 'node:crypto';
import { buildCandidateSkeletons, resolvePlace } from './anywhere.mjs';

const plans = new Map();
const TTL_MS = 30 * 60 * 1000;
const MAX_PLANS = 200;

export function registerJourneyPlan(plan, now = Date.now()) {
  for (const [id, entry] of plans) if (entry.expires_at <= now) plans.delete(id);
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
  const id = 'jpl_' + randomBytes(12).toString('hex');
  plans.set(id, { plan, expires_at: now + TTL_MS });
  return id;
}

function checklistRow(leg, direction, plan) {
  const countryOf = (name) => {
    if (name === plan.intent.origin_place?.name) return plan.intent.origin_place.country;
    if (name === plan.intent.destination_place?.name) return plan.intent.destination_place.country;
    return resolvePlace(name)?.country || null;
  };
  const fromCountry = countryOf(leg.from), toCountry = countryOf(leg.to);
  const missing = ['指定日期班次与当地起落时间', '当期价格及行李／退改口径', '站点接驳'];
  if (fromCountry && toCountry && fromCountry !== toCountry) missing.push('出入境条件');
  return {
    direction,
    segment: `${leg.from} → ${leg.to}`,
    mode_guess: leg.mode_guess || null,
    evidence_state: leg.evidence_state || 'explore',
    search_leads: leg.evidence_state === 'source_lead' ? (leg.sources || []) : [],
    missing,
    manual_check: leg.manual_check || '到原平台逐段核对'
  };
}

/** 返回完整的探索结构；没有逐段证据时，时间和费用保持未知。 */
export function buildJourneyDetail(plan, candidateId, stopoverNights = 0) {
  if (!plan || !plan.intent || !Array.isArray(plan.candidates)) throw new Error('规划已失效，请重新规划');
  const nights = Number(stopoverNights);
  if (![0, 1, 2].includes(nights)) throw new Error('停留仅支持不安排、1 晚或 2 晚');
  const candidate = plan.candidates.find((c) => c.id === candidateId);
  if (!candidate) throw new Error('走法不在本次规划中，请重新选择');
  const outbound = candidate.legs.map((leg) => ({ ...leg }));
  const stopCity = candidate.kind !== 'direct' && outbound.length === 2 ? outbound[0].to : null;
  if (nights && !stopCity) throw new Error('这条走法没有中途城市，无法安排停留');

  const roundTrip = plan.intent.trip_type === 'round_trip';
  let inbound = [];
  if (roundTrip) {
    const reverse = buildCandidateSkeletons(plan.intent.destination_place, plan.intent.origin_place, { max_transfers: 0 }, {});
    const returnHypothesis = reverse.candidates.find((c) => c.kind === 'direct');
    inbound = returnHypothesis ? returnHypothesis.legs.map((leg) => ({ ...leg })) : [];
  }
  const checklist = [
    ...outbound.map((leg) => checklistRow(leg, 'outbound', plan)),
    ...inbound.map((leg) => checklistRow(leg, 'inbound', plan))
  ];
  const unknownCosts = ['去程各段当期交通费用', '行李、退改与站点接驳费用'];
  if (roundTrip) unknownCosts.push('返程当期交通费用（须独立核查）');
  if (nights) unknownCosts.push(`${stopCity}停留 ${nights} 晚的单人住宿及当地接驳费用`);

  return {
    candidate_id: candidate.id,
    candidate_kind: candidate.kind,
    evidence_state: 'explore',
    trip_type: plan.intent.trip_type,
    outbound_window: plan.intent.outbound_window || null,
    return_window: roundTrip ? plan.intent.return_window || null : null,
    traveler_count: plan.intent.traveler_count || 1,
    outbound,
    inbound,
    return_note: roundTrip
      ? '返程为按相反出行方向独立生成的探索假设；未取得返程班期，不以去程班次反转充当返程证据。'
      : null,
    stopover: nights ? { city: stopCity, nights, scheduling_state: '待两段当地班期核实', accommodation_cost: null } : null,
    cost: { known_total: null, unknown_items: unknownCosts },
    checklist,
    warnings: [
      '本详情只是完整路线结构的探索草案，所有段的指定日期班期、衔接和价格均待核验。',
      ...(nights ? ['停留会占用旅行时间；后半程、住宿及返程需核实后才能判断是否成行和增加多少费用。'] : []),
      ...(roundTrip && !plan.intent.return_window ? ['返程日期窗口尚未填写，请补全后再核对返程。'] : [])
    ]
  };
}

export function journeyDetailFromPlanId(planId, candidateId, stopoverNights = 0, now = Date.now()) {
  const entry = plans.get(planId);
  if (!entry || entry.expires_at <= now) {
    if (entry) plans.delete(planId);
    throw new Error('规划已失效，请重新规划');
  }
  return buildJourneyDetail(entry.plan, candidateId, stopoverNights);
}
