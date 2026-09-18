# Prompt、Skill 与运行时治理测试方案

本方案验证 PromptPlan、Effective Skill/MCP Manifest、Claude Agent SDK Subagent、`_close` 恢复、运行上下文预算与 Agent 创建界面。安全议题不在本轮范围内。

## 测试分层

| 层级               | 真实对象                                                   | 代表用例                                     | 通过标准                                        |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| 纯函数             | PromptPlan、ContextBudget、TurnOutcome、Skill/MCP Resolver | 同名 Skill、MCP 配置变化、超预算、关闭未回复 | 输出状态、哈希与游标决策精确匹配                |
| 宿主集成           | Session Skill 对账、Container mounts、API preview          | ghost Skill、disabled collision、Plugin MCP  | 隔离 ghost；预览与实际 manifest 一致            |
| SDK/CLI 集成       | 项目锁定版本的 Claude Agent SDK 和 Claude CLI              | main → Task Subagent → main                  | 子请求只收到自有 prompt、短运行契约与显式 Skill |
| 前端契约/构建      | Agent 页面、Effective Context                              | 点击“新建”、选择工作区                       | 创建入口在右侧主区；真实上下文与总预算可见      |
| 真实 Provider 冒烟 | 当前 CommerceAgent 已配置 Provider                             | 固定标记问答                                 | 模型完成请求且逐字返回固定标记                  |

## 可复现命令

```bash
npm test -- --run \
  tests/effective-skill-resolver.test.ts \
  tests/effective-mcp-manifest.test.ts \
  tests/builtin-skill-bootstrap-contract.test.ts \
  tests/agent-capability-preview.test.ts \
  tests/group-queue-close-retry.test.ts \
  tests/turn-outcome.test.ts \
  tests/agent-runner-prompt-plan.test.ts \
  tests/agent-runner-context-budget.test.ts \
  tests/agent-runner-sdk-compat.test.ts \
  tests/agent-runner-sdk-subagent-contract.integration.test.ts \
  tests/run-context-snapshot.test.ts \
  tests/frontend-agent-create-workspace.test.ts \
  tests/frontend-run-context-explainability.test.ts

npm run build:all
npm run test:real-model
```

`test:real-model` 会产生一次真实 Provider 请求，可能计费。脚本只输出配置是否存在、是否完成、是否精确匹配、回复长度和耗时；不会输出凭据、Endpoint、模型名或意外回复正文。

## 实际例子

### 1. disabled Skill 与持久 Session ghost

- 宿主低优先级存在启用的 `review`。
- managed 用户层存在同名 `SKILL.md.disabled`。
- Session 中人工留下真实目录 `ghost/SKILL.md`。
- 期望：`review` 仍由低层定义生效；`ghost` 移入 `orphaned-skills`，不进入 SDK 的 `selectedSkillIds`。
- 内置 Skill 只来自固定版本的 `data/builtin-skills`，Host/Container 均消费同一 Manifest；镜像不再额外注入 `/opt/builtin-skills`。
- `.catalog.json` 同时校验 catalog 版本、来源 SHA、完整 Skill ID 集和递归 payload hash；缺项或任意脚本/资源被改写都会触发重建，而非继续使用半旧目录。

### 2. `_close` 无回复

- 第一次 runner 返回 `closed`，没有可见回复，也没有 `inputTurnCompleted`。
- 不发送任何新消息，仅推进 5 秒退避计时器。
- 期望：队列自动启动第二次执行；stop/restart 时旧计时器不再启动第三次执行。

### 3. SDK Subagent 策略继承

- main prompt 带唯一 main marker，并调用 Task。
- Task AgentDefinition 带唯一 child marker、`skills: ['qa-child-skill']`。
- 期望：子请求包含 child marker、CommerceAgent delegated-task contract 与 Skill 内容；不包含 main marker；子 Agent 不获得 Task 工具。

### 4. Agent 新建界面

- 打开“自定义 Agent”，点击左侧“新建”。
- 期望：右侧大工作区出现角色描述、例子、AI 生成和空白创建；左侧不出现小编辑框；移动端动作纵向排列。

### 5. Plugin MCP 能力指纹

- 启用 Plugin，其 `.mcp.json` 声明一个 MCP Server，获取 Agent 有效能力预览。
- 修改该 Server 的 command/args/env/header 任一真实定义，保持显示名称不变，再次预览。
- 期望：MCP Manifest hash 改变；`run_context_status` 将旧运行标记为能力配置过期。Agent MCP 策略为 custom/disabled 时，SDK 禁止 Plugin MCP 自动发现，因此这些 Server 不进入有效 Manifest。

### 6. 真实模型固定回答

请求要求模型只回复：

```text
COMMERCEAGENT_REAL_SMOKE_OK_20260721
```

2026-07-21 已执行两次：两次请求都完成并逐字匹配，回复长度均为 32，耗时分别约 9.1 秒和 7.5 秒。执行过程中没有打印 Provider 凭据、Endpoint 或模型值。
