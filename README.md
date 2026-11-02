<p align="center">
  <img src=".github/assets/mixtouring-banner.svg" alt="MixTouring：一个人，也能走得更远。探索走法，比较取舍，把想去的地方慢慢变成计划。" width="100%">
</p>

<p align="center">
  <a href="https://github.com/lucashuang-an/MixTouring/actions/workflows/verify.yml"><img src="https://github.com/lucashuang-an/MixTouring/actions/workflows/verify.yml/badge.svg?branch=main" alt="工程验证"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.9-397A48?style=flat-square" alt="Node.js ≥ 22.9">
  <img src="https://img.shields.io/badge/%E9%98%B6%E6%AE%B5-%E6%8E%A2%E7%B4%A2%E5%8E%9F%E5%9E%8B-B35E45?style=flat-square" alt="阶段：探索原型">
</p>

<p align="center">
  <strong>独立旅行者的线路发现与规划助手</strong><br>
  探索走法，比较取舍，把想去的地方慢慢变成计划。
</p>

<p align="center">
  <a href="#从一个旅行想法开始">产品体验</a> ·
  <a href="#本地运行">本地运行</a> ·
  <a href="#项目导航">项目导航</a> ·
  <a href="https://github.com/lucashuang-an/MixTouring/issues">反馈问题</a>
</p>

## 为什么做 MixTouring

想去一个地方，往往要在机票、火车、地图和攻略之间来回切换。直达是否合适？换个中转城市会怎样？沿途值得停一下吗？有限的时间和预算，应该花在哪里？

MixTouring 从一次北京去喀什的混合交通旅行中诞生，希望把这些分散的思考放进同一个规划过程：先找到值得考虑的走法，再看清交通、停留和体验之间的取舍。直达更合适时，也如实保留直达。

## 从一个旅行想法开始

> 北京出发去阿拉木图，想兼顾城市和自然，不开车，日期还没定。先帮我看看有哪些走法。

| 规划过程 | 你可以做什么 |
| --- | --- |
| 说出想法 | 输入起终点或一句话，逐步补充日期、预算与交通偏好 |
| 探索走法 | 查看直达与途经城市的候选，比较铁路、飞机等交通组合及待查项 |
| 决定停留 | 在路线基础上考虑沿途停留与目的地玩法；具体内容覆盖随城市而异 |
| 调整草案 | 选择走法，编辑景点、住宿和安排，保留尚未确定的部分 |
| 保存再继续 | 将私人草案保存在当前浏览器，之后从“我的行程”继续规划 |

当前为持续迭代的探索原型。路线候选用于帮助决策；指定日期的班次、价格、接驳及开放信息，需要逐项核实。去程与返程分别取证，历史资料不会自动成为当期事实。项目提供内容与规划，不提供购票或交易。

## 本地运行

需要 **Node.js ≥ 22.9** 和 npm。

```bash
git clone https://github.com/lucashuang-an/MixTouring.git
cd MixTouring
npm ci --prefix server
cd server
npm start
```

