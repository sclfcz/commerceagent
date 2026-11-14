# 会话连续性

CommerceAgent 面向多租户。租户管理员修改 Agent 配置、平台轮换上游账号、用户切换模型，
都不应让终端用户的对话丢失上下文。

## 三层分离

| 层       | 内容                               | 何时改变                               |
| -------- | ---------------------------------- | -------------------------------------- |
| 业务对话 | 聊天记录、工作区文件、任务进度     | 只在用户 `/clear` 或数据隔离要求时清空 |
| SDK 会话 | Claude transcript（`sessions` 表） | 仅当目标上游无法续接原会话时替换       |
| Runner   | 进程、挂载、环境变量               | 任何配置变化都可重启                   |

AgentProfile 的 `identity_hash` / `version` 只记录会话最后运行的配置版本。
不一致时下一轮带一段一次性的“配置已更新”说明，SDK 会话保留
（`src/session-continuity.ts` 的 `planAgentProfileSessionContinuity`）。
Agent 配置路由仍会在敏感修改后停止暖 Runner，保证新配置生效。

## 上游账号与模型切换

thinking 块签名和网关协议差异可能让会话无法跨上游续接，所以跨上游续接必须先实测。

- 会话默认粘在创建它的上游账号上；轮换策略只影响新会话的分配。
- 只有在续接矩阵中验证通过的 (源, 目标) 组合，才允许已有会话在两者之间移动。
- 未验证的组合沿用旧行为：新建 SDK 会话并注入最近历史。
- 修改上游的 Base URL 或模型会改变其指纹，原有验证结果自动失效。

续接矩阵保存在 `data/config/session-continuity-matrix.json`，由下面的命令生成：

```bash
npm run probe:session-continuity
```

脚本会产生真实请求和费用。对每个有序组合，它检查四项行为：恢复成功、记得只出现在
工具结果里的信息、恢复后还能调用工具、流式输出。四项都通过才算可续接。
同一上游自身的组合作为基线，基线失败时脚本以非零状态退出。

## 结构化会话迁移

确实必须新建 SDK 会话时（resume 失败、崩溃恢复、未验证的上游组合、清理 thinking 块），
新会话不再是“最近 N 条、每条截断”的聊天回放，而是基于旧 transcript 的结构化迁移：

- 用户提出的要求，按预算尽量完整保留（单条上限默认 4000 字符）；
- assistant 的结论性回复；
- 工具调用摘要：工具名、关键参数与结果摘要（最近 4 条完整、4~12 条压缩、更早的只留一行）；
- 最近一次 compact summary；
- 最新一次 TodoWrite 的任务进度。

实现位于 `shared/session-migration.ts`，通过 `make sync-types` 同步到
`src/session-migration.ts` 与 `container/agent-runner/src/session-migration.ts`，
Host 与 Runner 用同一份代码、输出逐字节一致（`tests/session-migration.test.ts` 校验）。

| 路径                                  | 触发点                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| `container/agent-runner/src/index.ts` | `sessionResumeFailed` 回退：`extractSessionHistory()`       |
| `src/index.ts` 恢复 / 预热切换        | `buildRecentConversationHistoryContext()` 优先读 transcript |
| `src/index.ts` Agent 新会话           | 同上，按 `agents/{agentId}/.claude` 取 transcript           |

transcript 路径由 `src/session-transcript.ts` 解析：已知旧 session id 时精确命中
`projects/{encodedCwd}/{sessionId}.jsonl`，否则取该会话目录下最近修改的文件。
Host 读不到 transcript（容器未写、目录被清理）时回退到持久化聊天记录，同样按字符预算
取最近消息（单条默认上限 4000 字符、最多读取 200 条），不再是固定 30 条 × 700 字。

总预算按字符估算 token（约 3~4 字符/token），默认 24000 字符，可用
`COMMERCEAGENT_SESSION_MIGRATION_BUDGET_CHARS` 或调用方参数调整。预算按优先级分配：
用户要求 50%、助手结论 15%、工具摘要 15%、任务进度 6%、compact summary 14%，
未用尽的额度顺延给后面的段。映射后的文本仍走孤立代理项清理与
`</system_context>` 转义，注入块无法被历史内容提前闭合。

## 待完成

- 不可续接的组合：把 thinking 块剥离后续接，替代整段丢弃。
- 模型目录：只把验证通过的模型作为“可无缝切换”的选项开放给租户。
