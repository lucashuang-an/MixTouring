/* calibrate-routes.mjs · G2.6 线路发现质量校准（v0.38.0 十五轮修订：候选级合理性判据）
 * 纪律：确定性运行（不联网、不读 server/.env、不调 LLM/搜索）。
 * 判据分两层：样本级（卡型/枢纽/方向）+ 候选级（中转点可解释、绕行比受控、依据与方式一致、
 * 措辞与证据相称、中转/混合两卡提供不同走法）。「约 80% 靠谱」是内部待测目标；
 * 本报告只陈述样本与候选级事实，不构成对外准确率承诺，也不替代人工抽查。
 * 运行：node server/calibrate-routes.mjs  （报告写入 pipeline/out/route-calibration.json） */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCandidateSkeletons, resolvePlace, DIRECT_HINT_KM } from './lib/anywhere.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'pipeline', 'out');
const HUB_NAMES = new Set(JSON.parse(readFileSync(join(ROOT, 'pipeline/data/transfer-hubs.json'), 'utf8')).hubs.map((h) => h.name));

/** 动态地点（无 LLM/OSM 环境用固定坐标模拟开放解析结果，仅校准候选生成质量） */
const dyn = (name, country, lat, lon) => ({ name, kind: 'city', country, is_mainland: false, lat, lon, tz: null });

