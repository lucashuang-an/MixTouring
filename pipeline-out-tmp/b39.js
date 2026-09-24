export function buildCandidateSkeletons(o, d, constraints, llmHints = {}) {
  const degradations = [];
  const constraint_notes = [];
  const explorations = [];
  const intl = !isDomesticPair(o, d);
  const placeByName = (n) => loadPlaces().find((p) => p.name === n && p.kind === 'city');
  /* cities-geo 词典外顺路城市均为国内城市（geo-skill 为国内 179 城库）——骨架节点补国内属性，防误判跨境段 */
  const hubNode = (n) => placeByName(n) || { name: n, kind: 'city', country: 'CN', is_mainland: true };
  const candidates = [];

  /* 短距提示档（十五轮 P1-4：不做最优断言、不 gate 中转生成——中转是否生成由连接依据决定） */
  const oDist = [o.lat, o.lon, d.lat, d.lon].every((x) => x != null && !Number.isNaN(Number(x)))
    ? haversineKm(Number(o.lat), Number(o.lon), Number(d.lat), Number(d.lon)) : null;
  const shortHaul = !intl && oDist != null && oDist <= DIRECT_HINT_KM;

  const whysText = (whys) => whys.map((w) => w.text).join('；');

  /* ① 直达骨架：国内一张卡（方式未知待取证）；国际航班方向默认，铁路方向需正向依据（负向粗筛+走廊） */
  if (intl) {
    candidates.push({
      id: 'cand-direct-plane', kind: 'direct', variant: 'plane', hypothesis: true, transfers: 0, builder: 'rule',
      basis: { mode: 'plane', rule: 'intl-default', reason: '国际 OD 默认航班方向假设（是否成立待取证）' },
      legs: [newLeg(1, o, d, 'plane')],
      explanation: '假设存在直达航班：班期与价格待逐段取证，未取证前不做任何比较',
      why_explore: '直达航班是国际出行最直接的参照方案，先确认有无与大致价位，再判断中转是否值得',
      uncertain_leg: segUncertain(o, d),
      next_checks: ['查航司官网/平台该方向直达航班与当期价位', '若直达价位可接受，中转方案只在其明显更优时才值得继续查']
    });
    const rb = railDirectEligibility(o, d);
    if (rb.eligible) {
      candidates.push({
        id: 'cand-direct-rail', kind: 'direct', variant: 'rail', hypothesis: true, transfers: 0, builder: 'rule',
        basis: rb.basis,
        legs: [newLeg(1, o, d, 'rail')],
        explanation: '假设存在直达铁路方案：已有已知线路依据（详见 basis），班期、口岸衔接与是否直达待逐段取证，与航班假设并存供核验',
        why_explore: '该方向有已知铁路线路依据（见卡面来源），直达铁路在时间充裕时可能更省或体验不同',
        uncertain_leg: segUncertain(o, d),
        next_checks: ['核对该线路当期班期与购票渠道（见下方分地区入口）', '确认口岸/签证衔接要求']
      });
    } else if (rb.explore_hint) {
      explorations.push({
        type: 'land_rail',
        from: o.name, to: d.name,
        note: '地理距离在陆路可达量级，但无已知直达铁路线路或班期依据：可按「铁路/陆路方向」分段探索（例如先到铁路枢纽，再经陆路口岸或航班接驳）；取证到线路或班期后再生成直达假设',
        basis: rb.basis
      });
    } else {
      degradations.push('直达铁路假设未生成（负向粗筛，不凑固定卡数）：' + rb.basis.reason);
    }
  } else {
    candidates.push({
      id: 'cand-direct', kind: 'direct', hypothesis: true, transfers: 0, builder: 'rule',
      basis: { mode: 'unknown', rule: 'domestic-default', reason: '国内 OD 航空/铁路均可能，方式待取证确认' },
      legs: [newLeg(1, o, d, null)],
      explanation: '假设存在直达航班或直达列车：具体班期待逐段取证',
      why_explore: shortHaul
        ? '短距离行程：优先核查直达（经验判断，非最优断言）；中转方向仅在存在值得探索的依据时另行列出'
        : '直达是最直接的参照方案，先确认直达供给与价位，再判断中转/混合是否值得',
      uncertain_leg: segUncertain(o, d),
      next_checks: ['查直达航班与高铁班次供给', '记录直达价位作为比较基准']
    });
  }

  /* ②③ 中转/混合骨架：pickTransferHubs 依据驱动（段+方向绑定；依据与路段不一致时缺依据降级） */
  const picked = pickTransferHubs(o, d, llmHints, degradations);
  if (picked.one.name) {
    const hubPlace = hubNode(picked.one.name);
    /* 末段方式由可用依据 scope 决定（air→plane；rail→rail 且枢纽在中国大陆铁路网内） */
    const outMode = picked.one.outScope === 'rail' ? 'rail' : 'plane';
    const lastLeg = newLeg(2, hubPlace, d, outMode);
    candidates.push({
      id: 'cand-one-transfer',
      kind: 'one_transfer',
      hypothesis: true,
      transfers: 1,
      builder: picked.one.source,
      basis: { rule: picked.one.source === 'rule:hub' ? 'hub-network' : picked.one.source, whys: picked.one.whys },
      legs: [newLeg(1, o, hubPlace, null), lastLeg],
      explanation: '假设经「' + picked.one.name + '」一次中转：中转城市按' + (picked.one.source === 'rule:geo'
        ? '顺路约束内的枢纽作用与「枢纽→目的地」段连接依据筛选（确定性估算，非班期事实）'
        : picked.one.source === 'rule:hub'
          ? '枢纽作用与「枢纽→目的地」段连接依据筛选（依据见下，末段方式按可用连接选择）'
          : 'AI 从已收录城市中提名（待验证假设）') + '，两段班期与衔接余量待逐段取证',
      why_explore: whysText(picked.one.whys),
      uncertain_leg: segUncertain(o, hubPlace) + '；' + segUncertain(hubPlace, d),
      next_checks: ['核两段班期与衔接余量（末段按上方连接依据的渠道核对）', '与直达价位对比后再决定是否值得']
    });
  } else {
    degradations.push('一次中转骨架需要具备「枢纽→目的地」段连接依据的中转城市（顺路枢纽/方向枢纽/AI 提名），当前不可用：该骨架未生成');
  }
  const railEligible = o.country === 'CN' && o.is_mainland === true;
  if (picked.mixed.name && railEligible) {
    const hubPlace = hubNode(picked.mixed.name);
    candidates.push({
      id: 'cand-mixed',
      kind: 'mixed',
      hypothesis: true,
      transfers: 1,
      builder: picked.mixed.source,
      basis: { rule: picked.mixed.source === 'rule:hub' ? 'hub-network' : picked.mixed.source, whys: picked.mixed.whys },
      legs: [newLeg(1, o, hubPlace, 'rail'), newLeg(2, hubPlace, d, 'plane')],
      explanation: '假设先乘铁路到「' + picked.mixed.name + '」再飞往目的地的混合走法：中转城市按「起点→枢纽」铁路依据与「枢纽→目的地」航空依据分别筛选（依据见下），两段班期与衔接待逐段取证',
      why_explore: whysText(picked.mixed.whys),
      uncertain_leg: segUncertain(o, hubPlace) + '；' + segUncertain(hubPlace, d),
      next_checks: ['铁路段班次与耗时', '航空末段「' + hubPlace.name + ' → ' + d.name + '」班期（末段连接待查）', '两段衔接预留时间']
    });
  } else if (!railEligible) {
    degradations.push('混合交通骨架假设大陆铁路起段，当前出发地不适用：该骨架未生成');
  } else if (!picked.mixed.name) {
    degradations.push('混合交通骨架需要「起点→枢纽」铁路依据与「枢纽→目的地」航空依据双齐的中转城市，当前不可用：该骨架未生成');
  }

  /* 约束应用：换乘次数可直接校验（结构事实）；预算/中转时长/夜间到达需取证到数字或时刻才能评估——如实说明 */
  if (constraints.max_transfers != null) {
    const kept = candidates.filter((c2) => c2.transfers <= constraints.max_transfers);
    const dropped = candidates.filter((c2) => c2.transfers > constraints.max_transfers);
    if (dropped.length) {
      constraint_notes.push('已按「换乘 ≤ ' + constraints.max_transfers + ' 次」过滤：' +
        dropped.map((c2) => candidateTitle(c2)).join('、') + ' 骨架未展示');
    }
    candidates.length = 0;
    candidates.push(...kept);
  }
  if (constraints.budget_max_cny != null) constraint_notes.push('预算约束需取证到价格样本后才能评估，当前不做任何断言');
  if (constraints.max_layover_hours != null) constraint_notes.push('最长中转时长约束需取证到两段班期后才能校验衔接余量');
  if (constraints.night_arrival) constraint_notes.push('夜间到达约束需取证到段到达时刻后才能校验（骨架阶段无时刻）');

  return { candidates, degradations, constraint_notes, explorations };
}
