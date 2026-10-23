import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'system-settings-normalize-'),
);
process.env.CONTAINER_TIMEOUT = '-5';
process.env.MAX_CONCURRENT_CONTAINERS = '999';
process.env.ADMIN_HOST_ONLY_MODE = 'true';
process.env.COMMERCEAGENT_OTEL_ENABLED = 'true';
process.env.COMMERCEAGENT_OTEL_ENDPOINT = 'https://otel-env.example';
process.env.COMMERCEAGENT_OTEL_PUBLIC_KEY = 'pk-env';
process.env.COMMERCEAGENT_OTEL_SAMPLE_RATE = '0.25';

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'CommerceAgent',
  DATA_DIR: tmpDir,
}));

const warn = vi.fn();
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

const runtime = await import('../src/runtime-config.js');

afterAll(() => {
  delete process.env.CONTAINER_TIMEOUT;
  delete process.env.MAX_CONCURRENT_CONTAINERS;
  delete process.env.ADMIN_HOST_ONLY_MODE;
  delete process.env.COMMERCEAGENT_OTEL_ENABLED;
  delete process.env.COMMERCEAGENT_OTEL_ENDPOINT;
  delete process.env.COMMERCEAGENT_OTEL_PUBLIC_KEY;
  delete process.env.COMMERCEAGENT_OTEL_SAMPLE_RATE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('system settings normalization', () => {
  test('env, API save, and file reads share the same bounds', () => {
    const fromEnv = runtime.getSystemSettings();
    expect(fromEnv.containerTimeout).toBe(60_000);
    expect(fromEnv.maxConcurrentContainers).toBe(100);
    expect(fromEnv.adminHostOnlyMode).toBe(true);
    expect(fromEnv.observabilityEnabled).toBe(true);
    expect(fromEnv.observabilityEndpoint).toBe('https://otel-env.example');
    expect(fromEnv.observabilityPublicKey).toBe('pk-env');
    expect(fromEnv.observabilitySampleRate).toBe(0.25);
    expect(fromEnv.observabilityIncludeContent).toBe(false);

    const saved = runtime.saveSystemSettings({
      mainAgentAutoCompactPercentage: 95,
    } as any);
    expect(saved.mainAgentAutoCompactPercentage).toBe(90);

    const persisted = runtime.saveSystemSettings({
      observabilityEnabled: false,
      observabilityEndpoint: 'https://otel-persisted.example',
      observabilitySampleRate: 0.75,
    });
    expect(persisted.observabilityEnabled).toBe(false);
    expect(persisted.observabilityEndpoint).toBe(
      'https://otel-persisted.example',
    );
    expect(persisted.observabilitySampleRate).toBe(0.75);

    const settingsFile = path.join(tmpDir, 'config', 'system-settings.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ ...saved, loginLockoutMinutes: 999_999 }),
    );
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(settingsFile, future, future);
    expect(runtime.getSystemSettings().loginLockoutMinutes).toBe(1_440);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        invalidFields: expect.arrayContaining(['loginLockoutMinutes']),
      }),
      'Normalized invalid system settings',
    );
  });
});
