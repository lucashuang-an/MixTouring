/* check-geo.mjs · 地理技能自测（纯函数，无需起服务）。CI 与本地验证入口。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadGeo, haversineKm, deviationKm, candidatesBetween, assessRoute,
  geoPromptBlock, enrichWithGeo, MAX_DETOUR_RATIO
} from './lib/geo-skill.mjs';
import { buildServiceDB } from './lib/derive.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

function ok(label, cond, detail = '') {
  if (cond) console.log('✓ ' + label);
  else { failed++; console.error('✗ ' + label + (detail ? '：' + detail : '')); }
}

/* ---------- 地理库自身健康 ---------- */
const geo = loadGeo();
const cities = [...geo.byName.values()];
ok(`地理库 ${cities.length} 城`, cities.length >= 150);
ok('坐标在中国境内范围', cities.every((c) => c.lat >= 17 && c.lat <= 54 && c.lng >= 73 && c.lng <= 136));
ok('城市名无重复', cities.length === geo.byName.size);
const plansStore = JSON.parse(readFileSync(join(root, 'pipeline/data/plans.json'), 'utf8'));
const missing = plansStore.cities.filter((c) => !geo.byName.has(c));
ok('方案库 24 城全部在地理库中', missing.length === 0, '缺失：' + missing.join('、'));

/* ---------- 基础几何 ---------- */
const bjKm = haversineKm(39.9, 116.41, 39.47, 75.99);
ok('北京→喀什大圆距离约 3,430km（±5%）', bjKm > 3260 && bjKm < 3600, `实际 ${Math.round(bjKm)}km`);
const a = { lat: 39.9, lng: 116.41 }, b = { lat: 39.47, lng: 75.99 };
const yinchuan = geo.byName.get('银川');
ok('银川偏离北京→喀什走廊 < 300km', deviationKm(yinchuan, a, b) < 300, `实际 ${Math.round(deviationKm(yinchuan, a, b))}km`);
const shanghai = geo.byName.get('上海');
ok('上海在北京→喀什起点反方向（t<0，顺路窗口排除）', deviationKm(shanghai, a, b) > 500);

/* ---------- 候选计算：三角形路线直觉 ---------- */
const bjKashi = candidatesBetween('北京', '喀什');
const names = bjKashi.map((c) => c.name);
ok('北京→喀什候选含银川', names.includes('银川'));
ok('北京→喀什候选含兰州', names.includes('兰州'));
ok('北京→喀什候选含乌鲁木齐', names.includes('乌鲁木齐'));
ok('北京→喀什候选不含上海（大绕行被排除）', !names.includes('上海'));
ok('候选按绕行比升序', bjKashi.every((c, i) => i === 0 || bjKashi[i - 1].detourRatio <= c.detourRatio));

const gzLhasa = candidatesBetween('广州', '拉萨').map((c) => c.name);
ok('广州→拉萨候选含西宁（青藏铁路）', gzLhasa.includes('西宁'));
ok('广州→拉萨候选含成都', gzLhasa.includes('成都'));

const planeOnly = candidatesBetween('北京', '喀什', { mode: 'plane' }).map((c) => c.name);
ok('mode=plane 过滤后仍含银川（有机场）', planeOnly.includes('银川'));
const trainOnly = candidatesBetween('广州', '拉萨', { mode: 'train' }).map((c) => c.name);
ok('mode=train 过滤广州→拉萨含西宁且不含稻城（无铁路）', trainOnly.includes('西宁') && !trainOnly.includes('稻城'));

/* ---------- 绕行比评估：三角形直觉的两端用例 ---------- */
const bad = assessRoute('北京', '喀什', ['上海']);
ok('北京→上海→喀什 判非主流（反方向走廊，即绕行比 1.53 未超标也被拦）',
  bad.verdict === 'non_mainstream' && bad.reasons.some((r) => r.includes('反方向')),
  `实际 verdict=${bad.verdict} reasons=${JSON.stringify(bad.reasons)}`);
const good = assessRoute('北京', '喀什', ['银川']);
ok('北京→银川→喀什 判主流', good.verdict === 'mainstream' && good.ratio <= MAX_DETOUR_RATIO, `实际 verdict=${good.verdict} ratio=${good.ratio}`);
const unknown = assessRoute('北京', '喀什', ['不存在城']);
ok('地理库外城市 verdict=unknown（不误杀）', unknown.verdict === 'unknown');
const directPlan = assessRoute('北京', '喀什', []);
ok('无中转即主流', directPlan.verdict === 'mainstream');

/* ---------- Prompt 注入段 ---------- */
const block = geoPromptBlock('广州', '拉萨');
ok('geoPromptBlock 含约束句与城市标注', block.includes('必须取自该列表') && block.includes('绕行'));
ok('geoPromptBlock 含铁路榜候选（has_rail 城市进入列表）', /[铁路|高铁]/.test(block));
ok('geoPromptBlock 紧凑（≤160 token 量级，即 ≤500 字符）', block.length <= 500, `实际 ${block.length} 字符`);
const emptyBlock = geoPromptBlock('北京', '月球');
ok('库外起终点给兜底文案不抛错', emptyBlock.includes('直达方案'));

/* ---------- 服务层增强（enrichWithGeo） ---------- */
const db = enrichWithGeo(buildServiceDB(plansStore));
const bjRoute = db.routes['北京-喀什'];
ok('北京-喀什每条方案都有 geo 字段', bjRoute.plans.every((p) => p.geo && ['mainstream', 'non_mainstream', 'unknown'].includes(p.geo.verdict)));
const nonCount = bjRoute.plans.filter((p) => p.geo.verdict === 'non_mainstream').length;
ok('非主流方案 ≤ 2 条', nonCount <= 2, `实际 ${nonCount}`);
const firstNon = bjRoute.plans.findIndex((p) => p.geo.verdict === 'non_mainstream');
const lastMain = bjRoute.plans.map((p) => p.geo.verdict).lastIndexOf('mainstream');
ok('非主流方案排在主流之后（垫底）', firstNon === -1 || firstNon > lastMain);

console.log(failed ? `\n✗ ${failed} 项未通过` : '\n✓ 地理技能自测全部通过');
process.exit(failed ? 1 : 0);
