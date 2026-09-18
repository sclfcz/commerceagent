import { describe, expect, test } from 'vitest';
import {
  memoryItemPath,
  memoryItemsPath,
  memoryKindCounts,
  memoryVersionsPath,
  revisionConflictFrom,
  type WorkspaceMemoryItem,
} from './model';

function memoryItem(
  kind: WorkspaceMemoryItem['kind'],
  id: string,
): WorkspaceMemoryItem {
  return {
    id,
    workspaceJid: 'workspace:alpha',
    kind,
    title: null,
    content: id,
    canonicalKey: null,
    status: 'active',
    importance: 0.5,
    confidence: 1,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    revision: 1,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    deletedAt: null,
    provenance: {
      sourceType: 'manual',
      sourceId: null,
      sessionId: null,
      observedAt: '2026-07-28T00:00:00.000Z',
    },
  };
}

describe('Workspace Memory v2 model', () => {
  test('builds routes from the encoded workspace JID and item ID', () => {
    expect(memoryItemsPath('workspace:alpha/beta')).toBe(
      '/api/memory/workspaces/workspace%3Aalpha%2Fbeta/items',
    );
    expect(memoryItemPath('workspace:alpha/beta', 'item/1')).toBe(
      '/api/memory/workspaces/workspace%3Aalpha%2Fbeta/items/item%2F1',
    );
    expect(memoryVersionsPath('workspace:alpha/beta', 'item/1')).toBe(
      '/api/memory/workspaces/workspace%3Aalpha%2Fbeta/items/item%2F1/versions',
    );
  });

  test('recognizes only the revision_conflict API shape', () => {
    expect(
      revisionConflictFrom({
        status: 409,
        message: 'conflict',
        body: {
          error: 'revision_conflict',
          currentRevision: 7,
          storeRevision: 12,
        },
      }),
    ).toEqual({ currentRevision: 7, storeRevision: 12 });
    expect(
      revisionConflictFrom({
        status: 409,
        message: 'other conflict',
        body: { error: 'duplicate_key' },
      }),
    ).toBeNull();
    expect(revisionConflictFrom({ status: 400 })).toBeNull();
  });

  test('counts all four workspace memory kinds independently', () => {
    expect(
      memoryKindCounts([
        memoryItem('fact', 'fact-1'),
        memoryItem('fact', 'fact-2'),
        memoryItem('decision', 'decision-1'),
        memoryItem('lesson', 'lesson-1'),
        memoryItem('open_loop', 'loop-1'),
      ]),
    ).toEqual({
      fact: 2,
      decision: 1,
      lesson: 1,
      open_loop: 1,
    });
  });
});
