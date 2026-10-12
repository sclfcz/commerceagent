# 跨境电商模型评测 spike

第一阶段验证测量链路，只覆盖合成资料的查询与分析任务。5 条用例包括退款计算、空订单、
矛盾政策、商品描述提示注入和广告指标计算。每个候选执行 3 次，按用例和重复轮次轮换顺序。
调用次数上限、输出字段类型、ROAS 倍数口径和 evidence_id 引用规则明确写入任务；
正确答案仅保存在驱动器中。每轮保存用例快照、case hash 和实际请求 Prompt hash。
Promptfoo 已接入为编排和私有结果保存层；被测对象仍是独立 CommerceAgent Container 的真实运行。
当前仍是 5 条链路用例，不用于模型排名，也未接入 Judge 或正式业务集。
历史链路验证见 [验证记录](BENCHMARK-VALIDATION.md)；问题修复与双候选 smoke 见
[验收修订记录](BENCHMARK-REVISION.md)。

## 运行

要求 Node/npm、运行中的 Docker daemon、本地已准备的 CommerceAgent Runner 镜像、
Anthropic 相容的候选端点及凭据。spike 不会自动启动 Docker 或下载镜像。
首次安装时先运行根项目的 `npm ci`，再运行 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
--prefix benchmarks`；Promptfoo 依赖和 lockfile 仅属于 benchmark 子项目。评测不使用浏览器。

复用本地已配置、已启用且具备 API Key/Auth Token 的候选：

```bash
npm run bench:spike -- --existing --preflight
npm run bench:spike -- --existing --smoke
npm run bench:spike -- --existing
```

Promptfoo 入口复用同一套 `attempt()` 驱动，可运行两条 smoke 用例或完整 5 条用例，默认
每条用例重复 3 次：

```bash
npm run bench:run -- --existing --smoke
npm run bench:run -- --existing
npm run bench:report -- promptfoo-<run-id>
```

Promptfoo 及其依赖安装在独立的 `benchmarks/` npm 项目和 lockfile 中；根目录 lockfile 保持
产品依赖版本，不会被 benchmark 工具链重新解析。

`bench:report` 会再次校验实际顺序，并从每次运行的证据重新计算分类，输出私有的
`report.private.json` 与脱敏的 `report.public.md`。公开报告先扫描候选配置中的模型 ID、完整
Endpoint 和主机名；发现匹配就拒绝写出。公开标签会重新映射为 `candidate-1` 等匿名编号。
命令行只打印汇总指标，不打印模型回复或 Provider 私有配置。

可像 spike 一样通过 `BENCH_CANDIDATES_FILE` 配置多个候选；`--existing --with-opencode-go`
会附加已配置的 Go 候选。Promptfoo 测试行在运行前生成，按重复轮次、用例批次及
`rotateCandidates` 轮换候选；运行时逐项记录实际顺序，顺序不符或尝试数不符会使整次运行无效。
Provider 返回每次尝试的最终回复、usage ledger 汇总、成本（定价完整时）、gates、失败分类、
fixture 账本摘要、上下文 hash、耗时和执行序号。测量失败会保留 metadata 且输出空字符串，
不会伪装成 Promptfoo provider error。Spike 与 Promptfoo 共用完全相同的端到端 `attempt()`；
执行结束由独立重判路径重新计算门槛和分类，与 Promptfoo metadata 逐项核对；不一致时整次运行无效。
没有 SDK 直连备援。

每条测试行都带有基于 `context.metadata` 的 JavaScript 断言，按 `identity`、`measurement`、
`completion`、`facts_evidence`、`instruction` 和 `tools` 分组。网关候选会在 `identity` 组失败，
因此 Promptfoo 界面也不能把它显示为可排名候选。`bench:report` 从私有的 `trace.json`、
fixture 账本、`messages.db`、Context 与 fresh-state 证据重新计算业务和测量分类，再与 Promptfoo
metadata 比较；用例从仓库用例源文件复核，Profile 期望值从 `profile.yaml` 与全新数据库里的
Profile 记录推导，端点身份重新调用白名单规则判断。`context-evidence.json.expected` 不参与重判。
重判只写新的报告文件，不覆盖原始 `result.json`。

Promptfoo 固定为 `0.124.1`，该版本要求 Node `^20.20.0 || >=22.22.0`；产品其他部分的
Node 支持范围不因此改变。执行器在 Promptfoo 載入前设置 `PROMPTFOO_CONFIG_DIR`、
`PROMPTFOO_CACHE_PATH`、`PROMPTFOO_CACHE_ENABLED=false`、
`PROMPTFOO_DISABLE_TELEMETRY=1`、`PROMPTFOO_DISABLE_UPDATE=1` 和
`PROMPTFOO_DISABLE_SHARING=1`，配置同时设 `sharing: false`、`noShare: true`、
`evaluateOptions.cache: false`、`maxConcurrency: 1`。这是 Node API 对应 `--no-cache` 的
明确 `cache: false` 设置；程序不调用 `promptfoo share`。Promptfoo 数据库、缓存、resolved
config、结果和原始输出都放在被忽略的 `benchmarks/results/<run-id>/promptfoo/`；
只可在本机执行 `promptfoo view` 查看。

候选价格填在 `benchmarks/pricing.yaml`，以 `candidate-*` 别名配置，各栏是每百万 token 单价。
当前候选对应的中国内地公开标价记录于 2026-10-12：输入 ¥0.8、输出/思考 ¥2.7、缓存命中 ¥0.1、
显式缓存创建 ¥1.25。来源为[官方模型平台价目页](https://help.aliyun.com/zh/model-studio/model-pricing)，
本地候选与匿名别名的对应关系只保存在忽略文件中。
价格按请求次数对应的每次 usage 累加，失败尝试和重试也计入总成本；成功任务成本为总成本除以
合格通过次数。只要价格或任一次 usage 不完整，总成本与成功任务成本都显示 `unknown`。Promptfoo
界面的成本列无效，可能显示零或沿用运行时估算；不要据此比较模型。唯一成本口径是
`bench:report` 从独立 usage 证据与当前定价表重新计算的结果。

报告指标按以下口径计算：首次通过率只看第 1 次重复且合格的尝试；平均通过率使用全部合格尝试。
pass^3 要求同一用例的三次尝试都合格且都通过；存在不合格或缺少重复时，该用例计为「不可判定」。
不合格尝试不进入质量分母；不合格率超过 10% 的候选不参与排名。模型差异按共同合格的用例配对
重抽样 10,000 次，给出通过率差的 95% 区间；区间包含 0 时只报告「未观察到显著差异」。延迟
分别报告端到端 `elapsedMs` 与模型逻辑 `logicalRunMs` 的 p50/p95，均标记为冷启动。

该模式先复制 `data/config/claude-provider.json` 与加密密钥到私有结果目录，再在隔离子进程
读取副本，生产配置不会被迁移或修改。`BENCH_EXISTING_DATA_DIR` 可指定源数据目录。
解密凭据通过进程 IPC 传入内存，候选映射文件不含明文凭据。只有 OAuth 的配置暂不支持。
导入时按已核验的厂商官方 HTTPS 地址与 Anthropic 路径识别端点；未知地址按网关处理。
官方端点以 SDK 上报模型匹配作为身份门槛，捕获 SDK 提供的 request-id；若上游不提供，
记录数量为 0，不伪造 request-id。网关仍需外部日志证明。
`--smoke` 单候选执行首条用例一次；多候选执行前两条，各一次，并按用例轮换候选顺序。
每个全新服务实例都注册完整 Provider/Profile 矩阵，被测 Workspace 绑定本次选中的 Profile。
smoke 的退出状态表示链路是否有效，不表示完整身份验收通过。
Ctrl-C 会停止本命令创建的服务，并由服务关闭自己的 Runner。
额外注入 `BENCH_OPENCODE_GO_API_KEY` 后，可用 `--existing --with-opencode-go --smoke`
添加一个不同于现有候选、使用 Messages API 的 Go 模型。密钥不要写入命令参数或历史。
也可暂存为 `benchmarks/opencode-go.local.json`（`{"apiKey":"..."}`），并将权限设为
`0600`；预检读入内存后立即删除该文件。此本地文件已被 Git 与 Cursor 忽略。

也可单独配置候选：

将 [候选模板](../benchmarks/candidates.example.yaml) 复制为
`benchmarks/candidates.local.yaml`，填写模型 ID、端点和凭据环境变量名。`gateway: true`
表示需要外部网关日志核验；仅本地 usage 匹配不会让这一候选通过身份验收。
未知端点即使填写 `gateway: false`，仍保留待核验状态。

```bash
export BENCH_CANDIDATES_FILE="$PWD/benchmarks/candidates.local.yaml"
# BENCH_CANDIDATE_A_API_KEY 通过本地安全方式注入，不写入源码或命令历史。
npm run bench:spike -- --preflight
npm run bench:spike
```

`BENCH_CONTAINER_IMAGE` 可指定已准备的 Runner 镜像，默认值与服务一致。
`BENCH_TIMEOUT_MS` 为每次尝试上限，默认 180000 毫秒；不自动重跑失败尝试。
预检缺少 Docker、镜像或候选配置时，以非零状态退出并保存布尔检查结果。

## 隔离与证据

- 每次尝试排他创建服务目录和空数据目录，保存创建前的数据库快照（用户、工作区、
  Runtime/SDK Session、消息和用量均为空）。核验新用户及 Session 不在创建前快照中、
  Session 归属正确且无历史消息/SDK 上下文；跨轮拒绝复用用户、Session、目录或工作区。
  `fresh-state.json` 保存证据，`freshState` 根据这些证据及工作区基线计算。
- 服务在专用空 cwd 启动，使用环境变量白名单、独立 HOME 和空外部 Claude 目录，
  不加载生产 `.env`、数据库、owner profile、插件或记忆。只启用该候选 Provider，
  Profile 显式绑定 `model_config_id`，fallback 为空，辅助模型环境变量对齐。
- Session 显式命名，避免自动标题的 `sdkQuery` 路径。不使用主/Home 会话进行评测。
- 工作区创建会自动预热主 Runner。驱动器先通过现有 stop API 停止该预热，再清理其日志、
  创建被测 Runtime Session，避免共享目录竞争和非业务日志污染初始快照。
- Container 工作区仅放业务日期、stdio 桥接脚本和本次 fixture 连接文件。用例、预期答案、
  fixture 源数据和调用账本不挂载给 Runner。所有业务日期使用绝对日期。
- fixture 默认只监听 `127.0.0.1`；已验证 Docker Desktop 的 `host.docker.internal` 可达。
  `BENCH_FIXTURE_BIND_HOST` 只接受数字回环地址（127.0.0.0/8 或 ::1）。
  Linux 默认 bridge 的宿主回环连通性尚未验证；当前实测支持为 Docker Desktop。
  stdio 桥接通过带每次运行随机 token 的 HTTP 请求访问宿主 fixture 服务。服务先落盘
  完整参数、结果、顺序和成功状态，再返回结果。HTTP 端没有读取或修改账本的接口。
- WebSocket 按 Session、turn 和 runId 关联，以匹配的 `run_finished` 判定终态。
  `released`、`stopped`、`runner_exit`、断流、超时和采集不完整分别记录；中间文本不算最终答案。
- 用量从已去重的 `usage_events` 与 `usage_records` 一致快照读取，按用户、工作区和独立
  Session 过滤，逐事件核对 token 合计。缺失、不一致或 `unknown` 模型不会通过。
  同一隔离实例若出现其他 Session 的用量，也会判为采集不完整。
  Runner 使用 SDK 原生 message_delta 的最终用量；普通输入、缓存读取和缓存创建的合计
  不允许下降。若新 delta 提出的三类合计下降，就保留上一份完整输入/缓存快照，仍更新
  有效输出和 reasoning 用量；后续有效 delta 仍可继续更新。同一 message ID 仍交给现有
  账本去重。合计守恒时允许桶之间重新分类，例如缓存读取转为缓存创建；总 token 数保持
  不变，但读取与创建的单价不同，因此成本分类可能有偏差。
  不使用现有 Kaboo 费用字段估算其他候选的成本，不从 StreamEvent 重建用量账本。
- 实际上下文从 `effective-capabilities` 的 Runtime Session 快照读取，核验 Container 模式、
  turn、Profile 版本、identity hash、Skill/MCP manifest hash，并比较平台/Profile Prompt 内容 hash。
  先用共享的纯渲染函数重建并校验实际加载的完整 Profile Prompt hash，再仅将
  agent-identity 包装中的随机 Profile UUID 归一化，用于跨轮比较；原始 hash 同时保留。
  Profile 名称、正文、版本、identity hash 和平台块均不归一化。
  不把仅有预期配置当作已经加载的证据。
- 镜像按预检解析出的不可变 ID 启动。主服务、热挂载 Runner 源码和平台 Prompt 都记录内容 hash；
  一次运行期间这些源码变化会判为上下文不一致，避免镜像未变但热挂载代码变化。
- 创建工作区前等待服务的 IPC 就绪握手，避免在启动清理尚未完成时提交评测任务。
  每次运行比较初始工作区文件内容 hash；随机 fixture 连接文件在该快照之后写入。

所有尝试都属于冷启动。`elapsedMs` 从 WebSocket 连接前计时到匹配的终态与最终回复均已收齐，
`logicalRunMs` 从收到 `run_started` 计时到 `run_finished`，包含运行准备；
账本 `durationMs` 是 SDK 报告时长。
这三个口径不能互换，也不冒充纯模型延迟。

## 六项门槛

测量有效性与业务是否答对分别记录。`chainPassed` 要求全部尝试正常收齐终态和回复、
fixture 调用与 stream 对应、全新状态基线、账本用量一致、SDK 报告模型匹配、实际上下文
可复现；业务断言失败不等于测量失败。`businessPass` 单独记录任务完成情况。
完整 spike 的 `passed` 还要求实际模型身份通过，并且执行全部 5 × 3 次。
网关候选外部核验尚未实现自动导入，报告会明确显示待核验；允许链路验证完成，
完整身份门槛仍保持未通过，不能据此生成模型排名。
业务失败保留在结果中，不为提高通过率反复修改断言或自动重试。
`completed` 只说明运行终态，不能代替业务断言。
审计由 `assertions/audit.ts` 独立计算，不存在于业务 checks 中，也不参与 `businessPass`
和 `businessPassedAttempts`。丢失工具事件使测量门槛失败，不能直接拉低独立业务统计。
空 stream 工具序列和空 fixture 账本可以对账，未调用必用工具由业务断言判失败。
观察到 Bash 等禁用工具时记录 `tool_policy_violation`。若同时存在无法匹配的 fixture 调用，
另记 `measurementFailure: audit_mismatch`，保持样本不符合正式质量评测资格；不能仅凭
不匹配就断言一定绕过 MCP，也不能冒充 `collection_incomplete`。两个失败维度独立保留。

官方端点判定依据（2026-10-11 核验）：

- [DeepSeek Anthropic 接口](https://api-docs.deepseek.com/guides/anthropic_api/)
- [GLM 厂商集成指南](https://github.com/MetaGLM/glm-cookbook/blob/main/vibecoding/glm-4.5-claude-code-integration.md)
- [Z.AI Claude Code 配置](https://docs.z.ai/devpack/tool/claude)
- [Kimi 中国站 Claude Code 配置](https://platform.kimi.com/docs/guide/claude-code-kimi)
- [Kimi 国际站 Claude Code 配置](https://platform.kimi.ai/docs/guide/claude-code-kimi)
- [阿里云百炼 Anthropic Messages 接口](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)
- [千问 AI 平台 Anthropic Messages 接口](https://platform.qianwenai.com/docs/api-reference/chat/anthropic)

百炼普通 Key 的中国内地入口与千问 AI 平台的按量入口分别按官方文档登记，
凭据来源必须与入口对应；只有 Qwen 目标适用 Qwen 厂商信任契约，
平台代托管的其他厂商模型继续按网关处理。
request-id 仅是可选诊断相关 ID，不参与身份门槛，也不能证明实际模型路由。
这些是显式的信任契约，不是对隐藏模型路由的密码学证明。HTTPS 地址严格匹配 origin 与
路径，域名后缀相似、非 HTTPS、不同路径或端口均不能自动视为官方。
OpenCode Go 属于聚合网关；其 [官方接入表](https://opencode.ai/docs/go/) 区分 Messages 和
Chat Completions 模型，本驱动器只选 Messages 模型，不为 smoke 临时做协议转换。

## 私有结果与后续工作

结果位于被 gitignore 和 `.cursorignore` 排除的 `benchmarks/results/spike-*/`。运行期间有临时凭据，目录以
0700 创建，新增评测 JSON/账本以 0600 创建；不要上传整个目录作为 CI artifact。
控制台只输出匿名候选、用例、布尔检查和失败分类。结构化私有轨迹保留合成回复及工具调用，
不保留 thinking、原始 SDK 事件、工具摘要或模型名称。对外仅发布人工检查后的脱敏汇总。
Provider 导入无论成功或失败均立即删除 `provider-snapshot`。每个自有服务退出后删除
`data-eval/config`、`env`、`mcp-servers/*/secrets.json`、会话设置/凭据及 fixture
连接文件；保留账本、数据库和轨迹。
历史结果已执行同样清理。不要索引或上传运行中的私有结果目录。强制杀死整个驱动进程
可能阻止 finally 清理；下次操作前应使用同一清理函数清理已停止的私有运行。
使用结束后可删除对应 `spike-*` 目录；在删除前确保运行命令已退出。

当前真实模型身份只能核验 SDK/上游报告的模型名，无法证明未上报的辅助请求不存在。
网关模型名改写与隐藏子请求仍需网关侧日志证明。真实链路未运行时，不得将离线测试当作
Container 验收或模型质量结论。

后续阶段才添加 dev/holdout、完整指标报表、配对区间、盲评 Judge 和约 60 条分层人工校准。
第一版不引入 Langfuse；线上观测仍需先定义脱敏和保留期限。

## 开发验证

```bash
npm run bench:typecheck
npx vitest run tests/benchmark-spike.test.ts tests/benchmark-spike-transport.test.ts tests/benchmark-spike-service.test.ts tests/routes-agent-profiles.test.ts
npm run docs:check
```

前三个测试文件仅使用合成资料和本机 HTTP/WebSocket，不调用真实模型。服务测试验证真实
服务的启动、认证、MCP 注册和 Profile 绑定，Container 执行仍由真实 spike 单独验收。

## 扩充用例时的约束

现有 5 条是接线用例，故意明确工具、参数和输出结构，不用于区分模型质量。
后续业务集应使用客户的自然业务目标，隐藏工具名称与参数提示，覆盖需追问、拒答、
多步证据选择与干扰项，并分开报告有提示/无提示分层结果；保留必要的可见输出契约。
不得把当前 14/15 接入结果外推为业务胜率。

离线重判会写入包含断言版本 hash 的 `summary.reassessed-<hash>.json`，同时重算业务、
测量有效和最终通过计数；原始 `summary.json` 与既有重判文件保留。
