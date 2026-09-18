import { createHash } from 'node:crypto';

import type { ClaudeContextAudit } from './stream-event.types.js';

const MAX_SNAPSHOTS = 500;

export interface RunContextSnapshot {
  chatJid: string;
  agentId: string | null;
  turnId: string | null;
  sessionId: string | null;
  capturedAt: string;
  executionMode: ClaudeContextAudit['executionMode'];
  agentProfile: {
    id: string;
    version: number;
    identityHash: string;
    runtimePolicyHash: string | null;
  } | null;
  prompt: {
    planHash: string | null;
    totalBytes: number;
    estimatedTokens: number | null;
    blocks: Array<{
      id: string;
      version: number | null;
      scope: 'main' | 'subagent' | 'both' | null;
      owner: 'platform' | 'agent_profile' | 'workspace' | 'channel' | null;
      required: boolean | null;
      condition: string | null;
      hash: string | null;
      bytes: number;
      estimatedTokens: number | null;
    }>;
  };
  skills: {
    manifestHash: string | null;
    selectedSkillIds: string[];
    total: number | null;
    included: number | null;
    tokens: number | null;
    sources: Array<{
      name: string;
      count: number | null;
      tokens: number | null;
    }>;
  };
  mcp: { manifestHash: string | null; serverIds: string[] };
  rules: { discovered: number; loaded: number | null };
  claudeMd: { status: string; loaded: boolean | null; tokens: number | null };
  sdkContext: {
    model: string;
    totalTokens: number;
    maxTokens: number;
    percentage: number;
    mcpTools: Array<{ name: string; serverName: string; tokens: number }>;
  } | null;
  budget: ClaudeContextAudit['contextBudget'] | null;
  subagentContract: ClaudeContextAudit['subagentContract'] | null;
  warnings: string[];
}

export type RunContextStatus =
  | 'none'
  | 'current'
  | 'stale_profile'
  | 'stale_config';

const snapshots = new Map<string, RunContextSnapshot>();

function snapshotKey(chatJid: string, agentId?: string): string {
  return `${chatJid}\0${agentId ?? 'main'}`;
}

function nullableNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function hashRuntimePolicy(policy: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(policy ?? null), 'utf8')
    .digest('hex');
}

/**
 * Retain the latest real SDK context observation without retaining prompt text,
 * MCP configuration, or filesystem paths. The sanitized shape is safe to use
 * in authenticated explainability APIs and remains useful after the stream has
 * completed.
 */
export function recordRunContextSnapshot(input: {
  chatJid: string;
  agentId?: string;
  turnId?: string;
  sessionId?: string;
  audit: ClaudeContextAudit;
  capturedAt?: Date;
}): RunContextSnapshot {
  const { audit } = input;
  const usage = audit.sdkContextUsage;
  const snapshot: RunContextSnapshot = {
    chatJid: input.chatJid,
    agentId: input.agentId ?? null,
    turnId: input.turnId ?? null,
    sessionId: input.sessionId ?? null,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    executionMode: audit.executionMode,
    agentProfile: audit.agentProfile
      ? {
          id: audit.agentProfile.id,
          version: audit.agentProfile.version,
          identityHash: audit.agentProfile.identityHash,
          runtimePolicyHash: audit.agentProfile.runtimePolicyHash ?? null,
        }
      : null,
    prompt: {
      planHash: audit.commerceagentPrompt.planHash ?? null,
      totalBytes: audit.commerceagentPrompt.totalBytes,
      estimatedTokens: nullableNumber(audit.commerceagentPrompt.estimatedTokens),
      blocks: audit.commerceagentPrompt.files.map((block) => ({
        id: block.id ?? block.name,
        version: nullableNumber(block.version),
        scope: block.scope ?? null,
        owner: block.owner ?? null,
        required: typeof block.required === 'boolean' ? block.required : null,
        condition: block.condition ?? null,
        hash: block.hash ?? null,
        bytes: block.bytes,
        estimatedTokens: nullableNumber(block.estimatedTokens),
      })),
    },
    skills: {
      manifestHash: audit.skills.manifestHash ?? null,
      selectedSkillIds: [...(audit.skills.selectedSkillIds ?? [])],
      total: nullableNumber(audit.skills.totalSkills),
      included: nullableNumber(audit.skills.includedSkills),
      tokens: nullableNumber(audit.skills.tokens),
      sources: audit.skills.sources.map((source) => ({
        name: source.name,
        count: nullableNumber(source.count),
        tokens: nullableNumber(source.tokens),
      })),
    },
    mcp: {
      manifestHash: audit.mcp?.manifestHash ?? null,
      serverIds: [...(audit.mcp?.serverIds ?? [])],
    },
    rules: {
      discovered: audit.rules.fileCount,
      loaded: nullableNumber(audit.rules.loadedFileCount),
    },
    claudeMd: {
      status: audit.claudeMd.status,
      loaded:
        typeof audit.claudeMd.loaded === 'boolean'
          ? audit.claudeMd.loaded
          : null,
      tokens: nullableNumber(audit.claudeMd.tokens),
    },
    sdkContext: usage
      ? {
          model: usage.model,
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          mcpTools: usage.mcpTools.map((tool) => ({
            name: tool.name,
            serverName: tool.serverName,
            tokens: tool.tokens,
          })),
        }
      : null,
    budget: audit.contextBudget ?? null,
    subagentContract: audit.subagentContract ?? null,
    warnings: [...audit.warnings],
  };

  const key = snapshotKey(input.chatJid, input.agentId);
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    snapshots.delete(oldest);
  }
  return snapshot;
}

export function getRunContextSnapshot(
  chatJid: string,
  agentId?: string,
): RunContextSnapshot | null {
  return snapshots.get(snapshotKey(chatJid, agentId)) ?? null;
}

/**
 * Attribute a real run only when both the persisted Agent identity and the
 * effective Skill manifest match the configuration currently being previewed.
 */
export function classifyRunContextSnapshot(
  snapshot: RunContextSnapshot | null,
  expected: {
    agentProfile: {
      id: string;
      version: number;
      identityHash: string;
      runtimePolicyHash: string;
    };
    skillManifestHash: string;
    mcpManifestHash: string;
  },
): RunContextStatus {
  if (!snapshot) return 'none';
  const actualProfile = snapshot.agentProfile;
  if (
    !actualProfile ||
    actualProfile.id !== expected.agentProfile.id ||
    actualProfile.version !== expected.agentProfile.version ||
    actualProfile.identityHash !== expected.agentProfile.identityHash
  ) {
    return 'stale_profile';
  }
  if (snapshot.skills.manifestHash !== expected.skillManifestHash) {
    return 'stale_config';
  }
  if (
    actualProfile.runtimePolicyHash !== expected.agentProfile.runtimePolicyHash
  ) {
    return 'stale_config';
  }
  if (snapshot.mcp.manifestHash !== expected.mcpManifestHash) {
    return 'stale_config';
  }
  return 'current';
}

export function clearRunContextSnapshots(): void {
  snapshots.clear();
}
