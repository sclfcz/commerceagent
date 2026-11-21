import { describe, expect, test } from 'vitest';
import { isAgentRunnerContainerName } from '../src/container-runner.js';

describe('isAgentRunnerContainerName', () => {
  test('matches the runner naming scheme', () => {
    expect(isAgentRunnerContainerName('commerceagent-main-1794882000000')).toBe(
      true,
    );
    expect(
      isAgentRunnerContainerName(
        'commerceagent-my-group-0f1e2d3c-4b5a-1794882000000',
      ),
    ).toBe(true);
  });

  test('ignores the distributed test stack services', () => {
    // docker-compose.distributed.yml — startup cleanup must not stop these.
    expect(isAgentRunnerContainerName('commerceagent-dist-postgres')).toBe(
      false,
    );
    expect(isAgentRunnerContainerName('commerceagent-dist-mysql')).toBe(false);
    expect(isAgentRunnerContainerName('commerceagent-dist-rabbit')).toBe(false);
    expect(isAgentRunnerContainerName('commerceagent-dist-redis')).toBe(false);
  });

  test('ignores unrelated and malformed names', () => {
    expect(isAgentRunnerContainerName('commerceagent-')).toBe(false);
    expect(isAgentRunnerContainerName('commerceagent-main')).toBe(false);
    expect(isAgentRunnerContainerName('commerceagent-main-123')).toBe(false);
    expect(isAgentRunnerContainerName('other-main-1794882000000')).toBe(false);
  });
});
