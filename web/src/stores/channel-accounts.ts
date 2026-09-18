import { create } from 'zustand';
import { api } from '../api/client';

export type ChannelProvider =
  | 'feishu'
  | 'telegram'
  | 'qq'
  | 'wechat'
  | 'dingtalk'
  | 'discord'
  | 'whatsapp';

export type ChannelAuthMode = 'credentials' | 'bot_token' | 'qr_session';
export type ChannelAuthStatus =
  | 'draft'
  | 'awaiting_scan'
  | 'authorized'
  | 'revoked'
  | 'error';
export type ChannelTransportStatus =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'error';

export interface ChannelOnboardingState {
  auth_mode: ChannelAuthMode;
  auth_status: ChannelAuthStatus;
  transport_status: ChannelTransportStatus;
  status?:
    | 'wait'
    | 'scaned'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect'
    | 'confirmed'
    | 'expired'
    | 'connecting'
    | 'reconnecting'
    | 'qr'
    | 'connected'
    | 'disconnected'
    | 'logged_out'
    | 'error';
  qrcodeUrl?: string;
  qrDataUrl?: string;
  needsVerifyCode?: boolean;
  error?: string;
  meJid?: string;
  meName?: string;
  phoneNumber?: string;
}

export interface ChannelAccount {
  id: string;
  owner_user_id: string;
  provider: ChannelProvider;
  name: string;
  enabled: boolean;
  is_default: boolean;
  status:
    | 'disconnected'
    | 'connecting'
    | 'reconnecting'
    | 'connected'
    | 'error';
  auth_mode?: ChannelAuthMode;
  auth_status?: ChannelAuthStatus;
  transport_status?: ChannelTransportStatus;
  default_workspace_jid: string | null;
  last_error: string | null;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
  has_credentials: boolean;
  options?: {
    bypassProxy?: boolean;
    streamingMode?: 'card' | 'text' | 'edit' | 'off';
    phoneNumber?: string;
  };
}

export interface ChannelAccountCreateInput {
  provider: ChannelProvider;
  name: string;
  enabled?: boolean;
  is_default?: boolean;
  default_workspace_jid?: string | null;
  credentials: Record<string, string>;
}

export type ChannelAccountPatchInput = Partial<
  Omit<ChannelAccountCreateInput, 'provider' | 'credentials'>
> & { credentials?: Record<string, string> };

export interface ChannelAccountStatusEvent {
  accountId: string;
  transportStatus: ChannelTransportStatus;
  lastError?: string | null;
  connectedAt?: string | null;
}

interface ChannelAccountsState {
  accounts: ChannelAccount[];
  loading: boolean;
  error: string | null;
  loadAccounts: () => Promise<void>;
  createAccount: (input: ChannelAccountCreateInput) => Promise<ChannelAccount>;
  updateAccount: (
    id: string,
    input: ChannelAccountPatchInput,
  ) => Promise<ChannelAccount>;
  testAccount: (id: string) => Promise<{ success: boolean; error?: string }>;
  beginOnboarding: (
    id: string,
  ) => Promise<{ account: ChannelAccount; onboarding: ChannelOnboardingState }>;
  getOnboardingStatus: (
    id: string,
  ) => Promise<{ account: ChannelAccount; onboarding: ChannelOnboardingState }>;
  verifyOnboardingCode: (
    id: string,
    verifyCode: string,
  ) => Promise<{ account: ChannelAccount; onboarding: ChannelOnboardingState }>;
  disconnectAccount: (
    id: string,
  ) => Promise<{ account: ChannelAccount; onboarding: ChannelOnboardingState }>;
  logoutAccount: (
    id: string,
  ) => Promise<{ account: ChannelAccount; onboarding: ChannelOnboardingState }>;
  toggleAccount: (id: string) => Promise<ChannelAccount>;
  deleteAccount: (id: string) => Promise<void>;
  applyStatusEvent: (event: ChannelAccountStatusEvent) => void;
}

