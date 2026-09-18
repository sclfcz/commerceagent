import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'canonical-workspace-mirrors-'),
);
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const db = await import('../src/db.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('canonical workspace compatibility mirrors', () => {
  test('registered web workspaces are mirrored into workspaces', () => {
    db.setRegisteredGroup('web:mirror-workspace-a', {
      name: 'Workspace A',
      folder: 'mirror-workspace-a',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'owner-a',
      is_home: false,
    });

    expect(db.getWorkspaceRecord('web:mirror-workspace-a')).toMatchObject({
      jid: 'web:mirror-workspace-a',
      folder: 'mirror-workspace-a',
      owner_user_id: 'owner-a',
      name: 'Workspace A',
      status: 'active',
      is_home: false,
    });

    db.deleteRegisteredGroup('web:mirror-workspace-a');
    expect(db.getWorkspaceRecord('web:mirror-workspace-a')).toBeUndefined();
  });

  test('sessions are mirrored with AgentProfile identity version metadata', () => {
    db.setRegisteredGroup('web:mirror-workspace-b', {
      name: 'Workspace B',
      folder: 'mirror-workspace-b',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'owner-b',
      is_home: false,
    });

    db.setSession('mirror-workspace-b', 'claude-session-b', 'session-b', {
      agentProfileId: 'profile-b',
      agentProfileVersion: 7,
      identityHash: 'hash-b',
    });
    db.setSessionProviderId('mirror-workspace-b', 'session-b', 'provider-b');

    expect(
      db.getWorkspaceRuntimeSession('mirror-workspace-b', 'session-b'),
    ).toMatchObject({
      group_folder: 'mirror-workspace-b',
      runtime_agent_id: 'session-b',
      workspace_jid: 'web:mirror-workspace-b',
      sdk_session_id: 'claude-session-b',
      provider_id: 'provider-b',
      agent_profile_id: 'profile-b',
      agent_profile_version: 7,
      identity_hash: 'hash-b',
    });

    db.deleteSession('mirror-workspace-b', 'session-b');
    expect(
      db.getWorkspaceRuntimeSession('mirror-workspace-b', 'session-b'),
    ).toBeUndefined();
  });

  test('creating a workspace projects pre-existing runtime state in the same write', () => {
    db.setSession(
      'mirror-workspace-late-registration',
      'sdk-before-workspace',
      'agent-before-workspace',
    );
    expect(
      db.getWorkspaceRuntimeSession(
        'mirror-workspace-late-registration',
        'agent-before-workspace',
      ),
    ).toBeUndefined();

    db.setRegisteredGroup('web:mirror-workspace-late-registration', {
      name: 'Late Registration Workspace',
      folder: 'mirror-workspace-late-registration',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'owner-late-registration',
    });

    expect(
      db.getWorkspaceRuntimeSession(
        'mirror-workspace-late-registration',
        'agent-before-workspace',
      ),
    ).toMatchObject({ sdk_session_id: 'sdk-before-workspace' });
  });

  test('channel mounts are mirrored into agent-owned mounts', () => {
    db.setRegisteredGroup('web:mirror-workspace-c', {
      name: 'Workspace C',
      folder: 'mirror-workspace-c',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'owner-c',
      is_home: false,
    });
    const profile = db.createAgentProfile({
      ownerUserId: 'owner-c',
      name: 'Ops Agent',
      identityPrompt: '关注运行风险。',
    });
    db.assignWorkspaceAgentProfile('mirror-workspace-c', profile.id);
    db.createAgent({
      id: 'session-c',
      group_folder: 'mirror-workspace-c',
      chat_jid: 'web:mirror-workspace-c',
      name: 'Session C',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner-c',
      created_at: '2026-07-09T00:00:00.000Z',
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });

    db.setRegisteredGroup('telegram:mirror-chat-c', {
      name: 'Telegram C',
      folder: 'owner-home-c',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: 'owner-c',
      target_agent_id: 'session-c',
      reply_policy: 'mirror',
    });

    expect(db.getAgentChannelMount('telegram:mirror-chat-c')).toMatchObject({
      channel_jid: 'telegram:mirror-chat-c',
      agent_profile_id: profile.id,
      owner_user_id: 'owner-c',
      workspace_jid: 'web:mirror-workspace-c',
      workspace_folder: 'mirror-workspace-c',
      session_id: 'session-c',
      routing_mode: 'single_session',
      reply_policy: 'mirror',
    });

    const nextProfile = db.createAgentProfile({
      ownerUserId: 'owner-c',
      name: 'Review Agent',
      identityPrompt: '先审查风险。',
    });
    db.assignWorkspaceAgentProfile('mirror-workspace-c', nextProfile.id);
    expect(db.getAgentChannelMount('telegram:mirror-chat-c')).toMatchObject({
      agent_profile_id: nextProfile.id,
      workspace_folder: 'mirror-workspace-c',
    });

    db.deleteRegisteredGroup('telegram:mirror-chat-c');
    expect(db.getAgentChannelMount('telegram:mirror-chat-c')).toBeUndefined();
  });

  test('provider session deletion removes runtime-session projections atomically', () => {
    db.setRegisteredGroup('web:mirror-workspace-provider', {
      name: 'Provider Workspace',
      folder: 'mirror-workspace-provider',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'owner-provider',
    });
    db.setSession(
      'mirror-workspace-provider',
      'sdk-provider-session',
      'agent-provider',
    );
    db.setSessionProviderId(
      'mirror-workspace-provider',
      'agent-provider',
      'provider-to-delete',
    );
    expect(
      db.getWorkspaceRuntimeSession(
        'mirror-workspace-provider',
        'agent-provider',
      ),
    ).toBeDefined();

    expect(db.deleteSessionsByProviderId('provider-to-delete')).toMatchObject({
      deletedCount: 1,
      affectedFolders: ['mirror-workspace-provider'],
    });
    expect(
      db.getWorkspaceRuntimeSession(
        'mirror-workspace-provider',
        'agent-provider',
      ),
    ).toBeUndefined();
  });

  test('deleting a product Session clears its runtime state and channel projection', () => {
    db.setRegisteredGroup('web:mirror-workspace-delete-agent', {
      name: 'Delete Agent Workspace',
      folder: 'mirror-workspace-delete-agent',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'owner-delete-agent',
    });
    db.createAgent({
      id: 'product-session-delete-me',
      group_folder: 'mirror-workspace-delete-agent',
      chat_jid: 'web:mirror-workspace-delete-agent',
      name: 'Product Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner-delete-agent',
      created_at: '2026-07-10T00:00:00.000Z',
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    db.setSession(
      'mirror-workspace-delete-agent',
      'sdk-delete-me',
      'product-session-delete-me',
    );
    db.setRegisteredGroup('telegram:mirror-delete-agent-channel', {
      name: 'Delete Agent Channel',
      folder: 'owner-home-delete-agent',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'owner-delete-agent',
      target_agent_id: 'product-session-delete-me',
    });
    expect(
      db.getAgentChannelMount('telegram:mirror-delete-agent-channel'),
    ).toBeDefined();

    db.deleteAgent('product-session-delete-me');

    expect(
      db.getWorkspaceRuntimeSession(
        'mirror-workspace-delete-agent',
        'product-session-delete-me',
      ),
    ).toBeUndefined();
    expect(
      db.getAgentChannelMount('telegram:mirror-delete-agent-channel'),
    ).toBeUndefined();
    expect(
      db.getRegisteredGroup('telegram:mirror-delete-agent-channel')
        ?.target_agent_id,
    ).toBeUndefined();
  });

  test('deleting a workspace clears dependent channel projections and assignment ghosts', () => {
    db.setRegisteredGroup('web:mirror-delete-workspace', {
      name: 'Delete Workspace',
      folder: 'mirror-delete-workspace',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'owner-delete-workspace',
    });
    const profile = db.createAgentProfile({
      ownerUserId: 'owner-delete-workspace',
      name: 'Delete Workspace Profile',
    });
    db.assignWorkspaceAgentProfile('mirror-delete-workspace', profile.id);
    db.setRegisteredGroup('telegram:mirror-delete-workspace-channel', {
      name: 'Delete Workspace Channel',
      folder: 'owner-home-delete-workspace',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'owner-delete-workspace',
      target_main_jid: 'web:mirror-delete-workspace',
    });

    db.deleteRegisteredGroup('web:mirror-delete-workspace');

    expect(
      db.getWorkspaceRecord('web:mirror-delete-workspace'),
    ).toBeUndefined();
    expect(
      db.getAgentChannelMount('telegram:mirror-delete-workspace-channel'),
    ).toBeUndefined();
    expect(
      db.getRegisteredGroup('telegram:mirror-delete-workspace-channel')
        ?.target_main_jid,
    ).toBeUndefined();
    expect(
      db.getWorkspaceAgentProfileId('mirror-delete-workspace'),
    ).toBeUndefined();
  });
});
