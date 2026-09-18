import { describe, expect, test } from 'vitest';

import {
  AgentBuilderTurnRegistry,
  agentBuilderTurnScope,
  getAgentBuilderRuntimeRejection,
  isAgentBuilderOwnerInput,
  ownerImIdFromDirectConversationJid,
  resolveTrustedDirectOwnerUpgrade,
} from '../src/agent-builder-turn-auth.js';

const ownerInput = {
  content: '确认发布 AGENT-A1B2C3D4',
  sender: 'owner-1',
  source_jid: 'web:home',
  is_from_me: 0,
  source_kind: null,
  task_id: null,
};

describe('Agent Builder host turn authorization', () => {
  test('classifies only the host-owned active batch for runtime mutation authorization', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'owner-active');
    registry.enqueueBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'scheduled-queued',
        runtimeTurnId: 'scheduled-delivery',
        scheduledTaskId: 'task-queued',
      },
    ]);
    const load = (_chatJid: string, messageId: string) =>
      messageId === 'scheduled-queued'
        ? {
            ...ownerInput,
            task_id: 'task-queued',
            source_kind: 'scheduled_task_prompt',
          }
        : ownerInput;

    expect(registry.classifyActiveTurn('home', 'owner-active', load)).toBe(
      'interactive',
    );
    registry.clearCompleted('home', [
      { chatJid: 'web:home', messageId: 'owner-active' },
    ]);
    expect(
      registry.classifyActiveTurn('home', 'scheduled-delivery', load),
    ).toBe('scheduled');
    registry.clearCompleted('home', [
      { chatJid: 'web:home', messageId: 'scheduled-queued' },
    ]);
    expect(
      registry.classifyActiveTurn('home', 'scheduled-delivery', load),
    ).toBe('unknown');
  });

  test('active turn classification fails closed when durable input is missing', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'missing');
    expect(registry.classifyActiveTurn('home', 'missing', () => null)).toBe(
      'unknown',
    );
  });

  test('classifies only the exact runtime turn that owns the active batch', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.startBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'cursor-a',
        runtimeTurnId: 'delivery-current',
        scheduledTaskId: null,
      },
      {
        chatJid: 'web:home',
        messageId: 'cursor-b',
        runtimeTurnId: 'delivery-current',
        scheduledTaskId: null,
      },
    ]);
    const load = () => ownerInput;

    expect(registry.classifyActiveTurn('home', 'delivery-old', load)).toBe(
      'unknown',
    );
    expect(registry.classifyActiveTurn('home', 'delivery-current', load)).toBe(
      'interactive',
    );
  });

  test('isolates concurrent runtime sessions in the same workspace', () => {
    const registry = new AgentBuilderTurnRegistry();
    const sessionA = agentBuilderTurnScope('workspace', 'session-a');
    const sessionB = agentBuilderTurnScope('workspace', 'session-b');
    registry.set(sessionA, 'web:workspace#agent:session-a', 'message-a');
    registry.set(sessionB, 'web:workspace#agent:session-b', 'message-b');

    expect(
      registry.requireOwnerHumanTurn(
        sessionA,
        (_chatJid, messageId) => ({ ...ownerInput, content: messageId }),
        () => true,
      ).content,
    ).toBe('message-a');
    expect(
      registry.requireOwnerHumanTurn(
        sessionB,
        (_chatJid, messageId) => ({ ...ownerInput, content: messageId }),
        () => true,
      ).content,
    ).toBe('message-b');
  });

  test('returns only a host-recorded durable owner turn', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'human-1');
    expect(
      registry.requireOwnerHumanTurn(
        'home',
        () => ownerInput,
        (input) => input.sender === 'owner-1',
      ),
    ).toEqual({
      chatJid: 'web:home',
      messageId: 'human-1',
      runtimeTurnId: 'human-1',
      scheduledTaskId: null,
      content: ownerInput.content,
    });
  });

  test.each([
    {
      name: 'host-recorded scheduled task',
      scheduledTaskId: 'task-1',
      input: ownerInput,
    },
    {
      name: 'database scheduled task marker',
      scheduledTaskId: null,
      input: { ...ownerInput, task_id: 'task-2' },
    },
    {
      name: 'scheduled source kind',
      scheduledTaskId: null,
      input: { ...ownerInput, source_kind: 'scheduled_task_prompt' },
    },
    {
      name: 'assistant-authored row',
      scheduledTaskId: null,
      input: { ...ownerInput, is_from_me: 1 },
    },
  ])('rejects $name', ({ scheduledTaskId, input }) => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'message-1', scheduledTaskId);
    expect(() =>
      registry.requireOwnerHumanTurn(
        'home',
        () => input,
        () => true,
      ),
    ).toThrow('scheduled or non-human');
  });

  test('rejects a human message from a non-owner in a shared channel', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'member-1');
    expect(() =>
      registry.requireOwnerHumanTurn(
        'home',
        () => ({ ...ownerInput, sender: 'group-member' }),
        (input) => input.sender === 'owner-1',
      ),
    ).toThrow('Only the Agent owner');
  });

  test('clears only the matching completed input and rejects stale idle calls', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'human-2');
    registry.clearCompleted('home', [
      { chatJid: 'web:home', messageId: 'older' },
    ]);
    expect(
      registry.requireOwnerHumanTurn(
        'home',
        () => ownerInput,
        () => true,
      ).messageId,
    ).toBe('human-2');

    registry.clearCompleted('home', [
      { chatJid: 'web:home', messageId: 'human-2' },
    ]);
    expect(() =>
      registry.requireOwnerHumanTurn(
        'home',
        () => ownerInput,
        () => true,
      ),
    ).toThrow('active owner conversation turn');
  });

  test('does not let an in-flight scheduled turn borrow a queued owner turn', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'scheduled-1', 'task-1');
    registry.enqueueBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'owner-queued',
        runtimeTurnId: 'owner-queued',
        scheduledTaskId: null,
      },
    ]);
    const load = (_chatJid: string, messageId: string) =>
      messageId === 'scheduled-1'
        ? {
            ...ownerInput,
            content: 'scheduled prompt',
            source_kind: 'scheduled_task_prompt',
            task_id: 'task-1',
          }
        : ownerInput;

    expect(() =>
      registry.requireOwnerHumanTurn('home', load, () => true),
    ).toThrow('scheduled or non-human');

    registry.clearCompleted('home', [
      { chatJid: 'web:home', messageId: 'scheduled-1' },
    ]);
    expect(
      registry.requireOwnerHumanTurn('home', load, () => true).messageId,
    ).toBe('owner-queued');
  });

  test('fails closed when a scheduled or non-owner input is queued behind an owner turn', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'owner-running');
    registry.enqueueBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'scheduled-queued',
        runtimeTurnId: 'scheduled-queued',
        scheduledTaskId: 'task-2',
      },
    ]);
    expect(() =>
      registry.requireOwnerHumanTurn(
        'home',
        (_chatJid, messageId) =>
          messageId === 'scheduled-queued'
            ? { ...ownerInput, task_id: 'task-2' }
            : ownerInput,
        () => true,
      ),
    ).toThrow('scheduled or non-human');
  });

  test('retires startup inputs and already-completed queued receipts together', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'startup-owner');
    registry.enqueueBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'boot-drained-owner',
        runtimeTurnId: 'boot-drained-owner',
        scheduledTaskId: null,
      },
    ]);
    registry.clearCompleted('home', [
      { chatJid: 'web:home', messageId: 'boot-drained-owner' },
    ]);
    expect(() =>
      registry.requireOwnerHumanTurn(
        'home',
        () => ownerInput,
        () => true,
      ),
    ).toThrow('active owner conversation turn');
  });

  test('promotes a new owner turn injected while a long-lived runner is idle', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set('home', 'web:home', 'prepare-turn');
    registry.clearCompleted('home', [
      { chatJid: 'web:home', messageId: 'prepare-turn' },
    ]);
    registry.enqueueBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'confirmation-turn',
        runtimeTurnId: 'confirmation-delivery',
        scheduledTaskId: null,
      },
    ]);

    expect(
      registry.requireOwnerHumanTurn(
        'home',
        (_chatJid, messageId) => ({
          ...ownerInput,
          content:
            messageId === 'confirmation-turn' ? ownerInput.content : 'prepare',
        }),
        () => true,
      ).messageId,
    ).toBe('confirmation-turn');
  });
});

