import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-extraction-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: root,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const memoryStore = await import('../src/memory-store.js');
const candidateStore = await import('../src/memory-candidate-store.js');
const memoryService = await import('../src/memory-service.js');
const extraction = await import('../src/memory-extraction/index.js');
const { parseExtractionResponse } =
  await import('../src/memory-extraction/schema.js');
const {
  MEMORY_EXTRACTION_CANDIDATE_TTL_DAYS,
  MEMORY_EXTRACTION_MAX_CANDIDATES,
  MEMORY_EXTRACTION_LESSON_MIN_CONFIDENCE,
  MEMORY_EXTRACTION_RETRY_BACKOFF_MS,
} = await import('../src/memory-extraction/config.js');
const { containsSensitiveContent } =
  await import('../src/memory-extraction/filters.js');

const WORKSPACE_JID = 'web:extraction-a';
const FOLDER = 'extraction-a';
const CHAT_JID = WORKSPACE_JID;

const NOW = new Date('2026-11-16T12:00:00.000Z');
const IDLE_SETTINGS = {
  enabled: true,
  idleMs: 15 * 60 * 1000,
  ttlDays: MEMORY_EXTRACTION_CANDIDATE_TTL_DAYS,
  maxCandidates: MEMORY_EXTRACTION_MAX_CANDIDATES,
  lessonMinConfidence: MEMORY_EXTRACTION_LESSON_MIN_CONFIDENCE,
};

let messageSeq = 0;

function storeMessage(input: {
  content: string;
  isFromMe: boolean;
  minutesAgo: number;
  chatJid?: string;
  meta?: { sourceKind: 'scheduled_task_result'; taskId?: string | null };
}): { id: string; timestamp: string } {
  messageSeq += 1;
  const timestamp = new Date(
    NOW.getTime() - input.minutesAgo * 60 * 1000,
  ).toISOString();
  const id = `msg-${String(messageSeq).padStart(4, '0')}`;
  db.storeMessageDirect(
    id,
    input.chatJid ?? CHAT_JID,
    input.isFromMe ? 'assistant' : 'alice',
    input.isFromMe ? 'Agent' : 'Alice',
    input.content,
    timestamp,
    input.isFromMe,
    input.meta ? { meta: input.meta } : undefined,
  );
  return { id, timestamp };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'decision',
    title: 'Use SQLite for host state',
    content:
      'The team decided host state lives in SQLite so deployments stay single-binary.',
    confidence: 0.9,
    importance: 0.7,
    evidence_message_ids: [] as string[],
    ...overrides,
  };
}

function fakeLlm(payload: unknown) {
  return vi.fn(async () => JSON.stringify({ candidates: payload }));
}

function session() {
  return {
    workspaceJid: WORKSPACE_JID,
    sessionKey: CHAT_JID,
    sessionId: 'session-1',
  };
}

