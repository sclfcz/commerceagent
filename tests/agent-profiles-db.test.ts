import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-db-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const {
  initDatabase,
  createUser,
  listAgentProfilesForUser,
  createAgentProfile,
  updateAgentProfile,
  archiveAgentProfile,
  assignWorkspaceAgentProfile,
  deleteWorkspaceAgentProfile,
  getAgentProfileForWorkspace,
  getWorkspaceAgentProfileId,
  setRegisteredGroup,
  setSession,
  getSessionAgentIdentity,
  computeAgentProfileIdentityHash,
  normalizeAgentProfileRuntimePolicy,
  migrateAgentProfileAutoCompactWindow,
  getAgentChannelMount,
  listAgentProfilePromptVersions,
  ensureUserHomeGroup,
  getOrCreateDefaultAgentProfile,
  getRegisteredGroup,
} = await import('../src/db.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedUser(id: string, role: 'admin' | 'member' = 'member'): void {
  const now = new Date().toISOString();
  createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

describe('AgentProfile DB model', () => {
  test('creates one default AgentProfile for every new user', () => {
    seedUser('agent-profile-user-a');

    const profiles = listAgentProfilesForUser('agent-profile-user-a');

    expect(profiles).toHaveLength(1);
    expect(profiles[0].is_default).toBe(true);
    expect(profiles[0].name).toBe('CommerceAgent');
    expect(profiles[0].identity_prompt).toBe('');
    expect(profiles[0].include_claude_preset).toBe(true);
    expect(profiles[0].model_config_id).toBeNull();
    expect(profiles[0].runtime_policy).toEqual({
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
    });
    expect(profiles[0].identity_hash).toBe(
      computeAgentProfileIdentityHash('', true, undefined, 'CommerceAgent'),
    );
  });

  test('persists admin CommerceAgent as managed; global host policy is resolved at runtime', () => {
    const userId = 'agent-profile-admin-context';
    seedUser(userId, 'admin');

    const original = listAgentProfilesForUser(userId)[0];
    expect(original).toMatchObject({
      is_default: true,
      runtime_policy: { context: { source: 'managed' } },
    });

    const managed = updateAgentProfile(original.id, userId, {
      runtimePolicy: { context: { source: 'managed' } },
    });
    expect(managed?.version).toBe(original.version);
    expect(managed?.runtime_policy.context.source).toBe('managed');

    const reread = listAgentProfilesForUser(userId)[0];
    expect(reread.version).toBe(managed?.version);
    expect(reread.runtime_policy.context.source).toBe('managed');
  });

  test('does not rewrite legacy admin context policy during profile reads', () => {
    const userId = 'agent-profile-admin-legacy-context';
    seedUser(userId, 'admin');
    const original = listAgentProfilesForUser(userId)[0];
    const legacyPolicy = {
      provider_id: null,
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
    };
    const rawDb = new Database(path.join(tmpStoreDir, 'messages.db'));
    rawDb
      .prepare('UPDATE agent_profiles SET runtime_policy = ? WHERE id = ?')
      .run(JSON.stringify(legacyPolicy), original.id);
    rawDb.close();

    const migrated = listAgentProfilesForUser(userId).find(
      (candidate) => candidate.id === original.id,
    )!;
    expect(migrated.runtime_policy.context.source).toBe('managed');
    expect(migrated.version).toBe(original.version);
    expect(migrated.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        migrated.identity_prompt,
        migrated.include_claude_preset,
        migrated.runtime_policy,
        migrated.name,
      ),
    );

    const reread = listAgentProfilesForUser(userId)[0];
    expect(reread.version).toBe(migrated.version);
  });

  test('renames the legacy built-in Agent without changing custom default names', () => {
    const userId = 'agent-profile-user-legacy-name';
    seedUser(userId);
    const original = listAgentProfilesForUser(userId)[0];

    const legacy = updateAgentProfile(original.id, userId, {
      name: 'Default Agent',
    });
    expect(legacy?.name).toBe('Default Agent');

    const migrated = listAgentProfilesForUser(userId)[0];
    expect(migrated.name).toBe('CommerceAgent');
    expect(migrated.version).toBe((legacy?.version ?? 0) + 1);
    expect(listAgentProfilePromptVersions(migrated.id, userId)).toHaveLength(1);
    expect(migrated.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        migrated.identity_prompt,
        migrated.include_claude_preset,
        migrated.runtime_policy,
        'CommerceAgent',
      ),
    );

    const custom = updateAgentProfile(migrated.id, userId, {
      name: '我的默认助手',
    });
    expect(listAgentProfilesForUser(userId)[0].name).toBe(custom?.name);
  });

  test('ignores retired provider, model and tool policies when normalizing', () => {
    expect(
      normalizeAgentProfileRuntimePolicy({
        provider_id: 'provider-a',
        model: 'claude-opus-4-1',
        tools: { mode: 'readonly' },
      } as any),
    ).toEqual({
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
    });
  });

  test('maps a workspace to the selected AgentProfile', () => {
    seedUser('agent-profile-user-b');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-b',
      name: 'Research Agent',
      identityPrompt: '以研究员身份回答。',
      includeClaudePreset: false,
    });
    const folder = 'agent-profile-workspace-b';
    setRegisteredGroup('web:agent-profile-workspace-b', {
      name: 'Workspace B',
      folder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'agent-profile-user-b',
    });

    assignWorkspaceAgentProfile(folder, profile.id);

    expect(getWorkspaceAgentProfileId(folder)).toBe(profile.id);
    const mapped = getAgentProfileForWorkspace(folder, 'agent-profile-user-b');
    expect(mapped?.id).toBe(profile.id);
    expect(mapped?.include_claude_preset).toBe(false);
    expect(mapped?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '以研究员身份回答。',
        false,
        undefined,
        'Research Agent',
      ),
    );
  });

  test('permanently binds Home Workspace to the built-in CommerceAgent', () => {
    const userId = 'agent-profile-home-owner';
    seedUser(userId);
    const homeJid = ensureUserHomeGroup(userId, 'member', userId);
    const home = getRegisteredGroup(homeJid)!;
    const builtIn = getOrCreateDefaultAgentProfile(userId);
    const custom = createAgentProfile({
      ownerUserId: userId,
      name: 'Must Stay Isolated',
    });

    expect(getWorkspaceAgentProfileId(home.folder)).toBe(builtIn.id);
    expect(() => assignWorkspaceAgentProfile(home.folder, custom.id)).toThrow(
      'Home Workspace must remain bound to the built-in CommerceAgent Agent',
    );

    // Simulate a legacy database written before the invariant existed.
    const rawDb = new Database(path.join(tmpStoreDir, 'messages.db'));
    rawDb
      .prepare(
        `UPDATE workspace_agent_profiles
         SET agent_profile_id = ?
         WHERE group_folder = ?`,
      )
      .run(custom.id, home.folder);
    rawDb.close();
    expect(getWorkspaceAgentProfileId(home.folder)).toBe(custom.id);
    expect(getAgentProfileForWorkspace(home.folder, userId)?.id).toBe(
      builtIn.id,
    );
    expect(getWorkspaceAgentProfileId(home.folder)).toBe(builtIn.id);
  });

  test('updates identity hash and version when name, prompt, or preset mode changes', () => {
    seedUser('agent-profile-user-c');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-c',
      name: 'Coder',
      identityPrompt: '写代码前先读上下文。',
    });

    const renamed = updateAgentProfile(profile.id, 'agent-profile-user-c', {
      name: 'Coder Renamed',
    });
    expect(renamed?.version).toBe(profile.version + 1);
    expect(renamed?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '写代码前先读上下文。',
        true,
        undefined,
        'Coder Renamed',
      ),
    );
    const sameName = updateAgentProfile(profile.id, 'agent-profile-user-c', {
      name: 'Coder Renamed',
    });
    expect(sameName?.version).toBe(renamed?.version);
    expect(sameName?.identity_hash).toBe(renamed?.identity_hash);

    const updated = updateAgentProfile(profile.id, 'agent-profile-user-c', {
      identityPrompt: '先读上下文，再给最小可行改动。',
    });
    expect(updated?.version).toBe((renamed?.version ?? 0) + 1);
    expect(updated?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '先读上下文，再给最小可行改动。',
        true,
        undefined,
        'Coder Renamed',
      ),
    );

    const presetToggled = updateAgentProfile(
      profile.id,
      'agent-profile-user-c',
      {
        includeClaudePreset: false,
      },
    );
    expect(presetToggled?.version).toBe((updated?.version ?? 0) + 1);
    expect(presetToggled?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '先读上下文，再给最小可行改动。',
        false,
        undefined,
        'Coder Renamed',
      ),
    );
  });

  test('persists and versions Agent model configuration changes', () => {
    const userId = 'agent-profile-model-config';
    seedUser(userId);
    const profile = createAgentProfile({
      ownerUserId: userId,
      name: 'Model-bound Agent',
      modelConfigId: 'provider-a',
    });

    expect(profile.model_config_id).toBe('provider-a');
    const same = updateAgentProfile(profile.id, userId, {
      modelConfigId: 'provider-a',
    });
    expect(same?.version).toBe(profile.version);

    const switched = updateAgentProfile(profile.id, userId, {
      modelConfigId: 'provider-b',
    });
    expect(switched?.model_config_id).toBe('provider-b');
    expect(switched?.version).toBe(profile.version + 1);

    const inherited = updateAgentProfile(profile.id, userId, {
      modelConfigId: null,
    });
    expect(inherited?.model_config_id).toBeNull();
    expect(inherited?.version).toBe(profile.version + 2);
  });

  test('stores avatar overrides without changing runtime identity version', () => {
    seedUser('agent-profile-avatar-user');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-avatar-user',
      name: 'Designer',
    });

    const updated = updateAgentProfile(
      profile.id,
      'agent-profile-avatar-user',
      {
        avatarEmoji: '🎨',
        avatarColor: '#123456',
        avatarUrl: '/api/auth/avatars/agent-profile-test.png',
      },
    );

    expect(updated).toMatchObject({
      avatar_emoji: '🎨',
      avatar_color: '#123456',
      avatar_url: '/api/auth/avatars/agent-profile-test.png',
      version: profile.version,
      identity_hash: profile.identity_hash,
    });
  });

  test('versions AgentProfile runtime policy changes', () => {
    seedUser('agent-profile-user-policy');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-policy',
      name: 'Policy Agent',
      identityPrompt: '按策略运行。',
      runtimePolicy: {
        skills: { mode: 'custom', ids: ['review', 'research', 'review'] },
        mcp: { mode: 'disabled', ids: ['ignored'] },
      },
    });

    expect(profile.runtime_policy).toEqual({
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'custom', ids: ['review', 'research'] },
      mcp: { mode: 'disabled', ids: ['ignored'] },
    });
    expect(profile.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '按策略运行。',
        true,
        profile.runtime_policy,
        'Policy Agent',
      ),
    );

    const samePolicy = updateAgentProfile(
      profile.id,
      'agent-profile-user-policy',
      {
        runtimePolicy: profile.runtime_policy,
      },
    );
    expect(samePolicy?.version).toBe(profile.version);

    const updated = updateAgentProfile(
      profile.id,
      'agent-profile-user-policy',
      {
        runtimePolicy: {
          context: { source: 'host_claude' },
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'custom', ids: ['github'] },
        },
      },
    );
    expect(updated?.version).toBe(profile.version + 1);
    expect(updated?.runtime_policy).toEqual({
      reasoning: { effort: 'inherit' },
      context: {
        source: 'host_claude',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'custom', ids: ['github'] },
    });
    expect(updated?.identity_hash).toBe(
      computeAgentProfileIdentityHash(
        '按策略运行。',
        true,
        updated?.runtime_policy,
        'Policy Agent',
      ),
    );
  });

  test('records prompt history only when prompt sections or mode change', () => {
    const userId = 'agent-profile-prompt-history-scope';
    seedUser(userId);
    const profile = createAgentProfile({
      ownerUserId: userId,
      name: 'History Scope',
      identityPrompt: 'Identity v1',
      soulPrompt: 'Soul v1',
    });

    expect(listAgentProfilePromptVersions(profile.id, userId)).toHaveLength(1);

    const renamed = updateAgentProfile(profile.id, userId, {
      name: 'History Scope Renamed',
    })!;
    expect(renamed.version).toBe(profile.version + 1);
    expect(listAgentProfilePromptVersions(profile.id, userId)).toHaveLength(1);

    const policyUpdated = updateAgentProfile(profile.id, userId, {
      runtimePolicy: { skills: { mode: 'disabled' } },
    })!;
    expect(policyUpdated.version).toBe(renamed.version + 1);
    expect(listAgentProfilePromptVersions(profile.id, userId)).toHaveLength(1);

    const promptUpdated = updateAgentProfile(profile.id, userId, {
      toolsPrompt: 'Tools v2',
    })!;
    expect(promptUpdated.version).toBe(policyUpdated.version + 1);
    expect(listAgentProfilePromptVersions(profile.id, userId)).toMatchObject([
      {
        version: promptUpdated.version,
        name: 'History Scope Renamed',
        identity_prompt: 'Identity v1',
        soul_prompt: 'Soul v1',
        tools_prompt: 'Tools v2',
        change_source: 'update',
      },
      {
        version: profile.version,
        name: 'History Scope',
        tools_prompt: '',
        change_source: 'create',
      },
    ]);

    const modeUpdated = updateAgentProfile(profile.id, userId, {
      promptMode: 'replace',
    })!;
    expect(modeUpdated.version).toBe(promptUpdated.version + 1);
    expect(listAgentProfilePromptVersions(profile.id, userId)).toHaveLength(3);
  });

  test('deep-merges partial runtime policy patches without reopening siblings', () => {
    seedUser('agent-profile-user-policy-merge');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-policy-merge',
      name: 'Strict Policy Agent',
      runtimePolicy: {
        context: { source: 'host_claude' },
        skills: { mode: 'disabled', ids: ['kept-for-audit'] },
        mcp: { mode: 'custom', ids: ['github'] },
      },
    });

    const updated = updateAgentProfile(
      profile.id,
      'agent-profile-user-policy-merge',
      { runtimePolicy: { mcp: { ids: ['github', 'linear'] } } },
    );

    expect(updated?.runtime_policy).toEqual({
      reasoning: { effort: 'inherit' },
      context: {
        source: 'host_claude',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'disabled', ids: ['kept-for-audit'] },
      mcp: { mode: 'custom', ids: ['github', 'linear'] },
    });
  });

  test('preserves legacy missing host Skill policy and deep-merges explicit host selection', () => {
    const legacy = normalizeAgentProfileRuntimePolicy({
      context: { source: 'host_claude' },
      skills: { mode: 'custom', ids: ['managed-a'] },
    });
    expect(legacy.skills.host).toBeUndefined();

    const userId = 'agent-profile-host-skills-merge';
    seedUser(userId, 'admin');
    const profile = createAgentProfile({
      ownerUserId: userId,
      name: 'Host Skill Agent',
      runtimePolicy: {
        skills: {
          mode: 'custom',
          ids: ['managed-a'],
          host: {
            mode: 'custom',
            ids: ['host-a', 'host-b'],
          },
        },
      },
    });

    const updated = updateAgentProfile(profile.id, userId, {
      runtimePolicy: { skills: { host: { mode: 'disabled' } } },
    })!;
    expect(updated.runtime_policy.skills).toEqual({
      mode: 'custom',
      ids: ['managed-a'],
      host: { mode: 'disabled', ids: ['host-a', 'host-b'] },
    });
    expect(updated.version).toBe(profile.version + 1);
    expect(updated.identity_hash).not.toBe(profile.identity_hash);
  });

  test('migrates the legacy system compact threshold without bumping identity metadata', () => {
    const userId = 'agent-profile-auto-compact-migration';
    seedUser(userId);
    const profile = createAgentProfile({
      ownerUserId: userId,
      name: 'Legacy Compact Agent',
    });
    const rawDb = new Database(path.join(tmpStoreDir, 'messages.db'));
    rawDb
      .prepare('UPDATE agent_profiles SET runtime_policy = ? WHERE id = ?')
      .run(JSON.stringify({ context: { source: 'managed' } }), profile.id);
    rawDb.close();

    expect(migrateAgentProfileAutoCompactWindow(240_000)).toBeGreaterThan(0);
    const migrated = listAgentProfilesForUser(userId).find(
      (candidate) => candidate.id === profile.id,
    )!;
    expect(migrated.runtime_policy.context.auto_compact_window).toBe(240_000);
    expect(migrated.version).toBe(profile.version);
    expect(migrated.identity_hash).toBe(profile.identity_hash);
    expect(migrateAgentProfileAutoCompactWindow(240_000)).toBe(0);
  });

  test('updates auto compact policy without bumping Agent identity', () => {
    const userId = 'agent-profile-auto-compact-update';
    seedUser(userId);
    const profile = createAgentProfile({
      ownerUserId: userId,
      name: 'Compact Agent',
    });
    const updated = updateAgentProfile(profile.id, userId, {
      runtimePolicy: { context: { auto_compact_window: 300_000 } },
    });
    expect(updated?.runtime_policy.context.auto_compact_window).toBe(300_000);
    expect(updated?.version).toBe(profile.version);
    expect(updated?.identity_hash).toBe(profile.identity_hash);
  });

  test('model-relative compact percentage takes precedence over a legacy window', () => {
    const policy = normalizeAgentProfileRuntimePolicy({
      context: {
        auto_compact_window: 300_000,
        auto_compact_percentage: 80,
      },
    });
    expect(policy.context.auto_compact_window).toBe(0);
    expect(policy.context.auto_compact_percentage).toBe(80);
  });

  test('stores AgentProfile identity metadata on sessions', () => {
    seedUser('agent-profile-user-d');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-d',
      name: 'Planner',
      identityPrompt: '先拆计划再执行。',
    });

    setSession('agent-profile-workspace-d', 'session-d', undefined, {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });

    expect(getSessionAgentIdentity('agent-profile-workspace-d')).toEqual({
      agent_profile_id: profile.id,
      agent_profile_version: profile.version,
      identity_hash: profile.identity_hash,
    });
  });

  test('does not archive an AgentProfile that still owns workspaces', () => {
    seedUser('agent-profile-user-e');
    const [defaultProfile] = listAgentProfilesForUser('agent-profile-user-e');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-e',
      name: 'Ops',
      identityPrompt: '关注运行风险。',
    });
    const folder = 'agent-profile-workspace-e';
    assignWorkspaceAgentProfile(folder, profile.id);

    expect(archiveAgentProfile(profile.id, 'agent-profile-user-e')).toBe(
      'has_workspaces',
    );

    assignWorkspaceAgentProfile(folder, defaultProfile.id);
    expect(archiveAgentProfile(profile.id, 'agent-profile-user-e')).toBe('ok');
  });

  test('removes stale AgentProfile ownership from channel projections when mapping is deleted', () => {
    seedUser('agent-profile-user-f');
    const profile = createAgentProfile({
      ownerUserId: 'agent-profile-user-f',
      name: 'Channels',
      identityPrompt: '负责 IM 渠道。',
    });
    const folder = 'agent-profile-workspace-f';
    setRegisteredGroup('web:agent-profile-workspace-f', {
      name: 'Workspace F',
      folder,
      added_at: new Date().toISOString(),
      created_by: 'agent-profile-user-f',
    });
    assignWorkspaceAgentProfile(folder, profile.id);
    setRegisteredGroup('telegram:agent-profile-channel-f', {
      name: 'Telegram F',
      folder: 'home-f',
      added_at: new Date().toISOString(),
      created_by: 'agent-profile-user-f',
      target_main_jid: 'web:agent-profile-workspace-f',
    });

    deleteWorkspaceAgentProfile(folder);
    expect(
      getAgentChannelMount('telegram:agent-profile-channel-f'),
    ).toMatchObject({ agent_profile_id: null });
    expect(archiveAgentProfile(profile.id, 'agent-profile-user-f')).toBe('ok');
  });
});
