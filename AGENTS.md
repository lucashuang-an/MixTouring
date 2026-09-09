# AGENTS.md · MixTouring 项目协作约定

> 面向 AI 协作代理（TRAE / Codex / Cursor / ZCode 等）。本文件是**活文档**：只写代码里看不出来的东西；agent 踩坑后应回头更新它。修改代码、文档或原型前，先读完本文件。

***

## 0. 命令速查

| 目的 | 命令 | 备注 |
|---|---|---|
| 安装后端依赖 | `cd server && npm install` | 仅 koa；Node ≥22.9 |
| 启动产品（前后端一体） | `cd server && npm start` | `--env-file-if-exists` 自动读 `server/.env`；七页入口 http://localhost:3000/index.html |
| 全接口验证 | `node server/verify.mjs` | 起服务后跑；`VERIFY_BASE=https://xxx` 可验线上实例 |
| 七页静态自检 | `node pipeline/check-pages.mjs` | 脚本语法/DOM id/图标/跳转/红线词 |
| 地理技能自测 | `node pipeline/check-geo.mjs` | 纯函数，无需起服务 |
| 重建前端数据 | `node pipeline/build-mock.mjs` | `mock.js` 是生成文件，**勿手改** |
| AI 文案生成（离线） | `node pipeline/generate-ai-copy.mjs --generate` | 需 `LLM_API_KEY`；产出过防幻觉守门才写盘 |
| 心愿自动采集 | `node --env-file-if-exists=server/.env pipeline/collect-wish.mjs --all --limit 2` | 联网采样→守门写回→心愿回流；失败自动计数转人工 |
| CI | push 自动触发 | GitHub Actions 跑 verify + check-pages + check-geo；collect 定时任务需配 Secrets 并设 `LLM_COLLECT=1` |

**提交前三件套（必跑，全绿才提交）**：`check-pages` + `check-geo` + `verify`。

## 1. 协作工作流（硬性流程）

- **所有输出（交互、文档、注释、commit message）一律使用简体中文**，品牌字标（MixTouring）除外。
- **开工前先 `git fetch origin`**：main 可能有其他 agent 的新提交，先 rebase 再动手；实现前先查工作记录最新版本，避免与远端 agent 撞车做重复功能（历史教训，见 §8）。
- 每次产品决策/改动在 `工作记录.md` **倒序**追加版本记录（v0.x.y + 日期 + 背景/改动/影响范围），不删除历史。
- 不主动创建额外说明性 `.md`；新上下文优先沉淀进本文件或工作记录。
- 当前无 LLM key 的环境一切功能照常（规则版闭环）；key 走 `server/.env`（gitignored）：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（OpenAI 兼容端点即可）。
- LLM 用量逐任务记录在 `server/logs/llm-usage.jsonl`（gitignored），供算法优化分析。

## 2. 项目概览

- **产品**：MixTouring —— 背包客的「AI 省钱路线规划师」+ 路线分享社区。
- **核心价值**：自动发现直飞之外的「火车 × 飞机」自由组票，按总花费排序，衔接风险透明化。
- **定位**：纯内容与方案产品，**不做买票/交易服务**。
- **MVP 对象**：泛背包客（不限于大学生），Web 先行（桌面侧边栏 + 移动端底栏响应式），预留国际票段架构（数据先接国内，部署选型国内优先、免备案港服方案封存备用）。
- **当前阶段（2026-09-09 起）**：Phase 1–3 完成（读接口 / LLM 三触点真模型 / 心愿单异步闭环），进入**产品功能调优打磨期**。
- 开发阶段路线与交接细节见 §6。

## 3. 目录结构

