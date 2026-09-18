import { describe, expect, test } from 'vitest';

import {
  buildPostMdFallback,
  FEISHU_POST_MD_NODE_MAX_BYTES,
  splitFeishuPostMarkdown,
} from '../src/feishu.js';

describe('Feishu post Markdown node splitting', () => {
  test('keeps a 4KB-class CJK answer in one physical post with bounded md nodes', () => {
    const text = Array.from(
      { length: 44 },
      (_, index) =>
        `${index + 1}. 工作方式：把 Agent 放进真实协作流程，保留上下文、链接与明确的下一步。`,
    ).join('\n');

    const payload = JSON.parse(buildPostMdFallback(text)) as {
      zh_cn: { content: Array<Array<{ tag: string; text: string }>> };
    };
    const nodes = payload.zh_cn.content.flat();

    expect(Buffer.byteLength(text)).toBeGreaterThan(4_000);
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((node) => node.tag === 'md')).toBe(true);
    expect(
      nodes.every(
        (node) => Buffer.byteLength(node.text) <= FEISHU_POST_MD_NODE_MAX_BYTES,
      ),
    ).toBe(true);
    expect(nodes.map((node) => node.text).join('')).toContain(
      '把 Agent 放进真实协作流程',
    );
  });

  test('does not split Unicode code points or ordinary Markdown links', () => {
    const link = '[飞书文档](https://example.com/docs?id=123&source=commerceagent)';
    const chunks = splitFeishuPostMarkdown(
      `${'总结🙂'.repeat(500)}\n${link}\n${'下一步🚀'.repeat(500)}`,
      900,
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 900)).toBe(true);
    expect(chunks.join('')).toContain(link);
    expect(chunks.join('')).not.toContain('\uFFFD');
  });

  test('balances fenced code blocks in every independently rendered node', () => {
    const chunks = splitFeishuPostMarkdown(
      [
        '```ts',
        ...Array.from({ length: 120 }, () => 'const value = "你好";'),
        '```',
      ].join('\n'),
      512,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(512);
    }
  });
});
