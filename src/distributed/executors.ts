/**
 * Executors contain the actual business work. The worker owns leasing,
 * heartbeat and lifecycle; an executor only has to honour the AbortSignal.
 */
export interface ExecutorRunContext {
  runId: string;
  tenantId: string;
  taskId: string;
  /** 1-based attempt number assigned by the claim. */
  attempt: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  workerId: string;
  /** Aborted when the lease is lost, the run is cancelled, or the worker stops. */
  signal: AbortSignal;
}

export interface Executor {
  execute(context: ExecutorRunContext): Promise<unknown>;
}

/** Thrown by an executor when the same run may succeed on a later attempt. */
export class RetryableError extends Error {
  constructor(message = 'retryable executor failure') {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Thrown internally when work is interrupted by an AbortSignal. */
export class ExecutorAbortedError extends Error {
  constructor(message = 'executor aborted') {
    super(message);
    this.name = 'ExecutorAbortedError';
  }
}

const MAX_SLEEP_MS = 3_600_000;

function readCount(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Sleep that rejects as soon as the signal aborts, so stop() stays responsive. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ExecutorAbortedError());
  const bounded = Number.isFinite(ms)
    ? Math.min(Math.max(ms, 0), MAX_SLEEP_MS)
    : 0;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ExecutorAbortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, bounded);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Test/chaos executor: sleeps for `payload.sleepMs` and fails the first
 * `payload.failTimes` attempts with a RetryableError.
 */
export class SleepExecutor implements Executor {
  async execute(context: ExecutorRunContext): Promise<unknown> {
    const payload = context.payload ?? {};
    const sleepMs = readCount(payload.sleepMs, 0);
    await abortableSleep(sleepMs, context.signal);
    const failTimes = readCount(payload.failTimes, 0);
    if (failTimes > 0 && context.attempt <= failTimes)
      throw new RetryableError(
        `synthetic failure on attempt ${context.attempt}/${failTimes}`,
      );
    return { workerId: context.workerId, attempt: context.attempt };
  }
}
