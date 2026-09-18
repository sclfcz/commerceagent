import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commerceagent-usage-v51-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSystemSettings: () => ({ billingEnabled: true }),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { deriveUsageEventId, recordUsageEvent } =
  await import('../src/usage-service.js');

const dbPath = path.join(store, 'messages.db');
let probe: InstanceType<typeof Database>;

beforeAll(() => {
  db.initDatabase();
  probe = new Database(dbPath, { readonly: true });
  const now = new Date().toISOString();
  db.createUser({
    id: 'member-usage',
    username: 'member-usage',
    password_hash: 'x',
    display_name: 'Usage member',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.createUser({
    id: 'zero-cost-user',
    username: 'zero-cost-user',
    password_hash: 'x',
    display_name: 'Zero cost user',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.createUser({
    id: 'model-mismatch-user',
    username: 'model-mismatch-user',
    password_hash: 'x',
    display_name: 'Model mismatch user',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.createUser({
    id: 'reasoning-user',
    username: 'reasoning-user',
    password_hash: 'x',
    display_name: 'Reasoning user',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

afterAll(() => {
  probe.close();
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('v51 usage event accounting', () => {
  test('does not include non-authoritative SDK costs in fallback identity', () => {
    const base = {
      userId: 'member-usage',
      groupFolder: 'identity-workspace',
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 25,
        costUSD: 1,
        durationMs: 10,
        numTurns: 1,
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 1_000,
            outputTokens: 100,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 25,
            costUSD: 1,
          },
        },
      },
    };
    expect(deriveUsageEventId(base)).toBe(
      deriveUsageEventId({
        ...base,
        usage: {
          ...base.usage,
          costUSD: 999,
          modelUsage: {
            'claude-sonnet-4-5': {
              ...base.usage.modelUsage['claude-sonnet-4-5'],
              costUSD: 500,
            },
          },
        },
      }),
    );
  });

  test('returns an exact N-calendar-day window', () => {
    expect(db.getUsageDateWindow(7, new Date(2026, 6, 16, 12))).toMatchObject({
      from: '2026-07-10',
      to: '2026-07-16',
      days: 7,
    });
    expect(db.getUsageDateWindow(1, new Date(2026, 6, 16, 12))).toMatchObject({
      from: '2026-07-16',
      to: '2026-07-16',
      days: 1,
    });
  });

  test('date-window queries use the indexed materialized usage date', () => {
    const plan = probe
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usage_records r
         WHERE r.user_id = ? AND r.usage_date >= ? AND r.usage_date <= ?`,
      )
      .all('member-usage', '2026-07-10', '2026-07-16') as Array<{
      detail: string;
    }>;
    expect(
      plan.some((row) => row.detail.includes('idx_usage_user_usage_date')),
    ).toBe(true);
  });

  test('commits a multi-model event once and counts one run', () => {
    const input = {
      eventId: 'turn-multi-model',
      userId: 'member-usage',
      groupFolder: 'workspace-a',
      agentId: 'reviewer',
      source: 'custom-agent',
      createdAt: '2026-07-16T03:00:00.000Z',
      inputTokens: 30,
      outputTokens: 5,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 20,
      providerEstimatedCostUSD: 0,
      billedCostUSD: 0,
      durationMs: 100,
      numTurns: 1,
      trackBillingUsage: true,
      models: [
        {
          model: 'model-a',
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 10,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
        {
          model: 'model-b',
          inputTokens: 20,
          outputTokens: 3,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 10,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
      ],
    } as const;
    expect(db.recordUsageEventBatch(input).inserted).toBe(true);
    expect(db.recordUsageEventBatch(input).inserted).toBe(false);

    const analytics = db.getUsageAnalytics({
      from: '2026-07-16',
      to: '2026-07-16',
      userId: 'member-usage',
    });
    expect(analytics.summary).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
      totalTokens: 155,
      runCount: 1,
      modelCallCount: 2,
    });

    // Cost=0 must still count all input/cache categories toward token quota.
    const monthly = probe
      .prepare(
        "SELECT * FROM monthly_usage WHERE user_id = ? AND month = '2026-07'",
      )
      .get('member-usage') as any;
    expect(monthly.total_input_tokens).toBe(150);
    expect(monthly.total_output_tokens).toBe(5);
    expect(monthly.message_count).toBe(1);
  });

  test('counts sub-cent tokens while applying Kaboo bucket rounding', () => {
    recordUsageEvent({
      eventId: 'zero-cost-service-event',
      userId: 'zero-cost-user',
      groupFolder: 'zero-cost-workspace',
      source: 'web',
      createdAt: '2026-07-16T03:30:00.000Z',
      usage: {
        eventId: 'zero-cost-service-event',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 5,
        costUSD: 0,
        durationMs: 1,
        numTurns: 1,
      },
    });
    const monthly = probe
      .prepare(
        "SELECT * FROM monthly_usage WHERE user_id = 'zero-cost-user' AND month = '2026-07'",
      )
      .get() as any;
    expect(monthly.total_input_tokens).toBe(45);
    expect(monthly.total_output_tokens).toBe(2);
    expect(monthly.total_cost_usd).toBe(0);
    expect(
      (
        probe
          .prepare(
            "SELECT COUNT(*) AS count FROM balance_transactions WHERE idempotency_key = 'usage_event_zero-cost-service-event'",
          )
          .get() as any
      ).count,
    ).toBe(0);
  });

  test('persists Kaboo reasoning separately while conserving totals, quota and cost', () => {
    const result = recordUsageEvent({
      eventId: 'reasoning-split-event',
      userId: 'reasoning-user',
      groupFolder: 'reasoning-workspace',
      source: 'web',
      createdAt: '2026-07-16T04:00:00.000Z',
      usage: {
        eventId: 'reasoning-split-event',
        inputTokens: 0,
        outputTokens: 250,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 750,
        costUSD: 999,
        durationMs: 10,
        numTurns: 1,
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 0,
            outputTokens: 250,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningTokens: 750,
            costUSD: 999,
          },
        },
      },
    });
    // $0.015 at Sonnet output/reasoning rates, rounded once like Kaboo.
    expect(result.providerEstimatedCostUSD).toBe(0.02);
    const event = probe
      .prepare(
        `SELECT output_tokens, reasoning_output_tokens,
          provider_estimated_cost_usd
         FROM usage_events WHERE event_id = ?`,
      )
      .get('reasoning-split-event') as any;
    expect(event).toMatchObject({
      output_tokens: 250,
      reasoning_output_tokens: 750,
      provider_estimated_cost_usd: 0.02,
    });
    const analytics = db.getUsageAnalytics({
      from: '2026-07-16',
      to: '2026-07-16',
      userId: 'reasoning-user',
    });
    expect(analytics.summary).toMatchObject({
      outputTokens: 250,
      reasoningTokens: 750,
      totalTokens: 1_000,
    });
    const monthly = probe
      .prepare(
        "SELECT total_output_tokens FROM monthly_usage WHERE user_id = 'reasoning-user' AND month = '2026-07'",
      )
      .get() as any;
    expect(monthly.total_output_tokens).toBe(1_000);
  });

  test('carries sub-cent usage inside one UTC half-hour model bucket', () => {
    const make = (eventId: string, createdAt: string) =>
      recordUsageEvent({
        eventId,
        userId: 'member-usage',
        groupFolder: 'workspace-cent-carry',
        source: 'web',
        createdAt,
        usage: {
          eventId,
          inputTokens: 1_633,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 999,
          durationMs: 1,
          numTurns: 1,
          modelUsage: {
            'unlisted-model': {
              inputTokens: 1_633,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 999,
            },
          },
        },
      });
    // Each event is $0.004899 at the Kaboo Sonnet fallback. Per-event
    // rounding would lose both; one bucket rounds their $0.009798 total to 1¢.
    expect(make('cent-carry-1', '2026-07-16T06:01:00.000Z')).toMatchObject({
      providerEstimatedCostUSD: 0,
      billedCostUSD: 0,
    });
    expect(make('cent-carry-2', '2026-07-16T06:20:00.000Z')).toMatchObject({
      providerEstimatedCostUSD: 0.01,
      billedCostUSD: 0.01,
    });
    expect(
      db.getUsageAnalytics({
        from: '2026-07-16',
        to: '2026-07-16',
        groupFolder: 'workspace-cent-carry',
      }).summary.providerEstimatedCostUSD,
    ).toBe(0.01);
  });

  test('does not carry rounding residual across UTC half-hour boundaries', () => {
    const record = (eventId: string, createdAt: string) =>
      recordUsageEvent({
        eventId,
        userId: 'member-usage',
        groupFolder: 'workspace-cent-boundary',
        source: 'web',
        createdAt,
        usage: {
          eventId,
          inputTokens: 1_633,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 999,
          durationMs: 1,
          numTurns: 1,
          modelUsage: {
            'unlisted-model': {
              inputTokens: 1_633,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: 999,
            },
          },
        },
      });
    expect(record('cent-boundary-1', '2026-07-16T06:29:59.999Z')).toMatchObject(
      { providerEstimatedCostUSD: 0 },
    );
    expect(record('cent-boundary-2', '2026-07-16T06:30:00.000Z')).toMatchObject(
      { providerEstimatedCostUSD: 0 },
    );
  });

  test('custom Agent uses the same idempotent analytics and balance path', () => {
    const options = {
      eventId: 'custom-agent-paid-turn',
      userId: 'member-usage',
      groupFolder: 'workspace-custom',
      agentId: 'custom-agent-1',
      messageId: 'message-custom-1',
      source: 'custom-agent',
      createdAt: '2026-07-16T04:00:00.000Z',
      usage: {
        eventId: 'custom-agent-paid-turn',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        // Compatibility-only SDK estimate. Kaboo token pricing is $4.50.
        costUSD: 1.25,
        durationMs: 25,
        numTurns: 1,
        modelUsage: {
          'paid-model': {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 1.25,
          },
        },
      },
    };
    expect(recordUsageEvent(options).inserted).toBe(true);
    expect(recordUsageEvent(options).inserted).toBe(false);

    expect(
      recordUsageEvent({
        ...options,
        eventId: 'custom-agent-paid-turn-2',
        usage: {
          ...options.usage,
          eventId: 'custom-agent-paid-turn-2',
          costUSD: 0.5,
          modelUsage: {
            'paid-model': {
              ...options.usage.modelUsage['paid-model'],
              costUSD: 0.5,
            },
          },
        },
      }).inserted,
    ).toBe(true);

    const charges = probe
      .prepare(
        "SELECT * FROM balance_transactions WHERE idempotency_key LIKE 'usage_event_custom-agent-paid-turn%' ORDER BY id",
      )
      .all() as any[];
    expect(charges).toHaveLength(2);
    expect(charges[0].reference_type).toBe('usage_event');
    expect(charges[0].amount_usd).toBeCloseTo(-4.5);
    expect(charges[1].amount_usd).toBeCloseTo(-4.5);
    expect(
      (
        probe
          .prepare(
            `SELECT COUNT(*) AS count FROM billing_audit_log
             WHERE event_type = 'balance_deducted'
               AND json_extract(details, '$.usageEventId') LIKE 'custom-agent-paid-turn%'`,
          )
          .get() as any
      ).count,
    ).toBe(2);
    expect(
      db.getUsageAnalytics({
        from: '2026-07-16',
        to: '2026-07-16',
        groupFolder: 'workspace-custom',
      }).summary.runCount,
    ).toBe(2);
  });

  test('prices root tokens when the SDK omits model costs', () => {
    recordUsageEvent({
      eventId: 'root-cost-only',
      userId: 'member-usage',
      groupFolder: 'workspace-root-cost',
      source: 'main-agent',
      createdAt: '2026-07-16T05:00:00.000Z',
      usage: {
        eventId: 'root-cost-only',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        // Must not enter analytics or billing.
        costUSD: 2,
        durationMs: 10,
        numTurns: 1,
        modelUsage: {
          'missing-cost-a': {
            inputTokens: 750_000,
            outputTokens: 50_000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
          },
          'missing-cost-b': {
            inputTokens: 250_000,
            outputTokens: 50_000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
          },
        },
      },
    });
    const analytics = db.getUsageAnalytics({
      from: '2026-07-16',
      to: '2026-07-16',
      userId: 'member-usage',
      groupFolder: 'workspace-root-cost',
    });
    expect(analytics.summary.providerEstimatedCostUSD).toBeCloseTo(4.5);
    expect(analytics.summary.billedCostUSD).toBeCloseTo(4.5);
    expect(
      analytics.attributions.models.reduce(
        (sum, item) => sum + item.providerEstimatedCostUSD,
        0,
      ),
    ).toBeCloseTo(4.5);
  });

  test('rebuilds event and quota roots from authoritative model usage', () => {
    const result = recordUsageEvent({
      eventId: 'model-token-mismatch',
      userId: 'model-mismatch-user',
      groupFolder: 'workspace-model-mismatch',
      source: 'main-agent',
      createdAt: '2026-07-16T05:30:00.000Z',
      usage: {
        eventId: 'model-token-mismatch',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 200_000,
        cacheCreationInputTokens: 100_000,
        costUSD: 999,
        durationMs: 10,
        numTurns: 1,
        modelUsage: {
          'claude-opus-4-5-20251101': {
            inputTokens: 600_000,
            outputTokens: 60_000,
            cacheReadInputTokens: 50_000,
            cacheCreationInputTokens: 50_000,
            costUSD: 500,
          },
          'claude-haiku-4-5': {
            inputTokens: 200_000,
            outputTokens: 40_000,
            cacheReadInputTokens: 150_000,
            cacheCreationInputTokens: 25_000,
            costUSD: 499,
          },
        },
      },
    });

    expect(result.providerEstimatedCostUSD).toBe(5.29);
    expect(result.billedCostUSD).toBe(5.29);
    const event = probe
      .prepare(
        `SELECT input_tokens, output_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, provider_estimated_cost_usd,
          billed_cost_usd
         FROM usage_events WHERE event_id = 'model-token-mismatch'`,
      )
      .get() as any;
    expect(event).toMatchObject({
      input_tokens: 800_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 75_000,
      provider_estimated_cost_usd: 5.29,
      billed_cost_usd: 5.29,
    });
    const modelTotals = probe
      .prepare(
        `SELECT SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_input_tokens) AS cache_read_input_tokens,
          SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
          SUM(provider_estimated_cost_usd) AS provider_estimated_cost_usd,
          SUM(billed_cost_usd) AS billed_cost_usd
         FROM usage_records WHERE event_id = 'model-token-mismatch'`,
      )
      .get() as any;
    expect(modelTotals).toMatchObject({
      input_tokens: event.input_tokens,
      output_tokens: event.output_tokens,
      cache_read_input_tokens: event.cache_read_input_tokens,
      cache_creation_input_tokens: event.cache_creation_input_tokens,
    });
    // SQLite stores USD as REAL, so SUM may expose an IEEE-754 tail.
    expect(modelTotals.provider_estimated_cost_usd).toBeCloseTo(
      event.provider_estimated_cost_usd,
    );
    expect(modelTotals.billed_cost_usd).toBeCloseTo(event.billed_cost_usd);
    expect(
      (
        probe
          .prepare(
            `SELECT COUNT(*) AS count FROM usage_records
             WHERE event_id = 'model-token-mismatch' AND model = 'unknown'`,
          )
          .get() as any
      ).count,
    ).toBe(0);
    const monthly = probe
      .prepare(
        `SELECT total_input_tokens, total_output_tokens, total_cost_usd
         FROM monthly_usage
         WHERE user_id = 'model-mismatch-user' AND month = '2026-07'`,
      )
      .get() as any;
    expect(monthly).toMatchObject({
      // Quota input includes uncached input plus cache read and creation.
      total_input_tokens: 1_075_000,
      total_output_tokens: 100_000,
      total_cost_usd: 5.29,
    });
  });

  test('rebuilds a message snapshot from all incremental events', () => {
    db.ensureChatExists('web:snapshot');
    db.storeMessageDirect(
      'snapshot-message',
      'web:snapshot',
      'assistant',
      'CommerceAgent',
      'done',
      '2026-07-16T06:00:00.000Z',
      true,
    );
    for (const [eventId, inputTokens, cost] of [
      ['snapshot-event-1', 10, 0.25],
      ['snapshot-event-2', 30, 0.75],
    ] as const) {
      db.recordUsageEventBatch({
        eventId,
        userId: 'member-usage',
        groupFolder: 'snapshot-workspace',
        messageId: 'snapshot-message',
        inputTokens,
        outputTokens: 1,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 3,
        providerEstimatedCostUSD: cost,
        billedCostUSD: cost,
        models: [
          {
            model: 'snapshot-model',
            inputTokens,
            outputTokens: 1,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 3,
            providerEstimatedCostUSD: cost,
            billedCostUSD: cost,
          },
        ],
      });
    }
    db.rebuildMessageTokenUsageFromLedger(
      'web:snapshot',
      'snapshot-workspace',
      'snapshot-message',
    );
    const row = probe
      .prepare(
        "SELECT token_usage, cost_usd FROM messages WHERE id = 'snapshot-message' AND chat_jid = 'web:snapshot'",
      )
      .get() as any;
    expect(JSON.parse(row.token_usage)).toMatchObject({
      inputTokens: 40,
      outputTokens: 2,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 6,
      costUSD: 1,
      modelUsage: {
        'snapshot-model': {
          inputTokens: 40,
          outputTokens: 2,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 6,
          costUSD: 1,
        },
      },
    });
    expect(row.cost_usd).toBeCloseTo(1);
  });
});
