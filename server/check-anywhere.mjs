/* check-anywhere.mjs · G2.5 任意地点规划确定性测试（v0.31.0 · 模式同 check-trip.mjs，纯函数无服务依赖）
 * 纪律：本文件不读 server/.env、不联网——LLM、OSM 核验、searchWeb 一律注入桩；真模型路径由有 key 环境冒烟。
 * 反例来源：Issue #5 对 8685a56 的需修复结论（P0-1 开放地点解析四验收场景、P0-2 相关性门槛、
 * P1-3 国际直达多方式）+ v0.30.0 冒烟实测缺陷（机场别名误拆、geo 中转城市静默丢弃、清单外提名）。
 * 运行：node server/check-anywhere.mjs */

import {
  resolvePlace, scanPlaceMentions, extractConstraints, constraintChips,
  buildCandidateSkeletons, verifyLegs, planAnywhere, resultRelevance,
  registerPlaceCandidate, takePlaceCandidate, railDirectEligibility, corridorEffectiveStatus, isValidWindow, buildTravelIntent, RAIL_DIRECT_MAX_KM,
  osmKind, KIND_LABEL
} from './lib/anywhere.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let fail = 0;
let total = 0;
const ok = (cond, name) => { total++; if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

const NO_LLM = { callJson: async () => null, env: {}, osmSearch: async () => [] };
const NO_DIGIT_RE = /\d/;

/* ---------- PlaceResolver：精确名 / 别名 / 类型 / 大小写 ---------- */
{
  ok(resolvePlace('北京')?.kind === 'city' && resolvePlace('北京')?.matched_via === 'name', 'resolvePlace：精确城市名');
  ok(resolvePlace('PEK')?.name === '北京首都国际机场' && resolvePlace('PEK')?.kind === 'airport', 'resolvePlace：IATA 别名 → 机场');
  ok(resolvePlace('pek')?.name === '北京首都国际机场', 'resolvePlace：拉丁别名不区分大小写');
  ok(resolvePlace('首都机场')?.city === '北京', 'resolvePlace：中文别名 + 就近城市归属');
  ok(resolvePlace('北京南站')?.kind === 'station', 'resolvePlace：车站 kind');
  ok(resolvePlace('故宫')?.kind === 'poi' && resolvePlace('紫禁城')?.name === '故宫', 'resolvePlace：景点及别名');
  ok(resolvePlace('Almaty')?.country === 'KZ' && resolvePlace('Almaty')?.is_mainland === false, 'resolvePlace：英文别名 → 国际城市');
  ok(resolvePlace('喀纳斯')?.city == null, 'resolvePlace：无就近已收录城市的景点 city=null（不猜）');
  ok(resolvePlace('塔什干') === null && resolvePlace('') === null, 'resolvePlace：未收录/空 → null（进入开放解析而非直接编造）');
  const p = resolvePlace('上海');
  p.name = '被篡改';
  ok(resolvePlace('上海')?.name === '上海', 'resolvePlace：返回浅拷贝，缓存词典不被污染');
}

/* ---------- 一句话扫描：最长优先 + 相邻冲突（冒烟反例：北京首都机场 解析成 北京） ---------- */
{
  const s1 = scanPlaceMentions('从北京首都机场去喀纳斯');
  ok(s1.length === 2 && s1[0].place.name === '北京首都国际机场' && s1[1].place.name === '喀纳斯',
    '扫描：机场别名整段命中，「北京」不再单独成提及');
  const s2 = scanPlaceMentions('10月1日从北京去阿拉木图');
  ok(s2.map((x) => x.place.name).join(',') === '北京,阿拉木图', '扫描：常规城市 OD 按出现顺序');
  const s3 = scanPlaceMentions('PEK to ALA');
  ok(s3.length === 2 && s3[0].place.name === '北京首都国际机场' && s3[1].place.name === '阿拉木图国际机场',
    '扫描：拉丁 IATA 大小写不敏感（PEK/ALA）');
  ok(scanPlaceMentions('今天天气不错').length === 0, '扫描：无地点提及 → 空');
}

/* ---------- 约束提取（数字只来自用户输入） ---------- */
{
  const c = extractConstraints('预算3000元以内，中转不超过8小时，不接受夜间到达，最多换乘1次');
  ok(c.budget_max_cny === 3000 && c.max_layover_hours === 8 && c.night_arrival === 'avoid' && c.max_transfers === 1,
    '约束：预算/中转时长/夜间到达/换乘次数四项全提取');
  ok(extractConstraints('红眼航班也行，可以半夜到').night_arrival === 'allow', '约束：夜间到达 allow 表述');
  ok(extractConstraints('不想换乘').max_transfers === 0, '约束：「不想换乘」→ 0 次');
  ok(extractConstraints('国庆从北京去喀什').budget_max_cny === undefined && !('night_arrival' in extractConstraints('国庆从北京去喀什')),
    '约束：无约束表述 → 不出现字段（不猜）');
  ok(constraintChips(c).length === 4, 'chips：四项齐备（数字仅来自用户输入值）');
  ok(extractConstraints('10月1日出发').max_layover_hours === undefined, '约束：日期数字不误判为中转时长');
}

/* ---------- CandidateBuilder：三类骨架（geo 路径，确定性） ---------- */
{
  const o = resolvePlace('北京'), d = resolvePlace('喀什');
  const { candidates, degradations, constraint_notes } = buildCandidateSkeletons(o, d, {}, {});
  ok(candidates.length === 3 && candidates.map((c) => c.kind).join(',') === 'direct,one_transfer,mixed',
    '骨架：国内 OD（两端 geo 覆盖）出全三类，顺序直达/一次中转/混合交通');
  const one = candidates.find((c) => c.kind === 'one_transfer');
  ok(one.builder === 'rule:geo' && one.transfers === 1 && one.legs.length === 2 && one.legs[0].to === one.legs[1].from,
    '骨架：一次中转两段首尾相接，builder=rule:geo');
  const mixed = candidates.find((c) => c.kind === 'mixed');
  ok(mixed.legs[0].mode_guess === 'rail' && mixed.legs[1].mode_guess === 'plane', '骨架：混合交通 = 铁路段 + 航空段');
  ok(candidates.every((c) => c.hypothesis === true), '骨架：全部 candidate_hypothesis（待验证假设）');
  ok(candidates.every((c) => NO_DIGIT_RE.test(c.explanation) === false), '骨架：explanation 零数字（防幻觉）');
  ok(candidates.every((c) => c.legs.every((l) => l.evidence_state === 'explore' && l.sources.length === 0)),
    '骨架：初始全部段探索态、无来源');
  ok(!JSON.stringify(candidates).includes('"price"'), '骨架：不含任何价格字段');
  ok(degradations.length === 0 && constraint_notes.length === 0, '骨架：geo 路径无降级无约束备注');

  const f = buildCandidateSkeletons(o, d, { max_transfers: 0 }, {});
  ok(f.candidates.length === 1 && f.candidates[0].kind === 'direct' &&
    f.constraint_notes.some((n) => n.includes('一次中转、混合交通')), '约束：换乘 ≤ 0 次过滤掉两类中转骨架并如实备注');

  /* P1-2（八轮）：直达铁路 = 负向粗筛 + 正向依据（已知走廊） */
  const hkg = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('香港'), {}, {});
  const hkgDirects = hkg.candidates.filter((c) => c.kind === 'direct');
  ok(hkgDirects.length === 2 && hkgDirects.some((c) => c.variant === 'plane') && hkgDirects.some((c) => c.variant === 'rail'),
    'P1-2：北京→香港保留航班+铁路双直达（走廊依据：京港高铁）');
  ok(hkgDirects.find((c) => c.variant === 'rail').basis.rule === 'known-corridor' &&
    hkgDirects.find((c) => c.variant === 'rail').basis.within_km <= RAIL_DIRECT_MAX_KM,
    'P1-2：铁路卡 basis=known-corridor 且记录距离阈值（机器可读依据）');
  ok(hkgDirects.every((c) => c.basis && typeof c.basis === 'object' && c.basis.rule),
    'P1-2：直达卡全部带机器可读 basis');

  /* 旗标误伤修复：台北—高雄同区内部铁路（台湾高铁走廊）不受 no_direct_rail 影响 */
  const twRoute = buildCandidateSkeletons(resolvePlace('台北'), resolvePlace('高雄'), {}, {});
  const twRail = twRoute.candidates.find((c) => c.variant === 'rail');
  ok(!!twRail && twRail.basis.rule === 'known-corridor',
    'P1-2 修复：台北—高雄生成直达铁路卡（走廊依据台湾高铁；旗标仅约束跨境场景）');

  const nyc = { name: '纽约', kind: 'city', country: 'US', is_mainland: false, lat: '40.71', lon: '-74.01' };
  const nycR = railDirectEligibility(resolvePlace('北京'), nyc);
  const nycBuilt = buildCandidateSkeletons(resolvePlace('北京'), nyc, {}, {});
  ok(nycR.eligible === false && nycR.explore_hint === false &&
    nycBuilt.candidates.every((c) => c.variant !== 'rail') && nycBuilt.explorations.length === 0 &&
    nycBuilt.degradations.some((x) => x.includes('直达铁路假设未生成')),
    'P1-2 反例：北京→纽约（跨洋）负向粗筛 veto，无铁路卡也无探索提示');

  const tpe = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('台北'), {}, {});
  ok(tpe.candidates.every((c) => c.variant !== 'rail') && tpe.explorations.length === 0 &&
    tpe.degradations.some((x) => x.includes('无跨境陆路铁路连接')),
    'P1-2 反例：北京→台北（跨境 + 岛域旗标）不生成铁路卡');

  /* 八轮核心反例：北京→阿拉木图距离可过，但无直达铁路依据 → 不出卡，转铁路/陆路方向探索 */
  const alm = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('阿拉木图'), {}, {});
  ok(alm.candidates.every((c) => c.variant !== 'rail') && alm.candidates.some((c) => c.variant === 'plane'),
    'P1-2 反例：北京→阿拉木图仅凭距离不生成直达铁路卡');
  ok(alm.explorations.length === 1 && alm.explorations[0].type === 'land_rail' &&
    alm.explorations[0].basis.rule === 'geo-plausible-only',
    'P1-2：北京→阿拉木图降为「铁路/陆路方向探索」（地理可能但无服务依据，不出假设卡）');

  const urumqiAlma = buildCandidateSkeletons(resolvePlace('乌鲁木齐'), resolvePlace('阿拉木图'), {}, {});
  ok(urumqiAlma.candidates.some((c) => c.variant === 'rail' &&
    c.basis.evidence_grade === 'historical_schedule_sample'),
    'P1（十轮）：乌鲁木齐→阿拉木图走廊降为历史班期样例分级（K9795 属历史参考，不再标结构化班期证据），铁路卡仍生成');

  /* P2（九轮+十轮）：走廊种子结构化来源治理——字段齐备 + 分级 + 复核期限语义 + 过期降级 */
  const corridors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline/data/rail-corridors.json'), 'utf8')).corridors;
  ok(corridors.length >= 3 && corridors.every((c) =>
    c.a && c.b && c.note && c.evidence &&
    ['public_line_knowledge', 'historical_schedule_sample'].includes(c.evidence_grade) &&
    typeof c.source_url === 'string' && /^https:/.test(c.source_url) &&
    /^\d{4}-\d{2}-\d{2}$/.test(c.sampled_at || '') &&
    c.status === 'verified_knowledge' &&
    /^\d{4}-\d{2}-\d{2}$/.test(c.review_by || '') && c.review_by >= c.sampled_at &&
    c.valid_for === undefined),
    'P2（十轮）：走廊字段齐备且语义准确——review_by 复核期限（valid_for 已移除）、K9795 为历史班期样例分级');
  const railCard = urumqiAlma.candidates.find((c) => c.variant === 'rail');
  ok(railCard.basis.source_url && /^https:/.test(railCard.basis.source_url) && railCard.basis.sampled_at &&
    railCard.basis.review_by && railCard.basis.evidence_grade === 'historical_schedule_sample',
    'P2：铁路卡 basis 带来源字段与复核期限（页面明示复核期限非运营有效期；仍是假设依据）');
  const exp = { a: '北京', b: '香港', note: '测试走廊', evidence: '公开线路常识', evidence_grade: 'public_line_knowledge', source_url: 'https://example.com/rail', sampled_at: '2026-09-22', status: 'verified_knowledge', review_by: '2026-10-01' };
  ok(corridorEffectiveStatus(exp, Date.parse('2026-09-25')) === 'verified_knowledge' &&
    corridorEffectiveStatus(exp, Date.parse('2026-10-02')) === 'expired',
    'P2：corridorEffectiveStatus 按 review_by 日界判定（10-01 有效、10-02 过期）');
  const expR = railDirectEligibility(resolvePlace('北京'), resolvePlace('香港'), { nowMs: Date.parse('2026-10-02T00:00:00Z'), corridors: [exp] });
  ok(expR.eligible === false && expR.explore_hint === true && expR.basis.rule === 'corridor-expired' && expR.reason.includes('过期'),
    'P2 反例：走廊过期 → 只降为铁路/陆路方向探索（railDirectEligibility 层；真实走廊未过期不受影响）');
  ok(buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('香港'), {}, {})
    .candidates.some((c) => c.variant === 'rail'),
    'P2：真实数据走廊（valid_for 未过）铁路卡正常生成');
  const badStatus = { ...exp, status: 'disputed' };
  ok(corridorEffectiveStatus(badStatus) === 'disputed' &&
    railDirectEligibility(resolvePlace('北京'), resolvePlace('香港'), { corridors: [badStatus] }).explore_hint === true,
    'P2 反例：走廊状态异常（非 verified_knowledge）→ 降为探索');

  const noCoord = railDirectEligibility(resolvePlace('北京'), { name: 'X', kind: 'city', country: 'US' });
  ok(noCoord.eligible === false && noCoord.explore_hint === false && noCoord.basis.reason.includes('坐标缺失'),
    'P1-2：坐标缺失 → veto 不生成（宁缺勿凑）');

  /* P2：铁路核对入口按地区适配（经走廊 OD 验证国际段） */
  const ktzRailLeg = urumqiAlma.candidates.find((c) => c.variant === 'rail').legs[0];
  ok(ktzRailLeg.manual_check.includes('哈萨克斯坦国家铁路（KTZ）') && !ktzRailLeg.manual_check.startsWith('到 12306'),
    'P2：乌鲁木齐→阿拉木图铁路核对入口指向 KTZ（不再统一 12306）');
  const domRailLeg = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('喀什'), {}, {})
    .candidates.find((c) => c.kind === 'mixed').legs[0];
  ok(domRailLeg.manual_check.includes('12306'), 'P2：国内铁路段（混合骨架北京→大同）仍指向 12306');

  /* 国际 OD 无 LLM（G2.6）：北京→阿拉木图凭枢纽表出可解释中转——直达航班 + 枢纽中转 + 枢纽混合 + 陆路探索 */
  const intl = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('阿拉木图'), {}, {});
  ok(intl.candidates.length === 3 && intl.candidates[0].variant === 'plane' &&
    intl.candidates.filter((c) => c.builder === 'rule:hub').length === 2 &&
    intl.candidates.every((c) => c.why_explore && c.uncertain_leg && c.next_checks.length >= 1),
    'G2.6：北京→阿拉木图无 LLM 仍出枢纽中转（乌鲁木齐，builder=rule:hub）且三件套齐备');
  /* 十六轮 P1-1：依据与路段/方向绑定——mixed 卡 whys 不含 rail 锚点（K 锚点属枢纽之后跨境铁路方向，
   * 不属于「北京→乌鲁木齐 rail + 乌鲁木齐→阿拉木图 air」任一段）；out 段为 KZ 航空依据、in 段分离 */
  const almMixed = intl.candidates.find((c) => c.kind === 'mixed');
  ok(almMixed && almMixed.basis.whys.some((w) => w.leg === 'out' && w.direction === 'KZ' && w.scope === 'air') &&
    almMixed.basis.whys.some((w) => w.leg === 'in') &&
    almMixed.basis.whys.every((w) => w.scope !== 'rail'),
    'P1（十六轮）：混合卡依据按段/方向绑定——out 段为 KZ 航空依据、in 段分离，rail 锚点不进混合卡（评审反例）');
  /* 十六轮 P2：反向跨境行程逐段判定 */
  const revHk = buildCandidateSkeletons(resolvePlace('香港'), resolvePlace('北京'), {}, { one_transfer_city: '广州' });
  const revOne = revHk.candidates.find((c) => c.kind === 'one_transfer');
  ok(revOne && revOne.uncertain_leg.includes('香港 → 广州（跨境') && revOne.uncertain_leg.includes('广州 → 北京（班期未核验）'),
    'P2（十六轮）：反向跨境行程逐段判定（香港→广州跨境、广州→北京非跨境）');
  ok(intl.candidates.find((c) => c.kind === 'one_transfer').legs[1].from === '乌鲁木齐' &&
    intl.candidates.find((c) => c.kind === 'one_transfer').why_explore.includes('乌鲁木齐→哈萨克斯坦方向'),
    'G2.6：中转枢纽=乌鲁木齐（gateway KZ），依据明示「枢纽→目的地」段方向（十六轮：路段级绑定）');
  ok(intl.explorations.length === 1, 'G2.6：无走廊依据仍只有陆路探索（直达铁路不凭枢纽生成）');

  /* LLM 提名：枢纽命中后 LLM 不再顶替（更优来源优先）；清单外丢弃；无枢纽匹配时 LLM 兜底生效 */
  const hint = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('阿拉木图'), {}, { one_transfer_city: '西安', mixed_rail_city: '西安' });
  ok(hint.candidates.find((c) => c.kind === 'one_transfer').builder === 'rule:hub',
    'G2.6：枢纽匹配优先于 LLM 提名（确定性来源优先）');
  const llmFallback = buildCandidateSkeletons(resolvePlace('北京'), { name: '塔什干', kind: 'city', country: 'UZ', is_mainland: false, lat: '41.31', lon: '69.28' }, {}, { one_transfer_city: '乌鲁木齐', mixed_rail_city: '乌鲁木齐' });
  ok(llmFallback.candidates.filter((c) => c.builder === 'llm').length === 2,
    'G2.6：无枢纽匹配（UZ）时 LLM 清单内提名兜底生效并标注 builder=llm');
  const bad = buildCandidateSkeletons(resolvePlace('北京'), { name: '塔什干', kind: 'city', country: 'UZ', is_mainland: false, lat: '41.31', lon: '69.28' }, {}, { one_transfer_city: '火星', mixed_rail_city: '伊斯坦布尔' });
  ok(bad.candidates.every((c) => c.builder !== 'llm') &&
    bad.degradations.filter((x) => x.includes('骨架未生成')).length >= 2,
    '骨架：LLM 清单外提名被丢弃（不造地名，无依据骨架不生成）');

  /* 反向绕行反例：gateway_for 匹配但绕行比超标的枢纽不生成 */
  const revOk = buildCandidateSkeletons(resolvePlace('北京'), { name: '阿拉木图', kind: 'city', country: 'KZ', is_mainland: false, lat: '43.24', lon: '76.89' }, {}, {});
  ok(revOk.candidates.find((c) => c.kind === 'one_transfer')?.legs[1].from === '乌鲁木齐',
    'G2.6 回归：正常绕行比（乌鲁木齐 ≈ 0.98）枢纽通过');

  /* 出发地非大陆：混合骨架不生成（铁路起段假设不成立）；香港→阿拉木图枢纽中转仍出 */
  const hk = buildCandidateSkeletons(resolvePlace('香港'), resolvePlace('阿拉木图'), {}, {});
  ok(hk.candidates.map((c) => c.id).join(',') === 'cand-direct-plane,cand-one-transfer' &&
    hk.degradations.some((x) => x.includes('大陆铁路起段')) &&
    hk.explorations.length === 1,
    '骨架：非大陆出发地不出混合骨架并说明；无走廊依据只有陆路探索');

  /* G2.6：国内短距直达合适 → 只出直达，不凑中转 */
  const short = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('上海'), {}, {});
  ok(short.candidates.length === 1 && short.candidates[0].kind === 'direct' &&
    short.candidates[0].why_explore.includes('优先核查直达') && !short.candidates[0].why_explore.includes('是最优'),
    'G2.6（十五轮）：北京→上海只出直达卡，直达文案为优先核查而非最优断言（十五轮回归，v0.39.0 中转由依据驱动）');
  const gzLhasa = buildCandidateSkeletons(resolvePlace('广州'), resolvePlace('拉萨'), {}, {});
  const gzOne = gzLhasa.candidates.find((c) => c.kind === 'one_transfer');
  ok(gzOne && gzOne.legs[1].from === '成都' && gzOne.why_explore.includes('成都→拉萨方向'),
    'G2.6（十五轮）：广州→拉萨中转选成都（方向匹配枢纽，非绕行最小首位柳州），依据明示成都→拉萨段方向');
  const almOne = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('阿拉木图'), {}, {}).candidates.find((c) => c.kind === 'one_transfer');
  ok(almOne && almOne.legs[1].from === '乌鲁木齐' && !almOne.why_explore.includes('班期锚点'),
    'G2.6（十五轮）：阿拉木图航空末段卡的依据不含铁路锚点（分域：rail 依据只挂铁路方向）');
  const lhasa = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('拉萨'), {}, {});
  ok(lhasa.candidates.length === 3 && lhasa.candidates.filter((c) => c.kind !== 'direct').length === 2,
    'G2.6：北京→拉萨（长距）保留中转/混合方向（正向案例）');
}

