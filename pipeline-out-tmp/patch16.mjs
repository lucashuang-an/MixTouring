import { readFileSync, writeFileSync } from 'fs';
const f = 'server/check-anywhere.mjs';
let t = readFileSync(f, 'utf8');
const old1 = `  ok(intl.candidates.length === 3 && intl.candidates[0].variant === 'plane' &&
    intl.candidates.filter((c) => c.builder === 'rule:hub').length === 2 &&
    intl.candidates.every((c) => c.why_explore && c.uncertain_leg && c.next_checks.length >= 1),
    'G2.6：北京→阿拉木图无 LLM 仍出枢纽中转（乌鲁木齐，builder=rule:hub）且三件套齐备');`;
if (!t.includes(old1)) { console.error('锚1未找到'); process.exit(1); }
const new1 = old1 + `
  /* 十六轮 P1-1：依据与路段/方向绑定——mixed 的 KZ 锚点只挂枢纽之后段（leg=out），in 段依据分离 */
  const almMixed = intl.candidates.find((c) => c.kind === 'mixed');
  ok(almMixed && almMixed.basis.whys.some((w) => w.leg === 'out' && w.direction === 'KZ' && w.scope === 'rail') &&
    almMixed.basis.whys.some((w) => w.leg === 'in'),
    'P1（十六轮）：混合卡依据 leg=out（枢纽之后段）+ 方向 KZ 绑定，in 段依据分离');
  /* 十六轮 P2：反向跨境行程逐段判定 */
  const revHk = buildCandidateSkeletons(resolvePlace('香港'), resolvePlace('北京'), {}, { one_transfer_city: '广州' });
  const revOne = revHk.candidates.find((c) => c.kind === 'one_transfer');
  ok(revOne && revOne.uncertain_leg.includes('香港 → 广州（跨境') && revOne.uncertain_leg.includes('广州 → 北京（班期未核验）'),
    'P2（十六轮）：反向跨境行程逐段判定（香港→广州跨境、广州→北京非跨境）');`;
t = t.replace(old1, new1);

const old2 = `  ok(intl.candidates.find((c) => c.kind === 'one_transfer').legs[1].from === '乌鲁木齐' &&
    intl.candidates.find((c) => c.kind === 'one_transfer').why_explore.includes('中亚'),
    'G2.6：中转枢纽=乌鲁木齐（gateway KZ），推荐依据含门户说明');`;
if (!t.includes(old2)) { console.error('锚2未找到'); process.exit(1); }
const new2 = `  ok(intl.candidates.find((c) => c.kind === 'one_transfer').legs[1].from === '乌鲁木齐' &&
    intl.candidates.find((c) => c.kind === 'one_transfer').why_explore.includes('乌鲁木齐→哈萨克斯坦方向'),
    'G2.6：中转枢纽=乌鲁木齐（gateway KZ），依据明示「枢纽→目的地」段方向（十六轮：路段级绑定）');`;
t = t.replace(old2, new2);

/* 上海断言：why 文案已改，调整 */
const old3 = `  ok(short.candidates.length === 1 && short.candidates[0].kind === 'direct' &&
    short.candidates[0].why_explore.includes('优先核查直达') && !short.candidates[0].why_explore.includes('是最优') &&
    short.degradations.some((x) => x.includes('缺少航空段连接依据')),
    'G2.6（十五轮）：北京→上海只出直达——中转因顺路城市缺航空段依据不生成（非里程阈值 gate）；直达文案为优先核查而非最优断言');`;
if (t.includes(old3)) {
  const new3 = `  ok(short.candidates.length === 1 && short.candidates[0].kind === 'direct' &&
    short.candidates[0].why_explore.includes('优先核查直达') && !short.candidates[0].why_explore.includes('是最优'),
    'G2.6（十五轮）：北京→上海只出直达卡，直达文案为优先核查而非最优断言（十五轮回归，v0.39.0 中转由依据驱动）');`;
  t = t.replace(old3, new3);
}
/* 广州→拉萨：why 关键词从「高原方向」改为段绑定文案 */
const old4 = `  ok(gzOne && gzOne.legs[1].from === '成都' && gzOne.why_explore.includes('高原方向'),
    'G2.6（十五轮）：广州→拉萨中转选成都（方向匹配枢纽，非绕行最小首位柳州），依据含高原航线出发点');`;
if (t.includes(old4)) {
  const new4 = `  ok(gzOne && gzOne.legs[1].from === '成都' && gzOne.why_explore.includes('成都→拉萨方向'),
    'G2.6（十五轮）：广州→拉萨中转选成都（方向匹配枢纽，非绕行最小首位柳州），依据明示成都→拉萨段方向');`;
  t = t.replace(old4, new4);
}
writeFileSync(f, t, 'utf8');
console.log('check-anywhere 断言已更新');
