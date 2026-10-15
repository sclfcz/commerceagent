# Benchmark handoff

本文说明如何在第三方环境中复现 CommerceAgent benchmark。当前交付目标是可运行、可复评的评测工具；**本项目已有真实模型运行只用于验证测量链路，不包含模型排名或选型结论**。阶段 6 不会由本项目维护者启动正式多模型真实运行。

## 运行条件

- Node.js 与 npm 版本符合根目录项目要求；完成根项目、`web/`、`container/agent-runner/` 和 `benchmarks/` 的 `npm ci`。
- Docker daemon 正常，预先从当前 checkout 构建 Agent Runner 镜像；评测会把实际镜像固定为不可变 image ID 并写入 run manifest。
- Linux 主机上 fixture 服务自动读取 Docker `bridge` 网络的 gateway，并只绑定该网桥地址；不监听 `0.0.0.0`。benchmark 模式会给 Runner 容器添加 `host.docker.internal:host-gateway` 映射，让它访问该地址。macOS/Windows 使用 Docker Desktop 的回环路径。Linux 上如设置 `BENCH_FIXTURE_BIND_HOST`，值必须是实际 bridge gateway。
- `COMMERCEAGENT_BENCHMARK_MODE=1` 只能由 benchmark 启动的隔离评测服务设置，不能配置在生产服务环境中；生产环境设置会关闭产品自带工具，并给 Runner 容器添加 host-gateway 映射。
- 每个候选须提供 Anthropic Messages 兼容 endpoint、精确 model ID、密钥环境变量名、计费区域和网关声明。Provider/SDK 上报的模型名只证明请求中声明的模型，不能证明网关实际路由。

```bash
npm ci
npm --prefix web ci
npm --prefix container/agent-runner ci
npm --prefix benchmarks ci
docker build -f container/Dockerfile -t commerceagent-bench-selftest:local container
make bench-selftest
```

仅支持 OpenAI Chat Completions 或 Responses 协议的模型，不能直接接入当前 Claude Agent SDK Runner。经网关转换后可以作链路或探索性测试，但必须设为 `gateway: true`，身份会标记为 `gateway_pending`，在外部路由证据核验前不能计入质量排名。

## 候选与密钥

可以复用宿主机已配置 Provider：

```bash
npm run bench:run -- --preflight --split dev --existing
```

也可以将 `benchmarks/candidates.example.yaml` 复制为被忽略的 `benchmarks/candidates.local.yaml`，设置 `BENCH_CANDIDATES_FILE`，并在当前 shell 或本机安全密钥管理器中设置 YAML 所列的环境变量。配置字段包括匿名 alias、model ID、Anthropic Messages base URL、API key 环境变量名、billing region 和 `gateway` 状态。不要将密钥写入 YAML、命令参数、shell 历史、提交、issue 或聊天。

Judge 与评测候选凭据分开。OpenCode Go 的一次性本地导入文件为 `benchmarks/opencode-go.local.json`，格式 `{"apiKey":"…"}`，权限须为 `0600`；导入器会在读入后立即删除文件。API Key 不要直接粘贴到对话或终端命令中。

Judge 默认使用 OpenCode Go 的 OpenAI 兼容接口和 `mimo-v2.6-flash`。可在运行校准命令前通过 `BENCH_JUDGE_BASE_URL` 和 `BENCH_JUDGE_MODEL` 覆盖接口根地址与模型 ID，并通过 `BENCH_JUDGE_API_KEY` 单独提供该接口的 Key。自定义接口必须使用 HTTPS、兼容 OpenAI Chat Completions，并允许访问 `/chat/completions`；网络出口守卫只放行配置的精确 origin/path 前缀。每次运行会把请求的模型 ID 和接口写入私有 provenance。自定义 Judge 不得与参赛模型同家族，校准仍须盲标。

## 选型规则与价格

正式模型调用前，使用方必须填写 `benchmarks/selection-policy.yaml`，确定选择对象、主指标、硬约束、平局规则以及多重比较方式。可以使用 Holm 校正，或指定唯一主要比较并将其他比较标为探索性；完成确认人和日期后，**必须先提交该文件**。当前模板为 `status: template`，真实运行程序会拒绝未确认或未提交的规则。

价格放在 `benchmarks/pricing.yaml`，以 alias 关联并绑定 `sha256(model + "|" + endpoint origin)` 指纹及 billing region。价格来源必须对应实际服务平台、协议 endpoint 和区域；套餐额度不等于每 token 账单。无法确认的字段或指纹/区域不匹配时，成本报告为 `unknown`，不能填零。`pricing.yaml` 本身不匿名，不应作为公开脱敏报告发布。

## 推荐运行顺序

