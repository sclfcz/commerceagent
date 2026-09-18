import fs from 'node:fs';
import path from 'node:path';

export type McpServerMap = Record<string, Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read only the MCP declaration from a Claude settings/.mcp.json file. */
export function readMcpServersFile(filePath: string): McpServerMap {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {};
    return Object.fromEntries(
      Object.entries(parsed.mcpServers).filter(
        ([name, server]) => name.trim().length > 0 && isRecord(server),
      ),
    ) as McpServerMap;
  } catch {
    return {};
  }
}

/**
 * Resolve every native user-level MCP source from the configured Claude
 * directory. Never consult process HOME: externalClaudeDir is the single
 * authority for both the .claude directory and its sibling .claude.json.
 */
export function getHostClaudeMcpSourcePaths(
  externalClaudeDir: string,
): string[] {
  return [
    path.join(externalClaudeDir, 'settings.json'),
    path.join(path.dirname(externalClaudeDir), '.claude.json'),
  ];
}

export function loadHostClaudeMcpServers(
  externalClaudeDir: string,
): McpServerMap {
  const [settingsPath, globalPath] =
    getHostClaudeMcpSourcePaths(externalClaudeDir);
  return {
    ...readMcpServersFile(settingsPath),
    ...readMcpServersFile(globalPath),
  };
}

/**
 * Claude-native MCP is project/host context, not a CommerceAgent-managed user MCP
 * grant.  Materialize it explicitly so strict Agent MCP filtering cannot hide
 * it (and cannot accidentally re-enable unselected CommerceAgent user servers).
 * Later/more-local sources win, matching Claude settings precedence.
 */
export function loadClaudeContextMcpServers(options: {
  workspaceDir: string;
  externalClaudeDir?: string;
  includeHostClaudeContext?: boolean;
}): McpServerMap {
  const hostServers =
    options.includeHostClaudeContext && options.externalClaudeDir
      ? loadHostClaudeMcpServers(options.externalClaudeDir)
      : {};
  const projectFile = readMcpServersFile(
    path.join(options.workspaceDir, '.mcp.json'),
  );
  const projectSettings = readMcpServersFile(
    path.join(options.workspaceDir, '.claude', 'settings.json'),
  );
  const projectLocalSettings = readMcpServersFile(
    path.join(options.workspaceDir, '.claude', 'settings.local.json'),
  );
  return {
    ...hostServers,
    ...projectFile,
    ...projectSettings,
    ...projectLocalSettings,
  };
}

/** CommerceAgent-managed MCP is an additive final layer. */
export function mergeMcpServerLayers(
  contextServers: McpServerMap,
  managedUserServers: McpServerMap,
): McpServerMap {
  return { ...contextServers, ...managedUserServers };
}