打开 [http://localhost:3000/index.html](http://localhost:3000/index.html)。后端同时提供页面和 API，无需另外启动前端构建服务。

### 配置 AI 与搜索

中文搜索可使用同一`DEEPSEEK_KEY`（兼容`DEEPSEEK_API_KEY`），设置`TRAVEL_CHINESE_SEARCH_PROVIDER=deepseek`。当前配置中文优先DeepSeek Search，外文补查继续使用Tavily；DeepSeek失败时在剩余时限内由已配置Tavily补查，空结果和取消不会触发回退，诊断保留两个实际供应商的状态。设置`TRAVEL_SEARCH_PROVIDER=deepseek`也可使其成为默认检索服务。使用DeepSeek官方凭据，不复用火山密钥；搜索摘要仍按search_excerpt进入原有证据核对。接口依据[DeepSeek官方Search文档](https://api-docs.deepseek.com/guides/search/)。

未启用Google Maps时，地图城市定位使用[Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api)与GeoNames，使用英文查询、国家范围与行政层级消歧；模型不提供坐标，未消歧时保留列表。商业服务可配置`OPEN_METEO_API_KEY`走客户域名，并按服务条款部署。会话执行轨迹保存在被Git忽略的`server/logs/agent-trace.jsonl`。

在 `server/` 下新建 `.env`，按使用的服务配置。下列值均为占位符，请替换为账号实际可用的密钥、接口和模型 ID。

```dotenv
# OpenAI 兼容模型通道
LLM_API_KEY=你的模型密钥
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=你的模型ID
TRAVEL_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=你的Tavily密钥
```

火山通道使用 `VOLC_SEARCH_API_KEY`，可通过 `VOLC_COMPOSE_MODEL` 与 `VOLC_SEARCH_MODEL` 分别指定组合和搜索模型。搜索模型未指定时复用组合模型，否则默认使用实测可联网的`deepseek-v4-1-flash-261017`；已知未开放的旧默认`doubao-seed-2-1-lite-260915`直接跳过，不先发失败请求。设置`TRAVEL_SEARCH_PROVIDER=current`可选择既有火山原生搜索路径；`tavily`仍独立选择，不因存在火山密钥而自动改变。通道实现见 [server/lib/llm.mjs](server/lib/llm.mjs)，修改配置后重启服务。

火山适配器保留来源原始summary，单条异常保护上限12,000字符，并记录原长与截断标记；不再固定只取300字。同URL引用优先保留较长摘录，空URL不补造链接。该上限是采集边界，后续相关性、证据和上下文仍按各阶段预算处理，不能把返回摘录当已核实全文。

设置`TRAVEL_SEARCH_MODE=hybrid`启用目的地资料双搜索：中文查询使用已有火山DeepSeek通道，国际体验查询用Tavily（分别需要已有的火山与Tavily凭据）。同一任务按城市分开搜索，最多三个中文城市查询加一个国际查询；单路失败仍记录该路状态，不伪造另一家的成功。缺少对应凭据时沿用主provider配置；不设置hybrid则保持原provider选择。当前改造覆盖`collectTravelSources`目的地资料采集，其他直接交通检索仍遵循主provider设置。

公开网页使用Readability＋linkedom提取正文，不执行网页脚本；体验长文按本轮主题选原句，保留来源与上下文预算。运行前执行`npm ci --prefix server`安装锁定依赖，再重启自己的服务加载新规则和配置。

当天详情可按需加载地点地图。地点取自当前日卡，模型最多提供名称检索提示，实际坐标来自所选地理服务：Google Maps使用Places API，原服务使用OSM/Photon或Overpass；缺失／同名不唯一时保留文字和搜索入口。一次最多8个地点，名称提示最多一次模型调用，服务端总时限35秒；原服务地图快照直接恢复，Google Maps仅恢复地点ID。公共地理服务覆盖和可用性不保证，本机实测国际中文景点仍有缺口；不是逐段导航或完整交通服务验证。点位保留实际provider、OSM对象及采样时间，客户端地图元数据不改变行程保存状态。

主规划 AI 对话需要可用模型；未配置或调用失败时，AI 能力不完整。产品不预置地点或方案，模型或检索不可用时保留输入并提示重试。密钥仅保存在服务端，`.env` 已被 Git 忽略。

### 分支与开发进展

`main` 是本 README 默认对应的代码版本。[codex/ai-conversation](https://github.com/lucashuang-an/MixTouring/tree/codex/ai-conversation) 分支正在迭代主对话、来源与结论关联、上下文和有界补查，具体完成情况与待修项以该分支的工作记录为准。

该开发分支已提供 Tavily 适配，可在其 `server/.env` 中设置 `TRAVEL_SEARCH_PROVIDER=tavily` 和 `TAVILY_API_KEY`；`main` 的配置请以主分支实际代码为准。真实来源覆盖与回答质量仍在验收，工程检查通过不代表旅行信息已经核实。

## 技术与数据

原生 HTML / CSS / JavaScript 构成前端，Node.js ESM 与 Koa 提供服务。路线由本次搜索与AI整合产生，不预置地点、攻略、枢纽或方案；模型调用统一经过服务端出口。

```text
mixtouring-hifi/       页面、交互与设计样式
server/               Koa API、规划服务与回归检查
pipeline/             网页静态检查与历史验证记录（不参与规划）
.github/workflows/    自动化工程验证
```

私人草案目前存于当前浏览器的 `localStorage`，默认私有，不是云端备份。长期偏好等开发能力的范围与授权规则，请查对应版本的产品文档。

## 开发与验证

```bash
# 在仓库根目录执行
node pipeline/check-pages.mjs
node server/check-no-preloads.mjs

# 另一个终端已有服务运行时
node server/verify.mjs
```

`verify` 的确定性基线使用不加载 `.env`、无继承模型或搜索密钥的独立服务：在 `server/` 下以 `node index.mjs` 启动。若端口不同，通过 `PORT` 与 `VERIFY_BASE` 对齐；不要将无密钥断言直接用于已配置真实服务的实例。

完整检查以 [.github/workflows/verify.yml](.github/workflows/verify.yml) 为准。工程回归、真实模型／搜索质量、浏览器体验分别验证。

产品模型的提示词集中维护在根目录 [AGENTS.md](AGENTS.md)，服务端按阶段读取命名规则块；部署时需包含该文件。规则在进程启动时锁定快照，修改后重启服务生效，内容版本会写入上下文清单及模型用量记录。开发流程、命令和协作约定见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 项目导航

| 文档 | 用途 |
| --- | --- |
| [产品方案 Solo Trip v1.2](产品方案_SoloTrip_v1.2.md) | 产品定位、交互约定与范围 |
| [开发流程 Solo Trip v1.2](开发流程_SoloTrip_v1.2.md) | 开发卡、质量门槛与验收 |
| [工作记录](工作记录.md) | 版本演进、验证结果与剩余问题 |
| [Agent运行规则](AGENTS.md) | 产品模型按阶段加载的提示词与行为合同 |
| [开发协作指南](DEVELOPMENT.md) | 开工入口、实现边界与按影响验证 |
| [Issue #5](https://github.com/lucashuang-an/MixTouring/issues/5) | 开发与产品评审决策 |

欢迎通过 [Issues](https://github.com/lucashuang-an/MixTouring/issues) 提供旅行规划中遇到的问题，附上预期行为、实际结果与复现步骤即可。提交改动前请阅读协作指南，并避免上传密钥或私人行程数据。


### 主模型与检索供应商

主模型支持DeepSeek官方直连：在`server/.env`配置`DEEPSEEK_KEY`（兼容`DEEPSEEK_API_KEY`）及`DEEPSEEK_MODEL=deepseek-flash`。配置后优先于火山；失败不自动切回旧账户。结构化请求使用JSON输出与关闭思考模式，继续沿用原取消、用量统计和校验，参见[官方Chat Completions接口](https://api-docs.deepseek.com/api/create-chat-completion/)。模型切换不自动等于搜索切换；当前`TRAVEL_CHINESE_SEARCH_PROVIDER=deepseek`负责中文搜索，`TRAVEL_SEARCH_PROVIDER=tavily`保留外文及其他补充检索。更改.env后重新启动自己的服务实例。

### Google Maps地点服务

主规划现已使用地图观察检查活动之间的交通，并可尝试同日既有活动重排；只有新路段查询显示参考耗时下降才采用，固定时序与团安排不自动重排。当天地图可展开“核对当天时间安排”，填写出发／结束时间、停留分钟、可选地点及首末地点后，按连续时间链查询；缺首末段时只判断已标注活动。参考数值不写入攻略正文，完整初稿不等于指定日期交通已核实。

生产对话支持本机检查点及幂等请求。检查点存放于git忽略的`server/logs/planning-checkpoints/`，只保留用户结构，恢复时重新查询证据；24小时内且请求／规则版本匹配才复用。超时只中断运行，不把任务标为完成；交通核对阶段中断时可保留已通过正文核验的初稿。详见[实施映射](docs/mixtouring-architecture.md#d1d4实施映射2026-10-30)。

设置`MAP_PROVIDER=google`与服务端`GOOGLE_MAPS_API_KEY`后，行程城市定位与当天地点查询使用Places API (New) Text Search；只配置Google密钥而未指定provider时也选择Google。保留`MAP_PROVIDER=open`可明确使用原Open-Meteo／OSM路径。Google请求失败不伪装成OSM成功。Places与Routes密钥通过X-Goog-Api-Key请求头发送；Static图片请求由下述服务端代理处理。密钥不进入页面、地图链接或日志。

需要代理时可设置`GOOGLE_MAPS_PROXY_URL=http://127.0.0.1:端口`，仅影响Google请求；使用已有代理且保持TLS校验，不修改模型与搜索服务出口。Undici代理适配作为明确依赖加入package-lock。

页面显示Google Maps署名及精确Place ID地点入口，地图内容在Google Maps打开；不将Google地点叠加到OSM底图，也不向浏览器暴露服务端密钥。已启用Google Maps Static底图：图片由服务端代理请求，浏览器仅访问本地图片接口，密钥不进入页面；保留完整Google与数据供应商署名，图片不落盘并使用no-store响应。已接入Routes API地点间交通参考：按日卡地点出现顺序查询公交、步行或车行距离／时长，默认公交，可指定参考出发时刻。车行只提供不含实时路况的打车／接送参考，不等于用户自驾。各段独立查询，合计不含游览停留与未标注首末段；没有路线或查询失败时保持未知，不用直线距离推算。路线时长不写入私人草案快照。Google原始坐标、名称与营业状态不写入私人草案快照，只保留用户自己的地点名与Place ID；恢复后的日地图由用户点击时重新查询。API参考：[Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search)、[Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)、[Places展示与存储要求](https://developers.google.com/maps/documentation/places/web-service/policies)。


### 本机运行与恢复边界

服务默认绑定127.0.0.1，通过PORT选择端口；只有明确需要其他绑定地址时才设置MIXTOURING_HOST。healthz和/api/capabilities中的runtime_version标识启动时的后端代码与依赖，agent_rules_version标识当前规则快照，均不包含环境或密钥数据。

server/.state保存本机规划授权签名密钥，应与私人应用状态一同保管，不作为日志清理，也不能入Git。server/logs/planning-checkpoints按24小时过期清理；诊断JSONL默认8MiB轮转并保留3份档案。自动清理不处理浏览器中已保存的旅行、版本和偏好。

JSON提交上限2MiB、提交超时30秒；对话客户端等待上限150秒、响应上限8MiB。这些是传输与资源边界，不是旅行天数上限。当前优先完善1—20天常规体验，20天以上的新增优化暂缓。


### 缓存观测与候选布局

模型尝试用量写入server/logs/llm-usage-v2.jsonl；MT_LLM_USAGE_LOG可指定独立输出路径，工程测试请重定向到临时测试日志，避免污染成本基线。缺失／矛盾缓存计量保留unknown／invalid，未得到usage的失败不按零成本统计。

只读汇总：`node server/report-model-usage.mjs --input=server/logs/llm-usage-v2.jsonl --out=私有汇总.json`。可选--rates=价格快照.json，按provider|requested_model配置hit/miss/output每百万token单价及currency/version/basis；未提供完整数据时总费用保持未知。

MT_CACHE_LAYOUT_EXTRACT与MT_CACHE_LAYOUT_PATCH默认baseline，cache_v1为候选布局；healthz／capabilities显示有效配置，按启动快照读取。当前A/B未通过全部质量和延迟门槛，两个开关应继续保持baseline。实验入口为`node --env-file=server/.env server/replay-cache-layout.mjs --live --out=私有目录`，可选--stage=extract或patch；该命令会调用模型，仅在明确需要实网验收时运行。
