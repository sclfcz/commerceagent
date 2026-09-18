import { describe, expect, test } from 'vitest';

import {
  buildDetachedWorkspaceUpdate,
  buildNativeThreadWorkspaceUpdate,
  buildRestoreDefaultChannelMountUpdate,
  buildSessionMountUpdate,
  buildWorkspaceMountUpdate,
  hasRemainingThreadMapMount,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  matchesWorkspaceMount,
  resolveChannelMountTarget,
  isNativeContextContainer,
} from '../src/channel-mount-service.js';
import {
  IM_CHANNEL_CAPABILITIES,
  isThreadMapCapableChat,
} from '../src/im-channel-capabilities.js';
import type {
  ChannelAccount,
  ChannelProvider,
  RegisteredGroup,
  SubAgent,
} from '../src/types.js';

function makeWorkspace(name: string, folder: string): RegisteredGroup {
  return {
    name,
    folder,
    added_at: '2026-07-09T00:00:00.000Z',
  };
}

function makeSession(id: string, chatJid: string): SubAgent {
  return {
    id,
    group_folder: 'workspace-a',
    chat_jid: chatJid,
    name: `Session ${id}`,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'owner-a',
    created_at: '2026-07-09T00:00:00.000Z',
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  };
}

function makeAccount(
  id: string,
  provider: ChannelProvider,
  defaultWorkspaceJid: string | null,
  legacy = false,
): ChannelAccount {
  return {
    id,
    owner_user_id: 'owner-a',
    provider,
    name: id,
    secret_ref: `secret:${id}`,
    enabled: true,
    is_default: true,
    is_legacy_default: legacy,
    auth_mode: 'bot_token',
    auth_status: 'authorized',
    transport_status: 'connected',
    status: 'connected',
    default_agent_profile_id: null,
    default_workspace_jid: defaultWorkspaceJid,
    last_error: null,
    connected_at: null,
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
  };
}

describe('resolveChannelMountTarget', () => {
  test('resolves a session mount through the session owner workspace', () => {
    const result = resolveChannelMountTarget(
      { session_id: 'session-a', workspace_jid: 'web:workspace-a' },
      {
        getAgent: (id) =>
          id === 'session-a' ? makeSession(id, 'web:workspace-a') : undefined,
        getRegisteredGroup: (jid) =>
          jid === 'web:workspace-a'
            ? makeWorkspace('Workspace A', 'workspace-a')
            : undefined,
      },
    );

    expect(result).toMatchObject({
      status: 'resolved',
      effectiveJid: 'web:workspace-a#agent:session-a',
      workspaceJid: 'web:workspace-a',
      agentId: 'session-a',
    });
  });

  test('does not fall back when a session mount points at a missing session', () => {
    const result = resolveChannelMountTarget(
      { session_id: 'missing-session', workspace_jid: 'web:workspace-a' },
      {
        getAgent: () => undefined,
        getRegisteredGroup: (jid) =>
          jid === 'web:workspace-a'
            ? makeWorkspace('Workspace A', 'workspace-a')
            : undefined,
      },
    );

    expect(result).toEqual({
      status: 'stale',
      reason: 'missing_session',
      sessionId: 'missing-session',
      workspaceJid: 'web:workspace-a',
    });
  });

  test('uses the session owner workspace when stored workspace_jid is stale', () => {
    const result = resolveChannelMountTarget(
      { session_id: 'session-a', workspace_jid: 'web:old-workspace' },
      {
        getAgent: (id) =>
          id === 'session-a' ? makeSession(id, 'web:workspace-a') : undefined,
        getRegisteredGroup: (jid) =>
          jid === 'web:workspace-a'
            ? makeWorkspace('Workspace A', 'workspace-a')
            : undefined,
      },
    );

    expect(result).toMatchObject({
      status: 'resolved',
      effectiveJid: 'web:workspace-a#agent:session-a',
      workspaceJid: 'web:workspace-a',
      agentId: 'session-a',
      workspaceMismatch: {
        storedWorkspaceJid: 'web:old-workspace',
        actualWorkspaceJid: 'web:workspace-a',
      },
    });
  });

  test('does not fall back when a workspace mount points at a missing workspace', () => {
    const result = resolveChannelMountTarget(
      { session_id: null, workspace_jid: 'web:missing-workspace' },
      {
        getAgent: () => undefined,
        getRegisteredGroup: () => undefined,
      },
    );

    expect(result).toEqual({
      status: 'stale',
      reason: 'missing_workspace',
      workspaceJid: 'web:missing-workspace',
    });
  });
});