export function mergeChannelAccount(
  accounts: ChannelAccount[],
  account: ChannelAccount,
) {
  const normalized = account.is_default
    ? accounts.map((item) =>
        item.provider === account.provider && item.id !== account.id
          ? { ...item, is_default: false }
          : item,
      )
    : accounts;
  return [account, ...normalized.filter((item) => item.id !== account.id)].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      Number(b.is_default) - Number(a.is_default) ||
      a.created_at.localeCompare(b.created_at),
  );
}

export const useChannelAccountsStore = create<ChannelAccountsState>((set) => ({
  accounts: [],
  loading: false,
  error: null,

  loadAccounts: async () => {
    set({ loading: true, error: null });
    try {
      const result = await api.get<{ accounts: ChannelAccount[] }>(
        '/api/channel-accounts',
      );
      set({ accounts: result.accounts, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '加载渠道账号失败',
      });
      throw error;
    }
  },

  createAccount: async (input) => {
    const result = await api.post<{ account: ChannelAccount }>(
      '/api/channel-accounts',
      input,
    );
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result.account;
  },

  updateAccount: async (id, input) => {
    const result = await api.patch<{ account: ChannelAccount }>(
      `/api/channel-accounts/${encodeURIComponent(id)}`,
      input,
    );
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result.account;
  },

  testAccount: async (id) =>
    api.post<{ success: boolean; error?: string }>(
      `/api/channel-accounts/${encodeURIComponent(id)}/test`,
      {},
    ),

  beginOnboarding: async (id) => {
    const result = await api.post<{
      account: ChannelAccount;
      onboarding: ChannelOnboardingState;
    }>(`/api/channel-accounts/${encodeURIComponent(id)}/onboarding`, {});
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result;
  },

  getOnboardingStatus: async (id) => {
    const result = await api.get<{
      account: ChannelAccount;
      onboarding: ChannelOnboardingState;
    }>(`/api/channel-accounts/${encodeURIComponent(id)}/onboarding/status`);
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result;
  },

  verifyOnboardingCode: async (id, verifyCode) => {
    const result = await api.post<{
      account: ChannelAccount;
      onboarding: ChannelOnboardingState;
    }>(`/api/channel-accounts/${encodeURIComponent(id)}/onboarding/verify`, {
      verifyCode,
    });
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result;
  },

  disconnectAccount: async (id) => {
    const result = await api.post<{
      account: ChannelAccount;
      onboarding: ChannelOnboardingState;
    }>(`/api/channel-accounts/${encodeURIComponent(id)}/disconnect`, {});
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result;
  },

  logoutAccount: async (id) => {
    const result = await api.post<{
      account: ChannelAccount;
      onboarding: ChannelOnboardingState;
    }>(`/api/channel-accounts/${encodeURIComponent(id)}/logout`, {});
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result;
  },

  toggleAccount: async (id) => {
    const result = await api.post<{ account: ChannelAccount }>(
      `/api/channel-accounts/${encodeURIComponent(id)}/toggle`,
      {},
    );
    set((state) => ({
      accounts: mergeChannelAccount(state.accounts, result.account),
      error: null,
    }));
    return result.account;
  },

  deleteAccount: async (id) => {
    await api.delete(`/api/channel-accounts/${encodeURIComponent(id)}`);
    set((state) => ({
      accounts: state.accounts.filter((account) => account.id !== id),
      error: null,
    }));
  },

  applyStatusEvent: (event) => {
    set((state) => ({
      accounts: state.accounts.map((account) =>
        account.id === event.accountId
          ? {
              ...account,
              status: event.transportStatus,
              transport_status: event.transportStatus,
              last_error:
                event.lastError !== undefined
                  ? event.lastError
                  : account.last_error,
              connected_at:
                event.connectedAt !== undefined
                  ? event.connectedAt
                  : account.connected_at,
            }
          : account,
      ),
    }));
  },
}));
