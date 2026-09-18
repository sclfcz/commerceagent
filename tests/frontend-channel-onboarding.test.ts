import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative: string) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

describe('channel onboarding frontend protocol contract', () => {
  test('first-run setup reuses the account manager instead of legacy singleton APIs', () => {
    const source = read('web/src/pages/SetupChannelsPage.tsx');
    expect(source).toContain('<ChannelAccountsManager />');
    expect(source).not.toContain('/api/config/user-im/');
    expect(source).not.toContain('WeChatQRDialog');
  });

  test('QR onboarding never exposes WeChat or WhatsApp protocol output as inputs', () => {
    const fields = read(
      'web/src/components/settings/channel-accounts/ProviderConnectionFields.tsx',
    );
    const definitions = read('web/src/utils/channel-accounts.ts');
    expect(fields).toContain('扫码结果由 CommerceAgent 安全保存');
    expect(fields).toContain('无需填写手机号或账号标识');
    expect(definitions).not.toMatch(
      /key:\s*['"](?:ilinkBotId|baseUrl|cdnBaseUrl|accountId|phoneNumber)['"]/,
    );
  });

  test('Feishu owner identity is learned by the backend and never submitted by UI', () => {
    const fields = read(
      'web/src/components/settings/channel-accounts/ProviderConnectionFields.tsx',
    );
    const definitions = read('web/src/utils/channel-accounts.ts');
    expect(fields).not.toContain('ownerOpenId');
    expect(definitions).not.toContain("key: 'ownerOpenId'");
  });

  test('WhatsApp live status is isolated by immutable channel account id', () => {
    const source = read(
      'web/src/components/settings/channel-accounts/QrOnboardingPanel.tsx',
    );
    const store = read('web/src/stores/channel-accounts.ts');
    expect(source).toContain("'whatsapp_status'");
    expect(source).toContain('event.accountId !== account.id');
    expect(source).toContain('mergeWhatsAppOnboardingState');
    expect(store).toContain('/onboarding/status');
  });

  test('disabled QR accounts never auto-start and prompt before manual scanning', () => {
    const source = read(
      'web/src/components/settings/channel-accounts/QrOnboardingPanel.tsx',
    );
    expect(source).toContain('account.enabled &&');
    expect(source).toContain('if (!account.enabled)');
    expect(source).toContain('请先启用账号再发起扫码连接');
  });

  test('WeChat QR verification and protocol states are wired end to end', () => {
    const panel = read(
      'web/src/components/settings/channel-accounts/QrOnboardingPanel.tsx',
    );
    const store = read('web/src/stores/channel-accounts.ts');
    expect(store).toContain('verifyOnboardingCode');
    expect(store).toContain('/onboarding/verify');
    expect(store).toContain('needsVerifyCode?: boolean');
    expect(panel).toContain('onboarding.needsVerifyCode');
    expect(panel).toContain('输入微信验证码');
    expect(panel).toContain('inputMode="numeric"');
    expect(panel).toContain('提交验证码');
    for (const status of [
      'need_verifycode',
      'scaned_but_redirect',
      'verify_code_blocked',
      'binded_redirect',
      'expired',
    ]) {
      expect(panel).toContain(`state.status === '${status}'`);
    }
  });

  test('pairing and destructive protocol actions use account-scoped endpoints', () => {
    const manager = read(
      'web/src/components/settings/ChannelAccountsManager.tsx',
    );
    const store = read('web/src/stores/channel-accounts.ts');
    expect(manager).toContain('/pairing-code');
    expect(manager).toContain('/paired-chats');
    expect(store).toContain('/disconnect');
    expect(store).toContain('/logout');
  });

  test('QR-session accounts render pairing controls outside the credential branch', () => {
    const manager = read(
      'web/src/components/settings/ChannelAccountsManager.tsx',
    );
    expect(manager).toContain(
      '        )}\n\n        {supportsChannelPairing(account.provider) &&',
    );
    expect(manager).toContain('<AccountPairingSection account={account} />');
  });

  test('auth and transport status are rendered as independent states', () => {
    const manager = read(
      'web/src/components/settings/ChannelAccountsManager.tsx',
    );
    expect(manager).toContain('auth_status');
    expect(manager).toContain('transport_status');
    expect(manager).toContain('待扫码');
    expect(manager).toContain('在线');
    expect(manager).not.toContain('凭证已安全配置');
  });

  test('renders setup steps, official entry points and accessible field help', () => {
    const fields = read(
      'web/src/components/settings/channel-accounts/ProviderConnectionFields.tsx',
    );
    const definitions = read('web/src/utils/channel-accounts.ts');

    expect(fields).toContain('ProviderSetupGuide');
    expect(fields).toContain('aria-labelledby');
    expect(fields).toContain('aria-describedby');
    expect(fields).toContain('focus-visible:ring-2');
    expect(fields).toContain('创建后：');

    for (const officialUrl of [
      'https://open.feishu.cn/app',
      'https://t.me/BotFather',
      'https://q.qq.com/qqbot/openclaw/index.html',
      'https://open-dev.dingtalk.com/fe/app',
      'https://discord.com/developers/applications',
    ]) {
      expect(definitions).toContain(officialUrl);
    }
  });
});
