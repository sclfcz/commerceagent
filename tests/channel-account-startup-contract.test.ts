import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const indexSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/index.ts'),
  'utf8',
);

describe('channel account startup compatibility contract', () => {
  test('startup projects legacy configs, then connects only first-class accounts', () => {
    expect(indexSource).not.toMatch(/\bconnectUserIMChannels\b/);

    expect(indexSource).toContain('ensureLegacyDefaultChannelAccount({');
    expect(indexSource).toContain(
      'listEnabledChannelAccounts().map((account) =>',
    );
    expect(indexSource).toContain('reloadChannelAccountById(account.id)');
  });

  test('legacy hot reload updates the default account instead of starting a legacy connector', () => {
    const start = indexSource.indexOf('const reloadUserIMConfig = async');
    const end = indexSource.indexOf(
      "\n  // Reconnect all of a user's IM channels",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const reloadSource = indexSource.slice(start, end);
    expect(reloadSource).toContain('syncLegacyConfigToDefaultChannelAccount(');
    expect(reloadSource).toContain(
      'return reloadChannelAccountById(projectedAccount.id)',
    );
    expect(reloadSource).not.toContain('connectUserIMChannels(');
  });

  test('first successful Feishu account connection starts the shared sync scheduler', () => {
    expect(indexSource).toContain(
      "if (connected && account.provider === 'feishu')",
    );
    expect(indexSource).toContain('ensureFeishuSyncScheduler();');
    expect(indexSource).toContain('imManager.syncAllFeishuGroups(uid)');
    expect(indexSource).toContain('Feishu user group sync failed; continuing');
  });

  test('user re-enable reconnects additional first-class Bot accounts after legacy projection', () => {
    const start = indexSource.indexOf('const reconnectUserIMChannels = async');
    const end = indexSource.indexOf('\n  // Start Web server early', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const reconnectSource = indexSource.slice(start, end);
    expect(reconnectSource).toContain('reloadUserIMConfig(userId, channel)');
    expect(reconnectSource).toContain('listChannelAccountsForUser(userId)');
    expect(reconnectSource).toContain(
      'account.enabled && !account.is_legacy_default',
    );
    expect(reconnectSource).toContain('reloadChannelAccountById(account.id)');
  });
});
