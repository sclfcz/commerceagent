# Workspace Memory v2

Workspace Memory v2 是 CommerceAgent 的工作区长期知识层。它保存经过提炼、未来
Session 仍可复用的内容，并以 Workspace 作为唯一产品入口和权限边界。

## 产品边界

CommerceAgent 的相关数据分成三个彼此独立的层次：

| 层次                   | 用途                                     | 生命周期                         |
| ---------------------- | ---------------------------------------- | -------------------------------- |
| 平台/AgentProfile 身份 | Agent 是谁、平台规则和能力策略           | 配置或代码版本管理，不可被忘记   |
| Home Owner Profile     | 内置 CommerceAgent 如何称呼实际 owner        | Home 跨 Session，专用 API 管理   |
| Session 历史           | 一段对话的消息、工具轨迹与即时上下文     | 由 Session/消息管理功能单独处理  |
| Workspace Memory       | 同一 Workspace 跨 Session 复用的提炼知识 | 忘记后不再检索，但保留修订审计线 |

因此：

- Memory 页面先选择 Workspace，只查询该 Workspace 的数据。
- 内置 CommerceAgent 的平台身份和安全约束不是 Memory；自定义 Agent 的身份由各自
  AgentProfile 管理，也不会继承 CommerceAgent 的内置身份。
- Workspace Memory 不是用户全局 Profile，也不会在不同 Workspace 之间共享。
- Session、日期和任意文件路径不是 Memory 页面中的可浏览“记忆源”。
- 来源 Session 只用于回溯 provenance；忘记一条 Memory 不会删除 Session 或聊天
  历史。
- Workspace 文件仍通过文件功能管理，不能通过 Memory API 任意读取或改写。
- “重建工作区”是明确的内容级永久重置：保留 Workspace 外壳，但删除整个 Memory
  store 及其 versions、provenance、tombstones、audit/outbox。Home 同时删除
  Owner Profile 称呼并把首次唤醒生命周期重置为 `pending`；关联定时任务停止并
  移入回收站，运行历史保留。

### Home、Agent 与首次唤醒

- 每个用户的 Home Workspace 永久绑定内置 CommerceAgent，不能删除或迁移给自定义
  Agent。
- `POST /api/agent-profiles` 只创建自定义 AgentProfile，不自动创建 Workspace、
  Session 或 Memory，也不继承 Home 的任何内容。
- 非 Home Workspace 可以由用户显式迁移到另一个 Agent。文件、Session、渠道挂载和
  Workspace Memory 均跟随 Workspace 保留；迁移不是复制。
- CommerceAgent 只在 Home、内置默认 AgentProfile、实际 owner 的人类交互轮次中运行
  首次唤醒。宿主用 `workspace_onboarding_states` 原子 claim 一次 lease；只有新 claim
  的 turn 可以说一次“刚醒来”。同一 lease 的后续消息可以完成设置，但不能重复
  first-wake。
- 称呼通过专用 `commerceagent_owner_profile` 工具或
  `/api/workspaces/:jid/owner-profile` 管理。owner 明确拒绝时记录 `skipped`；
  清空称呼保持 onboarding 已完成，不会重新触发。
- 物理唯一真相仍是 Workspace Memory item
  `happyclaw.owner.preferred_address`，因此沿用 revision、provenance、audit、outbox
  和 CAS；但它是平台保留项，通用 Memory 的 create/update/forget、列表、详情、
  versions、搜索、FTS 和 Runtime snapshot 均不暴露它。旧库重复项先确定性收敛，
  再建立数据库唯一索引。
- Scheduled Run、Task/Spawn Sub-Agent、自定义 AgentProfile、终端预热和 Home
  中的非 owner 群成员 turn 都没有 Owner Profile 投影或修改权限。

## 知识类型

每条 Memory 必须属于以下一种类型：

| Kind        | UI 名称 | 含义                                   |
| ----------- | ------- | -------------------------------------- |
| `fact`      | 事实    | 工作区中稳定、可验证的信息             |
| `decision`  | 决策    | 已经做出的选择及必要背景               |
| `lesson`    | 经验    | 可复用的做法、反例或教训               |
| `open_loop` | 待跟进  | 尚未关闭的问题、承诺、风险或下一步行动 |

Memory 应保存结论和必要上下文，而不是复制整段聊天。可复用知识不足时，保留在
Session 历史中即可。

## 数据与一致性

Workspace Memory v2 的 canonical store 位于 CommerceAgent SQLite 主数据库。每个
Workspace 有独立的 store revision，每个 item 有单独的 revision：

- 每次创建、编辑或忘记都会递增 item revision 和 store revision。
- 版本记录保存当时的值、`changeType`、actor 和 provenance，按新到旧读取。
- 编辑和忘记必须提交 `expectedRevision`，服务端用 compare-and-set 防止丢失更新。
- 发生 409 `revision_conflict` 时，客户端保留本地草稿，展示服务端当前 revision，
  由用户决定何时加载最新版。