/* ---------- 搜索线索分层（P0-2：相关性门槛 + source_lead ≠ 取证） ---------- */
{
  const leg = { from: '北京', to: '阿拉木图', mode_guess: 'plane' };
  const rel1 = resultRelevance({ title: '北京至阿拉木图直飞航线复航', content: '' }, leg);
  ok(rel1.from_hit && rel1.to_hit && rel1.mode_hit, '相关性：命中两端+方式 → 相关');
  const rel2 = resultRelevance({ title: '限时优惠大促', content: '与本段行程无关的内容' }, leg);
  ok(!(rel2.from_hit && rel2.to_hit), 'P0-2 反例：无关 HTTPS 结果不满足两端命中 → 不升级（仍为 explore）');

  const o = resolvePlace('北京'), d = resolvePlace('喀什');
  const built = buildCandidateSkeletons(o, d, {}, {});
  let calls = 0;
  const queries = [];
  const stat = await verifyLegs(built.candidates, async (q) => {
    calls++; queries.push(q);
    /* 相关结果（覆盖全部段的两端与方式词）+ 一条无关 https 干扰项 */
    return [
      { title: '北京 喀什 乌鲁木齐 航班 火车 铁路 高铁 攻略', link: 'https://example.com/a', content: '北京 乌鲁木齐 喀什 航班 火车' },
      { title: '无关促销页', link: 'https://example.com/seo', content: '双十一' },
      { title: '非https丢弃', link: 'http://x.com/b', content: '北京 喀什 航班' }
    ];
  });
  const legs = built.candidates.flatMap((c) => c.legs);
  ok(legs.every((l) => l.evidence_state === 'source_lead' && l.sources.length === 1 && l.sources[0].link.startsWith('https:')),
    '取证→线索：相关 https 来源升级 source_lead；无关与 http 来源被拒');
  ok(legs.every((l) => l.lead_query && l.lead_query.includes(l.from) && l.lead_query.includes(l.to) && l.sources[0].relevance),
    '线索：记录查询词与逐源相关性判定');
  ok(legs.every((l) => !l.evidence_note.includes('核验通过') && l.evidence_note.includes('非班期核验')),
    '线索：文案明确「非班期核验」（不称取证）');
  ok(new Set(queries).size === queries.length, '线索：相同查询不重复发起（缓存去重）');
  ok(stat.leads === legs.length, '线索：全部段获得线索');

  const built2 = buildCandidateSkeletons(o, d, {}, {});
  await verifyLegs(built2.candidates, async () => [{ title: '完全无关', link: 'https://e.com/x' }]);
  ok(built2.candidates.flatMap((c) => c.legs).every((l) => l.evidence_state === 'explore' && l.sources.length === 0),
    'P0-2 反例：合法 HTTPS 但内容无关 → 保持探索态（不伪造线索）');
  await verifyLegs(built2.candidates, null);
  ok(true, '线索：无 searchFn 时安全跳过');
}

