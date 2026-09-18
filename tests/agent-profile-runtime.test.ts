import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profile-runtime-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  ASSISTANT_NAME: 'CommerceAgent',
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const db = await import('../src/db.js');
const runtime = await import('../src/agent-profile-runtime.js');
const runtimeConfig = await import('../src/runtime-config.js');
const policy = await import('../src/agent-profile-policy.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AgentProfile runtime invalidation', () => {
  test('default CommerceAgent takes its compact threshold from global policy', () => {
    const userId = 'agent-profile-runtime-default-compact';
    const now = new Date().toISOString();
    db.createUser({
      id: userId,
      username: userId,
      password_hash: 'hash',
      display_name: userId,
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    runtimeConfig.saveSystemSettings({
      mainAgentAutoCompactWindow: 0,
      mainAgentAutoCompactPercentage: 80,
    });
    const profile = db.getOrCreateDefaultAgentProfile(userId);
    const effective = runtime.resolveEffectiveAgentProfile(profile);
    expect(effective?.runtime_policy.context.source).toBe('managed');
    expect(effective?.runtime_policy.context.auto_compact_window).toBe(0);
    expect(effective?.runtime_policy.context.auto_compact_percentage).toBe(80);
    expect(effective?.identity_hash).toBe(
      runtime.bindCommerceAgentPlatformIdentityHash(
        db.computeAgentProfileIdentityHash(
          profile,
          effective!.runtime_policy,
          profile.name,
        ),
      ),
    );
    expect(effective?.identity_hash).not.toBe(profile.identity_hash);
  });

  test('custom Agents do not inherit the protected CommerceAgent identity hash', () => {
    const userId = 'agent-profile-runtime-custom-identity';
    const now = new Date().toISOString();
    db.createUser({
      id: userId,
      username: userId,
      password_hash: 'hash',
      display_name: userId,
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    const profile = db.createAgentProfile({
      ownerUserId: userId,
      name: 'Isolated Custom Agent',
      identityPrompt: 'Custom only.',
    });
    const effective = runtime.resolveEffectiveAgentProfile(profile)!;

    expect(effective.identity_hash).toBe(
      db.computeAgentProfileIdentityHash(
        profile,
        effective.runtime_policy,
        profile.name,
      ),
    );
    expect(effective.identity_hash).not.toBe(
      runtime.bindCommerceAgentPlatformIdentityHash(effective.identity_hash),
    );
  });

  test('role downgrade forces persisted host context back to managed', () => {
    const userId = 'agent-profile-runtime-role-downgrade';
    const now = new Date().toISOString();
    db.createUser({
      id: userId,
      username: userId,
      password_hash: 'hash',
      display_name: userId,
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    const profile = db.createAgentProfile({
      ownerUserId: userId,
      name: 'Host Agent',
      runtimePolicy: {
        context: { source: 'host_claude' },
        skills: {
          host: { mode: 'custom', ids: ['native-review'] },
        },
      },
    });
    expect(
      runtime.resolveEffectiveAgentProfile(profile)?.runtime_policy.context
        .source,
    ).toBe('host_claude');
    const adminEffectiveHash =
      runtime.resolveEffectiveAgentProfile(profile)?.identity_hash;

    db.updateUserFields(userId, { role: 'member' });
    const memberEffective = runtime.resolveEffectiveAgentProfile(profile);
    expect(memberEffective?.runtime_policy.context.source).toBe('managed');
    expect(memberEffective?.runtime_policy.skills.host).toEqual({
      mode: 'disabled',
      ids: ['native-review'],
    });
    expect(memberEffective?.identity_hash).not.toBe(adminEffectiveHash);
  });

  test('legacy missing host Skill policy follows the effective context source', () => {
    const userId = 'agent-profile-runtime-legacy-host-skills';
    const now = new Date().toISOString();
    db.createUser({
      id: userId,
      username: userId,
      password_hash: 'hash',
      display_name: userId,
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    runtimeConfig.saveSystemSettings({ mainAgentContextSource: 'host_claude' });
    const main = runtime.resolveEffectiveAgentProfile(
      db.getOrCreateDefaultAgentProfile(userId),
    )!;
    expect(main.runtime_policy.skills.host).toBeUndefined();
    expect(policy.resolveHostSkillPolicy(main.runtime_policy)).toEqual({
      mode: 'inherit',
      ids: [],
    });

    const managed = runtime.resolveEffectiveAgentProfile(
      db.createAgentProfile({ ownerUserId: userId, name: 'Managed legacy' }),
    )!;
    expect(policy.resolveHostSkillPolicy(managed.runtime_policy)).toEqual({
      mode: 'disabled',
      ids: [],
    });
  });

  test('opposite multi-profile lock order is serialized without deadlock', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = runtime.withAgentProfileLocks(
      ['profile-b', 'profile-a'],
      async () => {
        events.push('first-enter');
        firstEntered();
        await firstGate;
        events.push('first-exit');
      },
    );
    await firstEnteredPromise;

    const second = runtime.withAgentProfileLocks(
      ['profile-a', 'profile-b'],
      () => events.push('second-enter'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['first-enter']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);

    // An exception must also release/refcount-clean both keys.
    await expect(
      runtime.withAgentProfileLocks(['profile-a', 'profile-b'], () => {
        throw new Error('lock callback failed');
      }),
    ).rejects.toThrow('lock callback failed');
    await expect(
      runtime.withAgentProfileLocks(['profile-b', 'profile-a'], () => 'ok'),
    ).resolves.toBe('ok');
  });

  test('stops all workspace sibling and descendant runners', async () => {
    const folder = 'agent-profile-runtime-workspace';
    const now = new Date().toISOString();
    db.setRegisteredGroup('web:agent-profile-runtime-workspace', {
      name: 'Runtime Workspace',
      folder,
      added_at: now,
      executionMode: 'container',
      created_by: 'agent-profile-runtime-user',
    });
    db.setRegisteredGroup('feishu:runtime-channel', {
      name: 'Runtime Channel',
      folder,
      added_at: now,
      executionMode: 'container',
      created_by: 'agent-profile-runtime-user',
    });

    const stopGroup = vi.fn(async () => {});
    const deps = {
      queue: {
        listDescendantJids: (jid: string) =>
          jid === 'web:agent-profile-runtime-workspace'
            ? ['web:agent-profile-runtime-workspace#agent:a1']
            : ['feishu:runtime-channel#task:t1'],
        stopGroup,
      },
    } as unknown as Parameters<
      typeof runtime.stopWorkspaceRunnersForAgentIdentityChange
    >[0];

    const stopped = await runtime.stopWorkspaceRunnersForAgentIdentityChange(
      deps,
      folder,
      {
        primaryJid: 'web:agent-profile-runtime-workspace',
        reason: 'test identity change',
      },
    );

    expect(stopped.sort()).toEqual(
      [
        'feishu:runtime-channel',
        'feishu:runtime-channel#task:t1',
        'web:agent-profile-runtime-workspace',
        'web:agent-profile-runtime-workspace#agent:a1',
      ].sort(),
    );
    expect(stopGroup).toHaveBeenCalledTimes(4);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:agent-profile-runtime-workspace',
      { force: true },
    );
    expect(stopGroup).toHaveBeenCalledWith('feishu:runtime-channel', {
      force: true,
    });
    expect(stopGroup).toHaveBeenCalledWith(
      'web:agent-profile-runtime-workspace#agent:a1',
      { force: true },
    );
    expect(stopGroup).toHaveBeenCalledWith('feishu:runtime-channel#task:t1', {
      force: true,
    });
  });

  test('post-commit pass stops a runner that appeared after pass one', async () => {
    const folder = 'agent-profile-runtime-two-phase';
    const primaryJid = 'web:agent-profile-runtime-two-phase';
    db.setRegisteredGroup(primaryJid, {
      name: 'Two Phase Workspace',
      folder,
      added_at: new Date().toISOString(),
      created_by: 'agent-profile-runtime-user',
    });

    const events: string[] = [];
    let exposeRunnerStartedBetweenStopAndCommit = false;
    const stopGroup = vi.fn(async (jid: string) => {
      events.push(`stop:${jid}`);
      if (stopGroup.mock.calls.length === 1) {
        // Simulate a runner starting after pass one and reading the old DB
        // state. The post-commit collection must discover and stop it.
        exposeRunnerStartedBetweenStopAndCommit = true;
        events.push('runner-started-with-old-state');
      }
    });
    const deps = {
      queue: {
        pauseGroupsForMutation: (jids: string[]) => {
          events.push(`pause:${jids.join(',')}`);
          return { keys: ['two-phase'] };
        },
        resumeGroupsAfterMutation: () => events.push('resume'),
        listDescendantJids: () =>
          exposeRunnerStartedBetweenStopAndCommit
            ? [`${primaryJid}#agent:between-phases`]
            : [],
        stopGroup,
      },
    } as unknown as Parameters<
      typeof runtime.quiesceWorkspaceRunnersAroundCommit
    >[0];

    const result = await runtime.quiesceWorkspaceRunnersAroundCommit(
      deps,
      [{ folder, primaryJid }],
      { reason: 'test two-phase happens-before' },
      () => {
        events.push('commit-new-state');
        return 'committed';
      },
    );

    expect(result.value).toBe('committed');
    expect(result.runtimeJids.sort()).toEqual(
      [primaryJid, `${primaryJid}#agent:between-phases`].sort(),
    );
    expect(events).toEqual([
      `pause:${primaryJid}`,
      `stop:${primaryJid}`,
      'runner-started-with-old-state',
      'commit-new-state',
      `stop:${primaryJid}`,
      `stop:${primaryJid}#agent:between-phases`,
      'resume',
    ]);
    expect(stopGroup).toHaveBeenCalledWith(primaryJid, {
      force: true,
      preserveQueuedWork: true,
    });
  });

  test('pre-commit stop failure does not call commit', async () => {
    const commit = vi.fn(() => 'must-not-persist');
    const resumeGroupsAfterMutation = vi.fn();
    const deps = {
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['pre-failure'] }),
        resumeGroupsAfterMutation,
        listDescendantJids: () => [],
        stopGroup: vi.fn(async () => {
          throw new Error('injected pre-commit failure');
        }),
      },
    } as unknown as Parameters<
      typeof runtime.quiesceWorkspaceRunnersAroundCommit
    >[0];

    await expect(
      runtime.quiesceWorkspaceRunnersAroundCommit(
        deps,
        [
          {
            folder: 'pre-commit-failure',
            primaryJid: 'web:pre-commit-failure',
          },
        ],
        { reason: 'test pre failure' },
        commit,
      ),
    ).rejects.toMatchObject({ phase: 'pre_commit', persisted: false });
    expect(commit).not.toHaveBeenCalled();
    expect(resumeGroupsAfterMutation).toHaveBeenCalledTimes(1);
  });

  test('post-commit stop failure exposes the committed value', async () => {
    let stopCalls = 0;
    const resumeGroupsAfterMutation = vi.fn();
    const onPostCommitFailure = vi.fn();
    const deps = {
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['post-failure'] }),
        resumeGroupsAfterMutation,
        listDescendantJids: () => [],
        stopGroup: vi.fn(async () => {
          stopCalls += 1;
          if (stopCalls === 2) {
            throw new Error('injected post-commit failure');
          }
        }),
      },
    } as unknown as Parameters<
      typeof runtime.quiesceWorkspaceRunnersAroundCommit
    >[0];

    await expect(
      runtime.quiesceWorkspaceRunnersAroundCommit(
        deps,
        [
          {
            folder: 'post-commit-failure',
            primaryJid: 'web:post-commit-failure',
          },
        ],
        { reason: 'test post failure', onPostCommitFailure },
        () => ({ version: 2 }),
      ),
    ).rejects.toMatchObject({
      phase: 'post_commit',
      persisted: true,
      committedValue: { version: 2 },
    });
    expect(onPostCommitFailure).toHaveBeenCalledWith([
      'web:post-commit-failure',
    ]);
    expect(resumeGroupsAfterMutation).toHaveBeenCalledTimes(1);
  });
});
