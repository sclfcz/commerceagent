// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentGovernanceSection } from '../web/src/components/agents/AgentGovernanceSection';
import type { AgentProfile, AgentProfileGovernance } from '../web/src/types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseProfile = {
  id: 'custom-agent',
  owner_user_id: 'owner',
  name: 'Custom Agent',
  identity_prompt: '',
  soul_prompt: '',
  agents_prompt: '',
  tools_prompt: '',
  prompt_mode: 'append',
  include_claude_preset: true,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  runtime_policy: {
    context: {
      source: 'managed',
      auto_compact_window: 0,
      auto_compact_percentage: 0,
    },
    skills: { mode: 'inherit', ids: [] },
    mcp: { mode: 'inherit', ids: [] },
  },
  identity_hash: 'hash',
  version: 1,
  is_default: false,
  status: 'active',
  created_at: '2026-07-28T00:00:00.000Z',
  updated_at: '2026-07-28T00:00:00.000Z',
} as AgentProfile;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(
  selected: AgentProfile,
  governance: AgentProfileGovernance,
): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AgentGovernanceSection
        selected={selected}
        profiles={[selected]}
        governance={governance}
        busy={false}
        workspaceMoveTargets={{}}
        movingWorkspaceJid={null}
        onRefresh={vi.fn()}
        onMoveTargetChange={vi.fn()}
        onMoveWorkspace={vi.fn()}
      />,
    );
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('Agent governance isolation UI', () => {
  test('explains that a new custom Agent has no Workspace, Session, or Memory', async () => {
    await render(baseProfile, {
      profile: baseProfile,
      workspaces: [],
      channel_mounts: [],
    });

    expect(container?.textContent).toContain('尚未绑定工作区');
    expect(container?.textContent).toContain('没有 Session 或 Memory');
    expect(container?.textContent).toContain('非 Home 工作区');
  });

  test('shows Home as fixed to CommerceAgent and offers no migration control', async () => {
    const commerceAgent = {
      ...baseProfile,
      id: 'commerceagent',
      name: 'CommerceAgent',
      is_default: true,
    };
    await render(commerceAgent, {
      profile: commerceAgent,
      workspaces: [
        {
          jid: 'web:main',
          name: 'Home',
          folder: 'main',
          is_home: true,
          execution_mode: 'host',
          added_at: '2026-07-28T00:00:00.000Z',
          runtime_sessions: [],
        },
      ],
      channel_mounts: [],
    });

    expect(container?.textContent).toContain('Home · 固定归属 CommerceAgent');
    expect(
      container?.querySelector('[aria-label="迁移工作区 Home"]'),
    ).toBeNull();
  });
});
