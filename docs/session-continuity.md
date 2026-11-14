# 会话连续性

CommerceAgent 面向多租户。租户管理员修改 Agent 配置、平台轮换上游账号、用户切换模型，
都不应让终端用户的对话丢失上下文。

## 三层分离

| 层       | 内容                               | 何时改变                               |
| -------- | ---------------------------------- | -------------------------------------- |
| 业务对话 | 聊天记录、工作区文件、任务进度     | 只在用户 `/clear` 或数据隔离要求时清空 |
| SDK 会话 | Claude transcript（`sessions` 表） | 仅当原会话本身损坏或被显式重置时替换   |
| Runner   | 进程、挂载、环境变量               | 任何配置变化都可重启                   |

AgentProfile 的 `identity_hash` / `version` 只记录会话最后运行的配置版本。
不一致时下一轮带一段一次性的“配置已更新”说明，SDK 会话保留
（`src/session-continuity.ts` 的 `planAgentProfileSessionContinuity`）。
Agent 配置路由仍会在敏感修改后停止暖 Runner，保证新配置生效。

## 上游账号与模型切换

thinking 块签名和网关协议差异可能让会话无法跨上游续接，所以跨上游续接必须先实测。

- 会话默认粘在创建它的上游账号上；轮换策略只影响新会话的分配。
- 只有在续接矩阵中验证通过的 (源, 目标) 组合，才允许已有会话原样移动。
- 未验证的组合不再丢弃会话，改为“剥离 thinking 块后续接”（见下节）。
- 修改上游的 Base URL 或模型会改变其指纹，原有验证结果自动失效。

## 剥离 thinking 块续接

thinking 块签名绑定到产生它的上游；跨上游 resume 会被拒绝，但文本、工具调用和
工具结果并不需要签名。所以不可续接的组合把 transcript 复制成新 sessionId，
只去掉 `thinking` / `redacted_thinking` 内容块，再 resume 这份副本：

- 实现：`container/agent-runner/src/thinking-strip.ts`（纯函数 + 文件复制）。
  条目顺序不变，`parentUuid` 链保持完整；只有 thinking 的 assistant 条目保留为
  `content: []` 的空壳；`tool_use` / `tool_result` 块一律不动，调用保持成对；
  原 transcript 不修改，回退时仍可 resume 原会话。
- Host 决策：`resolveSessionResumeMode()`。`trySelectPoolProvider` 在会跨到未验证
  上游时返回 `stripSessionThinking`；上游配置变更（Base URL / 模型 / 凭据）由
  `markSessionsForThinkingStripByProviderId()` 在 `sessions.resume_strip_thinking`
  上打持久标记。两者都让本轮 `ContainerInput.sessionResumeMode = 'strip_thinking'`。
- Runner 启动时按该字段生成副本并 resume；副本失败或原 transcript 不存在时退回
  原 sessionId，resume 失败仍走既有的 `sessionResumeFailed` 回退（提取历史 + 新会话）。
- 标记在新 sessionId 落库时自动清除（`setSession`），同一个 id 则保留，
  这样一次失败的剥离不会让下一轮重放不可验证的 thinking 块。
- 剥离发生在 Runner 启动时，所以改动生效依赖暖 Runner 被停止：上游配置变更、
  渠道/Agent 配置变更本来就会先 quiesce 并停止 Runner。
- 已知边界：只处理主 transcript，不复制 `subagents/` 下的子代理转录；`sessions-index.json`
  存在时会补一条新条目（尽力而为）。

续接矩阵保存在 `data/config/session-continuity-matrix.json`，由下面的命令生成：

```bash
npm run probe:session-continuity
```

脚本会产生真实请求和费用。对每个有序组合，它检查四项行为：恢复成功、记得只出现在
工具结果里的信息、恢复后还能调用工具、流式输出。四项都通过才算可续接。
同一上游自身的组合作为基线，基线失败时脚本以非零状态退出。

## 待完成

- 必须新建会话时：基于 transcript 的结构化迁移（含工具结果和任务状态），
  替代当前最近 30 条、每条截断 700 字的聊天历史。
- 模型目录：只把验证通过的模型作为“可无缝切换”的选项开放给租户。
