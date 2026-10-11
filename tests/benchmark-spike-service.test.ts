import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { importExisting } from '../benchmarks/lib/existing.js';
import { hash } from '../benchmarks/lib/contracts.js';
import { parse } from 'yaml';
import {
  EvalApi,
  provisionProfiles,
  startService,
  stopService,
} from '../benchmarks/lib/service.js';

test('boots the real isolated API and creates an authenticated Profile without any model request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-api-'));
  let service: Awaited<ReturnType<typeof startService>> | null = null;
  try {
    const repository = fileURLToPath(new URL('../', import.meta.url));
    service = await startService({
      repository,
      directory: path.join(root, 'service'),
      image: 'benchmark-unused-image',
      timeoutMs: 1000,
    });
    const api = new EvalApi(service.baseUrl);
    const setup = await api.request('/api/auth/setup', {
      username: 'benchmark',
      password: randomBytes(24).toString('hex'),
    });
    expect(setup.user.role).toBe('admin');
    expect(api.cookie).toContain('commerceagent_session=');
    await api.request('/api/mcp-servers', {
      id: 'commerce_fixture',
      scope: 'user',
      command: 'node',
      args: ['/workspace/group/fixture-bridge.mjs'],
    });
    const provider = await api.request('/api/config/claude/providers', {
      name: 'candidate-test',
      type: 'third_party',
      enabled: true,
      anthropicBaseUrl: 'http://127.0.0.1:9',
      anthropicApiKey: 'synthetic-unused-key',
      anthropicModel: 'synthetic-unused-model',
    });
    const template = parse(
      fs.readFileSync(path.join(repository, 'benchmarks/profile.yaml'), 'utf8'),
    );
    const created = await api.request('/api/agent-profiles', {
      ...template,
      model_config_id: provider.id,
    });
    expect(created.profile.model_config_id).toBe(provider.id);
    expect(created.profile.runtime_policy.mcp).toMatchObject({
      mode: 'custom',
      ids: ['user:commerce_fixture'],
    });
    const providers = await api.request('/api/config/claude/providers');
    expect(providers.providers).toHaveLength(1);
    const matrix = [
      {
        alias: 'candidate-a',
        model: 'synthetic-a',
        baseUrl: 'http://127.0.0.1:9',
        apiKeyEnv: 'BENCH_TEST_MATRIX_KEY',
        gateway: true,
      },
      {
        alias: 'candidate-b',
        model: 'synthetic-b',
        baseUrl: 'http://127.0.0.1:9',
        apiKeyEnv: 'BENCH_TEST_MATRIX_KEY',
        gateway: true,
      },
    ];
    process.env.BENCH_TEST_MATRIX_KEY = 'synthetic-matrix-key';
    try {
      const bindings = await provisionProfiles(api, template, matrix);
      expect(new Set(bindings.map((b) => b.providerId)).size).toBe(2);
      expect(new Set(bindings.map((b) => b.profile.id)).size).toBe(2);
      for (const binding of bindings) {
        const loaded = await api.request('/api/agent-profiles');
        expect(
          loaded.profiles.find(
            (p: { id: string }) => p.id === binding.profile.id,
          ).model_config_id,
        ).toBe(binding.providerId);
      }
    } finally {
      delete process.env.BENCH_TEST_MATRIX_KEY;
    }
    expect(fs.existsSync(path.join(service.data, 'db/messages.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'service/.env'))).toBe(false);
    const sourceFile = path.join(service.data, 'config/claude-provider.json');
    const before = hash(fs.readFileSync(sourceFile, 'utf8'));
    const previousSource = process.env.BENCH_EXISTING_DATA_DIR;
    try {
      process.env.BENCH_EXISTING_DATA_DIR = service.data;
      const candidates = await importExisting(
        repository,
        path.join(root, 'import'),
      );
      expect(candidates).toHaveLength(3);
      expect(hash(fs.readFileSync(sourceFile, 'utf8'))).toBe(before);
      expect(
        fs
          .readFileSync(path.join(root, 'import/candidates.json'), 'utf8')
          .includes('synthetic-unused-key'),
      ).toBe(false);
      expect(
        process.env[candidates[0].apiKeyEnv] === 'synthetic-unused-key',
      ).toBe(true);
      for (const candidate of candidates)
        delete process.env[candidate.apiKeyEnv];
      expect(fs.existsSync(path.join(root, 'import/provider-snapshot'))).toBe(
        false,
      );
    } finally {
      if (previousSource === undefined)
        delete process.env.BENCH_EXISTING_DATA_DIR;
      else process.env.BENCH_EXISTING_DATA_DIR = previousSource;
    }
  } finally {
    if (service) await stopService(service.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
