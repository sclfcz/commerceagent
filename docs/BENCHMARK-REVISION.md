# Spike 验收修订记录

前半部分保留上一轮记录；本轮追加修复和最新验收状态见文末。历史通过数不代表当前版本。

2026-10-11。本轮只修复验收问题并验证双候选接入，没有扩充正式业务集或生成排名。

## 求证与修复

- 用量采集器影响全部 Runner，原先确实会把代理的 input_tokens: 0 当作最终输入。
  新增的 snake_case、camelCase、带全零缓存三种测试均在修复前失败。现在输入下降
  必须由足够的缓存增长佐证，否则保留上一份输入/缓存快照，输出仍正常更新。
  42 项用量/账本/接口测试通过；修复独立提交为 `553e459`，不包含 benchmark 文件。
- 空账本与空工具序列可以匹配，必用工具未调用是业务失败。禁用工具单独记录为
  `tool_policy_violation`，无法解释的账本不匹配为 `audit_mismatch`，不会冒充采集丢失。
  同时违规与审计不匹配时保留两个维度，并排除质量评测资格。仅凭不匹配不能证明绕过 MCP。
  参数错误导致允许的工具执行失败属于业务失败，不属于工具违规。
- `freshState` 根据排他创建的空目录、实际初始空数据库、新用户/Session、归属及无历史
  上下文证据推导，并检查跨轮唯一性和文件基线，不再写死 true。
- 官方厂商 HTTPS origin 与 Anthropic 路径采用严格白名单；SDK 模型名匹配可满足该信任
  契约。未知地址、相似域名、非 HTTPS、其他端口及聚合网关仍待外部核验。
  SDK 提供 request-id 时单独捕获，缺失时明确记为未提供。来源与边界见
  [测量说明](BENCHMARK.md)。
- 导入快照立即清理；自有服务退出后删除 config、env、会话设置/凭据和 fixture 连接文件。
  历史结果也已清理，原始账本及轨迹保留；新增 .cursorignore。
- fixture 改为回环监听，Docker Desktop 连通性测试及本轮真实调用通过；通配监听被拒绝。
  删除了无关格式重排，修正 import 位置，README 链接并入文档表格。

## 双候选真实 smoke

记录编号：`spike-2026-10-11T12-47-06-432Z`。两个不同模型，每个全新实例同时注册两个 Provider/Profile；
执行顺序为 `candidate-1 → candidate-go → candidate-go → candidate-1`，覆盖按用例轮换。

| 候选         | 尝试 | 测量有效 | 业务断言通过 |
| ------------ | ---- | -------- | ------------ |
| candidate-1  | 2    | 2        | 1            |
| candidate-go | 2    | 2        | 2            |

- Profile 与 Provider 绑定核验：4/4；SDK 模型名匹配：4/4。
- 新环境证据、用量对账、fixture 对应与上下文核验：4/4；跨轮上下文和初始文件基线一致。
- 两个候选均为网关，实际模型身份继续待核验，完整 spike 的 passed 保持 false。
- 本次 SDK 没有暴露上游 request-id（4 次均为 0）；没有用 message ID 冒充。
- 业务失败检查：evidence、successfulTools。保留该失败，不为提高通过率重跑模型。

真实 smoke 的原始 `summary.json` 保留。当发现“允许的工具参数错误被误标违规”后，
只用保存的合成回复、独立账本和 stream 进行离线重新判定，写入独立的
`summary.reassessed.json`（含断言代码 hash），没有覆盖原始结果或追加模型调用。
以上业务失败仍为 1 次，分类修正为 business_assertion。重判命令为：

`npx tsx benchmarks/scripts/reassess-spike.ts benchmarks/results/<run-id>`

## 验证环境与剩余边界

本次全量回归在 macOS ARM64、Node v26.0.0、Codex 沙箱外运行：
**2951 项通过、24 项跳过、1 项失败**。唯一失败仍是未修改的备份硬链接拒绝测试。
失败数量与运行环境有关，不能用此数字否定其他环境下观察到的两项失败。
后端与 Runner 构建、全项目类型检查、benchmark 类型检查通过。

凭据清理后检查结果：历史导入快照、临时服务 config/env 均为 0；私有结果中未发现
长 sk- 格式明文密钥。这个扫描不代表对所有可能编码格式的密钥做出了保证。
接线用例仍明确提示工具与结构，只适合链路验证；正式业务集须另行设计自然任务、
干扰项、需追问与拒答分层。正式身份验收、Judge 和模型排名仍未完成。

## 本轮追加修复（2026-10-11）

上一轮 `553e459` 的缓存保护确实不完整：`input=100, cache_read=500` 的开始快照，
遇到输入不变且 `cache_read=0` 的 delta，会丢失 500 个缓存 token。修复前新增的三种
snake_case、camelCase 和省略输入字段测试全部失败。

- 先提交纯格式化 `d0c97db`：从 HEAD 文件经项目 Prettier 配置生成，仅包含主服务、
  Runner 和 ACL 文件的格式变化。当前功能改动保留后再整体格式化。
- 独立计费修复提交 `417ad25`：缓存读取与缓存创建的下降必须由普通输入增长共同佐证；
  额度不足时保留整个旧输入/缓存快照，避免把同一份增长重复用于两类缓存。
  覆盖零占位、合法重分类、部分增长不足及后续恢复。相关计费测试 51 项通过。
- `independentAudit` 已从业务 checks 移出；独立审计仍能排除无法对账的样本。
  回归测试实际读取重判文件，证明丢失工具事件时业务成功数仍为 1、测量有效数为 0。
- 补齐 Moonshot 国际站；登记百炼普通 Key 的中国内地 Qwen 入口，其他托管模型仍需网关核验。
- 清理 MCP `secrets.json`，保留服务器定义，并验证目录/文件软链接不被跟随到外部。
- fixture 只允许数字回环地址，局域网、Docker 网桥、通配地址和主机名均被拒绝。
- request-id 仅为可选诊断字段，不计入身份门槛。

### 本轮验证与官方端点状态

- 相关 7 个测试文件在基础修复后 135 项通过；补齐千问 AI 平台端点后的身份/门槛专项
  24 项通过。计费相关 4 个测试文件 51 项通过。
- 完整回归在 macOS ARM64、Codex 沙箱外运行：2971 项通过、24 项跳过、1 项既有
  备份硬链接测试失败。后续新增平台地址单独经过上述专项验证，不将旧计数冒充新全量运行。
- `format:check`、benchmark 类型检查、全项目类型检查和文档检查已通过；最终检查结果以收尾记录为准。
- 既有双网关 smoke 离线重判仍为测量有效 4/4、业务通过 3/4；新重判文件带断言 hash，
  保留旧 `summary.reassessed.json`。没有新增网关模型调用。

官方 smoke 已真实尝试两次，均未取得有效模型回复：第一次按声明的百炼普通 Key 来源
使用百炼入口，返回 HTTP 403 鉴权失败；随后根据用户给出的千问 AI 平台来源，按该平台
官方文档更换入口及凭据，返回 HTTP 403 `AccessDenied`，并提示额度超限。
两次均按 `upstream_error` 分类、测量无效，业务质量未评估；身份门槛仍未通过。
没有把错误回复或静态白名单测试当作真实身份验收证据。
运行结束后清理了临时服务凭据，并逐文件检查未保留对应输入密钥原文。
这两次失败记录保留；后续使用用户指定的可用模型继续 smoke，结果见下节。
其他厂商官方端点也不据此宣称已验证。

### 官方端点 smoke 已跑通（2026-10-11）

用户指定有可用额度的千问模型后，使用同一千问 AI 平台官方 Messages 入口重新执行
退款用例一次。记录编号：`spike-2026-10-11T15-06-55-054Z`，候选别名为 `candidate-official`。

- `chainPassed=true`、`identityVerified=true`，本次 6 项门槛全部成立。
- 身份依据为 `official_endpoint_sdk`：严格的官方地址/目标模型策略与 SDK 上报模型匹配。
- Profile/Provider 绑定、全新状态证据、实际上下文快照校验均通过。
- fixture 调用 2 次，与 stream 对应；用量事件 2 条逐事件对账通过，
  非被测 Session 用量记录为 0。
- 全部业务断言通过 1/1，没有修改预期答案或断言阈值。
- 本次 SDK 仍未暴露上游 request-id（数量 0），它不参与身份门槛。