describe('Agent Builder runtime eligibility', () => {
  const base = {
    isScheduledTask: false,
    isolatedTaskId: null,
    runtimeAgentId: null,
    runtimeAgentKind: null,
    runtimeAgentFolder: null,
    sourceFolder: 'workspace-a',
    sourceProfileIsDefault: true,
  } as const;

  test('allows the main session and ordinary runtime sessions in any workspace', () => {
    expect(getAgentBuilderRuntimeRejection(base)).toBeNull();
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        runtimeAgentId: 'conversation-a',
        runtimeAgentKind: 'conversation',
        runtimeAgentFolder: 'workspace-a',
      }),
    ).toBeNull();
  });

  test('rejects custom profiles, task runs, spawn agents, and cross-workspace impersonation', () => {
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        sourceProfileIsDefault: false,
      }),
    ).toMatch(/main CommerceAgent/);
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        isScheduledTask: true,
      }),
    ).toMatch(/task runs/);
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        runtimeAgentId: 'spawn-a',
        runtimeAgentKind: 'spawn',
        runtimeAgentFolder: 'workspace-a',
      }),
    ).toMatch(/ordinary main-Agent conversations/);
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        runtimeAgentId: 'conversation-b',
        runtimeAgentKind: 'conversation',
        runtimeAgentFolder: 'workspace-b',
      }),
    ).toMatch(/ordinary main-Agent conversations/);
  });
});

