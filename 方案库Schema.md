# 方案库 Schema · v0.1

> MixTouring 阶段 1 · P0 交付物。定义方案库（核心数据资产）的存储结构、服务层映射与 AI 文案规范。
> 前端契约不变：`api.js` 四接口的输出形状与本文档「服务层映射」一致，UI 零改动。

---

## 1. 设计原则

1. **数字只来自字段**：价格、时刻、时长等一切数字在存储层为结构化数值；AI 文案中的数字用 `{placeholder}` 占位，渲染时插值。LLM 只写叙述，永不生成数字（防幻觉红线）。
2. **存储层 ≠ 服务层**：存储层机器友好（分钟数、数值区间、ISO 时间）；服务层与现有前端消费形状一致（`'¥1,180–1,350'`、`'总 24h'`），字符串由服务端按 §6 规则格式化。
3. **无数据不出卡**：方案仅当其全部 `segs` 具备有效价格（火车段 `fixed_price` 或机票段未过期 `price_band`）时才可被 `planSearch` 返回。

## 2. 实体关系

```
RoutePair 1───1 DirectFlight（直飞基准）
         1───n Plan（方案）
                1───n Stop（途经城市，城市级展示）
                1───n Segment（分段，含 PriceSample）
                1───4 RiskFactor（核心四因子，各一）+ 0..n advisory
                1───1 AICopy（AI 解读，P0）
                0───1 PlayNote（中转城市玩法）
Template = Plan + 社区字段（badge/region/contributor/rating/walkers/img）
Feedback（回填实测，独立表，P0 不动结构）
```

## 3. 枚举与通用约定

| 字段 | 取值 |
|---|---|
| `mode` | `train` / `plane`（预留 `bus` / `ship` / `intl_flight`） |
| `level` | `低` / `中` / `高`（映射绿 #34C759 / 琥珀 #FBBF24 / 红 #E11D48） |
| `factor` | `connection`（衔接余量）/ `baggage`（行李直挂）/ `refund`（退改规则）/ `transfer`（接驳距离）/ `advisory`（线路特殊提示） |
| `region` | `西部` / `西南` / `东北` / `海南`（可扩） |
| `ai.status` | `draft` → `verified`（数字校验通过）→ `published` |
| 时间 | 存储 `HH:MM` + `day_offset`（0=当日，1=次日）；ISO 时间戳一律带时区 |
| 金额 | 存储为整数（元），服务层格式化为 `'¥1,180'` |

## 4. 核心 Schema

### 4.1 RoutePair（路线对）

```json
{
  "route_id": "北京-喀什",
  "from": "北京",
  "to": "喀什",
  "direct": {
    "price": 2480,
    "duration_min": 380,
    "sampled_at": "2026-09-05T22:00:00+08:00",
    "source": "manual_sample"
  },
  "plan_ids": ["p-bjks-1", "p-bjks-2", "p-bjks-3"],
  "updated_at": "2026-09-05T22:00:00+08:00"
}
```

- `route_id` = `{from}-{to}`，与 `api.js planSearch` 的查库键一致。
- `direct` 为直飞基准价（单值采样），用于计算 `saved = direct.price − plan.price_mid`。
- `updated_at` 驱动前端页脚「估算价格样本 · 更新于 X 小时前」。

### 4.2 Plan（方案）

```json
{
  "id": "p-bjks-1",
  "type": "plan",
  "route_id": "北京-喀什",
  "from": "北京",
  "to": "喀什",
  "total_min": 1440,
  "price_min": 1180,
  "price_max": 1350,
  "price_mid": 1266,
  "saved": 1214,
  "stops": [
    { "city": "北京", "kind": "origin", "depart": "21:30", "day_offset": 0 },
    { "city": "银川", "kind": "transfer", "wait_min": 113 },
    { "city": "阿克苏", "kind": "transfer", "wait_min": 100 },
    { "city": "喀什", "kind": "dest", "arrive": "20:47", "day_offset": 1 }
  ],
  "segs": ["seg 对象数组，见 4.3"],
  "risks": ["risk 对象数组，见 4.4"],
  "play": { "city": "银川", "lines": ["若改签到次日航班", "镇北堡西部影城（市区打车 40 分钟）"] },
  "ai": { "见 4.5": "P0 核心" },
  "freshness": { "price_updated_at": "2026-09-05T22:00:00+08:00", "schedule_verified_at": "2026-09-01T00:00:00+08:00" }
}
```

