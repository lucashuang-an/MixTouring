/* calibrate-routes.mjs · G2.6 线路发现质量校准（十四轮流转：小规模分层抽样，报告路线合理性/失败类型/分母）
 * 纪律：确定性运行（不联网、不读 server/.env、不调 LLM/搜索）；「约 80% 靠谱」是内部待测目标，
 * 本报告只陈述样本事实，不构成对外准确率承诺。
 * 运行：node server/calibrate-routes.mjs  （报告写入 pipeline/out/route-calibration.json） */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCandidateSkeletons, resolvePlace, DIRECT_OK_KM } from './lib/anywhere.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'out');

/** 动态地点（无 LLM/OSM 环境用固定坐标模拟开放解析结果，仅校准候选生成质量） */
const dyn = (name, country, lat, lon) => ({ name, kind: 'city', country, is_mainland: false, lat, lon, tz: null });

/** 分层样本：每条给预期（期望生成的卡型集合）与失败类型枚举 */
const LAYERS = [
  {
    layer: 'L1 国内短距（直达合适应只直达）',
    samples: [
      { o: '北京', d: '上海', expect: { kinds: ['direct'], no: ['one_transfer', 'mixed'] } },
      { o: '北京', d: '西安', expect: { kinds: ['direct'], no: ['one_transfer', 'mixed'] } }
    ]
  },
  {
    layer: 'L2 国内长距（中转/混合方向应出）',
    samples: [
      { o: '北京', d: '喀什', expect: { kinds: ['direct', 'one_transfer', 'mixed'] } },
      { o: '北京', d: '拉萨', expect: { kinds: ['direct', 'one_transfer', 'mixed'] } }
    ]
  },
  {
    layer: 'L3 国际走廊（直达铁路可出，走廊依据）',
    samples: [
      { o: '北京', d: '香港', expect: { kinds: ['direct', 'one_transfer', 'mixed'], railDirect: true } },
      { o: '乌鲁木齐', d: '阿拉木图', expect: { kinds: ['direct', 'one_transfer'], railDirect: true } }
    ]
  },
  {
    layer: 'L4 国际枢纽（无模型应出可解释中转）',
    samples: [
      { o: '北京', d: '阿拉木图', expect: { kinds: ['direct', 'one_transfer', 'mixed'], hub: '乌鲁木齐' } },
      { o: '北京', d: '阿斯塔纳', expect: { kinds: ['direct', 'one_transfer', 'mixed'], hub: '乌鲁木齐' } }
    ]
  },
  {
    layer: 'L5 反例-跨洋/岛域（无铁路直达，跨境旗标/距离 veto）',
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

const FAIL_TYPES = ['missing_kind', 'unexpected_kind', 'missing_rail_direct', 'unexpected_rail_direct', 'missing_explore', 'unexpected_explore', 'wrong_hub', 'missing_explain'];

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
  if (sample.expect.hub) {
    const one = built.candidates.find((c) => c.kind === 'one_transfer');
    if (!one || one.legs[1].from !== sample.expect.hub) failures.push('wrong_hub');
  }
  /* 三件套齐备性（所有生成的候选） */
  if (!built.candidates.every((c) => c.why_explore && c.uncertain_leg && Array.isArray(c.next_checks) && c.next_checks.length)) {
    failures.push('missing_explain');
  }
  return {
    sample: (sample.o || '') + '→' + (sample.label || sample.d || ''),
    kinds, pass: failures.length === 0, failures
  };
}

const results = LAYERS.map((L) => ({ layer: L.layer, results: L.samples.map(check) }));
const all = results.flatMap((r) => r.results);
const failTypeCount = {};
for (const r of all) for (const f of r.failures) failTypeCount[f.split(':')[0]] = (failTypeCount[f.split(':')[0]] || 0) + 1;
const report = {
  generated_at: new Date().toISOString(),
  note: '小规模分层抽样校准（确定性，无 LLM/搜索）：路线合理性、失败类型与分母。内部质量参考，非对外准确率承诺。',
  denominator: all.length,
  passed: all.filter((r) => r.pass).length,
  fail_types: failTypeCount,
  layers: results,
  config: { direct_ok_km: DIRECT_OK_KM }
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'route-calibration.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
for (const L of results) {
  console.log(L.layer + '：' + L.results.filter((r) => r.pass).length + '/' + L.results.length);
  for (const r of L.results) console.log('  ' + (r.pass ? '✓' : '✗') + ' ' + r.sample + ' → [' + r.kinds.join(', ') + ']' + (r.failures.length ? ' 失败:' + r.failures.join('|') : ''));
}
console.log('总计：' + report.passed + '/' + report.denominator + '（失败类型 ' + JSON.stringify(failTypeCount) + '）');
console.log('报告已写入 pipeline/out/route-calibration.json');
process.exit(report.passed === report.denominator ? 0 : 1);
