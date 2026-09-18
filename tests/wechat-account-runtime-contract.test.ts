import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const indexSource = fs.readFileSync(
  path.join(process.cwd(), 'src/index.ts'),
  'utf8',
);

describe('WeChat first-class account runtime contract', () => {
  test('connects account-scoped authorization and pairing to the default workspace', () => {
    const start = indexSource.indexOf(
      "} else if (account.provider === 'wechat') {",
    );
    const end = indexSource.indexOf(
      "} else if (account.provider === 'dingtalk') {",
      start,
    );
    const branch = indexSource.slice(start, end);

    expect(branch).toMatch(
      /isChatAuthorized:\s*buildIsChatAuthorized\(\s*account\.owner_user_id,\s*account\.id,\s*account\.is_legacy_default,?\s*\)/,
    );
    expect(branch).toContain('onPairAttempt: buildOnPairAttempt(');
    expect(branch).toContain('workspace.jid');
  });

  test('maps iLink session expiry to revoked authorization and disconnected transport', () => {
    const start = indexSource.indexOf(
      "} else if (account.provider === 'wechat') {",
    );
    const end = indexSource.indexOf(
      "} else if (account.provider === 'dingtalk') {",
      start,
    );
    const branch = indexSource.slice(start, end);

    expect(branch).toContain("state.status === 'expired'");
    expect(branch).toMatch(
      /updateChannelAccountAuthStatus\(\s*account\.id,\s*'revoked'/,
    );
    expect(branch).toMatch(
      /updateChannelAccountStatus\(\s*account\.id,\s*'disconnected'/,
    );
  });

  test('uses a durable cursor as a replay boundary instead of applying startup stale filtering', () => {
    const start = indexSource.indexOf(
      "} else if (account.provider === 'wechat') {",
    );
    const end = indexSource.indexOf(
      "} else if (account.provider === 'dingtalk') {",
      start,
    );
    const branch = indexSource.slice(start, end);
    expect(branch).toContain('ignoreMessagesBefore: secret.getUpdatesBuf');
    expect(branch).toContain('onUpdatesBuf: (cursor: string) =>');
    expect(branch).toContain('saveChannelAccountSecret(');
  });
});
