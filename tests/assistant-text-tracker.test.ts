import { describe, expect, test } from 'vitest';
import { AssistantTextTracker } from '../container/agent-runner/src/utils.js';

// 每次 addContentBlocks 都代表一整条 top-level AssistantMessage。
describe('AssistantTextTracker', () => {
  const text = (value: string) => ({ type: 'text', text: value });
  const toolUse = () => ({ type: 'tool_use' });

  test('tool-free AssistantMessage joins all text blocks as one fallback candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('你好，'), text('这是回复。')]);

    expect(tracker.pickFinalText(null)).toBe('你好，这是回复。');
  });

  test('cross-message narration is discarded and a later tool-free message becomes the candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('我先检查 opencli 状态。'), toolUse()]);
    tracker.addContentBlocks([toolUse(), text('现在继续抓取 X 主页。')]);
    tracker.addContentBlocks([text('# 修正版调研报告\n\n'), text('完整结论…')]);

    expect(tracker.pickFinalText(null)).toBe('# 修正版调研报告\n\n完整结论…');
  });

  test('[text, tool_use] in the same message is narration, never a final fallback', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('让我先看看工作区。'), toolUse()]);

    expect(tracker.pickFinalText(null)).toBeNull();
  });

  test('[tool_use, text] in the same message is also narration', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([toolUse(), text('任务已经派出，正在等待。')]);

    expect(tracker.pickFinalText(null)).toBeNull();
  });

  test('interleaved text and tools in one message discards every text block', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([
      text('第一段过程。'),
      toolUse(),
      text('第二段过程。'),
      toolUse(),
      text('第三段过程。'),
    ]);

    expect(tracker.pickFinalText(undefined)).toBeNull();
  });

  test('non-empty SDK Result always overrides a different local candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('本地候选答案')]);

    expect(tracker.pickFinalText('SDK 权威答案')).toBe('SDK 权威答案');
  });

  test('does not fall back to the last narration when SDK Result is empty', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([
      text('三个调研任务已派出，等待完成。'),
      toolUse(),
    ]);

    expect(tracker.pickFinalText(null)).toBeNull();
    expect(tracker.pickFinalText('')).toBeNull();
  });

  test('a tool message does not corrupt an earlier valid tool-free candidate', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('完整候选答案')]);
    tracker.addContentBlocks([text('额外过程'), toolUse()]);

    expect(tracker.pickFinalText(null)).toBe('完整候选答案');
  });

  test('empty and whitespace-only messages do not create a candidate', () => {
    const tracker = new AssistantTextTracker();
    expect(tracker.pickFinalText(null)).toBeNull();
    tracker.addContentBlocks([]);
    tracker.addContentBlocks([text('\n\n  ')]);
    tracker.addContentBlocks([toolUse()]);

    expect(tracker.pickFinalText(undefined)).toBeNull();
  });

  test('addContentBlocks reports text presence independently from answer eligibility', () => {
    const tracker = new AssistantTextTracker();

    expect(tracker.addContentBlocks([toolUse()])).toBe(false);
    expect(tracker.addContentBlocks([toolUse(), text('过程旁白')])).toBe(true);
    expect(tracker.addContentBlocks([{ type: 'thinking' }])).toBe(false);
  });

  test('reset removes candidates from the previous mid-query turn', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('上一 turn 定稿。')]);
    tracker.reset();

    expect(tracker.pickFinalText(null)).toBeNull();
    tracker.addContentBlocks([text('新 turn 定稿。')]);
    expect(tracker.pickFinalText(null)).toBe('新 turn 定稿。');
  });
});