/* ---------- 开放地点解析（P0-1：安全两阶段四验收场景） ---------- */
{
  const osmTashkent = [{
    display_name: '塔什干, 乌兹别克斯坦', country: 'UZ', lat: '41.31', lon: '69.28',
    type: 'city', category: 'place', osm_type: 'relation', osm_id: '2369842',
    url: 'https://www.openstreetmap.org/relation/2369842'
  }];

  /* 场景1：北京→塔什干——不预写 JSON，形成待确认地点候选 */
  const r1 = await planAnywhere({ origin: '北京', destination: '塔什干' }, {
    callJson: async (opts) => String(opts.user).includes('地点表述')
      ? { candidates: [{ name: '塔什干', name_latin: 'Tashkent', kind: 'city', country: 'UZ', country_name: '乌兹别克斯坦', note: '乌兹别克斯坦首都' }] }
      : null,
    osmSearch: async () => osmTashkent,
    env: {}
  });
  ok(r1.candidates.length === 0 && r1.place_candidates.destination.length === 1,
    'P0-1 场景1：北京→塔什干 → 已核验候选待确认（未确认前不出交通候选）');
  const cand1 = r1.place_candidates.destination[0];
  ok(cand1.candidate_id && cand1.resolution_state === 'verified' && cand1.country === 'UZ' && /^https:/.test(cand1.source_url) && cand1.lat != null,
    'P0-1 场景1：候选带服务端签发 candidate_id + 核验字段（OSM）');
  ok(r1.needs_confirmation.some((n) => n.includes('新地点') && n.includes('确认卡')),
    'P0-1 场景1：needs_confirmation 指引确认卡');

  /* 场景1 续：用户确认（只回传 candidate_id）→ 服务端从存证恢复动态 Place */
  const r1c = await planAnywhere({ origin: '北京', destination: '塔什干', confirmed_places: { destination: cand1.candidate_id } }, {
    callJson: async () => null,
    osmSearch: async () => osmTashkent,
    env: {}
  });
  ok(r1c.route.route_type === 'international' && r1c.intent.parse_engine.includes('confirmed') &&
    r1c.intent.destination_place.dynamic === true && r1c.intent.destination_place.resolution_state === 'user_confirmed' &&
    r1c.intent.destination_place.country === 'UZ' && r1c.intent.destination_place.source_url === cand1.source_url &&
    r1c.candidates.filter((c) => c.kind === 'direct').length === 1 &&
    r1c.explorations.some((e) => e.type === 'land_rail'),
    'P0-1 场景1 续：确认后存证恢复动态 Place（international；塔什干无铁路走廊依据 → 仅航班直达 + 陆路探索）');

  /* 场景2：CDG→布拉格中央车站——两端都未收录，各自开放解析并确认 */
  const osmByQuery = async (q) => {
    if (/charles|cdg/i.test(q)) return [{
      display_name: 'Paris Charles de Gaulle Airport, 法国', country: 'FR', lat: '49.01', lon: '2.55',
      type: 'aerodrome', category: 'aeroway', osm_type: 'way', osm_id: '123', url: 'https://www.openstreetmap.org/way/123'
    }];
    if (/praha|布拉格/i.test(q)) return [{
      display_name: 'Praha hlavní nádraží, 布拉格', country: 'CZ', lat: '50.08', lon: '14.43',
      type: 'station', category: 'railway', osm_type: 'node', osm_id: '456', url: 'https://www.openstreetmap.org/node/456'
    }];
    return [];
  };
  const r2 = await planAnywhere({ origin: 'CDG', destination: '布拉格中央车站' }, {
    callJson: async (opts) => {
      const u = String(opts.user);
      if (u.includes('CDG')) return { candidates: [{ name: '巴黎戴高乐机场', name_latin: 'Paris Charles de Gaulle Airport', kind: 'airport', country: 'FR', country_name: '法国', note: '按代码推断' }] };
      if (u.includes('布拉格')) return { candidates: [{ name: '布拉格中央车站', name_latin: 'Praha hlavní nádraží', kind: 'station', country: 'CZ', country_name: '捷克', note: '主火车站' }] };
      return null;
    },
    osmSearch: osmByQuery,
    env: {}
  });
  ok(r2.place_candidates.origin.length === 1 && r2.place_candidates.origin[0].country === 'FR' &&
    r2.place_candidates.destination.length === 1 && r2.place_candidates.destination[0].kind === 'station',
    'P0-1 场景2：CDG 与布拉格中央车站各自形成已核验候选（机场 FR / 车站 CZ）');
  const r2c = await planAnywhere({
    origin: 'CDG', destination: '布拉格中央车站',
    confirmed_places: { origin: r2.place_candidates.origin[0].candidate_id, destination: r2.place_candidates.destination[0].candidate_id }
  }, { callJson: async () => null, osmSearch: osmByQuery, env: {} });
  ok(r2c.route.route_type === 'international' && r2c.intent.origin_place.dynamic && r2c.intent.destination_place.dynamic,
    'P0-1 场景2 续：两端确认后动态规划（FR→CZ international）');

  /* 场景3：重名地点（剑桥 GB/US）——必须让用户选 */
  const r3 = await planAnywhere({ origin: '北京', destination: '剑桥' }, {
    callJson: async (opts) => String(opts.user).includes('地点表述')
      ? { candidates: [
        { name: '剑桥（英国）', name_latin: 'Cambridge', kind: 'city', country: 'GB', country_name: '英国', note: '大学城' },
        { name: '剑桥（美国）', name_latin: 'Cambridge', kind: 'city', country: 'US', country_name: '美国', note: '麻省城市' }
      ] }
      : null,
    osmSearch: async () => [
      { display_name: 'Cambridge, 英国', country: 'GB', lat: '52.2', lon: '0.12', type: 'city', category: 'place', osm_type: 'relation', osm_id: '111', url: 'https://www.openstreetmap.org/relation/111' },
      { display_name: 'Cambridge, 美国', country: 'US', lat: '42.37', lon: '-71.1', type: 'city', category: 'place', osm_type: 'relation', osm_id: '222', url: 'https://www.openstreetmap.org/relation/222' }
    ],
    env: {}
  });
  ok(r3.candidates.length === 0 && r3.place_candidates.destination.length === 2 &&
    new Set(r3.place_candidates.destination.map((c) => c.country)).size === 2,
    'P0-1 场景3：重名地点返回两国候选，必须由用户选择');

  /* 场景4：完全无法核验（乱码）——诚实阻断 */
  const r4 = await planAnywhere({ origin: '北京', destination: 'asdfqwer' }, {
    callJson: async () => ({ candidates: [] }),
    osmSearch: async () => [],
    env: {}
  });
  ok(r4.candidates.length === 0 && r4.place_candidates.destination.length === 0 &&
    r4.needs_confirmation.some((n) => n.includes('无法核验')), 'P0-1 场景4：无法核验 → 诚实阻断（不猜）');

  /* 核验通道故障：OSM 抛错 → 明确降级为不可确认 */
  const r5 = await planAnywhere({ origin: '北京', destination: '塔什干' }, {
    callJson: async () => ({ candidates: [{ name: '塔什干', name_latin: 'Tashkent', kind: 'city', country: 'UZ' }] }),
    osmSearch: async () => { throw new Error('OSM HTTP 503'); },
    env: {}
  });
  ok(r5.candidates.length === 0 && r5.place_candidates.destination.length === 0 &&
    r5.degradations.some((x) => x.includes('核验通道不可用')) &&
    r5.needs_confirmation.some((n) => n.includes('通道不可用')),
    'P0-1：OSM 通道故障 → 候选未核验不可确认（诚实降级）');

  /* P0-1 安全反例：确认信任边界 */
  const forged = await planAnywhere({ origin: '北京', destination: '塔什干', confirmed_places: { destination: { name: '伪造地', kind: 'city', country: 'US', source_url: 'https://evil.example/x', resolution_state: 'verified', lat: '1', lon: '1' } } }, NO_LLM);
  ok(forged.route === null && forged.candidates.length === 0 &&
    forged.needs_confirmation.some((n) => n.includes('不接受自行拼装的地点数据')),
    'P0-1 反例：浏览器自报完整地点对象被拒（字段校验不替代来源校验）');

  const unknownId = await planAnywhere({ origin: '北京', destination: '塔什干', confirmed_places: { destination: 'plc_does_not_exist' } }, NO_LLM);
  ok(unknownId.route === null && unknownId.candidates.length === 0 &&
    unknownId.needs_confirmation.some((n) => n.includes('无效或已过期')),
    'P0-1 反例：未知 candidate_id 被拒');

  {
    const s = new Map();
    const c = { name: '塔什干', kind: 'city', country: 'UZ', source_url: 'https://www.openstreetmap.org/relation/2369842', resolution_state: 'verified', lat: '41.3', lon: '69.2' };
    const idA = registerPlaceCandidate(c, { store: s, now: 5000, ttlMs: 1000 });
    ok(takePlaceCandidate(idA, { store: s, now: 5999 })?.country === 'UZ', 'P0-1：存证候选 TTL 内可恢复（事实由服务端保存）');
    ok(takePlaceCandidate(idA, { store: s, now: 6001 }) === null, 'P0-1 反例：过期 candidate_id 被拒且即删');
    ok(takePlaceCandidate('plc_' + '0'.repeat(18), { store: s, now: 6001 }) === null, 'P0-1 反例：不存在的 candidate_id 被拒');
  }

  const tampered = await planAnywhere({ origin: '北京', destination: '塔什干', confirmed_places: { destination: { candidate_id: 'plc_' + 'f'.repeat(18), country: 'US' } } }, NO_LLM);
  ok(tampered.route === null && tampered.candidates.length === 0, 'P0-1 反例：篡改/拼装 candidate_id 与字段均不采信');

  /* 一句话模式开放解析：原文子串提取后走同一流程 */
  const r6 = await planAnywhere({ text: '国庆从北京去塔什干玩' }, {
    callJson: async (opts) => {
      const sp = String(opts.schema_prompt || '');
      if (sp.includes('origin_raw')) return { origin_raw: '北京', destination_raw: '塔什干' };
      if (sp.includes('地点候选')) return { candidates: [{ name: '塔什干', name_latin: 'Tashkent', kind: 'city', country: 'UZ' }] };
      return null;
    },
    osmSearch: async () => osmTashkent,
    env: {}
  });
  ok(r6.place_candidates.destination.length === 1 && r6.needs_confirmation.some((n) => n.includes('塔什干')),
    'P0-1：一句话模式与两字段共用开放解析流程');
}

