import { describe, expect, test } from 'vitest';

import {
  RUNNER_SHUTDOWN_GRACE_MS,
  resolveRunnerLivenessTimeouts,
} from '../src/runner-liveness.js';

describe('runner liveness timeout ordering', () => {
  test('puts the watchdog strictly after equal default idle and execution timeouts', () => {
    expect(
      resolveRunnerLivenessTimeouts({
        executionTimeoutMs: 1_800_000,
        idleTimeoutMs: 1_800_000,
      }),
    ).toEqual({
      idleCloseMs: 1_800_000,
      watchdogMs: 1_800_000 + RUNNER_SHUTDOWN_GRACE_MS,
    });
  });

  test('shortens warm retention when a workspace execution timeout is lower', () => {
    expect(
      resolveRunnerLivenessTimeouts({
        executionTimeoutMs: 300_000,
        idleTimeoutMs: 1_800_000,
      }),
    ).toEqual({
      idleCloseMs: 300_000,
      watchdogMs: 300_000 + RUNNER_SHUTDOWN_GRACE_MS,
    });
  });

  test('preserves a shorter configured idle timeout and the longer execution budget', () => {
    expect(
      resolveRunnerLivenessTimeouts({
        executionTimeoutMs: 1_800_000,
        idleTimeoutMs: 120_000,
        shutdownGraceMs: 5_000,
      }),
    ).toEqual({
      idleCloseMs: 120_000,
      watchdogMs: 1_805_000,
    });
  });
});
