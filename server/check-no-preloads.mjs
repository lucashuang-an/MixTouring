/* 删除旧库的防回归门槛；fixture不进入运行时路径。 */
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
const root=new URL('../',import.meta.url);
for(const name of ['places','plans','cities-geo','transfer-hubs','rail-corridors','discovery-corridors','destination-guides','route-experiences','attractions','sight-access','transport-references','seasonality'])
  assert.equal(existsSync(new URL('pipeline/data/'+name+'.json',root)),false,'不得重新引入预置数据：'+name);
for(const name of ['mock.js','api.js'])assert.equal(existsSync(new URL('mixtouring-hifi/assets/'+name,root)),false);
assert.equal(existsSync(new URL('.github/workflows/collect.yml',root)),false,'不得继续定时生成旧库');
for(const name of readdirSync(new URL('server/lib/',root)).filter(n=>n.endsWith('.mjs'))){
  const text=readFileSync(new URL('server/lib/'+name,root),'utf8');
  assert.ok(!/loadPlaces\(|resolvePlace\(|pipeline\/data\/(?:places|plans|cities-geo)|destination-guides\.json|route-experiences\.json|[./]fixtures\//.test(text),'运行时不得依赖旧库或测试fixture：'+name);
}
const page=readFileSync(new URL('mixtouring-hifi/pages/trip.html',root),'utf8');
assert.ok(!/fetch\('\/api\/inspirations'|data-idea="[^\"]*(?:北京|阿拉木图)|assets\/mock\.js/.test(page));
assert.equal(existsSync(new URL('mixtouring-hifi/pages/library.html',root)),false);
console.log('✓ 无预置库：地点、方案、攻略、枢纽、交通参考、前端mock及固定推荐入口均已删除');
