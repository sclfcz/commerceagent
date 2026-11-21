import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-e2e-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const memoryStore = await import('../src/memory-store.js');
const memoryService = await import('../src/memory-service.js');
const candidateStore = await import('../src/memory-candidate-store.js');
const extraction = await import('../src/memory-extraction/index.js');
const consolidation = await import('../src/memory-consolidation/index.js');

const OWNER = 'e2e-owner';
const WORKSPACE_JID = 'web:e2e-memory';
const FOLDER = 'e2e-memory';
const CHAT_JID = WORKSPACE_JID;
const actor = { id: OWNER, role: 'admin' as const };

/** Relative to the real clock so snapshot/expiry comparisons stay coherent. */
const CLOCK = new Date();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const SETTINGS = {
  enabled: true,
  idleMs: 15 * MINUTE,
  ttlDays: 14,
  maxCandidates: 5,
  lessonMinConfidence: 0.7,
};

function register(): void {
  db.setRegisteredGroup(WORKSPACE_JID, {
    name: FOLDER,
    folder: FOLDER,
    added_at: CLOCK.toISOString(),
    created_by: OWNER,
    is_home: false,
  } as never);
}

async function createMemory(value: {
  kind?: 'fact' | 'decision' | 'lesson' | 'open_loop';
  title?: string;
  content: string;
  pinned?: boolean;
  importance?: number;
  searchKeys?: string[];
  expiresAt?: string;
}): Promise<memoryStore.WorkspaceMemoryItem> {
  const created = await memoryService.createWorkspaceMemory({
    actor,
    workspaceJid: WORKSPACE_JID,
    sourceType: 'web_user',
    kind: value.kind ?? 'fact',
    ...value,
  });
  return created.item;
}

async function snapshot(input: { query?: string; maxChars?: number } = {}) {
  return await memoryService.getWorkspaceMemorySnapshot({
    actor,
    workspaceJid: WORKSPACE_JID,
    query: input.query ?? null,
    limit: 12,
    maxChars: input.maxChars ?? 8000,
  });
}

async function memoryDatabase() {
  return await memoryStore.withWorkspaceMemoryDatabase((conn) => conn);
}

