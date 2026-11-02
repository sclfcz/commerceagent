# Distributed runs (Phase 1–3)

MySQL owns run state. Redis only answers "may this run start now?" and "may this
model call go out now?" — losing Redis can never corrupt a run.

| File                | Role                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `run-repository.ts` | All run SQL: submit, claim, claimById, heartbeat, complete, fail, release, reap, cancel, outbox |
| `mysql.ts`          | Pool (UTC session), `withTransaction({ isolation })`                                            |
| `worker.ts`         | Claim loop, heartbeats, fencing, tenant-slot admission, graceful stop                           |
| `reaper.ts`         | Expired-lease recovery                                                                          |
| `relay.ts`          | Transactional outbox → RabbitMQ with publisher confirms                                         |
| `mq-consumer.ts`    | `run.ready` consumer, dedupe via `dist_consumed_messages`                                       |
| `tenant-slots.ts`   | Per-tenant concurrency slots (Redis ZSET, expiry-scored)                                        |
| `rate-limiter.ts`   | Token bucket for model calls (Redis hash, Lua)                                                  |
| `amqp-topology.ts`  | Exchange/queues/retry ladder/DLQ                                                                |

## Admission flow

1. A worker claims run rows in MySQL (`FOR UPDATE SKIP LOCKED`), which grants the
   lease and fencing token.
2. Before executing, it asks `TenantSlots.acquire(tenantId, runId)`. A rejection
   returns the run to the queue without consuming an attempt and with a short
   re-queue delay (200–400 ms) so the over-quota tenant cannot monopolise the
   global queue head. Rejected rows are also delayed because a run that keeps
   its original `available_at` would be re-claimed forever ahead of other
   tenants.
3. Every successful heartbeat renews the slot. A missing/expired slot is treated
   exactly like a lost lease: the run aborts and is left to expire, so a dead
   worker never blocks a tenant permanently.
4. `complete` / `fail` / `release` free the slot; a worker that already lost its
   lease does **not** free it (the new owner may already hold it under the same
   runId) — expiry is the safety net.

`DIST_TENANT_CONCURRENCY=0` disables all Redis admission calls.

## Token bucket: expected call site

The bucket is deliberately not wired into the provider pool yet (that would touch
main-service code). The intended integration is one `tryAcquire` per upstream
model request, before the SDK call:

```ts
const bucket = new TokenBucket({ redis, failMode: config.admissionFailMode });

// one key per tenant + model family
const permit = await bucket.tryAcquire(
  `dist:rate:${tenantId}:${modelFamily}`,
  ratePerSec,
  burst,
);
if (!permit.allowed) {
  await bucket.acquireBlocking(key, ratePerSec, burst, maxWaitMs);
}
await callModel();
```

`acquireBlocking` is for request paths that may wait; `tryAcquire` is for paths
that should fail fast (e.g. a batch fan-out). The bucket uses the same
`DIST_ADMISSION_FAIL_MODE` switch as the slots.

## Effect protocol

Steps and external side effects are recorded in `dist_run_steps` and replayed
from that ledger:

```
compute step:                     effect step:
  read (run_id, step_key)            INSERT intent (fenced, request_hash)
    ├─ committed -> return output      ├─ already committed -> return provider_ref
    └─ else -> run fn, fenced          ├─ request_hash differs -> EffectRequestMismatchError
               write committed         └─ intent/unknown (previous attempt):
                                          ├─ supportsLookup + lookup() found  -> committed (reconciled)
                                          ├─ supportsLookup + not found       -> send
                                          └─ no lookup                        -> run = needs_review
                                       send (fenced pre-check, DIST_EFFECT_TIMEOUT_MS)
                                          ├─ ok        -> committed + provider_ref
                                          ├─ timeout / network / 5xx -> unknown + RetryableError
                                          └─ 4xx       -> failed (run goes dead)
```

`step()` and every ledger write run in a transaction that first does
`SELECT 1 FROM dist_task_runs WHERE id=? AND status='running' AND lease_owner=?
AND lease_token=? FOR UPDATE`; a miss raises `LeaseLostError` and nothing is
written. A run parked in `needs_review` is not claimable and needs a human.

**Fencing limitation:** the fence stops a zombie worker from _writing the
database_, but it cannot stop it from sending an outbound request between the
fence check and the send. If the provider honours the idempotency key, the
duplicate is removed downstream. If it neither honours the key nor supports
lookup, the only guarantee is "at most once, then human review"
(`needs_review`). This is why every effect row carries
`idempotency_key = ${runId}:${stepKey}` — it is the only handle the outside
world may deduplicate on.

`Reaper` additionally scans for `unknown` steps older than 5 minutes whose run
is already terminal (`DIST_UNKNOWN_SWEEP_MS`, monitoring only).

