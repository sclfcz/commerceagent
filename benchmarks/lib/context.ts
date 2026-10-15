import { createHash } from 'node:crypto';
import {
  buildAgentIdentityPrompt,
  type IdentityProfile,
} from '../../container/agent-runner/src/agent-identity-prompt.js';
import { hash } from './contracts.js';

export interface ContextEvidence {
  executionMode: string;
  turnId: string | null;
  agentId: string | null;
  agentProfile: {
    id: string;
    version: number;
    identityHash: string;
    runtimePolicyHash: string | null;
  } | null;
  skills: { manifestHash: string | null; selectedSkillIds: string[] };
  mcp: { manifestHash: string | null; serverIds: string[] };
  prompt: {
    blocks: Array<{ id: string; hash: string | null; owner: string | null }>;
  };
  warnings: string[];
}

// Validate the exact loaded block before normalizing only the fresh Profile UUID.
export function profilePromptHashes(
  profile: IdentityProfile,
  includePreset: boolean,
) {
  const digest = (text: string) =>
    createHash('sha256').update(text.trim()).digest('hex');
  return {
    renderedProfileHash: digest(
      buildAgentIdentityPrompt(profile, includePreset) ?? '',
    ),
    canonicalProfileHash: digest(
      buildAgentIdentityPrompt(
        { ...profile, id: 'eval-profile' },
        includePreset,
      ) ?? '',
    ),
  };
}

export function verifyContext(
  actual: ContextEvidence | null,
  expected: {
    renderedProfileHash: string;
    canonicalProfileHash: string;
    profileId: string;
    version: number;
    identityHash: string;
    runtimePolicyHash: string;
    skillsHash: string;
    mcpHash: string;
    sessionId: string;
    turnId: string | null;
  },
) {
  const promptBlocks =
    actual?.prompt.blocks.filter(
      (block) => block.owner === 'agent_profile' || block.owner === 'platform',
    ) ?? [];
  const verified =
    !!actual &&
    actual.executionMode === 'container' &&
    actual.agentId === expected.sessionId &&
    !!expected.turnId &&
    actual.turnId === expected.turnId &&
    actual.agentProfile?.id === expected.profileId &&
    actual.agentProfile.version === expected.version &&
    actual.agentProfile.identityHash === expected.identityHash &&
    actual.agentProfile.runtimePolicyHash === expected.runtimePolicyHash &&
    actual.skills.manifestHash === expected.skillsHash &&
    actual.mcp.manifestHash === expected.mcpHash &&
    actual.skills.selectedSkillIds.length === 0 &&
    actual.mcp.serverIds.length === 1 &&
    /^(user:)?commerce_fixture$/.test(actual.mcp.serverIds[0]) &&
    promptBlocks.filter((block) => block.id === 'agent-profile').length === 1 &&
    promptBlocks.find((block) => block.id === 'agent-profile')?.hash ===
      expected.renderedProfileHash &&
    promptBlocks.length > 0 &&
    promptBlocks.every((block) => !!block.hash);
  return {
    verified,
    observedPromptHashes: promptBlocks,
    fingerprint: verified
      ? {
          version: actual.agentProfile!.version,
          identityHash: actual.agentProfile!.identityHash,
          skillsHash: actual.skills.manifestHash,
          mcpHash: actual.mcp.manifestHash,
          // Only the validated agent-identity wrapper Profile UUID is variable.
          runtimePolicyHash: actual.agentProfile!.runtimePolicyHash,
          promptContentHash: hash(
            promptBlocks.map((block) => ({
              id: block.id,
              hash:
                block.id === 'agent-profile'
                  ? expected.canonicalProfileHash
                  : block.hash,
            })),
          ),
        }
      : null,
  };
}
