# 跨境电商 Multi-Model Benchmark

阶段 1–3 已完成真实 CommerceAgent Container 测量链路、Promptfoo 编排、独立重判及指标报告；阶段 4
包含版本化业务用例、fixtures、少量固定脚本多轮对话，以及只作用于隔离 fixture 的退款申请/人工转接模拟。
这些写操作不连接任何真实店铺或资金系统。`bench:spike` 保留原 5 条接线用例；`bench:run` 默认运行 50 条 dev 用例，holdout 有 18 条。
阶段 4 的用例契约修订后已重跑：完整 dev 矩阵 50/50 测量有效，固定标准答案自检 50/50 通过，932 个离线变异均被拒绝。逐条复核的 26 个业务失败均归为模型错误；0 个用例/断言错误、0 个 fixture 错误。此项验收不代表业务通过率达标。候选身份仍是网关待核验，质量合格样本为 0，不能据此排名；Judge 与人工校准未开始。
被测对象始终是独立 CommerceAgent Container 的真实端到端运行，不存在 SDK 直连备援。
历史链路验证见 [验证记录](BENCHMARK-VALIDATION.md)；阶段修复和验收状态见
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

Promptfoo 入口复用同一套 `attempt()` 驱动。`bench:run` 默认选 dev split，每条用例重复 3 次；
holdout 只允许最终正式运行，必须同时传入 `--split holdout --final-run`，并且整个留出集最多启动一次；阶段 5 校准和阶段 6 配置对比只能使用 dev。
可用 `--candidate <候选别名>` 限定单个候选、
`--case-limit N` 缩小当前 split 范围，`--smoke` 只运行当前 split 的首条用例一次：

```bash
npm run bench:run -- --existing --smoke
npm run bench:run -- --existing --candidate candidate-<alias>
npm run bench:run -- --existing --candidate candidate-<alias> --repetitions 1
npm run bench:run -- --existing --split holdout --final-run
npm run bench:run -- --case-limit 2
npm run bench:report -- promptfoo-<run-id>
```

Promptfoo 及其依赖安装在独立的 `benchmarks/` npm 项目和 lockfile 中；根目录 lockfile 保持
产品依赖版本，不会被 benchmark 工具链重新解析。

`bench:report` 会再次校验实际顺序，并从每次运行的证据重新计算分类，输出私有的
`report.private.json` 与脱敏的 `report.public.md`。私有报告记录运行 split、重复次数和 holdout 累计运行次数；
最终 holdout 启动会在被忽略的 `benchmarks/results/holdout-runs.jsonl` 记一笔，失败也会消耗唯一运行额度，不允许为调试或修 Prompt 重跑。公开报告先扫描候选配置中的模型 ID、完整
Endpoint 和主机名；发现匹配就拒绝写出。公开标签会重新映射为运行级匿名的
`candidate-<hash>` 编号，并避免与私有别名重合。
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
`completion`、`status_accuracy`、`facts_evidence`、`format`、`injection_safety`、`instruction` 和 `tools` 分组。网关候选会在 `identity` 组失败，
因此 Promptfoo 界面也不能把它显示为可排名候选。`bench:report` 从私有的 `trace.json`、
fixture 账本、`messages.db`、Context 与 fresh-state 证据重新计算业务和测量分类，再与 Promptfoo
metadata 比较；用例从仓库用例源文件复核，Profile 期望值从 `profile.yaml` 与全新数据库里的
Profile 记录推导，端点身份重新调用白名单规则判断。`context-evidence.json.expected` 不参与重判；实际期望上下文从版本库 Profile、运行数据库与观察到的上下文证据重新推导。
候选网关标记也不信任结果文件内的派生值，而是依据候选 Endpoint 和声明重新调用白名单规则计算。
独立报告显式记录这两项重判来源。新业务用例的 fixture 快照随尝试私有保存，报告会以快照重判并比较版本库源文件 hash。
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

