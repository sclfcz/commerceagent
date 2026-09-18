import { describe, expect, test } from 'vitest';

import {
  anchorAgentProfileToUserTurn,
  resolveAgentTurnAnchor,
} from '../container/agent-runner/src/agent-turn-contract.js';
import { prepareMessageStreamText } from '../container/agent-runner/src/message-stream-text.js';

const anchor = resolveAgentTurnAnchor(
  {
    id: 'image-agent',
    name: '图片助手',
    version: 1,
    identityHash: 'hash',
    identityPrompt: '分析用户图片。',
  },
  'custom',
);
const decorate = (text: string) => anchorAgentProfileToUserTurn(anchor, text);

describe('Agent turn anchor at the SDK message boundary', () => {
  test('decorates a real text follow-up after MessageStream processing', () => {
    const content = prepareMessageStreamText({
      text: '用户输入',
      originalImageCount: 0,
      validImageCount: 0,
      maxImageDimension: 8_000,
      decorateText: decorate,
      now: new Date('2026-07-22T00:00:00Z'),
    });
    expect(content).toContain('<active-agent-turn-contract');
    expect(content).toContain(
      '<current-user-message>\n用户输入\n</current-user-message>',
    );
  });

  test('preserves the all-images-dropped fallback before decorating', () => {
    const content = prepareMessageStreamText({
      text: '',
      originalImageCount: 1,
      validImageCount: 0,
      maxImageDimension: 8_000,
      decorateText: decorate,
      now: new Date('2026-07-22T00:00:00Z'),
    });
    expect(content).toContain('<active-agent-turn-contract');
    expect(content).toContain('用户发送了 1 张图片');
    expect(content).toContain('请提示用户压缩或截取后重发');
  });
});
