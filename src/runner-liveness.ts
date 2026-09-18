export const RUNNER_SHUTDOWN_GRACE_MS = 15_000;

export interface RunnerLivenessTimeouts {
  /** Warm runner retention after the latest output. */
  idleCloseMs: number;
  /** Outer process/container watchdog after the latest stdout activity. */
  watchdogMs: number;
}

/**
 * Keep graceful warm-runner reclamation strictly ahead of the outer watchdog.
 *
 * Historically both defaults were 30 minutes. The stdout watchdog was reset
 * before the host finished projecting an output, while the idle timer was
 * reset afterwards, so the watchdog deterministically won the race and logged
 * a false timeout for otherwise healthy conversations.
 */
export function resolveRunnerLivenessTimeouts(input: {
  executionTimeoutMs: number;
  idleTimeoutMs: number;
  shutdownGraceMs?: number;
}): RunnerLivenessTimeouts {
  const executionTimeoutMs = Math.max(1, Math.floor(input.executionTimeoutMs));
  const idleTimeoutMs = Math.max(1, Math.floor(input.idleTimeoutMs));
  const shutdownGraceMs = Math.max(
    1,
    Math.floor(input.shutdownGraceMs ?? RUNNER_SHUTDOWN_GRACE_MS),
  );
  const idleCloseMs = Math.min(executionTimeoutMs, idleTimeoutMs);
  return {
    idleCloseMs,
    watchdogMs: Math.max(executionTimeoutMs, idleCloseMs) + shutdownGraceMs,
  };
}
