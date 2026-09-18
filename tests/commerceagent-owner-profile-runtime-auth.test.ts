import { describe, expect, test, vi } from 'vitest';

import {
  AgentBuilderTurnRegistry,
  agentBuilderTurnScope,
  getAgentBuilderRuntimeRejection,
  isAgentBuilderOwnerInput,
  isOwnerProfileOwnerInput,
  type AgentBuilderPersistedInput,
} from '../src/agent-builder-turn-auth.js';

const ownerWebInput: AgentBuilderPersistedInput = {
  content: '请把称呼改成何先生',
  sender: 'owner-1',
  source_jid: 'web:home',
  is_from_me: 0,
  source_kind: null,
  task_id: null,
};

describe('CommerceAgent Owner Profile exact active-turn authorization', () => {
  test('a queued future owner turn cannot authorize the current non-owner call', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.startBatch('home', [
      {
        chatJid: 'feishu:shared-home',
        messageId: 'member-active',
        runtimeTurnId: 'runtime-active',
        scheduledTaskId: null,
      },
    ]);
    registry.enqueueBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'owner-future',
        runtimeTurnId: 'runtime-future',
        scheduledTaskId: null,
      },
    ]);
    const load = vi.fn((_chatJid: string, messageId: string) =>
      messageId === 'member-active'
        ? { ...ownerWebInput, sender: 'group-member' }
        : ownerWebInput,
    );

    expect(() =>
      registry.requireExactActiveOwnerHumanTurn(
        'home',
        'runtime-active',
        load,
        (input) => input.sender === 'owner-1',
      ),
    ).toThrow('actual workspace owner');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('feishu:shared-home', 'member-active');

    expect(() =>
      registry.requireExactActiveOwnerHumanTurn(
        'home',
        'runtime-future',
        load,
        (input) => input.sender === 'owner-1',
      ),
    ).toThrow('exact active conversation turn');
  });

  test('read-only projection resolves the exact queued owner batch without lending mutation authority', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.startBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'owner-active',
        runtimeTurnId: 'runtime-active',
        scheduledTaskId: null,
      },
    ]);
    registry.enqueueBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'owner-queued',
        runtimeTurnId: 'runtime-queued',
        scheduledTaskId: null,
      },
    ]);
    const load = vi.fn((_chatJid: string, messageId: string) => ({
      ...ownerWebInput,
      content: messageId,
    }));

    expect(
      registry.requireExactOwnerHumanTurn(
        'home',
        'runtime-queued',
        load,
        (input) => input.sender === 'owner-1',
      ),
    ).toMatchObject({
      messageId: 'owner-queued',
      runtimeTurnId: 'runtime-queued',
      content: 'owner-queued',
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('web:home', 'owner-queued');

    expect(() =>
      registry.requireExactActiveOwnerHumanTurn(
        'home',
        'runtime-queued',
        load,
        () => true,
      ),
    ).toThrow('exact active conversation turn');
  });

  test('read-only projection rejects an exact queued non-owner batch', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.startBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'owner-active',
        runtimeTurnId: 'runtime-active',
        scheduledTaskId: null,
      },
    ]);
    registry.enqueueBatch('home', [
      {
        chatJid: 'feishu:shared-home',
        messageId: 'member-queued',
        runtimeTurnId: 'runtime-member-queued',
        scheduledTaskId: null,
      },
    ]);

    expect(() =>
      registry.requireExactOwnerHumanTurn(
        'home',
        'runtime-member-queued',
        (_chatJid, messageId) => ({
          ...ownerWebInput,
          sender: messageId === 'member-queued' ? 'group-member' : 'owner-1',
        }),
        (input) => input.sender === 'owner-1',
      ),
    ).toThrow('projection is unavailable for this turn');
  });

  test('a queued non-owner does not revoke the exact active owner turn', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.startBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'owner-active',
        runtimeTurnId: 'runtime-active',
        scheduledTaskId: null,
      },
    ]);
    registry.enqueueBatch('home', [
      {
        chatJid: 'feishu:shared-home',
        messageId: 'member-future',
        runtimeTurnId: 'runtime-future',
        scheduledTaskId: null,
      },
    ]);
    const load = vi.fn((_chatJid: string, messageId: string) => ({
      ...ownerWebInput,
      sender: messageId === 'owner-active' ? 'owner-1' : 'group-member',
    }));

    expect(
      registry.requireExactActiveOwnerHumanTurn(
        'home',
        'runtime-active',
        load,
        (input) => input.sender === 'owner-1',
      ),
    ).toMatchObject({
      chatJid: 'web:home',
      messageId: 'owner-active',
      runtimeTurnId: 'runtime-active',
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: 'scheduled host turn',
      turn: {
        scheduledTaskId: 'task-1',
      },
      input: ownerWebInput,
    },
    {
      name: 'persisted scheduled input',
      turn: {
        scheduledTaskId: null,
      },
      input: {
        ...ownerWebInput,
        source_kind: 'scheduled_task_prompt',
        task_id: 'task-1',
      },
    },
    {
      name: 'assistant-authored input',
      turn: {
        scheduledTaskId: null,
      },
      input: { ...ownerWebInput, is_from_me: 1 },
    },
  ])('rejects $name', ({ turn, input }) => {
    const registry = new AgentBuilderTurnRegistry();
    registry.startBatch('home', [
      {
        chatJid: 'web:home',
        messageId: 'active',
        runtimeTurnId: 'runtime-active',
        ...turn,
      },
    ]);
    expect(() =>
      registry.requireExactActiveOwnerHumanTurn(
        'home',
        'runtime-active',
        () => input,
        () => true,
      ),
    ).toThrow('scheduled or non-human');
  });
});