/* ---------- 十轮 P0/P2：往返意图不回退（提取/覆盖/消歧与重新规划后保留） ---------- */
{
  /* P0 核心：评审原句「国庆从北京去阿拉木图，10 月 7 日回来」 */
  const rt = await planAnywhere({ text: '国庆附近从北京去阿拉木图，10月7日回来' }, NO_LLM);
  ok(rt.intent.trip_type === 'round_trip' && rt.intent.traveler_count === 1,
    'P0：往返意图与人数提取（round_trip / 1 人）');
  ok(rt.intent.outbound_window && /^2026-09-27 ~ 2026-10-07$/.test(rt.intent.outbound_window),
    'P0：国庆假期宽窗提取（' + rt.intent.outbound_window + '）');
  ok(rt.intent.return_window === '2026-10-07 ~ 2026-10-07',
    'P0：返程日期提取「10月7日回来」→ 2026-10-07 单日窗（代码计算年份）');
  /* 塔什干确认流（有候选路径）：消歧与重新规划后意图字段保留 */
  const osmT = [{ display_name: 'Tashkent, 乌兹别克斯坦', country: 'UZ', lat: '41.31', lon: '69.28', type: 'city', category: 'place', osm_type: 'relation', osm_id: '2369842', url: 'https://www.openstreetmap.org/relation/2369842' }];
  const p1 = await planAnywhere({ text: '国庆附近从北京去塔什干，10月7日回来，2个人' }, {
    callJson: async (o2) => {
      const sp = String(o2.schema_prompt || '');
      if (sp.includes('origin_raw')) return { origin_raw: '北京', destination_raw: '塔什干' };
      if (sp.includes('地点候选')) return { candidates: [{ name: '塔什干', name_latin: 'Tashkent', kind: 'city', country: 'UZ' }] };
      return null;
    },
    osmSearch: async () => osmT,
    env: {}
  });
  const p2c = await planAnywhere({ text: '国庆附近从北京去塔什干，10月7日回来，2个人', confirmed_places: { destination: p1.place_candidates.destination[0].candidate_id } }, {
    callJson: async () => null, osmSearch: async () => osmT, env: {}
  });
  ok(p2c.intent.trip_type === 'round_trip' && p2c.intent.traveler_count === 2 &&
    p2c.intent.return_window === '2026-10-07 ~ 2026-10-07' && p2c.intent.outbound_window,
    'P2：往返/日期/人数经消歧确认后保留（round_trip/2人/10-07 返程/假期宽窗）');
  /* 显式字段覆盖文本提取（UI 字段优先） */
  const ov = await planAnywhere({ text: '国庆附近从北京去喀什', travel: { trip_type: 'one_way', traveler_count: 3 } }, NO_LLM);
  ok(ov.intent.trip_type === 'one_way' && ov.intent.traveler_count === 3,
    'P0：显式行程字段覆盖文本提取（one_way/3 人）');
  const badTravel = await planAnywhere({ text: '从北京去喀什', travel: { trip_type: 'hack', outbound_window: '明天', traveler_count: 99 } }, NO_LLM);
  ok(badTravel.intent.trip_type !== 'hack' && badTravel.intent.outbound_window == null && badTravel.intent.traveler_count === 1,
    'P0：非法行程字段被白名单丢弃（不猜）');
  /* 重名候选区分（P1）：detail 携带完整行政层级 */
  const cam = await planAnywhere({ origin: '北京', destination: '剑桥' }, {
    callJson: async () => ({ candidates: [{ name: '剑桥', name_latin: 'Cambridge', kind: 'city', country: 'GB' }] }),
    osmSearch: async () => [
      { display_name: '剑桥市, 剑桥郡, 英格兰, 英国', country: 'GB', lat: '52.2', lon: '0.12', type: 'city', category: 'place', osm_type: 'node', osm_id: '20971094', url: 'https://www.openstreetmap.org/node/20971094' },
      { display_name: '剑桥市, 剑桥郡, 英格兰, 英国', country: 'GB', lat: '52.21', lon: '0.13', type: 'city', category: 'place', osm_type: 'relation', osm_id: '295355', url: 'https://www.openstreetmap.org/relation/295355' }
    ],
    env: {}
  });
  const gb = cam.place_candidates.destination;
  ok(gb.length === 2 && gb.every((c) => c.detail) &&
    gb[0].detail === gb[1].detail && (gb[0].osm_type !== gb[1].osm_type || gb[0].osm_id !== gb[1].osm_id),
    'P1：重名候选带 detail 与稳定标识（同 display_name 也能经 node/relation 区分，页面逐候选展示）');
}

