import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  applyFeishuCliBindingToEnvLines,
  resolveFeishuCliBoundAccountId,
  resolveFeishuCliRuntimeBinding,
} from '../src/feishu-cli-runtime.js';
import type { ChannelAccount, ChannelTurnContext } from '../src/types.js';

function account(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: 'account-current',
    owner_user_id: 'owner-1',
    provider: 'feishu',
    name: 'Current Bot',
    secret_ref: 'channel-account:account-current',
    enabled: true,
    is_default: true,
    is_legacy_default: false,
    auth_mode: 'credentials',
    auth_status: 'authorized',
    transport_status: 'connected',
    status: 'connected',
    default_agent_profile_id: null,
    default_workspace_jid: null,
    last_error: null,
    connected_at: null,
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

function context(
  overrides: Partial<ChannelTurnContext> = {},
): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: 'account-current',
    sourceJid: 'feishu:chat#account:account-current#root:message',
    bot: { appId: 'cli_current' },
    chat: { id: 'chat' },
    message: { id: 'message' },
    ...overrides,
  };
}

function dependencies(
  current = account(),
  secret: Record<string, string | undefined> | null = {
    appId: 'cli_current',
    appSecret: 'secret-current',
  },
) {
  return {
    getChannelAccount: (id: string) =>
      id === current.id ? current : undefined,
    loadChannelAccountSecret: (secretRef: string) =>
      secretRef === current.secret_ref ? secret : null,
  };
}

describe('Feishu CLI runtime identity binding', () => {
  test('host mode leaves feishu-cli identity entirely to the host', () => {
    const source = fs.readFileSync(
      new URL('../src/container-runner.ts', import.meta.url),
      'utf8',
    );
    const hostRunner = source.slice(
      source.indexOf('export async function runHostAgent'),
      source.indexOf('export type AgentRunner'),
    );

    expect(hostRunner).not.toContain('resolveFeishuCliRuntimeBinding');
    expect(hostRunner).not.toContain('applyFeishuCliBinding');
    expect(hostRunner).not.toContain('FEISHU_APP_ID');
    expect(hostRunner).not.toContain('FEISHU_APP_SECRET');
  });

  test('prefers the exact turn account over the workspace account', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        channelContext: context(),
        workspaceChannelAccountId: 'account-workspace',
      },
      dependencies(),
    );

    expect(binding).toEqual({
      source: 'channel_account',
      accountId: 'account-current',
      appId: 'cli_current',
      appSecret: 'secret-current',
    });
  });

  test('uses the workspace account when the turn has no Feishu identity', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        workspaceChannelAccountId: 'account-current',
      },
      dependencies(),
    );

    expect(binding?.source).toBe('channel_account');
    expect(binding?.appId).toBe('cli_current');
  });

  test('leaves native container config untouched without a bound account', () => {
    const binding = resolveFeishuCliRuntimeBinding({});
    const lines = [
      'FEISHU_PROFILE=work',
      'FEISHU_OWNER_EMAIL=owner@example.com',
    ];

    expect(binding).toBeNull();
    applyFeishuCliBindingToEnvLines(lines, binding);
    expect(lines).toEqual([
      'FEISHU_PROFILE=work',
      'FEISHU_OWNER_EMAIL=owner@example.com',
    ]);
  });

  test('selects only a Feishu turn account before the workspace fallback', () => {
    expect(
      resolveFeishuCliBoundAccountId({
        channelContext: context(),
        workspaceChannelAccountId: 'account-workspace',
      }),
    ).toBe('account-current');
    expect(
      resolveFeishuCliBoundAccountId({
        channelContext: context({
          provider: 'telegram',
          channelAccountId: 'telegram-account',
        }),
        workspaceChannelAccountId: 'account-workspace',
      }),
    ).toBe('account-workspace');
  });

  test.each([
    [
      'missing account',
      dependencies(account({ id: 'different' })),
      /no longer exists/,
    ],
    [
      'wrong owner',
      dependencies(account({ owner_user_id: 'owner-2' })),
      /does not belong/,
    ],
    ['disabled account', dependencies(account({ enabled: false })), /disabled/],
    [
      'incomplete secret',
      dependencies(account(), { appId: 'cli_current' }),
      /incomplete credentials/,
    ],
    [
      'stale context app',
      dependencies(account(), {
        appId: 'cli_other',
        appSecret: 'secret-other',
      }),
      /does not match/,
    ],
    [
      'unsafe secret',
      dependencies(account(), {
        appId: 'cli_current',
        appSecret: 'secret-current\nINJECTED=value',
      }),
      /invalid credential characters/,
    ],
  ])('fails closed for an explicitly bound %s', (_name, deps, error) => {
    expect(() =>
      resolveFeishuCliRuntimeBinding(
        {
          ownerUserId: 'owner-1',
          channelContext: context(),
        },
        deps,
      ),
    ).toThrow(error);
  });

  test('overlays the bound Bot and removes inherited user-token overrides', () => {
    const binding = resolveFeishuCliRuntimeBinding(
      {
        ownerUserId: 'owner-1',
        channelContext: context(),
      },
      dependencies(),
    );
    const lines = [
      'FEISHU_APP_ID=cli_workspace',
      'FEISHU_APP_SECRET=secret-workspace',
      'FEISHU_USER_ACCESS_TOKEN=stale-user-token',
      'FEISHU_PROFILE=workspace',
      'KEEP=yes',
    ];

    applyFeishuCliBindingToEnvLines(lines, binding);

    expect(lines).toEqual([
      'FEISHU_PROFILE=workspace',
      'KEEP=yes',
      'FEISHU_APP_ID=cli_current',
      'FEISHU_APP_SECRET=secret-current',
    ]);
  });
});
