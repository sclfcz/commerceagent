// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  providers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(async () => ({
      providers: mocks.providers,
      balancing: {
        strategy: 'round-robin',
        unhealthyThreshold: 3,
        recoveryIntervalMs: 60_000,
      },
      enabledCount: mocks.providers.length,
      defaultProviderId: null,
    })),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  getErrorMessage: (error: unknown) => String(error),
}));

const { ClaudeProviderSection } =
  await import('../web/src/components/settings/ClaudeProviderSection');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function provider(
  id: string,
  name: string,
  status: 'verified' | 'failed' | 'unverified',
) {
  return {
    id,
    name,
    type: 'third_party',
    enabled: true,
    weight: 1,
    anthropicBaseUrl: `https://${id}.gateway.example.test`,
    anthropicModel: `model-${id}`,
    hasAnthropicAuthToken: false,
    anthropicAuthTokenMasked: null,
    hasAnthropicApiKey: true,
    anthropicApiKeyMasked: '****',
    hasClaudeCodeOauthToken: false,
    claudeCodeOauthTokenMasked: null,
    hasClaudeOAuthCredentials: false,
    claudeOAuthCredentialsExpiresAt: null,
    claudeOAuthCredentialsAccessTokenMasked: null,
    customEnv: {},
    updatedAt: '2026-11-01T00:00:00.000Z',
    sessionContinuity: {
      status,
      checkedAt: status === 'unverified' ? null : '2026-11-02T03:04:05.000Z',
      bidirectionalProviderIds: [],
    },
    health: null,
  };
}

async function renderSection() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ClaudeProviderSection setNotice={() => {}} setError={() => {}} />,
    );
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  mocks.providers = [];
  vi.clearAllMocks();
});

describe('上游设置页的会话续接状态', () => {
  test('每个上游显示续接标签，并说明如何验证', async () => {
    mocks.providers = [
      provider('verified', '已验证上游', 'verified'),
      provider('failed', '不可续接上游', 'failed'),
      provider('unverified', '未验证上游', 'unverified'),
    ];
    const element = await renderSection();

    await vi.waitFor(() => {
      expect(element.textContent).toContain('已验证上游');
    });

    expect(
      element.querySelector('[data-continuity-status="verified"]')?.textContent,
    ).toBe('已验证续接');
    expect(
      element.querySelector('[data-continuity-status="failed"]')?.textContent,
    ).toBe('不可续接');
    expect(
      element.querySelector('[data-continuity-status="unverified"]')
        ?.textContent,
    ).toBe('续接未验证');

    expect(element.textContent).toContain('npm run probe:session-continuity');
    expect(element.textContent).toContain('会话续接');
  });

  test('状态标签的提示解释后果，不暴露地址或密钥', async () => {
    mocks.providers = [provider('verified', '已验证上游', 'verified')];
    const element = await renderSection();

    const badge = await vi.waitFor(() => {
      const match = element.querySelector('[data-continuity-status]');
      expect(match).not.toBeNull();
      return match as HTMLElement;
    });
    expect(badge.getAttribute('title')).toContain('最近检查');
    const serialized = element.innerHTML;
    expect(serialized).not.toContain('synthetic-');
  });
});