const dist = (a, b) => {
  if ([a.lat, a.lon, b.lat, b.lon].some((x) => x == null)) return null;
  const R = 6371, rad = (x) => Number(x) * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** 候选级合理性判据：返回失败类型数组（空=通过） */
function judgeCandidate(c, o, d) {
  const f = [];
  const overclaim = /是最优|保证|确定的省钱/.test((c.why_explore || '') + (c.explanation || ''));
  if (overclaim) f.push('overclaim');
  if (!(c.why_explore && c.uncertain_leg && Array.isArray(c.next_checks) && c.next_checks.length)) f.push('missing_explain');
  if (c.kind === 'direct') {
    const km = dist(o, d);
    /* 短距提示：国内「方式待取证」直达卡须含「优先核查直达」；国际/带方式的直达卡（plane/rail）
     * 本身即指向明确核查方向（查航班/查线路），不适用该提示判据 */
    if (!c.variant && km != null && km <= DIRECT_HINT_KM && !/优先核查直达|最直接的参照方案/.test(c.why_explore || '')) f.push('short_haul_no_direct_hint');
    return f;
  }
  const hub = c.legs[1] ? c.legs[1].from : null;
  if (!hub) { f.push('malformed_transfer'); return f; }
  /* 中转点可解释：枢纽表命中，或 LLM 假设提名（标注待查） */
  if (!HUB_NAMES.has(hub) && c.builder !== 'llm') f.push('hub_unexplained');
  /* 方向性：绕行比受控（可算时） */
  const km = dist(o, d);
  const hubPlace = resolvePlace(hub);
  if (hubPlace && km) {
    const via = (dist(o, hubPlace) || 0) + (dist(hubPlace, d) || 0);
    if (via && via / km > 1.6) f.push('detour_violation');
  }
  /* 依据与方式一致性 */
  const scopes = (c.basis && Array.isArray(c.basis.whys) ? c.basis.whys : []).map((w) => w.scope);
  if (c.kind === 'one_transfer' && scopes.some((s) => s === 'rail' || s === 'rail-leg')) f.push('scope_mismatch');
  if (c.kind === 'mixed' && !(scopes.includes('rail-leg') && scopes.includes('air-leg')) &&
      !(c.builder === 'llm' && scopes.includes('llm'))) f.push('scope_mismatch');
  return f;
}

const LAYERS = [
  {
    layer: 'L1 国内短距（直达优先提示；中转仅在存在依据时生成）',
    samples: [
      { o: '北京', d: '上海', expect: { kinds: ['direct'], no: ['one_transfer', 'mixed'], degradeHint: '缺少航空段连接依据' } },
      { o: '北京', d: '西安', expect: { kinds: ['direct'], no: ['one_transfer', 'mixed'] } }
    ]
  },
  {
    layer: 'L2 国内长距（方向匹配枢纽择优，非绕行最小首位）',
    samples: [
      { o: '广州', d: '拉萨', expect: { kinds: ['direct', 'one_transfer', 'mixed'], hub: '成都' } },
      { o: '北京', d: '拉萨', expect: { kinds: ['direct', 'one_transfer', 'mixed'], hubIn: ['成都', '西安'] } },
      { o: '北京', d: '喀什', expect: { kinds: ['direct', 'one_transfer', 'mixed'], hub: '乌鲁木齐' } }
    ]
  },
  {
    layer: 'L3 国际走廊（直达铁路需走廊依据）',
    samples: [
      { o: '北京', d: '香港', expect: { kinds: ['direct', 'one_transfer', 'mixed'], railDirect: true, hub: '广州' } },
      { o: '乌鲁木齐', d: '阿拉木图', expect: { kinds: ['direct', 'one_transfer'], railDirect: true } }
    ]
  },
  {
    layer: 'L4 国际枢纽（无模型可解释中转；依据按方式分域）',
    samples: [
      { o: '北京', d: '阿拉木图', expect: { kinds: ['direct', 'one_transfer', 'mixed'], hub: '乌鲁木齐', oneWhyNot: '班期锚点' } },
      { o: '北京', d: '阿斯塔纳', expect: { kinds: ['direct', 'one_transfer', 'mixed'], hub: '乌鲁木齐', oneWhyNot: '班期锚点' } }
    ]
  },
  {
    layer: 'L5 反例-跨洋/岛域（无铁路直达；veto 连探索都不给）',
    samples: [
      { o: '北京', d: '台北', expect: { kinds: ['direct'], noRail: true } },
      { o: '北京', d2: dyn('纽约', 'US', '40.71', '-74.01'), label: '纽约（动态）', expect: { kinds: ['direct'], noRail: true, noExplore: true } }
    ]
  },
  {
    layer: 'L6 反例-缺依据（无走廊无枢纽：LLM 不可用时仅直达+陆路探索）',
    samples: [
      { o: '北京', d2: dyn('塔什干', 'UZ', '41.31', '69.28'), label: '塔什干（动态）', expect: { kinds: ['direct'], explore: true } }
    ]
  }
];

function check(sample) {
  const o = resolvePlace(sample.o);
  const d = sample.d ? resolvePlace(sample.d) : sample.d2;
  const built = buildCandidateSkeletons(o, d, {}, {});
  const kinds = built.candidates.map((c) => c.kind + (c.variant ? ':' + c.variant : ''));
  const failures = [];
  const hasKind = (k) => kinds.some((x) => x === k || x.startsWith(k + ':'));
  for (const k of sample.expect.kinds || []) if (!hasKind(k)) failures.push('missing_kind:' + k);
  for (const k of sample.expect.no || []) if (hasKind(k)) failures.push('unexpected_kind:' + k);
  const railDirect = built.candidates.some((c) => c.variant === 'rail');
  if (sample.expect.railDirect && !railDirect) failures.push('missing_rail_direct');
  if (sample.expect.noRail && railDirect) failures.push('unexpected_rail_direct');
  if (sample.expect.explore && !built.explorations.length) failures.push('missing_explore');
  if (sample.expect.noExplore && built.explorations.length) failures.push('unexpected_explore');
  const one = built.candidates.find((c) => c.kind === 'one_transfer');
  if (sample.expect.hub && (!one || one.legs[1].from !== sample.expect.hub)) failures.push('wrong_hub');
  if (sample.expect.hubIn && (!one || !sample.expect.hubIn.includes(one.legs[1].from))) failures.push('wrong_hub');
  if (sample.expect.oneWhyNot && one && one.why_explore.includes(sample.expect.oneWhyNot)) failures.push('scope_mismatch');
  if (sample.expect.degradeHint && !built.degradations.some((x) => x.includes(sample.expect.degradeHint))) failures.push('missing_degrade_hint');
  /* 中转/混合两卡须提供不同走法（mode 序列不同） */
  const mixed = built.candidates.find((c) => c.kind === 'mixed');
  if (one && mixed &&
    JSON.stringify(one.legs.map((l) => l.mode_guess)) === JSON.stringify(mixed.legs.map((l) => l.mode_guess))) {
    failures.push('no_differentiation');
  }
  /* 候选级判据 */
  const candResults = built.candidates.map((c) => ({ id: c.id, failures: judgeCandidate(c, o, d) }));
  return {
    sample: (sample.o || '') + '→' + (sample.label || sample.d || ''),
    kinds, pass: failures.length === 0 && candResults.every((r) => !r.failures.length),
    failures,
    candidate_failures: candResults.filter((r) => r.failures.length)
  };
}

const results = LAYERS.map((L) => ({ layer: L.layer, results: L.samples.map(check) }));
const all = results.flatMap((r) => r.results);
const allCands = all.flatMap((r) => r.candidate_failures);
const failTypeCount = {};
for (const r of all) for (const f of r.failures) failTypeCount[f.split(':')[0]] = (failTypeCount[f.split(':')[0]] || 0) + 1;
for (const cf of allCands) for (const f of cf.failures) failTypeCount[f] = (failTypeCount[f] || 0) + 1;
const candidatesTotal = all.reduce((n, r) => n + r.kinds.length, 0);
const report = {
  generated_at: new Date().toISOString(),
  note: '小规模分层抽样 + 候选级合理性判据（确定性，无 LLM/搜索）：中转点可解释性、绕行比受控、依据与交通方式一致、措辞与证据相称、中转/混合差异化。内部质量参考，不构成对外准确率承诺，也不替代人工抽查；「约 80% 靠谱」为待测内部目标。',
  sample: { denominator: all.length, passed: all.filter((r) => r.pass).length },
  candidates: { total: candidatesTotal, failed: allCands.length },
  fail_types: failTypeCount,
  layers: results,
  config: { direct_hint_km: DIRECT_HINT_KM, hub_detour_max: 1.6 }
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'route-calibration.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
for (const L of results) {
  console.log(L.layer + '：' + L.results.filter((r) => r.pass).length + '/' + L.results.length);
  for (const r of L.results) console.log('  ' + (r.pass ? '✓' : '✗') + ' ' + r.sample + ' → [' + r.kinds.join(', ') + ']' + (r.failures.length ? ' 样本级失败:' + r.failures.join('|') : '') + (r.candidate_failures.length ? ' 候选级失败:' + JSON.stringify(r.candidate_failures) : ''));
}
console.log('样本：' + report.sample.passed + '/' + report.sample.denominator + '；候选：' + (candidatesTotal - allCands.length) + '/' + candidatesTotal + '（失败类型 ' + JSON.stringify(failTypeCount) + '）');
console.log('报告已写入 pipeline/out/route-calibration.json');
process.exit(report.sample.passed === report.sample.denominator && allCands.length === 0 ? 0 : 1);