**Settle window (`DIST_EFFECT_SETTLE_MS`, default 2000):** a client timeout does
not cancel the request the provider is already processing. When a lookup misses,
the context compares `NOW(3) - send_started_at` against
`effectTimeoutMs + effectSettleMs` and, while still inside that window, defers
the retry (`reconcileDeferred`) with `available_at` pushed past the window
instead of sending again. Only after the window does a second miss count as
"never sent". The window cannot cover a worker frozen between the fence check
and the send (unbounded); only a provider that honours the idempotency key can
remove that duplicate.

**Lookup race:** "lookup says not found, so send" assumes the provider has
already made a _timed-out_ send visible. If the first send is still in flight
server-side when the retry looks it up, the retry sends again and the provider
sees two requests. A provider that honours the idempotency key collapses them;
one that does not will record a duplicate. This was observed once during
development (2 duplicates out of 1000 messages in one repeat); the delivered
chaos run had 0 because the retry happened after the message was visible.

## 与定时任务的集成（DIST_SCHEDULER=1）

默认关闭。开关关闭时 `pumpTaskScheduler` 仍按原逻辑循环 `claimNextTaskRun`，行为与
加入本模块前完全一致。

**职责划分**

- **SQLite `task_runs` 仍是任务结果、历史、通知和 UI 的唯一真相源。**
  `materializeDueOccurrences`、`failExpiredStartedTaskRuns`、通知重试与日志清理继续在
  legacy pump 里运行，不迁移、不改语义。
- **MySQL `dist_task_runs` 只是派发信封**：负责排队、outbox + MQ 唤醒、派发租约和租户
  准入。一个 SQLite run 对应一个 dist run：`idempotency_key = task_run.id`，
  `tenant_id = 工作区 owner 的 user id`（取不到时 `system`），`max_attempts = 20`
  只统计派发次数，重试预算仍由 SQLite `attempt` 决定。
- 开关打开后 pump 不再自己认领，而是唤醒 forwarder；forwarder 把 `queued/retry_wait`
  的 run 提交成 dist 信封（`available_at` 取 SQLite 的值，outbox 同步）。
  内存 Set 只减少重复提交，重启后全量重提，靠幂等键去重。

**每次领到 dist 信封都要先对账 SQLite**

1. SQLite 已终态（`success/failed/cancelled/missed/delivered`）→ dist complete，
   `result = {mirroredStatus}`，**不执行**；
2. `queued/retry_wait` 且未到 `available_at` → dist release，延迟为剩余时间；
3. `running` 且 SQLite 租约未过期 → dist release，延迟 `leaseMs`；
4. 否则 `claimTaskRunById`（条件与 `claimNextTaskRun` 完全相同，只固定 id）→ 执行 →
   重新读 SQLite → 终态则 complete，回到 `retry_wait` 则 release（按其 `available_at`）。

崩溃语义沿用 legacy：**执行开始后进程崩溃不会重放**，`failExpiredStartedTaskRuns`
把它记为 `failed`，下一次 dist 对账把这个终态镜像过去；dist 的 20 次派发额度绕不过它。

**两个围栏，不要混用**

- **MySQL 租约是派发围栏**：丢失后只是停止向 dist 回写，下一次认领会通过对账收敛；
  它**不会**中止正在运行的 legacy 执行。
- **SQLite 租约是执行围栏**：`claimTaskRunById` / `markTaskRunExecutionStarted` /
  `completeTaskRun` 全部按 owner+token 校验，本地执行只认它。

**当前边界**

执行层依赖进程内的 `GroupQueue`、`sendMessage`、`broadcastStreamEvent` 和本机工作区
文件，因此这一版只能单机运行：内嵌 Worker 与主服务同进程，不拆独立进程，也不跨机器
执行。Host 模式任务跳过租户槽位（CLAUDE.md §4 不允许在 Host 会话之间设置应用层并发
上限），container 模式任务才走 `tenant-slots`；容器并发仍由 `maxConcurrentContainers`
控制，内嵌 Worker 的 `concurrency` 只作为单批派发上限。

## Failure modes

`DIST_ADMISSION_FAIL_MODE=open` (default): a Redis error admits the work and
logs `admission_degraded` once every 5 s (availability first).
`closed`: the work is rejected so it can be retried later (consistency first).

## Known trade-offs

- Admission happens _after_ the MySQL claim, so a throttled tenant's runs are
  claimed/released repeatedly. This shows up as extra `claimed` events and as
  completion-latency churn for that tenant (see the fairness benchmark). A
  per-tenant claim queue or "reserve before claim" would remove it.
- Retry-queue TTLs are queue arguments; changing them requires a new queue name
  (tests use a unique prefix and numeric suffixes).
