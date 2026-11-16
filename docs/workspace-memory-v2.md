# Workspace Memory v2

Workspace Memory v2 是 CommerceAgent 的工作区长期知识层。它保存经过提炼、未来
Session 仍可复用的内容，并以 Workspace 作为唯一产品入口和权限边界。

## 产品边界

CommerceAgent 的相关数据分成三个彼此独立的层次：

| 层次                   | 用途                                     | 生命周期                         |
| ---------------------- | ---------------------------------------- | -------------------------------- |
| 平台/AgentProfile 身份 | Agent 是谁、平台规则和能力策略           | 配置或代码版本管理，不可被忘记   |
| Home Owner Profile     | 内置 CommerceAgent 如何称呼实际 owner    | Home 跨 Session，专用 API 管理   |
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

### 存储后端

Workspace Memory v2 的 canonical store 位于独立的 PostgreSQL 数据库，不再存放在
SQLite 主数据库。后端由 `MEMORY_DATABASE_URL` 选择：

| 条件                         | 后端                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `MEMORY_DATABASE_URL` 已设置 | 外部 PostgreSQL（`pg` 连接池），用于 SaaS 部署                                         |
| 未设置                       | `@electric-sql/pglite` 嵌入式 PostgreSQL，数据落在 `data/memory-pg/`，用于零配置自托管 |

两种后端实现同一小组接口（`query` / `transaction`），store 层只依赖该接口，因此
两条路径的行为一致；SQLite 实现已删除，`workspace_memory_*` 表也不再由 SQLite
迁移重建。运行时元数据（Workspace、Session、Onboarding、任务）仍在 SQLite，
Memory 之外的功能不受影响。

Memory schema 使用独立的版本表 `workspace_memory_schema_migrations`，迁移文件按
编号放在 `src/memory-pg/migrations/`，一个编号一个文件、各自一个事务。数据库版本
高于代码期望版本时拒绝启动（不降级执行）。当前有 001 基线、002（提炼与提议）、
003（三路回忆）和 004（整理与降级）；新迁移只能追加，001 不再修改。

### 修订与并发

每个 Workspace 有独立的 store revision，每个 item 有单独的 revision：

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
- 幂等预检与写入在同一个事务内完成，但外部 PostgreSQL 的并发请求仍可能同时
  通过预检：后写者会触发唯一约束（`create_idempotency_key` 或
  `mutation_requests` 主键，SQLSTATE 23505）。此时事务已回滚，服务端会重放
  一次同一事务——先提交的记录此时可见，于是按 request hash 返回
  `replayed: true` 或 `idempotency_conflict`，而不是 500。Owner Profile 的保留
  mutation 走同一套恢复逻辑。PGlite 只有一个串行连接，不会出现该竞态。

