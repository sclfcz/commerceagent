export type McpServerSource = 'system' | 'user';

export interface SourceQualifiedMcpServer {
  id: string;
  source?: McpServerSource;
  sourceKey?: string;
  enabled: boolean;
  runtimeAvailable?: boolean;
}

export function mcpSourceKey(source: McpServerSource, id: string): string {
  return `${source}:${id}`;
}

export function parseMcpSourceKey(sourceKey: string): {
  source: McpServerSource;
  id: string;
} {
  if (sourceKey.startsWith('system:')) {
    return { source: 'system', id: sourceKey.slice('system:'.length) };
  }
  if (sourceKey.startsWith('user:')) {
    return { source: 'user', id: sourceKey.slice('user:'.length) };
  }
  // Historical clients stored bare ids. They always referred to the user's
  // private MCP namespace.
  return { source: 'user', id: sourceKey };
}

export function mcpServerEndpoint(sourceKey: string): string {
  const { source, id } = parseMcpSourceKey(sourceKey);
  return `/api/mcp-servers/${encodeURIComponent(id)}?source=${source}`;
}

export function normalizeMcpPolicyReferences(references: string[]): string[] {
  return references.map((reference) => {
    const { source, id } = parseMcpSourceKey(reference);
    return mcpSourceKey(source, id);
  });
}

export function normalizeMcpServers<T extends SourceQualifiedMcpServer>(
  servers: T[],
): Array<
  T & {
    source: McpServerSource;
    sourceKey: string;
    conflictSources: McpServerSource[];
    effective: boolean;
  }
> {
  const normalized = servers.map((server) => {
    const parsed = server.sourceKey
      ? parseMcpSourceKey(server.sourceKey)
      : { source: server.source ?? ('user' as const), id: server.id };
    const source = server.source ?? parsed.source;
    return {
      ...server,
      source,
      sourceKey: mcpSourceKey(source, server.id),
    };
  });
  const byId = new Map<string, typeof normalized>();
  for (const server of normalized) {
    const matches = byId.get(server.id) ?? [];
    matches.push(server);
    byId.set(server.id, matches);
  }

  return normalized.map((server) => {
    const matches = byId.get(server.id) ?? [server];
    const conflictSources = Array.from(
      new Set(matches.map((item) => item.source)),
    );
    const enabled = matches.filter(
      (item) => item.enabled && item.runtimeAvailable !== false,
    );
    const effectiveSource = enabled.some((item) => item.source === 'user')
      ? 'user'
      : enabled.some((item) => item.source === 'system')
        ? 'system'
        : null;
    return {
      ...server,
      conflictSources,
      effective: effectiveSource === server.source,
    };
  });
}

export function buildMcpPolicyOptions<
  T extends {
    id: string;
    source: McpServerSource;
    sourceKey: string;
    enabled: boolean;
    description?: string;
    conflictSources?: McpServerSource[];
    effective?: boolean;
    runtimeAvailable?: boolean;
  },
>(servers: T[]) {
  return servers
    .filter((server) => server.enabled && server.runtimeAvailable !== false)
    .map((server) => ({
      id: server.sourceKey,
      name: `${server.id} · ${server.source === 'system' ? '系统' : '我的'}`,
      description:
        (server.conflictSources?.length ?? 0) > 1
          ? `${server.description ? `${server.description} · ` : ''}存在同名来源，${server.effective ? '当前生效' : '当前被同名用户配置覆盖'}`
          : server.description,
    }));
}
