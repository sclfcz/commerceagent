import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const WRITE_TOOLS = new Set([
  'mcp__commerceagent__workspace_memory_remember',
  'mcp__commerceagent__workspace_memory_update',
  'mcp__commerceagent__workspace_memory_forget',
]);
const OWNER_PROFILE_TOOLS = new Set([
  'mcp__commerceagent__commerceagent_owner_profile',
]);

/** Sub-agents inherit the MCP server, so enforce read-only access in a hook. */
export function createWorkspaceMemoryWriteGuard(): HookCallback {
  return async (input) => {
    const preTool = input as PreToolUseHookInput;
    if (
      preTool.hook_event_name === 'PreToolUse' &&
      preTool.agent_id &&
      (WRITE_TOOLS.has(preTool.tool_name) ||
        OWNER_PROFILE_TOOLS.has(preTool.tool_name))
    ) {
      const ownerProfile = OWNER_PROFILE_TOOLS.has(preTool.tool_name);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: ownerProfile
            ? 'Owner Profile is private to the actual owner’s top-level CommerceAgent turn and is unavailable to sub-agents.'
            : 'Sub-agents have read-only Workspace Memory access. Return proposed learnings to the top-level session.',
        },
      };
    }
    return {};
  };
}
