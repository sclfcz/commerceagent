import { describe, expect, test } from 'vitest';

import {
  collectKnownReferenceAttachmentIndexes,
  collectReferencedMessageIds,
  formatMessages,
  splitLegacyEmbeddedReferenceContent,
} from '../src/message-prompt.js';
import type { NewMessage } from '../src/types.js';

function replyMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'om_current',
    chat_jid: 'web:main#agent:agent-1',
    source_jid: 'feishu:oc_chat#thread:omt_topic#root:om_root',
    sender: 'ou_user',
    sender_name: 'Alice',
    content: '重新调研',
    timestamp: '2026-07-28T03:23:06.358Z',
    channel_context: {
      schemaVersion: 1,
      provider: 'feishu',
      channelAccountId: null,
      sourceJid: 'feishu:oc_chat#thread:omt_topic#root:om_root',
      chat: { id: 'oc_chat', type: 'group' },
      message: {
        id: 'om_current',
        rootId: 'om_root',
        parentId: 'om_root',
        threadId: 'omt_topic',
        referencedMessages: [
          {
            id: 'om_root',
            sender: 'Alice',
            text: 'https://example.test 深度调研',
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('message prompt projection', () => {
  test('keeps reply bodies when the referenced message is outside this session', () => {
    const prompt = formatMessages([replyMessage()]);

    expect(prompt).toContain('id="om_current"');
    expect(prompt).toContain('reply_to="om_root"');
    expect(prompt).toContain('<referenced_messages>');
    expect(prompt).toContain('https://example.test 深度调研');
    expect(prompt).toContain('重新调研');
  });

  test('uses only structural reply metadata when history already contains the target', () => {
    const prompt = formatMessages([replyMessage()], {
      knownMessageIds: new Set(['om_root']),
    });

    expect(prompt).toContain('reply_to="om_root"');
    expect(prompt).toContain('重新调研');
    expect(prompt).not.toContain('<referenced_messages>');
    expect(prompt).not.toContain('https://example.test 深度调研');
  });

  test('retains materialized attachment hints without duplicating known text', () => {
    const message = replyMessage();
    message.channel_context!.message.referencedMessages![0].attachmentHints = [
      '[引用图片: inbound/quoted.png]',
    ];
    message.channel_context!.message.referencedMessages![0].attachmentIndexes =
      [1];
    const prompt = formatMessages([message], {
      knownMessageIds: new Set(['om_root']),
    });

    expect(prompt).toContain('[引用图片: inbound/quoted.png]');
    expect(prompt).not.toContain('https://example.test 深度调研');
  });

  test('identifies quoted image bytes that an active session already has', () => {
    const message = replyMessage();
    message.channel_context!.message.referencedMessages![0].attachmentIndexes =
      [1, 3, -1, 1.5];

    expect([
      ...collectKnownReferenceAttachmentIndexes(message, new Set(['om_root'])),
    ]).toEqual([1, 3]);
    expect([
      ...collectKnownReferenceAttachmentIndexes(
        message,
        new Set(['om_elsewhere']),
      ),
    ]).toEqual([]);
  });

  test('deduplicates a reference to an earlier message in the same pending batch', () => {
    const root = replyMessage({
      id: 'om_root',
      content: '原始任务',
      channel_context: undefined,
    });
    const prompt = formatMessages([root, replyMessage()]);

    expect(prompt.match(/原始任务/g)).toHaveLength(1);
    expect(prompt).not.toContain('<referenced_messages>');
  });

  test('collects stable provider IDs for persistence-based deduplication', () => {
    expect([...collectReferencedMessageIds([replyMessage()])]).toEqual([
      'om_root',
    ]);
  });

  test('recognizes only the exact legacy embedded-reference envelope', () => {
    expect(
      splitLegacyEmbeddedReferenceContent(
        '[引用消息链（最早到最近）]\n- Alice: 原始任务\n[当前消息]\n重新调研',
      ),
    ).toEqual({
      referenceText: '- Alice: 原始任务',
      currentContent: '重新调研',
    });
    expect(splitLegacyEmbeddedReferenceContent('普通消息')).toBeNull();
  });
});