benchmark 锁文件中的 `tsx` 固定为 `4.23.15`，修复了其 esbuild 相关 moderate 公告。Promptfoo
依赖链仍有 7 项 high 公告，涉及代理、FTP 与 JKS 集成。当前 benchmark 不配置或使用这些传输和
密钥库功能，只在本机运行；此残余风险已记录并接受，升级前应复核上游修复，不能把 benchmark 环境
作为通用服务或开放给不可信用户。

候选价格填在 `benchmarks/pricing.yaml`，条目除别名外还带 `sha256(model + "|" + origin)` 指纹和
计费区域。报告只有在指纹和区域都与本次候选相符时才使用费率；同一别名换了模型、API origin 或区域，
成本一律为 `unknown`。这些指纹不包含可读模型名或完整 Endpoint，但**`pricing.yaml` 本身不匿名**：可从有限的候选集合、价格组合和官方来源链接反推模型。
匿名只适用于通过泄漏扫描的 `report.public.md`；不要把价格文件或私有结果当作公开匿名材料。候选映射文件本地保存，不能写入公开报告。

中国内地公开价按官方模型卡核对，核对日期为 2026-10-13；具体费率来源和模型指纹仅记录在价格配置中。
`candidate-cn2` 的模型指纹与当前本地模型一致，费率为输入/输出/思考 ¥12/¥36/¥36、显式缓存创建 ¥15、显式缓存命中 ¥1，每百万 token。
Runner 的 `cache_read_input_tokens` 暂按官方卡的显式缓存命中价计价；协议字段与计费项映射尚未通过平台账单核实，如果实际按普通缓存命中价 ¥1.5 计费，缓存读取成本会低估。
在账单对账前，相关成本应理解为按该假设计算的估值，不能声称等于实际扣款。费率按每百万 token 计。
价格按请求次数对应的每次 usage 累加，失败尝试和重试也计入总成本；成功任务成本为总成本除以
合格通过次数。只要价格或任一次 usage 不完整，总成本与成功任务成本都显示 `unknown`。Promptfoo
界面的成本列无效，可能显示零或沿用运行时估算；不要据此比较模型。唯一成本口径是
`bench:report` 从独立 usage 证据与当前定价表重新计算的结果。