describe('Agent Builder owner identity', () => {
  test('accepts the authenticated Web owner and rejects another Web member', () => {
    expect(
      isAgentBuilderOwnerInput(ownerInput, 'owner-1', () => undefined),
    ).toBe(true);
    expect(
      isAgentBuilderOwnerInput(
        { ...ownerInput, sender: 'group-member' },
        'owner-1',
        () => undefined,
      ),
    ).toBe(false);
  });

  test('accepts only the claimed IM owner, including a native thread source', () => {
    const groups = new Map([
      [
        'feishu:chat-1',
        {
          created_by: 'owner-1',
          owner_im_id: 'ou_owner',
          owner_claim_source: 'configured',
        },
      ],
    ]);
    const lookup = (jid: string) => groups.get(jid);
    expect(
      isAgentBuilderOwnerInput(
        {
          sender: 'ou_owner',
          source_jid: 'feishu:chat-1#thread:thread-1',
        },
        'owner-1',
        lookup,
      ),
    ).toBe(true);
    expect(
      isAgentBuilderOwnerInput(
        { sender: 'ou_member', source_jid: 'feishu:chat-1' },
        'owner-1',
        lookup,
      ),
    ).toBe(false);
  });

  test.each([
    {
      name: 'Feishu account-scoped thread',
      sourceJid: 'feishu:chat-1#account:account-a#thread:thread-1#root:root-1',
      groupJid: 'feishu:chat-1#account:account-a',
      ownerImId: 'ou_owner',
      sender: 'ou_owner',
    },
    {
      name: 'Telegram account-scoped topic',
      sourceJid: 'telegram:-1001#account:account-a#thread:42',
      groupJid: 'telegram:-1001#account:account-a',
      ownerImId: '123',
      sender: 'tg:123',
    },
    {
      name: 'Discord group',
      sourceJid: 'discord:channel-1',
      groupJid: 'discord:channel-1',
      ownerImId: '123',
      sender: 'discord:123',
    },
    {
      name: 'DingTalk group',
      sourceJid: 'dingtalk:group:conversation-1',
      groupJid: 'dingtalk:group:conversation-1',
      ownerImId: 'owner-open-id',
      sender: 'dingtalk:owner-open-id',
    },
    {
      name: 'WeChat direct chat',
      sourceJid: 'wechat:owner-open-id',
      groupJid: 'wechat:owner-open-id',
      ownerImId: 'owner-open-id',
      sender: 'wechat:owner-open-id',
    },
    {
      name: 'QQ C2C namespace',
      sourceJid: 'qq:c2c:conversation-1',
      groupJid: 'qq:c2c:conversation-1',
      ownerImId: 'c2c:owner-open-id',
      sender: 'qq:owner-open-id',
    },
    {
      name: 'QQ group namespace',
      sourceJid: 'qq:group:conversation-1',
      groupJid: 'qq:group:conversation-1',
      ownerImId: 'group:owner-open-id',
      sender: 'qq:owner-open-id',
    },
    {
      name: 'WhatsApp device-qualified sender',
      sourceJid: 'whatsapp:group-1@g.us',
      groupJid: 'whatsapp:group-1@g.us',
      ownerImId: '15551234@s.whatsapp.net',
      sender: 'whatsapp:15551234:42@s.whatsapp.net',
    },
  ])('accepts canonical owner identity for $name', (entry) => {
    expect(
      isAgentBuilderOwnerInput(
        { sender: entry.sender, source_jid: entry.sourceJid },
        'owner-1',
        (jid) =>
          jid === entry.groupJid
            ? {
                created_by: 'owner-1',
                owner_im_id: entry.ownerImId,
                owner_claim_source: 'trusted_direct',
              }
            : undefined,
      ),
    ).toBe(true);
  });

  test.each([
    {
      name: 'Telegram rejects a Discord-shaped sender',
      sourceJid: 'telegram:chat-1',
      ownerImId: '123',
      sender: 'discord:123',
    },
    {
      name: 'Discord rejects a Telegram-shaped sender',
      sourceJid: 'discord:channel-1',
      ownerImId: '123',
      sender: 'tg:123',
    },
    {
      name: 'QQ group rejects a C2C owner claim',
      sourceJid: 'qq:group:conversation-1',
      ownerImId: 'c2c:owner-open-id',
      sender: 'qq:owner-open-id',
    },
    {
      name: 'WhatsApp rejects a group identity as owner',
      sourceJid: 'whatsapp:group-1@g.us',
      ownerImId: 'group-1@g.us',
      sender: 'whatsapp:group-1@g.us',
    },
    {
      name: 'unknown channel fails closed',
      sourceJid: 'unknown:chat-1',
      ownerImId: 'owner-1',
      sender: 'owner-1',
    },
  ])('$name', (entry) => {
    expect(
      isAgentBuilderOwnerInput(
        { sender: entry.sender, source_jid: entry.sourceJid },
        'owner-1',
        () => ({ created_by: 'owner-1', owner_im_id: entry.ownerImId }),
      ),
    ).toBe(false);
  });

  test('does not fall back from an account-scoped native thread to a legacy group', () => {
    expect(
      isAgentBuilderOwnerInput(
        {
          sender: 'ou_owner',
          source_jid: 'feishu:chat-1#account:account-b#thread:thread-1',
        },
        'owner-1',
        (jid) =>
          jid === 'feishu:chat-1'
            ? { created_by: 'owner-1', owner_im_id: 'ou_owner' }
            : undefined,
      ),
    ).toBe(false);
  });

  test('rejects a Feishu owner learned by first-DM auto-discovery', () => {
    expect(
      isAgentBuilderOwnerInput(
        { sender: 'ou_first_dm', source_jid: 'feishu:p2p-chat' },
        'owner-1',
        () => ({
          created_by: 'owner-1',
          owner_im_id: 'ou_first_dm',
          owner_claim_source: 'auto_feishu',
        }),
      ),
    ).toBe(false);
  });

  test('rejects an unpaired explicit first-claim owner', () => {
    expect(
      isAgentBuilderOwnerInput(
        { sender: 'discord:123', source_jid: 'discord:channel-1' },
        'owner-1',
        () => ({
          created_by: 'owner-1',
          owner_im_id: '123',
          owner_claim_source: 'explicit',
        }),
      ),
    ).toBe(false);
  });
});