describe('CommerceAgent Owner Profile actual sender identity', () => {
  test('accepts only a canonical sender with strong IM owner provenance', () => {
    const sourceJid =
      'feishu:shared-home#account:bot-a#thread:thread-1#root:root-1';
    const lookup = (jid: string) =>
      jid === 'feishu:shared-home#account:bot-a'
        ? {
            created_by: 'owner-1',
            owner_im_id: 'ou_owner',
            owner_claim_source: 'configured',
          }
        : undefined;

    expect(
      isAgentBuilderOwnerInput(
        { sender: 'ou_owner', source_jid: sourceJid },
        'owner-1',
        lookup,
      ),
    ).toBe(true);
    expect(
      isAgentBuilderOwnerInput(
        { sender: 'ou_member', source_jid: sourceJid },
        'owner-1',
        lookup,
      ),
    ).toBe(false);
    expect(
      isAgentBuilderOwnerInput(
        { sender: 'ou_owner', source_jid: sourceJid },
        'different-owner',
        lookup,
      ),
    ).toBe(false);
    expect(
      isAgentBuilderOwnerInput(
        { sender: 'ou_owner', source_jid: sourceJid },
        'owner-1',
        () => ({
          created_by: 'owner-1',
          owner_im_id: 'ou_owner',
          owner_claim_source: 'explicit',
        }),
      ),
    ).toBe(false);
  });
});

describe('CommerceAgent Owner Profile home-anchored sender identity', () => {
  const registered = (jid: string) =>
    jid.startsWith('feishu:') ? { created_by: 'owner-1' } : undefined;
  const homeFeishuOwner = (provider: string) =>
    provider === 'feishu' ? ['ou_owner'] : [];

  test('accepts the owner in a Home topic group that never captured owner_im_id', () => {
    // Production regression: legacy topic groups have a NULL owner claim, but
    // sibling Home registrations anchor the same human via auto_feishu.
    expect(
      isOwnerProfileOwnerInput(
        {
          sender: 'ou_owner',
          source_jid: 'feishu:legacy-topic#thread:t1#root:r1',
        },
        'owner-1',
        registered,
        homeFeishuOwner,
      ),
    ).toBe(true);
  });

  test('rejects a non-owner group member and an unknown source chat', () => {
    expect(
      isOwnerProfileOwnerInput(
        { sender: 'ou_member', source_jid: 'feishu:legacy-topic' },
        'owner-1',
        registered,
        homeFeishuOwner,
      ),
    ).toBe(false);
    expect(
      isOwnerProfileOwnerInput(
        { sender: 'ou_owner', source_jid: 'feishu:unregistered' },
        'owner-1',
        () => undefined,
        homeFeishuOwner,
      ),
    ).toBe(false);
    expect(
      isOwnerProfileOwnerInput(
        { sender: 'ou_owner', source_jid: 'feishu:legacy-topic' },
        'owner-1',
        () => ({ created_by: 'different-owner' }),
        homeFeishuOwner,
      ),
    ).toBe(false);
  });

  test('anchored identities never cross providers', () => {
    expect(
      isOwnerProfileOwnerInput(
        { sender: 'qq:ou_owner', source_jid: 'qq:c2c:ou_owner' },
        'owner-1',
        () => ({ created_by: 'owner-1' }),
        homeFeishuOwner,
      ),
    ).toBe(false);
  });

  test('an empty anchor set fails closed and web turns stay user-id matched', () => {
    expect(
      isOwnerProfileOwnerInput(
        { sender: 'ou_owner', source_jid: 'feishu:legacy-topic' },
        'owner-1',
        registered,
        () => [],
      ),
    ).toBe(false);
    expect(
      isOwnerProfileOwnerInput(
        { sender: 'owner-1', source_jid: 'web:home' },
        'owner-1',
        () => undefined,
        () => [],
      ),
    ).toBe(true);
    expect(
      isOwnerProfileOwnerInput(
        { sender: 'someone-else', source_jid: 'web:home' },
        'owner-1',
        () => undefined,
        () => [],
      ),
    ).toBe(false);
  });
});

describe('CommerceAgent Owner Profile runtime isolation', () => {
  const base = {
    isScheduledTask: false,
    isolatedTaskId: null,
    runtimeAgentId: null,
    runtimeAgentKind: null,
    runtimeAgentFolder: null,
    sourceFolder: 'home-folder',
    sourceProfileIsDefault: true,
  } as const;

  test('allows the default CommerceAgent main and same-workspace conversation sessions', () => {
    expect(getAgentBuilderRuntimeRejection(base)).toBeNull();
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        runtimeAgentId: 'conversation-1',
        runtimeAgentKind: 'conversation',
        runtimeAgentFolder: 'home-folder',
      }),
    ).toBeNull();
    expect(agentBuilderTurnScope('home-folder', 'conversation-1')).not.toBe(
      agentBuilderTurnScope('home-folder', 'conversation-2'),
    );
  });

  test('rejects custom profiles, SDK/spawn agents, task agents, and scheduled runs', () => {
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        sourceProfileIsDefault: false,
      }),
    ).not.toBeNull();
    for (const runtimeAgentKind of ['spawn', 'task'] as const) {
      expect(
        getAgentBuilderRuntimeRejection({
          ...base,
          runtimeAgentId: `${runtimeAgentKind}-1`,
          runtimeAgentKind,
          runtimeAgentFolder: 'home-folder',
        }),
      ).not.toBeNull();
    }
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        isScheduledTask: true,
      }),
    ).not.toBeNull();
    expect(
      getAgentBuilderRuntimeRejection({
        ...base,
        isolatedTaskId: 'task-run-1',
      }),
    ).not.toBeNull();
  });
});
