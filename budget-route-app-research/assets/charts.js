(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  function baseTooltip() {
    return { trigger: 'axis', appendToBody: true, textStyle: { color: ink } };
  }

  // --- Chart 1: 国内旅游总量 ---
  var c1 = echarts.init(document.getElementById('chart-volume'), null, { renderer: 'svg' });
  c1.setOption({
    animation: false,
    tooltip: baseTooltip(),
    legend: { data: ['国内出游人次（亿）', '国内出游总花费（万亿元）'], textStyle: { color: muted }, top: 0 },
    grid: { top: 60, left: 60, right: 70, bottom: 40 },
    xAxis: {
      type: 'category', data: ['2024年', '2025年'],
      axisLabel: { color: ink, fontSize: 13 }, axisLine: { lineStyle: { color: rule } }
    },
    yAxis: [
      { type: 'value', name: '亿人次', nameTextStyle: { color: muted }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } } },
      { type: 'value', name: '万亿元', nameTextStyle: { color: muted }, axisLabel: { color: muted }, splitLine: { show: false } }
    ],
    series: [
      {
        name: '国内出游人次（亿）', type: 'bar', data: [56.15, 65.22], barWidth: 44,
        itemStyle: { color: accent, borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: accent, fontWeight: 600 }
      },
      {
        name: '国内出游总花费（万亿元）', type: 'bar', yAxisIndex: 1, data: [5.75, 6.30], barWidth: 44,
        itemStyle: { color: accent2, borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: accent2, fontWeight: 600 }
      }
    ]
  });
  window.addEventListener('resize', function () { c1.resize(); });

  // --- Chart 2: 大学生单次旅行预算分布 ---
  var c2 = echarts.init(document.getElementById('chart-budget'), null, { renderer: 'svg' });
  c2.setOption({
    animation: false,
    tooltip: baseTooltip(),
    grid: { top: 30, left: 110, right: 60, bottom: 30 },
    xAxis: { type: 'value', name: '占比（%）', nameTextStyle: { color: muted }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } } },
    yAxis: {
      type: 'category', data: ['6000元以上', '2000–4000元', '低于2000元'],
      axisLabel: { color: ink, fontSize: 13 }, axisLine: { lineStyle: { color: rule } }
    },
    series: [{
      type: 'bar', data: [5.2, 54.7, 28.1], barWidth: 30,
      itemStyle: {
        borderRadius: [0, 4, 4, 0],
        color: function (p) { return p.dataIndex === 1 ? accent : accent2; }
      },
      label: { show: true, position: 'right', color: ink, fontWeight: 600, formatter: '{c}%' }
    }]
  });
  window.addEventListener('resize', function () { c2.resize(); });

  // --- Chart 3: 低成本航空市场份额对比 ---
  var c3 = echarts.init(document.getElementById('chart-lcc'), null, { renderer: 'svg' });
  c3.setOption({
    animation: false,
    tooltip: baseTooltip(),
    grid: { top: 30, left: 70, right: 40, bottom: 40 },
    xAxis: {
      type: 'category', data: ['中国', '欧洲', '美国'],
      axisLabel: { color: ink, fontSize: 13 }, axisLine: { lineStyle: { color: rule } }
    },
    yAxis: { type: 'value', name: '市场份额（%）', nameTextStyle: { color: muted }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } } },
    series: [{
      type: 'bar', data: [12.5, 25, 35], barWidth: 52,
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: function (p) { return p.dataIndex === 0 ? accent2 : accent; }
      },
      label: { show: true, position: 'top', color: ink, fontWeight: 600, formatter: '{c}%' }
    }]
  });
  window.addEventListener('resize', function () { c3.resize(); });

  // --- Chart 4: 回旋镖机票 vs 整体均价 ---
  var c4 = echarts.init(document.getElementById('chart-saving'), null, { renderer: 'svg' });
  c4.setOption({
    animation: false,
    tooltip: baseTooltip(),
    grid: { top: 40, left: 70, right: 40, bottom: 40 },
    xAxis: {
      type: 'category', data: ['中转玩法「回旋镖机票」\n单航段均价', '同期机票整体\n单航段均价'],
      axisLabel: { color: ink, fontSize: 12, interval: 0 }, axisLine: { lineStyle: { color: rule } }
    },
    yAxis: { type: 'value', name: '元/航段', nameTextStyle: { color: muted }, axisLabel: { color: muted }, splitLine: { lineStyle: { color: rule } } },
    series: [{
      type: 'bar', data: [356, 640], barWidth: 64,
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: function (p) { return p.dataIndex === 0 ? accent : muted; }
      },
      label: { show: true, position: 'top', color: ink, fontWeight: 700, formatter: '{c} 元' },
      markLine: {
        symbol: 'none',
        lineStyle: { color: accent2, type: 'dashed' },
        label: { color: accent2, fontWeight: 700, formatter: '中转便宜约 44%' },
        data: [[{ coord: [0, 356] }, { coord: [1, 640] }]]
      }
    }]
  });
  window.addEventListener('resize', function () { c4.resize(); });
})();