- 忘记通过 `deleted` tombstone 和 `forget` 版本表达；活跃列表和 Runtime
  检索不再返回该条目，但审计历史仍存在。
- 创建、编辑和忘记可以携带稳定的 `idempotencyKey`。相同请求重试返回
  `replayed: true`；同一个 key 对应不同请求时返回
  `idempotency_conflict`。

`validFrom`、`validUntil` 和 `expiresAt` 用于控制知识的时间有效性；`importance` 和
`confidence` 的范围都是 0 到 1。详情字段与端点见 [API 文档](API.md#workspace-memory-v2)。

## 来源与隐私

每条 item 和 version 都带有 provenance：

- `sourceType`：服务端根据 Web 用户、Agent Runtime、定时任务或迁移流程生成。
- `sourceId`：可选的来源消息或运行标识。
- `sessionId`：可选的来源 Session 标识。
- `observedAt`：知识被观察到的时间，不等同于数据库写入时间。

客户端可以提交 `sourceId`、`sessionId` 和 `observedAt`，不能伪造
`sourceType` 或 actor。读取要求能够访问 Workspace，写入要求能够修改 Workspace；
未授权与不存在均返回 404，管理员也不能跨 owner 读取 Workspace Memory。

Agent Runtime 还按执行上下文收紧写权限：顶层交互式 Main/Runtime Session 可按
Workspace ACL 读写；Scheduled Run（group/isolated）和 SDK Task Sub-Agent
只能读取，不能创建、更新或忘记 Memory。

Owner Profile 的边界更严格：只允许 Home 内置 CommerceAgent 的 Main/普通 Runtime
Session，并且宿主必须把本次持久化消息 sender 验证为实际 owner。每个 cold/warm
turn 都单独读取最新投影；排队 turn 只能用自己的 host-issued turn ID 读取，
set/clear/skip 还必须是当前 active turn。SDK Sub-Agent 对整个专用工具（包括
`get`）均被 hook 拒绝。

## Web 交互

Memory 页面采用 Workspace-first 流程：

1. 从 `/api/workspaces` 选择 Workspace，并在 URL 中保存
   `?workspace=<workspaceJid>`。
2. 加载活跃 item，总览事实、决策、经验和待跟进数量。
3. 搜索只在当前 Workspace 内执行；类别筛选可与搜索组合。
4. 详情展示来源 Session/来源 ID、观察时间、item revision、store revision 和修订
   时间线。
5. 有修改权限时可以创建、编辑和忘记；只读 Workspace 不显示可执行写操作。

空状态需要区分“没有 Workspace”“Workspace 尚无 Memory”和“搜索无结果”。请求
失败在当前区域展示并允许刷新，不能回退到旧文件源。移动端在列表和详情之间切换，
返回列表不改变 Workspace；输入控件都有可读 label，冲突和错误使用 `role=alert`
通知辅助技术。

### 并发编辑流程

1. 打开 item r2，保留该 revision 作为 `expectedRevision`。
2. 用户编辑本地草稿并 PATCH。
3. 若服务端仍为 r2，保存成功并返回新的 item/store revision。
4. 若服务端已变为 r3，返回 409；页面继续显示本地草稿和冲突信息。
5. 用户显式选择“加载服务端最新版”后，页面才用 r3 覆盖草稿。

页面不能在冲突后自动重发 PATCH，也不能悄悄合并或覆盖内容。

## 旧版迁移

路径式的用户全局、日期和文件 Memory 端点已经退役并返回 410。旧
`data/memory/` 内容可以保留用于备份、离线导出或显式迁移，但具有以下约束：

- Web 页面和 Runtime 不读取或写入旧文件。
- 旧内容不会自动暴露为 Workspace Memory。
- 迁移流程必须明确目标 Workspace、kind 和 provenance，并使用 v2 写入接口。
- 完成迁移后，SQLite 记录是唯一在线真相源，不能进行双写。

## 验收清单

- 所有 Memory 请求都使用 `/api/workspaces` 返回的 JID，未使用 `folder`。
- 用户只能看到当前 Workspace 的 Memory；切换 Workspace 会清空旧选择和草稿。
- 四种 kind 可总览、筛选、搜索、创建和编辑。
- 详情可回溯来源、时间、revision 和 versions。
- PATCH/DELETE 携带 `expectedRevision`；409 时本地草稿仍在。
- 忘记后活跃列表不再显示 item，来源 Session 历史仍存在。
- 只读 Workspace 无写操作，未授权资源不泄露存在性。
- UI 和 Runtime 均不调用旧 `/sources`、`/search`、`/file`、`/global` 端点。
