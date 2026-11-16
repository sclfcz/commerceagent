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
高于代码期望版本时拒绝启动（不降级执行）。当前已应用到 003：001 为基线，002 增加
`search_keys` / `pinned` 检索字段，003 增加候选提炼侧表与 `agent_extraction` /
`system` 来源类型；004 由夜间整理阶段按编号追加。

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

### 候选提炼与确认

Memory 有一条“先提议、后生效”的写入口，自动提炼和 Agent 提议都走这条路径：

- `status = 'proposed'` 的 item 不会出现在 snapshot、搜索或任何活跃列表，只有确
  认后才变为 `active`。
- 候选的附加数据（`applies_when`、`search_keys`、`evidence_message_ids`、过期时
  间、决策状态）保存在 `workspace_memory_candidates` 侧表；item 本身仍是普通
  Memory，沿用 revision、versions、audit 和 outbox。
- 自动提炼的触发条件：顶层交互会话（Main Session 或 conversation 类型的 Runtime
  Session）超过 `memoryExtractionIdleMs` 没有新消息，或收到上下文压缩边界。宿主
  每分钟扫描一次，按 SQLite 中的消息时间判断空闲，因此重启不会丢待办。阈值和总
  开关在 系统设置 → 运行资源 / 记忆候选提炼 中调节（默认 15 分钟、默认开启）。
- 每个 Session 有独立的游标（`workspace_memory_extraction_cursors`），只读取上次
  提炼之后的消息。定时任务、Task/Spawn Sub-Agent 和纯 assistant 消息窗口不会成为
  来源；游标只在模型成功返回后推进，传输失败保留窗口并按三次、30 分钟退避重试，
  schema 不合法则丢弃该窗口并推进，避免每轮重复烧模型调用。
- 提炼使用宿主现成的一次性模型通道（与标题生成、AgentProfile 生成相同的
  `sdkQuery` 和 Provider 配置），提示词位于
  `container/agent-runner/prompts/memory-extraction.md`。
- 模型输出必须是严格 JSON：最多 5 条候选，`kind`/`title`/`content`/`confidence`/
  `importance`/`evidence_message_ids` 为必需字段，`lesson` 额外要求
  `applies_when` 且置信度不低于 0.7；每次提炼最多保留一条 `fact`（会话小结）。
  不合法响应整体丢弃，不做部分修复。
- 写入前过滤密钥、凭据、连接串和个人数据（邮箱、手机号、身份证、私网地址等），
  并与现有 active/proposed/conflicted 条目按 canonical key、包含关系和字符
  bigram 相似度去重；同一次响应内重复提议也会收敛。
- 确认与拒绝都走 CAS：`expectedRevision` 不符返回 409，确认会先校验 item 仍为
  `proposed`。拒绝写成 `deleted` tombstone，reason 固定为 `rejected`，并记录决策
  人和时间。
- 候选自创建起 14 天未被确认会自动转为 `superseded`（候选行记为 `expired`），
  由同一次宿主扫描惰性执行。

### 全文检索

`workspace_memory_items.search_vector` 是生成的 `tsvector` 列，使用 `simple`
词典：title 和 `search_keys` 都是 A，`canonical_key` 是 B，content 是 D；查询时
`ts_rank` 使用 `{0.3333, 0, 0.6667, 1}`。每次检索同时执行 tsvector 匹配与
`ILIKE` 子串匹配，因此中文短语（`simple` 词典不分词）仍能召回，召回率不低于
SQLite FTS 时期。`pg_trgm` 及其 GIN 索引只是可选加速：外部 PostgreSQL 角色没有
建扩展权限时只记录 warning，`ILIKE` 兜底结果仍然正确。

### 检索关键词（search_keys）

`simple` 词典把整句中文当作一个 lexeme，长问句永远匹配不上短条目。为了弥补这一
点，每个 item 带一列确定性的检索关键词 `search_keys`（`text[]`，最多 12 个，
每个 1–32 字符，小写并去重）：

- `search_keys` 与 title 同权重（A）进入 `search_vector`，同时参与
  `ILIKE ANY(...)` 匹配，并在 `search_key_hits` 中计数；排序为
  `search_key_hits DESC, ts_rank DESC, importance DESC, updated_at DESC`。
- 写入侧（`deriveSearchKeys`）：中文按标点切成 2–4 字 n-gram，按 title(3) /
  canonical_key(2) / content(1) 加权并保留高信息量片段；英文与数字按词切分；
  去掉中英文停用词；已被选中关键词包含或被包含的候选直接跳过。
- 查询侧（`deriveQueryKeywords`）：英数词优先，其次整段 2–4 字中文 run，再取长
  run 的全部 2-gram，最后补 3/4-gram，最多 24 个。两侧算法共用同一套切分与停用词
  表，所以“长问句里的两个字”能命中“条目里存的四个字”：匹配时用双向包含
  （`strpos(sk, kw) > 0 OR strpos(kw, sk) > 0`）。
- Agent 可以在 `workspace_memory_remember` / `workspace_memory_update` 上传
  `search_keys`；不传时宿主按标题和正文派生，正文变更且没有显式关键词时重新派生。