本次只验证一个官方模型的一条用例，不能据此宣称跨轮稳定性或正式模型排名。
`passed=false` 是 smoke 阶段保留完整 spike 验收门槛的设计；正式 5 × 3 尚未执行。
此前两个网关候选的外部模型身份核验仍是独立待办，不由本次官方验证替代。
临时服务凭据已清理，逐文件检查结果未保留本次输入密钥原文。

### 官方 + 网关组合 smoke（阶段 1 最终矩阵）

记录编号：`spike-2026-10-11T15-14-36-717Z`。同一轮包含两条退款/空订单用例，
每个候选各执行两次，顺序为 `candidate-1 → candidate-official → candidate-official → candidate-1`。
候选级结果存于私有 `summary.reassessed-b73d19bbcd50.json`，没有覆盖原始 summary：

| 匿名候选           | 尝试 | 测量有效 | 业务通过 | 身份状态       |
| ------------------ | ---: | -------: | -------: | -------------- |
| candidate-1        |    2 |        2 |        1 | 网关待核验     |
| candidate-official |    2 |        2 |        2 | SDK 身份已核验 |

官方候选两次均满足测量与身份门槛，Profile/Provider 绑定和用量对账通过。
网关候选两次 SDK 上报模型名匹配，但身份仍待网关日志核验；它们不进入已核验排名。
整体 smoke 的 `identityVerified` 不代替候选级状态。官方端点上游 request-id 本次仍未提供，
不作为门槛证据。完整 5 × 3 多候选运行尚未执行。

### 阶段 1 最终验收

- 官方 Qwen + 网关的同轮组合 smoke：候选级状态已分开记录，官方身份通过，网关待日志核验。
  这是阶段 1 所需的官方路径真实验证；不代表已完成 5 × 3 或正式排名。
- 将分散在多轮聊天与 smoke 的总身份状态拆为 `identityByCandidate`：官方候选的两次
  实际尝试均 `verified`；网关的两次尝试均 `gateway_pending`。整体 spike 仍不声称全部身份已核验。
- 备份硬链接回归在 macOS `cp -a` 会将链接展开为独立文件，Linux 等环境可能保留链接。
  测试现先测 staging 行为：保留时断言备份拒绝；展开时断言归档无硬链接条目；另外直接
  验证 staging 安全检查仍拒绝硬链接。只改测试，备份实现未改，提交 `6f71f01`。
- 最终 `make test`：**343 个测试文件通过，2974 项通过、24 项跳过、0 项失败**。
  macOS ARM64、Node v26.0.0。另有 `make typecheck`、`make build`、benchmark 类型检查、
  `npm run format:check`、`npm run docs:check` 与 `git diff --check` 全部通过。

按阶段门槛，阶段 1 验收完成；后续阶段尚未开始。

### 阶段 2：Promptfoo 接入与双候选全量运行（2026-10-12）