describe('trusted direct owner provenance upgrade', () => {
  test('learns a new admitted direct chat with no owner or provenance', () => {
    expect(
      resolveTrustedDirectOwnerUpgrade(
        'telegram:123',
        'tg:123',
        undefined,
        undefined,
      ),
    ).toBe('123');
  });

  test('does not trust a historical owner without provenance', () => {
    expect(
      resolveTrustedDirectOwnerUpgrade(
        'telegram:123',
        'tg:123',
        '123',
        undefined,
      ),
    ).toBeNull();
  });

  test.each([
    'configured',
    'trusted_direct',
    'explicit',
    'auto_feishu',
    'transfer_reset',
  ])('does not rewrite protected provenance %s', (source) => {
    expect(
      resolveTrustedDirectOwnerUpgrade('telegram:123', 'tg:123', '123', source),
    ).toBeNull();
  });

  test('rejects a different sender and handles WhatsApp device JIDs canonically', () => {
    expect(
      resolveTrustedDirectOwnerUpgrade(
        'telegram:123',
        'tg:456',
        '123',
        'explicit',
      ),
    ).toBeNull();
    expect(
      resolveTrustedDirectOwnerUpgrade(
        'whatsapp:15551234@s.whatsapp.net',
        'whatsapp:15551234:42@s.whatsapp.net',
        undefined,
        undefined,
      ),
    ).toBe('15551234@s.whatsapp.net');
  });
});

describe('paired direct conversation identity', () => {
  test.each([
    ['telegram:123#account:bot-a', '123'],
    ['discord:dm:456#account:bot-a', '456'],
    ['dingtalk:c2c:staff-a', 'staff-a'],
    ['wechat:user-a', 'user-a'],
    ['qq:c2c:open-a#account:bot-a', 'c2c:open-a'],
    [
      'whatsapp:15551234:42@s.whatsapp.net#account:bot-a',
      '15551234@s.whatsapp.net',
    ],
  ])('derives the native owner from %s', (jid, owner) => {
    expect(ownerImIdFromDirectConversationJid(jid)).toBe(owner);
  });

  test.each([
    'telegram:-1001',
    'discord:channel-1',
    'dingtalk:group-1',
    'qq:group:open-a',
    'whatsapp:group@g.us',
    'feishu:p2p-ambiguous',
    'unknown:chat',
  ])('fails closed for non-direct or ambiguous %s', (jid) => {
    expect(ownerImIdFromDirectConversationJid(jid)).toBeNull();
  });
});