async function listItems(status = 'proposed') {
  const listed = await memoryStore.listWorkspaceMemoryItems({
    workspaceJid: WORKSPACE_JID,
    status: status as never,
    limit: 50,
  });
  return listed.items;
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(async () => {
  for (const chatJid of [CHAT_JID, 'web:extraction-b']) {
    db.deleteMessagesForChatJid(chatJid);
  }
  try {
    await memoryStore.deleteWorkspaceMemoryData(WORKSPACE_JID);
  } catch {
    // store did not exist yet
  }
  try {
    await db.deleteRegisteredGroup(WORKSPACE_JID);
  } catch {
    // absent
  }
  db.setRegisteredGroup(WORKSPACE_JID, {
    name: 'Extraction',
    folder: FOLDER,
    added_at: NOW.toISOString(),
    created_by: 'alice',
    is_home: false,
  } as never);
  db.ensureChatExists(CHAT_JID);
  // Cursors are keyed by workspace + chat JID rather than owned by the store,
  // so deleting workspace memory data does not clear them.
  await memoryStore.withWorkspaceMemoryDatabase(async (database) => {
    await database.query(
      'DELETE FROM workspace_memory_extraction_cursors WHERE workspace_jid = $1',
      [WORKSPACE_JID],
    );
    await database.query(
      'DELETE FROM workspace_memory_candidates WHERE workspace_jid = $1',
      [WORKSPACE_JID],
    );
  });
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Workspace Memory extraction', () => {
  test('idle session triggers one extraction and the cursor advances', async () => {
    storeMessage({
      content: '我们决定把主机状态放在 SQLite。',
      isFromMe: false,
      minutesAgo: 60,
    });
    const last = storeMessage({
      content: '已记录，后续实现按这个来。',
      isFromMe: true,
      minutesAgo: 59,
    });
    const llm = fakeLlm([candidate({ evidence_message_ids: [last.id] })]);

    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });

    expect(result.outcome).toBe('extracted');
    expect(result.proposed).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0]).toContain('[msg:');

    const cursor = await candidateStore.getWorkspaceMemoryExtractionCursor(
      WORKSPACE_JID,
      CHAT_JID,
    );
    expect(cursor).toMatchObject({
      lastMessageId: last.id,
      lastMessageTimestamp: last.timestamp,
      attemptCount: 0,
    });

    const candidates =
      await candidateStore.listProposedWorkspaceMemoryCandidates({
        workspaceJid: WORKSPACE_JID,
      });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      item: { status: 'proposed', kind: 'decision' },
      candidate: {
        state: 'pending',
        evidenceMessageIds: [last.id],
        runId: expect.stringMatching(/^mer_/),
      },
    });

    // A second run has nothing new past the cursor: no second model call.
    const rerunLlm = fakeLlm([candidate({ content: '应该不会发生的第二次' })]);
    const rerun = await extraction.runMemoryExtractionForSession(session(), {
      llm: rerunLlm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    expect(rerun.outcome).toBe('empty');
    expect(rerunLlm).not.toHaveBeenCalled();
  });

  test('a session that is still active is not extracted', async () => {
    storeMessage({ content: '刚说的一句话', isFromMe: false, minutesAgo: 1 });
    const llm = fakeLlm([candidate()]);
    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    expect(result.outcome).toBe('not_idle');
    expect(llm).not.toHaveBeenCalled();
  });

  test('schema-invalid output is discarded and the window is not retried', async () => {
    const last = storeMessage({
      content: '这里有一段可以提炼的内容。',
      isFromMe: false,
      minutesAgo: 60,
    });
    const llm = vi.fn(async () => 'not json at all');

    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    expect(result.outcome).toBe('invalid_output');
    expect(result.proposed).toBe(0);

    const cursor = await candidateStore.getWorkspaceMemoryExtractionCursor(
      WORKSPACE_JID,
      CHAT_JID,
    );
    expect(cursor?.lastMessageId).toBe(last.id);
    expect(await listItems()).toHaveLength(0);
  });

  test('secrets and personal data never become candidates', async () => {
    // Assembled at runtime so the literals do not look like real credentials to
    // secret scanners while still matching the filters that run on content.
    const fakeApiKey = ['sk', 'live', 'abcdef1234567890'].join('-');
    const fakeEmail = ['owner', 'example.com'].join('@');
    storeMessage({
      content: `我的 key 是 ${fakeApiKey}`,
      isFromMe: false,
      minutesAgo: 60,
    });
    expect(containsSensitiveContent(`token ${fakeApiKey}`)).toBe(true);
    expect(containsSensitiveContent(`联系 ${fakeEmail}`)).toBe(true);

    const llm = fakeLlm([
      candidate({ content: `API key is ${fakeApiKey} and must be reused.` }),
      candidate({ content: `Contact owner at ${fakeEmail} for access.` }),
      candidate({ content: '工作区使用 SQLite 存放主机状态。' }),
    ]);
    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });

    expect(result.outcome).toBe('extracted');
    expect(result.droppedSensitive).toBe(2);
    expect(result.proposed).toBe(1);
    const items = await listItems();
    expect(items).toHaveLength(1);
    expect(items[0].content).not.toContain(fakeApiKey);
    expect(items[0].content).not.toContain(fakeEmail);
  });

  test('candidates duplicating existing active memory are suppressed', async () => {
    storeMessage({
      content: '我们把主机状态放在 SQLite。',
      isFromMe: false,
      minutesAgo: 60,
    });
    await memoryStore.createWorkspaceMemoryItem({
      workspaceJid: WORKSPACE_JID,
      value: {
        kind: 'decision',
        title: 'Use SQLite for host state',
        content:
          'The team decided host state lives in SQLite so deployments stay single-binary.',
        status: 'active',
      },
      context: { actorId: 'alice', sourceType: 'web_user' },
    });

    const llm = fakeLlm([
      candidate(),
      candidate({
        title: '重复于本轮的另一条',
        content:
          'The team decided host state lives in SQLite so deployments stay single-binary.',
      }),
    ]);
    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });

    expect(result.outcome).toBe('no_candidates');
    expect(result.droppedDuplicate).toBe(2);
    expect(await listItems()).toHaveLength(0);
  });

  test('lessons need confidence and applicability, and only one fact is kept', async () => {
    storeMessage({
      content: '记一下这些经验。',
      isFromMe: false,
      minutesAgo: 60,
    });
    const llm = fakeLlm([
      candidate({
        kind: 'lesson',
        title: '低置信经验',
        content: '低置信度的经验不应写入。',
        confidence: 0.5,
        applies_when: '部署时',
      }),
      candidate({
        kind: 'lesson',
        title: '缺少适用条件',
        content: '缺少 applies_when 的经验不应写入。',
        confidence: 0.9,
      }),
      candidate({
        kind: 'fact',
        title: '事实一',
        content: '第一条会话事实。',
      }),
      candidate({
        kind: 'fact',
        title: '事实二',
        content: '第二条会话事实应被丢弃。',
      }),
    ]);
    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });

    expect(result.proposed).toBe(1);
    expect(result.droppedRule).toBe(3);
    const items = await listItems();
    expect(items.map((item) => item.title)).toEqual(['事实一']);
  });

  test('proposed candidates stay out of snapshots and search until confirmed', async () => {
    storeMessage({
      content: '把主机状态放在 SQLite。',
      isFromMe: false,
      minutesAgo: 60,
    });
    await extraction.runMemoryExtractionForSession(session(), {
      llm: fakeLlm([candidate({ content: 'SQLite 是工作区的唯一存储。' })]),
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    const [proposed] = await listItems();
    expect(proposed).toBeDefined();

    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor: { id: 'alice', role: 'member' },
      workspaceJid: WORKSPACE_JID,
    });
    expect(snapshot.items.map((item) => item.id)).not.toContain(proposed.id);
    const searched = await memoryService.searchWorkspaceMemory({
      actor: { id: 'alice', role: 'member' },
      workspaceJid: WORKSPACE_JID,
      query: 'SQLite',
    });
    expect(searched.hits.map((hit) => hit.item.id)).not.toContain(proposed.id);

    const listed = await memoryService.listWorkspaceMemoryCandidates({
      actor: { id: 'alice', role: 'member' },
      workspaceJid: WORKSPACE_JID,
    });
    expect(listed.candidates).toHaveLength(1);
  });

  test('confirmation uses CAS and a stale revision cannot overwrite a decision', async () => {
    storeMessage({
      content: '确认流程测试。',
      isFromMe: false,
      minutesAgo: 60,
    });
    await extraction.runMemoryExtractionForSession(session(), {
      llm: fakeLlm([candidate({ content: '这条会被确认。' })]),
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    const [proposed] = await listItems();
    const actor = { id: 'alice', role: 'member' as const };

    await expect(
      memoryService.confirmWorkspaceMemoryCandidate({
        actor,
        workspaceJid: WORKSPACE_JID,
        sourceType: 'web_user',
        itemId: proposed.id,
        expectedRevision: proposed.revision + 5,
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' });

    const confirmed = await memoryService.confirmWorkspaceMemoryCandidate({
      actor,
      workspaceJid: WORKSPACE_JID,
      sourceType: 'web_user',
      itemId: proposed.id,
      expectedRevision: proposed.revision,
      title: '确认后的标题',
    });
    expect(confirmed.item).toMatchObject({
      status: 'active',
      title: '确认后的标题',
      revision: proposed.revision + 1,
    });
    const metadata = await candidateStore.getWorkspaceMemoryCandidateMetadata(
      WORKSPACE_JID,
      proposed.id,
    );
    expect(metadata).toMatchObject({ state: 'confirmed', decidedBy: 'alice' });

    // Confirming twice is refused: the item is no longer a proposal.
    await expect(
      memoryService.confirmWorkspaceMemoryCandidate({
        actor,
        workspaceJid: WORKSPACE_JID,
        sourceType: 'web_user',
        itemId: proposed.id,
        expectedRevision: proposed.revision,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    // Rejecting an already-confirmed item is refused before any CAS.
    await expect(
      memoryService.rejectWorkspaceMemoryCandidate({
        actor,
        workspaceJid: WORKSPACE_JID,
        sourceType: 'web_user',
        itemId: proposed.id,
        expectedRevision: confirmed.item.revision,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('rejection writes a tombstone and records the decision', async () => {
    storeMessage({
      content: '拒绝流程测试。',
      isFromMe: false,
      minutesAgo: 60,
    });
    await extraction.runMemoryExtractionForSession(session(), {
      llm: fakeLlm([candidate({ content: '这条会被拒绝。' })]),
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    const [proposed] = await listItems();
    const actor = { id: 'alice', role: 'member' as const };
    const rejected = await memoryService.rejectWorkspaceMemoryCandidate({
      actor,
      workspaceJid: WORKSPACE_JID,
      sourceType: 'web_user',
      itemId: proposed.id,
      expectedRevision: proposed.revision,
    });
    expect(rejected.item.status).toBe('deleted');

    const metadata = await candidateStore.getWorkspaceMemoryCandidateMetadata(
      WORKSPACE_JID,
      proposed.id,
    );
    expect(metadata).toMatchObject({ state: 'rejected', decidedBy: 'alice' });
    expect(await listItems()).toHaveLength(0);
    expect(await listItems('active')).toHaveLength(0);
  });

  test('unconfirmed candidates expire after the 14-day TTL', async () => {
    const created = await candidateStore.createWorkspaceMemoryCandidate({
      workspaceJid: WORKSPACE_JID,
      sessionKey: CHAT_JID,
      sessionId: 'session-1',
      runId: 'mer_expiry',
      kind: 'fact',
      title: '过期候选',
      content: '这条候选一直没有被确认。',
      confidence: 0.8,
      importance: 0.5,
      ttlDays: MEMORY_EXTRACTION_CANDIDATE_TTL_DAYS,
      now: '2026-10-01T00:00:00.000Z',
    });
    const fresh = await candidateStore.createWorkspaceMemoryCandidate({
      workspaceJid: WORKSPACE_JID,
      sessionKey: CHAT_JID,
      sessionId: 'session-1',
      runId: 'mer_fresh',
      kind: 'fact',
      title: '未到期候选',
      content: '这条候选刚刚创建。',
      confidence: 0.8,
      importance: 0.5,
      ttlDays: MEMORY_EXTRACTION_CANDIDATE_TTL_DAYS,
      now: NOW.toISOString(),
    });

    const expired = await candidateStore.expireStaleWorkspaceMemoryCandidates({
      now: NOW.toISOString(),
    });
    expect(expired.expired).toBe(1);

    const stale = await memoryStore.getWorkspaceMemoryItem(
      WORKSPACE_JID,
      created.item.id,
    );
    expect(stale.item.status).toBe('superseded');
    const staleMetadata =
      await candidateStore.getWorkspaceMemoryCandidateMetadata(
        WORKSPACE_JID,
        created.item.id,
      );
    expect(staleMetadata?.state).toBe('expired');

    const untouched = await memoryStore.getWorkspaceMemoryItem(
      WORKSPACE_JID,
      fresh.item.id,
    );
    expect(untouched.item.status).toBe('proposed');
  });

  test('transport failures back off and keep the cursor for a retry', async () => {
    const last = storeMessage({
      content: '模型调用会失败。',
      isFromMe: false,
      minutesAgo: 60,
    });
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });

    let result = await extraction.runMemoryExtractionForSession(session(), {
      llm: failing,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    expect(result.outcome).toBe('model_failed');

    const cursor = await candidateStore.getWorkspaceMemoryExtractionCursor(
      WORKSPACE_JID,
      CHAT_JID,
    );
    expect(cursor).toMatchObject({
      attemptCount: 1,
      lastError: 'model_call_failed',
    });
    expect(cursor?.lastMessageId).toBeNull();

    // Two more failures trip the backoff window.
    const later = new Date(NOW.getTime() + 60 * 1000);
    await extraction.runMemoryExtractionForSession(session(), {
      llm: failing,
      now: () => later,
      settings: IDLE_SETTINGS,
    });
    const evenLater = new Date(later.getTime() + 60 * 1000);
    await extraction.runMemoryExtractionForSession(session(), {
      llm: failing,
      now: () => evenLater,
      settings: IDLE_SETTINGS,
    });

    const attempts = await candidateStore.getWorkspaceMemoryExtractionCursor(
      WORKSPACE_JID,
      CHAT_JID,
    );
    expect(attempts?.attemptCount).toBe(3);

    const blocked = await extraction.runMemoryExtractionForSession(session(), {
      llm: vi.fn(async () => JSON.stringify({ candidates: [] })),
      now: () =>
        new Date(evenLater.getTime() + MEMORY_EXTRACTION_RETRY_BACKOFF_MS / 2),
      settings: IDLE_SETTINGS,
    });
    expect(blocked.outcome).toBe('backoff');

    // Once the backoff elapses the same window is retried and the cursor moves.
    const recovered = await extraction.runMemoryExtractionForSession(
      session(),
      {
        llm: fakeLlm([]),
        now: () =>
          new Date(
            evenLater.getTime() + MEMORY_EXTRACTION_RETRY_BACKOFF_MS + 1,
          ),
        settings: IDLE_SETTINGS,
      },
    );
    expect(recovered.outcome).toBe('no_candidates');
    const advanced = await candidateStore.getWorkspaceMemoryExtractionCursor(
      WORKSPACE_JID,
      CHAT_JID,
    );
    expect(advanced).toMatchObject({
      attemptCount: 0,
      lastMessageId: last.id,
      lastError: null,
    });
  });

  test('non-human windows never trigger extraction', async () => {
    storeMessage({ content: '定时任务结果', isFromMe: true, minutesAgo: 90 });
    storeMessage({
      content: 'Runner 继续输出',
      isFromMe: true,
      minutesAgo: 60,
    });
    const llm = fakeLlm([candidate()]);
    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });
    expect(result.outcome).toBe('no_human_message');
    expect(llm).not.toHaveBeenCalled();
  });

  test('scheduled task results never enter the extraction transcript', async () => {
    storeMessage({
      content: '售后口径按定稿版本对外。',
      isFromMe: false,
      minutesAgo: 90,
    });
    const answer = storeMessage({
      content: '已按定稿口径输出，未定项单独列出。',
      isFromMe: true,
      minutesAgo: 89,
    });
    // The terminal summary row of a scheduled run: `task_id` is NULL, so only
    // the source-kind filter can keep it out of the transcript.
    storeMessage({
      content: '## 定时任务执行完成：本次只提交待确认候选',
      isFromMe: true,
      minutesAgo: 60,
      meta: { sourceKind: 'scheduled_task_result' },
    });
    const llm = fakeLlm([]);

    const result = await extraction.runMemoryExtractionForSession(session(), {
      llm,
      now: () => NOW,
      settings: IDLE_SETTINGS,
    });

    expect(result.outcome).toBe('no_candidates');
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0]).not.toContain('定时任务执行完成');
    const cursor = await candidateStore.getWorkspaceMemoryExtractionCursor(
      WORKSPACE_JID,
      CHAT_JID,
    );
    expect(cursor?.lastMessageId).toBe(answer.id);
  });
});

describe('extraction response parser', () => {
  test('keeps the first complete object when prose with braces follows it', () => {
    const raw = [
      '```json',
      JSON.stringify({ candidates: [candidate()] }),
      '```',
      '说明：上面的 {candidates} 字段已经按格式输出。',
    ].join('\n');
    const parsed = parseExtractionResponse(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.candidates).toHaveLength(1);
  });

  test('tolerates trailing commas emitted by the model', () => {
    const raw =
      '{"candidates":[{"kind":"decision","title":"t","content":"c","confidence":0.9,"importance":0.5,"evidence_message_ids":[],},],}';
    const parsed = parseExtractionResponse(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.candidates[0]?.title).toBe('t');
  });

  test('leaves comma-before-bracket text inside string values untouched', () => {
    const raw =
      '{"candidates":[{"kind":"decision","title":"t","content":"示例 {\\"a\\": 1,} 和 [1, ]","confidence":0.9,"importance":0.5,"evidence_message_ids":[],},],}';
    const parsed = parseExtractionResponse(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.candidates[0]?.content).toBe('示例 {"a": 1,} 和 [1, ]');
    }
  });

  test('does not echo response content in the rejection reason', () => {
    const secret = '不该出现在错误信息里的对话内容';
    const parsed = parseExtractionResponse(`前缀 ${secret} {"candidates": [}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('response is not valid JSON');
      expect(parsed.reason).not.toContain(secret);
    }
  });
});