- Promptfoo `0.121.20` 与 `tsx` 已移入独立 `benchmarks/` npm 项目，新增子项目 lockfile；
  根 `package-lock.json` 与 `927a810` 完全一致。按该锁文件重装后检查了 318 个生产依赖，
  缺失与版本不匹配均为 0；Anthropic SDK 为 `0.93.0`、`ws` 为 `8.21.0`。
  根 `npm ci` 和 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix benchmarks` 均通过；
  `CLAUDE.md` 已将 Node 项目数改为四个。根目录安装报告 22 项基线公告，benchmark 子项目
  安装报告 12 项公告，仍需分别分级；它们不会进入产品依赖树。
- `bench:run` / `bench:report` 通过根 npm 脚本委托给 benchmark 子项目。Provider 仍复用真实
  Container `attempt()`，以单 Provider 加候选变量逐次路由。测试行带 JavaScript 断言，metric
  分为 `measurement`、`completion`、`facts_evidence`、`instruction` 和 `tools`。
  `bench:report` 从 trace、fixture 账本、usage 数据库、Context 和 fresh-state 文件独立重判，
  再与 Promptfoo metadata 逐项比较。每次重判写 `reassessed.json`，原始 `result.json` 不参与分类。
- 完整 30 次运行：`promptfoo-2026-10-11T16-28-09-907Z`，业务通过 28/30、失败 2 次；
  该次仍只有两个网关候选。首次 parity 发现重复轮次字段漏写。修复前曾临时改写 30 个
  `result.json`；之后已把原字段内容恢复，并将带重复轮次的版本另存为 `result.reconciled.json`，
  同时记录当前恢复文件和 sidecar 的 hash。恢复时逐个核对：30/30 除 `repetition` 外的 JSON
  字段一致。但改写前没有保存原文件 hash，无法证明原始字节级一致性；因此该次运行缺少后来
  加入的 `context-evidence.json`，独立重判将其标为不可判定，不作为阶段 2 独立验收依据。
- 更新后的「官方候选 + 网关」真实 smoke：`promptfoo-2026-10-12T02-01-37-408Z`，4 次尝试。
  原始证据完整，执行顺序、独立重判和 Provider parity 全部通过；测量与业务均 4/4 通过。
  官方候选身份核验通过 2/2、质量合格 2/2；网关候选为
  `gateway_pending` 2/2，不进入质量排名。Promptfoo 五组断言结果 4/4 通过。
  两个候选均没有定价，报告成本保持 `null`；Promptfoo UI 的成本列不作为费用来源。
- 缓存重分类计费修复独立提交为 `7571478`。阶段 2 首次接入提交为 `eb29204`，
  依赖隔离与独立重判修复提交为 `60d5ed9`。
  最新 `make test` 为 **2,989 项通过、24 项跳过**；`make typecheck`、`make build`、
  benchmark 类型检查、格式检查、`docs:check` 均通过。

阶段 2 验收完成，阶段 3 尚未开始。进入阶段 3 前仍需为候选补充带来源和生效日期的价格，
并计划更大样本的身份已核验候选运行；Judge 与 holdout 不属于本阶段。

### 阶段 3：指标与脱敏报告（2026-10-12）

- Promptfoo 独立子项目升级到 `0.124.1`，版本和 lockfile 一致，根目录产品 lockfile 未变；`tsx`
  升级到 `4.23.15` 以修复其构建依赖公告。
  安装审计输出为 9 项公告（2 moderate、7 high、0 critical）；当前网络下单独重查公告接口未返回
  可解析结果，仍需在 registry 可用时复核公告明细。
- 独立重判不再采用 `context-evidence.json.expected` 或候选的派生 `gateway` 值；Profile 提示词和
  Runtime Policy 从版本库 `profile.yaml` 推导，并与该次全新数据库里的 Profile 行核对。用例定义
  与仓库源文件比对，业务预期直接取源用例。端点身份通过 `requiresGatewayAudit` 再计算。原始
  `result.json` 保持不动。
- 新增 `identity` Promptfoo metric：SDK 身份门槛未通过的候选在界面显示失败。报告定义任务完成率为
  `businessPass` 通过率，并将状态字段正确率单独标为 `status_accuracy`。其他分维度通过率按对应检查的
  总通过数除以总检查数，采用微平均。时延仅统计 measurement-valid attempts。
- pass^3（缺失或不合格重复标为不可判定）、首次通过率、平均通过率、成本与 10,000 次按 case 配对
  bootstrap 区间都进入报告。无效运行或候选不合格率超过 10% 时，不参与排名和成对比较。两两比较未做
  多重比较校正。成本含失败尝试与重试；任一匹配费率或 usage 未知时，总成本为 `null`。
- 价格条目绑定 `sha256(model + "|" + origin)` 与计费区域，不能只依赖匿名别名；只有端点来源、模型和
  区域都匹配时才使用费率。费率来自官方模型市场中国内地价格卡；一个候选的缓存读取计量无法唯一映射
  到平台计费项，因此其缓存读取成本保持未知。Promptfoo UI 成本列标为无效，以独立报告为准。
- 公开 Markdown 只使用运行级哈希别名、指标、区间和样本数；写出前扫描候选模型 ID、完整地址、主机名、
  私有别名和厂商关键词，发现匹配即失败。合成测试覆盖不合格分母、pass^3 不可判定、
  配对重抽样、价格指纹/区域错配、价格未知和脱敏泄漏拦截。benchmark TypeScript 检查通过。
- 升级后的真实 smoke 使用已固定的本地镜像和现有唯一候选，共 1 次调用：证据完整、执行顺序和
  Provider parity 通过，测量与业务断言通过；身份为网关待核验，因此质量合格数为 0，Promptfoo 的
  `identity` 分数为 0，整体 Promptfoo 结果失败符合门槛。重算报告将该别名价格判为未知。Smoke 当时
  的 Promptfoo metadata 曾带运行时成本值；这不作为费用证据，原始结果保留，`bench:report` 独立
  重算为未知成本。

阶段 3 的首轮实现等待复验。已发现并正在修复价格仅按别名关联、任务完成率维度含义不符，以及真实
指标矩阵没有覆盖官方双候选的问题。Judge、holdout 与业务集扩充仍未开始。

### 阶段 3 复核修正（2026-10-12）

- 每条费率现在同时绑定模型+origin 的 SHA-256 指纹和 `cn-mainland` 区域；相同别名更换模型、origin
  或区域时成本返回未知。费率来源改为千问 AI 平台模型市场，并按该平台两个候选各自的公开价配置。
  第二候选的兼容接口 `cache_read_input_tokens` 映射到平台显式缓存命中价。
- `completion` 改为 `businessPass` 通过率，`status_accuracy` 独立报告。facts/evidence、instruction、tools
  按检查总数微平均。时延只统计 measurement-valid attempts；不具备排名资格的候选不进入 bootstrap，
  且报告声明未做多重比较校正。
- 公共报告泄漏检测增加本地别名与厂商关键词；完整候选配置仍只用于私有扫描。新增 `--case-limit 2`，
  可用两条用例、三次重复生成真实比较矩阵。
- `tsx` 升至 `4.23.15`；安装审计剩 7 项 high，来自不使用的代理/FTP/JKS 依赖链。BENCHMARK 文档已登记
  该本地开发依赖风险。最终全量测试 **2993 项通过、24 项跳过**；`make typecheck`、`make build`、
  benchmark 类型检查、格式、文档和 diff 检查均通过。
- 首轮真实矩阵中第二候选 6 次均返回认证失败，未覆盖任何统计值；保留原运行，未改写其证据。
  按官方接口文档换成同区域另一候选后，新运行 `promptfoo-2026-10-12T03-30-19-674Z` 完成 12 次尝试：
  测量有效 12/12、官方身份核验 12/12、业务通过 11/12，Provider parity 和执行顺序均通过。
- 公开匿名候选 `candidate-9f232a21b0` 的首轮通过率 100%、平均通过率 100%、pass^3 为 2/0/0；
  `candidate-8c0f0ec8b4` 的首轮通过率 100%、平均通过率 83.3%、pass^3 为 1/1/0。配对通过率差
  16.7 pp，95% bootstrap 区间为 [0, 33.3] pp，n=2；区间包含 0，只能表述为未观察到显著差异。
- 成本按匹配指纹和区域重新计算：两个匿名候选的总成本分别为 CNY 0.227704 和 CNY 0.045684，
  每个成功任务分别为 CNY 0.037951 和 CNY 0.009137。公开报告泄漏检查通过；私有运行目录中凭据文件、
  provider snapshot 和 key 格式痕迹均为 0。

阶段 3 的代码修正、全量验证和真实指标矩阵现已完成，等待验收；阶段 4 尚未开始。

### 阶段 4 范围补充与实现记录（2026-10-12）

遵照阶段 4 的两项范围补充，六阶段结构和顺序不变：

- 在隔离 fixture MCP 中加入 `create_refund_request` 与 `escalate_to_human` 两个模拟写工具。退款工具只创建 `pending` 申请，人工工具只创建 `queued` 跟进记录；不会连接真实店铺或资金系统。8 条用例断言最终状态，覆盖正确金额/币种、不符合资格或政策冲突时不退款并转人工、重复申请防护，以及查询场景不得产生副作用。
- 增加 3 条固定脚本多轮用例。每条将用户消息按序发到同一全新 Session，不模拟用户、不根据模型回复生成后续内容；最后一轮回复、全轮工具事件和最终 fixture 状态都进入确定性检查。
- 用例共 68 条：客户政策 28 条（dev 22、holdout 6），商品对比及广告复盘各 20 条（dev 14、holdout 6），dev 总计 50 条、holdout 18 条。
- Holdout 现在必须同时显式传入 `--split holdout --final-run`；不可 `--smoke`、`--case-limit`、单候选筛选或重复启动。留出集只在最终正式选型运行中使用；阶段 5 Judge 校准和阶段 6 配置对比都只能使用 dev。失败的最终运行也消耗唯一 holdout 运行额度。
- `reassess` 不采用 `context-evidence.json.expected`，从版本库 Profile、运行数据库和实际上下文重新构造期望值；网关标记从候选端点和原始声明重新计算，不信任派生字段。写操作最终状态从 fixture MCP 调用账本重放并与私有状态快照比较。独立报告显式输出这三项重判来源。
- 费率文件注明：缓存读取按显式命中价计费仍是未经平台账单核对的假设；若实际按普通缓存命中价计费，模型成本会被低估。`pricing.yaml` 可由候选集合、价目与来源反推模型，匿名只适用于通过泄漏检查的公开报告。

#### 本轮验证与未完成验收

- `tests/benchmark-cases.test.ts`、spike/transport/service/gates 与 Promptfoo 专项测试：**91 项通过**；benchmark 类型检查、`docs:check` 通过。覆盖 68 条 Schema/标签矩阵、oracle、金额/币种/证据/工具/禁止结论变异、分页、缺字段、模拟超时业务分类、写操作状态和重复申请幂等性。
- 使用一个本地已配置但身份待核验的候选执行过早期 42 条 dev 尝试。其原始逐次结果有 22/42 被初始逻辑标记为 measurement-valid（52.4%），其中 18 次 `audit_mismatch`、2 次超时、2 次上游错误，未达到 95% 门槛；此外当时重判在 `summary.json` 写出前读取 split 信息而失败。该矩阵不是可接受报告：之后用例定义和工具断言发生了变更，不能用于质量指标或通过率结论。
- 另有一条早期 smoke 的 1/1 尝试 measurement-valid，但业务检查被标为 `tool_policy_violation`，候选身份仍待核验；当时也没有生成完整报告。现已在评测开始时写入 `run-metadata.json`，并由重判读取，覆盖“报告尚未写出”的顺序问题。旧运行保留，仅作诊断，不追加或覆盖原模型调用。
- **当前阶段 4 尚未验收通过**：最终 68 条矩阵下的 dev Container 全量测量有效率 ≥95% 还未复验。下一步应先确认 fixture 调用账本与 stream 事件能稳定一一对应，再以一个候选跑完整 50 条 dev；若仍低于 95%，报告为阻塞并调查，不得用重复运行筛掉失败样本。

阶段 4 实现已按新范围更新，但真实 dev 门槛仍待通过；阶段 5、6 均未开始。

### 阶段 4 账本/stream 对账诊断（2026-10-12）

- 检查旧的 42 条 dev 运行 `promptfoo-2026-10-12T04-20-04-695Z` 的原始文件后，确认它只用了一个网关候选。18 条旧 `audit_mismatch` 不能一概解释为 WebSocket 漏事件：其中 17 条是 stream 有 fixture 工具开始事件而 fixture 账本没有对应记录；这组里有 11 条最终回答明确记载工具不可用，证据指向工具调用在抵达 fixture 前失败。另有 2 条是 fixture 账本有调用而 stream 没有 fixture MCP 调用，同时出现 Bash，符合绕过 MCP 的工具策略违规。多条不匹配还伴随其他禁用工具调用。
- 旧 trace 没有保留工具结果事件的错误标记，因此无法事后严格区分 MCP 执行失败和工具遥测缺失；不通过修改旧证据来重判。`commerceagent-provider.ts` 现将工具结果是否明确失败、结果是否收齐及工具 ID 关联写入新的私有 trace。审计会把明确失败的调用计作可观察的工具执行失败，并把“账本调用 + 可见禁用工具”归为工具策略违规；只有无法解释的差异仍为 `audit_mismatch`。
- 模拟写操作工具现在只对带 `write-operation` 标签的用例开放；其他业务用例只收到只读工具定义，避免把写能力无条件暴露给整套用例。
- 新增离线断言覆盖三类情形：明确失败的工具结果、带 Bash 的 fixture 账本调用、没有结果的孤立 stream 工具事件。阶段 4 50 条 dev 全矩阵尚未重跑，测量有效率门槛仍未验收；本轮未运行 holdout，也未进入阶段 5/6。

### 阶段 4 首次完整 dev 验收与采集修正（2026-10-12）

- 使用固定镜像 `sha256:e7a2989fbcfaaa0ea922924d27f718ce2fc0787609f0f6cd6b619da1ee897d1e`、一个本地网关候选，完成 50 条 dev × 1 次运行：`promptfoo-2026-10-12T07-43-05-334Z`。原始结果 `summary.json` 显示证据完整、执行顺序正确、Provider parity 通过；测量有效 46/50（92%），低于 95%，因此阶段 4 门槛未通过。测量失败为 1 次上游错误（`runner_exit`）和 3 次 `collection_incomplete`。业务通过 3/50；34 次工具策略违规和 13 次业务断言失败。候选为网关待核验，质量合格样本为 0，成本未知；不生成排名结论。
- 对 3 条多轮失败的只读证据核对显示：Runner 日志中的 `turnId` 是 IPC 运行标识，`inputTurnId` 才与持久化消息 `message.turn_id` 对应。WebSocket 收集器把这两个不同用途的 ID 当成同一标识比较，丢弃了数据库中已完成的 `sdk_final` 回复，随后触发 5 秒收集超时。根因已确认在 benchmark 采集适配器，不在 fixture 账本；单独的上游错误仍需保留为失败。
- `observeTurn` 现分别保留 StreamEvent `turnId` 和最终消息 `messageTurnId`，不再错误比较两者；加入 ID 不同但同一 Session 最终消息应被收集的 WebSocket 回归测试。重判报告新增完整 50 条 dev 的 `measurementValidityGate`，阈值固定为 95%；`invalidRun` 继续只表示证据/顺序/parity 完整性，不能掩盖测量有效率未达标。
- 原始 50 条结果及其 `result.json` 未覆盖。原 `summary.json` SHA-256 为 `050d2ff9a08ed45fef1ab640368a0b87423af1264cd86bf7c3a201b3c0da7b2a`；3 条多轮失败的原始 `result.json` hash 已在本地核验。修正后另起一轮完整 dev 运行，不向本轮追加或覆盖模型调用，也不运行 holdout。阶段 4 当前仍未验收，阶段 5、6 未开始。

### 阶段 4 修正后验收（2026-10-12）

- 新建完整运行 `promptfoo-2026-10-12T08-43-34-666Z`，固定镜像 ID 与前轮一致，一个本地网关候选、50 条 dev × 1 次。独立重判报告显示 `evidenceComplete=true`、`executionOrderValid=true`、`providerParityValid=true`，50/50 测量有效（100%），`measurementValidityGate` 阈值 95%、通过。公开摘要泄漏扫描通过；holdout 累计运行数仍为 0。
- 之前失败的 3 条多轮用例本轮都收齐最终回复，每条脚本两轮消息 ID 均有记录；8 条写操作用例都由实际 fixture 最终状态与调用账本重放完成核对。
- 网关候选仍是 `gateway_pending`，`qualityEligibleAttempts=0`，业务全项通过 2/50，成本未知。因此仅阶段 4 的测量链路验收通过；没有模型排名结论。阶段 5 和 6 未开始，等待阶段验收。
- 最新检查：`make test` **3010 项通过、24 项跳过**；`make typecheck`、`make build`、benchmark 类型检查、格式、文档和 diff 检查通过。结果摘要 SHA-256 为 `5f8783db0265ba1a345cf07df45fef47608395bbed6dd5fd5d989416664be0ff`。

### 阶段 4 MCP 工具可用性复核（2026-10-12，前述验收结论撤销）

- 对原始 `trace.json`、fixture 调用账本和模型回复复核后，两次完整 50 条运行均没有成功的 fixture MCP 工具结果。较新的运行有 39/50 输出为结构化 `unavailable`、21/50 尝试含 Bash，5 次尝试中共有 12 条 fixture 账本记录，均属于绕道；较早运行同样为 0 次成功 fixture MCP 结果。原 `summary.json` 与 `result.json` 保留不动，私有目录新增 `invalidated.json`，记录原因、计数和摘要 hash。两次运行均不参与质量统计或排名。
- 根因是版本化 fixture 的数值 `version` 被放进 MCP `serverInfo.version`，违反 SDK 的字符串 schema，造成 MCP 初始化失败。服务现在将该值序列化为字符串。Container 内固定镜像 SDK 初始化探针验证 `commerce_fixture` 为 `connected`，六个工具均出现在 init 工具列表；探针使用回环 fixture，在模型请求前中断。
- eval 实例启用 MCP `alwaysLoad`，benchmark Runner 的 `allowedTools` 收敛到 `mcp__commerce_fixture__*`，从可调用工具层阻止 Bash/Read 等旁路；Runner 将 MCP server 状态和可见工具写入脱敏 init 标记。运行和独立重判均据此验证服务已连接、当前用例必需工具齐全。显式 “No such tool available” 分类为 `tool_unavailable`；fixture 账本调用与非 fixture 工具同现则分类为 `fixture_bypass`，两者均使测量无效。整轮成功 fixture MCP 结果数为 0 时整次运行无效。
- 写操作断言现在同时检查服务最终状态与成功 MCP 结果账本重放；空账本即使状态快照看似符合，也无法满足预期退款/转接记录。回归覆盖 MCP 不可用、显式缺工具、Bash 绕道、写操作无账本证据和 fixture MCP 正常连接。
- 固定镜像 init 探针确认连接及六个工具；5 个专项测试文件 **106 项通过、24 项跳过**，benchmark 类型检查和项目类型检查通过。接下来需完成格式/构建/全量测试，再以新 run-id 运行完整 50 条 dev。新运行结果未产生；阶段 4 仍未验收，holdout 未运行，阶段 5/6 未开始。
- 后续一次新 run 在第 4 条后停止：成功 fixture MCP 调用已在 StreamEvent 和账本中出现，但 attempt 在服务进程退出前读取尚未 flush 的 Runner 日志，把 SDK init 证据误判为缺失；同时发现 benchmark 的 `alwaysLoad` MCP 覆盖当时未纳入 capability preview hash，导致上下文 hash 不一致。该部分运行另有 `invalidated.json`，原始逐次文件未改，未纳入指标。现在先停止并等待每次服务退出以读取 durable init 日志，并让 capability preview 与 Runner 使用相同的 `alwaysLoad` 变换；须由后续真实运行验证这两项修正。

### 阶段 4 修复后完整 dev 测量验收（2026-10-12）

- 修正 fixture MCP 初始化的字符串版本字段；benchmark 模式将 Agent SDK 的内建工具集设为 `[]`，只开放 fixture MCP，避免 `allowedTools` 仅自动授权却未禁用 Bash 的问题。对每条用例的 Profile MCP 设置强制 `alwaysLoad`，并让 capability preview 与实际 Runner 使用相同变换，因此 MCP manifest hash 与实际上下文证据一致。
- 不再只依赖偶发缺失的 `system/init` 日志。Runner 在 SDK 最终结果时主动查询 `mcpServerStatus()`，只写入脱敏的服务名、连接状态和工具名；每次服务停止、日志落盘后，驱动器再读取该证据。对所需工具缺失、MCP 返回 “No such tool available”、fixture 绕道分别做 fail-closed 测量分类；成功 fixture MCP 调用数为 0 时整轮作废。预期写操作同时核对 fixture 状态快照和成功调用账本重放。
- 新 run `promptfoo-2026-10-12T14-43-11-523Z`：完整 50 条 dev × 1 次，测量有效 **50/50（100%）**，MCP 已连接且必需工具可见 **50/50**，成功 fixture MCP 结果 **105**，fixture 绕道 **0**、Bash 事件 **0**；账本/状态对账 **50/50**。执行顺序、证据完整与 Provider parity 全部通过，95% 测量门槛通过，`invalidRun=false`。私有 `mcp-integrity-review.json` 保存上述计数及来源 hash。
- 8 条写操作用例全部完成状态与账本核对，业务状态检查通过 4/8；完整业务断言通过 3/50，另有 2 次工具策略违规。唯一候选身份仍为 `gateway_pending`，质量合格样本 0，成本未知，因此只验收阶段 4 测量链路，不做排名或业务能力结论。holdout 运行数为 0；阶段 5/6 尚未开始。
- 工程验证：`make test` **3020 项通过、24 项跳过**；`make typecheck`、`npm run bench:typecheck`、`make build`、`npm run format:check`、`npm run docs:check` 和 `git diff --check` 均通过。此次运行本身 `evidenceComplete=true`、`executionOrderValid=true`、`providerParityValid=true`，测量有效率 100%。此前 `07-43-05-334Z`、`08-43-34-666Z` 两次完整运行以及 `13-23-44-848Z`、`14-34-31-892Z` 两次中途运行都保留原始数据并有 `invalidated.json`，不参与指标。

### 阶段 4 用例契约复核（v2，整体验收待重新验证）

- 接受“测量链路通过、用例集未通过”的复核结论。必需事实字段名此前未公开，事实断言还拒绝额外字段；本次以每条 `requested_facts` 公开字段及含义，必需字段按 oracle 判值，额外证据只允许真实工具检索所得。标准答案、字段名和答案数值分开存放，Runner 只收到任务说明，不挂载标准答案或 oracle。
- 广告 fixture 从逐字日期匹配改为闭区间重叠；返回原始整周期数据且不按重叠比例拆分。调用断言接受覆盖完整目标周期的更大区间及活动全量查询，输出仍必须过滤到题目目标周期。所有广告题补齐绝对日期；客户政策题显式指定业务日期，模拟申请使用 2026-09-08，普通金额题明确只做付款减扣费的算术，不宣称具备退货资格。
- 复核 `pc-02`：oracle 的 stock > 0 过滤及 BT-A 预期正确；附加 BT-B 比较证据不应失败。修正 `pc-10` 把在库推荐证据指向缺货型号的问题，并补充容量；`pc-16` 补上题目要求的保修事实。`pc-01/03/09` 明确零价排除及预算/电压条件，`pc-05/14/15` 明确零价合法；`pc-06` 改为非零报价的含上限预算边界，并相应改正 oracle/证据。全部次数上限保持原值。
- 原因/状态断言复核发现因果正则会误杀否定句，改为明确的布尔事实字段；不再要求隐藏的固定短语。拒答中的禁止操作声明按肯定句检查，避免把“不能确认已经到账”判作声称到账。变更原因、前后文件 hash 及评分代码 hash 见 `benchmarks/cases/contract-revision-v2.json`。
- 全部 68 条有固定标准答案、单位、证据、工具参数与调用计划；不在测试运行时从 oracle 自动重造标准答案。已真实执行本地 fixture 自检，**68/68 通过，728 个变异全部被拒绝，真实模型调用为 0**。真实运行会先自检所选用例并记录源码与参考答案 hash。
- 首次 v2 开发集在第 6 条后停止：ad-03、ad-04 的事实、证据、参数和 MCP 状态均正确，但自然语言答案分别超过未公开的 240 字上限。该隐藏指令不能归因为模型错误；完整 run-id 有 `invalidated.json`，原始结果保留，隔离服务凭据已清理。现将语言、是否必需自然语言答案、字数上限及词组要求放入公开任务契约；既定 240 字数值不变。
- benchmark 模式同时移除产品自带的 commerceagent MCP，关闭记忆搜索旁路。该模式是用户明确授权的隔离实验例外，已在 `BENCHMARK.md` 对照 `CLAUDE.md` 的开放产品工具原则说明，不是产品工作区的权限模式。
- 原运行账本 106 行 = 105 个成功 MCP 结果 + 1 个预期注入超时结果；`success` 表示参数接受和调用已审计，不表示结果无错误。新账本显式记录 `isError`。原完整性文件不改，另写 `mcp-integrity-review.reconciled.json` 并记录原文件 hash。
- 先对旧 50 条已保存结果离线重判：原业务通过 3 条，修订断言下为 6 条；由于旧模型没有收到修订后的字段/日期契约，重判仅供诊断，禁止用于排名或模型归因。没有追加调用或补造工具证据。新开发集真实运行和逐条失败归因尚待完成，阶段 5/6 未开始，holdout 真实运行数仍为 0。

### 阶段 4 v2 完整 dev 运行和失败归因（2026-10-13）

- 新 run `promptfoo-2026-10-13T02-17-16-887Z` 在第一条真实调用前执行标准答案自检：50/50 参考答案通过、689 个变异被拒绝，真实模型调用为 0。随后完整执行 50 条 dev × 1 次：50/50 测量有效，fixture MCP 50/50 就绪，99 个成功 fixture 结果加 1 个预期超时结果，账本共 100 条；Bash/产品记忆 MCP/fixture 绕道为 0。一次不带 MCP 命名空间的裸 `get_ad_report` 调用收到 SDK 的 “No such tool available”，同一用例随后使用正确的命名空间工具并得到预期注入超时；fixture 工具本身未返回 No-such-tool。复核后该裸别名被视为模型工具名错误。执行顺序、证据完整和 Provider parity 全部通过。留出集仍未运行。
- 失败复核 `failure-review.e09fad3ccd50.json` 从固定标准答案、原始工具账本重放、最终 fixture 状态以及当前断言重新核对 26 条业务失败：`model_error=26`、`case_or_assertion_error=0`、`fixture_error=0`。评测后的命名空间检查也确保裸别名不作为 fixture 工具接受。原 run 的 summary/trace/result 没改，复核另写私有 sidecar。账本的 100 行包含 99 个成功 MCP 结果和 1 个预期超时错误；差额已在 `mcp-integrity-review.reconciled.json` 说明并保存原完整性文件 hash。
- 业务全项通过 **24/50（48%）**，26 条失败都已有逐条检查名、事实差异、工具参数和哈希证据。失败复核通过只表示当前剩余失败可归于模型；业务表现本身仍偏低。候选身份仍为 `gateway_pending`，quality eligible=0，不产生排名或模型优劣结论，成本 unknown。
- 最新全量检查：**3096 项通过、24 项跳过**；`make typecheck`、benchmark 类型检查、build、format、docs 和 diff 检查均通过。阶段 4 按“标准答案/断言与 fixture 通过自检、完整 dev 测量有效、剩余失败均可解释为模型错误”的标准通过；阶段 5/6 尚未开始，等待阶段验收。

### 阶段 4 用例可发现性复核与修正（2026-10-13）

- 撤销上面的 `promptfoo-2026-10-13T02-17-16-887Z` 用例质量结论。独立复读 50 份原始账本发现，当时工具 schema 未公开政策主题、市场和商品类别可选值；54 次政策/商品查询中有 44 次返回空（政策 29/30、商品 15/24）。该运行的测量采集仍可用于链路诊断，但不能用于业务通过率或模型归因。原始 summary、trace、账本、逐次结果均保留；私有 `case-contract-invalidated.json` 和 `case-contract-invalidated-ledger-review.json` 保存原因、逐账本 hash 与计数。
- `search_policy` 现公开市场与主题枚举，`list_products` 公开类别枚举，并附中英文含义。值从 fixture 派生；对于有意查询空结果的巴西市场，枚举明确包含 `BR`。每次 attempt 的 `toolSchemaHash` 现在覆盖实际发给 SDK 的 schema。
- 固定答案自检现检查每项参考调用是否符合实际 MCP inputSchema、每个枚举参数是否能从题面或前序查询结果推出，再调用隔离 fixture 确认数据可得。68 条 dev/holdout 参考答案全通过，932 个断言变异全部被拒；没有模型调用。46 项 fixture/归因专项测试通过。
- 发现 `pc-05`、`pc-06`、`pc-08` 和 holdout `pc-19` 未告知商品类别；题面已补充自然语言类别信息，仅同步更新受影响的 caseHash，没有修改 oracle、标准数值、工具调用上限或评分断言。`ad-05` 保持 `clarify`：周期记录存在，但缺少 conversions，无法计算 CPA。Profile 已明确区分完整查询无记录的 `not_found`、记录存在但关键信息缺失的 `clarify`、参数不足的 `clarify`。
- 本轮验证已通过 benchmark typecheck、专项测试 46/46、全量 `make test` 3099 项通过/24 项跳过、`make typecheck`、`make build`、格式、文档和 diff 检查。完整 dev 重跑尚待可用且已轮换的本地凭据；holdout 未运行，阶段 5/6 未开始。
- 随后启动的 100 次完整 dev run 达到 99/100 测量有效，但独立 parity 因 1 个超时 attempt 的 `usageReconciled` gate 不一致而失败。运行时在停止服务前读取用量，重判时读取停止后的持久化数据库；唯一差异是该 gate。原始 run 保留并有 `invalidated.json` 记录，不能用于质量统计。已将 attempt 的 usage 读取移到服务退出后，确保运行时结果与独立重判都读最终数据库快照；34 项服务/失败归因专项测试及 benchmark 类型、格式、文档检查通过。修正后的完整 dev 矩阵仍待重跑。
- 后续 100 次 dev run 的执行顺序正确、测量有效 96/100，但 3 次启动/采集异常没有 trace、context 和 fresh-state 文件，导致 `evidenceComplete=false`，且 Provider 将其记为 `environment`、重判只能归为 `collection_incomplete`。该 run 也已保留并作废。现在 attempt 在清理服务和落盘 fixture 最终状态后写入 `interruption.json`，只含阶段、错误类别和源文件 hash；重判验证 manifest 和每个文件 hash，再独立确定错误类别。相关 24 项中断、Promptfoo 和失败复核测试通过；最终完整 dev run 待验证。
- 该轮作废运行的 12 次环境异常都发生在 bootstrap，原记录只保留 `DOMException`，无法区分配置 API 哪一步超时。现在 bootstrap 记录匿名阶段名，并把隔离 eval API 请求超时从 20 秒提高到 60 秒；中断清单只保留安全化错误名/错误码和阶段，不记录消息、模型或 Endpoint。下一轮完整 dev 将验证这项修正。
- 用以上诊断改动执行的下一轮 100 次 dev run：证据完整、顺序和 parity 通过，但有 12 次 bootstrap 环境超时，测量有效率 84%，低于 95% 门槛。原始文件保留，私有 `invalidated.json` 标记该矩阵不得用于质量统计。为避免无必要的双候选成本，下一轮改为身份可核验候选跑完整 50 条 dev × 1 次，仍覆盖全体用例并验证测量门槛。
- 最终 dev run `promptfoo-2026-10-13T12-35-00-032Z` 使用身份可核验候选和固定镜像，50/50 测量有效，执行顺序、独立 evidence、Provider parity 全部通过。身份 `verified`、50 个质量合格样本；业务通过 40/50。`bench:review` 逐条重放 10 个失败，分类 `model_error=10`、`case_or_assertion_error=0`、`fixture_error=0`；无补跑模型调用。成本因模型指纹与本地价格条目不匹配而记为 unknown。公开报告泄漏检查通过；holdout 未运行，阶段 5/6 未开始。
- 报告 CLI 现在同时接受 run-id、绝对路径和仓库相对结果路径；对应路径解析测试已加入。最终全量门槛结果记录在阶段交付回复中。

### 阶段 4 断言离线复评与阶段 5 前置（2026-10-13）

- 复核最终 50 条 dev 运行的 10 个失败，确认 3 条注入用例只是提及恶意内容，并未执行注入。注入检查改为核对泄漏主张、未检索 fixture 标识、事实/证据和工具行为；ad-10、cp-09、cp-10 经原始轨迹离线重评为通过。
- 独立评估格式与语义：JSON 围栏仍记格式失败，但可解析内容继续参与状态、事实、证据和安全检查；不可解析的语义检查记为 N/A，指标微平均忽略 N/A。加入引用注入文本仍通过、虚构未检索订单号失败、代码围栏语义继续评估等回归测试。
- 核对官方模型卡后，将本地候选的模型/origin 指纹价格绑定到 candidate-cn2：输入 ¥12、输出 ¥36、cache-read ¥1（显式命中）、cache-write ¥15、reasoning ¥36 每百万 token。原始运行成本无需补跑模型即可重算；缓存账单映射仍未核实。
- 对 run `promptfoo-2026-10-13T12-35-00-032Z` 执行只读离线重评：业务通过从 40/50 修正为 43/50；剩余 7 条为 1 条事实编造和 6 条格式错误。pass^3 因只有一次重复，50 条均不可判定。重评保存为带来源 hash 的私有 sidecar 与脱敏公开摘要，原始结果保持不变；模型 API 调用数为 0。
- 本轮无真实模型重跑。阶段 5 的 Judge 尚待 OpenCode Go Judge 模型 ID 与本地凭据；当前参赛模型属于 Qwen，Judge 应选不同模型家族。holdout 保持未运行。

### 阶段 5 Judge 接入准备（2026-10-13）

- 增加 `bench:judge` 和 `bench:calibrate`。Judge 只读已保存的 dev 运行，过滤 measurement-valid 与 quality-eligible 尝试，按类别和确定性通过/失败分层抽取 20 条；每条分完整度、事实依据、决策恰当性和专业语气四项，4/5 分为通过。确定性断言与 Judge 结果单独保存。
- 使用 Promptfoo 内建 `llm-rubric` 评分 Provider，主 Provider 仅从本地结果回放候选回答。生成的评测上下文不含候选别名或模型字段；API Key 只从一次性本地文件进入进程环境，配置、回答和评分写入权限为 0600 的 Git 忽略目录。整批调用前先进行合成提示注入探针，探针失败立即停止。
- `bench:calibrate` 先导出不含 Judge 评分或候选身份的人工 JSONL，再据此计算逐维度/整体一致率、Cohen's kappa、误通过和误拒绝；20 条不足或整体 kappa 低于 0.6 时，Judge 仅作参考。
- 本机已生成最终待审阅的 20 条盲评请求预览（80 个评分请求加 1 个合成注入探针），仅含合成 benchmark 问题、期望事实、rubric 和已保存候选输出；预览检查确认候选身份信息未泄漏。生成预览没有调用任何 API。
- 本轮全量验证：3110 项通过、24 项跳过；类型检查、构建、格式、文档与 diff 检查通过。收到外发授权后，首次 Judge 执行在合成注入探针阶段退出，80 条候选评分请求未启动；由于首次运行时还没有持久化 probe 状态，无法核实该合成探针是否到达服务端。探针不含候选回答。一次性本地密钥文件已被导入流程删除；脚本现会在探针和批量评分的各阶段写入脱敏状态，后续重试需重新保存本地 Key。

### 阶段 5 校准统计与来源补充（2026-10-14）

- 保留原二分通过一致率、Cohen's kappa、误通过/误拒绝；每个 1–5 分维度新增评分完全一致率、二次加权 kappa、评分分布及不可定义原因。恒定标签的原始一致率可为 100% 而 kappa 为 null；既定 20 条、二分 kappa ≥0.6 门槛不放宽。
- 私有 Judge 执行记录新增请求模型、接口地址、UTC 时间、Provider 类型、Promptfoo 版本和源码 hash；网关上游版本保持未知。每次执行使用独立目录，校准结果绑定执行、报告与人工标注 hash，适用范围明确限定到本次抽样和配置。
- 修复探针把 Promptfoo 顶层 error 当成 Provider 故障的问题。锁定版本的 evaluator 会给普通断言不通过填写 error；正常低分探针应被接受。现在根据真实 Provider/grader 故障标记和合法的离散 1–5 分判定，错误评分不再四舍五入成有效分。历史探针结果未保存，不能据此断言历史退出原因。
- 人工重复 sampleId 或缺失样本会被拒绝，防止重复标注虚增样本数。盲标文件继续隐藏 Judge 分数和候选身份。本轮只做离线修正；本地 Key 模板尚为空，未新增 API 请求。
- 使用真实 Promptfoo 加本地假 Judge 的集成回归复现了正常低分结果会填写顶层 error，修复后探针被正确接受。该离线测试还发现锁定版本关闭遥测变量后仍尝试发送 opt-out 事件；测试桩拦截了请求，未外发。评测进程现安装 fetch 地址限制，Judge 仅允许批准的 API 路径，端到端驱动仅允许回环请求，额外遥测和重定向会被拒绝。
- 验证：Judge/Promptfoo 专项 30 项通过，全量 3115 项通过、24 项跳过；make typecheck、benchmark 类型检查、make build、format、docs 和 diff 检查通过。重新生成的 81 请求预览 hash 与已授权预览一致；本轮新增真实模型调用为 0，阶段 5 仍待可用本地 Key 与人工盲标。

### 阶段 5 真实评分与 AI 辅助人工校准（2026-10-14）

- 在用户既有外发授权下完成执行 `judge-2026-10-14T02-25-05-385Z-f4cf140c`：合成探针通过，20 条 dev ×4 维度得到 80 项有效评分，Provider/grader 错误 0，缓存文件 0，Key 文件已删除。原 251 份证据 hash 未变；未新增参赛模型调用，holdout 未运行。
- 按用户给定 sampleId 写入 20 条、80 个评分及备注。用户声明 AI 草拟、本人逐条复核，报告明确标注“AI 辅助人工标注”并保留相关偏差限制；没有宣称是纯人工独立标注。人工确认前未展示 Judge 分数。
- 整体二分一致率 35%，κ=0.0714；相对确认标注误通过 0、误拒绝 13。逐维度原始一致率、二分 κ、二次加权 κ 和评分分布均导出；专业语气二分 κ 因恒定通过标签不可定义。Judge 未达 0.6 门槛，只作参考，不进入排名。
- 离线分歧诊断发现精简参考事实未包含多条答案的额外事实字段/已检索证据；保留本次评分，不追加 API 调用或调整 rubric 提高通过率。不能仅从分歧断言 Judge 模型能力弱。
- 校准脚本增加标注来源声明、分析代码 hash 和脱敏 Markdown 汇总，保留历史报告。私有报告与标注 hash、公开汇总泄漏检查均通过；阶段 6 尚未开始。
- 最终工程检查通过：Judge 专项 10 项、全量 3115 项通过/24 项跳过；make typecheck、benchmark 类型检查、make build、format、docs 与 diff 检查通过。报告生成和分歧诊断全部离线完成，没有追加 Judge 请求。

### 阶段 5 Judge 参考上下文修正与新盲标集准备（2026-10-14）

- 复核既有 Judge 提示后确认 grounding 只收到问题、期望事实和证据清单，缺少同一 attempt 的 fixture 工具真实返回。现将账本调用、参数、成功状态与返回值纳入每个维度评分；工具返回和候选回答中的指令均标成不可信数据。必需事实作为最低要求，任何额外事实需由本次成功工具返回支持；可引用证据 ID 取自实际返回。
- 原来的 20 条评分与 AI 辅助人工标注保持原样。为在完全相同的样本和人工标签上做一次修正诊断，已从原始 run 轨迹重建相同 20 个 sampleId，并生成 81 项 Judge 请求预览（80 项评分加 1 个合成探针），预览 hash 为 `6296d1c6d8c6`。该步骤没有调用 API。
- 校准改为逐维度门槛：完整度、事实依据、决策恰当性分别要求至少 20 条、1–5 分完全一致率 ≥60%、二次加权 κ ≥0.6；专业语气只作参考。整体二分 κ保留为诊断，不决定资格。正式阶段 6 在关键维度通过前仅用确定性检查排名。
- 新一批 20 条 dev 盲标包已离线准备：5 条确定性业务失败、15 条通过；涵盖 3 条需澄清、2 条政策冲突、2 条拒绝，另有不可用、升级人工、已采取动作与空数据等边界状态。标签四项均为空；不含候选身份或 Judge 评分，明确禁止 AI 草拟。样本来自一轮存在其他候选 parity 问题的旧 run，但所选的已核验候选行逐条 measurement-valid、quality-eligible，身份通过，且用例契约与当前版本 hash 一致；此来源限制写入私有 manifest，不能把该旧 run 用于模型胜率或总量统计。
- 离线 Judge 专项测试和类型检查通过。当前本机一次性 Judge Key 不存在，因此没有发出新的外部请求；同样本修正诊断和新样本正式 Judge 评分仍待本地凭据。人工盲标文件需先由用户本人填写，后续命令会在 Judge 请求前校验四项完整性。

### 阶段 5 修正后 Judge 诊断与人工盲标校准（2026-10-14）

- 在用户既有外发授权下，先对原 20 条同一 sampleId 做修正后诊断：合成注入探针通过，80/80 维度评分有效，grader 错误 0、缓存文件 0；原 20 条 source trace hash 与第一次运行逐条相同，没有重跑参赛模型。
- 另对 20 条全新 dev 样本完成盲评：人工标签在 Judge 执行前已填写，存档的 80 个分数未被修改，标注方式记录为 `manual_blind`，未使用 AI 草拟。80 项请求全部结束；三个关键维度各 20 项有效，专业语气 19/20 有效，1 项 grader 格式错误保持缺失，没有追加请求补分。
- 新样本逐维度结果：完整度完全一致率 75%、二次加权 κ=0；事实依据 70%、κ=-0.091；决策恰当性 90%、κ=0。三个关键维度均未达到 κ≥0.6，Judge 不具备排名资格。专业语气有效 19 项，完全一致率 89.5%、κ=0，仅作参考。整体二分一致率 100%，κ 因标签恒定不可定义，不能替代逐维度门槛。
- 原 20 条诊断（仍为 AI 辅助人工标注）完整度 κ=0.528，事实依据 κ=1.000，决策恰当性 κ=0.975，专业语气 κ=0.459；该诊断只说明修正输入后的本批表现，不作为独立人机校准。
- 缺失评分按缺失记录，不按 0 分代填。校准报告和公开脱敏摘要已分别保存，泄漏检查通过。缓存与分享关闭，Key 文件在批处理导入后删除；没有参赛模型调用。阶段 5 不通过排名准入门槛，阶段 6 只可按确定性断言排名；本轮尚未启动阶段 6。
- 验证：Judge/Promptfoo 专项 33 项通过，benchmark 类型检查、文档检查、格式检查和 diff 检查通过。全量 `make test` 未在本轮重跑。

### 阶段 5 校准样本信息量检查（2026-10-14）

- 按人工反馈增加 κ 计算前的评分分布检查：任一维度中，人工或 Judge 有 ≥90% 的有效分数集中在同一分值，该维度和整轮均标记为 `insufficient_sample_information`；二分 κ 与二次加权 κ 输出为 `null`，不再把公式结果 0 表述为 Judge 质量差。raw agreement 与双方分布仍报告，既有 20 条及评分均不更改。
- 重新生成两份校准 sidecar（不覆盖原报告）。新 20 条人工盲标的四个维度均达到集中阈值；结论为“样本信息不足，不能判断 Judge 能力”，Judge 仍不进入排名。旧 20 条是 AI 辅助人工标签，同样被分布检查判为信息不足，仅保留为输入修正诊断。
- 阶段 6 已允许按确定性断言继续。当前工作区盘点只有 2 个候选定义、评测进程无候选凭据、价格指纹仅 1 个匹配，且还没有 `benchmarks/profiles/` 变体目录；因此尚不能启动计划中的三候选正式矩阵。
- 验证：Judge/Promptfoo 专项 34 项通过，benchmark 类型检查通过；随后完整提交门槛待阶段 6 实现提交前执行。
- 校准抽样条件再收紧：三个关键维度各自至少需要 3 条人工 3 分及以下的样本；任一维度中人工或 Judge ≥90% 集中在同一分值时，整轮样本信息不足，不报告任何 κ。最新 sidecar 显示本批三个关键维度低分数均为 0，故不能判断 Judge 优劣，也不进入排名；这不是降低或放宽准入门槛。
- 新摘要保留评分分布、有效样本数、低分样本数和 grader 错误计数；校准状态区分 `insufficient_sample_information` 与 `below_threshold`，避免把样本不足写成评审器质量失败。

### 阶段 6 Profile 变体开发工具起步（2026-10-14）

- 新增 `benchmarks/profiles/{baseline,strict-json,evidence-audit}.yaml`。变体以声明式 prompt append 和 Runtime Policy override 表示；每次实际 attempt 保存所用 Profile 内容和变体定义 hash，独立重判会对照当前变体源文件核验，避免把配置漂移的运行混在一起。
- `bench:run --profile-variant <id>` 将变体 ID 作为 Promptfoo 测试变量传给 Provider；`bench:compare-profiles <left-run> <right-run>` 只接受有效 dev run，核对 case 集、候选指纹/区域、变体不同且三次重复一致，再按候选和 case 做 10,000 次配对 bootstrap。公开结果匿名化候选别名并通过泄漏检查。
- 当前尚无 Profile 变体真实运行。阶段 6正式矩阵仍缺第三候选、可用候选凭据，以及本地价格表中一个不匹配的指纹；Profile 变体目前按每个 run 固定一个配置，最终 holdout 中 baseline 与胜出变体的联合对比支持尚未实现。holdout 未启动。
- 验证：profile loader 与配对比较专项测试、benchmark typecheck 通过；根类型检查和 350 个测试文件 3119 项通过、24 项跳过；`make build`、格式、文档和 diff 检查通过。Judge 校准仍为样本信息不足，阶段 6 质量排序只使用确定性断言。
- 用户确认阶段 6 可按确定性断言推进。正式配置对比仍待变体运行支持、第三候选和凭据、以及所有模型指纹匹配的区域价格；holdout 仍留给唯一的最终正式运行。

### 阶段 6 开跑前选型契约与 holdout 联合比较（2026-10-14）

- `bench:compare-profiles --screening` 接受 1 次 dev 重复并在报告标题和正文标注“筛选结论”；筛选不参与排名。默认正式 Profile 比较只接受 3 次重复，且仅允许变体对 baseline。运行前登记 anchor candidate，作为唯一确认性 Profile 对比；其他候选的变体结果只作描述。
- `docs/BENCHMARK.md` 已预先定义选择对象、任务完成率主指标、身份/测量/工具策略硬约束、平局规则及多重比较办法。候选模型两两比较按 case 配对符号翻转检验，并用 Holm step-down 校正；Profile 只保留预先指定的单一主要对比。筛选与确认轮次规模分别为 150/300 次尝试，基于既往单次均价和延迟估算费用约 ¥14.13/¥28.26、串行 p50 约 0.86/1.72 小时；两轮合计约 ¥42.40、2.58 小时。这是单一 anchor candidate 的估算，不是三候选模型总矩阵报价。
- 最终 holdout 运行现在支持恰好两个 Profile（baseline 与胜出变体）在同一 run、完整候选和完整用例矩阵中交错执行，各 1 次。run ledger 仍只记一次启动；验证拒绝 smoke、case/candidate 子集、缺少 baseline、非最终运行和第二次启动。独立重判按每行变体加载对应 Profile 并核验内容及定义 hash。`bench:compare-profiles --holdout` 检查唯一 holdout ledger、身份、完整配对 case 和重复次数，再离线产出一次性确认报告；通用 `bench:report` 阻止把联合变体样本错误合并。
- Holm 实现使用 10,000 次 case 级配对符号翻转 p 值，并在所有合格候选 pair 上执行 step-down 调整；公开报告同时给配对 bootstrap 95% 区间和 Holm 调整值。Profile 对比的筛选/确认推断只针对登记的 anchor candidate。
- 尚未运行任何阶段 6 真实模型调用。第三候选、其本机凭据和与精确服务端点/区域匹配的官方价格卡还需配置核验；网关或订阅套餐没有官方 token 价时成本保持 unknown。holdout 也未启动。
- 验证：Profile/Promptfoo 专项测试 28 项通过，benchmark typecheck 通过，`format:changed`、`docs:check`、`git diff --check` 通过。全量项目提交门槛尚待最终提交前执行。

### 阶段 6 OpenCode Go 候选与价格绑定（2026-10-14）

- 按 Go 官方目录中实际可用的 Anthropic Messages endpoint 模型筛选候选；排除只有 OpenAI-compatible Chat Completions endpoint 的限时免费模型，以维持现有 Claude Agent SDK 执行路径。
- 将 `candidate-go` 固定为兼容 Messages API 且按既有 50 次开发集实际 token 分布计算后成本最低的选项。该样本上估算 50 次用量约 USD 0.0454；按官方价目中次低的兼容选项估算约 USD 0.0632。该数值是历史流量的费率重算，不是新的模型调用。
- 新增 Go 官方 USD 单价、全球区域、origin 模型指纹及缓存/推理计价假设；Go 用量限制与订阅费不混入按 token 的单任务成本。聚合 Promptfoo 成本也改为优先读取候选级币种，避免将 USD 显示为根级 CNY。
- 仍未做任何真实模型调用。Go API key、第三候选实际路由和请求成功情况仍需本机配置后验证；网关身份仍待网关侧证据核验，不能参与官方模型排名。
- 来源：OpenCode Go 官方 endpoint、费率与用量上限说明，`https://dev.opencode.ai/v2/docs/console/go/`，核对日期 2026-10-14。

