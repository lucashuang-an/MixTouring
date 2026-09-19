/* check-anywhere.mjs · G2.5 任意地点规划确定性测试（v0.30.0 · 模式同 check-trip.mjs，纯函数无服务依赖）
 * 纪律：本文件不读 server/.env、不联网——LLM 与 searchWeb 一律注入桩；真模型路径由有 key 环境冒烟。
 * 反例来源：评审流转决定（Issue #5 六轮）给定的 G2.5 边界 + 冒烟实测抓到的两处缺陷
 * （geo 中转城市不在 31 城词典内被静默丢弃；「北京首都机场」解析成「北京」）。
 * 运行：node server/check-anywhere.mjs */

import {
  resolvePlace, scanPlaceMentions, extractConstraints, constraintChips,
  buildCandidateSkeletons, verifyLegs, planAnywhere, KIND_LABEL
} from './lib/anywhere.mjs';

let fail = 0;
const ok = (cond, name) => { if (cond) console.log('✓ ' + name); else { fail++; console.error('✗ ' + name); } };

const NO_LLM = { callJson: async () => null, env: {} };
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
  ok(resolvePlace('塔什干') === null && resolvePlace('') === null, 'resolvePlace：未收录/空 → null（不猜）');
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
  ok(extractConstraints('红眼航班也行，可以半夜到') .night_arrival === 'allow', '约束：夜间到达 allow 表述');
  ok(extractConstraints('不想换乘').max_transfers === 0, '约束：「不想换乘」→ 0 次');
  ok(extractConstraints('国庆从北京去喀什').budget_max_cny === undefined && 'night_arrival' in extractConstraints('国庆从北京去喀什') === false,
    '约束：无约束表述 → 不出现字段（不猜）');
  const chips = constraintChips(c);
  ok(chips.length === 4 && chips.every((x) => NO_DIGIT_RE.test(x.label) === false || x.key === 'budget' || x.key === 'layover' || x.key === 'transfers'),
    'chips：四项齐备（数字仅来自用户输入值）');
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
  ok(candidates.some((c) => JSON.stringify(c).includes('"price"') === false) && !JSON.stringify(candidates).includes('"price"'),
    '骨架：不含任何价格字段');
  ok(degradations.length === 0 && constraint_notes.length === 0, '骨架：geo 路径无降级无约束备注');

  /* 换乘次数过滤（结构事实可直接校验） */
  const f = buildCandidateSkeletons(o, d, { max_transfers: 0 }, {});
  ok(f.candidates.length === 1 && f.candidates[0].kind === 'direct' &&
    f.constraint_notes.some((n) => n.includes('一次中转、混合交通')), '约束：换乘 ≤ 0 次过滤掉两类中转骨架并如实备注');

  /* 国际 OD 无 LLM：只出直达，双骨架降级说明 */
  const intl = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('阿拉木图'), {}, {});
  ok(intl.candidates.length === 1 && intl.candidates[0].kind === 'direct' && intl.candidates[0].legs[0].mode_guess === 'plane',
    '骨架：国际 OD 直达假设 mode_guess=plane');
  ok(intl.degradations.filter((x) => x.includes('中转城市来源')).length === 2, '骨架：无 LLM 时两类中转骨架明确降级（不静默消失）');

  /* LLM 提名：清单内生效、清单外丢弃 */
  const hint = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('阿拉木图'), {}, { one_transfer_city: '乌鲁木齐', mixed_rail_city: '乌鲁木齐' });
  ok(hint.candidates.length === 3 && hint.candidates.filter((c) => c.builder === 'llm').length === 2,
    '骨架：LLM 清单内提名生效并标注 builder=llm');
  const bad = buildCandidateSkeletons(resolvePlace('北京'), resolvePlace('阿拉木图'), {}, { one_transfer_city: '火星', mixed_rail_city: '伊斯坦布尔' });
  ok(bad.candidates.length === 1 && bad.degradations.length === 2, '骨架：LLM 清单外提名被丢弃（不造地名）');

  /* 出发地非大陆：混合骨架不生成（铁路起段假设不成立） */
  const hk = buildCandidateSkeletons(resolvePlace('香港'), resolvePlace('阿拉木图'), {}, { one_transfer_city: '北京', mixed_rail_city: '北京' });
  ok(hk.candidates.map((c) => c.kind).join(',') === 'direct,one_transfer' &&
    hk.degradations.some((x) => x.includes('大陆铁路起段')), '骨架：非大陆出发地不出混合骨架并说明');
}