/* ---------- 十一轮：意图合并顺序 / 无效窗口 / 时序（评审定向反例） ---------- */
{
  /* P0-1：buildTravelIntent 直接以 null explicit 调用不抛（原 TypeError 反例） */
  let btOk = false, btNeeds = 0;
  try {
    const bt = buildTravelIntent('从北京去阿拉木图往返', null);
    btOk = bt.intent.trip_type === 'round_trip';
    btNeeds = bt.needs.filter((n) => n.includes('日期')).length;
  } catch { btOk = false; }
  ok(btOk && btNeeds === 2, 'P0-1：buildTravelIntent(…, null) 不抛错，round_trip + 去返两条补全提示');

  const p0a = await planAnywhere({ text: '从北京去阿拉木图往返' }, NO_LLM);
  ok(p0a.intent.trip_type === 'round_trip' &&
    p0a.needs_confirmation.filter((n) => n.includes('日期')).length === 2,
    'P0-1：真实 API 路径无 travel → round_trip + 补去返日期两条提示（不 500）');

  const p0b = await planAnywhere({ text: '从北京去喀什', travel: { trip_type: 'round_trip' } }, NO_LLM);
  ok(p0b.intent.trip_type === 'round_trip' &&
    p0b.needs_confirmation.filter((n) => n.includes('日期')).length === 2,
    'P0-2：文本无行程类型 + 显式 round_trip 日期空 → 两条日期补全提示');

  const p0c = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { trip_type: 'one_way' } }, NO_LLM);
  ok(p0c.intent.trip_type === 'one_way' &&
    p0c.needs_confirmation.every((n) => !n.includes('往返行程请补')),
    'P0-3：文本往返 + 显式 one_way → 最终单程，不残留往返日期提示');

  /* P1：无效窗口丢弃（2月31日溢出 / 月份99），丢后进补全提示 */
  const badWin = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-02-31 ~ 2026-02-31', return_window: '2026-99-99 ~ 2026-99-99' } }, NO_LLM);
  ok(badWin.intent.outbound_window == null && badWin.intent.return_window == null &&
    badWin.needs_confirmation.filter((n) => n.includes('日期')).length === 2,
    'P1：2026-02-31 / 2026-99-99 窗口被真实日历校验丢弃 → 进补全提示（不当已确认事实）');
  ok(isValidWindow('2026-02-31 ~ 2026-02-31') === false && isValidWindow('2026-99-99 ~ 2026-99-99') === false &&
    isValidWindow('2026-12-30 ~ 2027-01-03') === true && isValidWindow('2026-10-05 ~ 2026-10-03') === false,
    'P1：isValidWindow——溢出/越界/倒序拒，合法跨年窗过');

  /* 时序：返程早于去程 → 丢弃返程窗口并提示 */
  const seq = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-10-03 ~ 2026-10-05', return_window: '2026-10-01 ~ 2026-10-01' } }, NO_LLM);
  ok(seq.intent.return_window == null && seq.intent.outbound_window === '2026-10-03 ~ 2026-10-05' &&
    seq.needs_confirmation.some((n) => n.includes('返程窗口早于去程')),
    'P1：返程早于去程 → 忽略返程窗口并如实提示');
}

