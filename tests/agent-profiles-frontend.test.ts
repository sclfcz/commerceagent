import { beforeEach, describe, expect, test, vi } from 'vitest';

const storeDeps = vi.hoisted(() => ({
  loadChatGroups: vi.fn(async () => undefined),
  loadGroups: vi.fn(async () => undefined),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiFetch: vi.fn(),
}));
vi.mock('../web/src/stores/chat', () => ({
  useChatStore: {
    getState: () => ({ loadGroups: storeDeps.loadChatGroups }),
    setState: vi.fn(),
  },
}));
vi.mock('../web/src/stores/groups', () => ({
  useGroupsStore: {
    getState: () => ({ loadGroups: storeDeps.loadGroups }),
    setState: vi.fn(),
  },
}));

import { api } from '../web/src/api/client';
import { useAgentProfilesStore } from '../web/src/stores/agent-profiles';
import type { AgentProfile } from '../web/src/types';

const profile: AgentProfile = {
  id: 'profile-1',
  owner_user_id: 'user-1',
  name: 'Reviewer',
  identity_prompt: 'identity',
  soul_prompt: 'soul',
  agents_prompt: 'agents',
  tools_prompt: 'tools',
  prompt_mode: 'append',
  include_claude_preset: true,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  runtime_policy: {
    context: { source: 'managed' },
    skills: { mode: 'inherit', ids: [] },
    mcp: { mode: 'inherit', ids: [] },
  },
  identity_hash: 'hash',
  version: 1,
  is_default: false,
  status: 'active',
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
};

describe('Agent profile frontend write contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentProfilesStore.setState({
      profiles: [],
      governanceByProfile: {},
      governanceLoading: {},
      governanceErrors: {},
      promptVersionsByProfile: {},
      loading: false,
      profilesError: null,
      error: null,
    });
  });

  test('marks create payloads as the modern four-part prompt schema', async () => {
    vi.mocked(api.post).mockResolvedValue({ profile });
    vi.mocked(api.get).mockResolvedValue({ profiles: [profile] });

    await useAgentProfilesStore.getState().createProfile({
      name: 'Reviewer',
      identity_prompt: 'identity',
      soul_prompt: 'soul',
      agents_prompt: 'agents',
      tools_prompt: 'tools',
      prompt_mode: 'append',
    });

    expect(api.post).toHaveBeenCalledWith(
      '/api/agent-profiles',
      expect.objectContaining({ prompt_schema_version: 2 }),
    );
  });

  test('marks every modern update payload before sending it', async () => {
    useAgentProfilesStore.setState({ profiles: [profile] });
    vi.mocked(api.patch).mockResolvedValue({
      profile: { ...profile, soul_prompt: 'updated', version: 2 },
    });

    await useAgentProfilesStore.getState().updateProfile(profile.id, {
      soul_prompt: 'updated',
    });

    expect(api.patch).toHaveBeenCalledWith(
      '/api/agent-profiles/profile-1',
      {
        soul_prompt: 'updated',
        prompt_schema_version: 2,
      },
      120_000,
    );
  });

  test('supports a minimal host Skills policy PATCH for immediate apply', async () => {
    useAgentProfilesStore.setState({ profiles: [profile] });
    const updated = {
      ...profile,
      runtime_policy: {
        ...profile.runtime_policy,
        skills: {
          ...profile.runtime_policy.skills,
          host: { mode: 'inherit' as const, ids: [] },
        },
      },
      version: 2,
    };
    vi.mocked(api.patch).mockResolvedValue({ profile: updated });

    await useAgentProfilesStore.getState().updateProfile(profile.id, {
      runtime_policy: {
        skills: {
          host: { mode: 'inherit', ids: [] },
        },
      },
    });

    expect(api.patch).toHaveBeenCalledWith(
      '/api/agent-profiles/profile-1',
      {
        runtime_policy: {
          skills: {
            host: { mode: 'inherit', ids: [] },
          },
        },
        prompt_schema_version: 2,
      },
      120_000,
    );
    expect(
      useAgentProfilesStore.getState().profiles[0]?.runtime_policy.skills.host,
    ).toEqual({ mode: 'inherit', ids: [] });
  });

  test('does not report a committed profile PATCH as failed when list refresh fails', async () => {
    useAgentProfilesStore.setState({ profiles: [profile] });
    const updated = { ...profile, name: 'Reviewer 2', version: 2 };
    vi.mocked(api.patch).mockResolvedValue({ profile: updated });
    storeDeps.loadGroups.mockRejectedValueOnce(new Error('refresh failed'));

    await expect(
      useAgentProfilesStore
        .getState()
        .updateProfile(profile.id, { name: 'Reviewer 2' }),
    ).resolves.toEqual(updated);
    expect(useAgentProfilesStore.getState().profiles[0]?.name).toBe(
      'Reviewer 2',
    );
  });

  test('adopts a persisted profile from a post-commit cleanup error', async () => {
    useAgentProfilesStore.setState({ profiles: [profile] });
    const persisted = {
      ...profile,
      runtime_policy: {
        ...profile.runtime_policy,
        skills: {
          ...profile.runtime_policy.skills,
          host: { mode: 'inherit' as const, ids: [] },
        },
      },
      version: 2,
    };
    const error = {
      status: 503,
      message: '配置已更新，但运行时清理失败',
      body: { persisted: true, retryable: true, profile: persisted },
    };
    vi.mocked(api.patch).mockRejectedValue(error);

    await expect(
      useAgentProfilesStore.getState().updateProfile(profile.id, {
        runtime_policy: {
          skills: { host: { mode: 'inherit', ids: [] } },
        },
      }),
    ).rejects.toBe(error);
    expect(
      useAgentProfilesStore.getState().profiles[0]?.runtime_policy.skills.host,
    ).toEqual({ mode: 'inherit', ids: [] });
  });

  test('retries runtime cleanup through the owner-scoped endpoint', async () => {
    useAgentProfilesStore.setState({
      profiles: [profile],
      governanceByProfile: {
        [profile.id]: {
          profile,
          workspaces: [],
          channel_mounts: [],
          runtime_cleanup_pending: true,
        },
      },
    });
    vi.mocked(api.post).mockResolvedValue({
      success: true,
      cleaned_runtime_jids: 1,
      runtime_cleanup_pending: false,
    });

    await useAgentProfilesStore.getState().retryRuntimeCleanup(profile.id);

    expect(api.post).toHaveBeenCalledWith(
      '/api/agent-profiles/profile-1/runtime-cleanup',
      undefined,
      120_000,
    );
    expect(
      useAgentProfilesStore.getState().governanceByProfile[profile.id]
        ?.runtime_cleanup_pending,
    ).toBe(false);
  });
});
