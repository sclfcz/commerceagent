import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  findClaudeMdExcludeLeaks,
  resolveManagedHostClaudeMdExcludes,
} from '../container/agent-runner/src/claude-memory-policy.js';

describe('managed host Claude memory policy', () => {
  test('excludes OS-home and configured host instructions in managed mode', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'managed' } },
        homeDir: '/Users/operator',
        externalClaudeDir: '/Volumes/config/claude',
        projectRoot: '/Users/operator/airepo/commerceagent',
      }),
    ).toEqual([
      path.join('/Users/operator/.claude', 'CLAUDE.md'),
      path.join('/Users/operator/.claude', 'rules', '**'),
      path.join('/Volumes/config/claude', 'CLAUDE.md'),
      path.join('/Volumes/config/claude', 'rules', '**'),
      path.join('/Users/operator/airepo/commerceagent', 'CLAUDE.md'),
      path.join('/Users/operator/airepo/commerceagent', '.claude', 'CLAUDE.md'),
      path.join('/Users/operator/airepo/commerceagent', 'CLAUDE.local.md'),
      path.join('/Users/operator/airepo/commerceagent', '.claude', 'rules', '**'),
    ]);
  });

  test('keeps workspace-local memory while excluding only platform project memory', () => {
    const groupWorkspace =
      '/Users/operator/airepo/commerceagent/data/groups/address-agent';
    const excludes = resolveManagedHostClaudeMdExcludes({
      executionMode: 'host',
      runtimePolicy: { context: { source: 'managed' } },
      homeDir: '/Users/operator',
      projectRoot: '/Users/operator/airepo/commerceagent',
    });

    expect(excludes).not.toContain(path.join(groupWorkspace, 'CLAUDE.md'));
    expect(excludes).toContain(
      path.join('/Users/operator/airepo/commerceagent', 'CLAUDE.md'),
    );
  });

  test('treats a missing legacy context source as managed and deduplicates roots', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: {},
        homeDir: '/Users/operator',
        externalClaudeDir: '/Users/operator/.claude',
      }),
    ).toEqual([
      path.join('/Users/operator/.claude', 'CLAUDE.md'),
      path.join('/Users/operator/.claude', 'rules', '**'),
    ]);
  });

  test('preserves explicitly enabled host context and ignores container runs', () => {
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'host',
        runtimePolicy: { context: { source: 'host_claude' } },
        homeDir: '/Users/operator',
      }),
    ).toEqual([]);
    expect(
      resolveManagedHostClaudeMdExcludes({
        executionMode: 'container',
        runtimePolicy: { context: { source: 'managed' } },
        homeDir: '/home/node',
      }),
    ).toEqual([]);
  });

  test('detects an SDK memory file that escaped the applied exclusions', () => {
    expect(
      findClaudeMdExcludeLeaks(
        [
          { path: '/repo/CLAUDE.md' },
          { path: '/repo/.claude/rules/runtime.md' },
          { path: '/repo/data/groups/address/CLAUDE.md' },
        ],
        ['/repo/CLAUDE.md', path.join('/repo/.claude/rules', '**')],
      ),
    ).toEqual([
      path.normalize('/repo/CLAUDE.md'),
      path.normalize('/repo/.claude/rules/runtime.md'),
    ]);
  });

  test('emits portable picomatch patterns for Windows host paths', () => {
    const excludes = resolveManagedHostClaudeMdExcludes({
      executionMode: 'host',
      runtimePolicy: { context: { source: 'managed' } },
      homeDir: 'C:\\Users\\operator',
      externalClaudeDir: 'D:\\Claude',
      projectRoot: 'C:\\code\\commerceagent',
    });

    expect(excludes).toContain('C:/Users/operator/.claude/CLAUDE.md');
    expect(excludes).toContain('D:/Claude/rules/**');
    expect(excludes).toContain('C:/code/commerceagent/.claude/rules/**');
    expect(excludes.every((entry) => !entry.includes('\\'))).toBe(true);
    expect(
      findClaudeMdExcludeLeaks(
        [{ path: 'C:\\code\\commerceagent\\.claude\\rules\\agent.md' }],
        excludes,
      ),
    ).toEqual(['C:/code/commerceagent/.claude/rules/agent.md']);
  });
});