`validFrom`、`validUntil` 和 `expiresAt` 用于控制知识的时间有效性；`importance` 和
`confidence` 的范围都是 0 到 1。详情字段与端点见 [API 文档](API.md#workspace-memory-v2)。

### 全文检索

`workspace_memory_items.search_vector` 是生成的 `tsvector` 列，使用 `simple`
词典，并按旧 bm25 权重分配字段权重：title = A、`canonical_key` = B、
content = D；查询时 `ts_rank` 使用 `{0.3333, 0, 0.6667, 1}`。每次检索同时执行
tsvector 匹配与 `ILIKE` 子串匹配，因此中文短语（`simple` 词典不分词）仍能召回，
召回率不低于 SQLite FTS 时期。`pg_trgm` 及其 GIN 索引只是可选加速：外部
PostgreSQL 角色没有建扩展权限时只记录 warning，`ILIKE` 兜底结果仍然正确。

### 夜间整理与过期降级

`src/memory-consolidation/` 是宿主机上的后台维护任务：它不是用户可见的定时任务，
不出现在任务列表里，也不在容器内运行。每个本地日一次（默认 03:30，`TZ` 时区），
逐个 Workspace 做两件事——把过期条目降级为历史事实、把确定性重复合并成一条。
两步都只追加 revision，从不删除数据，全部可在版本链中追溯。

配置项走系统设置（Web 持久设置 > `MEMORY_CONSOLIDATION_*` 环境变量 > 默认值）：

| 设置                              | 默认     | 说明                                       |
| --------------------------------- | -------- | ------------------------------------------ |
| `memoryConsolidationEnabled`      | `true`   | 关闭后不再调度，已跑过的结果保留           |
| `memoryConsolidationTime`         | `03:30`  | 本地墙钟时间 `HH:MM`，非法值保留默认并告警 |
| `memoryConsolidationBatchSize`    | `200`    | 单批处理条目上限，1–1000                   |
| `memoryConsolidationMaxRuntimeMs` | `600000` | 单个 Workspace 单轮时长上限，10s–1h        |

运行语义：

- 是否到期只看“最近一次记录到的运行时刻”和“最近一个已到的计划时刻”。重启后补跑
  一次，计划时刻之前重启不会提前执行。
- 每个 Workspace 用 `workspace_memory_consolidation_state` 中的租约行
  （`lease_owner` / `lease_expires_at`）串行化，多实例部署不会重复整理；租约过期
  可被其他实例接管，崩溃不会把 Workspace 永久锁住。
- 单批受 `batchSize` 限制、单轮受 `maxRuntimeMs` 限制；到时限就停下并记 `partial`，
  剩下的留给下一次，不会为了跑完而拖住进程。
- 结果（`processed` / `merged` / `demoted` / `skippedGroups` / 错误 / 耗时）按
  Workspace 记录，通过 `GET /api/status/memory-consolidation` 查看，只有计数器，
  不含 Memory 内容。

去重判定（同 Workspace、同 kind、`active`、未降级），满足任一条即为重复：

1. `canonical_key` 相同；
2. 归一化内容相同——去掉空白与中英文标点、统一小写后逐字相等；
3. `pg_trgm` `similarity >= 0.85` 且标题相同（都为空视为相同）。

`pg_trgm` 不可用时只保留前两条精确判定。阈值 0.85 是有意的保守取值：中文短文本的
trigram 相似度偏低（一字之差常落在 0.75–0.8），0.85 实际只会合并几乎逐字相同、
标题也一致的条目——宁可漏合并，也不误合并，因为这里没有模型参与判断。

合并时保留 `importance` 最高的条目（并列取 `updated_at` 最新，再并列取 id），
keeper 的 `importance` 取组内最大值，其余条目置为 `superseded` 并写入
`superseded_by`；每条都追加一个 `update` 版本，actor 为
`memory_consolidation`（provenance 的 `sourceType` 同步扩展该取值）。被合并条目的
来源写入 `workspace_memory_merge_sources`，自身 provenance 也保留，因此来源不会因
合并丢失。计划与写入之间用 revision 做 compare-and-set：组内任一行在此期间被改过，
整组回滚并记为跳过，等下一次再合并，绝不覆盖并发编辑。

过期降级：

- `expires_at` 或 `valid_until` 已过的活跃条目写入 `demoted_at`，`importance`
  上限压到 0.3。
- `open_loop` 过期后 kind 变为 `fact`，标题（没有标题则内容）前加“（已过期）”，
  并记录 `demoted_from_kind = 'open_loop'`；其他 kind（例如临时促销 fact）保持
  kind 不变，`demoted_from_kind` 为空。
- 同时清空 `expires_at` / `valid_until`（旧值保存在降级前的版本记录里），这样
  降级条目仍能被检索命中。
- `pinned = true` 的条目不降级。该列由 002/004 以 `ADD COLUMN IF NOT EXISTS`
  幂等添加，两条迁移都可以重复执行。

**降级条目是历史事实：可以被搜索命中，但绝不进入 standing context 或主动回忆。**
回忆路径（`hasRecallableWorkspaceMemoryCanonicalKey`、
`listRecallableWorkspaceMemoryItems`）过滤掉 `demoted_at` 非空的条目；检索路径
按时间有效性过滤。两条过滤都在读取路径上完成，因此 Worker 没跑过也不会让过期
知识进入上下文，整理只负责把该状态落库、可审计。

### 跨库一致性

Memory 在 PostgreSQL、Workspace/Onboarding/任务在 SQLite，两者不能共享事务。
所有跨库写入都采用“Memory 先提交，SQLite 后提交”的固定顺序，并把失败语义写进
调用点注释：

- 删除 Workspace（`deleteRegisteredGroup`、`deleteGroupData`）：先删除该
  Workspace 的 Memory（幂等，可重复执行），再提交 SQLite 删除事务。中途崩溃只会
  留下“Memory 已空、Workspace/Group 仍在”，重试同一删除即收敛；不会出现
  “Workspace 已删但 Memory 残留并可能被他人读到”的状态。
- 重建 Workspace（`POST /api/groups/:jid/clear-history`）：先做预检（Workspace
  归属、活跃 Task Run）并让预检错误原样返回，再重置 Memory，最后用一个 SQLite
  事务重置 onboarding 行、回收任务、清理会话与聊天。SQLite 事务失败时会话与任务
  按原快照回滚、暂存文件恢复原位；Memory 已经重置且无法回滚，这是有意的取舍——
  重试重建是幂等的，而“已重建的 Workspace 仍能读到旧 Memory”不可接受。
- Owner Profile：先写 Memory 中的保留 item（唯一真相源），再在 SQLite 中把
  onboarding 置为 completed/skipped。第二步失败时 Memory 已生效而 onboarding
  仍为旧状态，下一次 claim/set 会幂等收敛；onboarding 行自身仍是单个 SQLite 事务，
  lease、`firstWakeAt` 与 revision 不会半更新。

### 旧 SQLite 数据导入

启动时如果 Memory 数据库为空、而 SQLite 主库仍有旧的 `workspace_memory_*` 数据，
会一次性把 items、versions、provenance、tombstones、audit、mutation_requests、
outbox 和 store revision 全部复制过去，并在 `workspace_memory_meta` 记录
`legacy_sqlite_import` 完成标记。导入在一个批次事务内完成（分批 100 行，
`ON CONFLICT DO NOTHING`），因此重复启动不会复制两次。导入完成后 Memory 只从
PostgreSQL 读写，不回写、不双写；旧的 SQLite 表仅作为备份保留。

保留键（owner preferred address）的去重与唯一索引在 bootstrap 中执行：先合并历史
重复行，再创建 `idx_workspace_memory_owner_address_unique` 这个部分唯一索引，
因此导入的旧库即使含重复也不会让启动失败。

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
