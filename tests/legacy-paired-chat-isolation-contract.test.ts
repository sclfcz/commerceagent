import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/routes/config.ts'),
  'utf8',
);

describe('legacy paired-chat facade isolation', () => {
  test('Telegram and QQ old routes restrict scoped chats to the legacy account', () => {
    expect(source).toContain("getLegacyChannelAccount(user.id, 'telegram')");
    expect(source).toContain("getLegacyChannelAccount(user.id, 'qq')");
    expect(source).toContain(
      'address.legacy || group.channel_account_id === legacy?.id',
    );
    expect(source).toContain(
      '!address?.legacy && group.channel_account_id !== legacy?.id',
    );
  });
});
