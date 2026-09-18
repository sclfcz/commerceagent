import { create } from 'zustand';
import { api } from '../api/client';
import {
  mcpServerEndpoint,
  normalizeMcpServers,
  type McpServerSource,
} from '../utils/mcp-servers';

export interface McpServer {
  id: string;
  source: McpServerSource;
  sourceKey: string;
  readonly: boolean;
  conflictSources: McpServerSource[];
  effective: boolean;
  // stdio type
  command?: string;
  args?: string[];
  envKeys?: string[];
  hasEnvSecrets?: boolean;
  // http/sse type
  type?: 'http' | 'sse';
  url?: string;
  headerKeys?: string[];
  hasHeaderSecrets?: boolean;
  memberAccess?: 'admin_only' | 'shared';
  runtimeAvailable?: boolean;
  unavailableReason?: 'system_admin_only';
  // metadata
  enabled: boolean;
  importedFromHost?: boolean;
  /** @deprecated Older imported entries still expose this marker. */
  syncedFromHost?: boolean;
  description?: string;
  addedAt: string;
}

interface SyncHostResult {
  added: number;
  skipped: number;
  importedFrom?: string;
}

export interface McpServerCreate {
  id: string;
  scope: McpServerSource;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  memberAccess?: 'admin_only' | 'shared';
}

export interface McpServerUpdate {
  command?: string;
  args?: string[];
  env?: Record<string, string> | null;
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string> | null;
  description?: string;
  enabled?: boolean;
  memberAccess?: 'admin_only' | 'shared';
}

interface McpServersState {
  servers: McpServer[];
  loading: boolean;
  error: string | null;
  syncing: boolean;

  loadServers: () => Promise<void>;
  addServer: (server: McpServerCreate) => Promise<void>;
  getServer: (sourceKey: string) => Promise<McpServer>;
  updateServer: (sourceKey: string, updates: McpServerUpdate) => Promise<void>;
  toggleServer: (sourceKey: string, enabled: boolean) => Promise<void>;
  deleteServer: (sourceKey: string) => Promise<void>;
  syncHostServers: () => Promise<SyncHostResult>;
}

export const useMcpServersStore = create<McpServersState>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
  syncing: false,

  loadServers: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ servers: McpServer[] }>('/api/mcp-servers');
      set({
        servers: normalizeMcpServers(data.servers).map((server) => ({
          ...server,
          readonly: server.readonly ?? false,
          envKeys: server.envKeys ?? [],
          headerKeys: server.headerKeys ?? [],
        })),
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  addServer: async (server) => {
    try {
      await api.post('/api/mcp-servers', server);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  getServer: async (sourceKey) => {
    const data = await api.get<{ server: McpServer }>(
      mcpServerEndpoint(sourceKey),
    );
    const [server] = normalizeMcpServers([data.server]);
    return {
      ...server,
      readonly: server.readonly ?? false,
      envKeys: server.envKeys ?? [],
      headerKeys: server.headerKeys ?? [],
    };
  },

  updateServer: async (sourceKey, updates) => {
    try {
      await api.patch(mcpServerEndpoint(sourceKey), updates);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  toggleServer: async (sourceKey, enabled) => {
    try {
      await api.patch(mcpServerEndpoint(sourceKey), {
        enabled,
      });
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      // A row-level toggle failure must not replace the already loaded list
      // with the page-level loading error state. The card reports it inline.
      throw err;
    }
  },

  deleteServer: async (sourceKey) => {
    try {
      await api.delete(mcpServerEndpoint(sourceKey));
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  syncHostServers: async () => {
    set({ syncing: true, error: null });
    try {
      const result = await api.post<SyncHostResult>(
        '/api/mcp-servers/sync-host',
        {},
      );
      await get().loadServers();
      return result;
    } catch (err: any) {
      set({ error: err?.message || '同步失败，请稍后重试' });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },
}));
