/**
 * In-process counters used by `dist:bench` and by the worker's shutdown line.
 * Kept deliberately cheap: claim timings are only recorded when a sink exists
 * (the benchmark injects one), so production workers pay nothing.
 */
export interface ClaimSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

function percentile(sorted: number[], quantile: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(3));
}

export function summarizeLatencies(samples: number[]): ClaimSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : null,
  };
}

export class RuntimeStats {
  /** Raw claim durations in milliseconds; small (one entry per claim batch). */
  readonly claimLatencySamples: number[] = [];
  claimBatches = 0;
  claimedRuns = 0;
  deadlockRetries = 0;
  transactionRetries = 0;

  recordClaim(durationMs: number, runs: number): void {
    this.claimBatches += 1;
    this.claimedRuns += runs;
    this.claimLatencySamples.push(Number(durationMs.toFixed(3)));
  }

  recordTransactionRetry(): void {
    this.transactionRetries += 1;
    this.deadlockRetries += 1;
  }

  snapshot() {
    return {
      claimBatches: this.claimBatches,
      claimedRuns: this.claimedRuns,
      deadlockRetries: this.deadlockRetries,
      claimLatencyMs: summarizeLatencies(this.claimLatencySamples),
      claimLatencyMsSamples: this.claimLatencySamples,
    };
  }
}
