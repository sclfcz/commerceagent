import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  loadClaudeContextMcpServers,
  mergeMcpServerLayers,
  readMcpServersFile,
} from '../src/mcp-context.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commerceagent-mcp-context-'));
  roots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Claude context MCP layering', () => {
  test('invalid files are ignored instead of breaking Agent startup', () => {
    const root = tempRoot();
    const file = path.join(root, 'settings.json');
    fs.writeFileSync(file, '{broken');
    expect(readMcpServersFile(file)).toEqual({});
  });

  test('project-local declarations override project and authorized host context', () => {
    const root = tempRoot();
    const externalClaudeDir = path.join(root, '.claude');
    const workspaceDir = path.join(root, 'workspace');

    writeJson(path.join(externalClaudeDir, 'settings.json'), {
      mcpServers: {
        hostSettings: { command: 'host-settings' },
        shared: { command: 'host-settings-shared' },
      },
    });
    writeJson(path.join(root, '.claude.json'), {
      mcpServers: {
        hostGlobal: { command: 'host-global' },
        shared: { command: 'host-global-shared' },
      },
    });
    writeJson(path.join(workspaceDir, '.mcp.json'), {
      mcpServers: {
        project: { command: 'project' },
        shared: { command: 'project-shared' },
      },
    });
    writeJson(path.join(workspaceDir, '.claude', 'settings.local.json'), {
      mcpServers: { shared: { command: 'project-local-shared' } },
    });

    expect(
      loadClaudeContextMcpServers({
        workspaceDir,
        externalClaudeDir,
        includeHostClaudeContext: true,
      }),
    ).toEqual({
      hostSettings: { command: 'host-settings' },
      hostGlobal: { command: 'host-global' },
      project: { command: 'project' },
      shared: { command: 'project-local-shared' },
    });
  });

  test('container-only context never reads host MCP', () => {
    const root = tempRoot();
    const externalClaudeDir = path.join(root, '.claude');
    const workspaceDir = path.join(root, 'workspace');
    writeJson(path.join(root, '.claude.json'), {
      mcpServers: { secretHost: { command: 'secret' } },
    });
    writeJson(path.join(workspaceDir, '.mcp.json'), {
      mcpServers: { project: { command: 'project' } },
    });

    expect(
      loadClaudeContextMcpServers({
        workspaceDir,
        externalClaudeDir,
        includeHostClaudeContext: false,
      }),
    ).toEqual({ project: { command: 'project' } });
  });

  test('CommerceAgent-managed MCP is additive and wins deterministic name collisions', () => {
    expect(
      mergeMcpServerLayers(
        {
          project: { command: 'project' },
          shared: { command: 'project-shared' },
        },
        {
          managed: { command: 'managed' },
          shared: { command: 'managed-shared' },
        },
      ),
    ).toEqual({
      project: { command: 'project' },
      managed: { command: 'managed' },
      shared: { command: 'managed-shared' },
    });
  });
});
