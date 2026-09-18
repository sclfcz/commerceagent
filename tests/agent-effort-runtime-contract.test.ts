import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Agent effort runtime contracts', () => {
  test('normal conversations and isolated scheduled tasks forward runtime policy', () => {
    const main = read('src/index.ts');
    const scheduler = read('src/task-scheduler.ts');

    expect(main).toMatch(
      /function toContainerAgentProfile[\s\S]*runtimePolicy: profile\.runtime_policy/,
    );
    expect(scheduler).toMatch(
      /function toRunnerAgentProfile[\s\S]*runtimePolicy: profile\.runtime_policy/,
    );
  });

  test('host and container starts remove Provider effort only for explicit Agents', () => {
    const host = read('src/container-runner.ts');
    const calls = host.match(
      /removeProviderEffortEnv\(envLines, agentEffort\)/g,
    );
    expect(calls).toHaveLength(2);
  });

  test('runner passes the resolved value through the supported SDK option', () => {
    const runner = read('container/agent-runner/src/index.ts');
    expect(runner).toContain('...(agentEffort ? { effort: agentEffort } : {})');
  });
});