- `modes`（`['train','plane']`）不入库，服务层从 `segs[].mode` 去重派生。
- `price_mid` = 各段价格中值求和；`saved` = 所属 RoutePair 的 `direct.price − price_mid`，入库时计算，不手写。

### 4.3 Segment（分段）与 PriceSample（价格样本）

```json
{
  "seg_id": "p-bjks-1#s2",
  "mode": "plane",
  "from_station": "银川河东",
  "to_station": "阿克苏",
  "depart": "10:05",
  "arrive": "13:40",
  "day_offset": 1,
  "duration_min": 215,
  "fixed_price": null,
  "price_band": { "min": 780, "max": 920, "sample_count": 6, "sampled_at": "2026-09-05T22:00:00+08:00" }
}
```

- **火车段**：票价固定定价 → 用 `fixed_price`（整数），`price_band` 为 `null`；时刻表低频维护。
- **机票段**：用 `price_band`，由 `price_samples` 聚合（取近 14 天样本的 P20/P80 为 min/max），样本表：

```json
{ "seg_ref": "银川河东-阿克苏", "price": 830, "source": "llm_agent:ctrip", "sampled_at": "2026-09-05T22:00:00+08:00" }
```

- `source` 记录采样渠道（`llm_agent:{平台}` / `manual_sample` / `api:{供应商}`），用于审计与质量回溯。
- 价格带过期策略：`sampled_at` 超过 72h 未更新 → 该段视为无有效数据 → 方案不出卡（原则 3）。

### 4.4 RiskFactor（风险因子）

**每个方案必须含核心四因子（`connection`/`baggage`/`refund`/`transfer`）各一条，`advisory` 可选多条**（如轮渡提示、高原提示）。

```json
{
  "factor": "connection",
  "level": "中",
  "raw": { "wait_min": 113, "same_station": true, "transfer_km": 18, "transfer_min": 40 },
  "title": "衔接时间余量 · 银川 1h53m",
  "lines": ["同站转场 1–2 小时，判黄", "误机将错过每日 2 班的航班"]
}
```

- `raw` 为该因子的**结构化原始值**（判级依据，可审计）；`title`/`lines` 为服务层展示文本，由判级规则模板生成、LLM 仅可润色叙述部分。
- 判级规则表（初始版，运营可调）：

| factor | 绿（低） | 黄（中） | 红（高） |
|---|---|---|---|
| `connection` | 同站且余量 ≥2h | 同站 1–2h，或跨站扣接驳后余量 ≥1h | 扣接驳后余量 <1h |
| `baggage` | 全程火车 | 火车转飞机（需自取再托运） | 多次取托 |
| `refund` | 全火车段可退 | 含特价舱机票（改期费高） | 不可退改段为主 |
| `transfer` | 同站换乘 | ≤20km 或轨交直达 | >30km 或多段接驳 |

- `advisory` 无判级规则表，由运营/LLM 按线路特征撰写，`level` 仅表提示强度。

### 4.5 AICopy（AI 解读 · P0 核心）

```json
{
  "ai": {
    "summary": "火车混搭飞机，比直飞省 {saved}，银川中转还能逛夜市",
    "fit": "适合时间充裕、想省大钱的背包客；不适合带大件行李赶路的人",
    "notice": "银川转机窗口 {wait_min_1}，下火车直奔机场巴士最稳",
    "play_intro": "若改签到次日航班，镇北堡西部影城值得专门留半天",
    "status": "verified",
    "model": "claude-sonnet-4.5-20260201",
    "generated_at": "2026-09-05T22:30:00+08:00",
    "verified_at": "2026-09-06T10:00:00+08:00"
  }
}
```