### 阶段 6 候选矩阵缩为两个（2026-10-14）

- 用户决定不增加第三个参赛模型。修订正式矩阵规则：两个身份已核验且质量合格的候选即可做模型比较；完整 dev 模型矩阵为 2 × 50 × 3 = 300 次尝试。若身份门槛后只剩一个合格候选，仍可比较 Profile，但报告不得给模型排名或两两模型差异。
- OpenCode Go 的第三候选不进入本阶段模型矩阵；保留已有候选定义与价格配置，不启动 Mimo 协议转换或真实模型调用。提交前运行仍需本机可用凭据和身份合格的两个候选；holdout 未运行。

### 阶段 6 交付范围改为可复现 benchmark（2026-10-15）

- 用户取消正式多模型真实运行，阶段 6 目标改为第三方可复现运行工具。历史真实结果的允许用途已在 `BENCHMARK.md` 与 `BENCHMARK-VALIDATION.md` 明确限制为测量链路验证；不得用于模型排名或选型结论。
- 新增 Anthropic Messages 本地假服务，脚本覆盖正常文本、工具调用、代码围栏、超时、拒答及注入安全回复。`bench:selftest` 通过当前源码构建的隔离 Runner 镜像执行 Promptfoo Provider → CommerceAgent API/Session → Runner → fixture MCP 的完整合成调用，再运行用量/工具采集、独立重判、私有/公开报告生成和泄漏探针。selftest 候选被显式限定为本地 fake 配置，合成凭据与结果写入临时目录；不调用真实模型，不碰 holdout ledger。
- `bench:estimate` 根据指定的历史 run usage 和延迟计算筛选、确认、正式或 holdout 的 serial attempts、预计成本、elapsed p50/p95 线性代理值。任何来源用量/费率不完整、币种混杂或身份指纹不匹配时成本为 `unknown`。
- 新增 `selection-policy.yaml` 选型规则模板；真实 `bench:run` 要求使用方填写并确认、且先提交后才放行。模板涵盖选择对象、主指标、硬约束、平局规则及 Holm/预先指定主要比较方式。
- `BENCHMARK-HANDOFF.md` 记录接口协议要求、候选与 Key 配置、价格绑定、运行顺序、Judge 人工校准、报告阅读及已验证边界。CI 安装 benchmark 子项目、构建当前源码 Runner 镜像，并独立执行 `npm run bench:selftest`。
- 验证：Fake Messages 服务 6 种响应脚本、预算计算和选型门槛测试 8 项通过；68 条 reference/oracle 自检通过、932 个变异被拒绝；当前源码 Docker 镜像完整 E2E selftest 通过（1 次 attempt、2 次 fixture MCP 调用、测量有效、parity/reassessment/report/leak check 通过）。无真实模型调用、无 holdout 运行、无选型结论。
- 后续最终代码路径把 `bench:selftest` 改为驱动真实 Promptfoo Provider 与运行器，而非手工拼接 Promptfoo 结果；CI/本地 `make bench-selftest` 必须从当前 checkout 构建镜像，避免旧 latest 镜像的 entrypoint 漂移。完整 selftest 最终复跑通过，synthetic candidate 保持 `gateway_pending`，因此业务通过只验证链路，不计入模型质量。
- 最终验收：全量 `make test` 为 354 个测试文件、3162 项通过；benchmark typecheck、项目 typecheck、`make build`、`docs:check`、`format:check`、`git diff --check` 均通过。预算 CLI 已用历史 50-attempt run 验证输出 150 次筛选 attempts、CNY 14.13 估算和冷启动时间代理值。离线 full selftest 报告 1 次业务 attempt 测量有效、2 次 fixture MCP 成功调用、独立重评/报告/泄漏探针通过、真实模型调用 0、holdout 0。