describe('channel binding product contract', () => {
  test('every channel exposes workspace binding capability', () => {
    expect(
      Object.values(IM_CHANNEL_CAPABILITIES).every(
        (capability) => capability.can_bind_workspace,
      ),
    ).toBe(true);
  });

  test('only transports with a real inbound gate advertise activation modes', () => {
    expect(IM_CHANNEL_CAPABILITIES.telegram.supports_activation_modes).toBe(
      false,
    );
    expect(IM_CHANNEL_CAPABILITIES.qq.supports_activation_modes).toBe(false);
    expect(IM_CHANNEL_CAPABILITIES.wechat.supports_activation_modes).toBe(
      false,
    );
    for (const provider of ['feishu', 'dingtalk', 'discord', 'whatsapp']) {
      expect(IM_CHANNEL_CAPABILITIES[provider].supports_activation_modes).toBe(
        true,
      );
    }
  });

  test('Feishu topics and Telegram Forums qualify for native thread mapping', () => {
    expect(
      isThreadMapCapableChat({ channel_type: 'feishu', chat_mode: 'topic' }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({
        channel_type: 'feishu',
        chat_mode: 'group',
        group_message_type: 'thread',
      }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({ channel_type: 'feishu', chat_mode: 'group' }),
    ).toBe(false);
    expect(
      isThreadMapCapableChat({
        channel_type: 'telegram',
        native_context_type: 'thread',
      }),
    ).toBe(true);
    expect(
      isNativeContextContainer('telegram:group-1', {
        ...makeWorkspace('Forum', 'forum'),
        native_context_type: 'thread',
      }),
    ).toBe(true);
    expect(
      isNativeContextContainer('feishu:topic-group', {
        ...makeWorkspace('Feishu topic', 'feishu-topic'),
        feishu_chat_mode: 'group',
        feishu_group_message_type: 'thread',
        activation_mode: 'always',
      }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({
        channel_type: 'qq',
        native_context_type: 'thread',
      }),
    ).toBe(false);
  });

  test('Feishu ordinary groups use thread mapping only for mention activation', () => {
    const ordinary: RegisteredGroup = {
      ...makeWorkspace('Ordinary group', 'ordinary'),
      feishu_chat_mode: 'group',
      native_context_type: 'thread',
      activation_mode: 'always',
    };
    expect(isNativeContextContainer('feishu:ordinary', ordinary)).toBe(false);
    expect(
      isNativeContextContainer('feishu:ordinary', {
        ...ordinary,
        activation_mode: 'when_mentioned',
      }),
    ).toBe(true);
    expect(
      isNativeContextContainer('feishu:ordinary', {
        ...ordinary,
        activation_mode: 'auto',
        require_mention: true,
      }),
    ).toBe(true);
    expect(
      isNativeContextContainer('feishu:direct', {
        ...ordinary,
        feishu_chat_mode: 'p2p',
        activation_mode: 'when_mentioned',
      }),
    ).toBe(false);
  });

  test('restores to account default atomically and preserves channel policy', () => {
    const account = makeAccount('telegram-a', 'telegram', 'web:workspace-a');
    const workspace = {
      ...makeWorkspace('Workspace A', 'workspace-a'),
      created_by: 'owner-a',
    };
    const source: RegisteredGroup = {
      ...makeWorkspace('Forum', 'forum'),
      created_by: 'owner-a',
      channel_account_id: account.id,
      target_agent_id: 'session-old',
      activation_mode: 'owner_mentioned',
      audience_mode: 'owner_only',
      owner_im_id: 'owner-im',
      sender_allowlist: ['sender-a'],
      reply_policy: 'mirror',
      native_context_type: 'thread',
    };
    const restored = buildRestoreDefaultChannelMountUpdate(
      'telegram:chat#account:telegram-a',
      source,
      'owner-a',
      {
        getAccount: (id) => (id === account.id ? account : undefined),
        getDefaultAccount: () => undefined,
        getGroup: (jid) => (jid === 'web:workspace-a' ? workspace : undefined),
        getHome: () => undefined,
      },
    );

    expect(restored).toMatchObject({
      status: 'resolved',
      workspaceJid: 'web:workspace-a',
      routingMode: 'thread_map',
      updated: {
        target_main_jid: 'web:workspace-a',
        target_agent_id: undefined,
        binding_mode: 'thread_map',
        activation_mode: 'owner_mentioned',
        audience_mode: 'owner_only',
        owner_im_id: 'owner-im',
        sender_allowlist: ['sender-a'],
        reply_policy: 'source_only',
      },
    });
  });

  test('falls back from an invalid account default to the owner home workspace', () => {
    const account = makeAccount('qq-a', 'qq', 'web:deleted');
    const home = {
      ...makeWorkspace('Home', 'home-a'),
      jid: 'web:home-a',
      created_by: 'owner-a',
      is_home: true,
    };
    const restored = buildRestoreDefaultChannelMountUpdate(
      'qq:c2c:user#account:qq-a',
      {
        ...makeWorkspace('QQ', 'qq'),
        created_by: 'owner-a',
      },
      'owner-a',
      {
        getAccount: () => account,
        getDefaultAccount: () => undefined,
        getGroup: () => undefined,
        getHome: () => home,
      },
    );
    expect(restored).toMatchObject({
      status: 'resolved',
      workspaceJid: 'web:home-a',
      routingMode: 'single_session',
      updated: {
        target_main_jid: 'web:home-a',
        channel_account_id: account.id,
      },
    });
  });

  test('returns unavailable without clearing the current mount', () => {
    const source: RegisteredGroup = {
      ...makeWorkspace('Legacy', 'legacy'),
      created_by: 'owner-a',
      target_agent_id: 'keep-this-session',
    };
    const restored = buildRestoreDefaultChannelMountUpdate(
      'whatsapp:user@s.whatsapp.net',
      source,
      'owner-a',
      {
        getAccount: () => undefined,
        getDefaultAccount: () => undefined,
        getLegacyAccount: () => undefined,
        getGroup: () => undefined,
        getHome: () => undefined,
      },
    );
    expect(restored).toEqual({
      status: 'unavailable',
      reason: 'missing_default_workspace',
    });
    expect(source.target_agent_id).toBe('keep-this-session');
  });

  test('rejects an account id owned by another user', () => {
    const foreign = {
      ...makeAccount('telegram-foreign', 'telegram', 'web:foreign'),
      owner_user_id: 'owner-b',
    };
    const restored = buildRestoreDefaultChannelMountUpdate(
      'telegram:chat#account:telegram-foreign',
      {
        ...makeWorkspace('Foreign chat', 'foreign-chat'),
        created_by: 'owner-a',
        channel_account_id: foreign.id,
      },
      'owner-a',
      {
        getAccount: () => foreign,
        getDefaultAccount: () => undefined,
        getGroup: () => undefined,
        getHome: () => undefined,
      },
    );
    expect(restored).toEqual({
      status: 'unavailable',
      reason: 'account_mismatch',
    });
  });

  test('workspace and session targets remain mutually exclusive', () => {
    const source: RegisteredGroup = {
      ...makeWorkspace('Channel', 'channel-a'),
      activation_mode: 'always',
      audience_mode: 'owner_only',
      owner_im_id: 'owner-im',
    };
    const sessionBound = buildSessionMountUpdate(
      { ...source, target_main_jid: 'web:old' },
      'session-a',
    );
    expect(sessionBound.target_agent_id).toBe('session-a');
    expect(sessionBound.target_main_jid).toBeUndefined();
    expect(sessionBound).toMatchObject({
      activation_mode: 'always',
      audience_mode: 'owner_only',
      owner_im_id: 'owner-im',
    });

    const workspaceBound = buildWorkspaceMountUpdate(
      { ...source, target_agent_id: 'old-session' },
      'web:workspace-a',
      'thread_map',
    );
    expect(workspaceBound.target_agent_id).toBeUndefined();
    expect(workspaceBound.target_main_jid).toBe('web:workspace-a');
    expect(workspaceBound).toMatchObject({
      activation_mode: 'always',
      audience_mode: 'owner_only',
      owner_im_id: 'owner-im',
    });
  });

  test('centralizes target conflict and legacy workspace matching semantics', () => {
    const sessionBound = {
      ...makeWorkspace('Channel', 'channel-a'),
      target_agent_id: 'session-a',
    };
    expect(hasSessionMountConflict(sessionBound, 'session-a')).toBe(false);
    expect(hasSessionMountConflict(sessionBound, 'session-b')).toBe(true);

    const workspaceBound = {
      ...makeWorkspace('Topic', 'channel-b'),
      target_main_jid: 'web:workspace-folder',
      binding_mode: 'thread_map' as const,
    };
    expect(
      matchesWorkspaceMount(
        workspaceBound,
        'web:workspace-uuid',
        'web:workspace-folder',
      ),
    ).toBe(true);
    expect(
      hasWorkspaceMountConflict(
        workspaceBound,
        'web:workspace-uuid',
        'web:workspace-folder',
      ),
    ).toBe(false);
  });

  test('keeps native navigation until the final thread-map source leaves', () => {
    const workspace: RegisteredGroup = {
      ...makeWorkspace('Workspace', 'workspace-folder'),
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    };
    const groups: Record<string, RegisteredGroup> = {
      'web:workspace-uuid': workspace,
      'feishu:topic-a': {
        ...makeWorkspace('Topic A', 'source-a'),
        target_main_jid: 'web:workspace-folder',
        binding_mode: 'thread_map',
      },
      'telegram:forum-b': {
        ...makeWorkspace('Forum B', 'source-b'),
        target_main_jid: 'web:workspace-uuid',
        binding_mode: 'thread_map',
      },
    };
    const deps = {
      getAllGroups: () => groups,
      getGroup: (jid: string) => groups[jid],
      getJidsByFolder: (folder: string) =>
        Object.entries(groups)
          .filter(([, group]) => group.folder === folder)
          .map(([jid]) => jid),
    };

    delete groups['feishu:topic-a'];
    expect(
      hasRemainingThreadMapMount(
        'web:workspace-folder',
        'feishu:topic-a',
        deps,
      ),
    ).toBe(true);
    expect(groups['web:workspace-uuid']).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    delete groups['telegram:forum-b'];
    expect(
      hasRemainingThreadMapMount(
        'web:workspace-uuid',
        'telegram:forum-b',
        deps,
      ),
    ).toBe(false);
    groups['web:workspace-uuid'] = buildDetachedWorkspaceUpdate(workspace);
    expect(groups['web:workspace-uuid']).toMatchObject({
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
  });

  test('detaching a topic workspace preserves its data and only resets navigation', () => {
    const workspace: RegisteredGroup = {
      ...makeWorkspace('Workspace A', 'workspace-a'),
      conversation_source: 'feishu_thread',
      conversation_nav_mode: 'vertical_threads',
      skill_ids: ['skill-a'],
    };

    expect(buildDetachedWorkspaceUpdate(workspace)).toEqual({
      ...workspace,
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
  });

  test('marking a native thread workspace enables vertical navigation and preserves legacy Feishu source', () => {
    const manual = makeWorkspace('Workspace A', 'workspace-a');
    expect(buildNativeThreadWorkspaceUpdate(manual)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const legacyFeishu: RegisteredGroup = {
      ...manual,
      conversation_source: 'feishu_thread',
    };
    expect(buildNativeThreadWorkspaceUpdate(legacyFeishu)).toMatchObject({
      conversation_source: 'feishu_thread',
      conversation_nav_mode: 'vertical_threads',
    });
  });
});
