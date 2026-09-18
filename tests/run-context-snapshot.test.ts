import { afterEach, describe, expect, test } from 'vitest';
import {
  clearRunContextSnapshots,
  classifyRunContextSnapshot,
  getRunContextSnapshot,
  hashRuntimePolicy,
  recordRunContextSnapshot,
} from '../src/run-context-snapshot.js';

afterEach(() => clearRunContextSnapshots());

describe('run context explainability snapshot', () => {
  test('keeps budget and provenance while stripping prompt text and host paths', () => {
    recordRunContextSnapshot({
      chatJid: 'web:research',
      turnId: 'turn-1',
      sessionId: 'session-1',
      capturedAt: new Date('2026-07-21T03:00:00.000Z'),
      audit: {
        executionMode: 'host',
        agentProfile: {
          id: 'profile-a',
          version: 3,
          identityHash: 'identity-a',
          runtimePolicyHash: hashRuntimePolicy({ mcp: { mode: 'inherit' } }),
        },
        cwd: '/secret/workspace',
        claudeConfigDir: '/secret/.claude',
        claudeMd: {
          sourcePath: '/secret/.claude/CLAUDE.md',
          runtimePath: '/runtime/CLAUDE.md',
          status: 'linked',
          loaded: true,
          tokens: 120,
        },
        rules: {
          sourcePath: '/secret/.claude/rules',
          runtimePath: '/runtime/rules',
          status: 'linked',
          fileCount: 2,
          loadedFileCount: 2,
          loadedFiles: [
            { path: '/secret/.claude/rules/private.md', tokens: 8 },
          ],
        },
        skills: {
          manifestHash: 'skills-a',
          selectedSkillIds: ['alpha', 'beta'],
          totalSkills: 5,
          includedSkills: 3,
          tokens: 420,
          sources: [
            {
              name: 'user',
              sourcePath: '/secret/.claude/skills',
              runtimePath: '/runtime/skills',
              count: 3,
              tokens: 420,
            },
          ],
        },
        mcp: { manifestHash: 'mcp-a', serverIds: ['search'] },
        commerceagentPrompt: {
          totalBytes: 800,
          estimatedTokens: 200,
          planHash: 'plan-hash',
          files: [
            {
              name: 'interaction',
              id: 'interaction',
              version: 1,
              scope: 'main',
              owner: 'platform',
              required: true,
              hash: 'block-hash',
              bytes: 800,
              estimatedTokens: 200,
            },
          ],
        },
        sdkContextUsage: {
          categories: [],
          totalTokens: 14_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 7,
          gridRows: [],
          model: 'claude-test',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
        contextBudget: {
          status: 'ok',
          totalTokens: 14_000,
          maxTokens: 200_000,
          warningThreshold: 50_000,
          hardThreshold: 80_000,
        },
        subagentContract: {
          enabled: true,
          hash: 'contract-hash',
          sdkCompatibility: 'sdk-test',
          cliCompatibility: 'cli-test',
        },
        warnings: [],
      },
    });

    const snapshot = getRunContextSnapshot('web:research');
    expect(snapshot).toMatchObject({
      turnId: 'turn-1',
      agentProfile: {
        id: 'profile-a',
        version: 3,
        identityHash: 'identity-a',
        runtimePolicyHash: hashRuntimePolicy({ mcp: { mode: 'inherit' } }),
      },
      prompt: {
        planHash: 'plan-hash',
        estimatedTokens: 200,
        blocks: [
          expect.objectContaining({
            id: 'interaction',
            owner: 'platform',
            hash: 'block-hash',
          }),
        ],
      },
      sdkContext: { totalTokens: 14_000, maxTokens: 200_000 },
      budget: { status: 'ok', hardThreshold: 80_000 },
      subagentContract: { enabled: true, hash: 'contract-hash' },
      skills: {
        manifestHash: 'skills-a',
        selectedSkillIds: ['alpha', 'beta'],
      },
      mcp: { manifestHash: 'mcp-a', serverIds: ['search'] },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('/secret/');
    expect(serialized).not.toContain('/runtime/');
    expect(serialized).not.toContain('prompt text');
  });

  test('keeps main and conversation-Agent observations independently', () => {
    const baseAudit = {
      executionMode: 'container' as const,
      claudeMd: { status: 'missing' as const },
      rules: { status: 'missing' as const, fileCount: 0 },
      skills: { sources: [] },
      commerceagentPrompt: { totalBytes: 0, files: [] },
      warnings: [],
    };
    recordRunContextSnapshot({ chatJid: 'web:a', audit: baseAudit });
    recordRunContextSnapshot({
      chatJid: 'web:a',
      agentId: 'reviewer',
      audit: baseAudit,
    });

    expect(getRunContextSnapshot('web:a')?.agentId).toBeNull();
    expect(getRunContextSnapshot('web:a', 'reviewer')?.agentId).toBe(
      'reviewer',
    );
  });

  test('does not attribute an Agent A run to Agent B or a changed manifest', () => {
    const snapshot = recordRunContextSnapshot({
      chatJid: 'web:migrated',
      audit: {
        executionMode: 'container',
        agentProfile: {
          id: 'agent-a',
          version: 2,
          identityHash: 'hash-a',
          runtimePolicyHash: hashRuntimePolicy({
            mcp: { mode: 'custom', ids: ['mcp-a'] },
          }),
        },
        claudeMd: { status: 'missing' },
        rules: { status: 'missing', fileCount: 0 },
        skills: {
          manifestHash: 'manifest-a',
          selectedSkillIds: ['skill-a'],
          sources: [],
        },
        mcp: { manifestHash: 'mcp-manifest-a', serverIds: ['mcp-a'] },
        commerceagentPrompt: { totalBytes: 0, files: [] },
        warnings: [],
      },
    });

    expect(
      classifyRunContextSnapshot(snapshot, {
        agentProfile: {
          id: 'agent-b',
          version: 1,
          identityHash: 'hash-b',
          runtimePolicyHash: hashRuntimePolicy({}),
        },
        skillManifestHash: 'manifest-b',
        mcpManifestHash: 'mcp-manifest-b',
      }),
    ).toBe('stale_profile');
    expect(
      classifyRunContextSnapshot(snapshot, {
        agentProfile: {
          id: 'agent-a',
          version: 2,
          identityHash: 'hash-a',
          runtimePolicyHash: hashRuntimePolicy({
            mcp: { mode: 'custom', ids: ['mcp-a'] },
          }),
        },
        skillManifestHash: 'manifest-b',
        mcpManifestHash: 'mcp-manifest-a',
      }),
    ).toBe('stale_config');
    expect(
      classifyRunContextSnapshot(snapshot, {
        agentProfile: {
          id: 'agent-a',
          version: 2,
          identityHash: 'hash-a',
          runtimePolicyHash: hashRuntimePolicy({
            mcp: { mode: 'custom', ids: ['mcp-a'] },
          }),
        },
        skillManifestHash: 'manifest-a',
        mcpManifestHash: 'mcp-manifest-a',
      }),
    ).toBe('current');

    expect(
      classifyRunContextSnapshot(snapshot, {
        agentProfile: {
          id: 'agent-a',
          version: 2,
          identityHash: 'hash-a',
          runtimePolicyHash: hashRuntimePolicy({
            mcp: { mode: 'custom', ids: ['mcp-b'] },
          }),
        },
        skillManifestHash: 'manifest-a',
        mcpManifestHash: 'mcp-manifest-a',
      }),
    ).toBe('stale_config');

    expect(
      classifyRunContextSnapshot(snapshot, {
        agentProfile: {
          id: 'agent-a',
          version: 2,
          identityHash: 'hash-a',
          runtimePolicyHash: hashRuntimePolicy({
            mcp: { mode: 'custom', ids: ['mcp-a'] },
          }),
        },
        skillManifestHash: 'manifest-a',
        mcpManifestHash: 'mcp-manifest-b',
      }),
    ).toBe('stale_config');
  });
});
