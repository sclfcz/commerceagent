import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-builder-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: dataDir,
}));

const db = await import('../src/db.js');
const builder = await import('../src/agent-builder.js');
const webContext = await import('../src/web-context.js');

const userId = 'agent-builder-owner';
const actor = (turn: string, content: string = turn) => ({
  user: db.getUserById(userId)!,
  sourceGroup: 'agent-builder-home',
  sourceChatJid: 'web:agent-builder-home',
  sourceTurnId: turn,
  sourceMessageContent: content,
});
const definition = (name: string) => ({
  name,
  prompt_schema_version: 2 as const,
  identity_prompt: `${name} identity`,
  soul_prompt: 'Be direct and evidence-driven.',
  agents_prompt: 'Review the requested code and report findings by severity.',
  tools_prompt: 'Use the tools needed to inspect, test, and explain the code.',
  prompt_mode: 'append' as const,
  runtime_policy: {
    context: {
      source: 'managed' as const,
      auto_compact_window: 0,
      auto_compact_percentage: 0,
    },
    skills: { mode: 'inherit' as const, ids: [] },
    mcp: { mode: 'inherit' as const, ids: [] },
  },
});

beforeAll(() => {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: userId,
    username: userId,
    password_hash: 'hash',
    display_name: 'Builder Owner',
    role: 'admin',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('conversational Agent Builder', () => {
  test('requires meaningful IDENTITY and AGENTS while allowing optional sections to be empty', () => {
    expect(() =>
      builder.prepareAgentBuilderDraft(actor('turn-sparse-identity'), {
        definition: {
          ...definition('Sparse Identity'),
          identity_prompt: '',
        },
      }),
    ).toThrow('substantive identity_prompt');

    expect(() =>
      builder.prepareAgentBuilderDraft(actor('turn-sparse-agents'), {
        definition: {
          ...definition('Sparse Agents'),
          agents_prompt: '   ',
        },
      }),
    ).toThrow('substantive agents_prompt');

    const prepared = builder.prepareAgentBuilderDraft(
      actor('turn-optional-sections'),
      {
        definition: {
          ...definition('Focused Utility'),
          soul_prompt: '',
          tools_prompt: '',
        },
      },
    );
    expect(prepared.draft.definition).toMatchObject({
      identity_prompt: 'Focused Utility identity',
      soul_prompt: '',
      agents_prompt:
        'Review the requested code and report findings by severity.',
      tools_prompt: '',
    });
  });

  test('persists a preview and requires confirmation in a later user turn', async () => {
    const prepared = builder.prepareAgentBuilderDraft(actor('turn-1'), {
      definition: definition('Code Review'),
      assumptions: ['Review correctness, architecture and missing tests.'],
    });

    expect(prepared.preview).toMatchObject({
      operation: 'create',
      confirmation_required: true,
      affected_workspaces: 0,
    });
    expect(prepared.preview.confirmation_phrase).toMatch(
      /^确认发布 AGENT-[0-9A-F]{8}$/,
    );
    expect(prepared.draft.state).toBe('ready');
    expect(
      builder.listAgentProfilesForBuilder(userId).ready_drafts,
    ).toContainEqual(
      expect.objectContaining({
        id: prepared.draft.id,
        revision: prepared.draft.revision,
        name: 'Code Review',
      }),
    );
    expect(
      builder.getAgentBuilderDraftForBuilder(userId, prepared.draft.id)
        .definition.name,
    ).toBe('Code Review');

    await expect(
      builder.publishAgentBuilderDraft(
        actor('turn-1'),
        prepared.draft.id,
        prepared.draft.revision,
      ),
    ).rejects.toThrow('later human message');

    await expect(
      builder.publishAgentBuilderDraft(
        actor('turn-2', '确认'),
        prepared.draft.id,
        prepared.draft.revision,
      ),
    ).rejects.toThrow('containing exactly');

    const published = await builder.publishAgentBuilderDraft(
      actor('turn-2', prepared.preview.confirmation_phrase),
      prepared.draft.id,
      prepared.draft.revision,
    );
    expect(published.profile).toMatchObject({
      id: prepared.draft.id,
      name: 'Code Review',
      is_default: false,
    });
    expect(published.draft.state).toBe('published');
    expect(
      builder.listAgentProfilesForBuilder(userId).ready_drafts,
    ).not.toContainEqual(expect.objectContaining({ id: prepared.draft.id }));
  });

  test('updates an existing Agent with profile and draft CAS checks', async () => {
    const existing = db.createAgentProfile({
      ownerUserId: userId,
      name: 'Researcher',
      agentsPrompt: 'Research carefully.',
    });
    const prepared = builder.prepareAgentBuilderDraft(actor('turn-3'), {
      targetAgentProfileId: existing.id,
      expectedAgentVersion: existing.version,
      definition: definition('Senior Researcher'),
    });
    expect(prepared.preview.operation).toBe('update');

    expect(() =>
      builder.prepareAgentBuilderDraft(actor('turn-4'), {
        draftId: prepared.draft.id,
        expectedDraftRevision: prepared.draft.revision + 1,
        definition: definition('Stale Draft'),
      }),
    ).toThrow('revision conflict');

    const published = await builder.publishAgentBuilderDraft(
      actor('turn-4', prepared.preview.confirmation_phrase),
      prepared.draft.id,
      prepared.draft.revision,
    );
    expect(published.profile.name).toBe('Senior Researcher');
    expect(published.profile.version).toBe(existing.version + 1);
  });

  test('rejects the retired tool security mode from draft definitions', () => {
    expect(() =>
      builder.prepareAgentBuilderDraft(actor('turn-5'), {
        definition: {
          ...definition('Legacy Policy'),
          runtime_policy: {
            ...definition('Legacy Policy').runtime_policy,
            tools: { mode: 'readonly' },
          },
        },
      }),
    ).toThrow('Agent definition is invalid');
  });

  test('rejects custom host Skills without a selection', () => {
    expect(() =>
      builder.prepareAgentBuilderDraft(actor('turn-empty-host-skills'), {
        definition: {
          ...definition('Empty Host Skills'),
          runtime_policy: {
            ...definition('Empty Host Skills').runtime_policy,
            skills: {
              mode: 'inherit',
              ids: [],
              host: { mode: 'custom', ids: [] },
            },
          },
        },
      }),
    ).toThrow('Custom host skills require at least one selected skill');
  });

  test('handles concurrent duplicate publication idempotently', async () => {
    const prepared = builder.prepareAgentBuilderDraft(
      actor('turn-concurrent'),
      {
        definition: definition('Concurrent Review Agent'),
      },
    );
    const confirmed = actor(
      'turn-concurrent-confirm',
      prepared.preview.confirmation_phrase,
    );
    const [first, second] = await Promise.all([
      builder.publishAgentBuilderDraft(
        confirmed,
        prepared.draft.id,
        prepared.draft.revision,
      ),
      builder.publishAgentBuilderDraft(
        confirmed,
        prepared.draft.id,
        prepared.draft.revision,
      ),
    ]);
    expect(first.profile.id).toBe(prepared.draft.id);
    expect(second.profile.id).toBe(prepared.draft.id);
    expect(first.profile.version).toBe(second.profile.version);
    expect(
      db
        .listAgentProfilesForUser(userId)
        .filter((profile) => profile.name === 'Concurrent Review Agent'),
    ).toHaveLength(1);
  });

  test('fails closed after a persisted runtime cleanup error and repairs on retry', async () => {
    const existing = db.createAgentProfile({
      ownerUserId: userId,
      name: 'Runtime Review Agent',
      agentsPrompt: 'Review carefully.',
    });
    const folder = 'agent-builder-runtime-repair';
    const jid = `web:${folder}`;
    db.setRegisteredGroup(jid, {
      name: 'Agent Builder Runtime Repair',
      folder,
      added_at: new Date().toISOString(),
      created_by: userId,
    });
    db.assignWorkspaceAgentProfile(folder, existing.id);

    let stopCalls = 0;
    let runtimeSafetyBlocked = false;
    webContext.setWebDeps({
      queue: {
        pauseGroupsForMutation: () => ({ keys: [folder] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup: async () => {
          stopCalls += 1;
          if (stopCalls === 2) throw new Error('injected post-commit failure');
        },
        blockGroupsForRuntimeSafety: () => {
          runtimeSafetyBlocked = true;
        },
        unblockGroupsForRuntimeSafety: () => {
          runtimeSafetyBlocked = false;
        },
        isGroupRuntimeSafetyBlocked: () => runtimeSafetyBlocked,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const prepared = builder.prepareAgentBuilderDraft(actor('turn-6'), {
      targetAgentProfileId: existing.id,
      expectedAgentVersion: existing.version,
      definition: definition('Runtime Review Agent v2'),
    });
    const confirmedActor = actor(
      'turn-7',
      prepared.preview.confirmation_phrase,
    );
    await expect(
      builder.publishAgentBuilderDraft(
        confirmedActor,
        prepared.draft.id,
        prepared.draft.revision,
      ),
    ).rejects.toThrow('published but runtime cleanup failed');
    expect(runtimeSafetyBlocked).toBe(true);
    expect(db.getAgentProfileForUser(existing.id, userId)?.name).toBe(
      'Runtime Review Agent v2',
    );

    const repaired = await builder.publishAgentBuilderDraft(
      actor('turn-8', prepared.preview.confirmation_phrase),
      prepared.draft.id,
      prepared.draft.revision,
    );
    expect(repaired.profile.version).toBe(existing.version + 1);
    expect(repaired.invalidated_runtime_jids).toBe(1);
    expect(stopCalls).toBe(4);
    expect(runtimeSafetyBlocked).toBe(false);
  });
});