- **占位符白名单**：`{saved}` `{price_min}` `{price_max}` `{price_mid}` `{total_time}` `{direct_price}` `{from}` `{to}` `{transfer_city_N}` `{wait_min_N}`（N 为中转序号）。渲染时插值；除此之外文案中**禁止出现任何数字**。
- **校验（draft→verified）**：自动校验器扫描文案，所有数字必须能匹配到白名单字段插值结果，否则打回重生成；`verified` 后才允许上线展示。
- `summary` 用于方案卡/模板卡一句话；`fit`/`notice`/`play_intro` 用于详情页「AI 解读」卡。
- `play.lines` 现阶段人工维护，后续可由同一管道生成（同样走占位符校验）。

### 4.6 Template（社区模板 = Plan 超集）

在 Plan 全字段上追加：

```json
{
  "id": "tpl-001",
  "type": "tpl",
  "badge": "官方精调",
  "region": "西部",
  "contributor": "@大漠孤烟",
  "rating": 4.8,
  "walkers": 12,
  "img": "assets/route-kashgar.jpg",
  "desc": "火车混搭飞机，省 ¥1,214，银川中转可玩"
}
```

- `desc` 与 `ai.summary` 二选一展示（模板卡优先 `desc`，人工精调文案）。
- 「一键复用」只读 `stops`/`segs` 结构，按用户日期重新匹配 `price_band`（硬约束）。

## 5. Feedback（回填实测，现状保持）

```json
{ "id": "p-bjks-1", "segs": ["银川转机实际用了 1h40m", "机票实付 ¥850"], "note": "整点机场巴士人多", "ts": 1788700000000 }
```

- P0 不改结构；当前存 localStorage，后端上线后原样迁移，仅加 `user_id`（账号体系上线时，可空）。

## 6. 存储层 → 服务层映射规则

| 服务层字段（前端现消费） | 格式化规则 |
|---|---|
| `totalTime: '总 24h'` | `total_min` → `总 {h}h`（有余分钟补 `{m}m`） |
| `price: '¥1,180–1,350'` | min≠max 用 en dash 区间；min==max 显示单值 `'¥890'` |
| `saved: '省 ¥1,214'` | `省 ¥{saved}`，千分位 |
| `stops[].sub` | origin=`{depart}`；transfer=`停 {h}h{m}m`；dest=`D{day_offset+1} {arrive}` |
| `segs[].dur: '10h42m'` | `duration_min` → `{h}h{m}m` |
| `segs[].price: '¥780–920'` | 火车段 `'¥{fixed_price}'`；机票段区间规则同上 |
| `segs[].arrNote: '次日'` | `day_offset≥1` 时输出 `'次日'`（D3 及以上扩展 `'第三日'`，MVP 用不到） |
| `direct.price/time/note` | `'¥{price}'` / `{h}h{m}m` / `'直飞基准 · {from} ⇄ {to}'` |

四接口映射：`planSearch({from,to})` → 查 `route_id`；`fetchTemplates({region})` → `type=tpl` 过滤；`fetchItem({id})` → Plan 或 Template；`postFeedback` → §5。返回体沿用 `{ data, delay }` 形状。

## 7. P0 落地清单（下一步）

1. 按本 schema 规范化 `mock.js` 现有 8 个 Plan/Template（重点：risks 补齐核心四因子、advisory 单列；price 拆 min/max）
2. 离线生成脚本：读方案库 JSON → LLM 生成 `ai.*` → 占位符校验器 → `verified` 入库
3. detail.html 加「AI 解读」展示卡（`fit`/`notice`/`play_intro`，渲染时插值），results.html 方案卡挂 `summary`
4. 判级规则表 v1 写进生成脚本，risks 的 `title`/`lines` 改由规则模板产出

---

*v0.1 · 2026-09-06 · 阶段 1 P0 交付物，待评审*
