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
| 行程契约确定性测试 | `node server/check-trip.mjs` | G1 底座回归，无需起服务 |
| G2.5 任意地点规划测试 | `node server/check-anywhere.mjs` | 确定性（注入桩，无网络无 key），v0.30.0 起 |
| CI | push 自动触发 | GitHub Actions 跑 verify + check-pages + check-geo + check-trip + check-anywhere；collect 定时任务需配 Secrets 并设 `LLM_COLLECT=1` |

**提交前必跑（全绿才提交）**：`check-pages` + `check-geo` + `verify` + `check-trip` + `check-anywhere`。

## 1. 协作工作流（硬性流程）

- **所有输出（交互、文档、注释、commit message）一律使用简体中文**，品牌字标（MixTouring）除外。
- **开工前先 `git fetch origin`**：main 可能有其他 agent 的新提交，先 rebase 再动手；实现前先查工作记录最新版本，避免与远端 agent 撞车做重复功能（历史教训，见 §8）。
- 每次产品决策/改动在 `工作记录.md` **倒序**追加版本记录（v0.x.y + 日期 + 背景/改动/影响范围），不删除历史。
- **ZCode 与产品评审交接（v0.26.2 修订：手动触发制）**：ZCode 每次开工前，除本文件和最新版工作记录，还要读取 [产品评审记录 Issue #5](https://github.com/lucashuang-an/MixTouring/issues/5) 的最新评审/决策评论。评审由用户在本对话主动发起（转述 ZCode 提交/PR/变更），Codex 只读评审后在本 Issue 追加以 `Codex 产品评审｜被审 SHA <完整 SHA>` 开头的结论；`需修复`／`阻断` 先处理，再做下一开发卡；修复后由用户转述新的 SHA 触发下一轮。产品/技术方案类决策（如双链路路由、任意地点规划）也以 Issue #5 评论为基准。不使用定时任务、自动工作流或 API 自动唤醒评审。不得在公开 Issue 发布凭据、个人数据或安全敏感复现细节。
- 不主动创建额外说明性 `.md`；新上下文优先沉淀进本文件或工作记录。经用户确认的新产品方案与开发流程以 `产品方案_SoloTrip_v1.2.md`、`开发流程_SoloTrip_v1.2.md` 两份基准文档承载，勿再并行新建零散说明。
- 当前无 LLM key 的环境一切功能照常（规则版闭环）；key 走 `server/.env`（gitignored）：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（OpenAI 兼容端点即可）。G2.5 开放地点核验通道：OSM Nominatim（`OSM_NOMINATIM_BASE` 可覆盖自建镜像）→ Photon（photon.komoot.io）自动兜底，均无需 key；两者都不可达时按「核验通道不可用」诚实阻断。
- LLM 用量逐任务记录在 `server/logs/llm-usage.jsonl`（gitignored），供算法优化分析。

## 2. 项目概览

- **产品方向（v1.2，尚未实现）**：MixTouring —— 面向 Solo Trip 的 AI 旅行助手，先回答起点到终点的交通选择，再自愿扩展多玩一座城市。
- **核心价值**：AI 解释可核验的直达、多程航班、铁路与混搭取舍；假期按一个人的完整总成本判断，直达占优时如实说明。
- **定位**：纯内容与方案产品，**不做买票/交易服务**。
- **首批目标用户**：已有目的地、希望独自安排旅程的 Solo Trip 旅行者；独处、交流、同行分别由用户自愿选择。Web 先行（桌面侧边栏 + 移动端底栏响应式）。
- **当前阶段（2026-09-20）**：旧产品 Phase 1–3 已完成；v1.2 的 G1 行程契约、G2 统一入口与只读探索结果页（trip.html）已交付并收口；G2.5 任意地点规划首卡已交付（候选一律待验证假设，防幻觉契约见 §4.2）。**指定日期可执行往返比较、城市停留完整旅程与社区试点尚未实现**。北京 ⇄ 阿拉木图、2026 国庆附近为第一验证 case；外部证据缺口仍按探索／部分核验处理。
- 开发阶段路线与交接细节见 §6。

## 3. 目录结构

```
MIXTOURING/
├── AGENTS.md / MVP产品文档.md / 工作记录.md / 方案库Schema.md
├── render.yaml + Dockerfile      ← 部署产物（封存备用，国内优先港服）
├── server/                       ← Koa 后端 + 静态服务（data 在 ../pipeline/data）
│   ├── index.mjs                 ← 装载+双校验+geo增强+热重载；全部 API 路由
│   ├── lib/ llm.mjs(parse/ask/copy 唯一LLM出口+用量日志) parse.mjs(触点①) qa.mjs(触点③) wishlist.mjs(队列) trip.mjs(行程契约) trip-service.mjs(G1/G2 行程服务) anywhere.mjs(G2.5 任意地点规划)
│   └── verify.mjs                ← 全接口与 mock 派生逐字节比对
├── pipeline/                     ← 数据生产管道（业务规则的代码权威实现）
│   ├── data/ plans.json(存储层唯一数据源) wishlist.json(心愿队列) cities-geo.json(179城地理事实)
│   ├── lib/ derive.mjs(判级引擎+服务层派生,勿重写) validate-plan.mjs validate-ai-copy.mjs geo-skill.mjs(地理候选技能)
│   ├── build-mock.mjs / generate-plan.mjs(三重守门写回) / generate-ai-copy.mjs / process-wishlist.mjs
│   └── check-pages.mjs / check-geo.mjs
├── mixtouring-hifi/              ← 现有七页 UI 资产 + 前端离线兜底；v1.2 按新规格逐页改造
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
- v1.2 首批面向 Solo Trip；已有国内单程数据／页面继续运行。不得把旧单程结构伪装成国际指定日期往返或实时比价。

### 4.2 数据与方案卡

- **无数据不出可执行卡**：仅有逐段指定日期有效证据时才展示可核验方案卡，禁止编造价格/车次；路线探索与历史参考须显式分级。国际往返去返方向各自核验，不用反转代替返程。
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

1. 本文件 → 2. `产品方案_SoloTrip_v1.2.md`（新产品交互与发布状态）→ 3. `开发流程_SoloTrip_v1.2.md`（gate 与北京—阿拉木图测试）→ 4. `方案库Schema.md`（**旧单程**数据契约）→ 5. `mixtouring-hifi/assets/mock.js`（旧 API 响应契约）→ 6. `pipeline/lib/derive.mjs` + `pipeline/lib/geo-skill.mjs`（旧规则及可复用候选能力）→ 7. `mixtouring-hifi/assets/api.js`（旧接口签名，升级需兼容）→ 8. `MVP产品文档.md`（历史背景）

### 6.2 四阶段路线（Phase 1–3 已完成）

| 阶段 | 状态 |
|---|---|
| Phase 1 薄后端读接口（Koa 包 derive 为服务层，api.js 桩切 fetch） | ✅ v0.6.0 |
| Phase 2 LLM 三触点（①自然语言搜索解析 ②AI 文案生成 ③站内 grounded 问答） | ✅ v0.7.0–0.8.0，真模型 v0.11.x |
| Phase 3 心愿单异步闭环（服务端队列+守门写回+热重载+状态回流+采集执行器） | ✅ v0.9.0 + v0.15.0 |
| Phase 4 数据源正规化（聚合商 API 或策展库扩线） | ⬜ 长期 |

**当前：v1.2 G0 产品与北京—阿拉木图证据取样阶段**——旧产品的 P1 与采集进展见历史工作记录；下一轮依 `开发流程_SoloTrip_v1.2.md` 的 G0–G5 gate 推进。数据取样、国际往返和社区试点不在旧 Phase 1–3 完成范围内。

### 6.3 资产转正映射

| 现有资产 | 开发中角色 |
|---|---|
| `derive.mjs` / `geo-skill.mjs` | 服务层核心，直接复用勿重写 |
| `validate-*.mjs` | 写入路径校验中间件 |
| `plans.json` + 方案库Schema.md | 数据库 schema + 种子数据（换 DB 保持字段形状） |
| `mock.js` | API 响应契约 + 前端离线兜底 |
| `api.js` 桩 | fetch 实现签名基准 |
| 七页原型 | 当前 UI 资产（v1.2 结构级改动按新产品方案实施并留版本记录） |
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
- **行程清单接口边界**：`/api/trip/checklist` 只接收 `{query, strategy_id}`，从服务端样本重取分段；不要将客户端提交的任意 `strategy` 当成已核事实。解析日期窗统一 `YYYY-MM-DD ~ YYYY-MM-DD`，单程检索不得混入返程。
- **淡季混搭未必省钱**：如实展示，AI 文案转向体验价值，勿美化数字。
- **CSS 覆盖三坑**（desktop.css 实战）：页面 body 有内联样式只能 `!important` 覆盖；Tailwind v4 的 `-translate-x-*` 走独立 `translate` 属性；body 内 critical-layout 样式块晚于 head 里的 link，覆盖需提特异性而非靠级联顺序。
- **智谱 glm-4-flash 约束遵循偏弱**：文案生成曾手写数字被守门拦截（拦截即浪费整次调用）；优化方向见工作记录 v0.11.1。
- **fetch 自定义 header 禁止非 ASCII**（v0.31.0 实测）：User-Agent 含中文会抛 `ByteString` TypeError，把 Nominatim/Photon 两通道瞬间全断且难定位——自定义头一律纯英文。