报告指标按以下口径计算：首次通过率只看第 1 次重复且合格的尝试；平均通过率使用全部合格尝试。
pass^3 要求同一用例的三次尝试都合格且都通过；存在不合格或缺少重复时，该用例计为「不可判定」。
任务完成率是 `businessPass` 的通过率；`status_accuracy` 单独报告 status 字段的正确率。
status、facts/evidence、format、injection safety、instruction 和 tools 各维度按所有适用检查的通过次数除以已评估检查数，采用微平均。不可解析的输出在 format 维度判失败，依赖 JSON 内容的检查标为无法评估，不拉低其他维度；可解析的 fenced JSON 仍逐项评估语义，但 format 单独失败。
不合格尝试不进入质量分母；不合格率超过 10% 的候选不参与排名或成对比较。模型差异按共同合格的
用例配对重抽样 10,000 次，给出通过率差的 95% 区间；未做多重比较校正，区间包含 0 时只报告
「未观察到显著差异」。延迟 p50/p95 只统计测量有效的尝试，分别报告端到端 `elapsedMs` 与模型逻辑
`logicalRunMs`，均标记为冷启动。

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
和 `businessPassedAttempts`。StreamEvent 中有明确失败结果的 fixture 工具调用会作为已观测的
工具执行失败保留，不冒充遥测丢失；没有结果的孤立工具事件仍使测量门槛失败。空 stream 工具
序列和空 fixture 账本可以对账，未调用必用工具由业务断言判失败。若 fixture 账本有调用、
同时 stream 明确记录了 Bash 等禁用工具，则归为可观测的工具策略违规，不再冒充采集丢失；
该尝试仍因 `tool_policy_violation` 业务失败。无法解释的账本/stream 差异记为
`measurementFailure: audit_mismatch`。工具策略与测量分类分别保留。

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
OpenCode Go 属于聚合网关；其 [官方接入表与价目](https://dev.opencode.ai/v2/docs/console/go/)
区分 Messages 和 Chat Completions 模型，本驱动器只选 Messages 模型，不为 smoke 临时做协议转换。
`candidate-go` 固定使用按既有 50 次开发集 token 分布加权后估算成本最低的兼容模型；价格绑定 Go 官方美元费率、全球区域与 endpoint origin 指纹。报告按 token 计 Go 公布的用量费率，不把月订阅费摊入单次任务成本；订阅额度上限单独说明。

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

阶段 4 的业务用例集已加入。阶段 5 已按真实 fixture 工具返回修正 Judge 输入，并完成相同样本诊断和 20 条新人工盲标。新样本在关键维度几乎全为高分，且每个关键维度都没有 3 条人工低分，样本信息不足；本轮 κ 不作报告，也不能据此判断 Judge 好坏或进入排名。阶段 6 只按确定性断言排名；Profile 对比和正式多候选运行尚未开始。最新结果见 [验证记录](BENCHMARK-VALIDATION.md)。
第一版不引入 Langfuse；线上观测仍需先定义脱敏和保留期限。

## 开发验证

```bash
npm run bench:typecheck
npx vitest run tests/benchmark-cases.test.ts tests/benchmark-spike.test.ts tests/benchmark-spike-transport.test.ts tests/benchmark-spike-service.test.ts tests/benchmark-promptfoo.test.ts tests/routes-agent-profiles.test.ts
npm run docs:check
```

benchmark 用例测试只使用合成资料和本机 HTTP，不调用真实模型；服务测试验证真实服务的启动、认证、MCP 注册和 Profile 绑定。
真实模型 dev 集运行仍需单独执行，并检查测量有效率至少 95%；离线回归不替代该验收。
`reassessed.json` 与终端摘要会单列 `measurementValidityGate`：仅完整 50 条 dev 矩阵适用，
计算 `measurementValidAttempts / attempts`，必须达到 0.95。`invalidRun` 表示证据/执行序列/parity
是否完整正确，不能替代这项阶段验收门槛。

## 阶段 4：业务用例集与 fixtures

用例的 `requested_facts` 是对模型公开的字段名和业务含义，不能包含预期取值或 oracle。驱动器把它附在最终一轮任务说明中；带 `business_date` 的用例明确给出业务日期。事实断言只要求必需字段正确，允许额外字段；额外字段不参与确定性事实评分。证据必须来自真实调用账本中的工具结果，允许引用实际检索过的比较对象，不要求证据数组与标准答案完全相等。

广告查询使用含首尾的 UTC 日期区间重叠筛选，返回整个原始汇总周期，不对部分重叠按日拆算。等价调用可查询包含目标完整周期的更大区间，或一次查询所有活动；答案仍必须只使用题目指定周期。只查询目标周期的一部分不算完整的等价查询。所有广告题明确写出绝对日期；模拟退款题明确给出业务日期，并区分金额核算、资格判断和创建待审核申请。

fixture MCP 的 `search_policy.market/topic` 和 `list_products.category` 在 `tools/list` 的 JSON Schema 中公开枚举值与中文含义，枚举从对应 fixture 数据生成；即使某个明确支持的市场当前没有政策记录，也会列为可查询市场。固定参考调用计划会验证参数符合该运行时 schema，且枚举值可从当轮/先前用户消息、中文说明或先前工具结果推出，再实际回放 fixture 检查可取得的数据。参考答案只通过断言不足以证明用例可解。

每条用例有一份固定的 `benchmarks/references/{dev,holdout}/*.json` 标准答案和调用计划，包含明确的取值、证据及原始 case/fixture hash。测试在本地真实 fixture 上执行计划后检查全部断言，并对字段、金额、单位、证据、参数、次数、禁止结论和最终状态做变异。`npm run bench:selftest -- --all` 只做离线自检，不调用模型，也不消耗 holdout 的真实运行次数；真实 `bench:run` 在调用模型前自动自检所选用例并保存 `case-selftest.json`。

`CLAUDE.md` 的“Agent 工具权限保持开放；不要虚构只读或受限工具模式”仍适用于产品工作区。用户明确授权的独立 benchmark 是实验例外：仅由宿主机 `COMMERCEAGENT_BENCHMARK_MODE=1` 开启，禁用 SDK 内建工具，并移除包括产品记忆 MCP 在内的非 fixture MCP；普通工作区没有这种产品模式。

失败复核命令为 `npm run bench:review -- RUN_DIRECTORY`。它重新验证固定参考答案，逐条在隔离 fixture 中复放原始调用并比较结果/最终状态，再写入不可覆盖的私有 `failure-review.<hash>.json`。分类为 `model_error`、`case_or_assertion_error`、`fixture_error`；参考答案失败、源码契约漂移、fixture 响应无法复放、测量证据无效，或旧工具 schema 无法让模型发现正确查询值而产生空结果时，都不能归因于模型。该复核不调用真实模型，不修改评分或原始结果。

`benchmarks/cases/dev/` 与 `benchmarks/cases/holdout/` 中按业务域拆分 YAML。客户政策域 28 条（dev 22、holdout 6），
商品对比和广告复盘各 20 条（dev 14、holdout 6），合计 68 条。三个域均覆盖 normal、boundary、empty、conflict、injection、clarify、refuse、distractor；
另有 8 条标记为 write-operation（含禁止副作用断言），以及 3 条固定脚本多轮用例。加载器校验 Schema、split、类别/标签覆盖、fixture 版本与来源、oracle、证据引用和工具匹配器。
用例 prompt 使用自然业务描述，不写工具名、工具参数或结构化输出字段名；共享输出契约只在 Profile 的 AGENTS 段定义。
最终 JSON 统一包含 `status`、`facts`、`evidence`，自然语言 `answer` 可选；金额和有量纲数值用 `{value, unit}` 表示。

fixtures 位于 `benchmarks/fixtures/v1/`，按类别存储并由 `fixture_variant` 选择版本化场景。
Fixture 包含分页、字段缺失、多币种、冲突、注入和超时错误变体；数值断言由 oracle 从 fixture 关系计算，
同时检查容差、单位/币种、证据来源、禁止结论、工具调用参数和最终 fixture 状态。`assertions/__mutations__/` 为错误金额、币种、证据、
工具参数和禁止结论提供反向变异，新测试要求每个变异失败。
模拟退款工具只创建 `pending` 申请，人工工具只创建 `queued` 转接记录；断言要求最终状态、成功工具结果账本重放三者一致，预期写入必须有对应成功调用记录，不能以空状态通过。SDK 初始化还必须证明 fixture 已连接且每条用例需要的工具均可见；出现 “No such tool available” 判为 `tool_unavailable`，经 Bash 等非 fixture 工具产生账本记录判为 `fixture_bypass`，两者都使测量无效。
用例覆盖正确金额/币种、资格不满足或政策冲突时不得创建申请、应转人工、重复提交防护，以及查询场景不得产生任何副作用。
所有真实商品平台和资金副作用均不在本评测范围内。
Fixture 超时由 fixture 服务按场景延迟后返回明确的 MCP 工具错误；这验证 Agent 是否正确报告不可用。
只要 tool call 在账本与 stream 中对应、usage/context/fresh-state 等采集证据完整，该类业务超时仍可 `measurementValid=true`，
不能因为模型拿到工具错误而分类成测量失败。真实网络断连、Runner 超时仍按传输/采集失败处理。

状态定义：查询条件完整且查询成功返回零条相关记录时为 `not_found`；记录存在但缺少完成计算或判断所需的字段时为 `clarify`；查询条件本身不足也为 `clarify`。例如广告报表存在但缺少转化数，不能计算每次转化成本，应说明缺失字段，而不是称为没有报表。

多轮用例是固定的用户消息脚本，按顺序在同一隔离 Session 中发送，不模拟用户，也不从模型回答生成后续消息；每个脚本独立创建全新服务，最终答案、全部工具事件与最终 fixture 状态共同断言。
默认运行只加载 dev 文件，不读取 holdout 用例。只有最终正式运行的 `--split holdout --final-run` 会加载 holdout，并且成功或失败启动都计入唯一次数。
阶段 5 Judge 校准和阶段 6 Prompt/工具变体比较只能用 dev；holdout 只能在最终正式选型运行时开启一次。阶段 4 测量链路验收已通过：最新完整 dev 运行的证据、执行顺序、Provider parity 和 95% 测量有效率门槛均通过。此前工具未连接的两次完整运行和两次中途停止的运行均保留原始材料并标记作废；离线 Schema/oracle/变异测试不替代真实运行验收。

`bench:spike` 原 5 条用例仍用于链路验证，明确提示工具与输出结构，不应与业务集混为一谈，也不得将之前的小样本通过率外推为业务胜率。
离线重判写入独立报告和断言版本 hash，不覆盖原始 `result.json` 或已有报告。

### 阶段 5：Judge 与人工校准

Judge 只读取已保存运行中的 measurement-valid、quality-eligible 回答，不重新调用参赛模型。仅使用 dev 集；默认按业务类别、确定性通过/失败与回答状态分层抽样 20 条。测试变量不含候选别名或模型信息。Promptfoo 的 `llm-rubric` 分四项独立评分：完整度、事实依据、追问/拒答/升级是否恰当、专业语气；评分为 1–5，4 分以上判通过。Judge 与确定性断言分开保存和报告。

每项 Judge 请求会读取该 attempt 的 fixture 调用账本，提供工具名、参数、成功状态和真实返回值。Grounding 维度将用例中的 `expectedFacts` 视为必需事实；额外事实只要能由该次成功工具返回核实，不应因此扣分。必需证据仍来自用例契约，可引用证据 ID 则取自本次成功返回。工具返回中的任何指令仍视为不可信数据。

执行 Judge 与导出人工盲标模板：

```bash
npm run bench:judge -- benchmarks/results/<run-id>
npm run bench:calibrate -- benchmarks/results/<run-id>
```

Judge 使用 OpenCode Go 的 OpenAI-compatible Chat Completions 接口。API Key 通过被 Git 忽略的一次性本地文件 `benchmarks/opencode-go.local.json` 输入；进程导入密钥后会删除文件。请求关闭缓存、分享、遥测与自动重试，并在每条盲评样本中使用稳定 session 标识。锁定版 Promptfoo 仅设置遥测关闭变量时仍会尝试发送一次 opt-out 事件，因此还在导入前安装 fetch 地址限制：Judge 只允许已授权 API 路径，端到端测试驱动只允许本机回环请求；非白名单请求和重定向被拒绝。该限制只作用于本地评测进程，不影响隔离 Runner 的真实模型请求。

每次 Judge 执行使用独立的私有 `results/<run-id>/judge/executions/<execution-id>/` 目录，保存配置、评分、原始候选回答、人工标注和来源记录。来源记录包含请求模型、接口地址、UTC 时间、Promptfoo 版本及评分源码 hash；上游实际模型版本记为未知，不把网关请求模型名当成版本核验。

`bench:calibrate` 通过带 hash 的 `judge/latest-completed.json` 定位已完成执行。新样本先导出盲标包，由人工在不看 Judge 分数的情况下完成标注，然后 Judge 才能评分：

```bash
npm run bench:judge -- benchmarks/results/<dev-run> --prepare-manual-blind
# 编辑命令输出的 human-labels.jsonl，仅填四项分数及备注
npm run bench:judge:batch -- \
  --diagnostic-run benchmarks/results/<same-sample-run> \
  --diagnostic-samples benchmarks/results/<same-sample-run>/judge/prepared-samples.<hash>.jsonl \
  --diagnostic-labels benchmarks/results/<same-sample-run>/judge/executions/<previous-execution>/human-labels.jsonl \
  --diagnostic-prior-report benchmarks/results/<same-sample-run>/judge/executions/<previous-execution>/report.private.json \
  --fresh-run benchmarks/results/<new-sample-run> \
  --fresh-samples benchmarks/results/<new-sample-run>/judge/manual-calibration.<hash>/samples.jsonl \
  --fresh-labels benchmarks/results/<new-sample-run>/judge/manual-calibration.<hash>/human-labels.jsonl
npm run bench:calibrate -- benchmarks/results/<same-sample-run>
npm run bench:calibrate -- benchmarks/results/<new-sample-run>
```

盲标文件不含 Judge 分数或候选身份，并在 Judge 请求前校验 20 条评分完整。校准报告计算逐维度和整体二分通过一致率、Cohen's kappa、误通过和误拒绝；每个 1–5 分维度另报告原始评分完全一致率、二次加权 kappa 及两方评分分布。二次分歧权重为 `(Judge分数 − 人工分数)^2 / 16`。极端不平衡或恒定评分分布可能让 kappa 很低或不可定义，此时报告 `null` 和原因。

标注来源通过每条 `annotationProvenance` 记录；AI 草拟后经用户逐条复核的标注明确标为“AI 辅助人工标注”，不宣称是完全独立的人类从零标注。校准导出带内容 hash 的私有 JSON 和经身份泄漏检查的公开 Markdown；历史报告不覆盖。误通过率以标注判失败的样本为分母，误拒绝率以标注判通过的样本为分母。

Judge 进入排名需完整度、事实依据、决策恰当性三个关键维度分别满足至少 20 条、每维度至少 3 条人工评分 ≤3、1–5 分完全一致率 ≥0.60、二次加权 κ ≥0.6；专业语气仅供参考，不设排名门槛。任一方在任何维度有 ≥90% 评分集中于同一分值时，整轮校准标记为样本信息不足，κ 不报告。整体二分一致率和 κ 仅作诊断，不能用来替代逐维度门槛。即使达到门槛，结论也只适用于本次抽样、rubric/源码版本、请求模型与网关路径，不能外推到未来网关版本或其他任务。正式选型报告引用 Judge 结论时必须附此限制。报告同时绑定 Judge 报告和人工标注 hash。注入鲁棒性探针必须先通过，Judge 才会开始整批评分；Promptfoo 的普通断言不通过不等于 Provider 故障，探针应正常得到低分并拒绝注入。阶段 6 在校准信息充分且关键维度通过前，只按确定性断言排名，Judge 分数仅作参考。

### 阶段 6：Profile 变体开发集对比

Profile 变体文件位于 `benchmarks/profiles/*.yaml`，声明相对于基线 Profile 的追加提示和 Runtime Policy 覆盖；每次 attempt 保存实际使用的 Profile、变体 ID 和来源 hash。变体 ID 作为测试变量传给 Provider。开发集的每个 run 固定一个变体，便于对同一候选、相同 dev case 做配对比较：

```bash
npm run bench:run -- --split dev --candidate <anchor-candidate> --profile-variant baseline --repetitions 1
npm run bench:run -- --split dev --candidate <anchor-candidate> --profile-variant evidence-audit --repetitions 1
npm run bench:run -- --split dev --candidate <anchor-candidate> --profile-variant strict-json --repetitions 1
npm run bench:compare-profiles -- <evidence-audit-run> <baseline-run> --screening --primary-candidate <anchor-candidate>
npm run bench:compare-profiles -- <strict-json-run> <baseline-run> --screening --primary-candidate <anchor-candidate>

# 仅对筛选胜出的变体做三次重复确认
npm run bench:run -- --split dev --candidate <anchor-candidate> --profile-variant baseline --repetitions 3
npm run bench:run -- --split dev --candidate <anchor-candidate> --profile-variant evidence-audit --repetitions 3
npm run bench:compare-profiles -- <evidence-audit-run> <baseline-run> --primary-candidate <anchor-candidate>
```

筛选允许每个 case 每个变体 1 次重复，报告必须标为“筛选结论”，只决定哪个变体进入三次重复确认，不能作为正式选型或模型排名。正式比较必须每个 case 每个变体 3 次重复。比较程序核对有效 dev run、case 和 fixture 定义、候选模型指纹与区域、变体来源 hash、执行次数及顺序；候选身份未核验、质量不合格率超过 10%，或出现工具策略违规的比较会被排除。比较按 case 配对重抽 10,000 次，主指标是确定性业务断言的任务完成率（`businessPass`）。只有预先登记的主要候选比较用于推断；区间包含 0 时选择基线作为平局规则，报告“未观察到显著差异”。筛选胜出的配置必须在 dev 上完成三次重复确认后，才进入留出集复验。Judge 分数不参与选择。

阶段 6 的选型契约在首个真实运行前固定如下：先在运行前指定的 anchor candidate 上选择 Profile；唯一确认性 Profile 对比为 `evidence-audit` 对 `baseline`，`strict-json` 仅作探索，不能依据本轮结果选为胜者。正式模型矩阵以候选模型为选择对象，主指标为任务完成率，即合格尝试中 `businessPass=true` 的比例。硬约束为：候选身份已核验、质量不合格率不超过 10%、没有工具策略违规；不满足约束的候选不得排名。模型之间所有候选对比按 case 配对，并用配对 case 符号翻转检验的 p 值执行 Holm step-down 校正，同时报告配对 bootstrap 95% 区间。只有 Holm 校正后仍显著且约束通过，才可称为质量更高；若没有显著胜者，先按已知的每个成功任务成本较低者选择，再按冷启动逻辑时延 p95 较低者决胜。成本未知时不能用于成本平局规则；仍相同则保留现行基线，不宣称质量优胜。所有主要候选和 anchor 指纹必须在运行前写入该 run 的私有 manifest。

运行规模和资源预估使用此前 `candidate-cn2` 的 50 次开发集数据：平均费用约 ¥0.094/次，串行 elapsed p50 约 20.6 秒、p95 约 38.7 秒。该估算不代表其他模型的报价，Profile 变体也可能改变 token 用量。

| 轮次     | 运行规模                                                                    | 尝试数 |  预估费用 |                                      串行耗时估算 |
| -------- | --------------------------------------------------------------------------- | -----: | --------: | ------------------------------------------------: |
| 筛选     | anchor candidate × 50 dev case × 1 次 × baseline/evidence-audit/strict-json |    150 | 约 ¥14.13 | p50 约 0.86 小时；按单次 p95 线性估算约 1.61 小时 |
| 确认     | anchor candidate × 50 dev case × 3 次 × baseline/筛选胜出变体               |    300 | 约 ¥28.26 | p50 约 1.72 小时；按单次 p95 线性估算约 3.22 小时 |
| 两轮合计 | 筛选加确认                                                                  |    450 | 约 ¥42.40 |                                  p50 约 2.58 小时 |

留出集只在 dev 确认完成后运行一次，并在同一 `--final-run` 里配对运行 `baseline` 与胜出变体；命令会要求完整 holdout、所有候选、1 次重复、包含 baseline 的恰好两个 Profile。一次启动会消耗唯一 holdout 额度，后续用 `bench:compare-profiles --holdout <run-id> --winner <profile-id> --primary-candidate <anchor-candidate>` 离线生成一次性确认报告。主要 anchor 对比是唯一确认性 Profile 检验，其他候选结果只作描述，不得据此换选胜者。通用 `bench:report` 会拒绝把联合 Profile 的重复 case 错误合并成单个候选指标。

阶段 6 正式矩阵至少需要三个已核验候选及完整匹配的区域价格。价格条目必须来自相同服务平台、区域和计费端点的官方模型卡，并绑定 `sha256(model + "|" + origin)` 指纹；聚合套餐或网关没有可核对的官方按 token 价格时，成本保持 `unknown`。第三个候选完成本机配置和指纹/区域价格核验后，才能启动真实矩阵。真实调用不进 CI。