/* ---------- 十二轮：文本非法返程日期 + 时序完全倒序才拒（评审定向反例） ---------- */
{
  /* P1：文本非法返程日期过同一日历校验 */
  const badFeb = await planAnywhere({ text: '国庆附近从北京去阿拉木图，2月31日回来' }, NO_LLM);
  ok(badFeb.intent.return_window == null &&
    badFeb.needs_confirmation.some((n) => n.includes('返程日期')),
    'P1（十二轮）：「2月31日回来」非法日期 → return_window=null + 返程补全提示（不当已解析事实）');
  const badApr = await planAnywhere({ text: '国庆附近从北京去阿拉木图，4月31日回来' }, NO_LLM);
  ok(badApr.intent.return_window == null && badApr.needs_confirmation.some((n) => n.includes('返程日期')),
    'P1（十二轮）：「4月31日回来」同样拒绝');
  ok(isValidWindow('2028-02-29 ~ 2028-02-29') === true && isValidWindow('2027-02-29 ~ 2027-02-29') === false,
    'P1：闰年 2028-02-29 合法、平年 2027-02-29 拒（真实日历）');

  /* P1：时序只在完全倒序（返程结束早于去程开始）时拒绝 */
  const overlap = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-10-03 ~ 2026-10-05', return_window: '2026-10-01 ~ 2026-10-07' } }, NO_LLM);
  ok(overlap.intent.outbound_window === '2026-10-03 ~ 2026-10-05' && overlap.intent.return_window === '2026-10-01 ~ 2026-10-07' &&
    !overlap.needs_confirmation.some((n) => n.includes('早于去程')),
    'P1（十二轮）：重叠窗口（去 10-03~05 / 返 10-01~07）保留——仍存在去≤返组合，不预检拒绝');
  const fullRev = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-10-03 ~ 2026-10-05', return_window: '2026-10-01 ~ 2026-10-02' } }, NO_LLM);
  ok(fullRev.intent.return_window == null && fullRev.needs_confirmation.some((n) => n.includes('返程窗口早于去程')),
    'P1（十二轮）：完全倒序（返程结束 10-02 早于去程开始 10-03）拒绝并提示');
  const sameDay = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-10-07 ~ 2026-10-07', return_window: '2026-10-07 ~ 2026-10-07' } }, NO_LLM);
  ok(sameDay.intent.outbound_window && sameDay.intent.return_window === '2026-10-07 ~ 2026-10-07' &&
    !sameDay.needs_confirmation.some((n) => n.includes('早于去程')),
    'P1（十二轮）：同日去返窗口保留');
  const crossYear = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { outbound_window: '2026-12-30 ~ 2027-01-02', return_window: '2027-01-05 ~ 2027-01-08' } }, NO_LLM);
  ok(crossYear.intent.outbound_window && crossYear.intent.return_window === '2027-01-05 ~ 2027-01-08',
    'P1（十二轮）：跨年合法窗口保留');
}

