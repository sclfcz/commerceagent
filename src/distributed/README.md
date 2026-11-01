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
