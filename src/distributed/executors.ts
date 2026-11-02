import { HttpEffectProvider } from './http-effect-provider.js';
import {
  EffectPermanentError,
  type EffectProvider,
  type RunContext,
} from './durable.js';

/**
 * Executors contain the actual business work. The worker owns leasing,
 * heartbeat and lifecycle; an executor only has to honour the AbortSignal and
 * route replayable work through the RunContext.
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
  /** Dispatch lease token; needed to settle the dist envelope. */
  leaseToken: number;
  /** Aborted when the lease is lost, the run is cancelled, or the worker stops. */
  signal: AbortSignal;
}

export interface Executor {
  execute(context: ExecutorRunContext, ctx: RunContext): Promise<unknown>;
}

export { ExecutorAbortedError, RetryableError } from './errors.js';
import { ExecutorAbortedError, RetryableError } from './errors.js';

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
  async execute(
    context: ExecutorRunContext,
    _ctx: RunContext,
  ): Promise<unknown> {
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

export interface EffectDemoPayload {
  steps?: number;
  stepSleepMs?: number;
  effectUrl?: string;
  /** 'durable' checkpoints every step; 'naive' re-sends on every attempt. */
  mode?: 'durable' | 'naive';
  lookup?: boolean;
}

/**
 * Benchmark executor for the durable-step protocol (used by dist:chaos:effects).
 * Flow: step, effect, step, effect, step — the same shape the chaos asserts on.
 *
 * `mode: 'naive'` deliberately skips the checkpoint/effect ledger so a retry
 * re-sends both messages; it is the control group for duplicate delivery.
 */
export class EffectDemoExecutor implements Executor {
  constructor(
    private readonly providerFactory: (
      baseUrl: string,
      supportsLookup: boolean,
    ) => EffectProvider = (baseUrl, supportsLookup) =>
      new HttpEffectProvider({ baseUrl, supportsLookup }),
  ) {}

  async execute(
    context: ExecutorRunContext,
    ctx: RunContext,
  ): Promise<unknown> {
    const payload = (context.payload ?? {}) as EffectDemoPayload;
    const steps = Math.max(1, Number(payload.steps ?? 3));
    const stepSleepMs = Math.max(0, Number(payload.stepSleepMs ?? 120));
    const mode = payload.mode === 'naive' ? 'naive' : 'durable';
    const baseUrl = String(payload.effectUrl ?? '');
    if (!baseUrl) throw new Error('effect_url_missing');
    const provider = this.providerFactory(baseUrl, payload.lookup !== false);

    for (let index = 0; index < steps; index++) {
      if (mode === 'naive') {
        await abortableSleep(stepSleepMs, context.signal);
      } else {
        await ctx.step(`step-${index}`, async () => {
          await abortableSleep(stepSleepMs, context.signal);
          return { index, at: Date.now() };
        });
      }
      if (index < 2) {
        const request = {
          runId: context.runId,
          stepKey: `msg-${index}`,
          body: `hello-${index}`,
        };
        if (mode === 'naive') {
          // No ledger: every attempt sends again under the *same* key. If the
          // provider ignores idempotency keys (the chaos mock does), that is a
          // real duplicate delivery - which is exactly the control group.
          try {
            await provider.send(
              request,
              `${context.runId}:msg-${index}`,
              context.signal,
            );
          } catch (error) {
            if (error instanceof EffectPermanentError) throw error;
            throw new RetryableError(
              `naive_effect_failed:${index}:${
                error instanceof Error ? error.message.slice(0, 200) : 'unknown'
              }`,
            );
          }
        } else {
          await ctx.effect(`msg-${index}`, request, provider);
        }
      }
    }
    return { ok: true, attempt: context.attempt, mode };
  }
}
