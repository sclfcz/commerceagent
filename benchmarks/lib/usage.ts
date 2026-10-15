import Database from 'better-sqlite3';
import type { UsageTotals } from './contracts.js';

export function readUsage(
  dbFile: string,
  scope: { userId: string; groupFolder: string; sessionId: string },
  targetModel: string,
) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    // Read a consistent snapshot. The existing host ledger is the sole deduplication authority.
    return db.transaction(() => {
      const params = [scope.userId, scope.groupFolder, scope.sessionId];
      const events = db
        .prepare(
          'SELECT * FROM usage_events WHERE user_id = ? AND group_folder = ? AND agent_id = ? ORDER BY created_at, event_id',
        )
        .all(...params) as Record<string, unknown>[];
      const records = db
        .prepare(
          'SELECT * FROM usage_records WHERE user_id = ? AND group_folder = ? AND agent_id = ? ORDER BY created_at, event_id, model',
        )
        .all(...params) as Record<string, unknown>[];
      const unexpected = db
        .prepare(
          'SELECT COUNT(*) AS count FROM usage_records WHERE user_id <> ? OR group_folder <> ? OR agent_id IS NULL OR agent_id <> ?',
        )
        .get(...params) as { count: number };
      const keys = {
        inputTokens: 'input_tokens',
        outputTokens: 'output_tokens',
        cacheReadInputTokens: 'cache_read_input_tokens',
        cacheCreationInputTokens: 'cache_creation_input_tokens',
        reasoningTokens: 'reasoning_output_tokens',
      } as const;
      const sum = (rows: Record<string, unknown>[], key: string) =>
        rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
      const eventIds = new Set(events.map((row) => row.event_id));
      const recordIds = new Set(records.map((row) => row.event_id));
      const reconciled =
        events.length > 0 &&
        records.length > 0 &&
        eventIds.size === recordIds.size &&
        records.every((row) => eventIds.has(row.event_id)) &&
        events.every((event) =>
          Object.values(keys).every(
            (key) =>
              Number(event[key]) ===
              sum(
                records.filter((row) => row.event_id === event.event_id),
                key,
              ),
          ),
        );
      const tokens = Object.fromEntries(
        Object.entries(keys).map(([name, key]) => [name, sum(records, key)]),
      ) as Omit<UsageTotals, 'durationMs' | 'eventCount'>;
      const known =
        reconciled &&
        Object.values(tokens).every(
          (value) => Number.isFinite(value) && value >= 0,
        ) &&
        Object.values(tokens).some((value) => value > 0);
      return {
        known,
        scopeIsolated: unexpected.count === 0,
        unexpectedRecordCount: unexpected.count,
        identityVerified:
          known &&
          records.every(
            (row) => row.model === targetModel && row.model !== 'unknown',
          ),
        usage: known
          ? {
              ...tokens,
              durationMs: sum(events, 'duration_ms'),
              eventCount: events.length,
            }
          : null,
      };
    })();
  } finally {
    db.close();
  }
}
