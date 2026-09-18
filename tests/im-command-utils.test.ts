import { describe, expect, test } from 'vitest';

import {
  resolveBoundChatTarget,
  type RegisteredGroupLike,
  type AgentLike,
} from '../src/im-command-utils.js';

describe('resolveBoundChatTarget', () => {
  const registeredGroups = new Map<string, RegisteredGroupLike>([
    [
      'web:graduation-jid',
      {
        name: 'graduation',
        folder: 'flow-graduation',
      },
    ],
    [
      'web:legacy-real-jid',
      {
        name: 'legacy',
        folder: 'flow-legacy',
      },
    ],
  ]);

  const agents = new Map<string, AgentLike>([
    [
      'agent-1234',
      {
        name: 'Thesis Agent',
        chat_jid: 'web:graduation-jid',
      },
    ],
  ]);

  const getRegisteredGroup = (jid: string) => registeredGroups.get(jid);
  const getAgent = (id: string) => agents.get(id);
  const findGroupNameByFolder = (folder: string) =>
    folder === 'home-u1' ? 'Home' : folder;
  const resolveWorkspaceJid = (jid: string) =>
    jid === 'web:flow-legacy' ? 'web:legacy-real-jid' : jid;

  test('uses the real bound workspace jid for main-conversation bindings', () => {
    const target = resolveBoundChatTarget(
      'feishu:chat-1',
      {
        name: 'Feishu Chat',
        folder: 'home-u1',
        target_main_jid: 'web:graduation-jid',
      },
      getRegisteredGroup,
      getAgent,
      findGroupNameByFolder,
      resolveWorkspaceJid,
    );

    expect(target).toEqual({
      baseChatJid: 'web:graduation-jid',
      targetChatJid: 'web:graduation-jid',
      folder: 'flow-graduation',
      agentId: null,
      locationLine: 'graduation / 主会话',
    });
  });

  test('uses the agent parent workspace jid for agent bindings', () => {
    const target = resolveBoundChatTarget(
      'feishu:chat-1',
      {
        name: 'Feishu Chat',
        folder: 'home-u1',
        target_agent_id: 'agent-1234',
      },
      getRegisteredGroup,
      getAgent,
      findGroupNameByFolder,
      resolveWorkspaceJid,
    );

    expect(target).toEqual({
      baseChatJid: 'web:graduation-jid',
      targetChatJid: 'web:graduation-jid#agent:agent-1234',
      folder: 'flow-graduation',
      agentId: 'agent-1234',
      locationLine: 'graduation / Thesis Agent',
    });
  });

  test('returns null when an agent binding points at a missing session', () => {
    const target = resolveBoundChatTarget(
      'feishu:chat-1',
      {
        name: 'Feishu Chat',
        folder: 'home-u1',
        target_agent_id: 'missing-agent',
      },
      getRegisteredGroup,
      getAgent,
      findGroupNameByFolder,
      resolveWorkspaceJid,
    );

    expect(target).toBeNull();
  });

  test('returns null when an agent parent workspace is missing', () => {
    const localAgents = new Map<string, AgentLike>([
      [
        'orphan-agent',
        {
          name: 'Orphan Agent',
          chat_jid: 'web:missing-workspace',
        },
      ],
    ]);

    const target = resolveBoundChatTarget(
      'feishu:chat-1',
      {
        name: 'Feishu Chat',
        folder: 'home-u1',
        target_agent_id: 'orphan-agent',
      },
      getRegisteredGroup,
      (id) => localAgents.get(id),
      findGroupNameByFolder,
      resolveWorkspaceJid,
    );

    expect(target).toBeNull();
  });

  test('returns null when a main binding points at a missing workspace', () => {
    const target = resolveBoundChatTarget(
      'feishu:chat-1',
      {
        name: 'Feishu Chat',
        folder: 'home-u1',
        target_main_jid: 'web:missing-workspace',
      },
      getRegisteredGroup,
      getAgent,
      findGroupNameByFolder,
      resolveWorkspaceJid,
    );

    expect(target).toBeNull();
  });

  test('resolves legacy web:{folder} workspace bindings before lookup', () => {
    const target = resolveBoundChatTarget(
      'feishu:chat-1',
      {
        name: 'Feishu Chat',
        folder: 'home-u1',
        target_main_jid: 'web:flow-legacy',
      },
      getRegisteredGroup,
      getAgent,
      findGroupNameByFolder,
      resolveWorkspaceJid,
    );

    expect(target).toEqual({
      baseChatJid: 'web:legacy-real-jid',
      targetChatJid: 'web:legacy-real-jid',
      folder: 'flow-legacy',
      agentId: null,
      locationLine: 'legacy / 主会话',
    });
  });
});
