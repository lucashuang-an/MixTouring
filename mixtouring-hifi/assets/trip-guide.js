/* 对话引导的偏好与排序；普通偏好只重排，明确拒绝公路客运才筛除。 */
(function (root) {
  'use strict';
  function clean(raw) {
    raw = raw || {};
    return {
      pace: ['simple', 'explore', 'any'].includes(raw.pace) ? raw.pace : null,
      road: ['open', 'prefer_other', 'exclude'].includes(raw.road) ? raw.road : null,
      nights: [0, 1, 2].includes(raw.nights) ? raw.nights : null,
      skipped: Array.isArray(raw.skipped) ? raw.skipped.filter(function (x) { return ['pace', 'nights', 'road'].includes(x); }) : []
    };
  }
  function parse(text) {
    var t = String(text || ''), patch = {}, notes = [];
    if (/省心|少折腾|尽快到|优先直达|直接到|不想绕路/.test(t)) patch.pace = 'simple';
    if (/沿途|顺路玩|多玩|愿意停|可以停|想停|想绕/.test(t)) patch.pace = 'explore';
    if (/都看看|都可以|先看全部|取消偏好|重新比较/.test(t)) patch.pace = 'any';
    if (/(?:不坐|拒绝|不要坐|绝不坐|不能坐)(?:长途)?(?:大巴|客车|汽车|巴士)|不要公路/.test(t)) patch.road = 'exclude';
    else if (/少坐|不想.*(?:长途车|大巴)|优先.*(?:飞机|航班|铁路)/.test(t)) patch.road = 'prefer_other';
    else if (/(?:可以|愿意|接受).*?(?:公路|大巴|长途车)|取消.*(?:大巴|公路).*限制/.test(t)) patch.road = 'open';
    var stay = t.match(/(?:停(?:留)?|住)\s*([一二两12])\s*晚/);
    if (stay) { patch.nights = { '一': 1, '二': 2, '两': 2, '1': 1, '2': 2 }[stay[1]]; patch.pace = 'explore'; }
    if (/不停留|不安排停留|取消停留/.test(t)) patch.nights = 0;
    if (/(?:不想|不要|不能|不愿).{0,4}(?:停|住).*?[一二两12]\s*晚/.test(t)) {
      delete patch.nights; notes.push('我还不能确定你想停几晚，请点选确认。');
    }
    if (/不想沿途|不愿停留|不想多玩/.test(t)) { patch.pace = 'simple'; delete patch.nights; }
    if (/停(?:留)?\s*[一二两12]\s*天/.test(t)) { patch.pace = 'explore'; notes.push('停留天数已看到，住宿晚数请在下一题确认。'); }
    return { patch: patch, notes: notes };
  }
  function summary(raw) {
    var s = clean(raw), labels = [];
    if (s.pace === 'simple') labels.push('优先省心到达');
    if (s.pace === 'explore') labels.push('愿意沿途探索');
    if (s.pace === 'any') labels.push('保留全部方向');
    if (s.road === 'prefer_other') labels.push('优先少坐公路客运');
    if (s.road === 'exclude') labels.push('不坐公路客运');
    if (s.road === 'open') labels.push('愿意了解公路走法');
    if (s.nights != null) labels.push(s.nights ? '中途停 ' + s.nights + ' 晚' : '不安排中途停留');
    return labels;
  }
  function question(raw, candidates) {
    var s = clean(raw), list = candidates || [];
    if (!list.length) return null;
    var stops = Array.from(new Set(list.flatMap(function (c) { return c.legs.slice(1).map(function (l) { return l.from; }); }))).slice(0, 2);
    if (!s.pace && !s.skipped.includes('pace') && list.some(function (c) { return c.kind !== 'direct'; })) return {
      key: 'pace', title: (list.some(function (c) { return c.kind === 'direct'; }) ? '当前有直达方向，也有' : '当前找到') +
        '经' + (stops.join('、') || '沿途城市') + '的走法。你更倾向哪一种？',
      options: [{ label: '省心到达', patch: { pace: 'simple' } }, { label: '沿途多玩一座城', patch: { pace: 'explore' } }, { label: '先看看全部', patch: { pace: 'any' } }]
    };
    if (s.pace === 'explore' && s.nights == null && !s.skipped.includes('nights')) return {
      key: 'nights', title: '如果有值得停留的城市，愿意留几晚？',
      options: [{ label: '停 1 晚', patch: { nights: 1 } }, { label: '停 2 晚', patch: { nights: 2 } }, { label: '先不安排停留', patch: { nights: 0 } }]
    };
    var hasRoad = list.some(function (c) { return c.legs.some(function (l) { return l.mode_guess === 'road'; }); });
    var hasOther = list.some(function (c) { return c.legs.every(function (l) { return l.mode_guess !== 'road'; }); });
    if (s.pace === 'explore' && hasRoad && hasOther && !s.road && !s.skipped.includes('road')) return {
      key: 'road', title: '有些走法含公路客运。比较时，你希望怎么考虑这段体验？',
      options: [{ label: '都愿意了解', patch: { road: 'open' } }, { label: '优先少坐长途车', patch: { road: 'prefer_other' } }, { label: '明确不坐大巴', patch: { road: 'exclude' } }]
    };
    return null;
  }
  function rank(candidates, raw) {
    var s = clean(raw), omitted = 0;
    var ranked = candidates.map(function (c, i) {
      var road = c.legs.some(function (leg) { return leg.mode_guess === 'road'; });
      if (s.road === 'exclude' && road) { omitted++; return null; }
      var score = 0, reason = '';
      if (s.pace === 'simple' && c.kind === 'direct') { score += 30; reason = '符合你优先省心到达的想法'; }
      if (s.pace === 'explore' && c.kind !== 'direct') { score += 20; reason = '可以继续考虑沿途停留'; }
      if (s.road === 'prefer_other' && road) score -= 40;
      if (s.road === 'open' && road) score += 5;
      return { candidate: c, score: score, reason: reason, index: i };
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    return { items: ranked, omitted: omitted };
  }
  function routeKey(c) {
    return JSON.stringify((c && c.legs || []).map(function (l) { return [l.from, l.to, l.mode_guess || '?', l.via || '']; }));
  }
  var api = { clean: clean, parse: parse, summary: summary, question: question, rank: rank, routeKey: routeKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MTGuide = api;
})(typeof window !== 'undefined' ? window : globalThis);