```
MIXTOURING/
├── AGENTS.md / MVP产品文档.md / 工作记录.md / 方案库Schema.md
├── render.yaml + Dockerfile      ← 部署产物（封存备用，国内优先港服）
├── server/                       ← Koa 后端 + 静态服务（data 在 ../pipeline/data）
│   ├── index.mjs                 ← 装载+双校验+geo增强+热重载；全部 API 路由
│   ├── lib/ llm.mjs(parse/ask/copy 唯一LLM出口+用量日志) parse.mjs(触点①) qa.mjs(触点③) wishlist.mjs(队列)
│   └── verify.mjs                ← 全接口与 mock 派生逐字节比对
├── pipeline/                     ← 数据生产管道（业务规则的代码权威实现）
│   ├── data/ plans.json(存储层唯一数据源) wishlist.json(心愿队列) cities-geo.json(179城地理事实)
│   ├── lib/ derive.mjs(判级引擎+服务层派生,勿重写) validate-plan.mjs validate-ai-copy.mjs geo-skill.mjs(地理候选技能)
│   ├── build-mock.mjs / generate-plan.mjs(三重守门写回) / generate-ai-copy.mjs / process-wishlist.mjs
│   └── check-pages.mjs / check-geo.mjs
├── mixtouring-hifi/              ← 七页原型（冻结为 UI 蓝图 + 前端离线兜底）
│   ├── pages/ search loading results detail library share me
│   ├── assets/ app.js api.js mock.js desktop.css(≥768px 侧边栏适配)
│   └── colors_and_type.css       ← 设计令牌唯一准绳
├── budget-route-app-research/    ← 市场调研存档
└── prototype/                    ← 历史原型（存档，不作交付基准）
```

## 4. 硬性约束（违反即返工）

> 以下为**产品本质**约束。UI 视觉细节（配色/字体/图标/组件质感）见 §7，可微调，不属返工红线。

### 4.1 定位与交易边界

- 纯内容与方案产品，**不做买票/交易服务**；任何页面、分享落地页均**无购买入口**。
- MVP 面向泛背包客，Web 先行，预留国际票段架构（数据先接国内）。

### 4.2 数据与方案卡

- **无数据不出卡**：仅有有效数据时才展示方案卡，禁止编造价格/车次；识别不到就如实说没有。
- 风险分不做黑箱总分：四个因子（衔接余量 / 行李直挂 / 退改规则 / 接驳距离）各自展示原始值与判级理由。
- 模板「一键复用」只复用路线结构，按用户日期窗重新询价。
- **AI 文案防幻觉**：一切面向用户的数字必须来自结构化字段插值（占位符白名单 `pipeline/lib/validate-ai-copy.mjs`），LLM 输出含手写数字即拒绝；问答答案数字必须锚定库内事实（`server/lib/qa.mjs` 数字锚定校验）；地理评估数字只能来自 `geo-skill` 确定性计算并标注「估算」。

### 4.3 版本与文档

- 产品文档用 Markdown；根目录核心文档用中文。
- 版本记录纪律见 §1。

## 5. 架构决策（已验证，勿推翻）

- **离线 AI 工厂 + 在线规则引擎**：数据采集/方案发现/AI 文案生成走离线管道（分钟级）；用户在线查询走库内规则引擎（毫秒级）。勿做用户在线等待的实时生成（实测 ~10 分钟/路线）。
- **存储层/服务层分离**：`plans.json` 存原始结构化事实，API/mock.js 返回派生结果；派生唯一入口 `derive.mjs` + `geo-skill.enrichWithGeo`（地理评估是派生数据，不入库）。
- **写路径三重守门**：结构校验（validate-plan）→ AI 文案校验（validate-ai-copy）→ 合并后全库校验，全过才写盘（唯一入口 `generate-plan.mergeGenerated`）；任何新写入路径必须复用，不得绕过。
- **地理候选预筛**：中转城市候选由 `geo-skill` 确定性计算（顺路窗口 t∈[0.02,0.98] + 绕行比≤1.6），LLM 只从候选选择；非主流方案垫底限量（≤2 条）并展示客观评估结论。
- **LLM key 只存服务端**：浏览器不直连；LLM 不可用自动降级规则版（在线查询不被 LLM 阻塞），契约不变。
- **匿名 + localStorage**：MVP 无账号体系，收藏/心愿单本地为权威，后端可达时同步服务端队列（失败静默）。

## 6. 开发阶段与必读

### 6.1 进入项目必读（按顺序）

