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