/* ---------- verifyLegs：同查询缓存 / https 白名单 / 失败保持探索态 ---------- */
{
  const o = resolvePlace('北京'), d = resolvePlace('喀什');
  const built = buildCandidateSkeletons(o, d, {}, {});
  let calls = 0;
  const queries = [];
  const stat = await verifyLegs(built.candidates, async (q) => {
    calls++; queries.push(q);
    return [{ title: '来源A', link: 'https://example.com/a' }, { title: '非https', link: 'http://x.com/b' }, null];
  });
  const legs = built.candidates.flatMap((c) => c.legs);
  ok(legs.every((l) => l.evidence_state === 'searched' && l.sources.length === 1 && l.sources[0].link.startsWith('https:')),
    '取证：来源只保留 https（v0.29.1 白名单回归），线索级 note 标注');
  ok(new Set(queries).size === queries.length, '取证：相同查询不重复发起（缓存去重）');
  ok(stat.searched === legs.length, '取证：全部段获得线索');

  const built2 = buildCandidateSkeletons(o, d, {}, {});
  await verifyLegs(built2.candidates, async () => null);
  ok(built2.candidates.flatMap((c) => c.legs).every((l) => l.evidence_state === 'explore' && l.sources.length === 0),
    '取证：检索空结果 → 保持探索态（不伪造线索）');
  await verifyLegs(built2.candidates, null);
  ok(true, '取证：无 searchFn 时安全跳过');
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

  const r3 = await planAnywhere({ origin: '北京', destination: '塔什干' }, NO_LLM);
  ok(r3.needs_confirmation.length === 1 && r3.candidates.length === 0 && r3.route === null,
    '编排：未收录目的地 → needs_confirmation，不出任何候选（不猜）');

  const r4 = await planAnywhere({ origin: '北京', destination: '北京' }, NO_LLM);
  ok(r4.needs_confirmation.some((n) => n.includes('相同')) && r4.candidates.length === 0, '编排：同地名阻断');

  const r5 = await planAnywhere({ origin: '北京', destination: '喀什', constraints: { budget_max_cny: 'abc', max_transfers: 9, night_arrival: 'maybe' } }, NO_LLM);
  ok(r5.intent.constraints.max_transfers === undefined && r5.intent.constraints.night_arrival === undefined,
    '编排：非法约束字段被白名单丢弃（不猜）');

  const fakeEnv = { LLM_API_KEY: 'x', LLM_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4' };
  const r6 = await planAnywhere({ origin: '北京', destination: '喀什' },
    { callJson: async () => null, env: fakeEnv, searchWeb: async () => [{ title: 't', link: 'https://e.com/x' }] });
  ok(r6.candidates.flatMap((c) => c.legs).every((l) => l.evidence_state === 'searched'),
    '编排：web_search 已配置时逐段取证挂来源');

  const r7 = await planAnywhere({ text: '想去新疆最西边那座古城玩' },
    { callJson: async () => ({ origin: '北京', destination: '喀什' }), env: {} });
  ok(r7.intent.parse_engine === 'llm' && r7.candidates.length === 3,
    '编排：词典扫描无命中、LLM 清单内补全 → engine=llm');

  ok(KIND_LABEL.direct === '直达' && KIND_LABEL.mixed === '混合交通', '常量：骨架类型标签');
}

console.log(fail === 0 ? '\n✓ G2.5 任意地点规划确定性测试全部通过' : '\n✗ 失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
