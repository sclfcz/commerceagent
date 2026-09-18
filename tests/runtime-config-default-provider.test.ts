import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-default-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const { trySelectPoolProvider } = await import('../src/container-runner.js');
const configFile = path.join(root, 'config', 'claude-provider.json');

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('default model configuration', () => {
  test('strips root-side permission controls from saved Workspace env', () => {
    runtimeConfig.saveContainerEnvConfig('permission-env-workspace', {
      customEnv: {
        COMMERCEAGENT_INTERNAL_IDENTITY_MODE: 'direct',
        COMMERCEAGENT_PASSWD_FILE: '/workspace/group/passwd',
        COMMERCEAGENT_SESSION_PERMISSION_HELPER: '/workspace/group/evil.sh',
        PROJECT_ENV: 'kept',
      },
    });

    expect(
      runtimeConfig.getContainerEnvConfig('permission-env-workspace').customEnv,
    ).toEqual({ PROJECT_ENV: 'kept' });
  });

  test('selects one complete Provider environment as the default', () => {
    const first = runtimeConfig.createProvider({
      name: 'Official subscription',
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'sonnet',
      enabled: true,
    });
    const second = runtimeConfig.createProvider({
      name: 'Model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b' },
      enabled: true,
    });

    expect(runtimeConfig.getDefaultProviderId()).toBe(first.id);
    runtimeConfig.setDefaultProvider(second.id);
    expect(runtimeConfig.getDefaultProviderId()).toBe(second.id);
    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
    });
    expect(runtimeConfig.getActiveProfileCustomEnv()).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: model-b',
    });
    expect(() => runtimeConfig.setProviderEnabled(second.id, false)).toThrow(
      '默认模型配置不能禁用',
    );
    expect(() => runtimeConfig.deleteProvider(second.id)).toThrow(
      '默认模型配置不能删除',
    );
  });

  test('Agent selection overrides a legacy Workspace Provider environment', () => {
    const selected = runtimeConfig.createProvider({
      name: 'Agent-only model gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://agent-only.example.test',
      anthropicAuthToken: 'agent-only-token',
      anthropicModel: 'agent-only-model',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      enabled: false,
    });
    runtimeConfig.saveContainerEnvConfig('model-workspace', {
      anthropicBaseUrl: 'https://workspace-override.example.test',
      anthropicAuthToken: 'workspace-token',
      anthropicModel: 'workspace-model',
    });

    const result = trySelectPoolProvider('model-workspace', null, selected.id);
    expect(result).toMatchObject({
      profileId: selected.id,
      resolved: {
        config: {
          anthropicBaseUrl: 'https://agent-only.example.test',
          anthropicAuthToken: 'agent-only-token',
          anthropicModel: 'agent-only-model',
        },
        customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: agent-only' },
      },
    });
    expect(db.getSessionProviderId('model-workspace')).toBe(selected.id);
  });

  test('migrates V4 by choosing the first enabled configuration', () => {
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<
      string,
      unknown
    >;
    stored.version = 4;
    delete stored.defaultProviderId;
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);

    const firstEnabledId = runtimeConfig
      .getProviders()
      .find((provider) => provider.enabled)!.id;
    expect(runtimeConfig.getDefaultProviderId()).toBe(firstEnabledId);

    const migrated = JSON.parse(fs.readFileSync(configFile, 'utf8')) as {
      version: number;
      defaultProviderId: string;
    };
    expect(migrated).toMatchObject({
      version: 5,
      defaultProviderId: firstEnabledId,
    });
  });
});