/* ---------- 十三轮：最终行程类型统一约束返程字段（评审定向反例） ---------- */
{
  /* P1 评审原载荷：文本往返 + 显式 one_way + 两窗有效 → one_way 且无返程窗，带纠正提示 */
  const ow = await planAnywhere({ text: '从北京去阿拉木图往返', travel: { trip_type: 'one_way', outbound_window: '2026-10-03 ~ 2026-10-03', return_window: '2026-10-07 ~ 2026-10-07' } }, NO_LLM);
  ok(ow.intent.trip_type === 'one_way' && ow.intent.return_window == null &&
    ow.intent.outbound_window === '2026-10-03 ~ 2026-10-03' &&
    ow.needs_confirmation.some((n) => n.includes('已忽略返程日期')),
    'P1（十三轮）：one_way + 有效返程窗 → 返程清空 + 纠正提示（去程保留，不静默「单程＋返程」）');
  /* 文本提取返程日期（10月7日回来）+ 显式 one_way → 同样清空 */
  const owText = await planAnywhere({ text: '国庆附近从北京去阿拉木图，10月7日回来', travel: { trip_type: 'one_way' } }, NO_LLM);
  ok(owText.intent.trip_type === 'one_way' && owText.intent.return_window == null &&
    owText.needs_confirmation.some((n) => n.includes('已忽略返程日期')),
    'P1（十三轮）：文本返程日期 + 显式 one_way → 返程同样清空并提示');
  /* pending（待确认，按单程探索）也不保留返程窗 */
  const pd = await planAnywhere({ text: '从北京去阿拉木图', travel: { return_window: '2026-10-07 ~ 2026-10-07' } }, NO_LLM);
  ok(pd.intent.trip_type === 'pending' && pd.intent.return_window == null &&
    pd.needs_confirmation.some((n) => n.includes('已忽略返程日期')),
    'P1（十三轮）：pending + 显式返程窗 → 返程清空并提示');
  /* 回归：round_trip 正常保留返程窗（评审原句） */
  const rt = await planAnywhere({ text: '国庆附近从北京去阿拉木图，10月7日回来' }, NO_LLM);
  ok(rt.intent.trip_type === 'round_trip' && rt.intent.return_window === '2026-10-07 ~ 2026-10-07' &&
    !rt.needs_confirmation.some((n) => n.includes('已忽略返程日期')),
    'P1（十三轮）回归：round_trip 保留返程窗，无清理提示');
}

