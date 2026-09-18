import { describe, expect, test } from 'vitest';
import {
  evaluateMentionGate,
  stripLeadingBotMention,
  type MentionGateInput,
  type MentionGateMention,
} from '../src/feishu-mention-gate.js';

const BOT_OPEN_ID = 'ou_bot_xyz';
const SENDER = 'ou_user_abc';
const OWNER = 'ou_owner_def';
const CHAT = 'feishu:oc_test';

function mention(openId: string): MentionGateMention {
  return { id: { open_id: openId } };
}

function input(overrides: Partial<MentionGateInput> = {}): MentionGateInput {
  return {
    chatType: 'group',
    botOpenId: BOT_OPEN_ID,
    mentions: undefined,
    chatJid: CHAT,
    senderOpenId: SENDER,
    shouldProcessGroupMessage: () => false, // 默认 require_mention
    isGroupOwnerMessage: undefined,
    ...overrides,
  };
}

describe('evaluateMentionGate', () => {
  test('p2p 私聊一律放行（即便没有 botOpenId 也不进入 mention 检查）', () => {
    const decision = evaluateMentionGate(
      input({ chatType: 'p2p', botOpenId: '' }),
    );
    expect(decision).toEqual({ allow: true });
  });

  test('disabled plan is a hard stop even for p2p and mentioned messages', () => {
    expect(
      evaluateMentionGate(
        input({
          chatType: 'p2p',
          mentions: [mention(BOT_OPEN_ID)],
          conversationPlan: {
            disabled: true,
            allowWithoutMention: false,
          },
        }),
      ),
    ).toEqual({ allow: false, reason: 'disabled' });
  });

  test('an active topic plan allows a follow-up without another mention', () => {
    expect(
      evaluateMentionGate(
        input({
          mentions: undefined,
          conversationPlan: {
            disabled: false,
            allowWithoutMention: true,
          },
        }),
      ),
    ).toEqual({ allow: true });
  });

  test('未传 shouldProcessGroupMessage 时直接放行（视作"无门控"）', () => {
    const decision = evaluateMentionGate(
      input({ shouldProcessGroupMessage: undefined, botOpenId: '' }),
    );
    expect(decision).toEqual({ allow: true });
  });

  test('always 模式（shouldProcessGroupMessage 返回 true）一律放行，连 mention 都不查', () => {
    const decision = evaluateMentionGate(
      input({
        shouldProcessGroupMessage: () => true,
        botOpenId: '', // 即便 botOpenId 缺失也不影响
        mentions: undefined,
      }),
    );
    expect(decision).toEqual({ allow: true });
  });

  test('require_mention 模式 + bot 被 @ → 放行', () => {
    const decision = evaluateMentionGate(
      input({ mentions: [mention('ou_other'), mention(BOT_OPEN_ID)] }),
    );
    expect(decision).toEqual({ allow: true });
  });

  test('require_mention 模式 + bot 没被 @ → reject:not_mentioned', () => {
    const decision = evaluateMentionGate(
      input({ mentions: [mention('ou_other')] }),
    );
    expect(decision).toEqual({ allow: false, reason: 'not_mentioned' });
  });

  test('require_mention 模式 + mentions 数组缺失 → reject:not_mentioned（不会 NPE）', () => {
    const decision = evaluateMentionGate(input({ mentions: undefined }));
    expect(decision).toEqual({ allow: false, reason: 'not_mentioned' });
  });

  // 这是核心回归 case：历史 bug 是这里 fail-open，现在必须 fail-closed。
  test('require_mention 模式 + botOpenId 缺失 → reject:bot_open_id_missing（fail-closed，禁止再 fall back 到放行）', () => {
    const decision = evaluateMentionGate(
      input({
        botOpenId: '',
        mentions: [mention('ou_anyone')], // 即便有 mentions 也不能假装匹配
      }),
    );
    expect(decision).toEqual({
      allow: false,
      reason: 'bot_open_id_missing',
    });
  });

  test('botOpenId 缺失但 always 模式优先：always 短路，仍然放行', () => {
    const decision = evaluateMentionGate(
      input({
        botOpenId: '',
        shouldProcessGroupMessage: () => true,
      }),
    );
    expect(decision).toEqual({ allow: true });
  });

  test('owner_mentioned 模式：bot 被 @ + sender 是 owner → 放行', () => {
    const decision = evaluateMentionGate(
      input({
        senderOpenId: OWNER,
        mentions: [mention(BOT_OPEN_ID)],
        isGroupOwnerMessage: (_chat, sender) => sender === OWNER,
      }),
    );
    expect(decision).toEqual({ allow: true });
  });

  test('owner_mentioned 模式：bot 被 @ 但 sender 不是 owner → reject:not_owner', () => {
    const decision = evaluateMentionGate(
      input({
        senderOpenId: SENDER,
        mentions: [mention(BOT_OPEN_ID)],
        isGroupOwnerMessage: (_chat, sender) => sender === OWNER,
      }),
    );
    expect(decision).toEqual({ allow: false, reason: 'not_owner' });
  });

  test('owner_mentioned 模式：bot 没被 @ → 优先返回 not_mentioned，不进 owner 判断', () => {
    let ownerCalled = false;
    const decision = evaluateMentionGate(
      input({
        mentions: [mention('ou_other')],
        isGroupOwnerMessage: () => {
          ownerCalled = true;
          return true;
        },
      }),
    );
    expect(decision).toEqual({ allow: false, reason: 'not_mentioned' });
    expect(ownerCalled).toBe(false);
  });

  test('shouldProcessGroupMessage 收到的 chatJid / senderOpenId 与输入一致', () => {
    let seen: { chatJid?: string; sender?: string } = {};
    evaluateMentionGate(
      input({
        senderOpenId: SENDER,
        shouldProcessGroupMessage: (chatJid, sender) => {
          seen = { chatJid, sender };
          return true;
        },
      }),
    );
    expect(seen).toEqual({ chatJid: CHAT, sender: SENDER });
  });
});

describe('stripLeadingBotMention', () => {
  const mentions = [
    { name: 'Happy Claw', id: { open_id: BOT_OPEN_ID } },
    { name: 'Alice', id: { open_id: 'ou_alice' } },
  ];

  test('strips the trusted leading bot mention before an exact confirmation phrase', () => {
    expect(
      stripLeadingBotMention(
        '@Happy Claw  确认发布 AGENT-A1B2C3D4',
        BOT_OPEN_ID,
        mentions,
      ),
    ).toBe('确认发布 AGENT-A1B2C3D4');
  });

  test('does not strip another user mention or a non-leading bot mention', () => {
    expect(
      stripLeadingBotMention('@Alice 确认发布', BOT_OPEN_ID, mentions),
    ).toBe('@Alice 确认发布');
    expect(
      stripLeadingBotMention('请 @Happy Claw 确认发布', BOT_OPEN_ID, mentions),
    ).toBe('请 @Happy Claw 确认发布');
    expect(stripLeadingBotMention('@Happy Claw', BOT_OPEN_ID, mentions)).toBe(
      '@Happy Claw',
    );
  });
});
