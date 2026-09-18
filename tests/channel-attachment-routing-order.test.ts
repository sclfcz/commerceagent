import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

function section(source: string, start: string, end?: string): string {
  const from = source.indexOf(start);
  expect(from, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  expect(to, `missing section end ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

function expectRouteBefore(
  source: string,
  sideEffects: string[],
  gate?: string,
): void {
  const route = source.indexOf('resolveAdmittedChannelRoute(');
  expect(route).toBeGreaterThanOrEqual(0);
  if (gate) expect(source.indexOf(gate)).toBeLessThan(route);
  for (const effect of sideEffects) {
    const index = source.indexOf(effect);
    expect(index, `missing side effect ${effect}`).toBeGreaterThan(route);
  }
}

describe('attachment routing is fail-closed before business side effects', () => {
  test('Telegram resolves photo and document routes before registration/download', () => {
    const source = read('src/telegram.ts');
    expectRouteBefore(
      section(source, "bot.on('message:photo'", "bot.on('message:document'"),
      ['storeChatMetadata(jid', 'downloadTelegramPhotoAsBase64('],
      'isChatAuthorized(jid)',
    );
    expectRouteBefore(
      section(source, "bot.on('message:document'", "bot.on('my_chat_member'"),
      ['storeChatMetadata(jid', 'downloadTelegramFile('],
      'isChatAuthorized(jid)',
    );
  });

  test('QQ resolves direct and group routes before registration/download', () => {
    const source = read('src/qq.ts');
    expectRouteBefore(
      section(
        source,
        'async function handleC2CMessage(',
        'async function handleGroupMessage(',
      ),
      ['storeChatMetadata(jid', 'processQQAttachment('],
      'isChatAuthorized(jid)',
    );
    expectRouteBefore(
      section(source, 'async function handleGroupMessage('),
      ['storeChatMetadata(jid', 'processQQAttachment('],
      'isChatAuthorized(jid)',
    );
  });

  test('WeChat resolves before chat registration and media processing', () => {
    expectRouteBefore(
      section(read('src/wechat.ts'), 'async function processMessage('),
      ['storeChatMetadata(jid', 'processImageItem('],
      'isChatAuthorized?.(jid)',
    );
  });

  test('DingTalk applies the group gate, then resolves before registration/download', () => {
    expectRouteBefore(
      section(read('src/dingtalk.ts'), 'async function handleRobotMessage('),
      ['storeChatMetadata(jid', 'downloadDingTalkFileByDownloadCode('],
      'shouldProcessGroupMessage',
    );
  });
});