/* ---------- planAnywhere 编排（注入桩，无网络无 key） ---------- */
{
  const r1 = await planAnywhere({ text: '从北京去喀什' }, NO_LLM);
  ok(r1.intent.parse_engine === 'dict' && r1.route.route_type === 'domestic' && r1.candidates.length === 3,
    '编排：一句话国内 OD 词典解析 + 三骨架');
  ok(r1.degradations.some((x) => x.includes('web_search 未配置')), '编排：web_search 不可用 → 明确降级为探索态');

  const r2 = await planAnywhere({ text: '从北京首都机场去喀纳斯，预算5000元' }, NO_LLM);
  ok(r2.intent.origin === '北京首都国际机场' && r2.intent.destination === '喀纳斯' && r2.intent.constraints.budget_max_cny === 5000,
    '编排：机场别名 + 无就近城市景点 + 约束提取同句完成');
  ok(r2.candidates.every((c) => NO_DIGIT_RE.test(c.explanation) === false) &&
    r2.candidates.every((c) => c.legs.every((l) => NO_DIGIT_RE.test(l.from) === false && NO_DIGIT_RE.test(l.to) === false)),
    '编排：候选全文零数字（用户约束值只在 chips，防幻觉契约）');

  const r4 = await planAnywhere({ origin: '北京', destination: '北京' }, NO_LLM);
  ok(r4.needs_confirmation.some((n) => n.includes('相同')) && r4.candidates.length === 0, '编排：同地名阻断');

  const r5 = await planAnywhere({ origin: '北京', destination: '喀什', constraints: { budget_max_cny: 'abc', max_transfers: 9, night_arrival: 'maybe' } }, NO_LLM);
  ok(r5.intent.constraints.max_transfers === undefined && r5.intent.constraints.night_arrival === undefined,
    '编排：非法约束字段被白名单丢弃（不猜）');

  const fakeEnv = { LLM_API_KEY: 'x', LLM_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4' };
  const r6 = await planAnywhere({ origin: '北京', destination: '喀什' },
    { callJson: async () => null, env: fakeEnv, osmSearch: async () => [], webSearchStatus: () => ({ status: 'quota_exhausted' }),
      searchWeb: async () => [{ title: '北京 喀什 乌鲁木齐 航班 火车 铁路 高铁', link: 'https://e.com/x', content: '北京 乌鲁木齐 喀什' }] });
  ok(r6.candidates.flatMap((c) => c.legs).every((l) => l.evidence_state === 'source_lead'),
    '编排：web_search 已配置时逐段挂相关线索（source_lead）');
  ok(r6.web_search && r6.web_search.configured === true && r6.web_search.status === 'quota_exhausted',
    'P1-4：规划响应如实带 web_search 配置与最近真实状态（configured ≠ available）');
  ok(r6.planner_version === 'v0.39.0', '编排：anywhere 版本号对齐 v0.39.0');

  const r7 = await planAnywhere({ text: '想去新疆最西边那座古城玩' },
    { callJson: async () => ({ origin: '北京', destination: '喀什' }), env: {}, osmSearch: async () => [] });
  ok(r7.intent.parse_engine === 'llm' && r7.candidates.length === 3,
    '编排：词典扫描无命中、LLM 清单内补全 → engine=llm');

  ok(KIND_LABEL.direct === '直达' && KIND_LABEL.mixed === '混合交通', '常量：骨架类型标签');
  ok(osmKind({ type: 'aerodrome', category: 'aeroway' }) === 'airport' &&
    osmKind({ type: 'station', category: 'railway' }) === 'station' &&
    osmKind({ type: 'city', category: 'place' }) === 'city' &&
    osmKind({ type: 'attraction', category: 'tourism' }) === 'poi',
    'OSM 类型映射：aerodrome/station/city/attraction → 四类 kind');
}

console.log(fail === 0
  ? `\n✓ G2.5 任意地点规划确定性测试全部通过（${total} 项断言）`
  : `\n✗ 失败 ${fail} 项（共 ${total} 项断言）`);
process.exit(fail === 0 ? 0 : 1);