beforeAll(async () => {
  db.initDatabase();
  register();
  db.ensureChatExists(CHAT_JID);
  await memoryStore.initWorkspaceMemoryStore();
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Workspace Memory end to end', () => {
  test('extraction → confirm → recall → expiry → merge', async () => {
    // 1. Two messages, an hour idle, one fake model call.
    db.storeMessageDirect(
      'e2e-msg-1',
      CHAT_JID,
      'alice',
      'Alice',
      '我们决定客户退款统一在 7 天内处理，超时不再受理。',
      new Date(CLOCK.getTime() - 60 * MINUTE).toISOString(),
      false,
    );
    db.storeMessageDirect(
      'e2e-msg-2',
      CHAT_JID,
      'assistant',
      'Agent',
      '好的，已记录这条规则。',
      new Date(CLOCK.getTime() - 59 * MINUTE).toISOString(),
      true,
    );
    const llm = vi.fn(async () =>
      JSON.stringify({
        candidates: [
          {
            kind: 'decision',
            title: '退款政策',
            content: '客户退款需要在7天内提交申请，超时不处理',
            confidence: 0.92,
            importance: 0.7,
            evidence_message_ids: ['e2e-msg-1'],
          },
        ],
      }),
    );

    const extracted = await extraction.runMemoryExtractionForSession(
      {
        workspaceJid: WORKSPACE_JID,
        sessionKey: CHAT_JID,
        sessionId: 'session-e2e',
      },
      { llm, now: () => CLOCK, settings: SETTINGS },
    );
    expect(extracted).toMatchObject({ outcome: 'extracted', proposed: 1 });
    expect(llm).toHaveBeenCalledTimes(1);

    const proposed = await candidateStore.listProposedWorkspaceMemoryCandidates(
      { workspaceJid: WORKSPACE_JID },
    );
    expect(proposed).toHaveLength(1);
    const candidateId = proposed[0].item.id;

    // 2. A proposal is not memory yet: it is in no segment of the snapshot.
    const beforeConfirm = await snapshot({ query: '客户退款流程' });
    expect(beforeConfirm.items.map((entry) => entry.id)).not.toContain(
      candidateId,
    );
    expect(beforeConfirm.renderedText).not.toContain('7天内提交申请');

    // 3. Confirm turns it into an active, searchable memory.
    const confirmed = await memoryService.confirmWorkspaceMemoryCandidate({
      actor,
      workspaceJid: WORKSPACE_JID,
      sourceType: 'web_user',
      itemId: candidateId,
      expectedRevision: 1,
      idempotencyKey: 'e2e-confirm-1',
    });
    expect(confirmed.item).toMatchObject({ status: 'active', revision: 2 });
    expect(confirmed.item.searchKeys.length).toBeGreaterThan(0);

    const afterConfirm = await snapshot({
      query: '请问客户要退款的话流程是什么',
    });
    expect(afterConfirm.retrievalTrace.segments!.relevant.itemIds).toContain(
      candidateId,
    );
    expect(afterConfirm.renderedText).toContain('7天内提交申请');

    // 4. A pinned profile item is recalled without a query.
    const profile = await createMemory({
      title: '店铺画像',
      content: '本店主营轻奢女装，客单价 800 元',
      pinned: true,
      importance: 0.9,
    });
    const withProfile = await snapshot();
    expect(withProfile.retrievalTrace.segments!.profile.itemIds).toEqual([
      profile.id,
    ]);
    expect(withProfile.renderedText).toContain('pinned="true"');
    // The unpinned memory is delivered as ordinary context, never as profile.
    expect(withProfile.retrievalTrace.segments!.profile.itemIds).not.toContain(
      candidateId,
    );

    // 5. An open loop inside the proactive window is surfaced.
    const openLoop = await createMemory({
      kind: 'open_loop',
      title: '春季上新素材',
      content: '春季上新素材还没定稿，需要设计确认',
      expiresAt: new Date(CLOCK.getTime() + 1 * HOUR).toISOString(),
    });
    const withLoop = await snapshot();
    expect(withLoop.retrievalTrace.segments!.proactive.itemIds).toContain(
      openLoop.id,
    );

    // 6. The nightly worker demotes it once the window has passed.
    const database = await memoryDatabase();
    const demoteAt = new Date(CLOCK.getTime() + 2 * HOUR);
    const demoted = await consolidation.demoteExpiredBatch(database, {
      storeId: (await memoryStore.getWorkspaceMemoryStore(WORKSPACE_JID))!.id,
      limit: 50,
      now: demoteAt,
    });
    expect(demoted.demoted).toBe(1);

    const history = (
      await memoryStore.getWorkspaceMemoryItem(WORKSPACE_JID, openLoop.id)
    ).item;
    expect(history).toMatchObject({
      kind: 'fact',
      demotedFromKind: 'open_loop',
      pinned: false,
    });
    expect(history.demotedAt).not.toBeNull();

    // Out of profile/proactive after demotion...
    const afterDemotion = await snapshot();
    for (const segment of Object.values(
      afterDemotion.retrievalTrace.segments!,
    )) {
      expect(segment.itemIds).not.toContain(openLoop.id);
    }
    // ...but still answerable through relevant search.
    const searchHistory = await snapshot({ query: '春季上新素材的进度怎么样' });
    expect(searchHistory.retrievalTrace.segments!.relevant.itemIds).toContain(
      openLoop.id,
    );
    expect(
      searchHistory.retrievalTrace.segments!.profile.itemIds,
    ).not.toContain(openLoop.id);
    expect(
      searchHistory.retrievalTrace.segments!.proactive.itemIds,
    ).not.toContain(openLoop.id);

    // 7. The nightly merge folds two duplicates into one keeper, keys included.
    const keeper = await createMemory({
      content: '满三百减五十的优惠券可以叠加使用',
      importance: 0.9,
      searchKeys: ['优惠券', '叠加'],
    });
    const duplicate = await createMemory({
      content: '满三百减五十的优惠券可以叠加使用',
      importance: 0.3,
      searchKeys: ['优惠券', '满减'],
    });
    const merged = await consolidation.mergeDuplicateBatch(database, {
      storeId: (await memoryStore.getWorkspaceMemoryStore(WORKSPACE_JID))!.id,
      workspaceJid: WORKSPACE_JID,
      limit: 50,
      trigramAvailable:
        await consolidation.isTrigramSimilarityAvailable(database),
      now: demoteAt,
    });
    expect(merged.merged).toBe(1);

    const keeperAfter = (
      await memoryStore.getWorkspaceMemoryItem(WORKSPACE_JID, keeper.id)
    ).item;
    expect(keeperAfter.searchKeys).toEqual(['优惠券', '叠加', '满减']);
    expect(keeperAfter.revision).toBe(2);

    const keeperVersions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid: WORKSPACE_JID,
      itemId: keeper.id,
      limit: 10,
    });
    expect(keeperVersions.versions.map((version) => version.revision)).toEqual([
      2, 1,
    ]);
    expect(keeperVersions.versions[0]).toMatchObject({
      changeType: 'update',
      searchKeys: ['优惠券', '叠加', '满减'],
    });
    const duplicateVersions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid: WORKSPACE_JID,
      itemId: duplicate.id,
      limit: 10,
    });
    expect(duplicateVersions.versions[0]).toMatchObject({
      changeType: 'update',
      status: 'superseded',
      supersededBy: keeper.id,
    });
    expect(
      (await memoryStore.getWorkspaceMemoryItem(WORKSPACE_JID, duplicate.id))
        .item.status,
    ).toBe('superseded');

    // 8. One final query answers from all three ways at once.
    const finalSnapshot = await snapshot({
      query: '退款流程和优惠券叠加，还有春季上新素材进度',
    });
    const segments = finalSnapshot.retrievalTrace.segments!;
    expect(segments.profile.itemIds).toEqual([profile.id]);
    expect(segments.relevant.itemIds).toContain(candidateId);
    expect(segments.relevant.itemIds).toContain(keeper.id);
    expect(segments.relevant.itemIds).toContain(openLoop.id);
    // The superseded duplicate never appears in any segment.
    const allIds = finalSnapshot.items.map((entry) => entry.id);
    expect(allIds).not.toContain(duplicate.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