```bash
# 1. 假模型完整自检：使用当前源码构建的 Runner 镜像；不会调用真实候选，也不消耗 holdout
make bench-selftest

# 可单独运行 oracle 和变异自检
npm run bench:selftest -- --cases-only --all

# 2. 查看环境；预检不会发模型请求
npm run bench:run -- --preflight --split dev --existing

# 3. 估算筛选预算。reference run 必须有完整、可计价的 usage 与时延
npm run bench:estimate -- --reference-run <run-id> --mode screening --case-count 50 --candidate-count 1

# 4. 筛选每个 Profile 一次重复，比较报告标注“筛选结论”
npm run bench:run -- --split dev --candidate <anchor> --profile-variant baseline --repetitions 1
npm run bench:run -- --split dev --candidate <anchor> --profile-variant evidence-audit --repetitions 1
npm run bench:compare-profiles -- <variant-run> <baseline-run> --screening --primary-candidate <anchor>

# 5. 选定 Profile 后，baseline 与胜出变体各三次重复确认
npm run bench:run -- --split dev --candidate <anchor> --profile-variant baseline --repetitions 3
npm run bench:run -- --split dev --candidate <anchor> --profile-variant evidence-audit --repetitions 3
npm run bench:compare-profiles -- <variant-run> <baseline-run> --primary-candidate <anchor>

# 6. 两个身份已核验候选才可产生模型对比；完整 dev 矩阵为 2 × 50 × 3
npm run bench:run -- --split dev --repetitions 3

# 7. 只在最终确认时启动一次 holdout；一次 run 内配对 baseline 和胜出变体
npm run bench:run -- --split holdout --final-run --profile-variants baseline,evidence-audit --primary-candidate <anchor>
npm run bench:compare-profiles -- --holdout <run-id> --winner evidence-audit --primary-candidate <anchor>
```

Holdout 只允许一次完整运行；失败也消耗唯一额度。阶段 5 的 Judge 校准、阶段 6 的筛选及配置对比只使用 dev。自检和预算估算使用假服务或已保存历史证据，不访问候选模型。

## Judge 人工校准

Judge 目前是参考项，不能进入排名。正式将 Judge 纳入排名前，需要使用未重复的 dev 样本做盲标，人工标签由人独立完成，标注者不得先查看 Judge 分数。至少报告逐维度原始一致率、适用于 1–5 有序分值的加权 κ、二分 κ、误通过率和误拒绝率。样本评分过度集中或缺少足够低分样本时，应报告“样本信息不足”，不能把 κ=0 解释为 Judge 能力差，也不能降低准入门槛。

## 如何读报告

- `measurementValid` 与业务通过分开：服务/MCP、fixture、usage、上下文或证据链失败的尝试不进入质量分母；先排查测量失败，再读模型表现。
- 任务完成率是合格尝试中 `businessPass=true` 的比例。首次通过率只看第一次重复；平均通过率看全部合格尝试；pass^3 要求同一 case 三次都合格且都通过，任何一次不合格则不可判定。
- 候选身份未核验、测量不合格率超过 10% 或工具策略违规的候选不能排名。`gateway_pending` 是身份状态，不是模型失败。
- 两两模型比较按 case 配对；模型矩阵使用 10,000 次配对 case bootstrap 区间及 Holm 校正。区间跨零时报告“未观察到显著差异”。Profile 筛选只作筛选结论；正式比较和 holdout 均按已提交规则解释。
- 时延是冷启动 elapsed 与逻辑运行时间的 p50/p95。价格未知则总成本与成功任务成本保持 `unknown`；费用是费率估算，不等于平台账单。
- `bench:selftest` 失败时会输出错误码、处理提示以及保留的 synthetic artifacts 路径；可先按错误码定位 Docker 镜像、bridge/MCP、上游脚本或复评/泄漏阶段。
- 公共报告仅含匿名候选 alias 和汇总指标。私有 `result.json`、trace、数据库、候选映射和 pricing 源文件不能公开分享。

## 已验证与未验证范围

历史真实运行验证了 CommerceAgent 隔离 Container、Session、WebSocket、fixture MCP、用量和证据采集链路；它们**没有产生模型排名或选型结论**。此次新增的 `bench:selftest` 用本地假 Anthropic Messages 服务覆盖正常回复、工具调用、代码围栏、超时、拒答和注入，并端到端检查隔离服务、fixture MCP、收集、独立重评、报告及泄漏拦截；它验证的是代码和测量系统，不是模型质量。

尚未由该假模型自检证明的事项包括：任何候选模型的当前可用性、真实供应商/网关的路由身份、真实价格账单与缓存计价、模型质量表现、Judge 是否达到准入标准，以及任何 holdout 模型结果。使用方应在本机填入候选与密钥，完成已提交选型规则的预检，再自行决定是否进行真实调用。
