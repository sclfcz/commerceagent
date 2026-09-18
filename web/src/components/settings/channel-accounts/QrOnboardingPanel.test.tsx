// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  beginOnboarding: vi.fn(),
  getOnboardingStatus: vi.fn(),
  verifyOnboardingCode: vi.fn(),
  disconnectAccount: vi.fn(),
  logoutAccount: vi.fn(),
  handlers: new Map<string, (event: unknown) => void>(),
}));

vi.mock('../../../api/ws', () => ({
  wsManager: {
    on: vi.fn((type: string, handler: (event: unknown) => void) => {
      mocks.handlers.set(type, handler);
      return () => mocks.handlers.delete(type);
    }),
  },
}));

vi.mock('../../../stores/channel-accounts', () => ({
  useChannelAccountsStore: () => ({
    beginOnboarding: mocks.beginOnboarding,
    getOnboardingStatus: mocks.getOnboardingStatus,
    verifyOnboardingCode: mocks.verifyOnboardingCode,
    disconnectAccount: mocks.disconnectAccount,
    logoutAccount: mocks.logoutAccount,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { QrOnboardingPanel } = await import('./QrOnboardingPanel');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const account = {
  id: 'whatsapp-account-a',
  owner_user_id: 'user-a',
  provider: 'whatsapp' as const,
  name: 'WhatsApp A',
  enabled: true,
  is_default: true,
  status: 'connecting' as const,
  auth_mode: 'qr_session' as const,
  auth_status: 'awaiting_scan' as const,
  transport_status: 'connecting' as const,
  default_workspace_jid: null,
  last_error: null,
  connected_at: null,
  created_at: '2026-08-09T00:00:00.000Z',
  updated_at: '2026-08-09T00:00:00.000Z',
  has_credentials: false,
};

const authorizedResult = {
  account: {
    ...account,
    status: 'connected' as const,
    auth_status: 'authorized' as const,
    transport_status: 'connected' as const,
    has_credentials: true,
  },
  onboarding: {
    auth_mode: 'qr_session' as const,
    auth_status: 'authorized' as const,
    transport_status: 'connected' as const,
    status: 'connected' as const,
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.handlers.clear();
  mocks.getOnboardingStatus.mockReset().mockResolvedValue(authorizedResult);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('QrOnboardingPanel WhatsApp status reconciliation', () => {
  test('refreshes the authoritative account after a connected websocket event', async () => {
    await act(async () => {
      root?.render(<QrOnboardingPanel account={account} />);
    });
    expect(mocks.getOnboardingStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.handlers.get('whatsapp_status')?.({
        accountId: account.id,
        status: 'connected',
        meJid: 'bot@s.whatsapp.net',
      });
    });

    expect(mocks.getOnboardingStatus).toHaveBeenCalledTimes(2);
    expect(mocks.getOnboardingStatus).toHaveBeenLastCalledWith(account.id);
  });

  test('ignores connected events for another account', async () => {
    await act(async () => {
      root?.render(<QrOnboardingPanel account={account} />);
    });

    await act(async () => {
      mocks.handlers.get('whatsapp_status')?.({
        accountId: 'whatsapp-account-b',
        status: 'connected',
      });
    });

    expect(mocks.getOnboardingStatus).toHaveBeenCalledTimes(1);
  });
});
