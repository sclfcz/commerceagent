import { describe, expect, test } from 'vitest';

import { resolveBoundWorkspaceJid } from '../src/workspace-attribution.js';
import type { RegisteredGroup } from '../src/types.js';

const WORKSPACE_JID = 'web:ws-b';
const HOME_JID = 'web:main';
const IM_JID = 'qq:c2c:CHAT_A';

function group(partial: Partial<RegisteredGroup>): RegisteredGroup {
  return {
    jid: 'web:unused',
    name: 'unused',
    folder: 'main',
    ...partial,
  } as RegisteredGroup;
}

/**
 * The IM row deliberately keeps `folder: 'main'` and `created_by: 'u1'` — the
 * channel account owner — while being bound to another user's workspace. That
 * split is exactly the state the resolver has to see through.
 */
function makeDeps(overrides?: {
  groups?: Record<string, RegisteredGroup>;
  agents?: Record<string, { chat_jid: string }>;
}) {
  const groups: Record<string, RegisteredGroup> = overrides?.groups ?? {
    [HOME_JID]: group({
      jid: HOME_JID,
      folder: 'main',
      created_by: 'u1',
      is_home: true,
    }),
    [WORKSPACE_JID]: group({
      jid: WORKSPACE_JID,
      folder: 'flow-x',
      created_by: 'u2',
    }),
    [IM_JID]: group({
      jid: IM_JID,
      folder: 'main',
      created_by: 'u1',
      target_main_jid: WORKSPACE_JID,
    }),
  };
  const agents = overrides?.agents ?? {};
  return {
    getRegisteredGroup: (jid: string) => groups[jid] ?? null,
    getAgent: (agentId: string) => agents[agentId] ?? null,
    getJidsByFolder: (folder: string) =>
      Object.values(groups)
        .filter((g) => g.folder === folder)
        .map((g) => g.jid),
  };
}

describe('resolveBoundWorkspaceJid', () => {
  test('returns web JIDs unchanged without touching the registry', () => {
    expect(resolveBoundWorkspaceJid(HOME_JID, makeDeps())).toBe(HOME_JID);
  });

  test('returns null for an unregistered chat', () => {
    expect(resolveBoundWorkspaceJid('qq:c2c:UNKNOWN', makeDeps())).toBeNull();
  });

  test('follows a workspace binding instead of the IM row folder/owner', () => {
    expect(resolveBoundWorkspaceJid(IM_JID, makeDeps())).toBe(WORKSPACE_JID);
  });

  test('returns null for an unbound IM chat so callers keep their fallback', () => {
    const deps = makeDeps({
      groups: {
        [HOME_JID]: group({ jid: HOME_JID, created_by: 'u1', is_home: true }),
        [IM_JID]: group({ jid: IM_JID, created_by: 'u1' }),
      },
    });
    expect(resolveBoundWorkspaceJid(IM_JID, deps)).toBeNull();
  });

  test('folds a legacy web:{folder} binding to the registered workspace JID', () => {
    const deps = makeDeps({
      groups: {
        [WORKSPACE_JID]: group({
          jid: WORKSPACE_JID,
          folder: 'flow-x',
          created_by: 'u2',
        }),
        [IM_JID]: group({
          jid: IM_JID,
          created_by: 'u1',
          // Historical shape: web:{folder} rather than the registered JID.
          target_main_jid: 'web:flow-x',
        }),
      },
    });
    expect(resolveBoundWorkspaceJid(IM_JID, deps)).toBe(WORKSPACE_JID);
  });

  test('session binding wins over workspace binding', () => {
    const deps = makeDeps({
      groups: {
        [WORKSPACE_JID]: group({ jid: WORKSPACE_JID, folder: 'flow-x' }),
        'web:ws-c': group({ jid: 'web:ws-c', folder: 'flow-y' }),
        [IM_JID]: group({
          jid: IM_JID,
          created_by: 'u1',
          target_agent_id: 'agent-1',
          target_main_jid: WORKSPACE_JID,
        }),
      },
      agents: { 'agent-1': { chat_jid: 'web:ws-c' } },
    });
    expect(resolveBoundWorkspaceJid(IM_JID, deps)).toBe('web:ws-c');
  });

  test('normalized channel mount takes precedence over legacy target columns', () => {
    const deps = makeDeps({
      groups: {
        [WORKSPACE_JID]: group({ jid: WORKSPACE_JID, folder: 'flow-x' }),
        'web:ws-c': group({ jid: 'web:ws-c', folder: 'flow-y' }),
        [IM_JID]: group({
          jid: IM_JID,
          target_main_jid: WORKSPACE_JID,
        }),
      },
    });
    expect(
      resolveBoundWorkspaceJid(IM_JID, {
        ...deps,
        getChannelMount: (jid) =>
          jid === IM_JID
            ? { workspace_jid: 'web:ws-c', session_id: null }
            : null,
      }),
    ).toBe('web:ws-c');
  });

  test('normalized-only session mount resolves through the session owner workspace', () => {
    const deps = makeDeps({
      groups: {
        [WORKSPACE_JID]: group({ jid: WORKSPACE_JID, folder: 'flow-x' }),
        [IM_JID]: group({ jid: IM_JID, folder: 'channel-owner-home' }),
      },
      agents: { 'agent-1': { chat_jid: WORKSPACE_JID } },
    });
    expect(
      resolveBoundWorkspaceJid(IM_JID, {
        ...deps,
        getChannelMount: (jid) =>
          jid === IM_JID
            ? { workspace_jid: WORKSPACE_JID, session_id: 'agent-1' }
            : null,
      }),
    ).toBe(WORKSPACE_JID);
  });

  test('returns null when the bound session no longer exists', () => {
    const deps = makeDeps({
      groups: {
        [IM_JID]: group({
          jid: IM_JID,
          created_by: 'u1',
          target_agent_id: 'agent-gone',
          target_main_jid: WORKSPACE_JID,
        }),
      },
      agents: {},
    });
    expect(resolveBoundWorkspaceJid(IM_JID, deps)).toBeNull();
  });

  test('returns null when the workspace binding is stale', () => {
    const deps = makeDeps({
      groups: {
        [IM_JID]: group({
          jid: IM_JID,
          created_by: 'u1',
          target_main_jid: 'web:deleted-workspace',
        }),
      },
    });
    expect(resolveBoundWorkspaceJid(IM_JID, deps)).toBeNull();
  });
});
