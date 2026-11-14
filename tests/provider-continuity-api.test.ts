import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-continuity-api-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const continuity = await import('../src/session-continuity.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

type Provider = ReturnType<typeof runtimeConfig.createProvider>;

function createProvider(name: string, slug: string): Provider {
  return runtimeConfig.createProvider({
    name,
    type: 'third_party',
    anthropicBaseUrl: `https://${slug}.gateway.example.test`,
    anthropicApiKey: `synthetic-${slug}-key`,
    anthropicModel: `model-${slug}`,
    enabled: true,
  });
}

function writeBaseline(provider: Provider, pass: boolean): void {
  const fingerprint = continuity.providerContinuityFingerprint(provider);
  const checks = {
    resumed: pass,
    recalledToolResult: pass,
    toolCallAfterResume: pass,
    streamed: pass,
  };
  continuity.writeResumeMatrixEntries([
    {
      fromFingerprint: fingerprint,
      toFingerprint: fingerprint,
      fromName: provider.name,
      toName: provider.name,
      checks,
      resume: continuity.resumeChecksPass(checks),
      checkedAt: '2026-11-02T03:04:05.000Z',
    },
  ]);
}

function writePair(from: Provider, to: Provider, resume: boolean): void {
  const checks = {
    resumed: resume,
    recalledToolResult: resume,
    toolCallAfterResume: resume,
    streamed: resume,
  };
  continuity.writeResumeMatrixEntries([
    {
      fromFingerprint: continuity.providerContinuityFingerprint(from),
      toFingerprint: continuity.providerContinuityFingerprint(to),
      fromName: from.name,
      toName: to.name,
      checks,
      resume: continuity.resumeChecksPass(checks),
      checkedAt: '2026-11-02T03:04:05.000Z',
    },
  ]);
}

describe('公开模型配置载荷的续接状态', () => {
  test('上游列表按当前指纹报告状态、检查时间与双向伙伴', () => {
    const verified = createProvider('Verified gateway', 'verified');
    const failed = createProvider('Failed gateway', 'failed');
    const probed = createProvider('Probed gateway', 'probed');
    writeBaseline(verified, true);
    writeBaseline(probed, true);
    writeBaseline(failed, false);
    writePair(verified, probed, true);
    writePair(probed, verified, true);
    writePair(verified, failed, true);

    const all = runtimeConfig.getProviders();
    const publicById = Object.fromEntries(
      all.map((provider) => [
        provider.id,
        runtimeConfig.toPublicProvider(provider, all),
      ]),
    );

    expect(publicById[verified.id].sessionContinuity).toEqual({
      status: 'verified',
      checkedAt: '2026-11-02T03:04:05.000Z',
      bidirectionalProviderIds: [probed.id],
    });
    expect(publicById[failed.id].sessionContinuity).toMatchObject({
      status: 'failed',
    });
  });

  test('从未验证的上游是 unverified 且没有检查时间', () => {
    const neverProbed = createProvider('Never probed gateway', 'never-probed');
    const all = runtimeConfig.getProviders();
    expect(
      runtimeConfig.toPublicProvider(neverProbed, all).sessionContinuity,
    ).toEqual({
      status: 'unverified',
      checkedAt: null,
      bidirectionalProviderIds: [],
    });
  });

  test('续接状态不携带 endpoint、模型名或凭据', () => {
    const provider = createProvider('Secretless gateway', 'secretless');
    writeBaseline(provider, true);
    const publicPayload = runtimeConfig.toPublicProvider(
      provider,
      runtimeConfig.getProviders(),
    );
    expect(JSON.stringify(publicPayload.sessionContinuity)).toEqual(
      JSON.stringify({
        status: 'verified',
        checkedAt: '2026-11-02T03:04:05.000Z',
        bidirectionalProviderIds: [],
      }),
    );
    expect(JSON.stringify(publicPayload.sessionContinuity)).not.toContain(
      'gateway.example.test',
    );
    expect(JSON.stringify(publicPayload.sessionContinuity)).not.toContain(
      'synthetic-',
    );
  });

  test('上游列表路由使用同一次读取的 provider 集合计算状态', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/routes/config.ts'),
      'utf8',
    );
    expect(source).toContain('...toPublicProvider(p, providers)');
  });
});

describe('模型续接准入开关', () => {
  test('默认不拦未验证上游，保存后持久生效', () => {
    expect(runtimeConfig.getSystemSettings().blockUnverifiedModelConfigs).toBe(
      false,
    );

    runtimeConfig.saveSystemSettings({ blockUnverifiedModelConfigs: true });
    expect(runtimeConfig.getSystemSettings().blockUnverifiedModelConfigs).toBe(
      true,
    );

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(root, 'config', 'system-settings.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(stored.blockUnverifiedModelConfigs).toBe(true);
  });
});
