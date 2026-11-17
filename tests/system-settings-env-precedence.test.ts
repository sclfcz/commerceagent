import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-env-pref-'));
const settingsFile = path.join(tmpDir, 'config', 'system-settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'CommerceAgent',
  DATA_DIR: tmpDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtime = await import('../src/runtime-config.js');

const ENV_KEYS = [
  'MEMORY_EXTRACTION_ENABLED',
  'MEMORY_EXTRACTION_IDLE_MS',
  'MEMORY_CONSOLIDATION_ENABLED',
  'MEMORY_CONSOLIDATION_TIME',
  'MEMORY_CONSOLIDATION_BATCH_SIZE',
  'MEMORY_CONSOLIDATION_MAX_RUNTIME_MS',
  'CONTAINER_TIMEOUT',
  'MAIN_AGENT_AUTO_COMPACT_WINDOW',
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let mtimeOffset = 0;

/** Write the settings file and force the mtime cache to notice it. */
function writeSettings(value: Record<string, unknown>): void {
  fs.writeFileSync(settingsFile, JSON.stringify(value));
  mtimeOffset += 5_000;
  const stamp = new Date(Date.now() + mtimeOffset);
  fs.utimesSync(settingsFile, stamp, stamp);
}

afterAll(() => {
  setEnv({});
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('system settings env precedence when a settings file exists', () => {
  test('keys absent from the file still fall back to environment variables', () => {
    setEnv({
      MEMORY_EXTRACTION_ENABLED: 'false',
      MEMORY_EXTRACTION_IDLE_MS: '120000',
      MEMORY_CONSOLIDATION_ENABLED: 'false',
      MEMORY_CONSOLIDATION_TIME: '04:15',
      MEMORY_CONSOLIDATION_BATCH_SIZE: '50',
      MEMORY_CONSOLIDATION_MAX_RUNTIME_MS: '90000',
      CONTAINER_TIMEOUT: '120000',
    });
    writeSettings({ observabilityEnabled: false });

    const settings = runtime.getSystemSettings();
    expect(settings.observabilityEnabled).toBe(false);
    expect(settings.memoryExtractionEnabled).toBe(false);
    expect(settings.memoryExtractionIdleMs).toBe(120_000);
    expect(settings.memoryConsolidationEnabled).toBe(false);
    expect(settings.memoryConsolidationTime).toBe('04:15');
    expect(settings.memoryConsolidationBatchSize).toBe(50);
    expect(settings.memoryConsolidationMaxRuntimeMs).toBe(90_000);
    expect(settings.containerTimeout).toBe(120_000);
  });

  test('a key persisted in the file wins over its environment variable', () => {
    setEnv({
      MEMORY_EXTRACTION_ENABLED: 'false',
      MEMORY_CONSOLIDATION_ENABLED: 'false',
      CONTAINER_TIMEOUT: '120000',
    });
    writeSettings({
      memoryExtractionEnabled: true,
      memoryConsolidationEnabled: true,
      containerTimeout: 600_000,
    });

    const settings = runtime.getSystemSettings();
    expect(settings.memoryExtractionEnabled).toBe(true);
    expect(settings.memoryConsolidationEnabled).toBe(true);
    expect(settings.containerTimeout).toBe(600_000);
  });

  test('the legacy autoCompactWindow alias in the file still wins', () => {
    setEnv({ MAIN_AGENT_AUTO_COMPACT_WINDOW: '300000' });
    writeSettings({ autoCompactWindow: 500_000 });

    expect(runtime.getSystemSettings().mainAgentAutoCompactWindow).toBe(
      500_000,
    );
  });
});