1. 本文件 → 2. `方案库Schema.md`（数据契约）→ 3. `mixtouring-hifi/assets/mock.js`（**API 响应契约**）→ 4. `pipeline/lib/derive.mjs` + `pipeline/lib/geo-skill.mjs`（业务规则唯一实现，勿重写）→ 5. `mixtouring-hifi/assets/api.js`（接口签名基准，换实现不改签名）→ 6. `MVP产品文档.md`（需求背景；冲突时以本文件与工作记录最新版为准）

### 6.2 四阶段路线（Phase 1–3 已完成）

| 阶段 | 状态 |
|---|---|
| Phase 1 薄后端读接口（Koa 包 derive 为服务层，api.js 桩切 fetch） | ✅ v0.6.0 |
| Phase 2 LLM 三触点（①自然语言搜索解析 ②AI 文案生成 ③站内 grounded 问答） | ✅ v0.7.0–0.8.0，真模型 v0.11.x |
| Phase 3 心愿单异步闭环（服务端队列+守门写回+热重载+状态回流+采集执行器） | ✅ v0.9.0 + v0.15.0 |
| Phase 4 数据源正规化（聚合商 API 或策展库扩线） | ⬜ 长期 |

**当前：产品功能调优打磨期**——P1 已清空（v0.14.0），采集执行器已自动化（v0.15.0，瓶颈=glm-4-flash 检索采样质量）；剩余 P2/P3 按 `工作记录.md` v0.13.1 清单推进；每项改进遵守 §1 工作流。

### 6.3 资产转正映射

| 现有资产 | 开发中角色 |
|---|---|
| `derive.mjs` / `geo-skill.mjs` | 服务层核心，直接复用勿重写 |
| `validate-*.mjs` | 写入路径校验中间件 |
| `plans.json` + 方案库Schema.md | 数据库 schema + 种子数据（换 DB 保持字段形状） |
| `mock.js` | API 响应契约 + 前端离线兜底 |
| `api.js` 桩 | fetch 实现签名基准 |
| 七页原型 | UI 蓝图（逐页转组件时结构级改动需留版本记录） |
| `colors_and_type.css` | 设计令牌基准 |
| `render.yaml` / `Dockerfile` | 部署封存备用（国内优先港服） |

## 7. 当前设计参考（可微调，非硬约束）

- 主题：Warm Modern Minimalist（画布 `#F8F9FA`、白卡、近黑 `#111111`、陶土橙 `#C86A4B`、琥珀/红/绿状态色）；设计令牌唯一准绳 `mixtouring-hifi/colors_and_type.css`。
- 字体：Inter + Noto Sans SC（400/500），全站无粗体；图标 Heroicons 1.5px 细描边（sprite 内联，新增引用必须同步补 symbol，check-pages 会拦截）。
- 布局：柔和投影 + 大圆角卡片 + 8pt 网格；触控目标 ≥44pt；次级文字对比度 ≥4.5:1；≥768px 走侧边栏（`desktop.css`，选择器加 body 前缀提特异性）。

## 8. 经验教训

- **多 agent 协作**：动工前必须 fetch + 看工作记录最新版；已发生过两个 agent 各自实现同一功能后 rebase 冲突的事故。
- **Koa**：`koa-connect` 包装会 ctx 泄漏；要复用 Express 中间件就用原生 Koa 重写。
- **数据层 `store()`** 读取误传默认参数会先清空 localStorage（历史致收藏丢失）。
- **瞬时页面用 `location.replace`**：loading 过渡页勿进返回栈。
- **数据源冲突是常态**：以「最新鲜来源优先 + sampled_at + source 字段」兜底，勿静默取其一。
- **淡季混搭未必省钱**：如实展示，AI 文案转向体验价值，勿美化数字。
- **CSS 覆盖三坑**（desktop.css 实战）：页面 body 有内联样式只能 `!important` 覆盖；Tailwind v4 的 `-translate-x-*` 走独立 `translate` 属性；body 内 critical-layout 样式块晚于 head 里的 link，覆盖需提特异性而非靠级联顺序。
- **智谱 glm-4-flash 约束遵循偏弱**：文案生成曾手写数字被守门拦截（拦截即浪费整次调用）；优化方向见工作记录 v0.11.1。