- 显式关键词写入版本记录；派生关键词属于元数据，重新计算不递增 revision、不追加
  版本。启动时会为 `cardinality(search_keys) = 0` 的历史行补一次，可重复执行。

### pinned 与三路召回

`pinned` 表示“每轮都必须出现”的店铺画像与身份偏好。它和 create/update 的其它字段
一样走 revision CAS 并写入版本记录，不能绕过并发保护。

一次快照共享同一个 `maxChars` 预算，按 `profile → relevant → proactive` 顺序渲染，
前一段没用完的字符预算顺延给后一段；每个条目只出现在一段中：

| 段          | 内容                                                              | 预算                                                              | 排序                                     |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `profile`   | `pinned` 且当前有效的条目                                         | 默认 30%，硬上限 40%                                              | importance                               |
| `relevant`  | 检索命中 + 按 importance 补齐的其余活跃条目（不含到期 open_loop） | 剩余预算（`maxChars − profile 已用 − proactive 预留 15%`）        | `rank ?? importance × exp(−Δt / 半衰期)` |
| `proactive` | 到期的 `open_loop`                                                | 剩余预算（`maxChars − profile 已用 − relevant 已用`，至少约 15%） | 到期时间早者优先，其次 importance        |

- 时间衰减的 Δt 取 `provenance.observedAt`，缺失时用 `updatedAt`；半衰期默认 30
  天。`pinned` 条目不衰减。
- `proactive` 只收录 `status = active` 的 `open_loop`，且满足
  `expires_at ∈ (now, now + 72h]` 或 `valid_from <= now`；两个条件互相独立，因此
  “已到生效时间、但到期还在很远的”待跟进也会被主动注入。其余条目即使与问题无关也
  不会进入该段。
- 每段的 `budgetChars` / `usedChars` / `included` / `truncated` / `itemIds` 都写入
  `retrievalTrace.segments`；被裁掉的条目只记录数量，不注入正文。
- 渲染为 `<workspace_memory>` 下的 `<profile>`、`<relevant>`、`<proactive>` 三个
  分组，空分组直接省略，`pinned` 条目带 `pinned="true"` 属性。

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

- `sourceType`：服务端根据 Web 用户、Agent Runtime、定时任务、自动提炼、系统
  维护或迁移流程生成，取值包括 `web_user`、`agent_runtime`、`scheduled_task`、
  `agent_extraction`、`system` 和 `migration`。
- `sourceId`：可选的来源消息或运行标识。
- `sessionId`：可选的来源 Session 标识。
- `observedAt`：知识被观察到的时间，不等同于数据库写入时间。

客户端可以提交 `sourceId`、`sessionId` 和 `observedAt`，不能伪造
`sourceType` 或 actor。读取要求能够访问 Workspace，写入要求能够修改 Workspace；
未授权与不存在均返回 404，管理员也不能跨 owner 读取 Workspace Memory。

Agent Runtime 还按执行上下文收紧写权限：顶层交互式 Main/Runtime Session 可按
Workspace ACL 读写，并可使用 `workspace_memory_review` 列出、确认或拒绝候选；
Scheduled Run（group/isolated）和 SDK Task/Spawn Sub-Agent 不能创建、更新、忘记
或确认 Memory，只能读取，并可通过 `workspace_memory_propose` 写入 `proposed`
候选——候选在人工确认前不可见，因此这条通道不会扩大它们的影响面。候选确认等同于
写入 active Memory，仍要求顶层交互 turn 的 HMAC 能力凭证。

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
3. 存在候选时显示“待确认”分组：每条候选展示类型、内容、适用条件、证据数量、
   过期时间和来源，可确认、编辑后确认或拒绝；操作携带当前 item revision，冲突时
   提示并刷新列表。
4. 搜索只在当前 Workspace 内执行；类别筛选可与搜索组合。
5. 详情展示来源 Session/来源 ID、观察时间、item revision、store revision 和修订
   时间线。
5. 详情和创建对话框都可以编辑 `search_keys`（逗号、分号或空白分隔，最多 12 个，
   留空表示由宿主派生），并可以打开“常驻画像”开关设置 `pinned`；列表和详情会显示
   “常驻”标记。这两项和正文一样走 PATCH CAS。
6. 有修改权限时可以创建、编辑和忘记；只读 Workspace 不显示可执行写操作。

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
- 长中文问句能命中只带短关键词的条目；改写前的整句匹配零召回，现在能召回。
- `pinned` 变更走 `expectedRevision` CAS，并在 versions 中留下记录。
- 快照按 `profile`/`relevant`/`proactive` 三段渲染，未用预算顺延，`profile` 有
  40% 硬上限，到期的 `open_loop` 无论是否相关都会被注入。
- 候选在确认前不出现在 snapshot、搜索和活跃列表；拒绝留下 `rejected` tombstone，
  超过 14 天未确认自动 `superseded`。
- 定时任务和 Sub-Agent 只能 propose，不能确认、拒绝或直接写入 active Memory。
- 只读 Workspace 无写操作，未授权资源不泄露存在性。
- UI 和 Runtime 均不调用旧 `/sources`、`/search`、`/file`、`/global` 端点。
